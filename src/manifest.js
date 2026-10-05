/**
 * src/manifest.js
 *
 * Quasi-modulo foglia: l'unico import e' `./variant.js`, che a sua volta non ha
 * import ne' effetti collaterali, quindi qui non compare alcun ciclo. Contiene
 * due cose che condividono la stessa natura -- il contratto del protocollo
 * Stremio.
 *
 *   1. il manifest dell'addon;
 *   2. le primitive di trasporto (CORS, envelope JSON, timeout), lo SCHEMA DEGLI
 *      ID, che qui e' definito una volta sola e riusato da tutte le route, e la
 *      proiezione delle righe verso l'oggetto `Stream` di Stremio.
 *
 * Perche' lo schema degli id vive qui e non in `routes/meta.js`: sia meta.js
 * (che genera gli id dei video) sia stream.js (che li deve estrarre) hanno
 * bisogno della stessa regex. Tenerla in un unico punto evita sia il ciclo con
 * `src/server.js` sia la duplicazione della regex in due file.
 *
 * ---------------------------------------------------------------------------
 * SCHEMA DEGLI ID -- perche' sono nostri e non quelli di Cinemeta
 * ---------------------------------------------------------------------------
 *
 * I formati sono due, e nient'altro li produce:
 *
 *   catalogo / meta :  ku:<kitsuId>              es.  ku:12
 *   video           :  ku:<kitsuId>:<numero>     es.  ku:12:954
 *
 * Il terzo segmento di un id video e' il **numero ASSOLUTO dell'episodio nel
 * sito**, non l'indice dentro una stagione.
 *
 * Il motivo per cui questo e' un punto architetturale e non una scelta di
 * comodo: se ci appoggiassimo agli id IMDb di Cinemeta, l'id
 * `tt0388629:21:1` significherebbe "stagione 21, episodio 1". Ma il
 * partizionamento IMDb non e' quello del sito di riferimento: Naruto tiene tutti
 * i suoi 227 episodi in `season: 0`, e One Piece ha 24 stagioni sproporzionate
 * rispetto all'ordine reale. Un client che legge `season` e ricostruisce da li'
 * il numero assoluto sbaglia su una parte enorme del catalogo, in silenzio,
 * e l'errore e' invisibile perche' l'id sembra perfettamente valido.
 *
 * Emettendo noi il numero assoluto, quella interpretazione non e' nemmeno
 * disponibile: non esiste piu' un campo `season` da cui ricostruire, e l'id
 * resta l'unica fonte di verita. Per questo `meta.videos[].season` viene
 * emesso come `null` invece di tentare una partizione: un `null` non e'
 * interpretabile, quindi nessun client puo' inventare una season.
 *
 * `idPrefixes: ["ku"]` e non `tt`: Cinemeta cataloga solo `movie`/`series` con
 * prefisso `tt` e non contiene gli anime, quindi un id `tt` non porterebbe mai
 * a un risultato reale per questo catalogo.
 *
 * ---------------------------------------------------------------------------
 * CORS
 * ---------------------------------------------------------------------------
 * `Access-Control-Allow-Origin: *` e' su OGNI risposta, anche di errore, e lo
 * mette `jsonResponse()`, che e' l'unico modo di produrre una risposta in questo
 * addon. Un 404 senza CORS fallisce nel browser come un 500: per la richiesta
 * cross-origin sono indistinguibili. Per lo stesso motivo `behaviorHints.ingest`
 * NON e' presente da nessuna parte (vedi `MANIFEST`): imporre il player esterno
 * peggiora il risultato, Stremio riproduce da solo l'URL HTTPS gia' risolto.
 */

// Un solo import, e non e' un'infrastruttura: e' il vocabolario dub/sub che
// `routes/stream.js` NON puo' reimplementare, perche' la proiezione verso
// l'oggetto `Stream` vive qui dentro `normalizeStreams()` e deve dire la stessa
// cosa che dice `routes/api.js`. Due copie dello stesso vocabolario in due
// proiezioni diverse divergono, e la divergenza qui sarebbe invisibile: la
// riga Stremio mostrerebbe "ITA DUB" mentre l'API risponderebbe `sub`.
import {
  VARIANT_DUB,
  VARIANT_SUB,
  detectVariant,
  variantLabel,
} from './variant.js';

export const ADDON_ID = 'com.suplic0z.stremio-anime-resolver';
export const ADDON_NAME = 'Anime Resolver (Kitsu)';
export const ADDON_VERSION = '0.1.0';
export const ADDON_DESCRIPTION =
  'Catalogo anime su Kitsu con stream HTTPS gia risolti. Nessun playback esterno.';

export const ID_PREFIX = 'ku';
export const CATALOG_TYPE = 'anime';
export const CATALOG_ID = 'kitsu-anime';
export const CATALOG_NAME = 'Anime (Kitsu)';
export const LOGO_URL =
  'https://raw.githubusercontent.com/Stremio/stremio-brand/master/logos/logo-small.png';
export const BACKGROUND_URL =
  'https://raw.githubusercontent.com/Stremio/stremio-brand/master/logos/background.png';

/** Budget per una singola dipendenza (kitsu / resolver) prima del 504. */
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_LIMIT = 20; // tetto paginazione Kitsu: page[limit] > 20 risponde HTTP 400

/**
 * Manifest dell'addon. Notare l'assenza di `behaviorHints.ingest`: vedi la
 * nota in testa al file.
 */
export const MANIFEST = Object.freeze({
  id: ADDON_ID,
  name: ADDON_NAME,
  version: ADDON_VERSION,
  description: ADDON_DESCRIPTION,
  logo: LOGO_URL,
  background: BACKGROUND_URL,
  resources: ['catalog', 'meta', 'stream'],
  types: ['anime', 'series', 'movie'],
  idPrefixes: [ID_PREFIX],
  // `extra` dichiarato perche' la rotta /catalog lo implementa gia' (legge
  // `search`). Senza questa dichiarazione il client non chiede mai la ricerca:
  // Kitsu ha ~22k titoli e /catalog ne restituisce 20, quindi la ricerca e'
  // l'unico modo per raggiungere il resto. La rotta accetta sia la forma a
  // path segment (`/catalog/anime/kitsu-anime/search=Naruto.json`) sia la query
  // (`?search=Naruto`).
  catalogs: [{
    type: CATALOG_TYPE,
    id: CATALOG_ID,
    name: CATALOG_NAME,
    extra: [{ name: 'search', isRequired: false }],
  }],
  behaviorHints: { configurable: false },
});

// ---------------------------------------------------------------------------
// SCHEMA DEGLI ID
// ---------------------------------------------------------------------------

// `[^:]+` come id Kitsu: nessun due punti, cosi' il confine fra i segmenti
// dell'id e' ambiguo in nessun caso.
const META_ID_RE = new RegExp(`^${ID_PREFIX}:(\\d+)$`);
const VIDEO_ID_RE = new RegExp(`^${ID_PREFIX}:(\\d+):(\\d+)$`);

/**
 * I Kitsu id sono interi positivi. Validarli qui significa che un id come
 * `ku:abc` non raggiunge mai Kitsu: a monte risponderebbe 400 e, senza questa
 * guardia, un id malformato arriverebbe al client come 500 dell'addon invece
 * che come 404. Il tipo resta stringa per non rompere il contratto che
 * `kitsu.js` e le route si scambiano gia' da prima.
 */
function isValidKitsuId(raw) {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return false;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 1;
}

/** `ku:12` -> `ku:12`; `ku:12:954` -> null. */
export function parseMetaId(raw) {
  if (typeof raw !== 'string') return null;
  const m = META_ID_RE.exec(raw.trim());
  if (!m || !isValidKitsuId(m[1])) return null;
  return { kitsuId: m[1] };
}

/** `ku:12:954` -> `{ kitsuId:'12', number:954 }`; `ku:12` -> null. */
export function parseVideoId(raw) {
  if (typeof raw !== 'string') return null;
  const m = VIDEO_ID_RE.exec(raw.trim());
  if (!m || !isValidKitsuId(m[1])) return null;
  const number = Number.parseInt(m[2], 10);
  // 0 e negativo non sono numeri di episodio ammessi: meglio un 404 esplicito
  // che passare `episode: 0` al resolver e ottenere risultati inventati.
  if (!Number.isSafeInteger(number) || number < 1) return null;
  return { kitsuId: m[1], number };
}

export function formatMetaId(kitsuId) {
  return `${ID_PREFIX}:${String(kitsuId)}`;
}

export function formatVideoId(kitsuId, number) {
  return `${ID_PREFIX}:${String(kitsuId)}:${String(number)}`;
}

/**
 * Numero di episodio assoluto ricavato da un id video.
 * Esportato con nome esplicito perche' e' il punto dove una sbagliata
 * interpretazione dell'id produce un errore invisibile.
 */
export function episodeNumberFromVideoId(raw) {
  const parsed = parseVideoId(raw);
  return parsed ? parsed.number : null;
}

// ---------------------------------------------------------------------------
// PRIMITIVE DI TRASPORTO
// ---------------------------------------------------------------------------

export class TimeoutError extends Error {
  constructor(ms, label) {
    super(`timeout after ${ms}ms: ${label}`);
    this.name = 'TimeoutError';
    this.code = 'ETIMEDOUT';
  }
}

/**
 * Promessa con budget. Il timer viene sempre pulito, quindi una risposta lenta
 * che arriva dopo il timeout non lascia il processo appeso.
 */
export function withTimeout(promise, ms = DEFAULT_TIMEOUT_MS, label = 'dependency') {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(ms, label)), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([Promise.resolve(promise), guard]).finally(() => clearTimeout(timer));
}

export function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
    'Access-Control-Max-Age': '86400',
  };
}

/**
 * Envelope di una risposta JSON. Unico punto di uscita di tutte le route.
 *
 * `res` e' opzionale: se presente (un `http.ServerResponse`) riceve la
 * scrittura; in ogni caso viene restituito `{ status, body, headers }`, cosi'
 * lo stesso handler e' testabile senza aprire una porta.
 */
export function jsonResponse(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body ?? {});
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': status >= 400 ? 'no-store' : 'public, max-age=300',
    ...corsHeaders(),
    ...extraHeaders,
  };
  if (res && typeof res.writeHead === 'function') {
    res.writeHead(status, headers);
    res.end(payload);
  }
  return { status, body, headers, payload };
}

/** Risposta di preflight, senza body. */
export function preflightResponse(res) {
  const headers = { ...corsHeaders(), 'Content-Length': '0', 'Cache-Control': 'no-store' };
  if (res && typeof res.writeHead === 'function') {
    res.writeHead(204, headers);
    res.end();
  }
  return { status: 204, body: null, headers };
}

/** 500 senza stack trace: il dettaglio va su stderr, non al client. */
export function internalErrorResponse(res, log) {
  if (typeof log === 'function') log('internal_error');
  return jsonResponse(res, 500, { error: 'internal error' });
}

/** 504 esplicito quando una dipendenza sfora il budget. */
export function gatewayTimeoutResponse(res, log) {
  if (typeof log === 'function') log('upstream_timeout');
  return jsonResponse(res, 504, { error: 'upstream timeout' });
}

/**
 * Traduce un'eccezione in risposta HTTP senza esporre dettagli interni.
 *
 * `notFound` permette a ogni route di dichiarare il proprio corpo 404: la
 * risorsa `stream` deve restituire `{"streams":[]}`, non un oggetto errore,
 * altrimenti Stremio non la legge come "nessun risultato".
 */
export function errorToResponse(err, res, log, notFound) {
  if (err instanceof TimeoutError || err?.code === 'ETIMEDOUT') {
    return gatewayTimeoutResponse(res, log);
  }

  // Un 400/404 a monte significa "id inesistente" o "id non valido", non un
  // guasto dell'addon: mapparlo su 500 dichiarerebbe una causa falsa. Un 5xx o
  // un errore di rete restano 500 di proposito, perche' un'interruzione
  // di Kitsu deve restare visibile invece di becoming un catalogo vuoto.
  if (err?.status === 400 || err?.status === 404) {
    if (typeof log === 'function') log('upstream_not_found');
    if (typeof notFound === 'function') return notFound(res);
    return jsonResponse(res, 404, { error: 'not found' });
  }

  return internalErrorResponse(res, log);
}

// ---------------------------------------------------------------------------
// HELPERS PER LE ROUTE
// ---------------------------------------------------------------------------

/** Log minimale su stderr: metodo, path, status, durata. Mai il body. */
export function createLogger({ quiet = process.env.ADDON_QUIET_LOG === '1' } = {}) {
  return function log(level, message, fields = {}) {
    if (quiet) return;
    const parts = [`[${level}]`, message];
    for (const [k, v] of Object.entries(fields)) parts.push(`${k}=${v}`);
    process.stderr.write(`${parts.join(' ')}\n`);
  };
}

export function requestUrl(req) {
  const raw = typeof req?.url === 'string' ? req.url : '/';
  const base = req?.headers?.host ? `http://${req.headers.host}` : 'http://localhost';
  try {
    return new URL(raw, base);
  } catch {
    return new URL('/', base);
  }
}

/** Segmenti del path senza slash iniziale e senza `.json`. */
export function pathSegments(req) {
  const pathname = requestUrl(req).pathname;
  return pathname
    .split('/')
    .filter(Boolean)
    .map((s) => (s.endsWith('.json') ? s.slice(0, -5) : s))
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
}

/**
 * Estrattore di altezza per ordinare gli stream per qualita'. Accetta
 * `height` numerico, `quality`/`resolution` come stringa ("1080p", "1920x1080"),
 * il testo leggibile di `name`/`description` e, come ultima risorsa, l'URL.
 * Quando nessuna di queste contiene un numero riconoscibile restituisce 0:
 * l'ordinamento e' stabile, quindi gli stream senza qualita' dichiarata
 * restano nell'ordine restituito dalle fonti invece di essere mescolati a caso.
 *
 * L'ordine delle TRE fonti non e' decorativo, e in particolare l'URL viene letto
 * per ULTIMO, mai sopra un campo dichiarato: rileggere un fiuto nell'URL al
 * posto di un'affermazione esplicita della fonte significa sostituire un dato
 * che qualcuno ha dichiarato con una coincidenza, ed e' il modo di ordinare
 * sotto una qualita' che la fonte conosceva. Una fonte che dichiara
 * `height: 0` ottiene 0 e non viene ripescata sotto.
 *
 * Il terzo passaggio esiste perche' e' l'unico che funziona sui dati reali: gli
 * scraperi dichiarano la qualita' nel NOME DEL FILE (`/720p.mp4`, `_Full_HD/`)
 * e non compilano nessun campo, quindi senza URL ogni riga di questa addon
 * riportava `height: 0` e l'ordinamento non ordinava nulla.
 *
 * Nota sul campo letto nel testo: `description` per primo, con `title` come
 * riserva perche' `streamQualityHeight` non serve una sola proiezione (vedi il
 * commento accanto al ciclo qui sotto). Se `title` sparisse del tutto, qui
 * l'ordinamento diventerebbe dipendente da un campo che la proiezione non emette,
 * cioe' silenziosamente 0.
 */
export function streamQualityHeight(stream) {
  if (!stream || typeof stream !== 'object') return 0;
  if (typeof stream.height === 'number' && Number.isFinite(stream.height)) return stream.height;
  if (typeof stream.quality === 'number' && Number.isFinite(stream.quality)) return stream.quality;
  if (typeof stream.resolution === 'number' && Number.isFinite(stream.resolution)) return stream.resolution;

  // `resolution` e un campo dichiaratamente numerico: un numero nudo ("720",
  // "1080") li' e un'altezza, anche senza il suffisso 'p'. Cercarlo anche in
  // `name`/`description` produrrebbe falsi positivi (un titolo come "Episodio
  // 954"), quindi il numero nudo e' accettato solo dove il campo lo dichiara.
  //
  // The lookahead excludes `x`/`×`: without it a resolution pair like
  // "1920x1080" matched the bare branch first and returned the WIDTH (1920) as
  // the height, which then sorted above a real 1080p stream. The pair form is
  // handled by the `WxH` branch below, where the height is group 2.
  const declared = [stream?.quality, stream?.resolution]
    .filter((v) => typeof v === 'string')
    .join(' ');
  const bare = declared.match(/(?:^|\D)(\d{3,4})(?![\dx×])(?:\D|$)/);
  if (bare) return Number.parseInt(bare[1], 10);

  // Campo per campo e non concatenati in un unico haystack: altrimenti un nome
  // che finisce con un numero e una description che inizia con `p` potrebbero
  // formare insieme una qualita' che nessuno dei due dichiara.
  //
  // `title` c'entra perche' questa funzione non serve una sola proiezione:
  // `routes/api.js` la chiama sulle righe GREZZE del resolver (che portano
  // `name` e `title`), mentre `routes/stream.js` la chiama sulle righe emesse da
  // `normalizeStreams()` (che portano `name` e `description`). Sono lo stesso dato
  // in due forme diverse, e leggerne una sola farebbe perdere di nascosto la
  // qualita' a chi non usa la proiezione Stremio. `description` resta prima di
  // `title` perche' e' il campo che il protocollo Stremio definisce.
  const textHeight = (value) => {
    if (typeof value !== 'string' || !value) return null;
    const res = value.match(/(\d{3,4})\s*[x×]\s*(\d{3,4})/i);
    if (res) return Number.parseInt(res[2], 10);
    const p = value.match(/(\d{3,4})\s*p\b/i);
    return p ? Number.parseInt(p[1], 10) : null;
  };
  const fromText =
    textHeight(stream.name) ?? textHeight(stream.description) ?? textHeight(stream.title);
  if (fromText !== null) return fromText;

  return urlHeight(stream.url);
}

/**
 * Marche di qualita' riconosciute nell'URL, dalla piu' alta alla piu' bassa, e
 * vince il PRIMO match: un URL che ne contiene piu' di una viene letto come la
 * qualita' piu' alta presente. Su una singola riga il caso non si presenta,
 * quindi l'ordine serve solo a non dover spiegare quale dei due comanda.
 *
 * `scope: 'path'` = letto solo nel path. I numeri nudi sono vincolati a
 * quello perche' la query porta i token firmati degli scraperi e un `480`
 * dentro un token e' una coincidenza, mentre un `/480/` in un path e' una
 * scelta. Le forme con suffisso (`720p`) e le parole (`Full_HD`, `FHD`) sono
 * invece cercate in tutto l'URL: sono esse stesse a dichiarare la qualita', e
 * `?quality=720p` e' una forma reale di dichiarazione.
 *
 * I confini non alfanumerici su entrambi i lati servono a non leggere una
 * qualita' dentro un identificatore (`ep1080`, `abc720def`): un numero che fa
 * parte di una parola non e' una dichiarazione.
 */
const URL_HEIGHT_TOKENS = [
  { height: 1080, scope: 'any', re: /(?:^|[^0-9a-z])1080p(?![0-9a-z])/i },
  { height: 1080, scope: 'any', re: /(?:^|[^0-9a-z])full[_-]?hd(?![0-9a-z])/i },
  { height: 1080, scope: 'any', re: /(?:^|[^0-9a-z])fhd(?![0-9a-z])/i },
  { height: 1080, scope: 'path', re: /(?:^|[^0-9a-z])1080(?![0-9a-z])/i },
  { height: 720, scope: 'any', re: /(?:^|[^0-9a-z])720p(?![0-9a-z])/i },
  { height: 720, scope: 'path', re: /(?:^|[^0-9a-z])720(?![0-9a-z])/i },
  { height: 480, scope: 'any', re: /(?:^|[^0-9a-z])480p(?![0-9a-z])/i },
  { height: 480, scope: 'path', re: /(?:^|[^0-9a-z])480(?![0-9a-z])/i },
  { height: 360, scope: 'any', re: /(?:^|[^0-9a-z])360p(?![0-9a-z])/i },
  { height: 360, scope: 'path', re: /(?:^|[^0-9a-z])360(?![0-9a-z])/i },
];

/** Altezza letta dall'URL, o 0 se l'URL non dichiara niente. */
function urlHeight(value) {
  if (typeof value !== 'string' || !value) return 0;
  const cut = value.search(/[?#]/);
  const path = cut === -1 ? value : value.slice(0, cut);
  for (const { height, scope, re } of URL_HEIGHT_TOKENS) {
    if (scope === 'path' ? re.test(path) : re.test(value)) return height;
  }
  return 0;
}

/** Ordina per qualita' decrescente, stabile a parita'. */
export function sortStreamsByQuality(streams) {
  return streams
    .map((s, i) => ({ s, i, h: streamQualityHeight(s) }))
    .sort((a, b) => b.h - a.h || a.i - b.i)
    .map((x) => x.s);
}

/**
 * Proiezione di una riga del resolver sull'oggetto `Stream` del protocollo
 * Stremio: `name`, `description`, `url`, `source`, piu' `behaviorHints` solo se
 * la fonte ha dichiarato una variante.
 *
 * ── PERCHE' `description` E NON `title` ───────────────────────────────────────
 * Il tipo `Stream` di Stremio non ha un campo `title`: `Stream.d.ts` porta
 * `name` + `description`, e `title` e' un alias DEPRECATO che i client non
 * trattano come un campo a se'. Emetterlo era un doppione: il dato esisteva ma
 * nessun client lo mostrava, quindi correggere il nome del campo cambia anche
 * dove il campo viene letto (vedi la nota in `streamQualityHeight`).
 *
 * ── PERCHE' LA DESCRIPTION PORTA LA VARIANTE ─────────────────────────────────
 * Prima la riga perdeva la variante: uno stream doppiato e uno sottotitolato
 * erano indistinguibili per un utente se non guardando il testo del titolo.
 * Ora la description lo dichiara in chiaro (`ITA DUB` / `ITA SUB`), e non piu'
 * al posto del resto: quando la variante e' dichiarata si emette
 * `<label> — <titolo portato dalla fonte>` (o il `name` se il titolo e' vuoto),
 * perche' il titolo dell'episodio era informazione che il resolver aveva gia'
 * ripulito dal SOURCE_MARKER e che buttare via lasciava l'utente con una riga
 * secondaria identica per due episodi diversi di una stessa serie. Con la
 * variante assente la catena resta titolo-portato -> `name`, e la stringa non
 * e' MAI vuota in nessun dei due rami: `name` e' gia' non vuoto quando si
 * arriva qui (vedi il fallback `stream` piu' sopra), e una riga senza etichetta
 * e' indistinguibile da una riga troncata.
 *
* ── PERCHE' `behaviorHints.bingeGroup` ───────────────────────────────────────
 * E' l'unico canale LEGGIBILE DA UNA MACCHINA che distingue dub da sub senza
 * fare parsing del testo: e' quello su cui il client raggruppa e su cui fa
 * binge/autoplay. Senza, l'unico modo per un client di sapere che una riga e'
 * doppiata era leggere la stringa che sta sopra.
 *
 * Il gruppo e' deterministico (`<fonte>-ita-<variante>`), quindi identico fra
 * richieste e -- soprattutto -- IDENTICO ANCHE FRA EPISODI DIVERSI. Non e' un
 * effetto collaterale accettato: e' la proprieta' senza la quale il binge del
 * motore non si attiva mai, e la prova con i file del motore e' citata dove il
 * valore viene costruito (`bingeGroupOf`, piu' sotto). Un lettore che lo trovi
 * "troppo generico" sta per rompere qualcosa che funziona.
 *
 * C'e' dentro solo quello che DEVE variare fra due righe che un utente vede
 * come alternative dello stesso episodio: la fonte e la variante. L'episodio non
 * e' una di quelle cose, perche' nel confronto del motore i due episodi sono
 * due. La chiave viene omessa del tutto quando la variante e' `unknown`: un
 * gruppo `unknown` inventato raggrupperebbe fra loro righe che non hanno niente
 * in comune, che e' peggio che non raggrupparle.
 *
 * Non aggiunge altri campi: `Stream` non li definisce, e un campo che il
 * protocollo non ha e' rumore che ogni client deve imparare a ignorare. In
 * particolare l'id del video NON viene emesso come campo `videoId` della
 * `Stream`: se il client ha bisogno di leggerlo ce l'ha gia' nell'id del video
 * che sta guardando, e il protocollo non prevede il campo.
 *
 * @param {object[]} list righe GREZZE del resolver, non ancora proiettate
 */
export function normalizeStreams(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((s) => s && typeof s.url === 'string' && s.url.length > 0)
    .map((s) => {
      const name = typeof s.name === 'string' && s.name ? s.name : 'stream';
      const variant = detectVariant(s);
      const stream = {
        name,
        description: describeStream(s, name, variant),
        url: s.url,
        source: typeof s.source === 'string' ? s.source : undefined,
      };
      if (variant === VARIANT_DUB || variant === VARIANT_SUB) {
        stream.behaviorHints = { bingeGroup: bingeGroupOf(s, name, variant) };
      }
      return stream;
    });
}

/** Etichetta leggibile della riga: variante + titolo portato, o almeno non vuota. */
function describeStream(source, name, variant) {
  const carried = typeof source.title === 'string' ? source.title.trim() : '';
  // Il titolo che la fonte aveva portato e' il piu' specifico e vince; il `name`
  // e' il ripiego. La stringa non e' MAI vuota: `name` arriva gia' risolto dal
  // fallback `stream` di `normalizeStreams`, e il ramo sotto copre il caso in cui
  // sia spazio bianco.
  const detail = carried || name.trim();
  if (variant === VARIANT_DUB || variant === VARIANT_SUB) {
    // Meglio `ITA DUB` che `ITA DUB — ` con il separatore appeso a niente.
    return detail ? `${variantLabel(variant)} — ${detail}` : variantLabel(variant);
  }
  return detail || name;
}

/**
 * Id del gruppo binge: `<fonte>-ita-<variante>`, con la fonte ridotta a uno slug.
 * La riduzione serve perche' il valore finisce in un campo che i client usano
 * anche come chiave: una label con spazi o accenti (`Anime Unity`) non e' un id.
 *
 * ── L'ID DELL'EPISODIO QUI E' ASSENTE DI VOLTA. NON AGGIUNGERLO. ──────────────
 * Il valore e' una sola stringa per tutta la serie, e sembra il posto dove mettere
 * l'id del video per non confondere episodio 1 ed episodio 900: e' esattamente il
 * ragionamento con cui questo file e' stato sbagliato una volta. Il motore di
 * Stremio dice il contrario, e senza fallire:
 *
 *   - `stremio-core/src/types/resource/stream.rs`, `is_binge_match`: confronta
 *     SOLO i due `behavior_hints.binge_group` con uguaglianza di stringa, `a == b`.
 *     Nessun id, nessun contesto, nessun ripiego.
 *   - quel confronto avviene in `player.rs`, `next_stream_update`, fra lo stream
 *     SELEZIONATO dell'episodio CORRENTE e la lista di stream dell'episodio
 *     SUCCESSIVO: due episodi diversi, per definizione.
 *   - il test ufficiale `stremio-core/src/unit_tests/player/next_stream.rs` serve
 *     due id diversi (`tt123456:1:2` e `tt123456:1:3`) con gli STESSI valori
 *     letterali (`"binge_group"`, `"binge_group_1"`) e asserisce che il match
 *     riesca.
 *
 * Quindi un gruppo che cambia con l'episodio rende `a == b` irraggiungibile e il
 * binge si spegne in silenzio: nessun errore, nessun sintomo, solo l'autoplay che
 * smette di continuare. Lo stesso test mostra anche due varianti che convivono
 * nello stesso episodio con gruppi DIVERSI, e l'esempio canonico della
 * documentazione e' `"gobsAddon-720p"`: dentro il valore ci sta il discriminante
 * (addon, variante, qualita'), l'id dell'episodio no.
 *
 * Il test che fissa questa scelta e' `due episodi diversi danno lo stesso
 * bingeGroup` in `test/routes.test.mjs`.
 */
function bingeGroupOf(source, name, variant) {
  const raw = typeof source.source === 'string' && source.source ? source.source : name;
  const slug = String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || 'stream'}-ita-${variant}`;
}

// ---------------------------------------------------------------------------
// ROUTE MANIFEST (nessuna dipendenza iniettata)
// ---------------------------------------------------------------------------

export function createManifestRoute() {
  return async function handleManifest(req, res) {
    return jsonResponse(res, 200, MANIFEST, { 'Cache-Control': 'public, max-age=3600' });
  };
}
