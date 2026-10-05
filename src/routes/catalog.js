/**
 * src/routes/catalog.js
 *
 * GET /catalog/anime/kitsu-anime/search=Naruto.json      (extra come SEGMENTO)
 * GET /catalog/anime/kitsu-anime/search.json?search=Naruto (forma a query)
 * GET /catalog/anime/kitsu-anime.json                      (browse, ricerca vuota)
 *
 * Risposta: `{ metas: [...] }`, sempre con la chiave presente anche quando
 * l'elenco e' vuoto -- un `{}` o un array nudo romperebbero il client, che si
 * aspetta l'oggetto.
 *
 * I due id che la rotta pubblica sono SEMPRE oneseguiti dal parser di
 * `src/manifest.js`: una riga di ricerca il cui `kitsuId` il parser rifiuterebbe
 * viene scartata, perche' `src/routes/meta.js` risponderebbe 404 a un id che
 * questo catalogo ha appena emesso.
 *
 * Le dipendenze sono iniettate. Questo modulo NON importa `./kitsu.js`: il
 * contratto congelato e' rispettato via il parametro `kitsu`, cosi' i test
 * girano con una finta.
 */

import {
  CATALOG_ID,
  CATALOG_TYPE,
  DEFAULT_LIMIT,
  DEFAULT_TIMEOUT_MS,
  errorToResponse,
  formatMetaId,
  jsonResponse,
  pathSegments,
  requestUrl,
  withTimeout,
} from '../manifest.js';

/**
 * Mette in forma un risultato di `kitsu.search` per il protocollo.
 * `episodeCount` puo' essere `null` e non viene mai esposto: mostrarlo come
 * numero fisso sarebbe un dato falso. Va nell'`overview` solo se c'e'.
 */
export function toMetaSummary(item) {
  const meta = {
    id: formatMetaId(item.kitsuId),
    type: item.type === 'movie' ? 'movie' : 'anime',
    name: item.title,
    poster: item.poster ?? null,
    description: null,
    year: item.year ?? null,
    genres: [],
  };
  const episodeCount = Number.isFinite(item.episodeCount) ? item.episodeCount : null;
  if (episodeCount && episodeCount > 0) {
    meta.description = `${episodeCount} episodi`;
  }
  return meta;
}

/**
 * Il Kitsu id che siamo disposti a mettere in un id del catalogo, o `null`.
 *
 * Il filtro precedente accettava qualsiasi cosa non-null: `kitsu.search`
 * (`src/kitsu.js:464`) fa `String(record?.id ?? '')`, quindi un record senza id
 * arrivava come stringa VUOTA, passava il filtro e produceva `formatMetaId('')`,
 * cioe' `id: "ku:"`. `isValidKitsuId` (`/^\d+$/`) lo rifiuta, `parseMetaId`
 * restituisce `null` e `src/routes/meta.js` rispondeva 404 per un id che questo
 * stesso addon aveva appena pubblicato. Un catalogo che annuncia id che la
 * propria rotta meta nega e' peggio di un catalogo incompleto: il client clicca
 * e riceve un 404 che non spiega nulla.
 *
 * Il guard e' gia' esistente sul lato video (`src/routes/meta.js:84` valida
 * `Number.isSafeInteger(Number(e.number)) && Number(e.number) >= 1`): qui ne
 * aggiungiamo l'equivalente simmetrico, e con lo stesso criterio — cioe' esattamente
 * cio' che `parseMetaId` accettera, senza lenire il criterio e senza fidarsi di
 * una riparazione che il parser rifarebbe diversamente.
 *
 * La normalizzazione e' `String(...).trim()`: uno spazio attorno all'id non cambia
 * l'id e perderebbe un titolo che il catalogo puo' legittimamente mostrare. Il
 * valore emesso e' quello normalizzato, mai quello grezzo.
 *
 * @param {unknown} value `record.kitsuId`
 * @returns {string|null}
 */
export function emittableKitsuId(value) {
  if (value === undefined || value === null) return null;
  const id = String(value).trim();
  return /^\d+$/.test(id) && Number(id) >= 1 ? id : null;
}

/**
 * Gli argomenti `extra` che Stremio manda, estratti dal 4° segmento del PATH.
 *
 * Il protocollo li manda come segmento, non come query:
 * `/catalog/anime/kitsu-anime/search=Naruto.json`. Ignorarli degradava in
 * silenzio una ricerca a un browse completo — 200 con la prima pagina, cioe'
 * l'aspetto giusto e il contenuto sbagliato, che e' peggio di un errore.
 *
 * Perche' `pathSegments(req)` NON viene usato qui: quel helper applica
 * `decodeURIComponent` all'intero segmento (vedi `src/manifest.js`), e
 * decodificare PRIMA di dividere corrompe i valori che contengono un `&`
 * codificato — `search=a%26b` diventerebbe la coppia `search=a` piu' una spazzatura
 * `b`. Quindi qui si prende `pathname` grezzo, si divide su `&`, si prende il
 * PRIMO `=` di ogni coppia, e solo POI si decodifica chiave e valore
 * singolarmente. Il resto del path (`type`, `id`) continua a passare da
 * `pathSegments`, dove la decodifica e' innocua.
 *
 * `+` NON diventa spazio: quello e' semantica di query string (`URLSearchParams`),
 * e qui il segmento e' un path segment, dove `+` e' un carattere legittimo di una
 * ricerca ("C++"). Decodificarlo sarebbe inventare una parola che l'utente non ha
 * scritto.
 *
 * @param {object} req
 * @returns {Map<string, string>} chiave (decodificata, minuscola) -> valore (decodificato)
 *
 * Le chiavi che questa rotta non conosce restano nella mappa e nessuno le legge:
 * `manifest.catalogs[].extra` dichiara solo `search`, quindi `skip=10` e
 * `genre=Action` vengono ignorati — mai un 500, mai un 404.
 */
function parseExtraSegment(req) {
  const out = new Map();
  const raw = requestUrl(req).pathname
    .split('/')
    .filter(Boolean)
    .map((s) => (s.endsWith('.json') ? s.slice(0, -5) : s))[3];
  if (typeof raw !== 'string' || !raw.includes('=')) return out;

  for (const pair of raw.split('&')) {
    if (!pair) continue; // `search=a&&skip=1`: la coppia vuota non e' un errore
    const eq = pair.indexOf('=');
    if (eq <= 0) continue; // nessun `=`, o chiave vuota: non e' una coppia
    // PRIMO `=`: `search=a=b` vale "a=b", non "a" con un resto ignorato.
    const decodedKey = decodeSegmentPart(pair.slice(0, eq));
    const value = decodeSegmentPart(pair.slice(eq + 1));
    // Chiave o valore non decodificabile, o gia' presente: ignorati. Nessuna
    // delle due cose e' un errore del client, e nessuna deve diventare un 500.
    if (decodedKey === null || value === null) continue;
    // Chiave normalizzata: il manifest dichiara `search` e Stremio lo ripete
    // letterale, ma `Search=` non deve diventare una chiave sconosciuta.
    const key = decodedKey.trim().toLowerCase();
    if (!key || out.has(key)) continue;
    out.set(key, value);
  }
  return out;
}

/**
 * `decodeURIComponent` che non tira: un `%` non valido (`%E0%A4%A`) renderebbe
 * `search=Naruto%E0%A4%A` un errore di sintassi, e la risposta giusta a una
 * richiesta malformata qui e' ignorare l'argomento, non fallire.
 * @param {string} part
 * @returns {string|null}
 */
function decodeSegmentPart(part) {
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
}

export function createCatalogRoute({ kitsu, timeoutMs = DEFAULT_TIMEOUT_MS, limit = DEFAULT_LIMIT } = {}) {
  if (!kitsu || typeof kitsu.search !== 'function') {
    throw new TypeError('createCatalogRoute: serve `kitsu.search`');
  }

  return async function handleCatalog(req, res) {
    const segments = pathSegments(req);
    // ['catalog','anime','kitsu-anime'] o ['catalog','anime','kitsu-anime','search=Naruto']
    const [, type, id] = segments;
    if (type !== CATALOG_TYPE || id !== CATALOG_ID) {
      return jsonResponse(res, 404, { error: 'unknown catalog' });
    }

    const url = requestUrl(req);
    // PRECEDENZA, regola deterministica: il segmento di path vince su
    // `?search=`, e un segmento che non produce una ricerca non vuota cade sulla
    // query. Il motivo e' che il segmento e' la forma che il client Stremio
    // invia davvero per un `extra` dichiarato nel manifest, mentre `?search=` e'
    // una forma nostra, comoda per `curl`. Se vincesse la query, un proxy che
    // appende un `?search=` di suo percorso romperebbe la ricerca su ogni
    // catalogo che il client ha gia' filtrato — in silenzio, e con l'aspetto di
    // un catalogo che funziona.
    const extra = parseExtraSegment(req);
    const segmentSearch = (extra.get('search') ?? '').trim();
    const querySearch = (url.searchParams.get('search') ?? '').trim();
    const search = segmentSearch || querySearch;
    const requestedLimit = Number.parseInt(url.searchParams.get('limit') ?? '', 10);

    try {
      const results = await withTimeout(
        kitsu.search(search, { limit: Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : limit }),
        timeoutMs,
        'kitsu.search',
      );
      const metas = [];
      for (const record of Array.isArray(results) ? results : []) {
        const kitsuId = record ? emittableKitsuId(record.kitsuId) : null;
        // Riga scartata, non riparata a tentativi: un id che `parseMetaId`
        // rifiuterebbe verrebbe comunque pubblicato come 404 dalla rotta meta.
        if (kitsuId === null) continue;
        metas.push(toMetaSummary({ ...record, kitsuId }));
      }
      return jsonResponse(res, 200, { metas });
    } catch (err) {
      return errorToResponse(err, res, (kind) => process.stderr.write(`[catalog] ${kind}\n`));
    }
  };
}
