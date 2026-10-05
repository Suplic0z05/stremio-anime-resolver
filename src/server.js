/**
 * src/server.js -- punto di composizione.
 *
 * Unico file che importa `./kitsu.js` e `./resolver.js`. Tutte le route
 * ricevono le dipendenze per iniezione, quindi qui basta cablare:
 *
 *   kitsu.search / kitsu.meta       -> catalog, meta, stream (per il titolo)
 *   resolver.resolveSeries/Movie    -> stream
 *
 * Gli import statici vivono SOLO qui, perche' questo e' il punto in cui le
 * dipendenze reali diventano disponibili: se fossero dentro le rotte, un test
 * con finte non potrebbe importarle senza tirare dentro i moduli veri.
 *
 * Nessun `listen` all'import: il server si avvia solo se questo file e' il
 * punto d'ingresso del processo, cosi' importarlo per ispezionarlo non occupa
 * una porta.
 */

import http from 'node:http';
import { pathToFileURL } from 'node:url';

import {
  DEFAULT_TIMEOUT_MS,
  createLogger,
  internalErrorResponse,
  jsonResponse,
  pathSegments,
  preflightResponse,
} from './manifest.js';
import { createManifestRoute } from './manifest.js';
import { createCatalogRoute } from './routes/catalog.js';
import { createMetaRoute } from './routes/meta.js';
import { createStreamRoute } from './routes/stream.js';
import { createApiRoute } from './routes/api.js';

// --- dipendenze reali: l'unico punto del codice che le conosce ---
import * as kitsuModule from './kitsu.js';
import * as resolverModule from './resolver.js';

export const DEFAULT_PORT = 7000;
export const DEFAULT_HOST = '127.0.0.1';

function resolveDeps(deps) {
  const kitsu = deps.kitsu ?? kitsuModule.default ?? kitsuModule;
  const resolver = deps.resolver ?? resolverModule.default ?? resolverModule;
  return { kitsu, resolver };
}

export function createAddonRoutes(deps = {}) {
  const { kitsu, resolver } = resolveDeps(deps);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    manifest: createManifestRoute(),
    catalog: createCatalogRoute({ kitsu, timeoutMs }),
    meta: createMetaRoute({ kitsu, timeoutMs }),
    stream: createStreamRoute({ kitsu, resolver, timeoutMs }),
    // Deliberately NOT advertised in the manifest. This is a plain JSON surface
    // for non-Stremio clients (Kodi, MPV, curl, a browser extension); a Stremio
    // client that saw it in the manifest would try to drive it as a resource.
    api: createApiRoute({ resolver, timeoutMs }),
  };
}

/**
 * Traduce un throw che ha gia' rotto la risposta in "chiudi la connessione".
 *
 * Se `writeHead` e' passato non si puo' piu' cambiare lo status: riscrivere
 * gli header lancerebbe `ERR_HTTP_HEADERS_SENT`, quindi l'unica cosa onesta e'
 * chiudere. Non e' un caso teorico: un throw a meta' di uno stream di scrittura
 * lascia il client con una risposta troncata ma con uno status 200 gia'
 * partito, e l'unica alternativa sarebbe mentire sullo status.
 */
function endAfterPartialWrite(res, req, err, log) {
  log('error', 'dispatch_throw_after_write', {
    message: err instanceof Error ? err.message : String(err),
    method: req?.method,
    path: String(req?.url ?? '').split('?')[0],
  });
  try {
    res.end();
  } catch {
    // Connessione gia' chiusa dal client: non c'e' piu' niente da chiudere.
  }
}

/**
 * IL WRAPPER DEL DISPATCH -- perche' `onRequest` NON e' `async`.
 *
 * Node **non awaita** la promise restituita da un listener di `http.createServer`:
 * la chiama, ci butta dentro il risultato e va avanti. Quindi `async function`
 * come listener non e' "un handler che puo' fallire", e' un handler che puo'
 * **uccidere il processo**: il rejection non ha nessun handler, diventa
 * `unhandledRejection`, e da Node 15 il default di `unhandled-rejections` e'
 * `throw`, cioe' terminazione.
 *
 * Misurato su questo host (Node v26.10.0), con un listener `async` che fa
 * `throw new Error(...)`: nessuna risposta al client, socket appeso per sempre,
 * e processo terminato con exit 1. Nota che `process.on('unhandledRejection')`
 * **maschera** la morte (sostituisce il default `throw`): con quel listener
 * installato il processo sopravvive, ma il client non riceve MAI una risposta e
 * la connessione resta appesa. Quindi "il processo sopravvive" non e' un
 * verdetto: e' una condizione che si ottiene spegnendo il sintomo senza
 * sistemare la causa.
 *
 * `dispatch` resta `async` (deve poter awaitare gli handler); cambia solo cosa
 * viene passato a `http.createServer`, che e' una funzione che attacha un
 * `.catch` e **restituisce comunque la promise**, cosi' un test che fa
 * `await listener(req, res)` continua a osservare il completamento
 * dell'handler come prima.
 */
export function createRequestListener({ routes, log = createLogger() } = {}) {
  async function dispatch(req, res) {
    const startedAt = process.hrtime.bigint();
    const url = req.url ?? '/';

    const finish = (status) => {
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      log('info', 'request', {
        method: req.method,
        path: url.split('?')[0],
        status,
        ms: ms.toFixed(1),
      });
    };

    // Preflight su QUALSIASI path, anche uno sconosciuto: se il server
    // rispondesse 404 senza gli header CORS, il browser non mostrerebbe nemmeno
    // il motivo del fallimento.
    if (req.method === 'OPTIONS') {
      const out = preflightResponse(res);
      finish(out.status);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const out = jsonResponse(res, 405, { error: 'method not allowed' });
      finish(out.status);
      return;
    }

    const segments = pathSegments(req);

    if (url.split('?')[0] === '/health' || segments[0] === 'health') {
      const out = jsonResponse(res, 200, { ok: true });
      finish(out.status);
      return;
    }

    const [resource] = segments;
    let result;
    if (resource === 'manifest') {
      result = await routes.manifest(req, res);
    } else if (resource === 'catalog') {
      result = await routes.catalog(req, res);
    } else if (resource === 'meta') {
      result = await routes.meta(req, res);
    } else if (resource === 'stream') {
      result = await routes.stream(req, res);
    } else if (resource === 'api' && typeof routes.api === 'function') {
      result = await routes.api(req, res);
    } else {
      result = jsonResponse(res, 404, { error: 'not found' });
    }

    finish(result?.status ?? 200);
  }

  /**
   * Dispatcher: metodo, path, status e durata su stderr, niente body.
   * Il CORS e' gia' dentro `jsonResponse`/`preflightResponse`, quindi anche
   * l'errore 404 finale lo porta.
   */
  return function onRequest(req, res) {
    const settled = dispatch(req, res);
    // Qui e' il punto in cui il throw diventa una risposta 500 invece di una
    // terminazione. `pathSegments` e `requestUrl` stanno FUORI dal try dei
    // handler (`routes/catalog.js`, `routes/meta.js`), quindi sono esattamente
    // il genere di regressione che questa riga rende osservabile.
    settled.catch((err) => {
      if (res && (res.headersSent || res.writableEnded)) {
        endAfterPartialWrite(res, req, err, log);
        return;
      }
      log('error', 'dispatch_throw', {
        message: err instanceof Error ? err.message : String(err),
        method: req?.method,
        path: String(req?.url ?? '').split('?')[0],
      });
      internalErrorResponse(res, log);
    });
    return settled;
  };
}

export function createAddonServer(deps = {}) {
  const log = deps.log ?? createLogger();
  const routes = createAddonRoutes(deps);
  return http.createServer(createRequestListener({ routes, log }));
}

const isEntrypoint = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  const port = Number.parseInt(process.env.PORT ?? '', 10) || DEFAULT_PORT;
  const host = process.env.HOST || DEFAULT_HOST;
  const server = createAddonServer();
  server.listen(port, host, () => {
    process.stderr.write(`[server] listening on http://${host}:${port}\n`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
