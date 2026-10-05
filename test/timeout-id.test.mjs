/**
 * test/timeout-id.test.mjs
 *
 * Quattro difetti, e una radice sola: una risposta che racconta una cosa
 * diversa da quella che e' successa.
 *
 *   1. tre fonti in timeout -> 500 "internal error" invece di 504 "upstream
 *      timeout", perche' l'errore del resolver non portava la classificazione
 *      che `errorToResponse` guarda;
 *   2. `raceTimeout` ignorava il `label` che gli veniva passato, e teneva il suo
 *      timer di guardia `unref()`: senza ascolto, il processo moriva con codice
 *      13 e stderr VUOTO invece di consegnare la classificazione `ETIMEDOUT`;
 *   3. il catalogo pubblicava `id: "ku:"` per una riga di ricerca senza id, e la
 *      rotta meta rispondeva 404 a quell'id;
 *   4. il catalogo ignorava il segmento `extra` che Stremio manda, e una ricerca
 *      degradava in silenzio a un browse completo.
 *
 * ── PERCHE' IL PRIMO TEST USA IL RESOLVER VERO ────────────────────────────────
 * `test/routes.test.mjs` inietta un `TimeoutError` gia' costruito: cosi' prova la
 * guardia della rotta, che e' gia' corretta, e non prova mai il fallimento
 * vero. Qui il resolver e' quello di `src/resolver.js` con tre fonti finte che
 * non rispondono mai: il percorso `raceTimeout` -> `fanOut` -> rotta e' intero e
 * reale, e il budget della rotta e' piu' GENEROSO di quello del resolver, cosi'
 * che a classificare la risposta sia il fallimento del resolver e non la guardia
 * esterna.
 *
 * ── PERCHE' IL DIFETTO 2 HA DUE PROVE SEPARATE ────────────────────────────────
 * Il difetto era "nessuno sapeva nulla", e una prova sola non lo chiude: se ne
 * serve una che osserva la SCADENZA (un figlio che esce con `ETIMEDOUT`, e che
 * con `unref()` uscirebbe con 13 e zero byte) e una che osserva la PULIZIA (il
 * `finally` che libera la guardia quando la risposta arriva prima). La prima puo'
 * stare solo in un processo figlio, perche' `holdLoop` in questo file tiene vivo
 * il loop e mascherebbe il difetto; la seconda puo' stare in-process perche' non
 * riguarda il loop.
 *
 * `node:test` + `node:assert/strict`. Nessuna rete: le fonti sono iniettate.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { parseMetaId } from '../src/manifest.js';
import { resolveMovie, resolveSeries } from '../src/resolver.js';
import { createApiRoute } from '../src/routes/api.js';
import { createCatalogRoute, emittableKitsuId } from '../src/routes/catalog.js';
import { createStreamRoute } from '../src/routes/stream.js';
import { holdLoop } from '../test-helpers/hold-loop.mjs';

// Questo file e' quello che piu' dipende dal loop vivo: qui le tre fonti non
// rispondono MAI, quindi ogni classificazione 504 vs 500 dipende da una promise
// appesa che la scadenza deve sbloccare. Nei test non c'e' il socket che in
// produzione tiene aperto il ciclo, quindi se il loop drena la scadenza non
// arriva mai, la promise non si assesta e `node:test` cancella il resto del file
// con `# fail 0`.
//
// Per questo file la pompa e' un supporto, NON la prova: il contratto del timer si
// misura nei processi figli, che non importano questo helper e quindi non hanno
// niente che tenga vivo il ciclo se non la guardia stessa.
let releaseLoop = null;
before(() => {
  releaseLoop = holdLoop();
});
after(() => {
  releaseLoop?.();
  releaseLoop = null;
});

const execFileAsync = promisify(execFile);

const req = (url, method = 'GET') => ({ method, url, headers: { host: 'localhost' } });

/** Budget del resolver nei test: breve, perche' le fonti non rispondono MAI. */
const FAST_MS = 60;

// ---------------------------------------------------------------------------
// Finte
// ---------------------------------------------------------------------------

/** Una fonte che non risponde mai: la promise resta pendente per sempre. */
function stalled(id) {
  return {
    id,
    label: id,
    instance: { single: () => new Promise(() => {}), movie: () => new Promise(() => {}) },
  };
}

/** Una fonte che risponde con un errore vero (non un timeout). */
function http500(id) {
  return {
    id,
    label: id,
    instance: {
      single: async () => {
        throw new Error(`GET https://${id}.example/api -> HTTP 500 Internal Server Error`);
      },
      movie: async () => {
        throw new Error(`GET https://${id}.example/api -> HTTP 500 Internal Server Error`);
      },
    },
  };
}

const threeStalled = () => [stalled('animeworld'), stalled('animesaturn'), stalled('animeunity')];

/**
 * Il resolver REALE (`src/resolver.js`) con fonti iniettate: e' questo il
 * soggetto del test, non la rotta che lo avvolge.
 */
function realResolver(sources, timeoutMs = FAST_MS) {
  return {
    async resolveSeries(args) {
      return resolveSeries({ ...args, sources, timeoutMs });
    },
    async resolveMovie(args) {
      return resolveMovie({ ...args, sources, timeoutMs });
    },
  };
}

function fakeKitsu(results = []) {
  const calls = [];
  return {
    calls,
    async search(query, opts) {
      calls.push({ query, opts });
      return results;
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Un timeout di tutte le fonti e' un 504, non un 500
// ---------------------------------------------------------------------------

describe('timeout di tutte le fonti', () => {
  test('/stream/series risponde 504 upstream timeout', async () => {
    // timeoutMs della ROTTA volutamente 60 s: se fosse minore di 60 ms
    // risponderebbe la guardia di `stream.js` e il test misurerebbe quella.
    const handle = createStreamRoute({
      resolver: realResolver(threeStalled()),
      timeoutMs: 60_000,
    });
    const out = await handle(req('/stream/series/ku:12:954.json?title=Naruto'));
    assert.equal(out.status, 504);
    assert.deepEqual(out.body, { error: 'upstream timeout' });
  });

  test('/api/streams risponde 504 con lo stesso timeout reale', async () => {
    const handle = createApiRoute({ resolver: realResolver(threeStalled()), timeoutMs: 60_000 });
    const out = await handle(req('/api/streams?title=Naruto&episode=954'));
    assert.equal(out.status, 504);
    assert.deepEqual(out.body, { error: 'upstream timeout' });
  });

  test('resolveSeries rifiuta con code ETIMEDOUT e i tre label', async () => {
    await assert.rejects(
      () => resolveSeries({ title: 'Naruto', sources: threeStalled(), timeoutMs: FAST_MS }),
      (err) => {
        assert.equal(err.code, 'ETIMEDOUT');
        assert.match(err.message, /timeout 60 ms/);
        assert.equal(err.errors.length, 3);
        return true;
      },
    );
  });

  test('un guasto vero in mezzo ai timeout resta 500', async () => {
    // La classificazione di un errore NON-timeout non deve cambiare: un sito
    // rotto e' un guasto, e va detto come guasto. Solo "tutti in timeout" e' 504.
    const handle = createStreamRoute({
      resolver: realResolver([stalled('animesaturn'), http500('animeunity')]),
      timeoutMs: 60_000,
    });
    const out = await handle(req('/stream/series/ku:12:954.json?title=Naruto'));
    assert.equal(out.status, 500);
    assert.deepEqual(out.body, { error: 'internal error' });
  });

  test('una sola fonte in timeout non scatta nessuna classificazione', async () => {
    // Con `[{ rows }] ... [HTTP 500]` il risultato e' `[]` con `errors`, non un
    // errore: nessuna delle due fonti e' "tutte in timeout".
    const streams = await resolveSeries({
      title: 'Naruto',
      sources: [
        stalled('animesaturn'),
        { id: 'animeunity', label: 'AnimeUnity', instance: { single: async () => [] } },
      ],
      timeoutMs: FAST_MS,
    });
    assert.deepEqual([...streams], []);
    assert.equal(streams.errors.length, 1);
    assert.match(streams.errors[0], /animesaturn: timeout 60 ms/);
  });
});

// ---------------------------------------------------------------------------
// 2. raceTimeout: timer sganciato dal loop, label usato
// ---------------------------------------------------------------------------

describe('raceTimeout', () => {
  test('il messaggio porta il label della fonte e il suo budget', async () => {
    // NOTA: l'errore che questo test vede e' quello aggregato di `fanOut`, non
    // la rifiutazione per sorgente: `fanOut` tiene le ragioni come stringhe in
    // `errors`, quindi il `name` per-sorgente non e' osservabile da qui. Resta un
    // dato per i log, non un contratto, e non viene dichiarato un contratto che il
    // test non puo' verificare.
    await assert.rejects(
      () => resolveSeries({ title: 'X', sources: threeStalled(), timeoutMs: 45 }),
      (err) => {
        assert.equal(err.code, 'ETIMEDOUT');
        for (const id of ['animeworld', 'animesaturn', 'animeunity']) {
          assert.ok(
            err.errors.some((line) => line.includes(`timeout 45 ms (${id})`)),
            `label mancante per ${id}: ${JSON.stringify(err.errors)}`,
          );
        }
        return true;
      },
    );
  });

  test('la guardia referenziata consegna ETIMEDOUT anche senza ascolto', async () => {
    // Un processo vero, non `process.getActiveResourcesInfo()`: l'affermazione
    // riguarda il loop che resta acceso E la scadenza che deve essere consegnata,
    // e l'unica sonda onesta per le due cose e' un processo che esce.
    //
    // Il contratto e' INVERTITO rispetto alla versione precedente di questo test.
    // Il timer di `raceTimeout` e' referenziato: da solo tiene vivo il loop, quindi la
    // scadenza arriva e la classificazione viene consegnata. Con `unref()` questo
    // stesso figlio uscirebbe IMMEDIATAMENTE con codice 13 e stderr VUOTO — silenzioso,
    // senza `ETIMEDOUT` — che e' esattamente il difetto che il ref corregge.
    //
    // Nessuna pompa: il figlio importa solo `src/`, quindi l'unico handle possibile e'
    // la guardia. Budget volutamente piccolo (2 s) e margine di kill ampio (15 s): un
    // hang deve sembrare un KILL, non un passaggio lento.
    const CHILD_BUDGET_MS = 2_000;
    const KILL_AFTER_MS = 15_000;
    const resolverUrl = pathToFileURL(fileURLToPath(new URL('../src/resolver.js', import.meta.url))).href;
    const child = `
      import { resolveSeries } from '${resolverUrl}';
      const stalled = (id) => ({ id, label: id, instance: { single: () => new Promise(() => {}) } });
      resolveSeries({
        title: 'X',
        sources: [stalled('a'), stalled('b'), stalled('c')],
        timeoutMs: ${CHILD_BUDGET_MS},
      }).catch((err) => { process.stderr.write('CODE=' + err.code + '\\nMESSAGE=' + err.message); });
    `;
    const started = process.hrtime.bigint();
    let stdout;
    let stderr;
    try {
      ({ stdout, stderr } = await execFileAsync(process.execPath, ['--input-type=module', '-e', child], {
        timeout: KILL_AFTER_MS,
      }));
    } catch (err) {
      assert.fail(
        `il processo figlio non e' uscito: ${err.killed ? 'ucciso dal timeout (la guardia non ha consegnato)' : err.message}`,
      );
    }
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    // Arrivare qui senza passare dal `catch` significa gia' exit 0: `execFileAsync`
    // risolve solo su uscita pulita, e un figlio ucciso o abortito finirebbe nel fail.
    assert.equal(stdout, '', 'il figlio non deve scrivere su stdout');
    assert.ok(stderr.includes('CODE=ETIMEDOUT'), `classificazione assente: ${JSON.stringify(stderr)}`);
    // Il label per fonti, nella forma piena `timeout 2000 ms (a)`. Un semplice
    // `includes('a')` sarebbe VACUO: la 'a' compare anche in "nessuna fonte ha
    // risolto", quindi passerebbe anche senza alcun label.
    assert.ok(
      stderr.includes(`timeout ${CHILD_BUDGET_MS} ms (a)`),
      `label della fonte assente: ${JSON.stringify(stderr)}`,
    );
    // Ha ATTESO il budget (non e' uscito subito) e resta limitato (nessun hang).
    assert.ok(
      elapsedMs >= CHILD_BUDGET_MS,
      `uscito in ${elapsedMs.toFixed(0)} ms, prima del budget di ${CHILD_BUDGET_MS} ms`,
    );
    assert.ok(elapsedMs < KILL_AFTER_MS, `impiegato ${elapsedMs.toFixed(0)} ms`);
  });

  // ── LA PARTE OPPOSTA DELLO STESSO TIMER: esistere, e non restare appeso ───────
  // Il test precedente dimostra che il timer tiene vivo il loop. Questo dimostra
  // che viene comunque PULITO quando la risposta arriva prima: e' il `finally`
  // in `raceTimeout`, e senza di esso ogni risposta veloce lascerebbe un handle
  // pendente per l'intero budget di 25 s.
  //
  // Il percorso e' in-process e puo' esserlo: qui la prova non riguarda il loop,
  // quindi la pompa di `holdLoop` non la maschererebbe. I numeri sono misurati
  // (3 fonti -> 3 timer creati, 3 puliti, 0 pendenti).
  test('la guardia viene pulita quando la risposta arriva prima', async () => {
    const created = [];
    const cleared = new Set();
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    globalThis.setTimeout = (...args) => {
      const timer = realSetTimeout(...args);
      created.push(timer);
      return timer;
    };
    globalThis.clearTimeout = (timer) => {
      cleared.add(timer);
      return realClearTimeout(timer);
    };

    const row = (label) => ({ title: `N - Ep 12 [${label}]`, link: 'https://s.example/12.mp4', hash: '', seeders: 0, leechers: 0, type: 'http' });
    const fast = (id) => ({ id, label: id, instance: { single: async () => [row(id)] } });

    let streams;
    try {
      streams = await resolveSeries({ title: 'X', sources: [fast('a'), fast('b'), fast('c')] });
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }

    // Prima il percorso, poi il conto: senza questo, un resolver che non creasse
    // nessun timer farebbe passare `leaked === 0` senza aver provato nulla.
    assert.equal(streams.length, 3, `il percorso veloce non ha risolto: ${JSON.stringify(streams)}`);
    assert.equal(created.length, 3, `attesa una guardia per fonte, creati ${created.length} timer`);
    const leaked = created.filter((timer) => !cleared.has(timer));
    assert.deepEqual(leaked, [], `timer non puliti: ${leaked.length} su ${created.length}`);
  });

  // ── PERCHE' ANCHE QUI, IN UN FIGLIO, E NON IN-PROCESS ────────────────────────
  // Questo file chiama `holdLoop()` nel suo `before`, quindi UNA PROVA IN-PROCESS
  // PASSEREBBE ANCHE CON IL DIFETTO PRESENTE: la pompa `setImmediate` tiene vivo il
  // loop, la guardia `unref()` sembra funzionare e il test e' verde. Solo un vero
  // processo figlio, senza pompa e senza ascolto, distingue `ref` da `unref`.
  //
  // I due casi coprono i due lati del contratto, e sono entrambi numeri misurati:
  //
  //   budget ordinati   -> la risposta arriva e il PROCESSO ESCE SUBITO. Il
  //                        "non deve sopravvivere alla risposta" resta vero con il
  //                        ref, ed e' la proprieta' che conta in produzione.
  //   budget corto      -> la risposta arriva comunque, ma il timer ref'd del
  //                        resolver sopravvive e tiene il loop fino alla propria
  //                        scadenza. E' un hold LIMITATO e osservabile, non una
  //                        morte silenziosa: si asserisce come numero, non si augura.
  test('la rotta risponde e il figlio esce senza sopravvivere alla risposta', async () => {
    const CASES = [
      // rotta 5 s, resolver 1 s -> ordinati: nessun hold dopo la risposta.
      { name: 'ordinati', routeMs: 5_000, resolverMs: 1_000, expectLinger: false },
      // rotta 400 ms, resolver 3 s -> inversione: la rotta vince, il resolver tiene.
      { name: 'budget corto', routeMs: 400, resolverMs: 3_000, expectLinger: true },
    ];

    for (const { name, routeMs, resolverMs, expectLinger } of CASES) {
      const routeUrl = pathToFileURL(fileURLToPath(new URL('../src/routes/stream.js', import.meta.url))).href;
      const resolverUrl = pathToFileURL(fileURLToPath(new URL('../src/resolver.js', import.meta.url))).href;
      // Il resolver e' QUELLO VERO, non uno stub: il numero che tiene vivo il loop e'
      // il timer dentro `raceTimeout`, quindi se qualcuno rimette `unref()` questa
      // prova deve fallire. Uno stub con un `setTimeout` proprio avrebbe tenuto il
      // loop comunque e la prova sarebbe passata COL DIFETTO PRESENTE — ed e'
      // esattamente il buco che una verifica con il bug ripristinato ha mostrato.
      //
      // `?title=X` con `kitsu: null` evita il lookup del titolo: e' il percorso che
      // `src/routes/stream.js` documenta per essere testabile senza rete, e serve
      // perche' senza titolo il resolver vero restituirebbe `[]` senza mai scadere.
      // `res` non viene passato: l'handler restituisce l'envelope `{ status, body,
      // headers }` e non serve aprire una porta.
      const child = `
        import { createStreamRoute } from '${routeUrl}';
        import { resolveMovie, resolveSeries } from '${resolverUrl}';
        const t0 = process.hrtime.bigint();
        const ms = () => Number(process.hrtime.bigint() - t0) / 1e6;
        const stalled = (id) => ({ id, label: id, instance: { single: () => new Promise(() => {}), movie: () => new Promise(() => {}) } });
        const sources = [stalled('a'), stalled('b'), stalled('c')];
        const resolver = {
          resolveMovie: (q) => resolveMovie({ ...q, sources, timeoutMs: ${resolverMs} }),
          resolveSeries: (q) => resolveSeries({ ...q, sources, timeoutMs: ${resolverMs} }),
        };
        const req = { method: 'GET', url: '/stream/movie/ku:12.json?title=X', headers: { host: 'localhost' } };
        const route = createStreamRoute({ kitsu: null, resolver, timeoutMs: ${routeMs} });
        const envelope = await route(req);
        process.stdout.write('STATUS=' + envelope.status + ' at ' + ms().toFixed(0) + '\\n');
      `;
      const started = process.hrtime.bigint();
      let stdout;
      try {
        ({ stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', child], {
          timeout: routeMs + 15_000,
        }));
      } catch (err) {
        // Il difetto si manifesta QUI, non nelle asserzioni: il figlio esce con 13
        // e stdout vuoto, e `execFile` solleva. Senza questo `catch` il messaggio
        // sarebbe "Command failed" con lo script incollato dentro, che non dice
        // nulla sulla causa.
        assert.fail(
          `[${name}] il figlio non ha risposto: ${err.killed ? 'ucciso dal timeout' : `exit ${err.code}, stdout ${JSON.stringify(err.stdout ?? '')}`}`
            + ' — con unref() la guardia non tiene il loop e il figlio muore in silenzio',
        );
      }
      // Il tempo del padre E' la vita del figlio: nessun `process.on('exit')`, che
      // su pipe e' asincrono e puo' perdere la riga proprio nel momento che conta.
      const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
      const responseMs = Number(/STATUS=(\d+) at (\d+)/.exec(stdout)?.[2]);

      assert.match(stdout, /STATUS=504 at /, `[${name}] la rotta deve rispondere 504: ${JSON.stringify(stdout)}`);
      // La risposta arriva quando vince il GUARDIANO piu' corto, non il resolver.
      assert.ok(
        responseMs <= Math.min(routeMs, resolverMs) + 1_500,
        `[${name}] risposta a ${responseMs} ms, oltre il budget che doveva vincere`,
      );
      if (expectLinger) {
        // L'hold e' REALE e qui viene scritto come numero. Senza il ref questo figlio
        // uscirebbe con codice 13 e stdout VUOTO invece di 504: silenzioso.
        assert.ok(
          wallMs >= resolverMs * 0.5,
          `[${name}] atteso un hold fino a ~${resolverMs} ms, misurati ${wallMs} ms`,
        );
        assert.ok(wallMs < resolverMs + 10_000, `[${name}] hold illimitato: ${wallMs} ms`);
      } else {
        assert.ok(
          wallMs < resolverMs + 1_500,
          `[${name}] il processo ha sopravvissuto alla risposta: ${wallMs} ms`,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Il catalogo pubblica solo id che la rotta meta accetta
// ---------------------------------------------------------------------------

describe('catalog: id emittibili', () => {
  const MALFORMED = [
    { kitsuId: '', title: 'stringa vuota (era questa il buco)' },
    { kitsuId: 'abc', title: 'non numerico' },
    { kitsuId: '12.5', title: 'decimale' },
    { kitsuId: '12:13', title: 'con due punti' },
    { kitsuId: 'ku:12', title: 'gia prefissato' },
    { kitsuId: '0', title: 'zero' },
    { kitsuId: 0, title: 'zero numerico' },
    { kitsuId: null, title: 'null' },
    { kitsuId: undefined, title: 'undefined' },
    { title: 'campo assente' },
    null,
  ];

  test('una riga malformata non produce mai un id `ku:`', async () => {
    const kitsu = fakeKitsu([
      ...MALFORMED,
      { kitsuId: '12', title: 'Naruto' },
      { kitsuId: ' 13 ', title: 'One Piece' },
      { kitsuId: 14, title: 'Bleach' },
    ]);
    const out = await createCatalogRoute({ kitsu, timeoutMs: 1000 })(
      req('/catalog/anime/kitsu-anime.json'),
    );

    assert.equal(out.status, 200);
    // Nessun `id: "ku:"`, nessun 404 annunciato dal catalogo stesso.
    assert.ok(
      out.body.metas.every((meta) => !meta.id.endsWith(':')),
      `id senza numero pubblicato: ${JSON.stringify(out.body.metas.map((m) => m.id))}`,
    );
    // La proprieta' che conta: ogni id emesso e' risolvibile dal parser degli id,
    // quindi la rotta meta non puo' rispondere 404 su un id del catalogo.
    for (const meta of out.body.metas) {
      assert.ok(parseMetaId(meta.id), `parseMetaId ha rifiutato ${meta.id}`);
    }
    // Gli id validi sopravvivono, e `' 13 '` e' riparato in `ku:13` invece che perso.
    assert.deepEqual(out.body.metas.map((m) => m.id), ['ku:12', 'ku:13', 'ku:14']);
  });

  test('emittableKitsuId accetta solo interi >= 1', () => {
    for (const good of ['1', 12, ' 13 ']) {
      assert.equal(emittableKitsuId(good), String(good).trim(), `atteso accettato: ${String(good)}`);
    }
    for (const bad of ['', '  ', '0', 0, 'abc', '1.5', '-1', '1e3', '1_000', '12:13', null, undefined, {}]) {
      assert.equal(emittableKitsuId(bad), null, `atteso scartato: ${String(bad)}`);
    }
  });

  test('un catalogo vuoto resta un 200 con `metas: []`', async () => {
    const out = await createCatalogRoute({ kitsu: fakeKitsu([]), timeoutMs: 1000 })(
      req('/catalog/anime/kitsu-anime.json'),
    );
    assert.equal(out.status, 200);
    assert.deepEqual(out.body, { metas: [] });
  });
});

// ---------------------------------------------------------------------------
// 4. `extra` come segmento di path
// ---------------------------------------------------------------------------

describe('catalog: `extra` come segmento di path', () => {
  /** Esegue la rotta e restituisce status + la query che ha raggiunto Kitsu. */
  async function ask(url, results = []) {
    const kitsu = fakeKitsu(results);
    const out = await createCatalogRoute({ kitsu, timeoutMs: 1000 })(req(url));
    return {
      status: out.status,
      body: out.body,
      query: kitsu.calls[0]?.query,
      limit: kitsu.calls[0]?.opts?.limit,
    };
  }

  test('forma a segmento: e` questa che Stremio manda', async () => {
    const r = await ask('/catalog/anime/kitsu-anime/search=Naruto.json');
    assert.equal(r.status, 200);
    assert.equal(r.query, 'Naruto');
  });

  test('forma a query: continua a funzionare', async () => {
    const r = await ask('/catalog/anime/kitsu-anime.json?search=Naruto');
    assert.equal(r.status, 200);
    assert.equal(r.query, 'Naruto');
    // E la forma a segmento senza `.json`, che alcuni client mandano.
    assert.equal((await ask('/catalog/anime/kitsu-anime/search=Naruto')).query, 'Naruto');
  });

  test('entrambe insieme: vince il segmento, e il risultato e` deterministico', async () => {
    assert.equal((await ask('/catalog/anime/kitsu-anime/search=Segmento.json?search=Query')).query, 'Segmento');
    // Query vuota + segmento pieno: il segmento non viene svuotato.
    assert.equal((await ask('/catalog/anime/kitsu-anime/search=Segmento.json?search=')).query, 'Segmento');
    // Segmento vuoto + query piena: il segmento vuoto cade sulla query.
    assert.equal((await ask('/catalog/anime/kitsu-anime/search=.json?search=Naruto')).query, 'Naruto');
  });

  test('segmento malformato: ignorato, mai 500 e mai 404', async () => {
    for (const url of [
      '/catalog/anime/kitsu-anime/search.json', // nessun '='
      '/catalog/anime/kitsu-anime/Naruto.json', // nessun '='
      '/catalog/anime/kitsu-anime/=Naruto.json', // chiave vuota
      '/catalog/anime/kitsu-anime/.json', // segmento vuoto
      '/catalog/anime/kitsu-anime/search%E0%A4%A=Naruto.json', // % non decodificabile
    ]) {
      const r = await ask(url);
      assert.equal(r.status, 200, `status per ${url}`);
      assert.equal(r.query, '', `atteso browse per ${url}`);
    }
  });

  test('chiave sconosciuta: ignorata, il resto del segmento vale', async () => {
    const solo = await ask('/catalog/anime/kitsu-anime/skip=10.json');
    assert.equal(solo.status, 200);
    assert.equal(solo.query, '');

    const misto = await ask('/catalog/anime/kitsu-anime/skip=10&search=Naruto.json');
    assert.equal(misto.query, 'Naruto');
  });

  test('si divide DOPO: un `&` codificato dentro il valore non lo spezza', async () => {
    // E' il motivo per cui il segmento non viene decodificato prima di dividerlo:
    // decodificando tutto, `a%26b` diventerebbe `a` + spazzatura.
    assert.equal((await ask('/catalog/anime/kitsu-anime/search=a%26b.json')).query, 'a&b');
  });

  test('il PRIMO `=` separa: il resto resta nel valore', async () => {
    assert.equal((await ask('/catalog/anime/kitsu-anime/search=a=b.json')).query, 'a=b');
  });

  test('decodifica per valore, e `+` resta un `+` (non e` una query string)', async () => {
    assert.equal((await ask('/catalog/anime/kitsu-anime/search=Naruto%20Shippuden.json')).query, 'Naruto Shippuden');
    assert.equal((await ask('/catalog/anime/kitsu-anime/search=C%2B%2B.json')).query, 'C++');
    assert.equal((await ask('/catalog/anime/kitsu-anime/search=C++.json')).query, 'C++');
  });

  test('la chiave non e` case-sensitive, gli spazi sono rumore', async () => {
    assert.equal((await ask('/catalog/anime/kitsu-anime/Search=Naruto.json')).query, 'Naruto');
    assert.equal((await ask('/catalog/anime/kitsu-anime/search%20=Naruto.json')).query, 'Naruto');
  });

  test('il segmento non altera `limit` e il catalogo sconosciuto resta 404', async () => {
    const r = await ask('/catalog/anime/kitsu-anime.json?limit=5');
    assert.equal(r.limit, 5);
    assert.equal((await ask('/catalog/anime/kitsu-altro/search=Naruto.json')).status, 404);
    assert.equal((await ask('/catalog/movie/kitsu-anime/search=Naruto.json')).status, 404);
  });

  test('ricerca segmentata: i risultati arrivano filtrati come con la query', async () => {
    const kitsu = fakeKitsu([
      { kitsuId: '12', title: 'Naruto' },
      { kitsuId: '', title: 'rotta' },
    ]);
    const out = await createCatalogRoute({ kitsu, timeoutMs: 1000 })(
      req('/catalog/anime/kitsu-anime/search=Naruto.json'),
    );
    assert.equal(kitsu.calls[0].query, 'Naruto');
    assert.deepEqual(out.body.metas.map((m) => m.name), ['Naruto']);
  });
});