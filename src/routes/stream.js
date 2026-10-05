/**
 * src/routes/stream.js
 *
 * GET /stream/series/ku:12:954.json
 * GET /stream/series/ku:12:954.json?title=Naruto
 * GET /stream/movie/ku:12.json
 *
 * Risposta: `{ streams: [{ name, description, url, source }] }`, piu'
 * `behaviorHints.bingeGroup` sulle sole righe che dichiarano una variante.
 *
 * I quattro campi sono la proiezione di `normalizeStreams()`: `description` e'
 * il campo che il protocollo Stremio definisce (il vecchio `title` ne e' un alias
 * deprecato, quindi non viene emesso), e porta sia la variante (`ITA DUB` /
 * `ITA SUB`) sia il titolo che la fonte aveva dichiarato per quell'episodio.
 * `behaviorHints.bingeGroup` e' `<fonte>-ita-<variante>` e NON contiene l'id del
 * video, di proposito: la rotta lo conosce (e' `rawId`, validato qui sopra) ma
 * passarlo dentro spegnerebbe il binge del motore, che confronta due episodi
 * diversi con una semplice uguaglianza di stringa. La prova con i file del motore e'
 * nel docstring di `bingeGroupOf` in `src/manifest.js`.
 *
 * Il campo `url` DEVE essere l'HTTPS gia' risolto, con i token temporanei
 * dentro: restituire una pagina che richiede un secondo passaggio fa fallire
 * la riproduzione. Per lo stesso motivo qui NON c'e' `behaviorHints.ingest`:
 * senza, Stremio riproduce l'URL inline invece di buttare fuori l'utente
 * dall'app.
 *
 * ESTRAZIONE DEL NUMERO EPISODIO
 * Il numero non viene mai indovinato e non viene mai ricalcolato: si prende
 * dall'ultimo segmento dell'id con `parseVideoId`, e si valida che sia un
 * intero >= 1. `ku:12:954` produce `episode === 954`. Non 1, non 21: quel
 * terzo campo e' il numero ASSOLUTO, e 21 sarebbe la lettura sbagliata del
 * formato IMDb/Cinemeta (`stagione 21 episodio 1`), che qui non esiste perche'
 * gli id sono nostri (vedi lo schema in `src/manifest.js`).
 *
 * Parsing fallito -> 404 con `{"streams":[]}`. MAI 500 con stack trace: un id
 * malformato non e' un errore dell'addon, e il client deve poter distinguere
 * "non c'e' niente" da "sono rotto".
 *
 * IL TITOLO
 * L'handler NON fa il lookup del titolo da solo quando glielo si passano:
 * accetta `?title=` e, se assente, chiama `kitsu.meta` una volta. Quindi
 * `kitsu` e' opzionale perche' con il query parametro funziona lo stesso --
 * ed e' quello che rende la rotta testabile senza rete.
 */

import {
  DEFAULT_TIMEOUT_MS,
  errorToResponse,
  jsonResponse,
  normalizeStreams,
  parseMetaId,
  parseVideoId,
  pathSegments,
  requestUrl,
  sortStreamsByQuality,
  withTimeout,
} from '../manifest.js';

function streamsNotFound(res) {
  return jsonResponse(res, 404, { streams: [] }, { 'Cache-Control': 'no-store' });
}

export function createStreamRoute({ kitsu, resolver, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!resolver || typeof resolver.resolveSeries !== 'function' || typeof resolver.resolveMovie !== 'function') {
    throw new TypeError('createStreamRoute: serve `resolver.resolveSeries` e `resolver.resolveMovie`');
  }

  return async function handleStream(req, res) {
    const segments = pathSegments(req);
    const [, type, rawId] = segments;

    if (type !== 'series' && type !== 'anime' && type !== 'movie') {
      return streamsNotFound(res);
    }

    // `anime` e `series` condividono lo stesso formato di id.
    const video = parseVideoId(rawId);
    const metaRef = parseMetaId(rawId);
    const isMovie = type === 'movie';

    // Validazione esplicita e isolata: id non conforme -> 404, mai 500.
    if (isMovie ? !metaRef : !video) {
      return streamsNotFound(res);
    }

    const kitsuId = isMovie ? metaRef.kitsuId : video.kitsuId;
    const episode = isMovie ? null : video.number; // intero >= 1, garantito da parseVideoId

    const url = requestUrl(req);
    let title = (url.searchParams.get('title') ?? '').trim() || null;

    if (!title && kitsu && typeof kitsu.meta === 'function') {
      try {
        const data = await withTimeout(kitsu.meta(kitsuId), timeoutMs, 'kitsu.meta');
        title = data?.name ?? null;
      } catch (err) {
        return errorToResponse(err, res, (kind) => process.stderr.write(`[stream] ${kind}\n`), streamsNotFound);
      }
    }

    try {
      const results = isMovie
        ? await withTimeout(resolver.resolveMovie({ title }), timeoutMs, 'resolver.resolveMovie')
        : await withTimeout(
            resolver.resolveSeries({ title, episode }),
            timeoutMs,
            'resolver.resolveSeries',
          );

      const streams = sortStreamsByQuality(normalizeStreams(results));
      return jsonResponse(res, 200, { streams }, { 'Cache-Control': 'public, max-age=60' });
    } catch (err) {
      return errorToResponse(err, res, (kind) => process.stderr.write(`[stream] ${kind}\n`), streamsNotFound);
    }
  };
}
