/**
 * src/variant.js -- normalise "Italian Dub" / "Italian Sub" into a value a
 * client can branch on.
 *
 * ── WHY THIS MODULE HAS TO EXIST ────────────────────────────────────────────
 * The dub/sub distinction was being lost in TWO independent places, and fixing
 * only one of them would have looked like success while changing nothing:
 *
 *   1. The scrapers chose ONE record per title (`pickRecord` returns a single
 *      record) and never surfaced the language marker sitting next to it.
 *   2. `resolver.js` built every stream as exactly `{name,title,url,source}`,
 *      so any marker a source DID carry had nowhere to go and was discarded.
 *
 * Fixing (2) without (1) yields a field that is always `unknown`; fixing (1)
 * without (2) yields a field nobody can read. This module is the shared
 * vocabulary for both halves. Dependency-free and side-effect-free, so it can
 * be imported by the sources, by the adapter and by the API without a cycle.
 *
 * ── THE RULE THAT MATTERS ────────────────────────────────────────────────────
 * Only an EXPLICIT field is trusted, and only when it contains exactly one of
 * the two markers. The upstream titles carry a bare `[ITA]` or ` ITA`, and those
 * are deliberately NOT sniffed: a bare marker does not say whether the audio was
 * dubbed or the dialogue subtitled, so reading one as the other is precisely the
 * plausible-looking guess this codebase refuses to make. A title that says only
 * "ITA" is reported as `unknown`, which is a true statement.
 *
 * A missing field is `unknown`, and `unknown` is NOT defaulted to `sub`. That
 * default is what a client cannot tell apart from a real answer, and it is what
 * would make a dub silently disappear.
 */

/** Italian dub, audio in Italian. */
export const VARIANT_DUB = 'dub';
/** Italian sub, original audio with Italian subtitles. */
export const VARIANT_SUB = 'sub';
/** The source did not say, or said it ambiguously. Never guessed. */
export const VARIANT_UNKNOWN = 'unknown';

/**
 * Fields read from a source row, in priority order.
 *
 * `variant` first because that is the normalised key a source is expected to
 * set itself; the rest are the raw upstream spellings, so a source that
 * forwards an untranslated field still works without a translation step.
 */
const CANDIDATE_KEYS = ['variant', 'language_type', 'languageType', 'lang', 'language', 'audio', 'type'];

/**
 * Matched as whole tokens, never as substrings. `subscription` and `sub` share a
 * prefix, and a prefix match would label an unrelated field as a subtitled
 * track: the kind of error that is invisible until someone plays the wrong audio.
 */
const DUB_TOKENS = new Set(['dub', 'dubs', 'dubbed', 'dubbing', 'doppiato', 'doppiata', 'doppiaggio']);
// `subtitled` sits here next to `dubbed` on purpose: the two sites that spell the
// marker in English use the participle ("Italian Subtitled") at least as often as
// the bare noun, and missing it is what made an `Italian Subtitled` row fall
// through to `unknown` while `Italian Dubbed` resolved.
const SUB_TOKENS = new Set([
  'sub', 'subs', 'subbed', 'subbing', 'subtitled', 'subtitle', 'subtitles',
  'sottotitolato', 'sottotitolata', 'sottotitoli', 'sottotitolo',
]);

/**
 * Split on every non-letter run so the tokens are exact. Lowercasing first
 * means `"Italian Dub"`, `"italian-dub"` and `"ITALIAN_DUB"` all reduce to the
 * same token set, which is what makes this usable across three sites that each
 * spell it differently.
 * @param {string} value
 * @returns {string[]}
 */
function tokenize(value) {
  return String(value).toLowerCase().split(/[^a-z]+/).filter(Boolean);
}

/**
 * Read the dub/sub marker out of a source row.
 *
 * Returns the FIRST key that yields exactly one marker. A key that contains both
 * markers (`"Italian Dub/Sub"`) is ambiguous, so it is skipped and the next key
 * is consulted; if nothing resolves, the answer is `unknown`.
 *
 * @param {unknown} row a raw source row, or any object
 * @returns {'dub'|'sub'|'unknown'}
 */
export function detectVariant(row) {
  if (!row || typeof row !== 'object') return VARIANT_UNKNOWN;

  for (const key of CANDIDATE_KEYS) {
    const raw = row[key];
    if (typeof raw !== 'string' || !raw.trim()) continue;

    const tokens = tokenize(raw);
    const isDub = tokens.some((token) => DUB_TOKENS.has(token));
    const isSub = tokens.some((token) => SUB_TOKENS.has(token));

    // `isDub === isSub` covers both "carries no marker" and "carries both".
    // Neither can be turned into a variant without guessing.
    if (isDub === isSub) continue;
    return isDub ? VARIANT_DUB : VARIANT_SUB;
  }

  return VARIANT_UNKNOWN;
}

/**
 * Human label for a variant. Defaults to Italian because all three sources are
 * Italian-only; a future non-Italian source passes its own tag.
 * @param {string} variant
 * @param {string} [language]
 * @returns {string}
 */
export function variantLabel(variant, language = 'ita') {
  // `ita`, not `it`: every upstream marker on all three sites is spelled `ITA`
  // (`SUB ITA`, `_SUB_ITA`, `(ITA)`), so `IT` here would label a stream with a
  // code the sources never use.
  const tag = String(language || 'ita').trim().toUpperCase() || 'ITA';
  if (variant === VARIANT_DUB) return `${tag} DUB`;
  if (variant === VARIANT_SUB) return `${tag} SUB`;
  return tag;
}

/**
 * Validate the `variant` query parameter.
 *
 * `all` is the default because a caller who did not ask for a variant wants
 * everything the sources actually produced; silently returning only subs would
 * be a filter nobody requested.
 *
 * @param {unknown} raw
 * @returns {{ok: true, variant: 'all'|'dub'|'sub'} | {ok: false, variant: null}}
 */
export function parseVariantParam(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value || value === 'all' || value === 'any') return { ok: true, variant: 'all' };
  if (value === VARIANT_DUB || value === VARIANT_SUB) return { ok: true, variant: value };
  return { ok: false, variant: null };
}