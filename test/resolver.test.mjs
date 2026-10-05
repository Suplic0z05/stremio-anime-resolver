/**
 * Resolver tests. No network and no module mocking: every source is injected
 * through the `sources` option as `{ id, label, instance }`, which is the seam
 * `resolveSeries`/`resolveMovie` expose for exactly this.
 *
 * The real three sources are also imported here — not to be called, but to assert
 * the Node-adaptation contract that the copy from shiru-italian-streaming had to
 * preserve: `default` is an INSTANCE, the four entry points are functions, and
 * `validate` never throws. Those assertions are the regression guard for the
 * "importable da Node" requirement.
 */

import test, { describe } from 'node:test'
import assert from 'node:assert/strict'

import { SOURCES, SOURCE_TIMEOUT_MS, getSource, resolveMovie, resolveSeries } from '../src/resolver.js'
import animeworld from '../src/sources/animeworld.js'
import animesaturn from '../src/sources/animesaturn.js'
import animeunity from '../src/sources/animeunity.js'

/**
 * A source stub whose `single`/`movie`/`batch` do what the test says.
 * @param {string} id
 * @param {() => any} handler receives { titles, episode }
 */
function stub(id, handler) {
  return { id, label: id, instance: { single: async (q) => handler(q), movie: async (q) => handler(q) } }
}

/** One upstream-shaped row, including the `hash: ''` the real sources carry. */
function row(title, link) {
  return { title, link, hash: '', seeders: 0, leechers: 0, type: 'http' }
}

const http500 = (name) => async () => {
  throw new Error(`GET https://${name}.example/api -> HTTP 500 Internal Server Error`)
}

describe('SOURCES', () => {
  test('espone i tre id con la loro label e nient\'altro', () => {
    assert.deepEqual(SOURCES, [
      { id: 'animeworld', label: 'AnimeWorld' },
      { id: 'animesaturn', label: 'AnimeSaturn' },
      { id: 'animeunity', label: 'AnimeUnity' }
    ])
  })

  test('ogni id risolve a un\'istanza importata', () => {
    for (const { id } of SOURCES) {
      const instance = getSource(id)
      assert.ok(instance, `nessuna istanza per ${id}`)
      assert.equal(typeof instance, 'object')
      assert.equal(instance.constructor.name.startsWith('Anime'), true, `${id} non è un'istanza`)
    }
  })

  test('le tre fonti importate da Node sono istanze, non classi', () => {
    for (const [id, instance] of [
      ['animeworld', animeworld],
      ['animesaturn', animesaturn],
      ['animeunity', animeunity]
    ]) {
      assert.equal(typeof instance, 'object', `${id}: default deve essere un'istanza`)
      for (const method of ['single', 'batch', 'movie', 'validate']) {
        assert.equal(typeof instance[method], 'function', `${id}.${method} mancante`)
      }
    }
  })

  test('SOURCE_TIMEOUT_MS e\' un tetto per fonte, non per richiesta totale', () => {
    assert.equal(typeof SOURCE_TIMEOUT_MS, 'number')
    assert.ok(SOURCE_TIMEOUT_MS >= 20_000 && SOURCE_TIMEOUT_MS <= 60_000)
  })
})

describe('resolveSeries()', () => {
  test('mappa link -> url e toglie il marcatore [AW]', async () => {
    const streams = await resolveSeries({
      title: 'One Piece',
      episode: 5,
      sources: [stub('animeworld', () => [row('One Piece ITA - Ep 5 [AW]', 'https://cdn.example/op05.mp4')])]
    })

    assert.deepEqual(streams, [
      { name: 'animeworld', title: 'One Piece ITA - Ep 5', url: 'https://cdn.example/op05.mp4', source: 'animeworld' }
    ])
  })

  test('non copia MAI hash, nemmeno se la fonte ne inventa uno', async () => {
    const streams = await resolveSeries({
      title: 'x',
      sources: [
        stub('animeunity', () => [{ title: 'Naruto ITA - Ep 2 [AU]', link: 'https://v.example/n2.mp4', hash: 'f'.repeat(40) }])
      ]
    })

    assert.equal(streams.length, 1)
    assert.equal('hash' in streams[0], false, 'hash non deve comparire nello Stream')
    assert.equal(Object.keys(streams[0]).length, 4)
    assert.equal(streams[0].url, 'https://v.example/n2.mp4')
  })

  test('non mangia un [ITA] finale, solo i tre marcatori propri', async () => {
    const streams = await resolveSeries({
      title: 'x',
      sources: [
        stub('animesaturn', () => [
          row('Kimetsu no Yaiba [ITA]', 'https://a.example/1.mp4'),
          row('Kimetsu no Yaiba ITA - Ep 7 [AS]', 'https://a.example/2.mp4')
        ])
      ]
    })

    assert.deepEqual(streams.map((s) => s.title), ['Kimetsu no Yaiba [ITA]', 'Kimetsu no Yaiba ITA - Ep 7'])
  })

  test('propaga title/episode alla fonte e conserva il nome della label', async () => {
    const seen = []
    const streams = await resolveSeries({
      title: '  Naruto  ',
      episode: 12,
      sources: [{ id: 'animesaturn', label: 'AnimeSaturn', instance: { single: async (q) => (seen.push(q), [row('N - Ep 12 [AS]', 'https://s.example/12.mp4')]) } }]
    })

    assert.deepEqual(seen, [{ titles: ['Naruto'], episode: 12 }])
    assert.equal(streams[0].name, 'AnimeSaturn')
    assert.equal(streams[0].source, 'animesaturn')
  })

  test('tutte le fonti con array vuoto -> [] e nessun throw', async () => {
    const streams = await resolveSeries({
      title: 'non-esiste',
      sources: [stub('a', () => []), stub('b', () => []), stub('c', () => [])]
    })

    assert.deepEqual(streams, [])
    assert.equal(Array.isArray(streams), true)
  })

  test('throw solo se TUTTE le fonti falliscono, con i messaggi aggregati', async () => {
    await assert.rejects(
      () =>
        resolveSeries({
          title: 'One Piece',
          sources: [
            { id: 'animeworld', label: 'AnimeWorld', instance: { single: http500('animeworld') } },
            { id: 'animesaturn', label: 'AnimeSaturn', instance: { single: http500('animesaturn') } },
            { id: 'animeunity', label: 'AnimeUnity', instance: { single: http500('animeunity') } }
          ]
        }),
      (error) => {
        assert.match(error.message, /One Piece/)
        for (const host of ['animeworld', 'animesaturn', 'animeunity']) {
          assert.ok(error.message.includes(host), `messaggio mancante per ${host}`)
          assert.ok(error.message.includes(`https://${host}.example/api`), 'manca la URL del fallimento')
          assert.ok(error.message.includes('HTTP 500'))
        }
        assert.equal(error.errors.length, 3)
        return true
      }
    )
  })

  test('due fonti su tre in errore -> restituisce comunque gli stream della terza', async () => {
    const streams = await resolveSeries({
      title: 'One Piece',
      episode: 5,
      sources: [
        { id: 'animeworld', label: 'AnimeWorld', instance: { single: http500('animeworld') } },
        { id: 'animesaturn', label: 'AnimeSaturn', instance: { single: http500('animesaturn') } },
        stub('animeunity', () => [row('One Piece ITA - Ep 5 [AU]', 'https://v.example/5.mp4')])
      ]
    })

    assert.equal(streams.length, 1)
    assert.equal(streams[0].source, 'animeunity')
    assert.equal(streams.errors.length, 2, 'i due fallimenti restano diagnostica')
  })

  test('una fonte che rompe il contratto (non-array) non ferma le altre', async () => {
    const streams = await resolveSeries({
      title: 'x',
      sources: [
        { id: 'bad', label: 'Bad', instance: { single: async () => ({ results: [] }) } },
        { id: 'nullish', label: 'Nullish', instance: { single: async () => null } },
        stub('good', () => [row('X - Ep 1', 'https://g.example/1.mp4')])
      ]
    })

    assert.equal(streams.length, 1)
    assert.equal(streams[0].source, 'good')
    assert.equal(streams.errors.length, 2)
    assert.match(streams.errors[0], /non un array/)
  })

  test('risultati senza link riproducibile vengono scartati, non trasformati', async () => {
    const streams = await resolveSeries({
      title: 'x',
      sources: [
        stub('a', () => [
          row('no link', ''),
          row('magnet', 'magnet:xt=urn:btih:0123456789abcdef'),
          { title: 'assente' }
        ])
      ]
    })

    assert.deepEqual(streams, [])
    assert.equal(streams.errors.length, 3)
  })

  // Il timeout qui NON è parte dell'assert: la barriera non ha componenti temporali,
  // il test si chiude da solo quando tutte e tre le fonti hanno girato. È solo la
  // rete di sicurezza contro il deadlock di un runner sequenziale, e per questo
  // ha bisogno di slack: 2 s erano stretti su una macchina con load average 31,59
  // su 16 CPU, dove un semplice `setImmediate` puo' ritardare di secondi.
  // Non serve toccare l'assert sul parallelismo, che resta il punto del test.
  test('tre fonti girano IN PARALLELO, non in sequenza', { timeout: 10_000 }, async () => {
    let started = 0
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    // Ogni fonte si blocca finché tutte e tre non hanno iniziato: un runner
    // sequenziale resterebbe fermo sulla prima e questo test andrebbe in timeout.
    const barrier = (id) => ({
      id,
      label: id,
      instance: {
        single: async () => {
          started++
          if (started === 3) release()
          await gate
          return [row(`${id} - Ep 1`, `https://${id}.example/1.mp4`)]
        }
      }
    })

    const streams = await resolveSeries({ title: 'x', sources: [barrier('a'), barrier('b'), barrier('c')] })

    assert.equal(started, 3, 'le tre fonti devono essere partite prima che una torni')
    assert.deepEqual(streams.map((s) => s.source), ['a', 'b', 'c'])
  })

  test('rispetta il timeout per fonte senza bloccare le altre', async () => {
    const streams = await resolveSeries({
      title: 'x',
      timeoutMs: 60,
      sources: [
        {
          id: 'stalled',
          label: 'Stalled',
          instance: {
            single: () =>
              new Promise((resolve) => {
                const timer = setTimeout(() => resolve([row('X', 'https://s.example/1.mp4')]), 10_000)
                if (typeof timer.unref === 'function') timer.unref()
              })
          }
        },
        stub('fast', () => [row('X - Ep 1', 'https://f.example/1.mp4')])
      ]
    })

    assert.equal(streams.length, 1)
    assert.equal(streams[0].source, 'fast')
    assert.match(streams.errors[0], /stalled: timeout 60 ms/)
  })

  test('timeout rispettato anche quando TUTTE le fonti sono bloccate', async () => {
    const started = process.hrtime.bigint()
    await assert.rejects(
      () =>
        resolveSeries({
          title: 'x',
          timeoutMs: 60,
          sources: [
            { id: 's1', label: 'S1', instance: { single: () => new Promise(() => {}) } },
            { id: 's2', label: 'S2', instance: { single: () => new Promise(() => {}) } }
          ]
        }),
      /timeout 60 ms/
    )
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
    assert.ok(elapsedMs < 3000, `sono passati ${elapsedMs.toFixed(0)} ms invece di ~60`)
  })

  test('titolo vuoto -> [] senza throw e senza toccare le fonti', async () => {
    let called = 0
    const sources = [
      {
        id: 'a',
        label: 'A',
        instance: {
          single: async () => {
            called++
            return []
          }
        }
      }
    ]

    assert.deepEqual(await resolveSeries({ title: '   ' }), [])
    assert.deepEqual(await resolveSeries({}), [])
    assert.deepEqual(await resolveSeries(), [])
    assert.equal(called, 0)
  })

  test('sources vuoto -> [] e sources sconosciuta -> TypeError', async () => {
    assert.deepEqual(await resolveSeries({ title: 'x', sources: [] }), [])
    await assert.rejects(() => resolveSeries({ title: 'x', sources: ['non-esiste'] }), /fonte sconosciuta/)
    await assert.rejects(() => resolveSeries({ title: 'x', sources: 'animeworld' }), TypeError)
    await assert.rejects(() => resolveSeries({ title: 'x', sources: [{}] }), TypeError)
  })

  test('sources come subset di id risolve alle istanze reali', () => {
    assert.equal(getSource('animeworld'), animeworld)
    assert.equal(getSource('animesaturn'), animesaturn)
    assert.equal(getSource('animeunity'), animeunity)
    assert.equal(getSource('non-esiste'), undefined)
    assert.equal(getSource('  AnimeUnity  '), animeunity, 'gli id sono normalizzati')
  })
})

describe('resolveMovie()', () => {
  test('usa movie() quando la fonte ce l\'ha', async () => {
    const seen = []
    const streams = await resolveMovie({
      title: 'Akira',
      sources: [
        {
          id: 'animesaturn',
          label: 'AnimeSaturn',
          instance: {
            single: async () => [row('Akira [AS]', 'https://a.example/akira.mp4')],
            movie: async (q) => (seen.push(q), [row('Akira ITA [AS]', 'https://a.example/akira-movie.mp4')])
          }
        }
      ]
    })

    assert.deepEqual(seen, [{ titles: ['Akira'] }])
    assert.deepEqual(streams, [
      { name: 'AnimeSaturn', title: 'Akira ITA', url: 'https://a.example/akira-movie.mp4', source: 'animesaturn' }
    ])
  })

  test('senza movie() cade su single({ titles, episode: 1 })', async () => {
    const seen = []
    const streams = await resolveMovie({
      title: 'Akira',
      sources: [
        {
          id: 'custom',
          label: 'Custom',
          instance: {
            single: async (q) => {
              seen.push(q)
              return [row('Akira - Ep 1', 'https://c.example/akira.mp4')]
            }
          }
        }
      ]
    })

    assert.deepEqual(seen, [{ titles: ['Akira'], episode: 1 }])
    assert.equal(streams.length, 1)
  })

  test('array vuoto su tutte -> []; tutte in errore -> throw aggregato', async () => {
    assert.deepEqual(await resolveMovie({ title: 'Akira', sources: [stub('a', () => []), stub('b', () => [])] }), [])

    await assert.rejects(
      () =>
        resolveMovie({
          title: 'Akira',
          sources: [
            { id: 'a', label: 'A', instance: { movie: http500('a') } },
            { id: 'b', label: 'B', instance: { movie: http500('b') } }
          ]
        }),
      (error) => {
        assert.match(error.message, /Akira/)
        assert.match(error.message, /2\/2/)
        return true
      }
    )
  })
})