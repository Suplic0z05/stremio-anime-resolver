/**
 * src/routes/meta.js
 *
 * GET /meta/series/ku:12.json
 * GET /meta/anime/ku:12.json
 * GET /meta/movie/ku:12.json
 *
 * Risposta: `{ meta: { id, type, name, poster, background, description,
 * year, genres, videos: [...] } }`.
 *
 * SCELTA ARCHITETTURALE CENTRALE -- `videos[].episode` e' il numero ASSOLUTO.
 *
 * L'id del video e' `ku:<kitsuId>:<numeroAssoluto>` (vedi lo schema in
 * `src/manifest.js`), e `videos[].episode` DEVE essere esattamente quel numero:
 * se i due divergessero, il client che legge `episode` mostrerebbe un
 * episodio diverso da quello che l'id richiede, e i due sistemi di indirizzamento
 * si contraddirrebbero senza che nessuno dei due lo segnali.
 *
 * Per questo `season` viene emesso come `null` invece di provare a
 * partizionare in stagioni: con `season: null` nessun client puo' ricostruire
 * un numero diverso dal nostro, e l'id resta l'unica fonte di verita. Se
 * domani i `season` con numeri tipo "stagione 1", episodi 227 diventano
 * irraggiungibili per un client che splitta per season, e il numero non torna
 * piu'. E' lo stesso motivo per cui non usiamo gli id IMDb di Cinemeta:
 * `tt0388629:21:1` significherebbe episodio 954 di Naruto.
 *
 * Le dipendenze sono iniettate, mai importate a livello di modulo.
 */

import {
  DEFAULT_TIMEOUT_MS,
  errorToResponse,
  formatMetaId,
  formatVideoId,
  jsonResponse,
  parseMetaId,
  pathSegments,
  withTimeout,
} from '../manifest.js';

/** Tipi di tipo ammesso dal manifest per questa rotta. */
const ALLOWED_TYPES = new Set(['anime', 'series', 'movie']);

export function createVideoEntry(kitsuId, episode) {
  return {
    id: formatVideoId(kitsuId, episode.number),
    // numero assoluto, identico all'ultimo segmento dell'id
    episode: episode.number,
    // null esplicito: nessun partizionamento da applicare lato client
    season: null,
    title: episode.title ?? null,
    released: episode.aired ?? null,
    overview: null,
  };
}

export function createMetaRoute({ kitsu, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!kitsu || typeof kitsu.meta !== 'function') {
    throw new TypeError('createMetaRoute: serve `kitsu.meta`');
  }

  return async function handleMeta(req, res) {
    const segments = pathSegments(req);
    const [, requestedType, rawId] = segments;

    if (!ALLOWED_TYPES.has(requestedType)) {
      return jsonResponse(res, 404, { error: 'unknown meta type' });
    }

    const parsed = parseMetaId(rawId);
    if (!parsed) {
      // Id malformato: 404, non 500. Non e' un errore dell'addon, e' una
      // richiesta che non descrive nessuna risorsa.
      return jsonResponse(res, 404, { error: 'invalid id' });
    }

    try {
      const data = await withTimeout(kitsu.meta(parsed.kitsuId), timeoutMs, 'kitsu.meta');
      if (!data) return jsonResponse(res, 404, { error: 'not found' });

      const type = data.type === 'movie' ? 'movie' : 'series';
      const episodes = Array.isArray(data.episodes) ? data.episodes : [];
      const videos = episodes
        .filter((e) => e && Number.isSafeInteger(Number(e.number)) && Number(e.number) >= 1)
        .map((e) => createVideoEntry(data.id ?? parsed.kitsuId, { number: Number(e.number), title: e.title, aired: e.aired }))
        .sort((a, b) => a.episode - b.episode);

      return jsonResponse(res, 200, {
        meta: {
          id: formatMetaId(data.id ?? parsed.kitsuId),
          type,
          name: data.name ?? null,
          poster: data.poster ?? null,
          background: data.background ?? null,
          description: data.description ?? null,
          year: data.year ?? null,
          genres: Array.isArray(data.genres) ? data.genres : [],
          videos,
        },
      });
    } catch (err) {
      return errorToResponse(err, res, (kind) => process.stderr.write(`[meta] ${kind}\n`));
    }
  };
}
