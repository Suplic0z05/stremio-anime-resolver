// =============================================================================
// PROVENANCE — DERIVED FILE, DO NOT REWRITE
//   upstream : shiru-italian-streaming (GNU GPL v3)
//   file     : animeunitysearch/sources/animeunity.js
//   project  : https://github.com/Suplic0z05/shiru-italian-streaming
//
// The body below this banner is byte-identical to upstream, including the four
// deviations that all answer HTTP 200 with a useless body (the 120-episode range
// cap, the BARE url in /embed-url, title: null, episodes_count: 0) and the two
// traps that silently produce a wrong answer (episode DB id vs episode number;
// no /it/anime prefix). Each of those was found by measurement. Do not
// "improve", tidy, rewrite or strip its error handling: if it is wrong, fix it
// upstream and re-copy.
//
// ADAPTATION FOR NODE: none was needed, and that is a measured result rather
// than an assumption. ES module, no bundler-only syntax; fetch, AbortController,
// AbortSignal.timeout and Buffer are all Node globals on >= 18. `export default
// new class …` is an INSTANCE, so resolver.js takes the static default. The
// file's own comment records that the search index keys on original-language
// titles and that the VixCloud URLs carry short-lived tokens: neither is cached
// anywhere in this project.
//
// CONTRACT PRESERVED HERE ON PURPOSE:
//   * single() / batch() / movie() resolve to a REAL ARRAY (the consumer spreads
//     the awaited value); diagnostics ride along on .errors.
//   * genuine no-match -> [] ; real failure -> throw naming URL and status.
//   * validate() is async, resolves true/false, and never throws.
//   * hash is '' on every row: HTTPS media, never a torrent or infohash.
// =============================================================================
// AnimeUnity Source for Shiru
// animeunity.so — resolves one episode to a direct HTTP media URL.
//
// WHY THERE IS NO HTML SEARCH HERE
// The site has no search form at all (zero <form>, zero <input>): search is
// Vue-driven and answers with JSON. So the data path never parses markup, and
// the only regex in this file is the one that lifts `downloadUrl` out of a
// JWPlayer page. Measured live 2026-10-05.
//
//   1. GET  /                                   -> csrf-token <meta> + session cookie
//   2. POST /livesearch  {title}                -> {records:[{id,slug,title_eng,...}]}
//   3. GET  /info_api/{animeId}/{ep}?start_range&end_range
//                                             -> {episodes_count,episodes:[{id,number,...}]}
//   4. GET  /embed-url/{episodeId}              -> bare VixCloud embed URL (103 B)
//   5. GET  {vixcloud embed}                    -> JWPlayer page -> direct .mp4
//
// FOUR DEVIATIONS FROM THE OBVIOUS GUESSES. All four return HTTP 200 with a
// useless body, so none of them trips a `if (!res.ok)` guard:
//
//   a) `/info_api` caps the range at 120. `?start_range=1&end_range=200`
//      answers 200 `{"error":"You can't fetch for a range bigger than 120"}`.
//      So `end_range` MUST be clamped, and `data.error` MUST be read on 2xx.
//   b) `/embed-url/{id}` answers `application/json` whose body is a BARE URL,
//      not a quoted JSON string — `JSON.parse('https://vixcloud.co/...')`
//      throws. We accept both shapes rather than assume either.
//   c) `records[].title` is often null (the main "One Piece" entry has
//      `title: null, title_eng: "One Piece"`). Never index title without a
//      fallback chain.
//   d) `records[].episodes_count` is 0 on records that really have 1180
//      episodes. Do not use it to decide an entry is unusable.
//
// TWO TRAPS THAT SILENTLY PRODUCE A WRONG ANSWER
// - The last URL path segment of an episode page is the episode DB id, not the
//   episode number: `/anime/12-one-piece/1` returns 200 with EMPTY `episode`
//   and `embed_url` props, while `/anime/12-one-piece/5987` is populated. The
//   `/info_api` + `/embed-url` route below avoids the page route entirely,
//   which is why it is the one implemented.
// - Do NOT build `/it/anime/...`: that prefix 404s. Only `/anime/...` exists.
//
// THE SEARCH INDEX IS THE REAL LIMITATION
// It keys on original-language titles, so an Italian title often misses even
// when the anime is right there. Measured the same day: "One Piece" -> 8
// records, "Naruto" -> 8, but "Dimentica il mio nome, Erina" -> 0 records while
// "Erina" -> 6. (Not every localised title fails: "L'attacco dei giganti" ->
// 8 records. It is inconsistent, which is exactly why every candidate title in
// query.titles[] is tried before declaring a miss.)
// RESIDUAL LIMITATION, not fixable from here: if the caller supplies only a
// localised title that the index does not carry, this source returns no result
// even though the anime exists on the site. Supply an original-language or
// romanized title in query.titles[] to get a match.
//
// ERROR POLICY — WHY THIS FILE REJECTS INSTEAD OF RETURNING DIAGNOSTICS
// The host builds its error list from REJECTED PROMISES ONLY: `worker.js:148-156`
// keys on `result.status === 'rejected'` and pushes `result.reason.message`, and
// it never reads a returned value's `errors` property. A returned `[]` is
// therefore indistinguishable from an honest miss, so `worker.js:127` synthesises
// `noResults` and the user is told "Source animeunity-it found no results." —
// which is exactly what a dead CSRF handshake, an expired token or a changed
// player layout used to look like. Verified in the real loader, not inferred.
// So the contract is now binary:
//   - genuine miss (search ran, no record carries any of query.titles[])
//     -> return `[]` with `errors: []`, do NOT throw. It is the truth.
//   - anything actually broken -> reject. `Promise.allSettled` (`worker.js:148`)
//     keeps the rejection scoped to this entry point, and `handler.js:117`
//     turns `reason.message` into the message the user sees.
// `validate()` is deliberately EXEMPT: `worker.js:161` calls it inside a
// `Promise.race` and coerces the result with `!!`, so it must resolve to
// true/false and must never throw.
//
// ONE DELIBERATE EXCEPTION TO "ANYTHING BROKEN -> REJECT": batch(), PARTIAL RUN
// When 4 of 5 episodes resolve and 1 dies, batch() RETURNS the 4 rows with
// `errors` attached and does not throw. The trade-off is real and stated here
// rather than hidden: the failing episodes are SILENT, the run reports success,
// and 4 playable links beat 0 links plus a sentence. Measured end-to-end through
// the real pipeline (`/tmp/partial-probe.mjs`): returning the array shows 4 of
// 5 with no message; rejecting shows 0 of 5 and one line of text.
// Do not "fix" this by rejecting on a non-empty `errors` — that discards the
// good rows, and the reason it discards them is NOT that the host rejects a
// returned array. The host never inspects one (see above). Surfacing partial
// results WITH their warnings needs an empty host error list at the same time,
// which only handler.js can arrange, so it cannot be done from an extension.
// animeworld implements the identical rule (`failed = length === 0 && errors.length`);
// the three sources must agree, or the same breakage looks different per source.
//
// TOKENS EXPIRE — resolve at play time, every call. `expires` on the VixCloud
// embed token measured ~60 days out; the `downloadUrl` token on
// `*.vix-content.net` is short-lived. Nothing resolved here is cached or
// persisted anywhere: the URL is produced per call and handed back to the host.
//
// FANSUB, NOT DUB. The verified One Piece episode resolved to
// `OnePiece_Ep_01_SUB_ITA.mp4`; the catalogue entry is
// `One.Piece.S01E01.Il.ragazzo.di.gomma.1080p.AMZN.WEB-DL.JPN.AAC2.0.H.264.mkv`
// (the stream's own filename marks it SUB). Nothing here claims a dub.
//
// WHY `hash` IS ALWAYS EMPTY
// This site publishes no torrents, no magnets and no infohashes (measured: zero
// across live pages); it serves plain HTTP media. `TorrentResult.hash` is
// required and doubles as the dedupe key AND the infohash handed to Shiru's
// BitTorrent engine, so it is set to '' on purpose. A fabricated hash would
// produce a plausible-looking dead row, which is strictly worse than an honest
// empty one. In particular do NOT reintroduce `au-${episode}`: AnimeUnity and
// AnimeUnion used that same prefix, so `au-5` from one source silently
// shadowed `au-5` from the other. Do not "fix" this by hashing the URL.
//
// The manifest `type` stays `torrent` (index.json, not this file): the host
// dispatches only 'torrent' and 'subtitle' and only ever calls 'torrent'. The
// `type` on each result below is the unrelated per-result TorrentResult flag
// ('best' | 'batch' | 'alt'), which is why both fields are called `type`.

export default new class AnimeUnity {
  url = 'https://www.animeunity.so'

  // Per-request timeout, applied through AbortController (no dependency, no
  // AbortSignal.timeout requirement in the host's JS runtime).
  timeout = 20000

  // `/info_api` refuses any window wider than 120 (deviation (a) above).
  maxRange = 120

  // A batch is N independent episode resolutions, each one a VixCloud page
  // fetch. Bounded so one call cannot fan out into an unbounded crawl.
  maxBatchEpisodes = 6

  // Base headers for animeunity.so itself. Deliberately NOT applied to the
  // final media URL: the `*.vix-content.net` MP4 measured 206 / video/mp4 with
  // ZERO request headers, so adding any would only be a way to break it.
  baseHeaders = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'it-IT,it;q=0.9'
  }

  // ---------------------------------------------------------------------------
  // Transport: one cookie jar per resolution, carried across every hop
  // ---------------------------------------------------------------------------

  /**
   * A minimal cookie jar. Only the name=value pair is kept (no attributes, no
   * expiry, no domain scoping): the jar lives for the duration of a single
   * call and is thrown away, so cross-host leakage is impossible by
   * construction. The session cookie (`animeunity_session`) is mandatory —
   * without it `/livesearch` answers 419.
   */
  createJar() {
    return {
      cookies: new Map(),
      absorb(response) {
        for (const raw of response.headers.getSetCookie?.() ?? []) {
          const pair = raw.split(';')[0]
          const eq = pair.indexOf('=')
          if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
        }
      },
      header() {
        return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ')
      }
    }
  }

  /**
   * fetch + timeout + jar absorption.
   *
   * A transport failure (DNS, refused socket, TLS, the 20 s abort) is re-thrown
   * with the URL attached. Un-wrapped it is just "fetch failed" or "This
   * operation was aborted", which names no hop at all — and naming the hop is the
   * only way the user can tell an unreachable site from a missing anime.
   * @param {string} path absolute URL, or a path under this.url
   * @param {object} jar
   * @param {object} [options] fetch options; headers are merged over baseHeaders
   * @returns {Promise<Response>}
   */
  async request(path, jar, options = {}) {
    const url = path.startsWith('http') ? path : `${this.url}${path}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeout ?? this.timeout)

    try {
      const cookie = jar.header()
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          ...this.baseHeaders,
          ...(cookie ? { Cookie: cookie } : {}),
          ...(options.headers ?? {})
        }
      })
      jar.absorb(response)
      return response
    } catch (cause) {
      const reason = controller.signal.aborted ? `timeout ${options.timeout ?? this.timeout} ms` : this.messageOf(cause)
      throw new Error(`${path} non raggiungibile: ${reason}`)
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Message of a thrown cause, for the errors[] array.
   * @param {unknown} cause
   * @returns {string}
   */
  messageOf(cause) {
    if (cause instanceof Error) return cause.message
    return String(cause)
  }

  // ---------------------------------------------------------------------------
  // Hop 1 — CSRF token + session cookie
  // ---------------------------------------------------------------------------

  /**
   * Load the homepage once to obtain both halves of the CSRF pair: the
   * `csrf-token` meta value AND the session cookie. Measured: the jar comes
   * back holding `XSRF-TOKEN` and `animeunity_session`.
   * Sending the header without the cookie, or the cookie without the header,
   * both answer 419; sending X-XSRF-TOKEN instead answers 500. Both parts of
   * the pair are required, which is why this is one call and not two.
   * @param {object} jar
   * @returns {Promise<string>} the CSRF token
   */
  async csrfToken(jar) {
    const response = await this.request('/', jar, {
      headers: { Accept: 'text/html,application/xhtml+xml' }
    })
    if (!response.ok) throw new Error(`homepage HTTP ${response.status}`)

    const html = await response.text()
    const token = /<meta\s+name=["']csrf-token["']\s+content=["']([^"']+)["']/i.exec(html)?.[1]
    if (!token) throw new Error('homepage 200 senza meta csrf-token (layout cambiato?)')
    return token
  }

  // ---------------------------------------------------------------------------
  // Hop 2 — search
  // ---------------------------------------------------------------------------

  /**
   * Vue-driven JSON search. Both the jar cookie and X-CSRF-TOKEN are sent, and
   * X-Requested-With tells the backend this is the XHR the Vue app makes.
   * @param {object} jar
   * @param {string} token
   * @param {string} title
   * @returns {Promise<object[]>} the raw records, possibly empty
   */
  async search(jar, token, title) {
    const response = await this.request('/livesearch', jar, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'X-CSRF-TOKEN': token,
        Referer: `${this.url}/`
      },
      body: JSON.stringify({ title })
    })

    if (!response.ok) {
      // 419 here means the CSRF pair went stale, not that the anime is missing.
      throw new Error(`/livesearch "${title}" HTTP ${response.status}`)
    }

    const data = await response.json()
    return Array.isArray(data?.records) ? data.records : []
  }

  /**
   * The dub/sub variant this record declares, or `null` when it declares nothing.
   *
   * MEASURED against animeunity.so's own `/livesearch` payloads, not assumed and
   * not borrowed from a sibling project. Every record in every search carries a
   * numeric `dub` field, and it is the site's own dub/sub partition:
   *
   *   "One Piece"          id 12    slug one-piece          dub: 0
   *   "One Piece (ITA)"    id 2998  slug one-piece-ita      dub: 1
   *   "Naruto"             id 1469  slug naruto             dub: 0
   *   "Naruto (ITA)"       id 1468  slug naruto-ita         dub: 1
   *   "Bleach" / "Bleach (ITA)", "Pokemon (ITA)", and the whole movie set: same
   *   split, with the `-ita` slug carrying dub: 1 every time.
   *
   * Counts from a six-title sweep (One Piece, Naruto, Bleach, Pokemon, Attack on
   * Titan, Dokemon): 22 records at `dub: 0`, 18 at `dub: 1`, ZERO records with
   * the field absent, and ZERO values other than 0/1. The base-slug/`-ita`-slug
   * invariant held on 3/3 title pairs.
   *
   * THE FIELD IS NAMED `dub` AND IS NUMERIC, which is why it is read here rather
   * than left to `variant.js`: `detectVariant` tokenises STRING values and a
   * number is not a token, so a raw `dub: 1` would read as `unknown` forever.
   * Mapping it to a normalised 'dub'/'sub' here is what makes the field usable —
   * and it is a declared field, not a title marker, which is the distinction the
   * whole variant contract turns on.
   *
   * Note the `-ita` SLUG is deliberately not used as the signal: a slug is a
   * transliteration of a title and says nothing on its own.
   * @param {object} record
   * @returns {'dub'|'sub'|null}
   */
  variantOfRecord(record) {
    const value = record?.dub
    if (value === 1 || value === '1' || value === true) return 'dub'
    if (value === 0 || value === '0' || value === false) return 'sub'
    // Anything else — absent, null, a new value the site invents — is NOT guessed.
    return null
  }

  /**
   * Every title worth trying, in order, de-duplicated. Shiru's query.titles[]
   * already mixes localised, romanized and original titles; the search index is
   * keyed on the original ones, so all of them are candidates.
   * @param {object} query
   * @returns {string[]}
   */
  titleCandidates(query) {
    const raw = [
      ...(Array.isArray(query?.titles) ? query.titles : []),
      // Tolerate the shapes a caller might pass instead.
      query?.title,
      query?.romaji,
      query?.romanized,
      query?.english,
      query?.en,
      query?.romaja
    ]
    const seen = new Set()
    const out = []
    for (const value of raw) {
      const title = String(value ?? '').trim()
      if (!title || title.length > 160 || seen.has(title.toLowerCase())) continue
      seen.add(title.toLowerCase())
      out.push(title)
    }
    return out
  }

  /**
   * Normalise a title to compare it against a record slug.
   * @param {string} value
   * @returns {string}
   */
  slugify(value) {
    return String(value ?? '')
      .toLowerCase()
      .normalize('NFD')
      // strip combining diacritical marks (U+0300..U+036F) left by NFD
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
  }

  /**
   * Choose the record that best matches the query title.
   *
   * A search returns everything containing the words — for "One Piece" that is
   * 8 records, the TV series first and then movies, dubs and a fan letter. An
   * exact slug match wins; otherwise the upstream order is kept, because that
   * order is what the site's own Vue UI renders.
   * @param {object[]} records
   * @param {string} title the title that actually produced these records
   * @returns {object|null}
   */
  pickRecord(records, title) {
    return this.bestRecord(records, this.slugify(title))
  }

  /**
   * The one record that answers `needle` best.
   *
   * The rank tiers and the strict `<` tie-break are the ORIGINAL logic, extracted
   * unchanged and no more so: a strict `<` means the scan is a stable min, so
   * upstream order still breaks every tie, which is what the site's own Vue UI
   * relies on. Extracting it is what lets `pickRecordPair` score each variant's
   * candidates against the same yardstick instead of inventing a second one — and
   * it returns a SINGLE record, so `pickRecord` cannot have changed which record
   * wins while appearing to only add a second one.
   * @param {object[]} records
   * @param {string} needle already slugified
   * @returns {object|null}
   */
  bestRecord(records, needle) {
    if (!records.length) return null

    // Strict `<` on the rank means the scan is a stable min, so upstream order
    // breaks every tie. That is what the site's own Vue UI relies on.
    let best = null
    let bestRank = Infinity
    for (const record of records) {
      const slug = this.slugify(record?.slug)
      let rank = 3
      if (!needle || !slug) rank = 3
      else if (slug === needle) rank = 0
      else if (slug.startsWith(`${needle}-`)) rank = 1
      else if (slug.includes(needle) || needle.includes(slug)) rank = 2
      if (rank < bestRank) {
        bestRank = rank
        best = record
      }
    }
    return best
  }

  /**
   * Best record PER variant, so a dub and a sub of the same show both survive.
   *
   * WHY: `pickRecord` returns exactly one record, and on this site the search for
   * "One Piece" returns the TV series twice — once as the sub (`one-piece`,
   * dub: 0) and once as the dub (`one-piece-ita`, dub: 1) — plus movies and a
   * fan letter. One answer therefore always dropped one of the two variants, and
   * the caller had no way to learn the other existed.
   *
   * The candidates are SPLIT BY DECLARED VARIANT FIRST and ranked second, inside
   * each group, by the same yardstick as before. That ordering is the whole point:
   * ranking first and splitting afterwards would let the sub's exact slug match
   * (`one-piece` = needle) win the scan and hide the dub at rank 1 behind it,
   * which is the bug. Splitting first means each variant is competed for on its
   * own merits, and both winners are returned.
   *
   * A record that declares no variant is not silently dropped and not guessed: it
   * is returned as its own entry with no `variant`, so an undeclared record is
   * still a usable answer and still visibly undeclared.
   * @param {object[]} records
   * @param {string} title the title that actually produced these records
   * @returns {object[]} 0, 1 or 2 records, each tagged with `variant` when declared
   */
  pickRecordPair(records, title) {
    if (!records.length) return []
    const needle = this.slugify(title)

    const groups = new Map()
    for (const record of records) {
      const variant = this.variantOfRecord(record)
      const key = variant ?? ''
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(record)
    }

    const out = []
    for (const [variant, group] of groups) {
      const best = this.bestRecord(group, needle)
      if (!best) continue
      out.push(variant ? { ...best, variant } : { ...best })
    }
    return out
  }

  /**
   * Display title of a record. `title` is frequently null and
   * `episodes_count` is frequently 0 (see deviations (c) and (d)).
   * @param {object} record
   * @returns {string}
   */
  displayTitle(record) {
    return String(record?.title_it || record?.title_eng || record?.title || record?.slug || 'AnimeUnity')
  }

  // ---------------------------------------------------------------------------
  // Hop 3 — episodes of a series
  // ---------------------------------------------------------------------------

  /**
   * The window [start_range, end_range] is clamped to `maxRange` because
   * `/info_api` answers 200 + `{"error":"..."}` for anything wider, and a
   * window that does not start at or below the target may not contain the
   * requested episode at all (`end_range must be equal or greater than
   * start_range` is also a 200). Anchoring the window at the requested
   * episode guarantees it is inside, and 120 episodes of slack absorbs the
   * specials and gaps these catalogues are full of.
   * @param {object} jar
   * @param {string} token
   * @param {number} animeId
   * @param {number} episode
   * @returns {Promise<{episodes: object[], episodes_count: number}>}
   */
  async episodeWindow(jar, token, animeId, episode) {
    const start = Math.max(1, Number(episode) || 1)
    const end = start + this.maxRange - 1

    const response = await this.request(
      `/info_api/${animeId}/${start}?start_range=${start}&end_range=${end}`,
      jar,
      {
        headers: {
          Accept: 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          'X-CSRF-TOKEN': token,
          Referer: `${this.url}/`
        }
      }
    )

    // `windowRange`, not `window`: this file runs inside a worker whose global
    // `window` has no business being shadowed.
    const windowRange = `${start}..${end} (maxRange ${this.maxRange})`
    if (!response.ok) throw new Error(`/info_api/${animeId}/${start} HTTP ${response.status} [finestra ${windowRange}]`)

    const data = await response.json()
    // Deviation (a): the error is a property of a 200 body. Check it, or the
    // empty `episodes` reads as "series has no episodes".
    // The site also refuses a window whose START does not exist ("Episode doesn't
    // exist"), so on that path there is no episode count to report: the window is
    // stated instead, since asking again would be an extra network call.
    if (data?.error) throw new Error(`/info_api/${animeId}/${start}: ${data.error} [finestra ${windowRange}]`)
    if (!Array.isArray(data?.episodes)) throw new Error(`/info_api/${animeId}/${start}: risposta senza episodes [finestra ${windowRange}]`)

    return { episodes: data.episodes, episodes_count: Number(data.episodes_count) || 0 }
  }

  /**
   * Pick the requested episode out of a window. `number` is a STRING on the
   * wire ("1"), so compare as strings. The window starts at the requested
   * number, so its first entry is the nearest available episode when the exact
   * one does not exist — that is a real answer, not a failure.
   * @param {object[]} episodes
   * @param {number} episode
   * @returns {object|null}
   */
  pickEpisode(episodes, episode) {
    if (!Array.isArray(episodes) || !episodes.length) return null
    const wanted = String(Number(episode) || 1)
    return episodes.find((entry) => String(entry?.number) === wanted) ?? episodes[0] ?? null
  }

  // ---------------------------------------------------------------------------
  // Hop 4 + 5 — embed URL, then the direct MP4
  // ---------------------------------------------------------------------------

  /**
   * Resolve one episode id to a playable URL.
   *
   * Step 4 (`/embed-url/{id}`) returns a VixCloud embed URL in a body served as
   * application/json but shaped as a bare, unquoted string — `JSON.parse`
   * throws on it. Both shapes are accepted because only the bare one has been
   * observed and guessing wrong here means a hard failure on a live site.
   *
   * Step 5 is REQUIRED, not optional: the VixCloud page is a JWPlayer shell
   * (~75 KB) carrying `downloadUrl = '<direct .mp4>'`, and that URL is the whole
   * answer. An earlier version degraded to the bare embed URL when the regex
   * missed; measured 2026-10-05 that degraded row was indistinguishable to the
   * user from a working one (the host reported the same "1 result"), so a
   * changed player layout now surfaces as an error naming the failing hop.
   *
   * NO headers are added to the resolved media URL, and it is never fetched,
   * cached or persisted from here: the vix-content token is short-lived and the
   * host must re-resolve at play time.
   * @param {object} jar
   * @param {string} token
   * @param {number} episodeId
   * @returns {Promise<{url: string, kind: 'mp4'}>}
   */
  async resolveEpisodeUrl(jar, token, episodeId) {
    const response = await this.request(`/embed-url/${episodeId}`, jar, {
      headers: {
        Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'X-CSRF-TOKEN': token,
        Referer: `${this.url}/`
      }
    })
    if (!response.ok) throw new Error(`/embed-url/${episodeId} HTTP ${response.status}`)

    const body = (await response.text()).trim()
    let embedUrl = body
    try {
      const parsed = JSON.parse(body)
      if (typeof parsed === 'string') embedUrl = parsed
    } catch {
      // Deviation (b): the observed body is a bare URL, so this is the normal
      // path. Strip quotes defensively in case the shape flips to a string.
      embedUrl = body.replace(/^["']|["']$/g, '')
    }
    if (!/^https?:\/\//i.test(embedUrl)) {
      throw new Error(`/embed-url/${episodeId}: risposta non URL (${body.slice(0, 80)})`)
    }

    const direct = await this.directFrom(embedUrl)
    if (!direct) {
      throw new Error(
        `/embed-url/${episodeId}: pagina player VixCloud senza downloadUrl (layout JWPlayer cambiato); embed: ${embedUrl}`
      )
    }
    return { url: direct, kind: 'mp4' }
  }

  /**
   * Lift the direct MP4 out of a VixCloud player page.
   *
   * Returns null ONLY when the page loaded fine and simply has no `downloadUrl`
   * in it; a transport or HTTP failure rejects instead, so the caller can tell
   * "player page unreachable" apart from "player page changed".
   * @param {string} embedUrl
   * @returns {Promise<string|null>}
   */
  async directFrom(embedUrl) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeout)
    let response
    try {
      response = await fetch(embedUrl, {
        signal: controller.signal,
        headers: { ...this.baseHeaders, Referer: `${this.url}/` }
      })
    } catch (cause) {
      // Deliberately re-thrown rather than swallowed: the embed URL alone is not
      // a playable answer for this host, so a dead player page is a failure.
      throw new Error(`pagina player VixCloud non raggiungibile: ${this.messageOf(cause)}`)
    } finally {
      clearTimeout(timer)
    }

    if (!response.ok) throw new Error(`pagina player VixCloud HTTP ${response.status}`)
    const html = await response.text()

    const match = /downloadUrl\s*=\s*['"]([^'"]+)['"]/.exec(html)
    const direct = match?.[1]?.trim()
    if (!direct || !/^https?:\/\//i.test(direct)) return null
    return direct
  }

  // ---------------------------------------------------------------------------
  // Resolution
  // ---------------------------------------------------------------------------

  /**
   * Steps 1-3 of the chain: search the series, then list its episodes.
   * Split out from `resolve` because a batch needs this ONCE and then one embed
   * request per episode — re-running the homepage + search + info_api per
   * episode would triple the request count for the same answer, and could even
   * hand back rows from two different series if the index shifts mid-run.
   * The `series` array carries ONE entry per declared variant (see
   * `pickRecordPair`), each with its own episode window. The scalar `record` /
   * `matchedBy` / `episodes` / `episodes_count` fields are UNCHANGED and keep
   * pointing at the first entry, so the existing `batch` path — which is built
   * around one series and one episode window — behaves exactly as before.
   *
   * @param {object} query
   * @param {number} episode anchors the episode window
   * @returns {Promise<{jar: object|null, token: string, record: object|null,
   *   matchedBy: string, episodes: object[], episodes_count: number,
   *   series: Array<{record: object, matchedBy: string, episodes: object[],
   *     episodes_count: number}>, errors: string[]}>}
   */
  async resolveSeries(query, episode) {
    const errors = []
    const candidates = this.titleCandidates(query)
    if (!candidates.length) {
      return { jar: null, token: '', record: null, matchedBy: '', episodes: [], episodes_count: 0, errors: ['query.titles vuoto o assente'] }
    }

    // One jar for the whole chain: the session cookie opened on the homepage is
    // the one that authenticates /livesearch.
    const jar = this.createJar()
    const token = await this.csrfToken(jar)

    let picked = []
    let matchedBy = ''
    for (const title of candidates) {
      const records = await this.search(jar, token, title)
      // One record per DECLARED variant, not one record overall: the search for
      // "One Piece" returns the sub and the dub as separate records and a single
      // winner would always discard one of them.
      const pair = this.pickRecordPair(records, title)
      if (pair.length) {
        picked = pair
        matchedBy = title
        break
      }
      if (records.length) errors.push(`"${title}": ${records.length} record, nessuno corrisponde al titolo`)
    }
    // No candidate matched: that is an honest empty result, not a failure. The
    // index simply may not carry any of the titles we were given, and a fan
    // sub index keyed on original titles is exactly where that happens.
    if (!picked.length) {
      return { jar, token, record: null, matchedBy: '', episodes: [], episodes_count: 0, series: [], errors: [] }
    }

    // One episode window per variant. A window that cannot be read for one of them
    // must not discard the others, so each is attempted on its own and a failure
    // becomes a diagnostic naming the variant instead of a lost row.
    const series = []
    for (const record of picked) {
      const label = record.variant ? `${record.variant} "${record.title_eng || record.slug}"` : `"${record.title_eng || record.slug}"`
      try {
        const window = await this.episodeWindow(jar, token, record.id, Number(episode) || 1)
        series.push({ record, matchedBy, episodes: window.episodes, episodes_count: window.episodes_count })
      } catch (cause) {
        errors.push(`${label}: elenco episodi non leggibile — ${this.messageOf(cause)}`)
      }
    }

    const first = series[0] ?? { record: null, matchedBy: '', episodes: [], episodes_count: 0 }
    return {
      jar,
      token,
      record: first.record,
      matchedBy: first.matchedBy,
      episodes: first.episodes,
      episodes_count: first.episodes_count,
      series,
      errors
    }
  }

  /**
   * Full chain for one episode: steps 1-3, then the media URL for it.
   * @param {object} query
   * @param {number} episode
   * @returns {Promise<{record: object|null, matchedBy: string, resolved: object|null,
   *   episodeNumber: number, errors: string[]}>}
   */
  async resolve(query, episode) {
    const number = Number(episode) || 1
    const series = await this.resolveSeries(query, number)
    const { jar, token, record, matchedBy, episodes, episodes_count } = series
    if (!record) return { record: null, matchedBy: '', resolved: null, episodeNumber: 0, errors: series.errors }

    const errors = series.errors
    const episodeRow = this.pickEpisode(episodes, number)
    // Only the episode DB id goes into /embed-url — never the episode number.
    // Putting the number there is the soft-failure trap: it returns 200 with
    // empty props instead of erroring.
    if (!episodeRow?.id) {
      errors.push(
        `"${matchedBy}": episodio ${number} non presente — episodi in catalogo: ${episodes_count}, finestra interrogata 1..${episodes.length} (maxRange ${this.maxRange})`
      )
      return { record, matchedBy, resolved: null, episodeNumber: 0, errors }
    }

    // A gap in the numbering is answered with the nearest episode in the window.
    // That is a real answer, so it must NOT go into `errors`, where a non-empty
    // list now means "reject" (see `fail`). Instead the caller labels the row
    // with the episode actually resolved, so the user is never shown "Ep 5"
    // sitting on top of episode 4's video.
    const episodeNumber = Number(episodeRow.number) || number

    const resolved = await this.resolveEpisodeUrl(jar, token, episodeRow.id)
    return { record, matchedBy, resolved, episodeNumber, errors }
  }

  /**
   * Full chain for one episode, run once per declared variant.
   *
   * This is the multi-variant sibling of `resolve`. `resolve` returns ONE outcome
   * because the search returned one record; here the search returns a record per
   * variant (`pickRecordPair`) and each of them is carried all the way to a media
   * URL, so a dub and a sub of the same episode both come back as distinct rows.
   *
   * Each variant is resolved INDEPENDENTLY. A dub that resolves is a usable answer
   * even when its sub sibling has a dead player page, so one failure becomes a
   * diagnostic naming the variant and the other still produces a row — the same
   * partial-batch trade the header documents, applied per variant.
   * @param {object} query
   * @param {number} episode
   * @returns {Promise<Array<{record: object, matchedBy: string, resolved: object|null,
   *   episodeNumber: number}>>} only the outcomes that reached a media URL
   */
  async resolveVariants(query, episode) {
    const number = Number(episode) || 1
    const { jar, token, series, errors } = await this.resolveSeries(query, number)

    if (!series.length) {
      // No series matched at all. The search diagnostics are returned only when
      // they describe a real breakage; a genuine miss stays silent, so `single`
      // can tell "not on this site" from "this site broke".
      return { resolved: [], errors: errors.length ? errors : [] }
    }

    const out = []
    const problems = [...errors]
    for (const entry of series) {
      const { record, matchedBy, episodes, episodes_count } = entry
      const label = record.variant ? `${record.variant} "${record.title_eng || record.slug}"` : `"${matchedBy}"`
      try {
        const episodeRow = this.pickEpisode(episodes, number)
        if (!episodeRow?.id) {
          problems.push(
            `${label}: episodio ${number} non presente — episodi in catalogo: ${episodes_count}, finestra interrogata 1..${episodes.length} (maxRange ${this.maxRange})`
          )
          continue
        }
        // `token` is required: `/embed-url` answers 419 without the X-CSRF-TOKEN pair,
        // so it is threaded through exactly as `resolve` does.
        const resolved = await this.resolveEpisodeUrl(jar, token, episodeRow.id)
        out.push({
          record,
          matchedBy,
          resolved,
          episodeNumber: Number(episodeRow.number) || number
        })
      } catch (cause) {
        problems.push(`${label}: ${this.messageOf(cause)}`)
      }
    }

    return { resolved: out, errors: problems }
  }

  /**
   * Build a Shiru result row.
   *
   * `hash` is '' on purpose: this site publishes no torrent, magnet or
   * infohash, and `hash` is both the dedupe key and the infohash Shiru's
   * BitTorrent engine is handed. See the header note — do not fabricate one.
   * @param {object} record
   * @param {number} episode
   * @param {string} url direct media URL or the VixCloud embed URL
   * @param {'best'|'batch'|'alt'} kind
   * @returns {object}
   */
  buildResult(record, episode, url, kind) {
    const result = {
      title: `${this.displayTitle(record)} - Ep ${episode} [AU]`,
      link: url,
      // No torrent, magnet or infohash exists on this site: it serves plain
      // HTTP media. Empty on purpose — never fabricate an infohash here.
      hash: '',
      seeders: 0,
      leechers: 0,
      downloads: 0,
      size: 0,
      accuracy: 'high',
      date: new Date(),
      // Per-result flag (TorrentResult), unrelated to the manifest's `torrent`.
      type: kind,
      // provenance, harmless for the host and useful in a log line
      source: 'animeunity',
      animeId: record?.id ?? null,
      animeSlug: record?.slug ?? null,
      matchedBy: record?.title_eng || record?.title || record?.slug || null
    }

    // The dub/sub variant this record DECLARED via its numeric `dub` field (see
    // `variantOfRecord`). Copied only when present, and never defaulted: a record
    // with no declaration returns no `variant` key, which is what lets the caller
    // tell "the source said sub" apart from "the source said nothing".
    if (record?.variant === 'dub' || record?.variant === 'sub') result.variant = record.variant

    return result
  }

  /**
   * Pack the outcome into the shape the host expects.
   *
   * The return value IS an array — `[{...}]` on success, `[]` on no results —
   * because the host counts results with `Array.isArray(out) ? out.length : 0`.
   * Returning `{results, errors}` instead makes it report "unknown" and treats
   * the source as empty, so the errors channel rides along as a property on the
   * array instead of in a wrapper object.
   *
   * `out.errors` is what separates a REAL failure (network, non-2xx, layout
   * change) from a genuine "this anime is not on the site": an empty array with
   * no errors is an honest miss, an empty array with errors is a breakage.
   *
   * AND YET THE HOST NEVER READS IT. Measured in the real loader: the error list
   * is built exclusively from REJECTED promises (`worker.js:148-156`, keyed on
   * `result.status === 'rejected'`), so a returned value's `errors` property is
   * invisible. A returned `[]` therefore collapses into `noResults`
   * (`worker.js:127`) and the user is told "Source animeunity-it found no
   * results." Whether this entry point returns or rejects is the only thing that
   * decides what the user is told — see `fail`.
   * @param {object[]} results
   * @param {string[]} [errors]
   * @returns {object[]}
   */
  pack(results, errors = []) {
    const out = [...results]
    out.errors = [...errors]
    return out
  }

  /**
   * Reject with the diagnostics instead of returning them.
   *
   * This is the whole point of the file's error policy: the host learns WHY only
   * from a rejection (it becomes `result.reason.message`, and `handler.js:117`
   * turns that into the message shown in the UI). Returning the same information
   * on `out.errors` loses it.
   *
   * Rejecting is safe because the host runs every entry point through
   * `Promise.allSettled` (`worker.js:148`), so a rejection is isolated to this
   * one call and becomes a user-visible message instead of killing the worker.
   *
   * The array is populated first, as required, and is also hung on the thrown
   * Error so a wrapper or the host's `console.debug(result)` can still read the
   * individual messages.
   *
   * SCOPE: call this only when there is nothing worth showing the user. If some
   * rows did resolve, return them with `errors` attached instead — that is the
   * partial-batch rule, see the header and `batch`.
   * @param {string[]} errors
   * @returns {never} always throws
   */
  fail(errors) {
    const out = this.pack([], errors)
    const error = new Error(out.errors.join('; ') || 'errore non specificato')
    error.errors = out.errors
    throw error
  }

  /**
   * Search for a single episode.
   *
   * NOT wrapped in try/catch, on purpose: a rejection is the only channel that
   * makes the host tell the user what went wrong (see `fail` and `pack`). The
   * host isolates it to this call through `Promise.allSettled`.
   *
   * Returns a real array — `[{...}]` on success, `[]` for a genuine miss — and
   * only rejects when something actually broke.
   * @param {object} query
   * @param {string[]} query.titles
   * @param {number} [query.episode]
   * @returns {Promise<object[]>} result array, with an `errors: string[]` property
   */
  async single(query) {
    const episode = Number(query?.episode) || 1
    // `resolveVariants`, not `resolve`: one record per DECLARED variant, so a dub
    // and a sub of the same episode both come back as their own row instead of
    // one of them being discarded by a single-record selection.
    const { resolved, errors } = await this.resolveVariants(query, episode)

    // Genuine miss: the search ran and no record carries any title we were asked
    // for. `errors` is [] on this path — an honest empty result, no throw.
    if (!resolved.length) {
      if (errors.length) this.fail(errors)
      return this.pack([], [])
    }

    const rows = resolved.map((entry) =>
      this.buildResult(entry.record, entry.episodeNumber || episode, entry.resolved.url, 'best'))

    return this.pack(rows, errors)
  }

  /**
   * Resolve a short run of consecutive episodes starting at query.episode.
   *
   * The site has no batch endpoint, so this is steps 1-3 once plus one embed
   * request per episode, bounded by maxBatchEpisodes. Each episode is attempted
   * independently and every failure is collected, so one dead player page names
   * itself instead of silently shortening the run.
   *
   * Rejects only when NOTHING resolved. A partial run returns its rows with the
   * per-episode errors attached — see the rule at the end of the body and the
   * partial-batch section of the header.
   *
   * NOT wrapped in try/catch, on purpose — see `single`.
   * @param {object} query
   * @returns {Promise<object[]>} result array, with an `errors: string[]` property
   */
  async batch(query) {
    const start = Number(query?.episode) || 1

    const series = await this.resolveSeries(query, start)
    const { jar, token, record, matchedBy, episodes, episodes_count } = series
    if (!record) {
      if (series.errors.length) this.fail(series.errors)
      return this.pack([], [])
    }

    const errors = [...series.errors]
    const wanted = []
    for (let offset = 0; offset < this.maxBatchEpisodes; offset++) {
      const number = String(start + offset)
      // STRICT lookup here: `pickEpisode` falls back to the first row of the
      // window, so in a loop it would hand back the same episode once per
      // offset. A gap in the numbering must end the run instead.
      const row = episodes.find((entry) => String(entry?.number) === number)
      if (!row?.id) break
      wanted.push(row)
    }
    if (!wanted.length) {
      errors.push(
        `"${matchedBy}": episodio ${start} non presente — episodi in catalogo: ${episodes_count}, finestra interrogata 1..${episodes.length} (maxRange ${this.maxRange})`
      )
      this.fail(errors)
    }

    const results = []
    for (const row of wanted) {
      try {
        const resolved = await this.resolveEpisodeUrl(jar, token, row.id)
        results.push(this.buildResult(record, Number(row.number), resolved.url, 'batch'))
      } catch (cause) {
        errors.push(`episodio ${row.number}: ${this.messageOf(cause)}`)
      }
    }

    // THE PARTIAL-BATCH RULE: zero rows is a failure, any row is a success.
    //
    // A previous version rejected on any non-empty `errors`, on the mistaken
    // ground that the host discards results whenever its own error list is
    // non-empty (`handler.js:117`). That premise is wrong and it was refuted by
    // the fact documented on `pack`: the host's error list is built ONLY from
    // rejected promises, so an `errors` array riding on a RETURNED array never
    // reaches `handler.js:117` and that branch never fires. Measured through the
    // real pipeline: rejecting surfaced 0 of 4 rows plus one line of text,
    // returning surfaced all 4. Same rule as animeworld.
    //
    // The cost, stated plainly: a partial batch reports success and its failing
    // episodes are SILENT. That is the deliberate trade — the user asked for a
    // run of episodes and gets working links for the ones that exist, which beats
    // discarding them for the sake of a sentence about the rest.
    if (!results.length) {
      this.fail(errors.length ? errors : [`"${matchedBy}": nessun episodio risolto`])
    }
    return this.pack(results, errors)
  }

  /**
   * Resolve a movie: this site files movies as single-entry series, so a movie
   * is episode 1 of its own record.
   * @param {object} query
   * @returns {Promise<object[]>} result array, with an `errors: string[]` property
   */
  async movie(query) {
    return this.single({ ...query, episode: 1 })
  }

  /**
   * Validate source availability.
   *
   * A genuine reachability check, and deliberately more than a status code:
   * the homepage being up is not enough, because the only thing this file needs
   * from it is the CSRF token. So this asserts the token is actually in the
   * page — that is what distinguishes "reachable and usable" from "reachable
   * and about to return 419 on every search".
   * @returns {Promise<boolean>}
   */
  async validate() {
    const jar = this.createJar()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeout)
    try {
      const response = await fetch(`${this.url}/`, {
        method: 'GET',
        signal: controller.signal,
        headers: this.baseHeaders
      })
      if (!response.ok) return false
      const html = await response.text()
      return /<meta\s+name=["']csrf-token["']\s+content=["'][^"']+["']/i.test(html)
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }
}
