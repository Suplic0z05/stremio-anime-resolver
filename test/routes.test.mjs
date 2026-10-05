/**
 * test/routes.test.mjs
 *
 * `node:test` + `node:assert/strict`. Nessuna rete, nessun import dei moduli
 * reali (`src/kitsu.js`, `src/resolver.js`): tutte le dipendenze sono finite,
 * perche' le route le ricevono per iniezione.
 *
 * I test passano un oggetto `req` finto (`{ method, url, headers }`) e NON
 * passano `res`: gli handler sono `async (req, res)` ma `res` e' opzionale e,
 * quando assente, l'handler restituisce l'envelope `{ status, body, headers }`.
 * Cosi' si verifica l'header CORS (`headers`) senza aprire una porta.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MANIFEST,
  parseVideoId,
  parseMetaId,
  episodeNumberFromVideoId,
  sortStreamsByQuality,
  normalizeStreams,
  withTimeout,
  TimeoutError,
} from '../src/manifest.js';
import { createManifestRoute } from '../src/manifest.js';
import { createCatalogRoute, toMetaSummary } from '../src/routes/catalog.js';
import { createMetaRoute } from '../src/routes/meta.js';
import { createStreamRoute } from '../src/routes/stream.js';
import { holdLoop } from '../test-helpers/hold-loop.mjs';

// Il guard di `withTimeout` e' `unref()` per contratto (vedi piu' sotto: e' esattamente
// la proprieta' che quel blocco di test dimostra), quindi da solo NON tiene vivo
// il ciclo degli eventi; in produzione a tenerlo aperto e' il socket del server. Un
// file di test non ha un ascolto e quindi deve fornire l'equivalente esplicitamente:
// senza questo, `withTimeout(new Promise(() => {}), 30_000)` non si assesta mai, la
// scadenza non arriva mai e `node:test` cancella il resto del file con `# fail 0`.
//
// Il guard di `raceTimeout` in `src/resolver.js` tiene invece il timer
// REFERENZIATO, e non e' quello che questa pompa sostituisce: quel file lo
// dimostra con processi figli, che non importano questo helper.
//
// La pompa non si propaga ai processi figli: il figlio lanciato piu' sotto importa
// solo `src/manifest.js`, quindi "il guard NON tiene aperto il PROCESSO" resta vero
// anche con questo `before` attivo qui.
//
// NOTA: la pompa usa `setImmediate` e NON `setTimeout`, perche' un timer pendente
// compare in `getActiveResourcesInfo()` come 'Timeout' e falserebbe `countHoldingTimers`.
let releaseLoop = null;
before(() => {
  releaseLoop = holdLoop();
});
after(() => {
  releaseLoop?.();
  releaseLoop = null;
});

// ---------------------------------------------------------------------------
// Finte
// ---------------------------------------------------------------------------

const req = (url, method = 'GET') => ({ method, url, headers: { host: 'localhost' } });

function fakeKitsu({ searchResults = [], metaData = null } = {}) {
  const calls = { search: [], meta: [] };
  return {
    calls,
    async search(query, opts) {
      calls.search.push({ query, opts });
      return searchResults;
    },
    async meta(id) {
      calls.meta.push(id);
      return metaData;
    },
  };
}

function fakeResolver({ series = [], movie = [] } = {}) {
  const calls = { series: [], movie: [] };
  return {
    calls,
    async resolveSeries(args) {
      calls.series.push(args);
      return series;
    },
    async resolveMovie(args) {
      calls.movie.push(args);
      return movie;
    },
  };
}

const NARUTO_META = {
  id: '12',
  type: 'series',
  name: 'Naruto',
  poster: 'https://img/poster.jpg',
  background: 'https://img/bg.jpg',
  description: 'Un ninja.',
  year: 2002,
  genres: ['Action', 'Adventure'],
  episodes: [
    { number: 1, title: 'Dekimasu! Naruto!!', aired: '2002-10-03' },
    { number: 954, title: 'Episodio 954', aired: '2017-03-28' },
  ],
};

// ---------------------------------------------------------------------------
// Aiutanti per i test di uscita del processo (vedi `withTimeout`)
// ---------------------------------------------------------------------------

const MANIFEST_MODULE_URL = new URL('../src/manifest.js', import.meta.url).href;

/**
 * Attende `ms` millisecondi REALI tenendo vivo il loop event SENZA tenere un
 * timer pendente.
 *
 * Non si usa `setTimeout` di proposito: un `setTimeout` pendente viene riportato
 * da `getActiveResourcesInfo()` come 'Timeout', quindi dormire con uno
 * mascherebbe esattamente il conteggio che il test vuole misurare.
 * `setImmediate` viene riportato come 'Immediate', e ogni giro attraversa tutte
 * le fasi del loop, quindi i timer in scadenza vengono davvero eseguiti mentre
 * si gira.
 */
const spinPast = async (ms) => {
  const until = performance.now() + ms;
  while (performance.now() < until) await new Promise((r) => setImmediate(r));
};

/** Numero di timer che TIENO APERTO il processo, secondo l'API di Node. */
const countHoldingTimers = () =>
  process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

/**
 * Aspetta che `predicate()` diventi vera, o che scada il termine.
 * @returns {Promise<boolean>} `true` se la condizione e' diventata vera.
 */
const waitUntil = async (predicate, deadlineAt) => {
  while (!predicate()) {
    if (Date.now() > deadlineAt) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
  return true;
};

// ---------------------------------------------------------------------------

describe('manifest', () => {
  test('ha idPrefixes ["ku"] e i 3 resources', () => {
    assert.deepEqual(MANIFEST.idPrefixes, ['ku']);
    assert.deepEqual(MANIFEST.resources, ['catalog', 'meta', 'stream']);
  });

  test('non dichiara tt e non forza il player esterno', () => {
    assert.equal(MANIFEST.idPrefixes.includes('tt'), false);
    // `behaviorHints.ingest` degraderebbe il risultato spingendo fuori l'app.
    assert.equal(MANIFEST.behaviorHints.ingest, undefined);
    assert.equal(MANIFEST.behaviorHints.configurable, false);
  });

  test('espone il catalogo anime/kitsu-anime', () => {
    // `extra` non e' un extra: e' la DICHIARAZIONE al client che questo catalogo
    // accetta `search` (`?search=` e il path segment `/search=<x>.json`). Senza
    // la dichiarazione il client non chiede mai la ricerca, e con ~22k titoli e
    // 20 per pagina la ricerca e' l'unico modo per raggiungere il resto. Se la
    // proiezione del catalogo cambia, questa aspettativa e' il posto che lo
    // dichiara: la stessa cosa vale in `src/manifest.js`, dove `extra` e'
    // commentato.
    assert.deepEqual(MANIFEST.catalogs, [
      {
        type: 'anime',
        id: 'kitsu-anime',
        name: 'Anime (Kitsu)',
        extra: [{ name: 'search', isRequired: false }],
      },
    ]);
    assert.equal(MANIFEST.id, 'com.suplic0z.stremio-anime-resolver');
    assert.equal(typeof MANIFEST.logo, 'string');
    assert.equal(typeof MANIFEST.background, 'string');
  });

  test('la rotta manifest risponde 200 con CORS', async () => {
    const out = await createManifestRoute()(req('/manifest.json'));
    assert.equal(out.status, 200);
    assert.equal(out.body.idPrefixes[0], 'ku');
    assert.equal(out.headers['Access-Control-Allow-Origin'], '*');
  });
});

describe('catalog', () => {
  test('mappa i risultati in metas con id ku:<id>', async () => {
    const kitsu = fakeKitsu({
      searchResults: [
        { kitsuId: '12', slug: 'naruto', type: 'series', title: 'Naruto', year: 2002, poster: 'p', episodeCount: 220 },
        { kitsuId: '1376', slug: 'bleach', type: 'series', title: 'Bleach', year: 2004, poster: 'q', episodeCount: null },
      ],
    });
    const out = await createCatalogRoute({ kitsu })(req('/catalog/anime/kitsu-anime/search.json?search=na'));
    assert.equal(out.status, 200);
    assert.equal(out.body.metas.length, 2);
    assert.equal(out.body.metas[0].id, 'ku:12');
    assert.equal(out.body.metas[0].name, 'Naruto');
    assert.equal(out.body.metas[0].year, 2002);
    // episodeCount null non deve diventare un numero fisso
    assert.equal(out.body.metas[1].id, 'ku:1376');
    assert.equal(String(out.body.metas[1].description).includes('episodi'), false);
    assert.equal(kitsu.calls.search[0].query, 'na');
    assert.equal(kitsu.calls.search[0].opts.limit > 0, true);
  });

  test('ricerca vuota -> 200 con metas vuoto (non 404, non {})', async () => {
    const kitsu = fakeKitsu({ searchResults: [] });
    const out = await createCatalogRoute({ kitsu })(req('/catalog/anime/kitsu-anime/search.json?search='));
    assert.equal(out.status, 200);
    assert.deepEqual(out.body, { metas: [] });
  });

  test('id del catalogo sbagliato -> 404 con CORS', async () => {
    const kitsu = fakeKitsu({ searchResults: [] });
    const out = await createCatalogRoute({ kitsu })(req('/catalog/anime/altro/search.json'));
    assert.equal(out.status, 404);
    assert.equal(out.headers['Access-Control-Allow-Origin'], '*');
  });

  test('toMetaSummary non espone episodeCount null come numero', () => {
    const meta = toMetaSummary({ kitsuId: '1', type: 'series', title: 'X', year: null, poster: null, episodeCount: null });
    assert.equal(meta.description, null);
    assert.equal(meta.year, null);
    assert.deepEqual(meta.genres, []);
  });
});

describe('meta', () => {
  test('produce videos[].id ku:<id>:<n> con episode = numero assoluto', async () => {
    const kitsu = fakeKitsu({ metaData: NARUTO_META });
    const out = await createMetaRoute({ kitsu })(req('/meta/series/ku:12.json'));

    assert.equal(out.status, 200);
    assert.equal(out.body.meta.id, 'ku:12');
    assert.equal(out.body.meta.type, 'series');
    assert.equal(out.body.meta.name, 'Naruto');
    assert.deepEqual(out.body.meta.genres, ['Action', 'Adventure']);
    assert.equal(kitsu.calls.meta[0], '12');

    const videos = out.body.meta.videos;
    assert.equal(videos.length, 2);
    assert.equal(videos[0].id, 'ku:12:1');
    assert.equal(videos[0].episode, 1);
    // 954 e' il numero ASSOLUTO: 954 nell'id e 954 in `episode`, mai 21.
    assert.equal(videos[1].id, 'ku:12:954');
    assert.equal(videos[1].episode, 954);
    assert.equal(videos[1].episode, Number(videos[1].id.split(':')[2]));
    // nessun partizionamento: l'id resta l'unica fonte di verita
    assert.equal(videos[1].season, null);
    assert.equal(videos[1].released, '2017-03-28');
  });

  test('i video sono ordinati per numero', async () => {
    const kitsu = fakeKitsu({
      metaData: { ...NARUTO_META, episodes: [{ number: 5 }, { number: 2 }, { number: 1 }] },
    });
    const out = await createMetaRoute({ kitsu })(req('/meta/series/ku:12.json'));
    assert.deepEqual(out.body.meta.videos.map((v) => v.episode), [1, 2, 5]);
  });

  test('episodi con numero non valido vengono scartati', async () => {
    const kitsu = fakeKitsu({
      metaData: { ...NARUTO_META, episodes: [{ number: 0 }, { number: -3 }, { number: 4 }, { number: null }] },
    });
    const out = await createMetaRoute({ kitsu })(req('/meta/series/ku:12.json'));
    assert.deepEqual(out.body.meta.videos.map((v) => v.id), ['ku:12:4']);
  });

  test('id non conforme -> 404, non 500', async () => {
    const kitsu = fakeKitsu({ metaData: NARUTO_META });
    const out = await createMetaRoute({ kitsu })(req('/meta/series/ku:12:954.json'));
    assert.equal(out.status, 404);
    assert.equal(out.headers['Access-Control-Allow-Origin'], '*');
  });

  test('kitsu assente -> 404 senza stack trace', async () => {
    const kitsu = fakeKitsu({ metaData: null });
    const out = await createMetaRoute({ kitsu })(req('/meta/series/ku:12.json'));
    assert.equal(out.status, 404);
    assert.equal(typeof out.body.error, 'string');
  });

  test('errore di kitsu -> 500 con corpo minimale', async () => {
    const kitsu = fakeKitsu();
    kitsu.meta = async () => {
      throw new Error('boom: /home/utente/segreto/trace.js:12');
    };
    const out = await createMetaRoute({ kitsu })(req('/meta/series/ku:12.json'));
    assert.equal(out.status, 500);
    assert.deepEqual(out.body, { error: 'internal error' });
    assert.equal(out.payload.includes('segreto'), false);
    assert.equal(out.payload.includes('at '), false);
  });
});

describe('stream', () => {
  test("ku:12:954 passa episode === 954 (non 1, non 21)", async () => {
    const resolver = fakeResolver({ series: [{ name: 'S', title: 'T', url: 'https://cdn/954.m3u8', source: 's1' }] });
    const out = await createStreamRoute({ resolver })(
      req('/stream/series/ku:12:954.json?title=Naruto'),
    );

    assert.equal(out.status, 200);
    assert.equal(resolver.calls.series.length, 1);
    const args = resolver.calls.series[0];
    assert.equal(args.episode, 954);
    assert.notEqual(args.episode, 1);
    assert.notEqual(args.episode, 21);
    assert.equal(args.title, 'Naruto');
    assert.deepEqual(Object.keys(args).sort(), ['episode', 'title']);
    // Proiezione `normalizeStreams()`: `description`, non `title`. Il tipo
    // `Stream` di Stremio non ha `title` -- e' un alias deprecato a favore di
    // `description` -- quindi la chiave vecchia non viene piu' emessa.
    // `behaviorHints` e' ASSENTE perche' questa riga non dichiara nessuna
    // variante: non viene emesso `{bingeGroup: undefined}` ne' un gruppo
    // `unknown` inventato. `source` resta presente con valore `undefined`,
    // cioe' il comportamento di prima, e `deepStrictEqual` distingue la chiave
    // presente con `undefined` dalla chiave assente.
    assert.deepEqual(out.body.streams, [
      { name: 'S', description: 'T', url: 'https://cdn/954.m3u8', source: 's1' },
    ]);
  });

  test("l'id dell'URL NON finisce in bingeGroup, e non diventa un campo", async () => {
    // La rotta ha l'id validato (`rawId`) e NON lo passa alla proiezione, di
    // voluta: vedi `due episodi diversi danno lo stesso bingeGroup` per la prova
    // del motivo.
    const resolver = fakeResolver({
      series: [
        { name: 'AnimeUnity', title: 'Dekimasu! Naruto!!', url: 'https://cdn/1080p.mkv', source: 'animeunity', variant: 'dub' },
      ],
    });
    const out = await createStreamRoute({ resolver })(
      req('/stream/series/ku:12:1.json?title=Naruto'),
    );

    const [stream] = out.body.streams;
    assert.deepEqual(stream.behaviorHints, { bingeGroup: 'animeunity-ita-dub' });
    assert.equal(stream.behaviorHints.bingeGroup.includes('ku:12:1'), false);
    assert.equal(stream.description, 'ITA DUB — Dekimasu! Naruto!!');
    // La proiezione resta a 4 campi + behaviorHints: l'id non viaggia ne' dentro
    // la stringa del gruppo ne' come `videoId`, che il protocollo non definisce.
    assert.deepEqual(Object.keys(stream).sort(), [
      'behaviorHints',
      'description',
      'name',
      'source',
      'url',
    ]);
    assert.equal('videoId' in stream, false);
  });

  test('lo stesso per un film: nessun id nel gruppo, nessun episodio inventato', async () => {
    const resolver = fakeResolver({
      movie: [
        { name: 'AnimeSaturn', title: 'One Piece Movie 15', url: 'https://cdn/x_Full_HD.mkv', source: 'animesaturn', variant: 'sub' },
      ],
    });
    const out = await createStreamRoute({ resolver })(req('/stream/movie/ku:12.json?title=One%20Piece'));

    // Il gruppo di un film e' costruito come quello di un episodio: la proiezione
    // non sa e non deve sapere quale delle due forme di id abbia ricevuto, e
    // soprattutto non vi mette dentro `ku:12`.
    assert.deepEqual(out.body.streams[0].behaviorHints, {
      bingeGroup: 'animesaturn-ita-sub',
    });
  });

  test('due episodi diversi danno lo stesso bingeGroup (regressione binge)', async () => {
    // QUESTO TEST E' LA RAGIONE PER CUI NON SI METTE L'ID NEL GRUPPO.
    //
    // Il motore di Stremio (`stremio-core/src/types/resource/stream.rs`,
    // `is_binge_match`) confronta i due `binge_group` con `a == b`, e lo fa in
    // `player.rs::next_stream_update` fra lo stream scelto dell'episodio
    // CORRENTE e la lista dell'episodio SUCCESSIVO. Il suo test ufficiale
    // (`unit_tests/player/next_stream.rs`) serve due id diversi (`tt123456:1:2` e
    // `tt123456:1:3`) con gli stessi valori letterali e asserisce il match.
    //
    // Quindi un gruppo per-episodio rende `a == b` irraggiungibile e il binge si
    // spegne in silenzio: nessun errore, autoplay semplicemente non prosegue.
    //
    // Le due richieste passano dalla ROTTA, che e' il posto dove l'id e'
    // disponibile: se qualcuno lo reintroduce qui dentro, questo test fallisce.
    const rispostaPer = async (id) => {
      const resolver = fakeResolver({
        series: [
          { name: 'AnimeUnity', title: 'Naruto', url: 'https://cdn/dub.mkv', source: 'animeunity', variant: 'dub' },
        ],
      });
      const out = await createStreamRoute({ resolver })(req(`/stream/series/${id}.json?title=Naruto`));
      assert.equal(out.status, 200, id);
      return out.body.streams[0].behaviorHints.bingeGroup;
    };

    const ep1 = await rispostaPer('ku:12:1');
    const ep954 = await rispostaPer('ku:12:954');
    const ep2 = await rispostaPer('ku:12:2');

    // Stessa sorgente e stessa variante -> STESSO gruppo, anche a 954 episodi di
    // distanza. E' la condizione che il motore deve poter soddisfare.
    assert.equal(ep1, 'animeunity-ita-dub');
    assert.equal(ep954, ep1);
    assert.equal(ep2, ep1);

    // Il gruppo non contiene traccia del video: nessun id, nessun prefisso che
    // possa coincidere con l'id richiesto.
    for (const group of [ep1, ep2, ep954]) {
      assert.equal(group.includes('ku:12'), false, group);
    }
  });

  test('parseVideoId distingue il numero assoluto e rifiuta 0', () => {
    assert.deepEqual(parseVideoId('ku:12:954'), { kitsuId: '12', number: 954 });
    assert.equal(parseVideoId('ku:12:1').number, 1);
    assert.equal(parseVideoId('ku:12:0'), null);
    assert.equal(parseVideoId('ku:12:-1'), null);
    assert.equal(parseVideoId('ku:12'), null);
    assert.equal(parseVideoId('tt0388629:21:1'), null);
    assert.equal(episodeNumberFromVideoId('ku:12:954'), 954);
    assert.equal(episodeNumberFromVideoId('ku:12'), null);
  });

  test('parseMetaId/parseVideoId rifiutano anche un kitsuId non numerico', () => {
    // `ku:abc` non deve mai raggiungere Kitsu: a monte risponderebbe 400, e
    // senza questa guardia un id malformato arriverebbe al client come 500
    // dell'addon invece che come 404, cioe' come un guasto di chi serve.
    for (const bad of [
      'ku:abc', 'ku:abc:5', 'ku:0', 'ku:0:5', 'ku:12.5', 'ku:12.5:5',
      'ku:-3', 'ku:-3:5', 'ku:', 'ku:1e3', 'ku: 12', 'ku:12 :5', 'ku:+12',
    ]) {
      assert.equal(parseMetaId(bad), null, bad);
      assert.equal(parseVideoId(bad), null, bad);
    }
    // Gli id validi continuano a funzionare e `kitsuId` resta stringa: e' il
    // contratto che `kitsu.js` e le fixture si scambiano gia' da prima.
    assert.deepEqual(parseMetaId('ku:12'), { kitsuId: '12' });
    assert.deepEqual(parseVideoId('ku:12:954'), { kitsuId: '12', number: 954 });
  });

  test('400/404 a monte -> 404, ma un 5xx resta 500 (un outage deve restare visibile)', async () => {
    const throwing = (status) => ({
      async search() { return []; },
      async meta() {
        const err = new Error(`GET https://kitsu.io -> HTTP ${status}`);
        err.status = status;
        throw err;
      },
    });

    // `ku:abc` non arriva nemmeno a Kitsu: validazione prima della rete.
    const calls = [];
    for (const url of ['/meta/series/ku:abc.json', '/stream/series/ku:abc:5.json']) {
      const kitsu = {
        calls,
        async search() { return []; },
        async meta(id) { calls.push(id); return null; },
      };
      const out = url.includes('/meta/')
        ? await createMetaRoute({ kitsu })(req(url))
        : await createStreamRoute({ kitsu, resolver: fakeResolver() })(req(url));
      assert.equal(out.status, 404, url);
      assert.equal(out.headers['Access-Control-Allow-Origin'], '*', url);
    }
    assert.equal(calls.length, 0, 'nessuna richiesta a Kitsu per un id malformato');

    // Id inesistente: Kitsu risponde 404, non e' un errore dell'addon.
    for (const status of [400, 404]) {
      const meta = await createMetaRoute({ kitsu: throwing(status) })(req('/meta/series/ku:12.json'));
      assert.equal(meta.status, 404, `meta ${status}`);
      assert.deepEqual(meta.body, { error: 'not found' }, `meta ${status}`);
      assert.equal(meta.headers['Access-Control-Allow-Origin'], '*', `meta ${status}`);

      const stream = await createStreamRoute({ kitsu: throwing(status), resolver: fakeResolver() })(
        req('/stream/series/ku:12:954.json'),
      );
      assert.equal(stream.status, 404, `stream ${status}`);
      // La risorsa stream ha un corpo 404 suo: `{"streams":[]}` e non un errore.
      assert.deepEqual(stream.body, { streams: [] }, `stream ${status}`);
    }

    // Kitsu e' giuro': resta 500. Mappare un outage su 404 lo nasconderebbe
    // dietro un catalogo vuoto, che e' il fallimento peggiore di tutti.
    for (const status of [500, 503]) {
      const meta = await createMetaRoute({ kitsu: throwing(status) })(req('/meta/series/ku:12.json'));
      assert.equal(meta.status, 500, `meta ${status}`);
      const stream = await createStreamRoute({ kitsu: throwing(status), resolver: fakeResolver() })(
        req('/stream/series/ku:12:954.json'),
      );
      assert.equal(stream.status, 500, `stream ${status}`);
    }
  });

  test('senza ?title fa un solo lookup su kitsu e usa il nome', async () => {
    const kitsu = fakeKitsu({ metaData: NARUTO_META });
    const resolver = fakeResolver({ series: [] });
    const out = await createStreamRoute({ kitsu, resolver })(req('/stream/series/ku:12:954.json'));
    assert.equal(out.status, 200);
    assert.equal(kitsu.calls.meta.length, 1);
    assert.equal(kitsu.calls.meta[0], '12');
    assert.equal(resolver.calls.series[0].title, 'Naruto');
    assert.equal(resolver.calls.series[0].episode, 954);
  });

  test('movie -> resolveMovie e mai resolveSeries', async () => {
    const resolver = fakeResolver({ movie: [{ name: 'M', title: 'F', url: 'https://cdn/m.mp4' }] });
    const out = await createStreamRoute({ resolver })(req('/stream/movie/ku:12.json?title=Deadline'));
    assert.equal(out.status, 200);
    assert.equal(resolver.calls.movie.length, 1);
    assert.equal(resolver.calls.series.length, 0);
    assert.equal(resolver.calls.movie[0].title, 'Deadline');
  });

  test('id malformati -> 404 con {"streams":[]}', async () => {
    const resolver = fakeResolver({ series: [{ name: 'S', title: 'T', url: 'https://cdn/x.m3u8' }] });
    const route = createStreamRoute({ resolver });
    for (const url of [
      '/stream/series/ku:12.json',        // manca il numero
      '/stream/series/ku12:954.json',     // prefisso assente
      '/stream/series/ku:12:abc.json',    // non intero
      '/stream/series/ku:12:0.json',      // sotto il minimo
      '/stream/series/tt0388629:21:1.json',
      '/stream/serie/ku:12:954.json',     // tipo ignoto
      '/stream/movie/ku:12:5.json',       // movie non accetta un episodio
    ]) {
      const out = await route(req(url));
      assert.equal(out.status, 404, url);
      assert.deepEqual(out.body, { streams: [] }, url);
      assert.equal(out.headers['Access-Control-Allow-Origin'], '*', url);
    }
    // nessuna chiamata al resolver: la validazione avviene prima
    assert.equal(resolver.calls.series.length, 0);
  });

  test('errore del resolver -> 500 senza stack trace nel corpo', async () => {
    const resolver = fakeResolver();
    resolver.resolveSeries = async () => {
      throw new Error('ECONNREFUSED 10.0.0.5:8080 at resolve (/srv/secret/stream.js:44:9)');
    };
    const out = await createStreamRoute({ resolver })(req('/stream/series/ku:12:954.json?title=Naruto'));
    assert.equal(out.status, 500);
    assert.deepEqual(out.body, { error: 'internal error' });
    assert.equal(out.payload.includes('10.0.0.5'), false);
    assert.equal(out.payload.includes('/srv/secret'), false);
    assert.equal(out.payload.includes('\n    at '), false);
  });

  test('timeout di una dipendenza -> 504 esplicito', async () => {
    const resolver = fakeResolver();
    resolver.resolveSeries = () => new Promise(() => {});
    const out = await createStreamRoute({ resolver, timeoutMs: 20 })(
      req('/stream/series/ku:12:954.json?title=Naruto'),
    );
    assert.equal(out.status, 504);
    assert.deepEqual(out.body, { error: 'upstream timeout' });
  });

  test('con timeout 20ms una risposta lenta non viene tagliata', async () => {
    const resolver = fakeResolver({ series: [{ name: 'S', title: 'T', url: 'https://cdn/ok.m3u8' }] });
    resolver.resolveSeries = async (args) => {
      await new Promise((r) => setTimeout(r, 5));
      return [{ name: 'S', title: 'T', url: 'https://cdn/ok.m3u8' }];
    };
    const out = await createStreamRoute({ resolver, timeoutMs: 500 })(
      req('/stream/series/ku:12:954.json?title=Naruto'),
    );
    assert.equal(out.status, 200);
    assert.equal(out.body.streams.length, 1);
  });

  test('risposta del resolver non e\' un array -> streams vuoto, non crash', async () => {
    const resolver = fakeResolver();
    resolver.resolveSeries = async () => null;
    const out = await createStreamRoute({ resolver })(req('/stream/series/ku:12:1.json?title=X'));
    assert.equal(out.status, 200);
    assert.deepEqual(out.body, { streams: [] });
  });
});

describe('ordinamento e normalizzazione stream', () => {
  test('ordina per qualita\' decrescente quando il dato c\'e\'', () => {
    const sorted = sortStreamsByQuality([
      { name: 'low', quality: '480p', url: 'https://a/1.m3u8' },
      { name: 'high', quality: '1080p', url: 'https://a/2.m3u8' },
      { name: 'mid', resolution: '720', url: 'https://a/3.m3u8' },
    ]);
    assert.deepEqual(sorted.map((s) => s.name), ['high', 'mid', 'low']);
  });

  test('senza qualita\' dichiarata l\'ordine delle fonti resta invariato', () => {
    // Gli URL qui NON contengono marche di qualita'. Non e' piu' un caso
    // "senza qualita' in assoluto": `streamQualityHeight` legge anche l'URL come
    // ultima risorsa, quindi un `/1.m3u8` continua a valere 0 e l'ordine delle
    // fonti resta quello in cui sono arrivate.
    const input = [
      { name: 'a', url: 'https://a/1.m3u8' },
      { name: 'b', url: 'https://a/2.m3u8' },
    ];
    assert.deepEqual(sortStreamsByQuality(input).map((s) => s.name), ['a', 'b']);
  });

  test('un numero nudo in name non viene scambiato per una qualita\'', () => {
    // "Episodio 954" non e' un 1080p: nel testo libero si accettano solo forme
    // QUALIFICATE (`1920x1080`, `1080p`), mai un numero nudo. Nell'URL il numero
    // nudo e' accettato ma solo come token delimitato da caratteri non
    // alfanumerici: `episodio-954` e' un id, `/720/` e' una qualita' dichiarata.
    const sorted = sortStreamsByQuality([
      { name: 'episodio 954', url: 'https://a/1.m3u8' },
      { name: 'basso', quality: '360p', url: 'https://a/2.m3u8' },
    ]);
    assert.deepEqual(sorted.map((s) => s.name), ['basso', 'episodio 954']);
  });

  test('estrae l\'altezza da 1920x1080', () => {
    const sorted = sortStreamsByQuality([
      { name: 'sd', resolution: '640x480', url: 'https://a/1.m3u8' },
      { name: 'fhd', resolution: '1920x1080', url: 'https://a/2.m3u8' },
    ]);
    assert.deepEqual(sorted.map((s) => s.name), ['fhd', 'sd']);
  });

  test('l\'URL e\' l\'unica fonte reale: 720p, _Full_HD, 480, 360p', () => {
    // Nessuno scraper dichiara `height`/`quality`/`resolution`: la qualita' sta
    // nel NOME DEL FILE. Senza questo passaggio ogni riga valeva 0 e la suite
    // passava senza mai verificare un ordinamento vero.
    const sorted = sortStreamsByQuality([
      { name: 'a-360', url: 'https://cdn/a/360p.mkv' },
      { name: 'b-480', url: 'https://cdn/b/480.mkv' },
      { name: 'c-fullhd', url: 'https://cdn/One_Piece_Full_HD/1.m3u8' },
      { name: 'd-720', url: 'https://cdn/d/720p.mkv' },
      { name: 'e-1080', url: 'https://cdn/e/1080p.mkv' },
      { name: 'f-fullhd', url: 'https://cdn/f/FullHD.mkv' },
    ]);
    assert.deepEqual(sorted.map((s) => s.name), [
      'c-fullhd', 'e-1080', 'f-fullhd', 'd-720', 'b-480', 'a-360',
    ]);
  });

  test('un campo dichiarato non viene MAI sovrascritto dall\'URL', () => {
    // Precedenza: campo > testo > URL. Se l'URL vincesse, una fonte che dichiara
    // `quality: 480p` su un file chiamato `1080p` verrebbe riproiettata a 1080:
    // un'informazione affermata verrebbe sostituita da un fiuto.
    const sorted = sortStreamsByQuality([
      { name: 'dichiarato-480', quality: '480p', url: 'https://cdn/1080p.mkv' },
      { name: 'solo-url-720', url: 'https://cdn/720p.mkv' },
      { name: 'esplicito-0', height: 0, url: 'https://cdn/1080p.mkv' },
    ]);
    assert.deepEqual(sorted.map((s) => s.name), ['solo-url-720', 'dichiarato-480', 'esplicito-0']);
  });

  test('un numero dentro un token firmato non e\' una qualita\'', () => {
    // La query porta i token degli scraperi: `abc480def` contiene 480 ma non
    // dichiara niente, quindi 0. Nel path la stessa forma vale 0 per lo stesso
    // motivo (`ep720def` e' un identificatore).
    const sorted = sortStreamsByQuality([
      { name: 'token', url: 'https://cdn/x.mkv?sig=abc480def' },
      { name: 'id', url: 'https://cdn/ep720def/x.mkv' },
      { name: 'dichiarato', quality: '480p', url: 'https://cdn/y.mkv' },
    ]);
    assert.deepEqual(sorted.map((s) => s.name), ['dichiarato', 'token', 'id']);
  });

  test('scarta gli stream senza url', () => {
    assert.deepEqual(normalizeStreams([{ name: 'x' }, null, { name: 'y', url: 'https://a/1.m3u8' }]), [
      // `description` prende il `name` perche' la riga non ha `title`. La
      // stringa non e' mai vuota: una riga senza etichetta e' indistinguibile da
      // una riga troncata.
      { name: 'y', description: 'y', url: 'https://a/1.m3u8', source: undefined },
    ]);
  });

  test('la variante finisce in description e in behaviorHints.bingeGroup', () => {
    // `bingeGroup` e' l'unico canale che un client puo' leggere senza fare
    // parsing del testo: e' il gruppo su cui Stremio fa binge/autoplay. Senza di
    // esso, dub e sub sono indistinguibili per una macchina.
    //
    // La `description` non e' piu' SOLO la label: e' `label — titolo`, perche' il
    // titolo dell'episodio che la fonte aveva portato era informazione che il
    // resolver aveva gia' ripulito e che veniva buttata via.
    const [dub, sub] = normalizeStreams([
      { name: 'AnimeUnity', title: 'One Piece 1080p', url: 'https://cdn/du/1080p.mkv', source: 'animeunity', variant: 'dub' },
      { name: 'AnimeWorld', title: 'One Piece', url: 'https://cdn/su/720p.mkv', source: 'animeworld', variant: 'sub' },
    ]);

    assert.equal(dub.description, 'ITA DUB — One Piece 1080p');
    assert.equal(sub.description, 'ITA SUB — One Piece');
    // Il gruppo porta fonte + variante e nient'altro: vedi la regressione binge
    // nella describe `stream`, piu' in alto.
    assert.deepEqual(dub.behaviorHints, { bingeGroup: 'animeunity-ita-dub' });
    assert.deepEqual(sub.behaviorHints, { bingeGroup: 'animeworld-ita-sub' });
    // La macchina non deve percio' distinguere i due casi leggendo `title`.
    assert.equal('title' in dub, false);
  });

  test('senza titolo la catena della description non si interrompe', () => {
    // Titolo assente: la label resta e il dettaglio cade sul `name` (o sul suo
    // fallback). Nessun ramo lascia una stringa vuota o un separatore appeso.
    const [withName, withoutName] = normalizeStreams([
      { name: 'AnimeUnity', url: 'https://cdn/1.mkv', source: 'animeunity', variant: 'dub' },
      { url: 'https://cdn/2.mkv', source: 'animeunity', variant: 'sub' },
    ]);

    assert.equal(withName.description, 'ITA DUB — AnimeUnity');
    assert.equal(withoutName.description, 'ITA SUB — stream');
    assert.equal(withoutName.name, 'stream');

    // Con la variante assente il ramo e' quello di prima: titolo portato, poi
    // `name`. Non e' la label ad aggiungersi da sola.
    const [noVariant] = normalizeStreams([
      { name: 'AnimeSaturn', url: 'https://cdn/x_Full_HD.mkv', source: 'animesaturn' },
    ]);
    assert.equal(noVariant.description, 'AnimeSaturn');
  });

  test('fonte e variante separano ancora i gruppi', () => {
    // Senza l'id del video, il gruppo e' determinato solo da (fonte, variante).
    // La stabilita' fra richieste diverse e' implicita: stessa fonte + stessa variante
    // = stessa stringa. Qui si verifica solo che due varianti diverse o due fonti
    // diverse danno gruppi diversi, dentro lo stesso episodio.
    const group = (source, variant) => normalizeStreams(
      [{ name: 'X', title: 'T', url: 'https://cdn/1.mkv', source, variant }],
    )[0].behaviorHints.bingeGroup;

    assert.equal(group('animeunity', 'dub'), 'animeunity-ita-dub');
    assert.equal(group('animeunity', 'dub'), group('animeunity', 'dub'));
    assert.equal(group('animeunity', 'sub'), group('animeunity', 'sub'));

    // DISTINTO: fonte e variante continuano a separare i gruppi.
    assert.notEqual(group('animeunity', 'dub'), group('animeunity', 'sub'));
    assert.notEqual(group('animeunity', 'dub'), group('animeworld', 'dub'));
  });

  test('senza variante dichiarata behaviorHints e\' ASSENTE, non `unknown`', () => {
    const [row] = normalizeStreams([
      { name: 'AnimeSaturn', title: 'One Piece Movie 15 (ITA)', url: 'https://cdn/x_Full_HD.mkv', source: 'animesaturn' },
    ]);
    assert.equal(row.description, 'One Piece Movie 15 (ITA)');
    assert.equal('behaviorHints' in row, false);
    // E la chiave non e' nemmeno presente con valore `undefined`: un client che
    // fa `'behaviorHints' in stream` deve poter fidarsi del risultato.
    assert.deepEqual(Object.keys(row).sort(), ['description', 'name', 'source', 'url']);
  });

  test('una variante ambigua resta `unknown` e non genera un gruppo', () => {
    // Una riga che dice "dub/sub" NON e' una variante: dichiarare un gruppo per
    // una riga ambigua la metterebbe in un gruppo senza significato.
    const [row] = normalizeStreams([
      { name: 'x', title: 't', url: 'https://a/1.m3u8', source: 's1', variant: 'dub/sub' },
    ]);
    assert.equal('behaviorHints' in row, false);
    assert.equal(row.description, 't');
  });

  test('il sort legge la qualita\' dalla description, e l\'ordine regge senza marker nell\'URL', () => {
    // Prima che la `description` portasse il titolo, una riga la cui qualita' era
    // scritta solo nel titolo restava a 0 e finiva in fondo alla lista. Qui la
    // qualita' vive SOLO nella `description`, e i due URL sono path scelti senza
    // alcun marker: se l'ordine regge, e' la `description` a decidere e non
    // l'URL che pure continua a essere letto come ultima cascata.
    //
    // Si asserisce l'ORDINE e non un `height`: l'ordine e' il contratto che il
    // client vede, mentre il numero interno e' un dettaglio dell'implementazione
    // che puo' cambiare senza che nessuno se ne accorga.
    const rows = normalizeStreams([
      { name: 'basso', title: 'One Piece 480p', url: 'https://cdn/a/video.mkv', source: 'animeunity', variant: 'dub' },
      { name: 'alto', title: 'One Piece 1080p', url: 'https://cdn/b/video.mkv', source: 'animeunity', variant: 'dub' },
    ]);

    assert.deepEqual(sortStreamsByQuality(rows).map((s) => s.name), ['alto', 'basso']);
  });
});

describe('withTimeout', () => {
  test('propaga il valore quando la promessa arriva in tempo', async () => {
    assert.equal(await withTimeout(Promise.resolve(7), 50, 'x'), 7);
  });

  test('rifiuta con TimeoutError quando sfora', async () => {
    await assert.rejects(() => withTimeout(new Promise(() => {}), 10, 'x'), TimeoutError);
  });

// ── USCITA DEL PROCESSO ──────────────────────────────────────────────────────
  // Il test che c'era qui prima contava i timer attivi intorno a una chiamata con
  // budget di 5 ms e chiedeva che il conteggio non fosse cresciuto. Era rotto per
  // tre motivi indipendenti, tutti verificati a misura:
  //
  //   1. un solo `setImmediate` gira nella fase CHECK, che precede la fase
  //      TIMERS: dopo di esso un guard da 5 ms puo' legittimamente non essere
  //      ancora scaduto, e `after` leggeva `before + 1` -- "non scaduto", non una
  //      perdita. Sotto carico (suite intera) i 5 ms non erano passati => FAIL,
  //      da solo => PASS: era flaky per costruzione;
  //   2. `withTimeout` fa `timer.unref()`, e su Node v26.10.0 un timer pending
  //      `unref()` NON compare in `getActiveResourcesInfo()` (misurato: pending
  //      `unref` -> 0, pending REF -> 1, timer gia' scaduto -> 0). L'asserzione
  //      non poteva quindi osservare la proprieta' che dichiarava, e il suo
  //      eventuale fallimento veniva da un timer REF di qualcun altro;
  //   3. fuori da un runner che tiene il loop vivo il test non e' nemmeno
  //      eseguibile: una promessa che non si assesta muore con exit 13.
  //
  // La proprieta' da rimettere al centro: "il ciclo degli eventi puo' drainare,
  // quindi il processo puo' uscire". Non e' cio' che il conteggio dei timer
  // attivi misurava, per i due punti sopra.

  test('il guard NON tiene aperto il loop: un guard armato non e\' fra le risorse attive', async () => {
    // Questa e' la forma DETERMINISTICA della proprieta' e non usa processi:
    // `getActiveResourcesInfo()` elenca i timer che tengono vivo il ciclo degli
    // eventi, e un timer `unref()` non e' tra quelli. Il budget e' di 30 s e il
    // test non dura 30 s, quindi qui "non compare perche' e' gia' scaduto" e'
    // impossibile: l'unica spiegazione del conteggio invariato e' che quel timer
    // non tiene vivo il loop.
    const baseline = countHoldingTimers();

    // La promessa di fondo e' rilasciabile di proposito: cosi' il test puo'
    // finire IL GUARD ED ARMATO (la proprieta' che si misura) e poi chiuderlo,
    // invece di lasciare un timer da 30 s appeso per il resto del file. Un test
    // che sporca il conteggio dei test successivi non sta misurando la
    // proprieta' di `withTimeout`, sta misurando se stesso.
    let release = () => {};
    const payload = new Promise((resolve) => { release = resolve; });
    const guard = withTimeout(payload, 30_000, 'armato');
    guard.catch(() => {});
    try {
      assert.equal(
        countHoldingTimers(),
        baseline,
        'il guard armato compare fra le risorse che tengono vivo il loop',
      );

      // E la prova che il metodo di misura distingue davvero i due casi: qui si
      // rifa lo stesso conteggio con un timer REF, che DEVE comparire. Senza
      // questa riga l'asserzione sopra passerebbe anche se l'API smettesse di
      // elencare qualunque timer, cioe' se misurasse il nulla.
      const refd = setTimeout(() => {}, 30_000);
      assert.equal(
        countHoldingTimers(),
        baseline + 1,
        'un timer REF deve comparire fra le risorse attive: il confronto non misura niente',
      );
      clearTimeout(refd);
      assert.equal(countHoldingTimers(), baseline);
    } finally {
      release(); // la promessa vince: il `.finally(clearTimeout)` gira qui dentro
      await guard;
    }
  });

  test('il guard NON tiene aperto il PROCESSO: il figlio esce da solo', async () => {
    // Perche' serve un PROCESSO FIGLIO e non una chiamata in processo: la
    // proprieta' da dimostrare e' che il ciclo degli eventi puo' DRAINARE. In
    // processo quel ciclo resta vivo perche' lo tiene il runner, quindi "nessun
    // timer che lo blocca" e' letteralmente indistinguibile da "il runner tiene
    // il loop per conto suo". Nel figlio non c'e' nessun altro lavoro da fare:
    // se il guard lo trattenesse, il figlio starebbe vivo per tutto il budget.
    //
    // Il figlio non fa NULLA: arma il guard su una promessa che non si assesta
    // mai, con un budget di 2 minuti, e poi finisce.
    //
    // ── PERCHE' LA COMUNICAZIONE PASSA PER FILE E NON PER LE PIPE ──────────────
    // Il tempo lo misura il FIGLIO, non il padre: l'handler `exit` scrive su disco
    // quanto e' vissuto. Un'asserzione sul tempo visto dal padre sarebbe essa
    // stessa flaky, perche' su questo host l'osservazione della fine di un figlio
    // e' erraticissima: misurati 94 ms, 1.8 s, 2.3 s, 4.9 s, 7.4 s e 8.9 s per
    // `node -e 0`, che dura 1 ms (carico medio 70 su 16 CPU, 3 su 10 usciti puliti).
    // Con `spawnSync` il padre arrivava anche a UCCIDERE un figlio gia' uscito,
    // perdendo la stdout: la lettura del risultato era inaffidabile quanto la
    // misura. Un marker su disco sopravvive a un figlio ucciso e non dipende dal
    // fatto che il padre si accorga dell'uscita.
    //
    // Il padre ha due TERMINI e un `SIGKILL`, e sono due per una ragione precisa:
    // il primo riguarda l'AVVIO del figlio (su questa macchina carica avviare
    // `node` richiede fino a qualche secondo) e il secondo l'USCITA, che una
    // volta armato avviene in millisecondi. Con un unico termine di 30 s la
    // prima meta' delle esecuzioni era a pochi secondi dal fallimento per
    // colpa della macchina; con due finestre l'avvio lento e' tollerato e la
    // regressione vera (il guard che non lascia mai uscire il figlio) viene
    // comunque segnalata in 15 s, invece di restare appesa.
    const budget = 120_000;
    const startDeadlineMs = 30_000;
    const exitDeadlineMs = 15_000;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stremio-exit-'));
    const armedAt = path.join(dir, 'armed');
    const exitedAt = path.join(dir, 'exited');

    const script = [
      `import { writeFileSync } from 'node:fs';`,
      `import { withTimeout } from ${JSON.stringify(MANIFEST_MODULE_URL)};`,
      `const started = performance.now();`,
      // `writeFileSync` e non una scrittura asincrona: dentro l'handler `exit` non
      // si puo' aspettare nessuna promise, quindi una scrittura differita verrebbe
      // persa e il test non potrebbe distinguere "uscito subito" da "uscito
      // tardi". Senza marker l'asserzione fallisce, ed e' la risposta giusta.
      `process.on('exit', () => { try { writeFileSync(${JSON.stringify(exitedAt)}, String(Math.round(performance.now() - started))); } catch { /* niente marker: il test fallisce */ } });`,
      `const guard = withTimeout(new Promise(() => {}), ${budget}, 'never-settles');`,
      `globalThis.__guard = guard;`,
      `writeFileSync(${JSON.stringify(armedAt)}, 'armed');`,
    ].join('\n');

    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    let exit = 'il processo non e\' ancora uscito';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('exit', (code, signal) => { exit = `code=${code} signal=${signal}`; });
    child.on('error', (err) => { exit = `spawn error=${err.code || err.message}`; });

    try {
      assert.ok(
        await waitUntil(() => fs.existsSync(armedAt), Date.now() + startDeadlineMs),
        `il figlio non ha mai armato il guard entro ${startDeadlineMs} ms: ${exit} stderr=${stderr}`,
      );
      assert.ok(
        await waitUntil(() => fs.existsSync(exitedAt), Date.now() + exitDeadlineMs),
        `il figlio doveva uscire da solo entro ${exitDeadlineMs} ms e non e' mai uscito: ` +
        `il guard tiene aperto il processo (${exit}, budget del guard ${budget} ms)`,
      );

      const elapsedMs = Number(fs.readFileSync(exitedAt, 'utf8'));
      assert.ok(
        Number.isFinite(elapsedMs) && elapsedMs < budget / 2,
        `il figlio doveva uscire in meno di ${budget / 2} ms, ne' ha impiegati ${elapsedMs}`,
      );
    } finally {
      child.kill('SIGKILL');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('la clearTimeout del guard viene eseguita quando la promessa vince', async () => {
    // Perche' una spy e non un conteggio: `getActiveResourcesInfo()` NON puo'
    // vedere questa proprieta'. Un timer `unref()` pending non e' fra le risorse
    // attive, quindi togliere `.finally(clearTimeout)` non cambia nessun
    // conteggio -- verificato per mutazione: senza `.finally` tutta questa suite
    // passava 41/41, cioe' la proprieta' di cleanup NON era asserita da nessuna
    // asserzione esistente. Qui si osserva direttamente la chiamata, che e' il
    // percorso che il codice dichiara di eseguire.
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const armed = [];
    const cleared = [];

    globalThis.setTimeout = (...args) => {
      const handle = realSetTimeout(...args);
      armed.push(handle);
      return handle;
    };
    globalThis.clearTimeout = (handle) => {
      cleared.push(handle);
      return realClearTimeout(handle);
    };
    try {
      await withTimeout(Promise.resolve('ok'), 30_000, 'vince');
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }

    assert.ok(armed.length > 0, 'il guard non ha creato nessun timer: la spy non misura niente');
    assert.ok(
      cleared.includes(armed.at(-1)),
      'il timer creato dal guard non e` stato liberato quando la promessa ha vinto',
    );
    assert.deepEqual(
      armed.filter((handle) => !cleared.includes(handle)),
      [],
      'timer armati nella finestra e mai liberati',
    );
  });

  test('nessun timer che blocca l\'uscita resta appeso, vinta o scadenza', async () => {
    // Il percorso `.finally(clearTimeout)` in due tempi.
    //
    // Cosa questa API puo' davvero vedere, misurato su Node v26.10.0 sia fuori
    // dal runner che dentro `node --test`: pending `unref` -> 0, pending REF ->
    // 1, timer GIA' SCADUTO -> 0. Quindi il conteggio vede soltanto un timer che
    // tiene aperto il processo, non un timer qualunque: e' la stessa proprieta'
    // del test precedente, resa osservabile in un solo processo. Non e' una misura
    // della `clearTimeout` in se' -- un timer scaduto sparisce dalla lista comunque
    // -- e per questo il caso (b) asserisce anche che il guard abbia davvero
    // sparato.
    const baseline = countHoldingTimers();

    // (a) Vince la promessa: il timer da 30 s deve essere tolto subito. 30 s e'
    // irraggiungibile dentro un test, quindi qui "non e' ancora scaduto" non e'
    // una spiegazione possibile: o il timer e' stato liberato, o e' ancora li'.
    await withTimeout(Promise.resolve('ok'), 30_000, 'vince').catch(() => {});
    await new Promise((r) => setImmediate(r));
    assert.equal(
      countHoldingTimers(),
      baseline,
      'il timer del guard e` rimasto appeso quando la promessa ha vinto',
    );

    // (b) Il budget scade: si dorme di PAZZA il budget (60 ms contro 5 ms),
    // girando su `setImmediate` per non tenere un timer che mascherebbe il
    // conteggio, e si verifica che il guard abbia sparato e che non sia rimasto
    // nulla appeso.
    let rejection = null;
    withTimeout(new Promise(() => {}), 5, 'scade').catch((err) => { rejection = err; });
    await spinPast(60);
    assert.ok(rejection instanceof TimeoutError, 'il guard doveva scadere: nessun errore osservato');
    assert.equal(
      countHoldingTimers(),
      baseline,
      'il timer del guard e` rimasto appeso dopo lo scadere del budget',
    );
  });
});
