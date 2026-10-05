/**
 * Stremio adapter over the three derived sources.
 *
 * ── THE FROZEN SHAPE ────────────────────────────────────────────────────────
 *   Stream = { name, title, url, source, variant? }
 *
 * `variant?` is ENUMERABLE and present ONLY when a source declared it; it is
 * omitted otherwise, never set to a placeholder (see the note on `variant`
 * below). This is the INTERNAL row: what a Stremio client reads is a different
 * projection built in `manifest.js` (`normalizeStreams`), which drops `title`
 * and `variant` and adds `description` plus a conditional `behaviorHints`.
 *   resolveSeries({ title, episode, sources? }) → Promise<Stream[]>
 *   resolveMovie({ title, sources? })           → Promise<Stream[]>
 *
 * Three rules that the shape alone does not express, and why each is here:
 *
 * 1. `Promise.allSettled`, never a sequential loop. The three sites are
 *    independent and none of them can answer for another. Sequentially, one slow
 *    site would add its latency on top of the other two and a dead site would
 *    decide whether the other two are even tried. `test/resolver.test.mjs`
 *    enforces the parallelism with a barrier that deadlocks a sequential runner.
 *
 * 2. Return `[]` unless EVERY source failed. "No source has this title" and
 *    "all three are broken" are different answers and only one of them is a
 *    crash; conflating them is how a two-source outage turns into a
 *    "found nothing" page. The aggregated error keeps all three messages, so a
 *    dead site is still nameable in the log.
 *
 * 3. Per-source wall clock (~25 s), so a stalled CDN is one timed-out source and
 *    not a hung request that outlives the Stremio client.
 *
 * 4. A timeout is a CLASSIFIED timeout. The per-source guard rejects with
 *    `code: 'ETIMEDOUT'` — the one thing `errorToResponse` (`src/manifest.js`)
 *    looks for — and the "every source failed" aggregate repeats that code only
 *    when EVERY source timed out. So three slow upstreams answer 504 `upstream
 *    timeout` instead of 500 `internal error`, which told the user their addon
 *    was broken when the truth was that three sites were slow. A single real
 *    failure keeps 500 on purpose: an outage must stay visible instead of being
 *    relabelled as slowness.
 *
 * ── WHAT IS DELIBERATELY NOT COPIED ─────────────────────────────────────────
 * `hash`. Each upstream source sets it to `''` because these sites publish no
 * torrent, magnet or infohash — they serve plain HTTPS media, and `link` is the
 * playable field. Fabricating a hash to fill a field Stremio never reads would
 * be a plausible-looking lie, so the adapter copies only `link` into `url` and
 * carries no hash of its own, whatever the source handed over.
 *
 * The upstream URLs also carry time-limited tokens (AnimeSaturn's `expires` runs
 * ~12 h out, AnimeUnity's VixCloud `downloadUrl` token is short-lived). Nothing
 * resolved here is cached, persisted or memoised at any layer.
 */

import animeworld from './sources/animeworld.js'
import animesaturn from './sources/animesaturn.js'
import animeunity from './sources/animeunity.js'
import { VARIANT_UNKNOWN, detectVariant } from './variant.js'

/** Per-source wall clock. Above the sources' own 15-20 s budgets, below a client's patience. */
export const SOURCE_TIMEOUT_MS = 25_000

/** id → default instance imported from `./sources/`. */
const INSTANCES = new Map([
  ['animeworld', animeworld],
  ['animesaturn', animesaturn],
  ['animeunity', animeunity]
])

/** id → the label Stremio shows in its stream list. */
const LABELS = new Map([
  ['animeworld', 'AnimeWorld'],
  ['animesaturn', 'AnimeSaturn'],
  ['animeunity', 'AnimeUnity']
])

/**
 * The three sources, in resolution order. Presentation only: no instance, so
 * this stays a plain `{ id, label }[]` a route can serialise as-is.
 * @type {ReadonlyArray<{id: string, label: string}>}
 */
export const SOURCES = [...LABELS].map(([id, label]) => ({ id, label }))

/**
 * Source ids are normalised (trimmed, lowercased) before lookup: they arrive from
 * Stremio query strings, so `AnimeUnity`, `animeunity` and ` animeunity ` all
 * have to land on the same instance or a valid request 500s on capitalisation.
 * @param {string} id
 * @returns {object|undefined}
 */
export function getSource(id) {
  return INSTANCES.get(normalizeId(id))
}

/**
 * @param {unknown} id
 * @returns {string}
 */
function normalizeId(id) {
  return String(id ?? '').trim().toLowerCase()
}

/**
 * The sources that DECLARE the dub/sub distinction upstream, i.e. the ones that
 * expose it for EVERY title rather than for some of them.
 *
 * This is a property of the SITE, not of a title, a result set or a filter, which
 * is exactly why it is a static here instead of something derived from the rows a
 * request happened to get back. All three expose it today, each its own way:
 *
 *   animeworld   the `(ITA)` catalogue marker on the entry itself
 *   animesaturn  two `?dub=` queries, so dub and sub are separate listings
 *   animeunity   a numeric `dub` field on each item
 *
 * It lives next to the source registry rather than on the instances because
 * `src/sources/*` are byte-identical copies of a GPL project and must not be
 * edited here. It is deliberately NOT folded into `SOURCES`, which is a frozen
 * `{ id, label }[]` shape that callers serialise as-is.
 *
 * The three ids are written out rather than derived from `INSTANCES.keys()`: a
 * source added to the registry tomorrow has not been audited for this yet, and an
 * automatically-extended capability set would claim a variant support nobody
 * measured.
 */
const VARIANT_CAPABLE_SOURCES = new Set(['animeworld', 'animesaturn', 'animeunity'])

/**
 * Does this source expose the dub/sub distinction at all?
 *
 * An unknown id is `false`, not `true`: not being able to vouch for a source is
 * not a capability claim, and a lenient default here would let a source with no
 * variant support certify itself.
 *
 * @param {unknown} id
 * @returns {boolean}
 */
export function declaresVariants(id) {
  return VARIANT_CAPABLE_SOURCES.has(normalizeId(id))
}

/**
 * The upstream marker each source appends to its own titles: "One Piece ITA -
 * Ep 5 [AW]". Matched literally rather than with a generic `\[...\]`, because a
 * generic pattern would also eat a legitimate trailing "[ITA]" and hand the user
 * a title that no longer says it is subtitled.
 */
const SOURCE_MARKER = /\s*\[(AW|AS|AU)\]\s*$/

/** A link Stremio can actually be handed. Anything else is dropped, not guessed at. */
const PLAYABLE_LINK = /^https?:\/\/\S+$/i

function messageOf(cause) {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * The one classification `errorToResponse` (`src/manifest.js`) looks for. It is
 * duplicated here as a constant rather than imported from there so this module
 * keeps zero imports from the protocol layer: the adapter is the thing the
 * protocol layer depends on, not the other way round.
 */
const TIMEOUT_CODE = 'ETIMEDOUT'

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isTimeoutFailure(value) {
  return value?.code === TIMEOUT_CODE
}

/**
 * The rejection a per-source wall clock produces.
 *
 * `code` is load-bearing, not decoration: it is what makes the all-sources
 * aggregate below reach `errorToResponse`'s 504 branch. Without it the fan-out
 * rejected with an anonymous `Error` and the client was told "internal error",
 * conflating "three upstreams are slow" with "this addon is broken".
 *
 * `name` is distinct from `TimeoutError` on purpose: this is not that class and
 * nothing here does `instanceof`, so borrowing its name would only create a
 * second thing that looks like the protocol layer's own timeout.
 *
 * The label goes in the message so the error reads the same in isolation as it
 * does inside the aggregated line. It costs a visible `s1: timeout 60 ms (s1)`
 * repetition once `fanOut` prefixes its own id, which is a cheaper price than
 * a second mechanism that suppresses the label only in one of the two places.
 *
 * @param {number} ms
 * @param {string} label
 * @returns {Error}
 */
function sourceTimeoutError(ms, label) {
  const error = new Error(`timeout ${ms} ms (${label})`)
  error.name = 'SourceTimeoutError'
  error.code = TIMEOUT_CODE
  return error
}

/**
 * Normalise the `sources` option into descriptors.
 *
 * Accepted shapes, in order of use:
 *   - omitted        → all three defaults, in `SOURCES` order
 *   - `['animesaturn']` → a subset, by id
 *   - `[{ id, label, instance }]` → injection, which is how the tests run
 *     without a network. A descriptor carrying its own instance is used as-is.
 *
 * @param {unknown} sources
 * @returns {Array<{id: string, label: string, instance: object}>}
 */
function descriptors(sources) {
  if (sources === undefined || sources === null) {
    return SOURCES.map(({ id, label }) => ({ id, label, instance: INSTANCES.get(id) }))
  }

  if (!Array.isArray(sources)) {
    throw new TypeError('sources deve essere undefined, un array di id, o un array di { id, label, instance }')
  }

  return sources.map((entry) => {
    if (typeof entry === 'string') {
      const id = normalizeId(entry)
      const instance = INSTANCES.get(id)
      if (!instance) throw new Error(`fonte sconosciuta: "${entry}"`)
      return { id, label: LABELS.get(id) ?? id, instance }
    }
    if (entry && typeof entry === 'object' && entry.instance) {
      const id = normalizeId(entry.id) || 'custom'
      return { id, label: String(entry.label ?? '').trim() || id, instance: entry.instance }
    }
    throw new TypeError('voce di sources non valida: serve un id noto o { id, label, instance }')
  })
}

/**
 * Run one call against every source at once and fold the outcomes into streams.
 * @param {Array<{id: string, label: string, instance: object}>} targets
 * @param {(target: object) => Promise<unknown>} call
 * @param {number} timeoutMs
 * @param {string} wanted the title, quoted in the aggregated error
 * @returns {Promise<Array<{name: string, title: string, url: string, source: string}>>}
 */
async function fanOut(targets, call, timeoutMs, wanted) {
  const settled = await Promise.allSettled(
    targets.map((target) => raceTimeout(call(target), timeoutMs, target.id))
  )

  const streams = []
  // A source-level failure is "this source is broken". A row-level problem is
  // "this source answered, and one of its rows is unusable". Only the first kind
  // counts towards "everything failed", and conflating them would turn one dead
  // row somewhere into a thrown error.
  const failures = []
  const warnings = []
  // How many of those failures were the wall clock. Counted separately from
  // `failures` because only an all-timeouts fan-out may be reclassified as a 504:
  // one real failure in the mix means the sources are broken, not merely slow.
  let timeouts = 0

  targets.forEach((target, index) => {
    const outcome = settled[index]

    if (outcome.status === 'rejected') {
      failures.push(`${target.id}: ${messageOf(outcome.reason)}`)
      if (isTimeoutFailure(outcome.reason)) timeouts++
      return
    }

    // Upstream contract: these resolve to a real ARRAY. Anything else is a
    // contract break on the source side and is reported as this source's
    // failure rather than being iterated.
    const rows = outcome.value
    if (!Array.isArray(rows)) {
      failures.push(
        `${target.id}: la fonte ha restituito ${rows === null ? 'null' : typeof rows}, non un array`
      )
      return
    }

    for (const row of rows) {
      const link = typeof row?.link === 'string' ? row.link.trim() : ''
      if (!PLAYABLE_LINK.test(link)) {
        warnings.push(`${target.id}: risultato senza link riproducibile (${String(row?.title ?? '')})`)
        continue
      }
      const stream = {
        name: target.label,
        // `hash` is deliberately absent from this object; see the header.
        title: String(row?.title ?? '').replace(SOURCE_MARKER, '').trim(),
        url: link,
        source: target.id
      }

      // The dub/sub marker, carried ONLY when the source stated one.
      //
      // The key is omitted rather than set to `unknown` on purpose, and the
      // reason is the SHAPE of the row, not its inertness: it changes what Stremio
      // sees. `normalizeStreams` in `src/manifest.js` reads it back through
      // `detectVariant`, and a declared variant lands in the row's `description`
      // and in `behaviorHints.bingeGroup` (`<source>-ita-<variant>`, a value held
      // CONSTANT across episodes -- the episode id must NOT appear there, or the
      // engine's cross-episode match can never succeed). An
      // explicit `variant: 'unknown'` would decide none of that -- `detectVariant`
      // tokenizes it to a word that is neither a dub nor a sub marker and lands on
      // `unknown` anyway -- so it would add a field present-but-meaningless on
      // every source that declares nothing, and would change `deepStrictEqual` in
      // the existing suite for a value nothing reads differently.
      //
      // Omitting it keeps the frozen shape honest until a source actually declares
      // a variant, and `routes/api.js` is the single place that guarantees
      // `variant` is always present for a client.
      const variant = detectVariant(row)
      if (variant !== VARIANT_UNKNOWN) stream.variant = variant

      streams.push(stream)
    }
  })

  if (targets.length && failures.length === targets.length) {
    const error = new Error(
      `nessuna fonte ha risolto "${wanted}" (${failures.length}/${targets.length}): ${failures.join(' | ')}`
    )
    error.errors = failures
    // Only when EVERY failure was the wall clock: that is the one case where
    // "nothing answered" means "all upstreams are slow", and 504 says exactly
    // that. Any real failure in the mix leaves the aggregate unclassified, so a
    // broken site still surfaces as 500 and stays diagnosable.
    if (timeouts === targets.length) error.code = TIMEOUT_CODE
    throw error
  }

  // Diagnostics ride along as a NON-enumerable property, the same convention the
  // three sources use — non-enumerable so that `deepStrictEqual` and
  // `JSON.stringify` of the returned array stay exactly what the frozen Stream
  // shape says they are. Read it as `streams.errors`.
  Object.defineProperty(streams, 'errors', {
    value: [...failures, ...warnings],
    enumerable: false,
    writable: true,
    configurable: true
  })
  return streams
}

/**
 * Reject with a named message if the source outlasts its budget. The timer is
 * cleared on every exit path, so a source that answers in 300 ms does not hold
 * the event loop for the full 25 s.
 *
 * `label` is the source id, and it is load-bearing: without it three identical
 * `timeout 25000 ms` rejections are indistinguishable in the aggregate, and
 * standing alone the message says nothing about what timed out.
 *
 * The guard timer is `unref()`ed defensively, the same way `withTimeout` does in
 * `src/manifest.js`: by the time the fan-out rejects, the HTTP response has
 * already been sent, so three pending 25 s guards would keep the process alive
 * with nothing left to deliver. The guard exists to bound what the CLIENT waits
 * for, not to keep the loop warm — when a server socket is pending, that is the
 * server, not the guard, that holds the process open.
 *
 * Rejecting here does NOT cancel the underlying scraper work: no `AbortController`
 * is plumbed into the sources, so the three fetches keep running in the
 * background until the scrapers' own budgets (15–20 s) close them. Only their
 * abandoned output is discarded.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} label
 * @returns {Promise<T>}
 */
async function raceTimeout(promise, ms, label) {
  let timer
  const expiry = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(sourceTimeoutError(ms, label)), ms)
    if (typeof timer?.unref === 'function') timer.unref()
  })
  try {
    return await Promise.race([promise, expiry])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Resolve one episode of a series across all sources, in parallel.
 *
 * Returns `[]` when no source has the title — that is an honest answer, not a
 * failure, and it is not an error the caller has to catch. The only throw is
 * "every source failed", and its message carries all of them.
 *
 * @param {{title?: string, episode?: number, sources?: unknown, timeoutMs?: number}} query
 * @returns {Promise<Array<{name: string, title: string, url: string, source: string}>>}
 */
export async function resolveSeries({ title, episode = 1, sources, timeoutMs = SOURCE_TIMEOUT_MS } = {}) {
  const targets = descriptors(sources)
  if (!targets.length) return []

  const wanted = String(title ?? '').trim()
  if (!wanted) return []

  return fanOut(
    targets,
    (target) => target.instance.single({ titles: [wanted], episode: Number(episode) || 1 }),
    timeoutMs,
    wanted
  )
}

/**
 * Resolve a movie across all sources, in parallel.
 *
 * Each upstream source's `movie()` is literally `single({ ...query, episode: 1 })`,
 * so it is called when present rather than re-derived here: that keeps the
 * per-source contract where it was verified. `single({ titles, episode: 1 })` is
 * the fallback for an injected instance that has no `movie()`.
 *
 * @param {{title?: string, sources?: unknown, timeoutMs?: number}} query
 * @returns {Promise<Array<{name: string, title: string, url: string, source: string}>>}
 */
export async function resolveMovie({ title, sources, timeoutMs = SOURCE_TIMEOUT_MS } = {}) {
  const targets = descriptors(sources)
  if (!targets.length) return []

  const wanted = String(title ?? '').trim()
  if (!wanted) return []

  return fanOut(
    targets,
    (target) =>
      typeof target.instance.movie === 'function'
        ? target.instance.movie({ titles: [wanted] })
        : target.instance.single({ titles: [wanted], episode: 1 }),
    timeoutMs,
    wanted
  )
}