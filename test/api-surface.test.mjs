/**
 * test/api-surface.test.mjs
 *
 * Copre `src/variant.js` (vocabolario dub/sub) e `src/routes/api.js` (la
 * superficie che rende il resolver utilizzabile da un client non-Stremio).
 *
 * `node:test` + `node:assert/strict`. Nessuna rete, nessun modulo reale: il
 * resolver e le fonti sono finte e iniettate. Come in `test/routes.test.mjs`
 * gli handler sono `async (req, res)` ma `res` resta assente, quindi
 * l'handler restituisce l'envelope `{ status, body, headers }` e l'header CORS
 * si verifica senza aprire una porta.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  VARIANT_DUB,
  VARIANT_SUB,
  VARIANT_UNKNOWN,
  detectVariant,
  variantLabel,
  parseVariantParam,
} from '../src/variant.js';
import { createApiRoute } from '../src/routes/api.js';
import { createAddonRoutes, createRequestListener } from '../src/server.js';
import { MANIFEST } from '../src/manifest.js';

// ---------------------------------------------------------------------------
// Finte
// ---------------------------------------------------------------------------

const req = (url, method = 'GET') => ({ method, url, headers: { host: 'localhost' } });

const FAKE_SOURCES = [
  { id: 'animeworld', label: 'AnimeWorld' },
  { id: 'animesaturn', label: 'AnimeSaturn' },
  { id: 'animeunity', label: 'AnimeUnity' },
];

function row(over = {}) {
  return {
    name: 'AnimeUnity',
    title: 'One Piece - Ep 5',
    url: 'https://cdn.example/stream.m3u8?token=abc',
    source: 'animeunity',
    ...over,
  };
}

/** Array di stream con `errors` non enumerabile, come fa il resolver reale. */
function fakeResolver(rows, errors = []) {
  const calls = [];
  const out = [...rows];
  Object.defineProperty(out, 'errors', { value: errors, enumerable: false });
  return {
    calls,
    async resolveSeries(args) {
      calls.push(args);
      return out;
    },
    async resolveMovie(args) {
      calls.push({ movie: true, ...args });
      return out;
    },
  };
}

function api(resolver, sources = FAKE_SOURCES) {
  return createApiRoute({ resolver, sources, timeoutMs: 1000 });
}

/**
 * `createAddonRoutes` costruisce TUTTE le rotte, quindi serve un Kitsu che
 * soddisfi il contratto di dipendenza dichiarato dai route handler. Uno stub
 * vuoto fallirebbe su `kitsu.search` e i test misurerebbero il mio setup, non
 * il wiring di `api`.
 */
const fakeKitsu = () => ({
  async search() {
    return [];
  },
  async meta() {
    return null;
  },
});

/**
 * `onRequest` non RESTITUISCE l'envelope: chiama `jsonResponse(res, ...)`, che
 * scrive con `writeHead` + `end`. Catturare quei due e` quindi l'unico modo per
 * osservare davvero cosa esce dal dispatcher, ed e` un test piu' forte di uno
 * che leggerebbe un valore di ritorno.
 */
function fakeRes() {
  const captured = { statusCode: 0, headers: null, payload: '' };
  return {
    captured,
    writeHead(status, headers) {
      captured.statusCode = status;
      captured.headers = headers;
    },
    end(payload = '') {
      captured.payload = payload;
    },
    json() {
      return JSON.parse(captured.payload);
    },
  };
}

// ---------------------------------------------------------------------------
// detectVariant — il punto in cui il marker si perde
// ---------------------------------------------------------------------------

describe('detectVariant', () => {
  test('legge i valori letterali che il sito espone', () => {
    assert.equal(detectVariant({ language_type: 'Italian Dub' }), VARIANT_DUB);
    assert.equal(detectVariant({ language_type: 'Italian Sub' }), VARIANT_SUB);
  });

  test('accetta anche il campo normalizzato `variant`', () => {
    assert.equal(detectVariant({ variant: 'dub' }), VARIANT_DUB);
    assert.equal(detectVariant({ variant: 'sub' }), VARIANT_SUB);
  });

  test('tokenizza: trattini, underscore e maiuscole non contano', () => {
    for (const value of ['italian-dub', 'ITALIAN_DUB', 'Italian  Dub', 'italian-dubbed']) {
      assert.equal(detectVariant({ language_type: value }), VARIANT_DUB, `atteso dub per ${value}`);
    }
    for (const value of ['italian-sub', 'ITALIAN_SUB', 'Italian Subtitled', 'sottotitolato']) {
      assert.equal(detectVariant({ language_type: value }), VARIANT_SUB, `atteso sub per ${value}`);
    }
  });

  test('`variant` ha precedenza sui campi grezzi upstream', () => {
    assert.equal(detectVariant({ variant: 'dub', language_type: 'Italian Sub' }), VARIANT_DUB);
  });

  test('un marker nudo `[ITA]` NON viene interpretato', () => {
    // Il punto dell'intero modulo: `[ITA]` non dice se l'audio e' doppiato o se
    // i dialoghi sono sottotitolati. Scegliere `sub` qui sarebbe inventare.
    assert.equal(detectVariant({ language_type: 'ITA' }), VARIANT_UNKNOWN);
    assert.equal(detectVariant({ language: 'Italian' }), VARIANT_UNKNOWN);
    assert.equal(detectVariant({ lang: 'ita' }), VARIANT_UNKNOWN);
  });

  test('un campo che contiene entrambi i marker e ambiguo, non viene arbitrato', () => {
    assert.equal(detectVariant({ language_type: 'Italian Dub/Sub' }), VARIANT_UNKNOWN);
    assert.equal(detectVariant({ language_type: 'dub sub' }), VARIANT_UNKNOWN);
  });

  test('nessuna corrispondenza per prefisso: `subscription` non e` un sub', () => {
    assert.equal(detectVariant({ language_type: 'subscription' }), VARIANT_UNKNOWN);
    assert.equal(detectVariant({ language_type: 'subscribe' }), VARIANT_UNKNOWN);
  });

  test('campi assenti, vuoti o non-stringa', () => {
    assert.equal(detectVariant({}), VARIANT_UNKNOWN);
    assert.equal(detectVariant({ variant: '' }), VARIANT_UNKNOWN);
    assert.equal(detectVariant({ variant: '   ' }), VARIANT_UNKNOWN);
    assert.equal(detectVariant({ variant: null }), VARIANT_UNKNOWN);
    assert.equal(detectVariant({ variant: 42 }), VARIANT_UNKNOWN);
  });

  test('input non oggetto', () => {
    for (const value of [null, undefined, 0, '', [], 'dub']) {
      assert.equal(detectVariant(value), VARIANT_UNKNOWN, `atteso unknown per ${String(value)}`);
    }
  });

  test('un campo ambiguo non impedisce di trovare il successivo', () => {
    assert.equal(detectVariant({ language_type: 'Dub/Sub', audio: 'Italian Dub' }), VARIANT_DUB);
  });
});

// ---------------------------------------------------------------------------
// variantLabel
// ---------------------------------------------------------------------------

describe('variantLabel', () => {
  test('etichette leggibili', () => {
    assert.equal(variantLabel(VARIANT_DUB), 'ITA DUB');
    assert.equal(variantLabel(VARIANT_SUB), 'ITA SUB');
  });

  test('unknown non inventa DUB ne` SUB', () => {
    assert.equal(variantLabel(VARIANT_UNKNOWN), 'ITA');
  });

  test('lingua esplicita', () => {
    assert.equal(variantLabel(VARIANT_DUB, 'en'), 'EN DUB');
  });
});

// ---------------------------------------------------------------------------
// parseVariantParam
// ---------------------------------------------------------------------------

describe('parseVariantParam', () => {
  test('assente o vuoto = all, non sub', () => {
    for (const value of [undefined, null, '', 'all', 'ANY', '  ']) {
      assert.deepEqual(parseVariantParam(value), { ok: true, variant: 'all' });
    }
  });

  test('accetta dub e sub, indifferentemente al maiuscolo', () => {
    assert.deepEqual(parseVariantParam('dub'), { ok: true, variant: 'dub' });
    assert.deepEqual(parseVariantParam('SUB'), { ok: true, variant: 'sub' });
  });

  test('rifiuta un valore che non e` una variante', () => {
    // Non degradato a `all`: una richiesta esplicita e` sbagliata va detta.
    assert.deepEqual(parseVariantParam('english'), { ok: false, variant: null });
    assert.deepEqual(parseVariantParam('ita'), { ok: false, variant: null });
  });
});

// ---------------------------------------------------------------------------
// createApiRoute — superficie per client non-Stremio
// ---------------------------------------------------------------------------

describe('GET /api', () => {
  test('descrive se stessa, endpoint e fonti', async () => {
    const out = await api(fakeResolver([]))(req('/api'));
    assert.equal(out.status, 200);
    assert.equal(out.body.endpoints.streams.includes('variant='), true);
    // `/api/sources` promises "the sources AND whether they declare variants"
    // (src/routes/api.js header). Until the capability static existed that promise
    // was not implemented and the field was reconstructed from each request's
    // rows; the declaration is now stated here, per source, once.
    assert.deepEqual(
      out.body.sources.map(({ id, label }) => ({ id, label })),
      FAKE_SOURCES,
    );
    assert.deepEqual(
      out.body.sources.map((s) => s.declaresVariants),
      [true, true, true],
    );
    assert.deepEqual(out.body.variants, ['dub', 'sub', 'unknown']);
  });

  test('/api/sources e` la stessa risposta descrittiva', async () => {
    const handler = api(fakeResolver([]));
    assert.equal((await handler(req('/api'))).status, 200);
    assert.equal((await handler(req('/api/sources'))).status, 200);
  });

  test('endpoint sconosciuto -> 404 con gli endpoint reali', async () => {
    const out = await api(fakeResolver([]))(req('/api/nope'));
    assert.equal(out.status, 404);
    assert.ok(out.body.endpoints.streams);
  });

  test('la risposta porta CORS come tutto il resto', async () => {
    const out = await api(fakeResolver([]))(req('/api'));
    assert.equal(out.headers['Access-Control-Allow-Origin'], '*');
  });
});

describe('GET /api/streams — validazione', () => {
  test('senza title -> 400 che dice quale parametro manca', async () => {
    const out = await api(fakeResolver([]))(req('/api/streams'));
    assert.equal(out.status, 400);
    assert.match(out.body.error, /title/);
  });

  test('episode non numerico -> 400, NON un episodio 1 silenzioso', async () => {
    // Il difetto che questo test impedisce: `Number('abc')` -> NaN -> 1, che
    // restituirebbe uno stream reale e sbagliato invece di un errore.
    for (const value of ['abc', '0', '-1', '1.5', 'NaN', '1e']) {
      const out = await api(fakeResolver([]))(req(`/api/streams?title=Naruto&episode=${value}`));
      assert.equal(out.status, 400, `atteso 400 per episode=${value}`);
      assert.match(out.body.error, /episode/);
    }
  });

  test('episode valido viene passato al resolver', async () => {
    const resolver = fakeResolver([]);
    await api(resolver)(req('/api/streams?title=Naruto&episode=954'));
    assert.equal(resolver.calls[0].episode, 954);
  });

  test('episode assente -> 1', async () => {
    const resolver = fakeResolver([]);
    await api(resolver)(req('/api/streams?title=Naruto'));
    assert.equal(resolver.calls[0].episode, 1);
  });

  test('variant inesistente -> 400', async () => {
    const out = await api(fakeResolver([]))(req('/api/streams?title=Naruto&variant=english'));
    assert.equal(out.status, 400);
    assert.match(out.body.error, /variant/);
  });

  test('fonte sconosciuta -> 400 invece di un risultato vuoto', async () => {
    const out = await api(fakeResolver([]))(req('/api/streams?title=Naruto&source=nope'));
    assert.equal(out.status, 400);
    assert.match(out.body.error, /fonte/);
  });

  test('fonte nota ->restricted al resolver', async () => {
    const resolver = fakeResolver([]);
    await api(resolver)(req('/api/streams?title=Naruto&source=animeunity'));
    assert.deepEqual(resolver.calls[0].sources, ['animeunity']);
  });
});

describe('GET /api/streams — proiezione', () => {
  test('variant e` SEMPRE presente, anche quando la fonte non dice niente', async () => {
    const out = await api(fakeResolver([row()]))(req('/api/streams?title=One%20Piece'));
    assert.equal(out.body.streams[0].variant, 'unknown');
    assert.equal(out.body.streams[0].variantLabel, 'ITA');
  });

  test('variant derivato dalla riga, e` sempre coerente col label', async () => {
    const out = await api(
      fakeResolver([row({ variant: 'dub' }), row({ variant: 'sub', source: 'animeworld' })]),
    )(req('/api/streams?title=One%20Piece'));
    const [dub, sub] = out.body.streams;
    assert.equal(dub.variant, 'dub');
    assert.equal(dub.variantLabel, 'ITA DUB');
    assert.equal(sub.variant, 'sub');
    assert.equal(sub.variantLabel, 'ITA SUB');
  });

  test('height letto da title/declared, e 0 quando non c`e` qualita`', async () => {
    // Contratto reale di `streamQualityHeight`: tre fonti nell'ordine
    // dichiarato -> testo -> URL, e l'URL e' l'ULTIMA risorsa, mai sopra un campo
    // dichiarato. Il caso `720` qui sotto e' quello scelto per distinguerlo: la
    // riga non ha `quality`/`resolution`, il titolo (`x`) non dichiara nulla, e il
    // 720 arriva SOLO dal nome del file nell'URL.
    //
    // Leggerlo e' deliberato, non un'eredita': gli scraper dichiarano la qualita'
    // nel nome del file (`/720p.mp4`, `_Full_HD/`) e non compilano nessun campo,
    // quindi senza l'URL ogni riga avrebbe `height: 0` e l'ordinamento non
    // ordinerebbe nulla. Il perche' non sale MAI sopra un campo dichiarato sta nel
    // docstring di `streamQualityHeight` in manifest.js: sostituire
    // un'affermazione esplicita della fonte con un numero trovato in una stringa
    // e' il modo di ordinare sotto una qualita' che la fonte conosceva, e infatti
    // `height: 0` dichiarato resta 0 anche con un URL 1080p (fisso in
    // test/routes.test.mjs). Le due proiezioni non possono divergere: questa
    // superficie e l'ordinamento Stremio chiamano la stessa funzione sulla stessa
    // riga. `0` resta comunque un'affermazione onesta: "non c'e' qualita' dichiarata
    // da nessuna parte", non "e' bassa".
    const out = await api(
      fakeResolver([
        row({ title: 'One Piece 1080p' }),
        row({ title: 'x', url: 'https://a/720p.mp4' }),
        row({ title: 'x', height: 480 }),
        row({ title: 'x', resolution: '1920x1080' }),
        row({ title: 'Episodio 954' }),
      ]),
    )(req('/api/streams?title=One%20Piece'));

    assert.deepEqual(
      out.body.streams.map((s) => s.height),
      [1080, 720, 480, 1080, 0],
    );
  });

  test('righe senza URL riproducibile scartate, con count coerente', async () => {
    const out = await api(
      fakeResolver([row(), row({ url: '' }), row({ url: null }), row({ url: 42 })]),
    )(req('/api/streams?title=One%20Piece'));
    assert.equal(out.body.streams.length, 1);
    assert.equal(out.body.count, 1);
  });

  test('errori upstream riportati, non nascosti', async () => {
    const out = await api(fakeResolver([row()], ['animesaturn: timeout']))(
      req('/api/streams?title=One%20Piece'),
    );
    assert.deepEqual(out.body.errors, ['animesaturn: timeout']);
  });

  test('Cache-Control: no-store — gli URL hanno token temporanei', async () => {
    const out = await api(fakeResolver([row()]))(req('/api/streams?title=One%20Piece'));
    assert.equal(out.headers['Cache-Control'], 'no-store');
  });

  test('il resolver non viene chiamato se l`input e` invalido', async () => {
    const resolver = fakeResolver([row()]);
    await api(resolver)(req('/api/streams?title=X&episode=0'));
    await api(resolver)(req('/api/streams?variant=dub'));
    assert.equal(resolver.calls.length, 0);
  });
});

describe('GET /api/streams — filtro dub/sub', () => {
  const MIXED = [
    row({ variant: 'dub', url: 'https://a/dub.m3u8' }),
    row({ variant: 'sub', url: 'https://a/sub.m3u8', source: 'animeworld' }),
    row({ url: 'https://a/unspecified.m3u8', source: 'animesaturn' }),
  ];

  test('all restituisce tutto, compresi gli unknown', async () => {
    const out = await api(fakeResolver(MIXED))(req('/api/streams?title=Naruto'));
    assert.equal(out.body.totalCount, 3);
    assert.equal(out.body.count, 3);
    assert.deepEqual(out.body.availableVariants, ['dub', 'sub', 'unknown']);
  });

  test('variant=dub esclude gli unknown, non li vende come dub', async () => {
    const out = await api(fakeResolver(MIXED))(req('/api/streams?title=Naruto&variant=dub'));
    assert.equal(out.body.count, 1);
    assert.equal(out.body.streams[0].variant, 'dub');
    // totalCount resta il numero di righe reali: un filtro che dicesse 3 sarebbe bug.
    assert.equal(out.body.totalCount, 3);
  });

  test('variant=sub restituisce solo il sub dichiarato', async () => {
    const out = await api(fakeResolver(MIXED))(req('/api/streams?title=Naruto&variant=sub'));
    assert.equal(out.body.count, 1);
    assert.equal(out.body.streams[0].variant, 'sub');
  });

  test('variantsKnown e` la CAPACITA` DELLA FONTE, non il titolo', async () => {
    // Il difetto che questo test impedisce: `variantsKnown` era
    // `availableVariants.some(v => v !== 'unknown')`, cioe' una ristampa di
    // `availableVariants`. Sotto quel codice il `false` compariva ogni volta che
    // NESSUNA riga dichiarava una variante — titolo vuoto, o titolo in cui la
    // fonte ha risposto senza etichettare — e in entrambi i casi l'accusa
    // ("questo scraper non porta informazioni sulla variante") era falsa, e per
    // sua stessa definizione non correggibile da questa parte.
    const unknownOnly = await api(fakeResolver([row()]))(req('/api/streams?title=X'));
    assert.deepEqual(unknownOnly.body.availableVariants, ['unknown']);
    assert.equal(unknownOnly.body.variantsKnown, true, 'la fonte ha risposto: sa cosa cerca, non ha trovato un dub');

    // E il caso che non e' piu' distinguibile da "zero risultati".
    const empty = await api(fakeResolver([]))(req('/api/streams?title=X'));
    assert.deepEqual(empty.body.availableVariants, []);
    assert.equal(empty.body.variantsKnown, true, 'nessun risultato non puo` dire cosa sa la fonte');

    // Il campo per-titolo resta quello che descrive il titolo: `sub` e' un
    // titolo senza dub, non un sito che non distingue.
    const subOnly = await api(fakeResolver([row({ variant: 'sub', source: 'animesaturn' })]))(
      req('/api/streams?title=X'),
    );
    assert.deepEqual(subOnly.body.availableVariants, ['sub']);
    assert.equal(subOnly.body.variantsKnown, true);
  });

  test('?source= che restringe a una sola fonte: la capacita` non si specchia sul subset', async () => {
    // Il caso pinzato: la fonte del subset RISPONDE ma senza dichiarare nulla.
    // Sotto l'implementazione vecchia questo era `false`.
    const unlabeled = await api(fakeResolver([row({ source: 'animesaturn' })]))(
      req('/api/streams?title=X&source=animesaturn'),
    );
    assert.equal(unlabeled.status, 200);
    assert.deepEqual(unlabeled.body.availableVariants, ['unknown']);
    assert.equal(unlabeled.body.variantsKnown, true);
    assert.deepEqual(unlabeled.body.variantsKnownBy, { animesaturn: true });

    // E il titolo che ha solo sub: capability e per-titolo restano due risposte.
    const subOnly = await api(fakeResolver([row({ variant: 'sub', source: 'animesaturn' })]))(
      req('/api/streams?title=X&source=animesaturn'),
    );
    assert.deepEqual(subOnly.body.availableVariants, ['sub']);
    assert.equal(subOnly.body.variantsKnown, true);

    // Il subset filtra anche le fonti ELENCATE, non solo le righe.
    const all = await api(fakeResolver([row({ source: 'animesaturn' }), row({ source: 'animeworld' })]))(
      req('/api/streams?title=X'),
    );
    assert.deepEqual(Object.keys(all.body.variantsKnownBy), [
      'animeworld',
      'animesaturn',
      'animeunity',
    ]);
  });

  test('variantsKnownBy elenca solo le fonti consultate', async () => {
    const all = await api(fakeResolver([]))(req('/api/streams?title=X'));
    assert.deepEqual(all.body.variantsKnownBy, {
      animeworld: true,
      animesaturn: true,
      animeunity: true,
    });

    const one = await api(fakeResolver([]))(req('/api/streams?title=X&source=AnimeUnity'));
    assert.deepEqual(one.body.variantsKnownBy, { animeunity: true });
  });

  test('una fonte che non dichiara la distinzione rende `variantsKnown` false, e lo dichiara', async () => {
    // Dato il contratto ("true solo se OGNI fonte consultata dichiara"), il
    // booleano deve poter essere false per una sola ragione: una fonte che non
    // dichiara. Qui si simula con una lista di fonti che ne contiene una
    // sconosciuta — che non e' in grado di firmare la propria capacita'.
    const mixed = [
      { id: 'animesaturn', label: 'AnimeSaturn' },
      { id: 'sconosciuta', label: 'Sconosciuta' },
    ];
    const out = await createApiRoute({ resolver: fakeResolver([row()]), sources: mixed, timeoutMs: 1000 })(
      req('/api/streams?title=X'),
    );
    assert.equal(out.status, 200);
    assert.deepEqual(out.body.variantsKnownBy, { animesaturn: true, sconosciuta: false });
    assert.equal(out.body.variantsKnown, false);
  });

  test('un vuoto onesto: 200 con array vuoto, non un errore', async () => {
    const out = await api(fakeResolver([]))(req('/api/streams?title=Naruto&variant=dub'));
    assert.equal(out.status, 200);
    assert.deepEqual(out.body.streams, []);
    assert.equal(out.body.count, 0);
  });
});

describe('createApiRoute — robustezza', () => {
  test('senza resolver -> TypeError esplicita', () => {
    assert.throws(() => createApiRoute({}), TypeError);
    assert.throws(() => createApiRoute({ resolver: {} }), TypeError);
  });

  test('un resolver che solleva non produce una risposta falsa 200 vuota', async () => {
    const resolver = {
      async resolveSeries() {
        throw new Error('boom');
      },
      async resolveMovie() {},
    };
    const out = await api(resolver)(req('/api/streams?title=X'));
    assert.ok(out.status >= 400, `atteso >=400, ottenuto ${out.status}`);
  });
});

// ---------------------------------------------------------------------------
// La giuntura: `createAddonRoutes` deve davvero registrare `api` e il
// dispatcher deve raggiungerlo. Il resto dei test copre il route handler; senza
// questi due il sito risponderebbe 404 su una rotta che "esiste" solo in un
// file. Verificato con il resolver iniettato, quindi nessuna rete.
// ---------------------------------------------------------------------------

describe('server wiring: /api raggiungibile davvero', () => {
  test('createAddonRoutes registra una funzione `api`', () => {
    const routes = createAddonRoutes({ resolver: fakeResolver([]), kitsu: fakeKitsu() });
    assert.equal(typeof routes.api, 'function');
    // E non deve comparire nel manifest: Stremio lo tratterebbe come resource.
    assert.equal(MANIFEST.resources.some((r) => r.name === 'api'), false);
  });

  test('il dispatcher instrada /api e /api/streams al route handler', async () => {
    const resolver = fakeResolver([row({ variant: 'dub' })]);
    const listener = createRequestListener({
      routes: createAddonRoutes({ resolver, kitsu: fakeKitsu() }),
      log: () => {},
    });

    const index = fakeRes();
    await listener(req('/api'), index);
    assert.equal(index.captured.statusCode, 200);
    assert.equal(index.json().sources.length, FAKE_SOURCES.length);
    assert.equal(index.captured.headers['Access-Control-Allow-Origin'], '*');

    const streams = fakeRes();
    await listener(req('/api/streams?title=One%20Piece&variant=dub'), streams);
    assert.equal(streams.captured.statusCode, 200);
    assert.equal(streams.captured.headers['Cache-Control'], 'no-store');

    const body = streams.json();
    assert.equal(body.count, 1);
    assert.equal(body.streams[0].variant, 'dub');
    assert.equal(body.streams[0].variantLabel, 'ITA DUB');
    // Il percorso di scrittura reale: il body emesso deve essere JSON valido e
    // dichiarare la lunghezza che ha effettivamente inviato.
    assert.equal(Number(streams.captured.headers['Content-Length']), streams.captured.payload.length);
  });

  test('/api non collide con /api sconosciuto -> 404, non un 200 generico', async () => {
    const listener = createRequestListener({
      routes: createAddonRoutes({ resolver: fakeResolver([]), kitsu: fakeKitsu() }),
      log: () => {},
    });
    const res = fakeRes();
    await listener(req('/api/inesistente'), res);
    // Non il 404 generico del dispatcher: `api` intercetta la rotta e risponde
    // nominando l'endpoint sconosciuto, che e' la risposta utile a un client
    // che sta scoprendo la superficie.
    assert.equal(res.captured.statusCode, 404);
    assert.equal(res.json().error, 'endpoint sconosciuto');
    assert.ok(res.json().endpoints.streams);
  });

  test('il resolver iniettato e` davvero quello usato (nessun default reale)', async () => {
    const resolver = fakeResolver([]);
    const listener = createRequestListener({
      routes: createAddonRoutes({ resolver, kitsu: fakeKitsu() }),
      log: () => {},
    });
    await listener(req('/api/streams?title=Naruto&episode=954'), fakeRes());
    assert.equal(resolver.calls.length, 1);
    assert.equal(resolver.calls[0].episode, 954);
  });
});