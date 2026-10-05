/**
 * Kitsu client tests. No network: `globalThis.fetch` is replaced for the whole
 * file and every URL the client sends is recorded and inspected.
 *
 * The assertion that appears more than once on purpose — `sort=-searchScore` is
 * never sent — is the regression guard for a measured HTTP 400, so it is checked
 * against every recorded URL rather than once inside the search test.
 */

import test, { after, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  EPISODE_PAGE_SIZE,
  KitsuError,
  KitsuMaxPageSize,
  META_BUDGET_MS,
  PAGE_CONCURRENCY,
  REQUEST_TIMEOUT_MS,
  mapShowType,
  meta,
  search
} from '../src/kitsu.js'

const realFetch = globalThis.fetch

/** @type {string[]} every URL the client asked for */
let calls

/**
 * Replace the global fetch with a recording stub.
 * @param {(url: string, init: object) => any} handler
 */
function install(handler) {
  calls = []
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input)
    calls.push(url)
    return handler(url, init)
  }
}

/** @param {unknown} body */
function jsonOk(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/vnd.api+json' }
  })
}

/**
 * The real API's own answer to an out-of-range page, verbatim: this is the string
 * Kitsu puts in the 400 body. Used by the regression tests that assert we never
 * generate such a request in the first place.
 */
const LIMIT_EXCEEDS_BODY = {
  errors: [{ title: 'Invalid page value', detail: 'Limit exceeds maximum page size of 20.', code: '400' }]
}

/**
 * ── The fixtures below copy the shapes the LIVE API actually returns, because a
 * ── mock that is shaped differently hides real defects. Two of them were caught
 * ── exactly that way, and both were in `meta()`:
 * ──   * `/anime/{id}` is a SINGLE-RESOURCE endpoint: `data` is the object itself,
 * ──     not an array of one. Returning an array here made `meta()` throw "id
 * ──     inesistente" on a perfectly healthy id.
 * ──   * the JSON:API type of a genre is `genres`, PLURAL. Filtering on `genre`
 * ──     matched nothing and every meta came back with `genres: []`, on a 200.
 * ── Both look fine against a mock and fail on the first live call.
 */
const animeRecord = (over = {}) => ({
  type: 'anime',
  id: '12',
  attributes: {
    slug: 'one-piece',
    canonicalTitle: 'One Piece',
    titles: { en: 'One Piece', it: null },
    showType: 'TV',
    startDate: '1999-10-20',
    episodeCount: null,
    synopsis: null,
    posterImage: { small: '/small.jpg', medium: '/medium.jpg', original: '/original.jpg' },
    coverImage: { large: '/cover-large.jpg', original: '/cover-original.jpg' },
    ...over
  }
})

/** Collection document: /anime and /anime/{id}/episodes. */
const collection = (data, count) => ({ data, meta: { count } })

/** Single-resource document: /anime/{id}. `data` is the object, NOT an array. */
const resource = (data, included = []) => ({ data, included })

/** A genre as Kitsu types it, plural. */
const genre = (id, name) => ({ type: 'genres', id, attributes: { name, slug: name.toLowerCase() } })

const episodeRecord = (number, over = {}) => ({
  type: 'episodes',
  id: `ep-${number}`,
  attributes: { number, absoluteNumber: number, title: null, aired: null, ...over }
})

// The stub is installed per test; this is what puts the real fetch back.
after(() => {
  globalThis.fetch = realFetch
})

describe('search()', () => {
  test('mappa un record JSON:API nel shape dichiarato', async () => {
    install(() => jsonOk(collection([animeRecord()], 1)))

    const results = await search('One Piece', { limit: 5 })

    assert.equal(results.length, 1)
    assert.deepEqual(results[0], {
      kitsuId: '12',
      slug: 'one-piece',
      type: 'series',
      title: 'One Piece',
      year: 1999,
      poster: '/original.jpg',
      episodeCount: null
    })
  })

  test('codifica gli array di query e NON manda sort=-searchScore', async () => {
    install(() => jsonOk(collection([], 0)))

    await search('Kimetsu no Yaiba & c.', { limit: 12 })

    assert.equal(calls.length, 1)
    const url = new URL(calls[0])
    // Brackets percent-encoded: the raw `filter[text]=` form is not what is sent.
    assert.equal(url.searchParams.get('filter[text]'), 'Kimetsu no Yaiba & c.')
    assert.equal(url.searchParams.get('page[limit]'), '12')
    assert.equal(url.search.includes('['), false, 'nessuna parentesi grezza è rimasta in search')
    assert.equal(url.searchParams.get('sort'), null)
    assert.equal(calls[0].includes('searchScore'), false)
  })

  test('gestisce episodeCount null (serie in corso) senza crash', async () => {
    install(() =>
      jsonOk(
        collection(
          [
            animeRecord({ episodeCount: null }),
            { ...animeRecord({ episodeCount: 1180, slug: 'naruto' }), id: '20' }
          ],
          2
        )
      )
    )

    const [running, finished] = await search('x')

    assert.equal(running.episodeCount, null)
    assert.ok('episodeCount' in running, 'la chiave esiste anche quando vale null')
    assert.equal(finished.episodeCount, 1180)
  })

  test('mappa showType su type', async () => {
    install(() =>
      jsonOk(
        collection(
          [
            { ...animeRecord({ showType: 'TV' }), id: '1' },
            { ...animeRecord({ showType: 'movie' }), id: '2' },
            { ...animeRecord({ showType: 'ONA' }), id: '3' },
            { ...animeRecord({ showType: 'TV Special' }), id: '4' },
            { ...animeRecord({ showType: null }), id: '5' }
          ],
          5
        )
      )
    )

    const results = await search('x')

    assert.deepEqual(
      results.map((r) => r.type),
      ['series', 'movie', 'series', 'series', 'series']
    )
    assert.equal(mapShowType('MOVIE'), 'movie')
    assert.equal(mapShowType(undefined), 'series')
  })

  test('title: titles.en, poi canonicalTitle, poi slug', async () => {
    install(() =>
      jsonOk(
        collection(
          [
            { ...animeRecord({ titles: { en: 'Naruto', ja: 'ナルト' }, canonicalTitle: 'Naruto Shippuden' }), id: '1' },
            { ...animeRecord({ titles: { en: null }, canonicalTitle: 'Bleach' }), id: '2' },
            { ...animeRecord({ titles: { en: null }, canonicalTitle: null, slug: 'only-slug' }), id: '3' }
          ],
          3
        )
      )
    )

    const results = await search('x')

    assert.deepEqual(results.map((r) => r.title), ['Naruto', 'Bleach', 'only-slug'])
  })

  test('poster: original, poi medium', async () => {
    install(() =>
      jsonOk(
        collection(
          [
            { ...animeRecord({ posterImage: { original: '/o.jpg', medium: '/m.jpg' } }), id: '1' },
            { ...animeRecord({ posterImage: { medium: '/m-only.jpg' } }), id: '2' },
            { ...animeRecord({ posterImage: null }), id: '3' }
          ],
          3
        )
      )
    )

    const results = await search('x')

    assert.deepEqual(results.map((r) => r.poster), ['/o.jpg', '/m-only.jpg', null])
  })

  test('query vuota -> [] senza toccare la rete', async () => {
    install(() => jsonOk(collection([animeRecord()], 1)))

    assert.deepEqual(await search('   '), [])
    assert.deepEqual(await search(null), [])
    assert.equal(calls.length, 0)
  })

  test('data assente o non-array -> [] senza crash', async () => {
    install(() => jsonOk({ meta: { count: 0 } }))
    assert.deepEqual(await search('x'), [])
  })
})

describe('meta()', () => {
  test('episodi con numerazione assoluta, paginati fino a esaurire', async () => {
    // 70 episodi con pagine da 20 => 4 pagine: offset 0, 20, 40, 60.
    const total = EPISODE_PAGE_SIZE * 3 + 10
    install((url) => {
      if (!url.includes('/episodes')) return jsonOk(resource(animeRecord()))
      const parsed = new URL(url)
      const offset = Number(parsed.searchParams.get('page[offset]'))
      const limit = Number(parsed.searchParams.get('page[limit]'))
      const slice = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) =>
        episodeRecord(offset + i + 1)
      )
      return jsonOk({ data: slice, meta: { count: total } })
    })

    const result = await meta('12')

    assert.equal(result.episodes.length, total, 'nessuna lista troncata')
    assert.equal(result.episodes[0].number, 1)
    assert.equal(result.episodes.at(-1).number, total)

    // Tre richieste all'endpoint /anime, quattro a /episodes.
    const episodeCalls = calls.filter((u) => u.includes('/episodes'))
    assert.equal(calls.length, 5)
    assert.equal(episodeCalls.length, 4, 'ceil(70/20) = 4 pagine')

    // Il pool finisce fuori ordine, quindi gli offset si confrontano come insieme:
    // l'ordine delle richieste NON è un contratto, l'ordine degli episodi sì.
    assert.deepEqual(
      episodeCalls.map((u) => Number(new URL(u).searchParams.get('page[offset]'))).sort((a, b) => a - b),
      [0, 20, 40, 60]
    )
    // ...mentre gli episodi tornano in ordine crescente.
    assert.deepEqual(
      result.episodes.map((e) => e.number),
      Array.from({ length: total }, (_, i) => i + 1)
    )

    // sort=number è legittimo sull'/episodes (il 400 riguarda /anime).
    assert.ok(episodeCalls.every((u) => new URL(u).searchParams.get('sort') === 'number'))
    assert.equal(new URL(calls[0]).searchParams.get('sort'), null)
  })

  test('number assoluto: preferisce absoluteNumber, cade su number', async () => {
    install((url) => {
      if (url.includes('/episodes')) {
        return jsonOk({
          data: [
            { type: 'episodes', id: '1', attributes: { number: 12, absoluteNumber: 954, title: "Its Name is Enma! Oden's Great Swords!", aired: '2019-10-20' } },
            { type: 'episodes', id: '2', attributes: { number: 7 } }
          ],
          meta: { count: 2 }
        })
      }
      return jsonOk(resource(animeRecord()))
    })

    const { episodes } = await meta('12')

    assert.equal(episodes[0].number, 954)
    assert.equal(episodes[0].title, "Its Name is Enma! Oden's Great Swords!")
    assert.equal(episodes[0].aired, '2019-10-20')
    assert.equal(episodes[1].number, 7, 'senza absoluteNumber il fallback è number')
    assert.equal(episodes[1].title, null)
    assert.equal(episodes[1].aired, null)
  })

  test('mappa il meta Stremio: poster, background, description, genres, year', async () => {
    install((url) => {
      if (url.includes('/episodes')) return jsonOk({ data: [], meta: { count: 0 } })
      return jsonOk(
        resource(animeRecord({ synopsis: 'Il pirata Monkey D. Luffy.' }), [
          genre('1', 'Action'),
          genre('27', 'Adventure'),
          { type: 'episodes', id: '999', attributes: {} } // tipo non-genere: deve essere scartato
        ])
      )
    })

    const result = await meta('12')

    assert.deepEqual(result, {
      id: '12',
      type: 'series',
      name: 'One Piece',
      poster: '/original.jpg',
      background: '/cover-original.jpg',
      description: 'Il pirata Monkey D. Luffy.',
      year: 1999,
      genres: ['Action', 'Adventure'],
      episodes: []
    })
  })

  test('description senza synopsis ripiega sul titolo, mai sull\'italiano', async () => {
    install((url) => {
      if (url.includes('/episodes')) return jsonOk({ data: [], meta: { count: 0 } })
      return jsonOk(resource(animeRecord({ titles: { en: 'One Piece', it: null } })))
    })

    const result = await meta('12')

    assert.equal(result.description, 'One Piece')
    assert.equal(result.name, 'One Piece')
  })

  test('showType movie -> type movie', async () => {
    install((url) => {
      if (url.includes('/episodes')) return jsonOk({ data: [], meta: { count: 0 } })
      return jsonOk(resource({ ...animeRecord({ showType: 'movie', titles: { en: 'Akira' } }), id: '99' }))
    })

    const result = await meta('99')

    assert.equal(result.type, 'movie')
    assert.equal(result.name, 'Akira')
    assert.equal(result.id, '99')
  })

  test('kitsuId mancante -> KitsuError, nessuna richiesta', async () => {
    install(() => jsonOk(resource(null)))

    await assert.rejects(() => meta(''), (error) => {
      assert.ok(error instanceof KitsuError)
      assert.equal(error.status, null)
      return true
    })
    assert.equal(calls.length, 0)
  })

  test('data vuoto -> KitsuError con lo status', async () => {
    install(() => jsonOk({ data: [], meta: { count: 0 } }, { status: 404 }))

    await assert.rejects(() => meta('99999999'), (error) => {
      assert.ok(error instanceof KitsuError)
      assert.equal(error.status, 404)
      assert.match(error.message, /\/anime\/99999999/)
      assert.match(error.message, /404/)
      return true
    })
  })
})

describe('errori e limiti', () => {
  test('404 -> KitsuError con status e URL, senza il body', async () => {
    install(() =>
      new Response(JSON.stringify({ errors: [{ detail: 'Not Found', secret: 'do-not-log-me' }] }), {
        status: 404,
        statusText: 'Not Found'
      })
    )

    await assert.rejects(() => search('nope'), (error) => {
      assert.ok(error instanceof KitsuError)
      assert.equal(error.name, 'KitsuError')
      assert.equal(error.status, 404)
      assert.equal(error.url, calls[0])
      assert.match(error.message, /HTTP 404/)
      assert.ok(error.message.includes(calls[0]), 'il messaggio nomina la URL')
      assert.equal(error.message.includes('do-not-log-me'), false, 'il body non finisce nel messaggio')
      assert.equal(JSON.stringify(error).includes('do-not-log-me'), false, 'né nell\'error serializzato')
      return true
    })
  })

  test('500 -> KitsuError con status 500', async () => {
    install(() => new Response('boom', { status: 500, statusText: 'Internal Server Error' }))

    await assert.rejects(() => search('x'), (error) => {
      assert.ok(error instanceof KitsuError)
      assert.equal(error.status, 500)
      assert.match(error.message, /HTTP 500/)
      return true
    })
  })

  test('corpo non JSON -> KitsuError, sempre senza il body', async () => {
    install(() => new Response('<html>not json</html>', { status: 200 }))

    await assert.rejects(() => search('x'), (error) => {
      assert.ok(error instanceof KitsuError)
      assert.equal(error.status, 200)
      assert.match(error.message, /non è JSON valido/)
      assert.equal(error.message.includes('<html>'), false)
      return true
    })
  })

  test('timeout via AbortController', { timeout: 60_000 }, async () => {
    let observedSignal = null
    install((url, init) => {
      observedSignal = init.signal
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('the operation was aborted')))
      })
    })

    const started = process.hrtime.bigint()
    await assert.rejects(() => search('x', { timeoutMs: 30 }), (error) => {
      assert.ok(error instanceof KitsuError)
      assert.equal(error.reason, 'timeout', 'deve essere un timeout, non un 4xx')
      assert.equal(error.status, null, 'un timeout non è uno status HTTP')
      // "timeout 30 ms" e non "timeout 20000 ms": la prova che è scattato il
      // timer di questa chiamata, non il default del modulo.
      assert.match(error.message, /timeout 30 ms/)
      assert.ok(error.message.includes(calls[0]))
      return true
    })
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6

    // Le asserzioni sopra sono la verifica vera e non dipendono dal clock.
    // Resta un controllo di wall-clock, e questo ha bisogno di slack proporzionato
    // all'host e non al codice: il test è fallito a 8,8 s e 10,6 s su una macchina
    // con load average 31,59 su 16 CPU (due istanze markdown-oxide a 460% e 188%
    // di CPU), mentre passava 12/12 da solo. Un setTimeout da 30 ms schedulato
    // 300x in ritardo è il SO che dice "sono occupato", non l'abort che fallisce.
    // Il limite resta però molto sotto REQUEST_TIMEOUT_MS (20 s): se il timer
    // del client non fosse scattato, questa chiamata avrebbe impiegato 20 s.
    assert.ok(
      elapsedMs < REQUEST_TIMEOUT_MS * 0.75,
      `la richiesta è tornata in ${elapsedMs.toFixed(0)} ms invece di abortire sul nostro timer`
    )
    assert.equal(observedSignal.aborted, true, 'il segnale di abort è partito')
  })

  test('abort a metà corpo -> timeout, NON "corpo non JSON" (bug trovato sul live)', async () => {
    // Scenario misurato sul Kitsu vero: arriva l'intestazione 200, il timer
    // scade mentre il body è ancora in streaming, e response.json() butta
    // AbortError. Riportarlo come "corpo non JSON" darebbe la colpa a Kitsu di un
    // corpo che ha tagliato il nostro timer.
    install(
      (url, init) =>
        new Promise((resolve) => {
          init.signal.addEventListener('abort', () => {
            // Dopo l'abort la response è "insabbiata": il json() rigenera
            // AbortError, proprio come fa undici.
            resolve({
              ok: true,
              status: 200,
              statusText: 'OK',
              json: async () => {
                init.signal.throwIfAborted()
                throw new Error('unexpected: il body si sarebbe letto')
              }
            })
          })
        })
    )

    await assert.rejects(() => search('x', { timeoutMs: 30 }), (error) => {
      assert.ok(error instanceof KitsuError)
      assert.equal(error.reason, 'timeout', 'un abort è un timeout, non un body malformato')
      assert.match(error.message, /timeout 30 ms/)
      assert.equal(error.message.includes('non è JSON'), false, 'la diagnosi non deve essere invalid_json')
      return true
    })
  })

  test('le costanti sono coerenti col tetto misurato', () => {
    assert.equal(KitsuMaxPageSize, 20)
    assert.equal(
      EPISODE_PAGE_SIZE,
      KitsuMaxPageSize,
      'EPISODE_PAGE_SIZE non può superare il tetto: altrimenti ogni pagina va in 400'
    )
    assert.equal(typeof REQUEST_TIMEOUT_MS, 'number')
    assert.ok(REQUEST_TIMEOUT_MS > 0 && REQUEST_TIMEOUT_MS <= 30_000)
    assert.equal(META_BUDGET_MS < 30_000, true, 'il budget deve stare sotto il timeout della route')
    assert.ok(PAGE_CONCURRENCY >= 2 && PAGE_CONCURRENCY <= 16, 'un pool, non Promise.all su 71 pagine')
  })
})

describe('tetto page[limit] = 20 (misurato su entrambi gli endpoint)', () => {
  test('Nessun URL registrato, su nessuno dei due endpoint, supera 20', async () => {
    install((url) => {
      if (!url.includes('/episodes')) return jsonOk(resource(animeRecord()))
      return jsonOk({ data: [episodeRecord(1)], meta: { count: 1 } })
    })

    await search('One Piece')
    await meta('12')

    // Ogni URL che porta page[limit] deve stare in [1, 20]. Gli URL SENZA
    // page[limit] sono la richiesta del record singolo in meta() (`/anime/12?
    // include=genres`), che non pagina affatto: non sono un caso da normalizzare,
    // sono un endpoint diverso.
    const paged = calls.filter((u) => new URL(u).searchParams.get('page[limit]') !== null)
    assert.ok(paged.length > 0)

    for (const url of paged) {
      const limit = Number(new URL(url).searchParams.get('page[limit]'))
      assert.ok(
        Number.isInteger(limit) && limit >= 1 && limit <= KitsuMaxPageSize,
        `${url} porta page[limit]=${limit}, fuori da [1, ${KitsuMaxPageSize}]`
      )
    }

    // Entrambi gli endpoint sono davvero stati visitati CON page[limit]: senza
    // questi due assert il controllo sopra passerebbe anche se uno dei due
    // endpoint non fosse mai stato raggiunto.
    const isPaged = (needle) => (u) => u.includes(needle) && new URL(u).searchParams.get('page[limit]') !== null
    assert.ok(calls.some(isPaged('/anime?filter')), 'endpoint di ricerca senza page[limit]')
    assert.ok(calls.some(isPaged('/episodes')), 'endpoint episodi senza page[limit]')
  })

  test('search("x", { limit: 50 }) non genera page[limit]=50', async () => {
    install(() => jsonOk(collection([], 0)))

    await search('x', { limit: 50 })

    const limit = new URL(calls[0]).searchParams.get('page[limit]')
    assert.equal(limit, '20', 'clampato, non passato attraverso')
    assert.equal(calls[0].includes('50'), false)
  })

  test('limit fuori range: 0, -5, 1.9, NaN, Infinity, "20", 10_000', async () => {
    for (const [input, expected] of [
      [0, '1'],
      [-5, '1'],
      [1.9, '1'],
      [Number.NaN, '20'],
      [Number.POSITIVE_INFINITY, '20'],
      ['20', '20'],
      [10_000, '20'],
      [1, '1'],
      [20, '20']
    ]) {
      install(() => jsonOk(collection([], 0)))
      await search('x', { limit: input })
      const limit = new URL(calls[0]).searchParams.get('page[limit]')
      assert.equal(limit, expected, `search({limit: ${input}}) -> page[limit]=${limit}, atteso ${expected}`)
    }
  })

  test('il clampa avviene PRIMA della rete: il mock risponde 400 come Kitsu e non lo vediamo mai', async () => {
    // Il mock fa esattamente cio che fa l'API: 400 se page[limit] > 20. Se il
    // clamp fosse fatto tardi (o non fatto), questi test fallirebbero con un
    // KitsuError HTTP 400 invece di passare.
    const strictServer = (url) => {
      const limit = Number(new URL(url).searchParams.get('page[limit]'))
      if (Number.isFinite(limit) && limit > KitsuMaxPageSize) {
        return jsonOk(LIMIT_EXCEEDS_BODY, { status: 400 })
      }
      // Tre endpoint, tre forme: la ricerca e una collezione, il record di
      // meta() e una risorsa singola, /episodes e una collezione. Restituire
      // sempre la stessa forma qui sarebbe ripetere, in un test, l'errore che
      // questo file sta documentando.
      if (url.includes('/episodes')) return jsonOk(collection([episodeRecord(1)], 1))
      if (url.includes('/anime?')) return jsonOk(collection([animeRecord()], 1))
      return jsonOk(resource(animeRecord()))
    }

    install(strictServer)
    const results = await search('One Piece', { limit: 50 })
    assert.equal(results.length, 1, 'nessun 400 sulla ricerca con limit fuori range')

    install(strictServer)
    const full = await meta('12')
    assert.equal(full.episodes.length, 1, 'nessun 400 sulle pagine episodi')

    for (const url of calls) {
      assert.ok(!url.includes('limit%5D=50'), `richiesta vietata generata: ${url}`)
    }
  })

  test('meta() su una serie lunga (1000 episodi = 50 pagine) non sfora mai il tetto', async () => {
    const total = 1000
    install((url) => {
      if (!url.includes('/episodes')) return jsonOk(resource(animeRecord()))
      const parsed = new URL(url)
      const offset = Number(parsed.searchParams.get('page[offset]'))
      const limit = Number(parsed.searchParams.get('page[limit]'))
      if (limit > KitsuMaxPageSize) return jsonOk(LIMIT_EXCEEDS_BODY, { status: 400 })
      const slice = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) =>
        episodeRecord(offset + i + 1)
      )
      return jsonOk({ data: slice, meta: { count: total } })
    })

    const full = await meta('12')

    assert.equal(full.episodes.length, total)
    assert.equal(calls.length, 1 + Math.ceil(total / KitsuMaxPageSize), '51 richieste: 1 + 50 pagine')
    assert.ok(calls.every((u) => Number(new URL(u).searchParams.get('page[limit]')) <= KitsuMaxPageSize))
  })
})

describe('pool limitato e integrità dell\'elenco', () => {
  test('concorrenza mai oltre PAGE_CONCURRENCY, e 1410 pagine in 71 richieste', async () => {
    const total = 1410 // One Piece, misurato
    let inFlight = 0
    let peak = 0

    install((url) => {
      if (!url.includes('/episodes')) return jsonOk(resource(animeRecord()))
      inFlight++
      peak = Math.max(peak, inFlight)
      const parsed = new URL(url)
      const offset = Number(parsed.searchParams.get('page[offset]'))
      const limit = Number(parsed.searchParams.get('page[limit]'))
      const slice = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) =>
        episodeRecord(offset + i + 1)
      )
      // Ritardo asincrono: con un handler sincrono ogni worker azzererebbe
      // inFlight prima che il prossimo lo incremented, e il picco sarebbe 1.
      return new Promise((resolve) => {
        setTimeout(() => {
          inFlight--
          resolve(jsonOk({ data: slice, meta: { count: total } }))
        }, 2)
      })
    })

    const full = await meta('12')

    assert.equal(full.episodes.length, total, '1410 episodi, nessuna troncatura')
    assert.equal(full.episodes[0].number, 1)
    assert.equal(full.episodes.at(-1).number, 1410)
    assert.equal(calls.length, 1 + Math.ceil(total / KitsuMaxPageSize), '72 richieste: 1 + 71 pagine')
    assert.ok(peak > 1, `picco di concorrenza ${peak}: se fosse 1 il pool non esiste`)
    assert.ok(peak <= PAGE_CONCURRENCY, `picco ${peak} oltre PAGE_CONCURRENCY=${PAGE_CONCURRENCY}`)
    assert.ok(
      calls.every((u) => Number(new URL(u).searchParams.get('page[limit]')) <= KitsuMaxPageSize)
    )
  })

  test('elenco incompleto -> throw tipizzato, MAI troncato in silenzio', async () => {
    // Il server dichiara meta.count 1410 ma restituisce pagine corte: il caso in
    // cui restituire quello che c\'è sembrerebbe un successo con 20 episodi su
    // 1410. Deve fallire.
    install((url) => {
      if (!url.includes('/episodes')) return jsonOk(resource(animeRecord()))
      return jsonOk({ data: [episodeRecord(1)], meta: { count: 1410 } })
    })

    await assert.rejects(() => meta('12'), (error) => {
      assert.ok(error instanceof KitsuError, 'deve essere un KitsuError, non un risultato parziale')
      assert.equal(error.reason, 'budget')
      assert.match(error.message, /elenco incompleto/)
      assert.match(error.message, /1410/)
      assert.ok(error.message.includes(error.url), 'la URL della richiesta va nel messaggio')
      return true
    })
  })

  test('budget scaduto -> throw tipizzato che nomina il budget, non un timeout qualsiasi', async () => {
    const total = 1410
    install((url) => {
      if (!url.includes('/episodes')) return jsonOk(resource(animeRecord()))
      const parsed = new URL(url)
      const offset = Number(parsed.searchParams.get('page[offset]'))
      const limit = Number(parsed.searchParams.get('page[limit]'))
      const slice = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) =>
        episodeRecord(offset + i + 1)
      )
      // Ogni pagina arriva dopo i 40 ms: con budgetMs 120 la terza wave scade.
      return new Promise((resolve) => {
        setTimeout(() => resolve(jsonOk({ data: slice, meta: { count: total } })), 40)
      })
    })

    const started = process.hrtime.bigint()
    await assert.rejects(
      () => meta('12', { budgetMs: 120 }),
      (error) => {
        assert.ok(error instanceof KitsuError)
        assert.equal(error.reason, 'budget')
        assert.match(error.message, /budget/)
        assert.match(error.message, /scaduto/)
        // Il messaggio deve NOMINARE la richiesta che è rimasta indietro. È già
        // successo una volta di stampare "GET undefined -> ..." perché la URL
        // veniva destrutturata da una funzione che restituisce una stringa.
        assert.ok(error.url, 'KitsuError.url è obbligatorio')
        assert.ok(
          error.message.includes(error.url),
          `il messaggio deve contenere la URL, non "undefined": ${error.message}`
        )
        assert.equal(error.message.includes('undefined'), false)
        return true
      }
    )
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
    assert.ok(elapsedMs < 5000, `il budget doveva tagliare, sono passati ${elapsedMs.toFixed(0)} ms`)
  })

  test('budget inesaurito: le 1410 tornano tutte entro il budget', async () => {
    const total = 1410
    install((url) => {
      if (!url.includes('/episodes')) return jsonOk(resource(animeRecord()))
      const parsed = new URL(url)
      const offset = Number(parsed.searchParams.get('page[offset]'))
      const limit = Number(parsed.searchParams.get('page[limit]'))
      const slice = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) =>
        episodeRecord(offset + i + 1)
      )
      return jsonOk({ data: slice, meta: { count: total } })
    })

    const full = await meta('12', { budgetMs: 60_000 })
    assert.equal(full.episodes.length, total)
  })
})

describe('LIVE — Kitsu vero, nessun mock (SAR_LIVE=1)', () => {
  // Questi due test sono l'unico posto del progetto che esce su internet. Sono
  // skippati per default perché la CI resta offline: si lanciano con
  //   SAR_LIVE=1 node --test test/kitsu.test.mjs
  const live = process.env.SAR_LIVE === '1'
  const skip = live ? false : 'serve SAR_LIVE=1 (test di rete, la CI resta offline)'

  /** Wrap del fetch reale: si registra la URL e si delega davvero. */
  function installReal() {
    const seen = []
    globalThis.fetch = realFetch
    const delegating = (input, init) => {
      seen.push(typeof input === 'string' ? input : String(input?.url ?? input))
      return realFetch(input, init)
    }
    globalThis.fetch = delegating
    return seen
  }

  test('search("One Piece") risponde e non chiede mai page[limit] > 20', { skip, timeout: 120_000 }, async () => {
    const seen = installReal()
    try {
      const results = await search('One Piece', { limit: 50 })

      assert.ok(Array.isArray(results))
      assert.ok(results.length > 0, 'la ricerca live deve tornare almeno un risultato')
      assert.equal(results[0].type, 'series')

      for (const url of seen) {
        const limit = Number(new URL(url).searchParams.get('page[limit]'))
        assert.ok(
          Number.isInteger(limit) && limit >= 1 && limit <= KitsuMaxPageSize,
          `richiesta live fuori tetto: ${url}`
        )
      }
      console.error(
        `[LIVE] search: ${results.length} risultati, ${seen.length} richieste, primo="${results[0].title}" (${results[0].kitsuId})`
      )
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test('meta(12) = One Piece torna con tutti i 1410 episodi, in tempo', { skip, timeout: 180_000 }, async () => {
    const seen = installReal()
    const started = process.hrtime.bigint()
    try {
      const full = await meta(12)
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6

      assert.equal(full.name, 'One Piece')
      assert.equal(full.episodes.length, 1410, 'nessuna troncatura: 1410, non 20')
      assert.equal(full.episodes[0].number, 1)
      assert.equal(full.episodes.at(-1).number, 1410)
      assert.equal(full.episodes[953].number, 954)

      // `genres` è il campo che in assenza di rete restituiva [] senza errori:
      // il tipo JSON:API del genere e' il plurale "genres". Controllarlo solo sui
      // mock avrebbe lasciato passare il difetto.
      assert.ok(full.genres.length > 0, 'genres vuoto: il filtro su included sta ignorando il tipo vero')
      assert.ok(full.genres.every((g) => typeof g === 'string' && g.length > 0))
      assert.ok(full.poster.startsWith('https://'), `poster non HTTPS: ${full.poster}`)
      assert.ok(full.background.startsWith('https://'), `background non HTTPS: ${full.background}`)
      assert.equal(full.type, 'series')
      // Kitsu non ha titoli italiani: nessuna traduzione inventata.
      assert.equal(full.description.includes('Pirate King'), true)

      const episodeCalls = seen.filter((u) => u.includes('/episodes'))
      console.error(
        `[LIVE] meta(12): ${full.episodes.length} episodi in ${elapsedMs.toFixed(0)} ms, ${seen.length} richieste (${episodeCalls.length} pagine da ${KitsuMaxPageSize}), ${full.genres.length} generi, "${full.genres.slice(0, 3).join(', ')}"`
      )
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

describe('invariante sort=-searchScore', () => {
  test('nessuna richiesta di search() e meta() lo contiene, mai', async () => {
    install((url) => {
      if (url.includes('/episodes')) {
        return jsonOk({ data: [episodeRecord(1)], meta: { count: 1 } })
      }
      return jsonOk(resource(animeRecord()))
    })

    await search('One Piece')
    await search('a very odd ?&=# query', { limit: 3 })
    await meta('12')

    assert.equal(calls.length, 4, 'search + search + meta(anime) + meta(episodes)')
    for (const url of calls) {
      assert.equal(url.includes('searchScore'), false, `sort=-searchScore presente in ${url}`)
      const sort = new URL(url).searchParams.get('sort')
      // sort=number solo sull'/episodes; su /anime il parametro non ci deve essere.
      assert.equal(sort, url.includes('/episodes') ? 'number' : null, `sort inatteso in ${url}`)
    }
  })
})