/**
 * test/server-http.test.mjs
 *
 * L'unico file di test che parla a `src/server.js` attraverso un **socket
 * vero**. Tutti gli altri test del repo passano un `req` finto e non passano
 * `res`, quindi osservano solo l'envelope `{ status, body, headers }`: senza
 * questo file, `jsonResponse` non aveva mai eseguito `writeHead`/`end`, e
 * `createAddonServer`/`createRequestListener` non erano mai partiti.
 *
 * Cosa cambia rispetto al resto della suite, in concreto:
 *
 *   - la porta e' `0` (ephemera), quindi due run paralleli non si pestano i piedi
 *     e la suite non puo' fallire perche' la 7000 e' gia' occupata;
 *   - le asserzioni leggono `res.statusCode`, `res.headers` e i **byte** del body
 *     dal socket, non un oggetto costruito a mano;
 *   - `Content-Length` viene confrontato con `Buffer.byteLength` del body
 *     ricevuto, che e' l'unico confronto che puo' accorgersi di uno
 *     `end(payload)` sbagliato;
 *   - `HEAD` viene verificato sul body vuoto reale, non sull'assenza di una
 *     chiamata a `end`.
 *
 * ── NESSUNA RETE ─────────────────────────────────────────────────────────────
 * `createAddonServer` accetta le stesse dipendenze iniettate di
 * `createAddonRoutes`, quindi qui si iniettano finte. `kitsu` e' uno stub che
 * **lancia** se chiamato e conta le chiamate: `GET /health` e
 * `GET /manifest.json` devono rispondere con zero chiamate, ed e' un'affermazione
 * verificabile invece di "non e' andato in timeout".
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createAddonServer, createRequestListener } from '../src/server.js';
import { jsonResponse } from '../src/manifest.js';

// ---------------------------------------------------------------------------
// Finte
// ---------------------------------------------------------------------------

/**
 * Stub che fallisce rumorosamente se qualcuno lo chiama. Non serve solo a
 * evitare la rete: serve a rendere osservabile *quale* rotta tocca una
 * dipendenza, perche' un test che passa perche' "non ha dato errore" non
 * distingue "non chiamata" da "chiamata e swallowed".
 */
function strictKitsu() {
  const calls = [];
  return {
    calls,
    async search(...args) {
      calls.push(['search', args]);
      throw new Error('kitsu.search chiamata: questo test non deve toccare la rete');
    },
    async meta(...args) {
      calls.push(['meta', args]);
      throw new Error('kitsu.meta chiamata: questo test non deve toccare la rete');
    },
  };
}

function strictResolver() {
  const calls = [];
  return {
    calls,
    async resolveSeries(...args) {
      calls.push(['resolveSeries', args]);
      throw new Error('resolver.resolveSeries chiamata: questo test non deve toccare la rete');
    },
    async resolveMovie(...args) {
      calls.push(['resolveMovie', args]);
      throw new Error('resolver.resolveMovie chiamata: questo test non deve toccare la rete');
    },
  };
}

// ---------------------------------------------------------------------------
// Server + client di test
// ---------------------------------------------------------------------------

/**
 * `closeAllConnections()` e' necessario perche' l'agent globale di Node ha
 * `keepAlive: true` dal 19: senza, `server.close()` aspetta le connessioni
 * aperte e `t.after` non finisce, cioe' la suite si blocca. Il client qui sotto
 * usa `agent: false`, quindi non dovrebbe esserci nulla da chiudere: e' la rete
 * di sicurezza perche' un test fallito a meta' non deve lasciare la suite appesa.
 */
function closeServer(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

/**
 * Client HTTP reale. `agent: false` chiude la connessione a ogni richiesta:
 * e' cio' che tiene `server.close()` breve, e voglio che la prima richiesta
 * dopo la chiusura non trovi una socket riusata.
 *
 * Il body e' un `Buffer` grezzo, non una stringa: `Content-Length` si confronta
 * con i byte, e un `.toString('utf8')` preventivo maschererebbe proprio il
 * difetto che si vuole vedere.
 */
function fetchRaw(base, path, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${path}`, { method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body, text: body.toString('utf8') });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Suite principale: il server vero di produzione
// ---------------------------------------------------------------------------

describe('server su socket reale', () => {
  const kitsu = strictKitsu();
  const resolver = strictResolver();
  let server;
  let base;

  before(async () => {
    server = createAddonServer({ kitsu, resolver, log: () => {} });
    base = await listen(server);
  });

  after(async () => {
    await closeServer(server);
    // Non bastache il processo esca: se `close()` avesse fallito, il test
    // runner terrebbe la socket e la suite si bloccherebbe, ma l'asserzione
    // rende il requisito verificabile invece che dedotto dal fatto che siamo
    // arrivati alla fine.
    assert.equal(server.listening, false, 'il server di test deve essere chiuso');
  });

  test('GET /manifest.json -> 200, JSON valido, Content-Length coerente, CORS', async () => {
    const res = await fetchRaw(base, '/manifest.json');

    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(res.headers['access-control-allow-origin'], '*');

    // L'asserzione che l'envelope finto non poteva fare: il numero dichiarato
    // e i byte realmente arrivati sul socket sono lo stesso numero.
    const declared = Number(res.headers['content-length']);
    assert.ok(Number.isInteger(declared), `Content-Length assente o non numerico: ${res.headers['content-length']}`);
    assert.equal(declared, res.body.length);

    const parsed = JSON.parse(res.text);
    assert.equal(parsed.id, 'com.suplic0z.stremio-anime-resolver');
    assert.deepEqual(parsed.idPrefixes, ['ku']);

    // Il manifest e' una rotta statica: non deve aver toccato Kitsu.
    assert.deepEqual(kitsu.calls, []);
  });

  test('HEAD /manifest.json -> 200 senza body', async () => {
    const res = await fetchRaw(base, '/manifest.json', { method: 'HEAD' });

    assert.equal(res.status, 200);
    assert.equal(res.body.length, 0, 'HEAD non deve trasportare body');
    // Gli header restano coerenti anche senza body: `Content-Length` dichiara
    // quello che avrebbe avuto il GET, e su HEAD il client non lo usa.
    assert.equal(res.headers['access-control-allow-origin'], '*');
  });

  test('OPTIONS -> 204 con gli header CORS', async () => {
    const res = await fetchRaw(base, '/manifest.json', {
      method: 'OPTIONS',
      headers: { Origin: 'http://example.invalid', 'Access-Control-Request-Method': 'GET' },
    });

    assert.equal(res.status, 204);
    assert.equal(res.body.length, 0);
    assert.equal(res.headers['access-control-allow-origin'], '*');
    assert.equal(res.headers['access-control-allow-methods'], 'GET, HEAD, OPTIONS');
    assert.ok(res.headers['access-control-max-age']);
  });

  test('POST -> 405, e il 405 porta il CORS come ogni altra risposta', async () => {
    const res = await fetchRaw(base, '/manifest.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    assert.equal(res.status, 405);
    assert.equal(res.headers['access-control-allow-origin'], '*');
    assert.deepEqual(JSON.parse(res.text), { error: 'method not allowed' });
  });

  test('GET /health -> 200 {"ok":true} senza toccare Kitsu', async () => {
    const res = await fetchRaw(base, '/health');

    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.text), { ok: true });
    // Il punto della riga: lo stub di Kitsu **lancia** se called, quindi un 200
    // qui non puo' essere stato ottenuto passando da Kitsu.
    assert.deepEqual(kitsu.calls, []);
    assert.deepEqual(resolver.calls, []);
  });

  test('id malformato -> 404, non 500', async () => {
    // Uno spazio codificato nell'id: `pathSegments` lo decodifica e
    // `parseMetaId` non lo accetta. Un 500 qui sarebbe un bug di contratto:
    // l'id non descrive una risorsa, non e' un errore dell'addon.
    const meta = await fetchRaw(base, '/meta/series/ku:%20.json');
    assert.equal(meta.status, 404);
    assert.equal(meta.headers['access-control-allow-origin'], '*');

    // Episodio 0: la sintassi e' giusta, il numero non lo e'. Stessa risposta.
    const stream = await fetchRaw(base, '/stream/series/ku:12:0.json');
    assert.equal(stream.status, 404);
    assert.deepEqual(JSON.parse(stream.text), { streams: [] });
  });

  test('path inesistente -> 404 con CORS', async () => {
    const res = await fetchRaw(base, '/non/esiste.json');
    assert.equal(res.status, 404);
    assert.equal(res.headers['access-control-allow-origin'], '*');
  });
});

// ---------------------------------------------------------------------------
// Un throw che esce dal dispatcher
// ---------------------------------------------------------------------------

/**
 * Perche' questi test non usano `kitsu` che lancia: i route handler hanno già
 * un proprio `try` che chiama `errorToResponse`, quindi un throw da
 * `kitsu.search` viene **assorbito** li' e non arriva mai al wrapper. Per
 * colpire il wrapper serve un throw FUORI dal try di un handler, e l'unico
 * punto in cui il test può iniettarlo è `routes`: `createRequestListener`
 * accetta `{ routes, log }` ed è l'unica seam già esistente per questo.
 */
describe('un throw che sfugge al try di un handler', () => {
  async function serverWithRoutes(routes) {
    const server = http.createServer(createRequestListener({ routes, log: () => {} }));
    const base = await listen(server);
    return { server, base };
  }

  test('risponde 500 e il processo sopravvive', async (t) => {
    const { server, base } = await serverWithRoutes({
      manifest() {
        throw new Error('throw fuori dal try del handler');
      },
    });
    t.after(async () => {
      await closeServer(server);
      assert.equal(server.listening, false, 'il server di test deve essere chiuso');
    });

    const res = await fetchRaw(base, '/manifest.json');

    assert.equal(res.status, 500);
    // Il corpo non deve contenere il messaggio: è dettaglio interno.
    assert.deepEqual(JSON.parse(res.text), { error: 'internal error' });

    // "Il processo è sopravvissuto" verificato per via che conta: il server
    // risponde ancora su una richiesta successiva. Se il wrapper avesse lasciato
    // sfuggire il rejection, il processo sarebbe morto e questa seconda
    // richiesta non arriverebbe mai.
    const after = await fetchRaw(base, '/manifest.json');
    assert.equal(after.status, 500);
  });

  test('non rompe il caso senza throw: il percorso normale resta 200', async (t) => {
    const { server, base } = await serverWithRoutes({
      // Scrive davvero su `res`: un handler che si limitasse a restituire
      // l'envelope non scriverebbe nulla e il client resterebbe appeso, che e'
      // esattamente la classe di hang che questo wrapper deve evitare.
      manifest(req, res) {
        return jsonResponse(res, 200, { ok: true });
      },
    });
    t.after(async () => {
      await closeServer(server);
      assert.equal(server.listening, false, 'il server di test deve essere chiuso');
    });

    const res = await fetchRaw(base, '/manifest.json');
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.text), { ok: true });
    assert.equal(Number(res.headers['content-length']), res.body.length);
  });
});

// ---------------------------------------------------------------------------
// Cosa assorbe davvero il throw di una dipendenza
// ---------------------------------------------------------------------------

/**
 * Questo test **non** dimostra che il wrapper copra le dipendenze: dimostra il
 * contrario, cioe' che il `try` del route handler arriva prima. Serve a fermare
 * l'overclaim piu' probabile ("il throw di kitsu e' coperto dal wrapper"), e a
 * mettere sotto test il fatto che un errore upstream resta un 500 pulito senza
 * dettagli invece di uccidere il processo.
 */
describe('throw di una dipendenza: chi lo cattura', () => {
  test('kitsu.search che lancia -> 500 pulito, catturato dal try del handler', async (t) => {
    const kitsu = {
      calls: [],
      async search(...args) {
        kitsu.calls.push(args);
        throw new Error('Kitsu 503');
      },
      async meta() {
        return null;
      },
    };
    const server = createAddonServer({
      kitsu,
      resolver: { async resolveSeries() { return []; }, async resolveMovie() { return []; } },
      log: () => {},
    });
    const base = await listen(server);
    t.after(async () => {
      await closeServer(server);
      assert.equal(server.listening, false, 'il server di test deve essere chiuso');
    });

    const res = await fetchRaw(base, '/catalog/anime/kitsu-anime/search.json?search=naruto');

    // 5xx e non 404: `errorToResponse` distingue "a monte non ha risposto" da
    // "non c'e' niente qui".
    assert.ok(res.status >= 500, `atteso >=500, ottenuto ${res.status}`);
    assert.equal(kitsu.calls.length, 1, 'il throw doveva arrivare al handler');
    // Nessun dettaglio interno nel body.
    assert.equal(res.text.includes('Kitsu 503'), false);
  });
});