// =============================================================================
// PROVENANCE — DERIVED FILE, DO NOT REWRITE
//   upstream : shiru-italian-streaming (GNU GPL v3)
//   file     : animesaturnsearch/sources/animesaturn.js
//   project  : https://github.com/Suplic0z05/shiru-italian-streaming
//
// The body below this banner is byte-identical to upstream, including the four
// measured hops (/api/watch -> embed shell -> play.saturncdn.net -> base64 +
// repeating-key XOR decode) and the empirical write-up of that XOR key. That
// derivation was measured sample by sample and is not something to re-guess. Do
// not "improve", tidy, rewrite or strip its error handling: if it is wrong, fix
// it upstream and re-copy.
//
// ADAPTATION FOR NODE: none was needed, and that is a measured result rather
// than an assumption. ES module, no bundler-only syntax; fetch, AbortController,
// AbortSignal.timeout and Buffer are all Node globals on >= 18. `export default
// new class …` is an INSTANCE, so resolver.js takes the static default. The
// file's own comment records that the resolved media URLs are time-based
// (expires ~ now + 12 h) and regenerate: that is why nothing in this project
// caches them.
//
// CONTRACT PRESERVED HERE ON PURPOSE:
//   * single() / batch() / movie() resolve to a REAL ARRAY (the consumer spreads
//     the awaited value); diagnostics ride along on .errors.
//   * genuine no-match -> [] ; real failure -> throw naming URL and status.
//   * validate() is async, resolves true/false, and never throws.
//   * hash is '' on every row: HTTPS media, never a torrent or infohash.
//
// ONE DELIBERATE DEVIATION, and it is in the shared body rather than in this
// banner: the dub/sub tagging does NOT import `detectVariant` from
// `src/variant.js`, it keeps the same token sets locally. An import would have
// to sit inside the body to keep the two copies byte-identical, and the upstream
// addon is standalone — there is no `src/variant.js` in shiru-italian-streaming
// to resolve `../variant.js` to, so an import there is ERR_MODULE_NOT_FOUND at
// load. The copy is pinned rather than trusted: `test/saturn-variant.test.mjs`
// drives every marker this file can read through the real `single()` and asserts
// that `variant.js` resolves all of them identically, so the two cannot drift
// silently. `resolver.js` still calls `detectVariant(row)` on the row and gets
// the same answer.
// =============================================================================
// AnimeSaturn Source for Shiru
// HTTP streaming provider for animesaturn.net (Italian subbed anime).
//
// ── Verified chain (re-measured 2026-10-05, six queries: One Piece, Naruto,
// ── Kimetsu no Yaiba, Pokemon, Shingeki no Kyojin, I Cavalieri dello Zodiaco)
// ── No interactive anti-bot wall: only a Cloudflare JSD script, no challenge.
// ── The as_session cookie is set but NOT required (verified cookieless).
//
// 1. search  GET /filter?key=<query>&dub=1|0  -> 200, one pass per variant
//    `dub=1` returned 30/30 cards carrying <span class="ac__dub-badge">DUB</span>
//    and `dub=0` returned 30/30 carrying none, so the two result sets are read
//    separately and kept apart. Results are the anchors with class="ac group". A
//    naive href="/anime/" sweep returns 35 links of which only 30 are real
//    results: the first 5 are a hero banner. Order is NOT relevance ("Naruto"
//    returns "Boruto: Naruto Next Generations" first), so selection is by title.
//    SLUGS CONTAIN UPPERCASE (`one-piece-ita-bz8UJ`), they come verbatim from
//    href, and a [a-z0-9-]+ slug pattern drops them silently. The same `key=`
//    query returns BOTH `one-piece-PmTvj` (sub) and `one-piece-ita-bz8UJ` (dub)
//    as two cards whose titles differ only by a trailing "(ITA)", which is why
//    the two passes are merged by slug and never by title.
// 2. episodes  live at /episode/<slug>/ep-<N>    (NOT "/ep/...-ep-N": that
//    pattern has 0 occurrences on the page)
// 3. resolve, four plain fetches:
//    hop1  GET /api/watch/<slug>/ep-<N>  -> 200 JSON {episodeId, videoUrl}
//    hop2  GET <videoUrl>                -> ~5 KB shell, no player in the
//          HTML. The player only exists at runtime, so the inline
//          `window.__E={i:<id>,k:"<token>",e:<expires>}` is parsed out. i/k/e
//          are read from the embed shell and NOT assumed to equal the values
//          embedded in hop1's videoUrl (they do today, but that is not relied on).
//    hop3  GET https://play.saturncdn.net/embed/<i>/playlist?token=<k>&expires=<e>
//          -> 200 JSON {d, p, t}
//    hop4  decode `d` -> the real media URL (see below)
//    Tokens are time-based (expires ~ now + 12 h) and regenerate, so hops 2-4
//    run per episode and are never cached across calls.
//
// ── hop4 transform, derived empirically and recorded here on purpose ────────
// It is standard base64, then a repeating-key XOR whose key is the *ASCII
// bytes of the token string* (NOT the token's raw 16 hex bytes -- that
// produces garbage). The key was not taken on faith: assuming the plaintext
// starts with "https://" and recovering key[i] = cipher[i] ^ plaintext[i] for
// i<8 yields the first 8 bytes of the token's ASCII form exactly, e.g. for
// token d523809b7dff19d43106855e6e90d3a1 the implied keystream is
// 6435323338303962 = "d523809b". Decrypting with the full 32-char token then
// yields 112/112 printable ASCII bytes starting with "https://" and ending in
// a real media extension. The same transform also decodes `p` (poster) and
// `t` (thumbnails.vtt) into well-formed URLs, which is a second independent
// confirmation that it is the site-wide codec and not a coincidence of one
// sample.
//
// Measured sample (token above, d = "WBFGSBUOGk5ESkEABU1aAUhNDFEeQUxHAFBa..."):
//   cipher[0]=0x0c  key[0]='d'(0x64)  0x0c^0x64 = 0x68 = 'h'  -> "https://..."
//   full plaintext:
//   https://srv37.nezumi.streampeaker.org/_t/1791217147/CZ73Tlgxv_z27f_Z7WnnzQ/DDL/ANIME/OnePiece/0001/playlist.m3u8
//
// IMPORTANT CORRECTION to the assumption that every payload ends in .m3u8:
// it does not. The same codec emits progressive .mp4 for most other titles
// (Kimetsu, Shingeki verified 206 video/mp4). Accepting only .m3u8 silently
// threw away working streams -- see resolveEpisode().
//
// ── Why `hash` is EMPTY ───────────────────────────────────────────────────
// This site publishes HTTP progressive streams. It exposes no torrents, no
// magnets and no infohashes (measured: zero). `hash` is a required field and
// doubles as the dedupe key AND the infohash handed to Shiru's BitTorrent
// engine, so a fabricated 40-hex string would look like a valid result while
// being unresolvable. An empty hash plus the direct stream URL in `link` is
// the honest encoding of "playable, but not a torrent".

const BASE = 'https://www.animesaturn.net'
const PLAY = 'https://play.saturncdn.net'

// Hosts that must never leak into a `link`. The only iframe on an episode page
// is //acceptable.a-ads.com/... i.e. an advertisement; the previous version of
// this file used <iframe src> as its video fallback and handed that ad URL to
// the player. Iframes are never consulted, and these hosts are rejected
// explicitly as a second line of defence.
const AD_HOSTS = ['a-ads.com', 'adservice.', 'googlesyndication.com', 'doubleclick.net']

/** lowercase, strip diacritics, drop every non-alphanumeric char. */
const norm = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')

const isAdHost = (u) => {
  try {
    const h = new URL(u).hostname.toLowerCase()
    return AD_HOSTS.some((bad) => h === bad || h.endsWith('.' + bad) || h.includes(bad))
  } catch {
    return true // unparseable URL is not something we will hand to a player
  }
}

/**
 * ── dub / sub ────────────────────────────────────────────────────────────────
 *
 * The variant is bound HERE, at catalog time, because that is the only place on
 * this site where it still exists. Measured, in order of reliability:
 *
 *   `GET /filter?dub=1`  → 30/30 cards carry `<span class="ac__dub-badge">DUB`
 *   `GET /filter?dub=0`  → 30/30 cards carry none            (server-side, exact)
 *   card badge inside `class="ac group"`                    → per-slug, scoped
 *   `GET /anime/{slug}`   → 30 badges on the sub page, 29 on the dub page, and
 *                           every one of them belongs to a RELATED card. The only
 *                           self-scoped signal there is `<title>`
 *                           ("Streaming Sub ITA" vs "Streaming ITA"), and a
 *                           `<title>` read is one rename away from reading a
 *                           neighbouring series.
 *   `GET /api/watch/{slug}/ep-{N}` → no language field at all, and the media URL
 *                           it resolves to has none either.
 *
 * So the two signals that are allowed to speak are the QUERY PROVENANCE (which
 * `dub=` value produced this card) and the CARD BADGE (scoped to the anchor that
 * carries this slug). They must agree; a card that yields neither stays
 * `unknown`.
 *
 * NEVER a bare `ITA`. Every marker on this site is spelled `ITA` — `(ITA)`,
 * `Sub ITA`, `_SUB_ITA` — and `includes('ITA')` therefore matches all of them at
 * once, including the ones that say nothing about the audio. `variant.js` states
 * the same rule for the same reason, and this file keeps its own copy of the
 * token sets rather than importing that module: this file is byte-identical to
 * the standalone upstream addon, which has no `src/variant.js` to import. The
 * copy is not trusted on its own — `test/saturn-variant.test.mjs` asserts that
 * every marker resolved here resolves the same way through `variant.js`.
 */
const VARIANT_DUB = 'dub'
const VARIANT_SUB = 'sub'
const VARIANT_UNKNOWN = 'unknown'

/** Whole-token match, never a substring. */
const DUB_MARKER_TOKENS = new Set([
  'dub', 'dubs', 'dubbed', 'dubbing', 'doppiato', 'doppiata', 'doppiaggio'
])
const SUB_MARKER_TOKENS = new Set([
  'sub', 'subs', 'subbed', 'subbing', 'subtitled', 'subtitle', 'subtitles',
  'sottotitolato', 'sottotitolata', 'sottotitoli', 'sottotitolo'
])

/**
 * Read ONE marker string. Returns `unknown` for no marker AND for both markers:
 * neither case can be turned into a variant without guessing.
 * @param {unknown} value
 * @returns {'dub'|'sub'|'unknown'}
 */
const markerVariant = (value) => {
  if (typeof value !== 'string' || !value.trim()) return VARIANT_UNKNOWN
  const tokens = value.toLowerCase().split(/[^a-z]+/).filter(Boolean)
  const isDub = tokens.some((t) => DUB_MARKER_TOKENS.has(t))
  const isSub = tokens.some((t) => SUB_MARKER_TOKENS.has(t))
  if (isDub === isSub) return VARIANT_UNKNOWN
  return isDub ? VARIANT_DUB : VARIANT_SUB
}

/**
 * Resolve one card's variant from every signal it carries.
 *
 * `marker` in the result is the UPSTREAM TEXT the answer came from — the badge
 * when the card has one (`DUB`), otherwise the site's own word for the `dub=`
 * value (`DOPPIATO` / `SOTTOTITOLATO`) — so `detectVariant(row)` downstream
 * re-derives exactly the same answer from exactly the same bytes.
 *
 * @param {string[]} provenances marker text per query pass that returned the card
 * @param {string} badge `ac__dub-badge` text, empty when the card has none
 * @returns {{variant: 'dub'|'sub'|'unknown', marker: string}}
 */
const variantFrom = (provenances, badge) => {
  // Badge first: it is scoped to THIS slug. Provenance is scoped to the query.
  const candidates = []
  if (typeof badge === 'string' && badge.trim()) candidates.push(badge.trim())
  for (const p of provenances || []) {
    if (typeof p === 'string' && p.trim()) candidates.push(p.trim())
  }

  const resolved = candidates
    .map((text) => ({ text, variant: markerVariant(text) }))
    .filter((c) => c.variant !== VARIANT_UNKNOWN)

  if (!resolved.length) return { variant: VARIANT_UNKNOWN, marker: '' }

  // The same slug returned by both passes is ONE series, and the server-side
  // filter did not separate it. Provenance then disagrees with itself by
  // construction, which is exactly the ambiguity that must not be guessed away.
  const answers = new Set(resolved.map((c) => c.variant))
  if (answers.size > 1) return { variant: VARIANT_UNKNOWN, marker: '' }

  return { variant: resolved[0].variant, marker: resolved[0].text }
}

/**
 * The two catalog passes, in output order.
 *
 * `dub=1` is the site's "Doppiato" filter and `dub=0` its "Sottotitolato"; the
 * words are the site's own, taken from the filter control that builds the URL,
 * and they are the token `dub=0` actually resolves to once a human reads it.
 */
const VARIANT_PASSES = [
  { dub: 1, marker: 'DOPPIATO' },
  { dub: 0, marker: 'SOTTOTITOLATO' }
]

/**
 * Union of candidate lists, keyed by SLUG.
 *
 * Never by title: `key=One Piece` returns `one-piece-PmTvj` (sub) and
 * `one-piece-ita-bz8UJ` (dub) as two cards with two titles that differ only by a
 * trailing "(ITA)", so a title-keyed merge would silently drop one variant.
 *
 * @param {Array<object[]>} lists
 * @returns {object[]}
 */
const mergeCards = (lists) => {
  const seen = new Map()
  for (const card of lists.flat()) {
    if (!seen.has(card.slug)) seen.set(card.slug, card)
  }
  return [...seen.values()]
}

/**
 * Pack results into the shape the real loader actually consumes.
 *
 * MEASURED on Shiru 6.9.0 `worker.js`: there are TWO different shapes in play
 * and they are easy to confuse.
 *
 *   - `:119`  promises.push(this._querySource(...))  -> consumed at `:124-125`
 *              as `res.results` / `res.errors`. That is the WRAPPER's return.
 *   - `:141`  promises.push(source.single(options))   -> consumed at `:150`
 *              as `results.push(...result.value)`. That is the SOURCE's return,
 *              and it is SPREAD AS AN ARRAY.
 *
 * A `{results, errors}` object returned from `single()` therefore throws
 * `TypeError: Spread syntax requires ...iterable`, and `_querySource()` swallows
 * it as a rejected promise, so the source reports "found no results" instead of
 * crashing. `index.d.ts:107` (`Promise<TorrentResult[]>`) is correct; the
 * `{results, errors}` pair belongs to the wrapper, one layer up.
 *
 * `errors` on the returned array is a property the host NEVER reads: the worker
 * builds its own list at `:147` and fills it only from REJECTED promises
 * (`:153`). `pack()` is therefore the exit for a GENUINE NO-MATCH and for the
 * success path -- an empty array with a diagnostic riding along is exactly right
 * there. See `settle()` for a real failure.
 */
const pack = (results, errors) => {
  const out = Array.isArray(results) ? [...results] : []
  out.errors = [...errors]
  return out
}

/**
 * Exit for a REAL FAILURE: rejects, so the cause actually reaches the user.
 *
 * Measured on Shiru 6.9.0. `worker.js:153` builds the host error list exclusively
 * from `result.status === 'rejected'`; it never reads a returned value's
 * diagnostics. So returning an empty array plus a detailed diagnostic degrades to
 * `worker.js:127` synthesising "Source animesaturn-it found no results.", and
 * `handler.js:118` throws precisely that string to the UI -- the real cause
 * (search 404, expired CDN playlist, rejected ad host) is hidden behind a message
 * that blames nothing. `handler.js:116-117` is the only path that surfaces a
 * specific message, and it is reached solely by a rejection.
 *
 * Rejecting is safe and isolated: every entry point runs inside
 * `Promise.allSettled` (`worker.js:141-143`), so one rejection becomes one
 * user-visible message and cannot take down the sibling entry points.
 *
 * Degrades to `pack()` when there is no message to report. That matters: an
 * episode absent upstream (`resolveEpisode` -> `{noMatch:true}`) carries an EMPTY
 * diagnostics list because nothing went wrong, and `handler.js:116` joins the
 * messages with `|| 'Unknown error'` -- throwing there would surface the literal
 * string "Unknown error", which is worse than an honest "found no results".
 */
const settle = (results, errors) => {
  const out = pack(results, errors)
  if (!out.errors.length) return out
  const err = new Error(out.errors.join(' | '))
  err.errors = out.errors // structured diagnostics, for logs and verify.mjs
  throw err
}

export default new class AnimeSaturn {
  url = BASE

  headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'it-IT,it;q=0.9',
    Referer: `${BASE}/`
  }

  /** fetch that never throws: returns {ok, status, body} and records failures. */
  async grab(url, extra = {}) {
    try {
      const res = await fetch(url, {
        headers: { ...this.headers, ...extra },
        redirect: 'follow',
        signal: AbortSignal.timeout(20000)
      })
      return { ok: res.ok, status: res.status, body: await res.text(), res }
    } catch (e) {
      return { ok: false, status: 0, body: '', error: e?.message || String(e) }
    }
  }

  async grabJson(url, extra = {}) {
    const r = await this.grab(url, { Accept: 'application/json', ...extra })
    if (!r.ok) return { ok: false, status: r.status, error: r.error, data: null }
    try {
      return { ok: true, status: r.status, data: JSON.parse(r.body) }
    } catch (e) {
      return { ok: false, status: r.status, error: `JSON non valido: ${e.message}`, data: null }
    }
  }

  // ── search results ───────────────────────────────────────────────────────

  /** Pull the real result cards out of /filter. `class="ac group"` is required. */
  parseCandidates(html) {
    const out = []
    const re = /<a href="\/anime\/([^"]+)" class="ac group"[\s\S]*?<\/a>/g
    let m
    while ((m = re.exec(html)) !== null) {
      const block = m[0]
      const pick = (r) => (block.match(r) || [])[1]
      const title = (
        pick(/class="ac__title">([\s\S]*?)<\/h3>/) ||
        pick(/<img[^>]+alt="([^"]*)"/) ||
        ''
      )
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&#039;/g, "'")
        .trim()

      const sub = (pick(/class="ac__sub">([\s\S]*?)<\/p>/) || '')
        .replace(/&middot;/g, '·')
        .replace(/&amp;/g, '&')
        .replace(/&#039;/g, "'")
        .trim()

      // ac__score wraps an inline <svg> star, so the tags go before parsing.
      const scoreRaw = (pick(/class="ac__score">([\s\S]*?)<\/span>\s*<\/div>/) || '').replace(
        /<svg[\s\S]*?<\/svg>/g,
        ''
      )
      const score = parseFloat((scoreRaw.match(/(\d+(?:\.\d+)?)/) || [])[1] ?? '')

      // The ONLY language marker this card carries. `pick()` reads inside the
      // matched anchor block, so the badge cannot leak in from a neighbouring
      // card — which is precisely the false positive the series page produces,
      // where ~30 badges belong to RELATED cards rather than to the series.
      const dubBadge = (
        pick(/class="ac__dub-badge"[^>]*>([\s\S]*?)<\/span>/) || ''
      )
        .replace(/<[^>]+>/g, '')
        .trim()

      out.push({
        slug: m[1],
        title,
        nrm: norm(title),
        type: (pick(/class="ac__type-badge">([\s\S]*?)<\/span>/) || '').trim(),
        score: Number.isNaN(score) ? null : score,
        sub,
        year: (sub.match(/(\d{4})/) || [])[1] ?? null,
        // The site renders the count literally as "?? ep" on some cards; that
        // is NOT a parse failure, it just means "unknown".
        episodes: (sub.match(/·\s*(\d+)\s*ep/i) || [])[1] ?? null,
        dubBadge,
        rank: out.length
      })
      if (!title) continue
    }
    return out
  }

  /**
   * Rank a candidate against every title the host gave us.
   * 3 exact | 2 startswith (either direction) | 1 contains | 0 no relation.
   */
  tierFor(cand, queryTitles) {
    let best = 0
    for (const t of queryTitles) {
      const q = norm(t)
      if (!q || !cand.nrm) continue
      let tier = 0
      if (cand.nrm === q) tier = 3
      else if (cand.nrm.startsWith(q) || q.startsWith(cand.nrm)) tier = 2
      else if (cand.nrm.includes(q) || q.includes(cand.nrm)) tier = 1
      if (tier > best) best = tier
      if (best === 3) break
    }
    return best
  }

  /**
   * Pick the best card. Order is by tier, then by candidate length (closest to
   * the query wins, so "Pokemon (ITA)" beats "Pokemon (2019)"), then score,
   * then the site's own rank. Deliberately never "first result".
   */
  pickByTitle(candidates, queryTitles) {
    let best = null
    let bestTier = 0
    for (const c of candidates) {
      const tier = this.tierFor(c, queryTitles)
      if (tier === 0) continue
      if (
        !best ||
        tier > bestTier ||
        (tier === bestTier && c.nrm.length < best.nrm.length) ||
        (tier === bestTier && c.nrm.length === best.nrm.length && (c.score ?? 0) > (best.score ?? 0))
      ) {
        best = c
        bestTier = tier
      }
    }
    return bestTier ? { card: best, tier: bestTier } : null
  }

  /**
   * Second chance, used when no card title matches lexically at all.
   *
   * This is not hypothetical: the query "Shingeki no Kyojin" has ZERO lexical
   * overlap with any of the 21 cards, because the site is Italian and calls the
   * series "L'attacco dei Giganti". Rule-based matching would return empty for
   * a perfectly good result. The anime page carries schema.org JSON-LD
   * (TVSeries) whose `alternateName` is the original title
   * ("alternateName":"Shingeki no Kyojin"), so the site itself supplies the
   * mapping and we match on it instead of guessing.
   *
   * TV/DUB cards are scanned first (series 1 is the usual intent), capped so a
   * bad query cannot fan out over the whole catalogue.
   */
  async pickByAlternateName(candidates, queryTitles, errors, maxPages = 10) {
    const series = candidates.filter((c) => /^(tv|dub)$/i.test(c.type))
    const order = [...series, ...candidates.filter((c) => !series.includes(c))]
    const found = []
    let seen = 0

    for (const c of order) {
      if (seen >= maxPages) break
      seen++
      const page = await this.grab(`${BASE}/anime/${c.slug}`)
      if (!page.ok) continue

      const ld = (page.body.match(
        /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g
      ) || [])
        .map((s) => s.replace(/^[\s\S]*?>/, '').replace(/<\/script>$/, ''))
        .map((s) => {
          try {
            return JSON.parse(s)
          } catch {
            return null
          }
        })
        .filter(Boolean)

      for (const d of ld) {
        if (!d || !d.name) continue
        const alts = [d.name].concat(
          Array.isArray(d.alternateName) ? d.alternateName : d.alternateName ? [d.alternateName] : []
        )
        const probe = { nrm: norm(d.alternateName) }
        let tier = 0
        for (const t of queryTitles) {
          const q = norm(t)
          if (!q || !probe.nrm) continue
          if (probe.nrm === q) tier = Math.max(tier, 3)
          else if (probe.nrm.startsWith(q) || q.startsWith(probe.nrm)) tier = Math.max(tier, 2)
          else if (probe.nrm.includes(q) || q.includes(probe.nrm)) tier = Math.max(tier, 1)
        }
        if (tier > 0) {
          found.push({
            card: c,
            tier,
            nrm: probe.nrm,
            type: d['@type'] || '',
            published: d.datePublished || ''
          })
        }
      }
      if (found.some((f) => f.tier === 3)) break
    }

    if (!found.length) return null
    found.sort((a, b) => {
      if (b.tier !== a.tier) return b.tier - a.tier
      if (a.nrm.length !== b.nrm.length) return a.nrm.length - b.nrm.length
      return String(a.published).localeCompare(String(b.published))
    })
    if (seen >= maxPages && found.length) {
      // recorded, but deliberately not treated as a failure: the source worked
      errors.push(`ricerca per titolo alternativo: esaminate ${seen} schede (limite ${maxPages})`)
    }
    return { card: found[0].card, tier: found[0].tier, via: 'alternateName' }
  }

  // ── hop 4 codec ──────────────────────────────────────────────────────────

  /** base64 -> repeating-key XOR keyed with the token's ASCII bytes. */
  decodeField(b64, token) {
    const cipher = Buffer.from(String(b64), 'base64')
    if (!cipher.length) return ''
    const key = Buffer.from(String(token), 'utf8')
    const out = Buffer.from(cipher.map((b, i) => b ^ key[i % key.length]))
    return out.toString('utf8')
  }

  // ── the four hops ────────────────────────────────────────────────────────

  /**
   * Resolve one episode to a playable .m3u8.
   * @returns {Promise<{url?:string, error?:string, noMatch?:boolean}>}
   */
  async resolveEpisode(slug, episode) {
    const epPage = `${BASE}/anime/${slug}/ep-${episode}`

    // hop 1
    const w = await this.grabJson(`${BASE}/api/watch/${slug}/ep-${episode}`, {
      Referer: epPage,
      'X-Requested-With': 'XMLHttpRequest'
    })
    if (!w.ok) {
      if (w.status === 404) {
        // The anime exists (we found it via search) but that episode does not.
        // That is a genuine empty answer, not a broken source.
        return { noMatch: true }
      }
      return {
        error: `hop1 /api/watch/${slug}/ep-${episode} HTTP ${w.status}${w.error ? ' ' + w.error : ''}`
      }
    }
    const videoUrl = w.data?.videoUrl
    if (!videoUrl) {
      return { error: `hop1 senza videoUrl (episodeId=${w.data?.episodeId ?? '?'})` }
    }

    // hop 2 - the embed shell holds no player markup, only the runtime config
    const shell = await this.grab(videoUrl, { Referer: epPage })
    if (!shell.ok) return { error: `hop2 ${videoUrl} HTTP ${shell.status}` }

    const cfg = (shell.body.match(/window\.__E\s*=\s*\{([^}]*)\}/) || [])[1]
    if (!cfg) {
      return { error: `hop2 ${videoUrl}: script window.__E non trovato (layout cambiato?)` }
    }
    const g = (k) => {
      const v = (cfg.match(new RegExp(k + '\\s*:\\s*"?([^,"}]+)"?')) || [])[1]
      return v ? v.trim() : null
    }
    const i = g('i')
    const k = g('k')
    const e = g('e')
    if (!i || !k || !e) {
      return { error: `hop2 ${videoUrl}: __E incompleto (i=${i} k=${k} e=${e})` }
    }

    // hop 3
    const pl = `${PLAY}/embed/${i}/playlist?token=${k}&expires=${e}`
    const p = await this.grabJson(pl, { Referer: videoUrl, Origin: BASE })
    if (!p.ok) return { error: `hop3 ${pl} HTTP ${p.status}${p.error ? ' ' + p.error : ''}` }
    if (!p.data?.d) return { error: `hop3 ${pl}: payload senza campo "d"` }

    // hop 4
    //
    // The accepted shape is broader than "must end in .m3u8". Measured: the
    // site serves TWO payload shapes from the same endpoint --
    //   HLS master playlist  srv37.nezumi.streampeaker.org/_t/<exp>/<sig>/DDL/ANIME/OnePiece/0001/playlist.m3u8
    //   progressive MP4      srv13.sakuranbo.streampeaker.org/DDL/ANIME/KimetsuNoYaiba/KimetsuNoYaiba_Ep_01_SUB_ITA.mp4?token=..&expires=..
    // Both are genuine and playable (the .mp4 answers 206 video/mp4 with a
    // valid ftyp/isom header, ~261 MB). Gating on .m3u8 alone threw away
    // working streams for most of the catalogue, so both are accepted; a
    // decode must still be an absolute https URL to a media file.
    const media = this.decodeField(p.data.d, k)
    if (!/^https:\/\/\S+$/.test(media)) {
      return {
        error: `hop4 decodifica fallita su ${pl}: ottenuto ${JSON.stringify(media.slice(0, 40))}`
      }
    }
    if (!/\.(m3u8|mp4|m4v|webm)(\?|$)/i.test(media)) {
      return {
        error: `hop4 URL non-media su ${pl}: ${JSON.stringify(media.slice(0, 60))}`
      }
    }
    if (isAdHost(media)) {
      return { error: `hop4 rifiutato: host pubblicitario nel media ${media}` }
    }
    return { url: media }
  }

  // ── public API ───────────────────────────────────────────────────────────

  /**
   * Resolve a single episode.
   *
   * Returns a real ARRAY on the two exits that are NOT failures -- the success
   * path, and a genuine no-match. The loader spreads the resolved value
   * (`worker.js:151`), so anything non-iterable there is a hard TypeError.
   *
   * On a REAL failure this REJECTS instead, because that is the only route by
   * which the cause reaches the user: the loader builds its message list from
   * rejected promises alone (`worker.js:153`) and `handler.js:116-117` throws
   * that text to the UI, whereas a returned empty array is reported as the
   * contentless "Source animesaturn-it found no results." (`worker.js:127` +
   * `handler.js:118`). Rejections are isolated per entry point by
   * `Promise.allSettled` (`worker.js:141-143`), so `movie()` is unaffected by a
   * throw from `single()`.
   *
   * `.errors` is attached in every case and is diagnostic only: the host never
   * reads it from a fulfilled value. It is retained so verify.mjs and any log
   * line can see the detail, and on the throwing path it also rides on the
   * Error as `err.errors`.
   * @returns {Promise<object[]>}
   */
  async single(query) {
    const errors = []
    const titles = (query?.titles ?? []).filter(Boolean)
    const episode = Number(query?.episode) > 0 ? Number(query.episode) : 1

    // Not a throw, deliberately. `handler.js:316-338` builds `titles` from AniList
    // media filtered on `length > 3`, so `[]` is reachable when an entry has no
    // romaji/english title: a HOST-side data gap, not a broken source, and
    // "found no results" is the accurate thing to tell the user. Rejecting here
    // would blame AnimeSaturn for the host's missing data. The diagnostic is kept
    // in `.errors` so the case stays visible. To surface it instead, swap `pack`
    // for `settle` on this one line.
    if (!titles.length) return pack([], ['query.titles vuoto o assente'])

    // step 1 - search, ONCE PER VARIANT.
    //
    // `&dub=1` and `&dub=0` are the only reliable language primitive on this site
    // (measured 30/30 exact in both directions), so the catalog is read twice and
    // the two result sets are kept apart. They are the same query plus one
    // parameter: `key=` is untouched, and `titles` is untouched, so the host's
    // `length > 3` media filter and the existing search path behave as before.
    //
    // A pass that fails records a diagnostic and the OTHER pass still runs. Only
    // when neither pass yields a usable page does this reach the same two exits
    // as before: `settle` (real failure, the cause reaches the user) or `pack`
    // (the site said it has nothing).
    const passes = []
    for (const pass of VARIANT_PASSES) {
      const url = `${BASE}/filter?key=${encodeURIComponent(titles[0])}&dub=${pass.dub}`
      const page = await this.grab(url, { Referer: `${BASE}/` })
      if (!page.ok) {
        errors.push(`ricerca ${url} HTTP ${page.status}${page.error ? ' ' + page.error : ''}`)
        continue
      }

      const cards = this.parseCandidates(page.body)
      if (!cards.length) {
        // The site ships its own empty-state markup ("Nessun anime trovato" /
        // "Niente trovato per"). That is a genuine no-match, so this pass
        // contributes nothing and the other pass carries on.
        if (/Pagina non trovata/i.test(page.body)) {
          errors.push(`ricerca ${url}: pagina 404 del sito (rotta cambiata?)`)
          continue
        }
        if (/Nessun anime trovato|Nessun risultato|Niente trovato/i.test(page.body)) continue
        errors.push(`ricerca ${url}: nessuna scheda "ac group" nel markup (layout cambiato?)`)
        continue
      }

      passes.push({
        ...pass,
        url,
        cards,
        // Membership is what decides whether a detail-page hit belongs to a pass.
        slugs: new Set(cards.map((c) => c.slug))
      })
    }

    if (!passes.length) {
      if (errors.length) return settle([], errors)
      // Genuine no-match on both passes: nothing failed, so nothing is thrown.
      return pack([], errors)
    }

    // step 2 - pick one series PER PASS, by title and never by position.
    //
    // Per pass rather than once over the union: `key=One Piece` returns BOTH
    // `one-piece-PmTvj` (sub) and `one-piece-ita-bz8UJ` (dub) on the same card
    // list, so a single pick over the union would drop one variant on the floor
    // and the title that matched would decide which audio the user gets. Ranking
    // inside a pass is untouched: tier, then shortest normalised title, then
    // card score — exactly what `pickByTitle` already did.
    const picks = []
    for (const pass of passes) {
      const byTitle = this.pickByTitle(pass.cards, titles)
      picks.push({ pass, card: byTitle ? byTitle.card : null, via: byTitle ? 'titolo' : null })
    }

    if (picks.some((p) => !p.card)) {
      // One detail sweep over the UNION, never one per pass: the alternateName it
      // reads is a property of the SERIES, not of the variant, and it is the only
      // part of this path that costs requests.
      const alt = await this.pickByAlternateName(mergeCards(passes.map((p) => p.cards)), titles, errors)
      if (alt) {
        for (const p of picks) {
          if (!p.card && p.pass.slugs.has(alt.card.slug)) {
            p.card = alt.card
            p.via = 'titolo alternativo'
          }
        }
      }
    }

    // Distinct slugs only. A slug both passes picked is ONE series: it gets ONE
    // row, and its variant falls out of the badge plus both provenances — which
    // disagree by construction when the server-side filter failed to separate
    // them, so that slug lands on `unknown` rather than on a coin flip.
    const chosen = []
    const seenSlugs = new Set()
    for (const p of picks) {
      if (!p.card) continue
      if (seenSlugs.has(p.card.slug)) {
        chosen.find((c) => c.card.slug === p.card.slug).provenances.push(p.pass.marker)
        continue
      }
      seenSlugs.add(p.card.slug)
      chosen.push({ card: p.card, via: p.via, provenances: [p.pass.marker] })
    }

    if (!chosen.length) {
      return settle(
        [],
        errors.length
          ? errors
          : [`nessuna scheda corrisponde a "${titles[0]}" (titolo e titolo alternativo)`]
      )
    }

    // step 3 - four hops to a media URL, once per distinct series.
    //
    // A dub that will not resolve must not hide the sub that did, so a failing
    // row is recorded and the loop continues. The two original exits are
    // preserved at the end: throw when every row failed, stay quiet when the
    // series exist but that episode does not.
    const results = []
    for (const entry of chosen) {
      const card = entry.card
      const res = await this.resolveEpisode(card.slug, episode)
      if (res.error) {
        errors.push(res.error)
        continue
      }
      if (res.noMatch || !res.url) continue
      if (isAdHost(res.url)) {
        errors.push(`rifiutato host pubblicitario: ${res.url}`)
        continue
      }

      const { variant, marker } = variantFrom(entry.provenances, card.dubBadge)
      results.push({
        title: `${card.title} - Ep ${episode} [AS]`,
        link: res.url,
        seeders: 0,
        leechers: 0,
        downloads: 0,
        accuracy: 'high',
        // EMPTY ON PURPOSE. Animesaturn streams over HTTP and publishes no
        // torrent/magnet/infohash, while Shiru's BitTorrent engine needs one
        // here. A made-up hash would be a plausible-looking dead result.
        hash: '',
        size: 0,
        date: new Date(),
        type: 'best',
        // provenance, harmless for the host and useful in a log line
        source: 'animesaturn',
        matchedBy: entry.via,
        animeSlug: card.slug,
        animeTitle: card.title,
        animeType: card.type,
        animeScore: card.score,
        // `dub` | `sub` | `unknown`, and `unknown` is a real answer: it says the
        // site did not state one. It is never defaulted to `sub`.
        variant,
        // The raw upstream marker the answer came from, so the row is auditable
        // and `detectVariant(row)` reproduces `variant` from the same bytes.
        language_type: marker
      })
    }

    if (results.length) return pack(results, errors)
    if (errors.length) return settle([], errors)
    // Nothing failed: the series exists, that episode simply does not.
    return pack([], errors)
  }

  /** No batch releases on this site. */
  async batch() {
    return pack([], [])
  }

  async movie(query) {
    return this.single({ ...query, episode: 1 })
  }

  /** Cheapest meaningful liveness probe. */
  async validate() {
    const r = await this.grab(this.url, { 'X-Requested-With': 'XMLHttpRequest' })
    return !!r.ok
  }
}