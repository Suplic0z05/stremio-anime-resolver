/**
 * Kitsu JSON:API client — metadata only, no playback URLs.
 *
 * Endpoints used (both verified against the live API):
 *   GET /anime?filter[text]=<q>&page[limit]=N          → 200, JSON:API collection
 *   GET /anime/{id}?include=genres                      → 200, one record + included genres
 *   GET /anime/{id}/episodes?page[limit]=N&page[offset]=M&sort=number → 200, paginated
 *
 * ── THREE MEASURED FACTS THIS FILE IS BUILT AROUND ───────────────────────────
 *
 * 1. `sort=-searchScore` ANSWERS HTTP 400 on /anime. It is never sent, by either
 *    `search()` or `meta()`; relevance is whatever Kitsu's default order is.
 *    Both tests in test/kitsu.test.mjs assert its absence from every URL.
 *
 * 2. Array query keys MUST be percent-encoded. `URLSearchParams` encodes the
 *    brackets (`filter%5Btext%5D`), which is what the server decodes. Handing
 *    `fetch` the raw `filter[text]=` string works inconsistently — in `curl` it
 *    additionally needs `-g`, because curl treats `[...]` as a glob range and
 *    silently drops the parameter. Everything here goes through
 *    `URL`/`URLSearchParams`, so that class of bug cannot reappear.
 *
 * 3. `episodeCount` is `null` for a series still running (measured: One Piece).
 *    It is passed through verbatim as `null` and is NEVER used as an authority on
 *    how many episodes exist. `meta()` paginates /episodes instead, where the
 *    measured count for One Piece is 1410.
 *
 * Also measured: Kitsu has no Italian titles. `attributes.titles.it` is `null`
 * for One Piece, so nothing here invents a translation — `titles.en`, then
 * `canonicalTitle`, then `slug`, in that order.
 *
 * Diagnostics carry the URL and the HTTP status. Response BODIES are never
 * logged, attached to the error, or interpolated into a message: a Kitsu error
 * body can carry request detail that has no business in a server log.
 */

const BASE_URL = 'https://kitsu.io/api/edge'

/**
 * ── THE HARD CAP ON `page[limit]`, MEASURED ON BOTH ENDPOINTS ───────────────
 *
 * Kitsu rejects any page size above 20 with **HTTP 400**, on /anime AND on
 * /anime/{id}/episodes. Re-measured with `curl -g` (see the note below on why
 * the quoting matters), against the live API:
 *
 *   GET /anime?filter[text]=One%20Piece&page[limit]=N
 *     N=2 -> 200 (2 results)   N=20 -> 200 (20 results)   N=21 -> 400   N=50 -> 400
 *
 *   GET /anime/12/episodes?sort=number&page[limit]=N
 *     N=20 -> 200 (20 results, meta.count=1410)
 *     N=21 -> 400   N=50 -> 400   N=200 -> 400
 *
 * and the 400 body names the ceiling itself, which is the cheapest possible
 * confirmation that 20 is the number and not a coincidence:
 *
 *   "detail": "Limit exceeds maximum page size of 20."
 *
 * NOTE ON MEASURING THIS. In bash, `curl "...filter\[text\]=..."` inside DOUBLE
 * quotes keeps the backslashes: curl then sends `filter\[text\]`, Kitsu silently
 * ignores the whole query string, and the endpoint answers **200 with the first
 * 10 records of the unfiltered catalogue** (Cowboy Bebop, Trigun) and
 * `meta.count: 22491`. A corrupted measurement therefore does not error, it
 * returns a plausible 200 — so the ladder has to be read together with
 * `meta.count` and the first returned title, never from the status code alone.
 *
 * Because a 400 here is a 500 for whoever called us (the Kitsu status is
 * propagated), every `page[limit]` this module sends goes through
 * `clampPageSize()` in ONE place — `requestJson()` — so no caller can hand in an
 * out-of-range value.
 */
export const KitsuMaxPageSize = 20

/** Per-request network budget. Kitsu is slow to answer cold, not slow to fail. */
export const REQUEST_TIMEOUT_MS = 20_000

/**
 * Episodes per /episodes page. Equal to the cap above BY CONSTRUCTION, so that
 * raising one cannot silently produce a 400 on the other.
 */
export const EPISODE_PAGE_SIZE = KitsuMaxPageSize

/**
 * In-flight `/episodes` pages. Not 1 (see PAGINATION_BUDGET_MS) and not 71:
 * `Promise.all` over 71 pages would open 71 simultaneous connections against a
 * single API and is how an API bans you. 6 was picked from measurement, not
 * taste: real page latency is 300-2100 ms, so One Piece's 71 pages are ~78 s
 * sequential and ~12 s at this width, inside the route's 30 s budget with room
 * for the /anime request in front of it.
 */
export const PAGE_CONCURRENCY = 6

/**
 * Wall-clock budget for one `meta()` call, pagination included.
 *
 * Set just BELOW the 30 s the route allows (`DEFAULT_TIMEOUT_MS` in
 * src/manifest.js), and deliberately close to it. The budget exists so that this
 * module reports the failure as a typed, explanatory error instead of letting the
 * route's generic timeout win the race and print "upstream_timeout" — so it
 * should spend the whole window the route is willing to give it.
 *
 * Measured cost of a full One Piece meta (id 12, 1410 episodes, 72 requests) on
 * this host: 18.6 s at loadavg ~30, 26.3 s under heavier load. That is the honest
 * margin: it fits, but not with room to spare, and the budget is what converts the
 * unfits into an explicit error.
 *
 * Failing loudly is the whole point — a 1410-episode list quietly truncated to 20
 * is a wrong answer that looks right.
 */
export const META_BUDGET_MS = 28_000

const USER_AGENT =
  'stremio-anime-resolver/0.1 (+https://github.com/Suplic0z05/stremio-anime-resolver)'

/**
 * Every failure leaving this module is a KitsuError, so a caller can branch on
 * `.status` (null for a transport failure or a timeout) without matching on
 * message text, and on `.reason` to tell those apart from each other.
 * @type {'http'|'network'|'timeout'|'invalid_json'|'empty'|'budget'|null}
 */
export class KitsuError extends Error {
  constructor(message, { status = null, url = null, cause = null, reason = null } = {}) {
    super(message)
    this.name = 'KitsuError'
    this.status = status
    this.url = url
    this.reason = reason
    if (cause) this.cause = cause
  }
}

/**
 * Force any page size into `[1, KitsuMaxPageSize]`.
 *
 * The floor matters as much as the ceiling: `page[limit]=0` is just as invalid as
 * 50, and a NaN coming out of `Number(undefined)` would otherwise be serialised
 * as the literal string "NaN" and asked for.
 * @param {unknown} value
 * @returns {number} an integer in [1, KitsuMaxPageSize]
 */
function clampPageSize(value) {
  const parsed = Math.floor(Number(value))
  if (!Number.isFinite(parsed)) return KitsuMaxPageSize
  if (parsed < 1) return 1
  return Math.min(parsed, KitsuMaxPageSize)
}

// ─────────────────────────────────────────────────────────────────────────────
// Low-level plumbing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build an absolute URL with every key percent-encoded through URLSearchParams.
 * Empty/null/undefined values are dropped so an unset filter never becomes
 * `filter[text]=` (which Kitsu answers 400).
 * @param {string} path
 * @param {Record<string, unknown>} [params]
 * @returns {string}
 */
function buildUrl(path, params = {}) {
  const url = new URL(`${BASE_URL}${path}`)
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    url.searchParams.set(key, String(value))
  }
  return url.toString()
}

/**
 * GET a JSON:API document.
 *
 * THE ONLY PLACE `page[limit]` IS SET ON THE WIRE. Whatever a caller asks for —
 * `search({limit: 50})`, `paginate({pageSize: 200})`, a hand-typed constant — it
 * leaves here inside `[1, KitsuMaxPageSize]`, which is what turns Kitsu's 400
 * into something a caller cannot trigger by accident.
 *
 * The abort timer stays armed across the body read (the `finally` belongs to the
 * outer try), so a server that sends headers and then stalls is still bounded.
 * @param {string} path
 * @param {Record<string, unknown>} [params]
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<{payload: any, status: number, url: string}>}
 */
async function requestJson(path, params = {}, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const query = { ...params }
  if ('page[limit]' in query) query['page[limit]'] = clampPageSize(query['page[limit]'])

  const url = buildUrl(path, query)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    let response
    try {
      response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          Accept: 'application/vnd.api+json',
          'User-Agent': USER_AGENT
        }
      })
    } catch (cause) {
      const aborted = controller.signal.aborted
      throw new KitsuError(
        `GET ${url} -> ${aborted ? `timeout ${timeoutMs} ms` : `network error${cause?.message ? `: ${cause.message}` : ''}`}`,
        { url, cause, reason: aborted ? 'timeout' : 'network' }
      )
    }

    if (!response.ok) {
      throw new KitsuError(
        `GET ${url} -> HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`,
        { status: response.status, url, reason: 'http' }
      )
    }

    try {
      return { payload: await response.json(), status: response.status, url }
    } catch (cause) {
      // An abort that fires while the body is still streaming surfaces here as an
      // AbortError, not as a malformed body. Measured live: on a loaded host a
      // 200 header arrives, the timer expires mid-body, and `response.json()`
      // throws — reporting that as "invalid_json" would blame Kitsu for a body our
      // OWN timer cut. It has to be reported as the timeout that it is, or the
      // caller cannot tell a flaky upstream from a truncated one.
      if (controller.signal.aborted) {
        throw new KitsuError(`GET ${url} -> timeout ${timeoutMs} ms (corpo interrotto)`, {
          url,
          cause,
          reason: 'timeout'
        })
      }
      // The body is deliberately NOT quoted here.
      throw new KitsuError(`GET ${url} -> HTTP ${response.status} ma il corpo non è JSON valido`, {
        status: response.status,
        url,
        cause,
        reason: 'invalid_json'
      })
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Walk a paginated JSON:API collection until it is exhausted.
 *
 * ── WHY THIS IS A POOL AND NOT A LOOP ──────────────────────────────────────
 * One Piece is 1410 episodes and the server caps a page at 20, so this is 71
 * requests. Measured page latency is 300-2100 ms, i.e. ~78 s in sequence against
 * a 30 s route budget. Bounded concurrency at PAGE_CONCURRENCY brings it to
 * ~12 s. Bounded and not `Promise.all`, because 71 simultaneous requests against
 * one API is not faster, it is a rate-limit 429 in waiting.
 *
 * ── WHY IT CANNOT LIE ──────────────────────────────────────────────────────
 * `meta.count` (measured: 1410 for One Piece) is the authority on how much there
 * is. If the pool finishes and holds FEWER records than that, this THROWS. It
 * never returns a short list with a success status: a meta that reports 20
 * episodes for a 1410-episode series is worse than a 5xx, because it looks right.
 * A short page (< size) is also what stops discovery when `meta.count` is
 * absent, which is why there are two stopping conditions rather than one.
 *
 * @param {string} path
 * @param {Record<string, unknown>} [params]
 * @param {{timeoutMs?: number, pageSize?: number, sort?: string, maxRecords?: number,
 *   concurrency?: number, deadlineAt?: number|null}} [options]
 * @returns {Promise<{records: any[], total: number, pages: number, requests: number}>}
 */
async function paginate(
  path,
  params = {},
  {
    timeoutMs = REQUEST_TIMEOUT_MS,
    pageSize = EPISODE_PAGE_SIZE,
    sort = null,
    maxRecords = Infinity,
    concurrency = PAGE_CONCURRENCY,
    deadlineAt = null
  } = {}
) {
  const size = clampPageSize(pageSize)
  let requests = 0

  /** @type {(offset: number) => Record<string, unknown>} */
  const queryFor = (offset) => {
    const query = { ...params, 'page[limit]': size, 'page[offset]': offset }
    if (sort) query.sort = sort
    return query
  }

  const remainingMs = () => (deadlineAt === null ? Infinity : deadlineAt - Date.now())

  const budgetError = (offset, detail) => {
    // buildUrl returns the URL STRING, not an object: destructuring `.url` out of
    // it yields undefined, which is exactly what a message saying "GET undefined"
    // means. It shipped that way once and the live run caught it.
    const url = buildUrl(path, queryFor(offset))
    return new KitsuError(`GET ${url} -> ${detail}`, { url, reason: 'budget' })
  }

  /**
   * One page, with the caller's overall budget as a ceiling on the per-request
   * timeout. When the budget is what expires, that is said explicitly instead of
   * being dressed up as an ordinary per-request timeout.
   */
  const fetchPage = async (offset) => {
    const left = remainingMs()
    if (left <= 0) throw budgetError(offset, `budget di ${META_BUDGET_MS} ms scaduto prima della richiesta`)
    requests++

    const perRequest = Math.min(timeoutMs, left)
    try {
      return await requestJson(path, queryFor(offset), { timeoutMs: perRequest })
    } catch (error) {
      if (deadlineAt !== null && error instanceof KitsuError && error.reason === 'timeout') {
        throw budgetError(
          offset,
          `budget di ${META_BUDGET_MS} ms scaduto: la pagina non è arrivata entro ${perRequest} ms (serie troppo lunga per il timeout)`
        )
      }
      throw error
    }
  }

  const first = await fetchPage(0)
  const firstPage = Array.isArray(first.payload?.data) ? first.payload.data : []
  const counted = Number(first.payload?.meta?.count)
  const total = Number.isFinite(counted) && counted >= 0 ? counted : null

  const pages = new Map([[0, firstPage]])
  let collected = firstPage.length
  let cursor = size
  let exhausted = false

  // `cursor` is read and advanced with no await in between, so with several
  // workers in one event-loop turn there is no interleaving to defend against.
  const worker = async () => {
    while (!exhausted) {
      if (total !== null && cursor >= total) {
        exhausted = true
        return
      }
      const offset = cursor
      cursor += size

      const { payload } = await fetchPage(offset)
      const page = Array.isArray(payload?.data) ? payload.data : []
      pages.set(offset, page)
      collected += page.length

      if (page.length < size) exhausted = true // short or empty page: end of collection
      if (collected >= maxRecords) exhausted = true
    }
  }

  // With meta.count known the remaining page count is exact, so the pool is never
  // wider than the work left and cannot run past the end of the collection.
  const remainingPages =
    total === null ? concurrency : Math.max(1, Math.ceil(Math.max(0, total - size) / size))
  const workers = Math.max(1, Math.min(concurrency, remainingPages))

  await Promise.all(Array.from({ length: workers }, worker))

  // Numeric order by offset: the pool finishes out of order, the contract does not.
  const offsets = [...pages.keys()].sort((a, b) => a - b)
  const records = []
  for (const offset of offsets) records.push(...pages.get(offset))

  if (total !== null && Number.isFinite(maxRecords) === false && records.length < total) {
    throw new KitsuError(
      `GET ${buildUrl(path, queryFor(0))} -> elenco incompleto: ${records.length} record su meta.count ${total} (la lista episodi non viene troncata in silenzio)`,
      { url: buildUrl(path, queryFor(0)), reason: 'budget' }
    )
  }

  if (records.length > maxRecords) records.length = maxRecords

  return { records, total: total ?? records.length, pages: offsets.length, requests }
}

// ─────────────────────────────────────────────────────────────────────────────
// Field mapping
// ─────────────────────────────────────────────────────────────────────────────

/** First non-blank string, trimmed. JSON:API is null-heavy and so is Kitsu. */
function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

/**
 * Kitsu's JSON:API `type` for a genre is the PLURAL `genres`. Measured on a live
 * `GET /anime/12?include=genres`: the seven included entries all carry
 * `"type": "genres"`, and so does the resource `relationships.genres.data`. The
 * singular `genre` that the name suggests matches NOTHING, and the failure is
 * silent — the request is a perfectly good HTTP 200 that yields `genres: []` on
 * every single meta. The singular is accepted here anyway so that a pluralisation
 * change upstream costs a warning rather than an empty field.
 */
const GENRE_TYPES = new Set(['genres', 'genre'])

/**
 * A JSON:API document holds a COLLECTION under `data` for /anime and
 * /anime/{id}/episodes, but a SINGLE RESOURCE under `data` for /anime/{id}. This
 * accepts both, because the two differ only in shape and guessing wrong makes
 * `meta()` throw "id inesistente" against a healthy id.
 * @param {unknown} data
 * @returns {any|null}
 */
function firstRecord(data) {
  if (Array.isArray(data)) return data[0] ?? null
  if (data && typeof data === 'object') return data
  return null
}

/**
 * `movie` is the only showType that is a film. Everything else — TV, ONA, OVA,
 * TV Special, dub, music — is a series as far as Stremio's `type` is concerned.
 * @param {unknown} showType
 * @returns {'series'|'movie'}
 */
export function mapShowType(showType) {
  return String(showType ?? '').trim().toLowerCase() === 'movie' ? 'movie' : 'series'
}

/** Poster/cover: original first, medium as the fallback. */
function imageUrl(image) {
  return firstString(image?.original, image?.medium, image?.large, image?.small)
}

/** `startDate` is `YYYY-MM-DD` or null; a series without one has no year. */
function yearOf(startDate) {
  const match = /^(\d{4})/.exec(String(startDate ?? ''))
  return match ? Number(match[1]) : null
}

/** null stays null. `Number(null)` is 0, which would read as "zero episodes". */
function episodeCountOf(value) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

/**
 * Absolute episode number. Kitsu carries both `number` (within a season) and
 * `absoluteNumber` (across the whole series); Stremio asks in absolute terms
 * (measured: One Piece is 1..1410 and episode 954 is the one being requested),
 * so `absoluteNumber` wins and `number` is only the fallback.
 */
function absoluteNumberOf(attributes) {
  for (const candidate of [attributes?.absoluteNumber, attributes?.number]) {
    const parsed = Number(candidate)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return null
}

/** One JSON:API anime record → the search shape. */
function toSearchResult(record) {
  const attributes = record?.attributes ?? {}
  return {
    kitsuId: String(record?.id ?? ''),
    slug: firstString(attributes.slug),
    type: mapShowType(attributes.showType),
    title: firstString(attributes.titles?.en, attributes.canonicalTitle, attributes.slug),
    year: yearOf(attributes.startDate),
    poster: imageUrl(attributes.posterImage),
    episodeCount: episodeCountOf(attributes.episodeCount)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Search Kitsu by free text.
 *
 * An empty query is not an error: it is a query nobody asked for, so it returns
 * `[]` without touching the network.
 *
 * `limit` is clamped to `[1, KitsuMaxPageSize]` inside `requestJson`: asking for
 * 50 does not produce a Kitsu 400, it produces a well-formed request for 20.
 *
 * @param {string} query
 * @param {{limit?: number, timeoutMs?: number}} [options]
 * @returns {Promise<Array<{kitsuId: string, slug: string|null, type: 'series'|'movie',
 *   title: string|null, year: number|null, poster: string|null, episodeCount: number|null}>>}
 */
export async function search(query, { limit = 20, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const text = String(query ?? '').trim()
  if (!text) return []

  // `sort` is intentionally absent: `sort=-searchScore` is a measured HTTP 400.
  const { payload } = await requestJson(
    '/anime',
    { 'filter[text]': text, 'page[limit]': limit },
    { timeoutMs }
  )

  const records = Array.isArray(payload?.data) ? payload.data : []
  return records.map(toSearchResult)
}

/**
 * Full metadata for one anime, Stremio `meta` shaped, with every episode.
 *
 * `id` is the bare Kitsu id, not a prefixed one: this function takes that same
 * id as input, and keeping it round-trippable means `meta(meta(x).id)` is valid
 * without the caller knowing any prefix convention.
 *
 * `budgetMs` (default META_BUDGET_MS) covers the /anime request AND every
 * /episodes page, because the route's 30 s is spent on this one call. If it
 * expires, this throws a KitsuError with `reason: 'budget'`: a partial episode
 * list is never returned as a success.
 *
 * @param {string|number} kitsuId
 * @param {{timeoutMs?: number, maxEpisodes?: number, budgetMs?: number|null}} [options]
 * @returns {Promise<{id: string, type: 'series'|'movie', name: string, poster: string|null,
 *   background: string|null, description: string|null, year: number|null,
 *   genres: string[], episodes: Array<{number: number|null, title: string|null, aired: string|null}>}>}
 */
export async function meta(
  kitsuId,
  { timeoutMs = REQUEST_TIMEOUT_MS, maxEpisodes = Infinity, budgetMs = META_BUDGET_MS } = {}
) {
  const id = String(kitsuId ?? '').trim()
  if (!id) throw new KitsuError('meta(): kitsuId mancante o vuoto', { reason: 'empty' })

  // Started BEFORE the first request, so the budget covers the whole call and not
  // only its slowest phase.
  const deadlineAt = budgetMs === null || !Number.isFinite(Number(budgetMs)) ? null : Date.now() + Number(budgetMs)

  const encoded = encodeURIComponent(id)
  const { payload, status, url } = await requestJson(`/anime/${encoded}`, { include: 'genres' }, { timeoutMs })

  // Single-resource endpoint: `data` is the object itself, not an array.
  const record = firstRecord(payload?.data)
  if (!record) {
    throw new KitsuError(`GET ${url} -> HTTP ${status} ma la risorsa è vuota (id inesistente?)`, {
      status,
      url,
      reason: 'empty'
    })
  }

  const attributes = record.attributes ?? {}

  // Genres ride in `included` because of `?include=genres`: one request, no N+1.
  const genres = (Array.isArray(payload.included) ? payload.included : [])
    .filter((entry) => GENRE_TYPES.has(entry?.type))
    .map((entry) => firstString(entry?.attributes?.name) ?? firstString(entry?.id))
    .filter(Boolean)

  // `meta.count` (measured: 1410 for One Piece) is what the paginate loop uses to
  // know when to stop; `sort=number` is legitimate HERE, unlike on /anime.
  const { records: episodeRecords } = await paginate(
    `/anime/${encoded}/episodes`,
    {},
    { timeoutMs, pageSize: EPISODE_PAGE_SIZE, sort: 'number', maxRecords: maxEpisodes, deadlineAt }
  )

  const episodes = episodeRecords.map((episode) => {
    const episodeAttributes = episode?.attributes ?? {}
    return {
      number: absoluteNumberOf(episodeAttributes),
      title: firstString(episodeAttributes.title),
      aired: firstString(episodeAttributes.aired)
    }
  })

  const name = firstString(attributes.titles?.en, attributes.canonicalTitle, attributes.slug) ?? id

  return {
    id: String(record.id ?? id),
    type: mapShowType(attributes.showType),
    name,
    poster: imageUrl(attributes.posterImage),
    background: imageUrl(attributes.coverImage),
    description: firstString(attributes.synopsis) ?? name,
    year: yearOf(attributes.startDate),
    genres,
    episodes
  }
}