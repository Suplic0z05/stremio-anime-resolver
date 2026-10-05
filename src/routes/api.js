/**
 * src/routes/api.js
 *
 * The surface that makes this resolver usable by something other than Stremio.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * Stremio is one consumer of a capability. A Kodi skin, an MPV script, a browser
 * extension or any `curl` should be able to ask the same question and get the
 * same answer, including which of `Italian Dub` / `Italian Sub` it got. Those
 * clients have no use for `meta.videos[]` episode partitioning, so coupling them
 * to the Stremio routes would mean re-implementing the addon protocol to get one
 * stream list.
 *
 * What this is NOT: an attempt to re-implement Stremio, and not a second source
 * of truth. It reads the very same `resolver`, so a fix in the scrapers reaches
 * both surfaces at once.
 *
 * ── CONTRACT ─────────────────────────────────────────────────────────────────
 *   GET /api                      → what this surface is, and its endpoints
 *   GET /api/sources              → the sources and whether they declare variants
 *   GET /api/streams?title=&episode=&variant=&source=
 *        → { title, episode, variant, count, availableVariants, variantsKnown,
 *            variantsKnownBy, streams: [{ source, label, title, url, variant,
 *                        variantLabel, height }], errors }
 *
 * `variant` is `dub`, `sub`, or `all` (the default). It filters strictly:
 * requesting `dub` returns ONLY rows a source explicitly labelled as a dub.
 * Rows the source did not label are `unknown` and are therefore EXCLUDED from a
 * `dub` or `sub` request, because returning them would be claiming a fact.
 *
 * ── THE TWO VARIANT FIELDS, AND WHY THEY ARE NOT THE SAME QUESTION ───────────
 * `availableVariants` is the PER-TITLE answer: what this title actually produced.
 * It is read off the rows, after the `?source=` subset and the URL filter, so it
 * legitimately changes from one title to the next.
 *
 * `variantsKnown` is the PER-SOURCE answer, and it answers "does this site expose
 * the distinction at all" — a different question from "did this title happen to
 * have a dub". A `false` accuses a scraper of carrying no variant information at
 * all, which by definition is not fixable here. It is derived from what the
 * consulted SOURCES declare (`declaresVariants` in `src/resolver.js`), never from
 * this request's rows, so none of these can flip it:
 *
 *   - a title that only has sub rows (`variantsKnown` stays `true`: the site DID
 *     tell us, and it said "only sub for this title");
 *   - a `?source=` subset that narrows the request to a capable source;
 *   - an empty result set — which is why "the site cannot tell" and "nothing
 *     matched" are two different answers and must not share one `false`.
 *
 * `variantsKnown` is `true` only when EVERY consulted source declares the
 * distinction. With one source that does not, we cannot claim to know the
 * distinction for the result set: a missing dub from that site means nothing, so
 * saying `true` would be a guess. With no source consulted there is nothing to
 * know about, and the answer is `false` rather than a vacuous `true`.
 *
 * `variantsKnownBy` breaks the boolean down per source, so a client can see WHICH
 * site is silent instead of only that somebody is.
 *
 * ── ERRORS ───────────────────────────────────────────────────────────────────
 * Bad input is 400 and says which parameter is wrong: that is the caller's
 * mistake and is fixable by the caller. An empty result is 200 with an empty
 * array, which is an honest answer and not an error. Upstream failures go
 * through the shared `errorToResponse`, so a Kitsu outage stays a 5xx instead of
 * masquerading as "nothing here".
 */

import {
  DEFAULT_TIMEOUT_MS,
  errorToResponse,
  jsonResponse,
  pathSegments,
  requestUrl,
  streamQualityHeight,
  withTimeout,
} from '../manifest.js';
import { SOURCES, declaresVariants, getSource } from '../resolver.js';
import { VARIANT_DUB, VARIANT_SUB, VARIANT_UNKNOWN, parseVariantParam, variantLabel } from '../variant.js';

const ENDPOINTS = {
  root: '/api',
  sources: '/api/sources',
  streams: '/api/streams?title=<titolo>&episode=<n>&variant=dub|sub|all',
};

/** Media URLs carry short-lived tokens, so nothing here may be cached. */
const NO_STORE = { 'Cache-Control': 'no-store' };

function badRequest(res, message) {
  return jsonResponse(res, 400, { error: message }, NO_STORE);
}

function notFound(res) {
  return jsonResponse(res, 404, { error: 'not found', streams: [] }, NO_STORE);
}

function describe(res, sources) {
  return jsonResponse(
    res,
    200,
    {
      name: 'stremio-anime-resolver',
      summary: 'Risoluzione stream anime con distinzione Italian Dub / Italian Sub.',
      endpoints: ENDPOINTS,
      variants: [VARIANT_DUB, VARIANT_SUB, VARIANT_UNKNOWN],
      variantNote:
        "`unknown` significa che la fonte non ha dichiarato la variante. Non viene " +
        'dedotto dal titolo: un marker `[ITA]` nudo non dice se audio e doppiato o ' +
        'sottotitolato, quindi riportare `sub` sarebbe un affermazione inventata.',
      sources: sources.map(({ id, label }) => ({ id, label, declaresVariants: declaresVariants(id) })),
      stremio: { manifest: '/manifest.json', catalog: '/catalog/anime/kitsu-anime.json', stream: '/stream/series/ku:<kitsuId>:<n>.json' },
    },
    { 'Cache-Control': 'public, max-age=600' },
  );
}

/**
 * Resolve one episode and project the rows into this surface's own shape.
 *
 * The projection is NOT `normalizeStreams()`, and the reason is the CONTRACT, not
 * a fear of losing `variant`. `normalizeStreams()` exists to emit a Stremio
 * `Stream`: four protocol fields plus `behaviorHints`. This surface answers a
 * different question -- which variant, at which height, from which source -- so
 * it needs fields a `Stream` does not have (`label`, `title`, `variant` AND
 * `variantLabel`, `height`), all of them guaranteed present, and `variant` now
 * does travel to Stremio inside `bingeGroup` for the rows that declare one.
 *
 * The asymmetry that settles it: `behaviorHints.bingeGroup` is a field of the
 * Stremio `Stream` and it is consumed by Stremio's player, on the Stremio route,
 * where a group is meaningful. This endpoint has no client that reads it, and it
 * already says the same fact in a form a program can use: `variant` and
 * `variantLabel`, always present. Emitting a group here would be a field nobody
 * asks for, carrying less than the two fields next to it.
 *
 * @returns {Promise<{status:number, body:object, headers:object, payload:string}>}
 */
async function handleStreams(req, res, { resolver, sources, timeoutMs }) {
  const url = requestUrl(req);

  const title = (url.searchParams.get('title') ?? '').trim();
  if (!title) return badRequest(res, 'manca il parametro obbligatorio `title`');

  const rawEpisode = (url.searchParams.get('episode') ?? '').trim();
  let episode = 1;
  if (rawEpisode) {
    const parsed = Number(rawEpisode);
    // Rejected here rather than coerced: `episode=abc` silently becoming episode
    // 1 would return a real, wrong, playable stream.
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      return badRequest(res, '`episode` deve essere un intero >= 1');
    }
    episode = parsed;
  }

  const wanted = parseVariantParam(url.searchParams.get('variant'));
  if (!wanted.ok) return badRequest(res, '`variant` deve essere `dub`, `sub` o `all`');

  const rawSource = (url.searchParams.get('source') ?? '').trim();
  let subset;
  if (rawSource) {
    const id = rawSource.toLowerCase();
    if (!getSource(id)) return badRequest(res, `fonte sconosciuta: ${rawSource}`);
    subset = [id];
  }

  const query = { title, episode };
  if (subset) query.sources = subset;

  const results = await withTimeout(
    resolver.resolveSeries(query),
    timeoutMs,
    'resolver.resolveSeries',
  );

  const rows = (Array.isArray(results) ? results : [])
    .filter((row) => row && typeof row.url === 'string' && row.url.length > 0)
    .map((row) => {
      // Re-derived here instead of trusted: the adapter omits `variant` entirely
      // when a source declared none, so this is the one place that guarantees
      // the field is always present for a consumer.
      const variant =
        row.variant === VARIANT_DUB || row.variant === VARIANT_SUB ? row.variant : VARIANT_UNKNOWN;
      return {
        source: row.source,
        label: row.name,
        title: row.title,
        url: row.url,
        variant,
        variantLabel: variantLabel(variant),
        height: streamQualityHeight(row),
      };
    });

  const availableVariants = [...new Set(rows.map((row) => row.variant))].sort();

  // What the CONSULTED SOURCES declare, not what this title returned. See the
  // header: deriving it from `availableVariants` made a `false` mean both "this
  // scraper is blind" and "this title matched nothing", and the first of those
  // two is an accusation the resolver cannot fix.
  const consulted = (subset ? [subset] : sources.map(({ id }) => id))
    .map((id) => String(id ?? '').trim().toLowerCase());
  const variantsKnownBy = Object.fromEntries(consulted.map((id) => [id, declaresVariants(id)]));
  const variantsKnown = consulted.length > 0 && consulted.every((id) => variantsKnownBy[id]);
  const streams = wanted.variant === 'all' ? rows : rows.filter((row) => row.variant === wanted.variant);

  return jsonResponse(
    res,
    200,
    {
      title,
      episode,
      variant: wanted.variant,
      count: streams.length,
      totalCount: rows.length,
      availableVariants,
      variantsKnown,
      variantsKnownBy,
      streams,
      errors: Array.isArray(results?.errors) ? [...results.errors] : [],
    },
    NO_STORE,
  );
}

export function createApiRoute({ resolver, sources = SOURCES, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!resolver || typeof resolver.resolveSeries !== 'function' || typeof resolver.resolveMovie !== 'function') {
    throw new TypeError('createApiRoute: serve `resolver.resolveSeries` e `resolver.resolveMovie`');
  }

  return async function handleApi(req, res) {
    const [, name] = pathSegments(req);
    try {
      if (!name || name === 'sources') return describe(res, sources);
      if (name === 'streams') return await handleStreams(req, res, { resolver, sources, timeoutMs });
      return jsonResponse(res, 404, { error: 'endpoint sconosciuto', endpoints: ENDPOINTS }, NO_STORE);
    } catch (err) {
      return errorToResponse(err, res, (kind) => process.stderr.write(`[api] ${kind}\n`), notFound);
    }
  };
}