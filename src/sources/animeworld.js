// =============================================================================
// PROVENANCE — DERIVED FILE, DO NOT REWRITE
//   upstream : shiru-italian-streaming (GNU GPL v3)
//   file     : animeworldsearch/sources/animeworld.js
//   project  : https://github.com/Suplic0z05/shiru-italian-streaming
//
// The body below this banner is byte-identical to upstream. Its search, parsing
// and URL-resolution logic is covered by upstream tests and was measured against
// the live site, so it is copied rather than reimplemented. Do not "improve",
// tidy, rewrite or strip its error handling: if it is wrong, fix it upstream and
// re-copy.
//
// ADAPTATION FOR NODE: none was needed, and that is a measured result rather
// than an assumption. This file was already an ES module with no bundler-only
// syntax, and everything it uses — fetch, AbortController, AbortSignal.timeout,
// String#normalize — exists as a global on Node >= 18. It exports
// `new class …` (an INSTANCE, not a class), so resolver.js takes the static
// default and never calls `new`. Verified: importing all three files under
// `"type": "module"` yields objects carrying single/batch/movie/validate.
//
// CONTRACT PRESERVED HERE ON PURPOSE:
//   * single() / batch() / movie() resolve to a REAL ARRAY (the consumer spreads
//     the awaited value); diagnostics ride along on .errors.
//   * genuine no-match -> [] ; real failure -> throw naming URL and status.
//   * partial batch with >= 1 survivor -> return the array; throw only on zero.
//   * validate() is async, resolves true/false, and never throws.
//   * hash is '' on every row: this site publishes no torrent, magnet or
//     infohash, only plain HTTPS media. Never fabricate one.
// AnimeWorld Source for Shiru
// Provides direct HTTP streaming links (SUB ITA) from animeworld.ac.
//
// ---------------------------------------------------------------------------
// DIAGNOSTICS CONTRACT
// `single`, `batch` and `movie` each resolve to a real ARRAY of TorrentResult,
// with the diagnostics attached as an `errors` property on that array:
//   const out = []; out.errors = ['...']; return out
// The array is mandatory: the consumer spreads the awaited value
// (`results.push(...result.value)`), so a plain object is a TypeError.
//   * the array is empty on any failure;
//   * `errors` is populated ONLY for real failures: network error, non-2xx,
//     the site's HTTP-200 soft 404, an unparseable page, or an episode number
//     that does not exist. A genuine "this title is not on the site" returns
//     an empty array with `errors` empty, so the two stay distinguishable.
//
// WARNING: a returned `errors` property is NEVER read by the host. The worker
// builds its error list exclusively from REJECTED promises, so a real failure
// must THROW to be reported; returning would leave the user with a bare
// "Source animeworld-it found no results." and hide a 401, a soft 404 or a
// network error. Hence:
//   * success / genuine no-match -> resolve to the array (errors stays empty)
//   * real failure              -> reject with the diagnostics as the message
// Diagnostics are still assigned to `out.errors` before throwing, so tests and
// debuggers can read them off the same object.
//
// WHY hash IS ALWAYS EMPTY
// This site publishes no torrents, magnets or infohashes at all — it serves
// plain HTTP .mp4 streams. `TorrentResult.hash` is a required field (dedupe key
// + infohash for Shiru's BitTorrent engine), so it is set to '' on purpose.
// A fabricated infohash would produce a plausible-looking dead result, which is
// strictly worse than an empty one. Do not "fix" this by hashing the URL.
// ---------------------------------------------------------------------------

export default new class AnimeWorld {
  url = 'https://www.animeworld.ac'

  headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "it-IT,it;q=0.9",
    "Referer": "https://www.animeworld.ac/"
  }

  /** Network budget per request, so a stalled CDN cannot hang the host. */
  timeoutMs = 15000

  /** Cap for batch(): fetching a whole season would hammer the API. */
  maxBatchEpisodes = 5

  // -------------------------------------------------------------------------
  // Text helpers
  // -------------------------------------------------------------------------

  /**
   * Reusable title normalizer: lowercase, strip diacritics, strip every
   * non-alphanumeric character. Used for both the requested title and the
   * titles parsed out of `data-jtitle`, so the two are directly comparable.
   * @param {string} value
   * @returns {string}
   */
  normalizeTitle(value) {
    return String(value ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '')
  }

  /** `data-jtitle` arrives HTML-escaped (e.g. `One Piece: Barto&#x27;s ...`). */
  decodeEntities(value) {
    return String(value ?? '')
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
        try { return String.fromCodePoint(parseInt(h, 16)) } catch { return _ }
      })
      .replace(/&#(\d+);/g, (_, d) => {
        try { return String.fromCodePoint(+d) } catch { return _ }
      })
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
  }

  // -------------------------------------------------------------------------
  // Result list parsing
  // -------------------------------------------------------------------------

  /**
   * Return the inner HTML of every `<div class="film-list">` block.
   *
   * Scoping matters: a search page ALSO contains an unrelated "most viewed"
   * ranking block (`<i class="rank">` + `a.thumb`) with ~48 `/play/` anchors
   * for completely different anime. On a nonsense keyword the real filter list
   * is empty while those 48 sidebar anchors remain — parsing document-wide
   * would happily return the wrong anime for a query that has no match at all.
   * @param {string} html
   * @returns {string[]}
   */
  filmListRegions(html) {
    const regions = []
    const DIV = /<div\b|<\/div>/gi
    let cursor = 0

    while (cursor < html.length) {
      const marker = html.indexOf('class="film-list"', cursor)
      if (marker === -1) break

      const open = html.lastIndexOf('<div', marker)
      if (open === -1) break

      let depth = 0
      let end = html.length
      DIV.lastIndex = open
      let token
      while ((token = DIV.exec(html))) {
        if (token[0] === '</div>') {
          depth--
          if (depth === 0) { end = token.index + 6; break }
        } else {
          depth++
        }
      }

      regions.push(html.slice(open, end))
      cursor = Math.max(end, marker + 1)
    }

    return regions
  }

  /**
   * Collect the result entries of a film-list block.
   *
   * One entry is two anchors sharing the same href:
   *   <a href="/play/slug.ID" class="poster" data-tip="api/tooltip/160">   <- numeric anime id
   *   <a href="/play/slug.ID" data-jtitle="One Piece" class="name">      <- authoritative title
   * so entries are merged by href and in document order.
   *
   * @param {string} html
   * @returns {{href: string, animeId: string|null, title: string|null, order: number}[]}
   */
  collectResults(html) {
    const results = []
    const byHref = new Map()
    const ANCHOR = /<a\b([^>]*\bhref="\/play\/[^"]*"[^>]*)>/gi
    let match

    while ((match = ANCHOR.exec(html))) {
      const attributes = match[1]
      const href = (attributes.match(/href="(\/play\/[^"]+)"/i) || [])[1]
      if (!href) continue

      let entry = byHref.get(href)
      if (!entry) {
        entry = { href, animeId: null, title: null, order: byHref.size }
        byHref.set(href, entry)
        results.push(entry)
      }

      const animeId = (attributes.match(/data-tip="api\/tooltip\/(\d+)"/i) || [])[1]
      if (animeId && !entry.animeId) entry.animeId = animeId

      const jtitle = (attributes.match(/data-jtitle="([^"]*)"/i) || [])[1]
      if (jtitle && !entry.title) entry.title = this.decodeEntities(jtitle)
    }

    return results
  }

  /**
   * The `(ITA)` marker that files an entry as this site's DUB catalogue entry.
   *
   * Measured live, four entries, each paired with the filename the episode API
   * actually returned for its episode 1:
   *   "Naruto (ITA)"                            -> Naruto_Ep_001_ITA.mp4             (dub)
   *   "Pokemon Movie 20: Kimi ni Kimeta! (ITA)" -> Pokemon_Movie_20_ITA.mp4          (dub)
   *   "Boruto: Naruto Next Generations"         -> Boruto_Ep_001_SUB_ITA.mp4         (sub)
   *   "Pokemon Sun & Moon"                      -> PokemonSoleELuna_Ep_003_SUB_ITA.mp4 (sub)
   * So the marker is a CATALOGUE partition, not decoration on a title: the site
   * files a dub and a sub of the same show as two independent entries, which is
   * what makes a dub/sub pair recoverable at all.
   *
   * RETURN `null`, NOT `false`, for an unmarked entry. Whether an unmarked entry
   * is really a sub is decided by `selectAnimes`, which only claims `sub` for the
   * entry it matched as the counterpart of a `(ITA)` match — see the note there.
   * @param {string|null} title
   * @returns {boolean}
   */
  isDubEntry(title) {
    return /\(\s*ITA\s*\)/i.test(String(title ?? ''))
  }

  /**
   * The title with this site's dub marker removed, so a dub and a sub of the
   * same show compare equal. "Naruto (ITA)" -> "Naruto".
   * @param {string|null} title
   * @returns {string}
   */
  withoutDubMarker(title) {
    return String(title ?? '').replace(/\(\s*ITA\s*\)/ig, ' ').replace(/\s{2,}/g, ' ').trim()
  }

  /**
   * Pick the candidate that actually answers `requestedTitle`.
   *
   * The slug is a red herring (`one-piece-subita` is One Piece, id 160), so
   * `data-jtitle` is the authority. A first-match scrape is wrong for real
   * queries: "Naruto" hits Boruto first, "Pokemon" hits "Pokemon Movie 20".
   *
   * Tiers, strictest first:
   *   1. normalized title === query
   *   2. normalized title starts with query (shortest title wins: closest match,
   *      then document order) — "Naruto" -> "Naruto (ITA)", not the 5 Naruto movies
   *   3. slug name === query. AnimeWorld slugs carry the Italian name, so this
   *      is what rescues a dub-only title whose data-jtitle is the original
   *      ("I Cavalieri dello Zodiaco" -> data-jtitle "Saint Seiya: Knights of the
   *      Zodiac"). It is an *exact* comparison on purpose: a startswith slug
   *      match would re-admit the "Pokemon Movie 20" false positive.
   *   4. normalized title contains query (shortest, then document order)
   *
   * @param {{href: string, animeId: string|null, title: string|null, order: number}[]} candidates
   * @param {string} requestedTitle
   * @returns {object|null} null = genuinely no match for this title
   */
  selectAnime(candidates, requestedTitle) {
    const wanted = this.normalizeTitle(requestedTitle)
    if (!wanted) return null

    const slugNameOf = (entry) =>
      this.normalizeTitle((entry.href.split('/').pop() || '').replace(/\.[^.]+$/, ''))

    const exact = candidates.find((entry) => entry.title && this.normalizeTitle(entry.title) === wanted)
    if (exact) return exact

    const prefixed = candidates.filter((entry) => entry.title && this.normalizeTitle(entry.title).startsWith(wanted))
    if (prefixed.length) {
      return prefixed.slice().sort((a, b) =>
        this.normalizeTitle(a.title).length - this.normalizeTitle(b.title).length || a.order - b.order)[0]
    }

    const slugMatch = candidates.find((entry) => slugNameOf(entry) === wanted)
    if (slugMatch) return slugMatch

    const contained = candidates.filter((entry) => entry.title && this.normalizeTitle(entry.title).includes(wanted))
    if (contained.length) {
      return contained.slice().sort((a, b) =>
        this.normalizeTitle(a.title).length - this.normalizeTitle(b.title).length || a.order - b.order)[0]
    }

    return null
  }

  /**
   * The entry set for one logical show: the single best match, plus its
   * counterpart in the OTHER variant when the catalogue carries one.
   *
   * WHY THIS EXISTS. `selectAnime` returns one entry by construction, and on this
   * site that single return is the whole reason a dub is lost: AnimeWorld files
   * sub and dub as two separate catalogue entries, so `Naruto` and
   * `Naruto (ITA)` are BOTH in the index and only one of them can ever come out
   * of a single-answer selector. A caller asking for one show therefore got one
   * variant and never learned the other existed.
   *
   * HOW THE COUNTERPART IS FOUND, and why it is not simply "the other entry".
   * The primary match is whatever `selectAnime` already decided — every tier,
   * threshold and tie-break of the proven selector is untouched, so nothing here
   * can widen what counts as a match. The counterpart is then admitted only on a
   * strict condition, all three of which must hold:
   *
   *   1. it is the exact same show: `normalizeTitle(entry.title)` with the dub
   *      marker removed EQUALS the primary's marker-stripped normalized title.
   *      Equality, not `startsWith` and not `includes`. This is what stops
   *      "Naruto" from dragging in "Naruto: Shippuuden (ITA)", or "Pokemon" from
   *      dragging in "Pokemon Movie 20: Kimi ni Kimeta! (ITA)" — both of which
   *      the loose tiers in `selectAnime` would otherwise reach.
   *   2. it carries the opposite marker state from the primary.
   *   3. its href differs, so a self-match can never be emitted twice.
   *
   * WHAT `variant` MEANS HERE, precisely. `dub` is claimed only for an entry that
   * literally carries `(ITA)`, which the measurement above ties to a filename
   * without `SUB_`. `sub` is claimed for the unmarked counterpart of a dub entry
   * — i.e. only when this file has SEEN both halves of the pair and can name the
   * other one from the site's own partition. An unmarked entry that is not the
   * counterpart of a dub gets NO `variant` key at all, because for it this source
   * has said nothing about the audio track. This is deliberately stricter than
   * assuming "no marker = sub": that assumption is what made the previous label
   * a lie, and it would make an unmarked MOVIE silently claim to be subtitled.
   *
   * Returns `[]` when nothing matches, and always at most 2 entries.
   * @param {{href: string, animeId: string|null, title: string|null, order: number}[]} candidates
   * @param {string} requestedTitle
   * @returns {Array<{href: string, animeId: string|null, title: string, order: number, variant?: 'dub'|'sub'}>}
   */
  selectAnimes(candidates, requestedTitle) {
    const primary = this.selectAnime(candidates, requestedTitle)
    if (!primary) return []

    const primaryIsDub = this.isDubEntry(primary.title)
    // A dub entry is self-declaring, so it is labelled before any counterpart
    // lookup. An UNMARKED primary is left unlabelled here and only labelled `sub`
    // below, if a dub counterpart actually turns up — see the note on `variant`.
    const out = [{ ...primary, title: primary.title || requestedTitle }]
    if (primaryIsDub) out[0].variant = 'dub'

    // The key both entries must share once the marker is gone. When the PRIMARY
    // is unmarked its own title is already marker-free, so this is a no-op for it.
    const wantedKey = this.normalizeTitle(this.withoutDubMarker(primary.title))
    if (!wantedKey) return out

    const counterpart = candidates.find((entry) => {
      if (entry.href === primary.href) return false
      if (this.isDubEntry(entry.title) === primaryIsDub) return false
      if (!entry.title) return false
      return this.normalizeTitle(this.withoutDubMarker(entry.title)) === wantedKey
    })

    if (counterpart) {
      out.push({
        ...counterpart,
        title: counterpart.title || requestedTitle,
        variant: primaryIsDub ? 'sub' : 'dub'
      })
      // The pair is now resolved from BOTH sides, so the unmarked primary can be
      // labelled `sub` on that evidence rather than on the absence of a marker.
      if (!primaryIsDub) out[0].variant = 'sub'
    }

    return out
  }

  // -------------------------------------------------------------------------
  // Episode list parsing
  // -------------------------------------------------------------------------

  /**
   * Parse the episode anchors of a play page.
   *
   * Live attribute order is data-episode-id, data-id, data-episode-num, ... and
   * `data-id` is a TOKEN, not a number (cWAhIl, bwsCYS, Xk1-29) — so the three
   * fields are pulled with lookaheads, which are order-independent, all
   * anchored on the same `<a>`. The token charset is left open (`[^"]+`):
   * tokens are not always alphanumeric, Xk1-29 carries a hyphen, and a narrow
   * class silently loses that whole anime.
   *
   * The lookahead on `data-episode-num` is what makes the like button safe:
   * `<div id="loveButton" data-id="1749">` is the first numeric data-id on the
   * page (and 1749 happens to also be the anime id of the page it appears on),
   * so any document-wide `data-id="(\d+)"` silently returns the like count.
   *
   * The number always comes from data-episode-num / data-num, never from position.
   * @param {string} html
   * @returns {{num: number, altNum: number|null, token: string, episodeId: string|null, href: string}[]}
   */
  parseEpisodes(html) {
    const EPISODE_ANCHOR = /<a\b(?=[^>]*\bdata-episode-num="(\d+)")(?=[^>]*\bdata-num="(\d+)")(?=[^>]*\bdata-id="([^"]+)")(?=[^>]*\bdata-episode-id="(\d+)")(?=[^>]*\bhref="([^"]+)")[^>]*>/gi
    const episodes = []
    let match

    EPISODE_ANCHOR.lastIndex = 0
    while ((match = EPISODE_ANCHOR.exec(html))) {
      episodes.push({
        num: Number(match[1]),
        altNum: Number(match[2]),
        token: match[3],
        // Kept for diagnostics only: the API rejects it with 401.
        episodeId: match[4],
        href: match[5]
      })
    }

    return episodes
  }

  // -------------------------------------------------------------------------
  // Network
  // -------------------------------------------------------------------------

  /**
   * GET with error discrimination. Throws on network failure, non-2xx, and the
   * site's HTTP-200 soft 404.
   * @param {string} path absolute URL or site-relative path
   * @param {object} [extraHeaders]
   * @returns {Promise<{url: string, status: number, text: string}>}
   */
  async get(path, extraHeaders) {
    const url = /^https?:/i.test(path) ? path : `${this.url}${path}`

    let response
    try {
      response = await fetch(url, {
        headers: { ...this.headers, ...extraHeaders },
        redirect: 'follow',
        signal: AbortSignal.timeout(this.timeoutMs)
      })
    } catch (cause) {
      throw new Error(`GET ${url} -> network error: ${cause && cause.message ? cause.message : cause}`)
    }

    const text = await response.text()

    if (!response.ok) {
      throw new Error(`GET ${url} -> HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`)
    }

    // Soft 404: an unknown play path answers HTTP 200 with a "Pagina non
    // trovata" document, so response.ok alone would pass it through.
    if (/<title>[^<]*Pagina non trovata/i.test(text)) {
      throw new Error(`GET ${url} -> site soft-404 ("Pagina non trovata" served as HTTP ${response.status})`)
    }

    return { url: response.url, status: response.status, text }
  }

  /**
   * Search the filter page and resolve the anime entries for this title.
   *
   * Returns an ARRAY of 0, 1 or 2 entries — see `selectAnimes` for why one
   * logical show can be two catalogue entries here, and for the strict rule that
   * admits the second one.
   * @param {string} title
   * @returns {Promise<Array<{href: string, animeId: string|null, title: string, order: number, variant?: 'dub'|'sub'}>>}
   */
  async findAnimes(title) {
    const keyword = String(title || '').trim()
    if (!keyword) throw new Error('no title to search: query.titles was empty')

    const { url, text } = await this.get(`/filter?keyword=${encodeURIComponent(keyword)}`)
    const regions = this.filmListRegions(text)

    if (!regions.length) {
      throw new Error(`GET ${url} -> no film-list container parsed (layout change)`)
    }

    const candidates = regions.flatMap((region) => this.collectResults(region))
    // An empty film-list next to 48 sidebar anchors is a genuine "no results"
    // page, not a parse failure, so this returns [] instead of throwing.
    if (!candidates.length) return []

    return this.selectAnimes(candidates, keyword)
  }

  /**
   * Fetch and parse the episode list of an anime page.
   * `/play/<slug>` 302-redirects to `/play/<slug>/<token>`; fetch follows it.
   * @param {{href: string}} anime
   * @returns {Promise<{episodes: object[], playUrl: string}>}
   */
  async fetchEpisodes(anime) {
    const { url: playUrl, text } = await this.get(anime.href)
    const episodes = this.parseEpisodes(text)

    if (!episodes.length) {
      throw new Error(`play page ${playUrl} -> no episode anchors parsed (layout change)`)
    }

    return { episodes, playUrl }
  }

  /**
   * Ask the episode API for the direct .mp4.
   * The id MUST be the alphanumeric token: the numeric forms both answer
   * 401 {"error":true} (measured for the anime id 1749 and episode id 29921).
   * @param {string} token
   * @param {string} referer
   * @returns {Promise<string>}
   */
  async resolveStream(token, referer) {
    const { url, text } = await this.get(`/api/episode/info?id=${encodeURIComponent(token)}`, {
      'Accept': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': referer
    })

    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      throw new Error(`GET ${url} -> response is not JSON (${text.slice(0, 80)})`)
    }

    if (!payload || typeof payload !== 'object') {
      throw new Error(`GET ${url} -> unexpected payload (${text.slice(0, 80)})`)
    }
    if (!payload.grabber) {
      throw new Error(`GET ${url} -> 200 but no "grabber" field (keys: ${Object.keys(payload).join(', ') || 'none'})`)
    }

    return payload.grabber
  }

  /**
   * @param {{href: string, title: string}} anime
   * @param {{num: number, token: string}} episode
   * @param {string} streamUrl
   * @param {'best'|'batch'|'alt'} type
   * @returns {object} TorrentResult
   */
  buildResult(anime, episode, streamUrl, type) {
    // "(ITA)" in `data-jtitle` marks the DUB entry, and its absence marks a SUB
    // one. Measured on this site, same query, same filename convention:
    //   "Naruto (ITA)"                         -> Naruto_Ep_001_ITA.mp4      (dub)
    //   "Boruto: Naruto Next Generations"      -> Boruto_Ep_001_SUB_ITA.mp4  (sub)
    //   "Pokemon Movie 20: Kimi ni Kimeta! (ITA)" -> Pokemon_Movie_20_ITA.mp4 (dub)
    //   "Pokemon Sun & Moon"                   -> PokemonSoleELuna_Ep_003_SUB_ITA.mp4 (sub)
    // So a bare " ITA" claimed DUB for a sub file: One Piece episode 5 came back
    // titled "One Piece ITA - Ep 5 [AW]" while linking OnePiece_Ep_0005_SUB_ITA.mp4.
    // `_SUB_ITA` is this site's own spelling of sub (see the animeunity/animesaturn
    // headers), and an unmarked "ITA" means dub, which is what made the old label a
    // lie rather than a rounding error.
    //
    // The title marker is the ONLY discriminator the index exposes: collectResults
    // returns just {href, animeId, title, order, variant?}, there is no upstream
    // sub/dub field to read. The `variant` set by `selectAnimes` is carried on
    // `anime` and copied onto the row below, which is what lets a dub and a sub of
    // the same show survive as two distinct results instead of collapsing into one.
    //
    // `variant` is OMITTED when absent, never set to 'unknown': the resolver reads
    // the key only when a source declared something, and an absent key is the
    // truthful representation of "this entry said nothing".
    const marker = /\(\s*ITA\s*\)/i.test(anime.title) ? '' : ' SUB ITA'

    const result = {
      title: `${anime.title}${marker} - Ep ${episode.num} [AW]`,
      link: streamUrl,
      // No torrent, magnet or infohash exists on this site: it serves plain
      // HTTP .mp4 streams, so Shiru's BitTorrent path can never resolve this
      // result. Empty on purpose — never fabricate an infohash here.
      hash: '',
      seeders: 0,
      leechers: 0,
      downloads: 0,
      size: 0,
      accuracy: 'high',
      date: new Date(),
      type
    }

    if (anime.variant === 'dub' || anime.variant === 'sub') result.variant = anime.variant

    return result
  }

  // -------------------------------------------------------------------------
  // Entry points
  //
  // RETURN SHAPE: a real ARRAY of TorrentResult (index.d.ts:110,
  // Promise<TorrentResult[]>). The consumer does `results.push(...result.value)`
  // on the awaited value, so a plain object would be a TypeError:
  // "Spread syntax requires ...iterable to be a function".
  //
  // Diagnostics ride along as a non-index property `errors` on that array. An
  // array tolerates extra own properties, so `push(...out)` still works and the
  // messages stay readable in tests/debugging. NOTE: the host does not read
  // them — the worker only fills its error list from REJECTED promises, so the
  // only way to surface a message to the UI is to throw.
  // -------------------------------------------------------------------------

  /**
   * Validate that the site is reachable and its result markup is still parseable.
   * A plain HEAD is not enough: it passes on the HTTP-200 soft 404 too.
   * @returns {Promise<boolean>}
   */
  async validate() {
    try {
      const { text } = await this.get('/')
      return this.filmListRegions(text).some((region) => this.collectResults(region).length > 0)
    } catch {
      return false
    }
  }

  /**
   * Resolve one episode stream.
   *
   * Contract: resolves to a real ARRAY of TorrentResult (the host spreads it).
   * A genuine no-match resolves to an empty array — "found no results" is then
   * the truthful answer. A real failure REJECTS: the worker reads diagnostics
   * only from rejected promises, so returning would hide the cause behind
   * "no results". The rejection is raised after the try/catch so it cannot be
   * caught and re-wrapped by this method's own handler.
   *
   * @param {object} query
   * @param {string[]} query.titles
   * @param {number} [query.episode]
   * @returns {Promise<object[]>} TorrentResult[] with an `errors` property
   */
  async single(query) {
    const title = (query && query.titles && query.titles[0]) || ''
    const requested = Number(query && query.episode) || 1
    const out = []
    out.errors = []
    let failed = false

    try {
      const animes = await this.findAnimes(title)
      for (const anime of animes) {
        try {
          const { episodes, playUrl } = await this.fetchEpisodes(anime)
          const episode = this.pickEpisode(episodes, requested)
          if (episode) {
            const link = await this.resolveStream(episode.token, `${this.url}${playUrl}`)
            out.push(this.buildResult(anime, episode, link, 'best'))
          } else {
            out.errors.push(this.episodeError(anime, playUrl, requested, episodes))
          }
        } catch (cause) {
          // One variant failing must not take the other down with it: a dub that
          // resolves is a usable answer even when its sub sibling is broken. The
          // message names the variant so the two are told apart in a log.
          out.errors.push(`${anime.variant || 'senza variante'} "${anime.title}": ${this.messageOf(cause)}`)
        }
      }
      // A catalogue hit whose episode did not resolve IS a real failure, but only
      // when nothing at all came out: one good variant is worth returning.
      failed = out.length === 0 && out.errors.length > 0
      // !animes.length is a genuine no-match: empty array, empty errors, no throw.
    } catch (cause) {
      out.errors = [this.messageOf(cause)]
      failed = true
    }

    if (failed) this.reject(out)
    return out
  }

  /**
   * Resolve a short run of consecutive episodes starting at query.episode.
   * The site has no batch endpoint, so this is N single-episode resolutions.
   *
   * PARTIAL FAILURE: if at least one episode resolved, the array is returned
   * with the failures attached to `errors`, because throwing would throw away
   * episodes that are already good — and `handler.js:117` discards the results
   * of a source that reports errors anyway, so throwing would lose data for no
   * gain. Only when NOTHING resolved is it a genuine failure and we reject.
   *
   * @param {object} query
   * @returns {Promise<object[]>} TorrentResult[] with an `errors` property
   */
  async batch(query) {
    const title = (query && query.titles && query.titles[0]) || ''
    const start = Number(query && query.episode) || 1
    const out = []
    out.errors = []
    let failed = false

    try {
      const animes = await this.findAnimes(title)
      for (const anime of animes) {
        try {
          const { episodes, playUrl } = await this.fetchEpisodes(anime)
          const wanted = []
          for (let offset = 0; offset < this.maxBatchEpisodes; offset++) {
            const episode = this.pickEpisode(episodes, start + offset)
            if (!episode) break
            wanted.push(episode)
          }

          if (!wanted.length) {
            out.errors.push(this.episodeError(anime, playUrl, start, episodes))
          } else {
            for (const episode of wanted) {
              try {
                const link = await this.resolveStream(episode.token, `${this.url}${playUrl}`)
                out.push(this.buildResult(anime, episode, link, 'batch'))
              } catch (cause) {
                out.errors.push(`${anime.variant || 'senza variante'} "${anime.title}" ep ${episode.num}: ${this.messageOf(cause)}`)
              }
            }
          }
        } catch (cause) {
          out.errors.push(`${anime.variant || 'senza variante'} "${anime.title}": ${this.messageOf(cause)}`)
        }
      }
      failed = out.length === 0 && out.errors.length > 0
      // !animes.length is a genuine no-match: empty array, empty errors, no throw.
    } catch (cause) {
      out.errors = [this.messageOf(cause)]
      failed = true
    }

    if (failed) this.reject(out)
    return out
  }

  /**
   * Turn accumulated diagnostics into a rejection.
   * The worker fills its error list only from rejected promises and the host
   * turns those into a visible message; a returned `errors` array is never
   * read, which would leave the user with a bare "found no results".
   * @param {object[]} out
   * @returns {never}
   */
  reject(out) {
    const diagnostics = (out && out.errors) || []
    throw new Error(diagnostics.length ? diagnostics.join('\n') : 'unknown failure')
  }

  /**
   * Resolve a movie. Movie pages expose exactly one `data-episode-num="1"`.
   * @param {object} query
   * @returns {Promise<object[]>} TorrentResult[] with an `errors` property
   */
  async movie(query) {
    return this.single({ ...query, episode: 1 })
  }

  // -------------------------------------------------------------------------
  // Small shared utilities
  // -------------------------------------------------------------------------

  /**
   * @param {object[]} episodes
   * @param {number} number
   * @returns {object|null} null when that episode number does not exist
   */
  pickEpisode(episodes, number) {
    return episodes.find((episode) => episode.num === number)
      || episodes.find((episode) => episode.altNum === number)
      || null
  }

  /** Explicit "episode N is not here" message, never a silent episode 1. */
  episodeError(anime, playUrl, requested, episodes) {
    const numbers = episodes.map((episode) => episode.num)
    const lowest = Math.min(...numbers)
    const highest = Math.max(...numbers)
    return `episode ${requested} not found for "${anime.title}" on ${playUrl}: available episodes ${lowest}-${highest} (${numbers.length} parsed)`
  }

  messageOf(cause) {
    return cause && cause.message ? cause.message : String(cause)
  }
}()