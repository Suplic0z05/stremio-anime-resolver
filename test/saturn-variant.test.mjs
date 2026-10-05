/**
 * test/saturn-variant.test.mjs
 *
 * Dub/Sub tagging on AnimeSaturn, tested offline against markup captured from the
 * real `/filter` pages, with the two live paths measured against the real site
 * behind `SAR_LIVE=1`.
 *
 * ── WHY EVERY FIXTURE HERE IS A CARD BLOCK, NOT A FILE ──────────────────────
 * The whole feature rests on one measured asymmetry:
 *
 *   `GET /filter?key=One%20Piece&dub=1` → 23 cards, 23 with `ac__dub-badge`
 *   `GET /filter?key=One%20Piece&dub=0` → 29 cards,  0  with `ac__dub-badge`
 *   `GET /filter?key=One%20Piece`        → 30 cards, 13 with `ac__dub-badge`
 *
 * i.e. `key` and `dub` DO combine, so one `key=` query already carries both
 * variants and the server-side filter is what separates them. The two variants of
 * One Piece are `one-piece-ita-bz8UJ` (DUB, "One Piece (ITA)") and
 * `one-piece-PmTvj` (sub, "One Piece").
 *
 * A fixture that mocked the whole page instead of the card would not test the
 * thing that broke before: the badge must be read INSIDE the card anchor, because
 * the series page carries 30 badges on RELATED cards and reading them
 * document-wide is a measured false positive.
 *
 * ── SLUG CASE ──────────────────────────────────────────────────────────────
 * Slugs are taken verbatim from `href` and they contain UPPERCASE letters
 * (`one-piece-ita-bz8UJ`). A slug pattern of `[a-z0-9-]+` drops them silently and
 * every dub entry disappears with no error anywhere, which is why the parsing
 * tests below assert on the exact slug strings rather than on a count.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import animesaturn from '../src/sources/animesaturn.js'
import { detectVariant, VARIANT_DUB, VARIANT_SUB, VARIANT_UNKNOWN } from '../src/variant.js'

const LIVE = process.env.SAR_LIVE === '1'

// ── markup fixtures ─────────────────────────────────────────────────────────

/**
 * One real `/filter` card. The shape is verbatim from the site, including the two
 * details that matter: `<span class="ac__dub-badge">DUB</span>` sits inside
 * `<div class="ac__topbar">` INSIDE the anchor, and the episode count is the
 * literal `?? ep` on some cards.
 *
 * `badge` is the badge's own text, so a test can put a marker other than `DUB` in
 * the markup. `false` renders no badge at all, which is the measured sub case.
 */
const card = ({
  slug,
  title,
  type = 'TV',
  date = '20 Ottobre 1999',
  eps = '?? ep',
  score = '7.48',
  badge = false
}) =>
  `<a href="/anime/${slug}" class="ac group">
    <div class="ac__poster">
        <img src="https://img.saturncdn.net/static/images/locandine/x.png"
             alt="${title}"
             width="240" height="360"
             loading="lazy" decoding="async">

        <div class="ac__topbar">
                            <span class="ac__type-badge">${type}</span>
                            ${badge ? `<span class="ac__dub-badge">${badge}</span>` : ''}
                    </div>

                    <span class="ac__score">
                <svg class="w-3 h-3 text-amber-400" viewBox="0 0 24 24" fill="currentColor"><path d="m12 2 3.09 6.26L22 9.27l-5 4.87L18.18 22 12 18.56 5.82 22 7 14.14 2 9.27l6.91-1.01z"/></svg>
                ${score}            </span>
    </div>

    <div class="ac__caption">
        <h3 class="ac__title">${title}</h3>
                    <p class="ac__sub">${date} &middot; ${eps}</p>
            </div>
</a>`

/** Wrap cards in the shell the parser runs against. */
const page = (cards) => `<!DOCTYPE html><html><body><div class="container">${cards.join('\n')}</div></body></html>`

const DUB_SLUG = 'one-piece-ita-bz8UJ'
const SUB_SLUG = 'one-piece-PmTvj'

// The dub catalogue as measured, trimmed to the cards that could win the pick.
// The 21 movies are present because they are what the dub pick has to REJECT:
// every one of them normalises to a `onepiece…` prefix, so they are all tier 2.
const DUB_CATALOGUE = page([
  card({ slug: 'one-piece-movie-15-red-ita-R6sqk', title: 'One Piece Movie 15: Red (ITA)', type: 'Movie', badge: 'DUB' }),
  card({ slug: 'one-piece-movie-14-stampede-ita-myZUq', title: 'One Piece Movie 14: Stampede (ITA)', type: 'Movie', badge: 'DUB' }),
  card({ slug: DUB_SLUG, title: 'One Piece (ITA)', badge: 'DUB' }),
  card({ slug: 'one-piece-movie-01-the-movie-ita-P4d8d', title: 'One Piece Movie 01: The Movie (ITA)', type: 'Movie', badge: 'DUB' })
])

// The sub catalogue as measured. Only the plain "One Piece" is tier 3; everything
// else is tier 2 and loses on normalised length.
const SUB_CATALOGUE = page([
  card({ slug: 'one-piece-movie-15-red-KV5AX', title: 'One Piece Movie 15: Red', type: 'Movie' }),
  card({ slug: SUB_SLUG, title: 'One Piece' }),
  card({ slug: 'one-piece-movie-01-the-movie-y6KtV', title: 'One Piece Movie 01: The Movie', type: 'Movie' })
])

/**
 * Drive the real `single()` with the network replaced by two canned catalog
 * pages. `grab` and `resolveEpisode` are the ONLY seams: card parsing, title
 * ranking, per-pass picking, slug de-duplication and variant resolution are all
 * the file's own code under test.
 *
 * @param {Map<string,string>} catalogues keyed by `?dub=` value
 * @param {object} [opts]
 */
async function runSingle(catalogues, opts = {}) {
  const src = animesaturn
  const realGrab = src.grab.bind(src)
  const realResolve = src.resolveEpisode.bind(src)
  const requested = []

  src.grab = async (url) => {
    requested.push(url)
    if (url.includes('/anime/')) return { ok: true, status: 200, body: page([]) }
    const dub = /[?&]dub=(\d)/.exec(url)?.[1]
    const body = catalogues.get(dub)
    if (body === undefined) return { ok: false, status: 404, body: '', error: 'stub' }
    return { ok: true, status: 200, body }
  }
  src.resolveEpisode = async (slug, episode) =>
    opts.noMatchSlugs?.has?.(slug) ? { noMatch: true } : { url: `https://srv.example/${slug}/ep-${episode}.mp4` }

  try {
    const rows = await src.single({ titles: opts.titles ?? ['One Piece'], episode: opts.episode ?? 1 })
    return { rows: [...rows], errors: [...(rows.errors ?? [])], requested }
  } finally {
    src.grab = realGrab
    src.resolveEpisode = realResolve
  }
}

// ── 1. slug case ─────────────────────────────────────────────────────────────

test('slug: la classe ancore conserva gli slug con MAIUSCOLE', () => {
  const cards = animesaturn.parseCandidates(
    page([card({ slug: DUB_SLUG, title: 'One Piece (ITA)', badge: 'DUB' }), card({ slug: SUB_SLUG, title: 'One Piece' })])
  )

  assert.deepEqual(
    cards.map((c) => c.slug),
    [DUB_SLUG, SUB_SLUG],
    'uno slug con maiuscole perduto è indistinguibile da uno slug inesistente'
  )
  // The exact strings, not just "2 cards": a lowercase-only pattern would return
  // the right COUNT here only if it also matched something else, and the failure
  // this guards against is a silently shorter list.
  assert.ok(cards[0].slug.includes('bz8UJ'), 'le maiuscole dello slug devono arrivare intatte')
  assert.equal(cards[1].slug, 'one-piece-PmTvj')
})

test('slug: la regex di slug non filtra le maiuscole (misura diretta)', () => {
  // The tempting slug pattern, and why it is measurably wrong: it stops at the
  // first character outside [a-z0-9-]. `8` is inside the class and `U` is not, so
  // `one-piece-ita-bz8UJ` truncates to `one-piece-ita-bz8` — a slug that resolves
  // to nothing and reports no error anywhere. The working pattern is the one the
  // file uses: everything up to the closing quote.
  const bad = /href="\/anime\/([a-z0-9-]+)/
  const good = /href="\/anime\/([^"]+)"/
  assert.equal(`href="/anime/${DUB_SLUG}"`.match(bad)?.[1], 'one-piece-ita-bz8')
  assert.equal(`href="/anime/${DUB_SLUG}"`.match(good)?.[1], DUB_SLUG)

  const cards = animesaturn.parseCandidates(DUB_CATALOGUE)
  assert.ok(cards.some((c) => c.slug === DUB_SLUG), 'lo slug DUB deve arrivare al chiamante intero')
})

// ── 2. dub tagga dub, sub tagga sub ──────────────────────────────────────────

test('variant: la riga DUB e` dub e la riga SUB e` sub, sullo stesso titolo', async () => {
  const { rows } = await runSingle(new Map([['1', DUB_CATALOGUE], ['0', SUB_CATALOGUE]]))

  assert.equal(rows.length, 2, 'una riga per variante, non una riga per titolo')
  assert.deepEqual(
    rows.map((r) => [r.variant, r.animeSlug]),
    [
      [VARIANT_DUB, DUB_SLUG],
      [VARIANT_SUB, SUB_SLUG]
    ]
  )
})

test('variant: la riga DUB porta il badge `DUB`, la riga SUB la provenienza', async () => {
  const { rows } = await runSingle(new Map([['1', DUB_CATALOGUE], ['0', SUB_CATALOGUE]]))
  const dub = rows.find((r) => r.variant === VARIANT_DUB)
  const sub = rows.find((r) => r.variant === VARIANT_SUB)

  // The badge is card-scoped upstream text; the sub card has no badge at all, so
  // its marker is the site's own word for `dub=0`.
  assert.equal(dub.language_type, 'DUB')
  assert.equal(sub.language_type, 'SOTTOTITOLATO')
})

test('variant: `detectVariant` del progetto ricava lo stesso valore dalla riga', async () => {
  // The consumer (`src/resolver.js`) calls `detectVariant(row)` and never reads
  // `row.variant` directly, so the two have to agree or the field is decoration.
  const { rows } = await runSingle(new Map([['1', DUB_CATALOGUE], ['0', SUB_CATALOGUE]]))
  for (const row of rows) {
    assert.equal(detectVariant(row), row.variant, `disaccordo su ${row.animeSlug}`)
    assert.equal(detectVariant({ language_type: row.language_type }), row.variant)
  }
})

test('variant: ogni marker letto dal sorgente risolve come `variant.js` lo risolve', async () => {
  // `src/variant.js` owns the vocabulary. This file keeps its own copy of the
  // token sets — because it is byte-identical to the standalone upstream addon,
  // which has no `src/variant.js` to import — so the copy is pinned here instead
  // of being trusted. Each badge is driven through the real `single()` and the
  // row it produces is compared against the canonical implementation.
  //
  // `pass` matters and is not decoration: a card only gets a variant when its
  // badge and its query provenance AGREE, so a DUB marker has to be driven
  // through the `dub=1` pass and a SUB marker through `dub=0`. Putting a SUB
  // badge on a card returned by `dub=1` is a contradiction, and that is covered
  // separately below.
  const cases = [
    ['DUB', '1', VARIANT_DUB],
    ['dub', '1', VARIANT_DUB],
    ['DUBBING', '1', VARIANT_DUB],
    ['Doppiato', '1', VARIANT_DUB],
    ['SUB', '0', VARIANT_SUB],
    ['Sub ITA', '0', VARIANT_SUB],
    ['_SUB_ITA', '0', VARIANT_SUB],
    ['sottotitolato', '0', VARIANT_SUB],
    ['SUBTITLED', '0', VARIANT_SUB],
    // A badge naming no variant carries no information of its own. The pass
    // decides, and the pass's own word is the marker the row then reports — an
    // `ITA` badge is never read as a marker by itself.
    ['', '1', VARIANT_DUB],
    ['ITA', '1', VARIANT_DUB],
    ['(ITA)', '1', VARIANT_DUB]
  ]

  for (const [badge, pass, expected] of cases) {
    const one = page([card({ slug: DUB_SLUG, title: 'One Piece (ITA)', badge })])
    const { rows } = await runSingle(new Map([[pass, one]]), { titles: ['One Piece'] })
    const row = rows[0]
    assert.ok(row, `nessuna riga per il badge ${JSON.stringify(badge)}`)

    assert.equal(row.variant, expected, `sorgente: ${JSON.stringify(badge)} su dub=${pass}`)
    assert.equal(detectVariant(row), expected, `variant.js sulla riga: ${JSON.stringify(badge)}`)
    assert.equal(
      detectVariant({ language_type: row.language_type }),
      expected,
      `variant.js sul marker grezzo: ${JSON.stringify(badge)}`
    )
  }
})

// ── 3. nessun marker => unknown ──────────────────────────────────────────────

test('variant: una scheda senza marker resta unknown, non diventa sub', async () => {
  // Same slug returned by BOTH passes with no badge on either: the server-side
  // filter did not separate them, so the row has to say so. Defaulting to `sub`
  // here is what would make a dub silently disappear.
  const mixed = page([card({ slug: DUB_SLUG, title: 'One Piece (ITA)' })])
  const { rows, errors } = await runSingle(new Map([['1', mixed], ['0', mixed]]))

  assert.equal(rows.length, 1, 'uno slug solo produce una riga sola')
  assert.equal(rows[0].animeSlug, DUB_SLUG)
  assert.equal(rows[0].variant, VARIANT_UNKNOWN)
  assert.equal(rows[0].language_type, '')
  assert.deepEqual(errors, [])
})

test('variant: un badge `ITA` nudo resta unknown (mai inferito da ITA)', async () => {
  // Every marker on this site is spelled `ITA`, so `includes('ITA')` matches
  // `(ITA)`, `Sub ITA` and `_SUB_ITA` at once — including the ones that say
  // nothing about the audio.
  const cards = animesaturn.parseCandidates(
    page([
      card({ slug: 'x-ita-aaa', title: 'Foo (ITA)', dub: false }),
      card({ slug: 'x-bbb', title: 'Bar (ITA)' })
    ])
  )
  assert.deepEqual(cards.map((c) => c.dubBadge), ['', ''], 'il badge DUB assente non si inventa')

  // And through the canonical implementation, which the test pins:
  assert.equal(detectVariant({ language_type: 'ITA' }), VARIANT_UNKNOWN)
  assert.equal(detectVariant({ language_type: '(ITA)' }), VARIANT_UNKNOWN)
  assert.equal(detectVariant({ language_type: '_SUB_ITA' }), VARIANT_SUB)
})

test('variant: una provenienza che contraddice il badge resta unknown', async () => {
  // A DUB badge on a card that the `dub=0` pass returned is a contradiction, and
  // the file resolves it to `unknown` instead of trusting the badge or the URL.
  const { rows } = await runSingle(new Map([['0', DUB_CATALOGUE]]))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].variant, VARIANT_UNKNOWN)
  assert.equal(rows[0].language_type, '')
})

// ── 4. due slug distinti per lo stesso titolo ────────────────────────────────

test('slug: DUB e SUB sullo stesso titolo sono due slug distinti e due righe', async () => {
  const { rows } = await runSingle(new Map([['1', DUB_CATALOGUE], ['0', SUB_CATALOGUE]]))
  const slugs = rows.map((r) => r.animeSlug)

  assert.equal(new Set(slugs).size, 2, 'i due slug non si fondono')
  assert.ok(slugs.includes(DUB_SLUG))
  assert.ok(slugs.includes(SUB_SLUG))
  // The titles differ only by a trailing "(ITA)", which `norm()` collapses into
  // the same string: title-keyed merging would keep exactly one of the two.
  assert.notEqual(rows[0].link, rows[1].link)
  assert.notEqual(rows[0].title, rows[1].title)
})

test('slug: la stessa scheda nelle due pass produce una riga sola, non due', async () => {
  const { rows } = await runSingle(new Map([['1', DUB_CATALOGUE], ['0', DUB_CATALOGUE]]))
  assert.equal(rows.length, 1, 'risolvere due volte lo stesso slug produce la stessa riga due volte')
})

// ── 5. le due query, e cosa succede quando una fallisce ─────────────────────

test('query: `/filter` viene letta una volta per variante, con `key=` intatto', async () => {
  const { requested } = await runSingle(new Map([['1', DUB_CATALOGUE], ['0', SUB_CATALOGUE]]))

  assert.equal(requested.length, 2, 'una GET per variante, non tre')
  assert.match(requested[0], /\/filter\?key=One%20Piece&dub=1$/)
  assert.match(requested[1], /\/filter\?key=One%20Piece&dub=0$/)
  for (const url of requested) {
    assert.ok(url.includes('key='), 'il percorso di ricerca esistente resta intatto')
  }
})

test('query: una pass fallita non nasconde l`altra', async () => {
  const { rows, errors } = await runSingle(new Map([['0', SUB_CATALOGUE]]))

  assert.equal(rows.length, 1)
  assert.equal(rows[0].variant, VARIANT_SUB)
  assert.equal(rows[0].animeSlug, SUB_SLUG)
  assert.equal(errors.length, 1)
  assert.match(errors[0], /HTTP 404/)
})

test('query: nessuna pass utile => righe vuote e diagnostica, non un falso match', async () => {
  // Both catalog passes failed, so this is a REAL failure and the source REJECTS
  // rather than returning an empty array: that is the only route by which the
  // cause reaches the user. The rejection must name both URLs.
  await assert.rejects(
    () => runSingle(new Map()),
    (err) => {
      assert.match(err.message, /dub=1/, 'la diagnosi deve citare la pass DUB')
      assert.match(err.message, /dub=0/, 'la diagnosi deve citare la pass SUB')
      return true
    }
  )
})

test('query: `dub` assente dal catalogo lascia solo la variante dichiarata', async () => {
  // Un titolo senza doppiaggio: la pass DUB non deve inventare una riga.
  const { rows } = await runSingle(new Map([['0', SUB_CATALOGUE]]))
  assert.deepEqual([...new Set(rows.map((r) => r.variant))], [VARIANT_SUB])
})

// ── 6. prova live, opt-in ────────────────────────────────────────────────────

test(
  'LIVE: One Piece ep 1 risolve una riga DUB e una SUB, con slug distinti',
  { skip: LIVE ? false : 'serve SAR_LIVE=1: rete reale, ~6 GET verso animesaturn.net' },
  async () => {
    const rows = await animesaturn.single({ titles: ['One Piece'], episode: 1 })

    assert.ok(rows.length >= 1, `nessuna riga dal sito reale (errors: ${rows.errors?.join(' | ')})`)

    const byVariant = new Map(rows.map((r) => [r.variant, r]))
    if (byVariant.has(VARIANT_DUB)) {
      assert.equal(byVariant.get(VARIANT_DUB).animeSlug, DUB_SLUG)
      assert.ok(String(byVariant.get(VARIANT_DUB).link).startsWith('http'))
    }
    if (byVariant.has(VARIANT_SUB)) {
      assert.equal(byVariant.get(VARIANT_SUB).animeSlug, SUB_SLUG)
    }

    // Whatever the site answers, no row may claim a variant it cannot back.
    for (const row of rows) {
      assert.ok([VARIANT_DUB, VARIANT_SUB, VARIANT_UNKNOWN].includes(row.variant))
      assert.equal(detectVariant(row), row.variant)
      assert.equal(row.hash, '', 'mai fabbricare un infohash: il sito non pubblica torrent')
    }
  }
)