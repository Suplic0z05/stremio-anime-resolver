/**
 * test/source-variant.test.mjs — the dub/sub contract as the SOURCES implement it.
 *
 * These are OFFLINE tests. Every fixture below is a candidate list or record set
 * captured verbatim from a live payload, so a test asserts a decision the real site
 * produces rather than one invented here:
 *
 *   • AnimeWorld `/filter?keyword=…` film-list anchors (`data-jtitle` + `href`)
 *   • AnimeUnity `POST /livesearch` → `{records:[…]}`
 *
 * What is being pinned, per source:
 *
 *   ANIMEWORLD distinguishes dub/sub with no field at all — the discriminator is
 *   the `(ITA)` catalogue marker, because the site files a dub and a sub of the
 *   same show as two separate entries. So a single-answer selector structurally
 *   loses the dub, and `selectAnimes` is the fix: same show, both variants.
 *
 *   ANIMEUNITY does declare it, in a numeric `dub` field. `language_type` — the
 *   field a sibling project reads — is NOT in this site's payload; that was
 *   verified against `/livesearch` and is why these tests read `dub`.
 *
 *   ANIMESATURN declares nothing, so it emits no `variant` key at all. That is the
 *   third case the contract has to admit: absent, not guessed.
 *
 * The load-bearing assertions are the NEGATIVE ones (`hasKey === false`): a key
 * present with a made-up value is how a dub silently becomes a sub, so "no
 * declaration ⇒ no key" is asserted directly rather than inferred.
 *
 * Zero network, zero dependencies. Live reachability of the three sites is a
 * separate concern and belongs in a live-only suite.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import animeworld from '../src/sources/animeworld.js';
import animeunity from '../src/sources/animeunity.js';
import animesaturn from '../src/sources/animesaturn.js';
import {
  VARIANT_DUB,
  VARIANT_SUB,
  VARIANT_UNKNOWN,
  detectVariant
} from '../src/variant.js';

// ---------------------------------------------------------------------------
// AnimeWorld fixtures — captured from the live film-list
// ---------------------------------------------------------------------------

/** `?keyword=Naruto` (37 entries). Contains BOTH `Naruto` and `Naruto (ITA)`. */
const AW_NARUTO = [
  { href: '/play/boruto-naruto-next-generations.lYBFQ', animeId: '1', title: 'Boruto: Naruto Next Generations', order: 0 },
  { href: '/play/naruto.Ze1Qv', animeId: '160', title: 'Naruto', order: 1 },
  { href: '/play/naruto-ita.Ze1Qv2', animeId: '161', title: 'Naruto (ITA)', order: 2 },
  { href: '/play/naruto-shippuden-ita.9XRsD', animeId: '3', title: 'Naruto: Shippuuden (ITA)', order: 3 },
];

/** `?keyword=One Piece` (40 entries). Slug `one-piece-subita` is the SUB entry. */
const AW_ONE_PIECE = [
  { href: '/play/one-piece-subita.qzG-LE', animeId: '160', title: 'One Piece', order: 0 },
  { href: '/play/one-piece-ita.d5nahE', animeId: '161', title: 'One Piece (ITA)', order: 1 },
  { href: '/play/one-piece-movie-15-red.iRpAE', animeId: '9', title: 'One Piece Film Red', order: 2 },
  { href: '/play/one-piece-movie-15-red-ita.iRpAE2', animeId: '10', title: 'One Piece Film Red (ITA)', order: 3 },
];

/**
 * `?keyword=Pokemon` — the measured state of that one title: the catalogue carries
 * a DUB and no sub. Pinned because it is the case that must NOT invent a sub row.
 */
const AW_POKEMON = [
  { href: '/play/pokemon-ita.knlaD', animeId: '5', title: 'Pokemon (ITA)', order: 0 },
  { href: '/play/pokemon-sole-e-luna.4SE7T', animeId: '6', title: 'Pokemon Sun & Moon', order: 1 },
];

/** An unmarked movie on its own: nothing here says anything about its audio. */
const AW_UNMARKED_MOVIE = [
  { href: '/play/one-piece-movie-14-stampede.mawDj', animeId: '7', title: 'One Piece Film Stampede', order: 0 }
];

// ---------------------------------------------------------------------------
// AnimeUnity fixtures — captured from the live /livesearch payload
// ---------------------------------------------------------------------------

/**
 * `POST /livesearch {"title":"One Piece"}` → 8 records, of which these are the
 * relevant ones. The numeric `dub` field is present on EVERY record in this
 * payload: 0 on the sub, 1 on the `-ita` dub.
 */
const AU_ONE_PIECE = [
  { id: 12, slug: 'one-piece', dub: 0, type: 'TV', title: null, title_eng: 'One Piece', title_it: null },
  { id: 2998, slug: 'one-piece-ita', dub: 1, type: 'TV', title: null, title_eng: 'One Piece (ITA)', title_it: null },
  { id: 4833, slug: 'one-piece-movie-10-avventura-sulle-isole-volanti', dub: 0, type: 'Movie', title_eng: 'One Piece - Movie 10' },
  { id: 4217, slug: 'one-piece-movie-10-avventura-sulle-isole-volanti-ita', dub: 1, type: 'Movie', title_eng: 'One Piece - Movie 10 (ITA)' },
  { id: 5749, slug: 'one-piece-fan-letter', dub: 0, type: 'Special', title_eng: 'ONE PIECE FAN LETTER' }
];

/** A record whose `dub` field is absent. The source said nothing, so nothing follows. */
const AU_UNDECLARED = [
  { id: 99, slug: 'solo-series', type: 'TV', title_eng: 'Solo Series' }
];

// ---------------------------------------------------------------------------
// AnimeWorld — the `(ITA)` catalogue partition
// ---------------------------------------------------------------------------

describe('animeworld: il marcatore (ITA) e\' la partizione del catalogo', () => {
  test('il marcatore distingue l\'entry dub da quella sub', () => {
    assert.equal(animeworld.isDubEntry('Naruto (ITA)'), true);
    assert.equal(animeworld.isDubEntry('Pokemon Movie 20: Kimi ni Kimeta! (ITA)'), true);
    assert.equal(animeworld.isDubEntry('Boruto: Naruto Next Generations'), false);
    assert.equal(animeworld.isDubEntry('Pokemon Sun & Moon'), false);
    assert.equal(animeworld.isDubEntry(null), false);
  });

  test('senza il marcatore i due titoli normalizzano uguali', () => {
    assert.equal(animeworld.withoutDubMarker('Naruto (ITA)'), 'Naruto');
    assert.equal(animeworld.withoutDubMarker('Pokemon Movie 20: Kimi ni Kimeta! (ITA)'), 'Pokemon Movie 20: Kimi ni Kimeta!');
    assert.equal(animeworld.withoutDubMarker('Naruto'), 'Naruto');
  });

  test('una sola risposta non puo\' restituire due entry: il caso che si perdeva', () => {
    // The defect, stated as a fact about the OLD selector: one answer, dub kept,
    // sub dropped, with nothing in the return value saying a sub existed.
    const single = animeworld.selectAnime(AW_ONE_PIECE, 'One Piece');
    assert.equal(single.title, 'One Piece');
    assert.equal('variant' in single, false, 'selectAnime non conosce la variante');
  });
});

describe('animeworld: selectAnimes() recupera la coppia sub/dub', () => {
  test('"One Piece" -> sub + dub, due righe distinte', () => {
    const out = animeworld.selectAnimes(AW_ONE_PIECE, 'One Piece');
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((e) => e.variant), ['sub', 'dub']);
    assert.deepEqual(out.map((e) => e.title), ['One Piece', 'One Piece (ITA)']);
  });

  test('"Naruto" -> sub + dub, e NON trascina dentro Naruto: Shippuuden (ITA)', () => {
    const out = animeworld.selectAnimes(AW_NARUTO, 'Naruto');
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((e) => e.variant), ['sub', 'dub']);
    assert.deepEqual(out.map((e) => e.title), ['Naruto', 'Naruto (ITA)']);
    // "Naruto: Shippuuden (ITA)" shares the "naruto" prefix and is also a dub, so
    // it is the entry a startswith/includes tier would have reached. Exact
    // marker-stripped equality is what keeps it out.
    assert.equal(out.some((e) => e.title.includes('Shippuuden')), false);
  });

  test('la coppia e\' simmetrica: chiedere "One Piece (ITA)" restituisce anche la sub', () => {
    const out = animeworld.selectAnimes(AW_ONE_PIECE, 'One Piece (ITA)');
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((e) => e.variant), ['dub', 'sub']);
  });

  test('i due href sono diversi: la stessa entry non viene emessa due volte', () => {
    const out = animeworld.selectAnimes(AW_ONE_PIECE, 'One Piece');
    assert.equal(new Set(out.map((e) => e.href)).size, 2);
  });

  test('"Boruto" non viene preso per "Naruto" ne\' viceversa', () => {
    const out = animeworld.selectAnimes(AW_NARUTO, 'Boruto');
    assert.equal(out.length, 1);
    assert.equal(out[0].title, 'Boruto: Naruto Next Generations');
  });
});

describe('animeworld: nessuna variante inventata', () => {
  test('"Pokemon" ha solo il dub: UNA riga, nessuna sub fabbricata', () => {
    const out = animeworld.selectAnimes(AW_POKEMON, 'Pokemon');
    assert.equal(out.length, 1);
    assert.equal(out[0].variant, 'dub');
    // "Pokemon Sun & Moon" e' una sub REALE ma di un'altra serie: non puo'
    // diventare la sub di "Pokemon".
    assert.equal(out.some((e) => e.title === 'Pokemon Sun & Moon'), false);
  });

  test('un film senza marcatore NON riceve `variant: sub`', () => {
    // The absence of `(ITA)` is not a declaration that the audio is subtitled. A
    // guessed `sub` here is the failure mode the whole contract exists to stop, so
    // it is asserted as an ABSENT KEY, not as a different value.
    const out = animeworld.selectAnimes(AW_UNMARKED_MOVIE, 'One Piece Film Stampede');
    assert.equal(out.length, 1);
    assert.equal('variant' in out[0], false, 'un film non marcato non deve dichiarare una variante');
  });

  test('un film marcato come dub senza controparte resta `dub` e basta', () => {
    const out = animeworld.selectAnimes(
      [{ href: '/play/x-ita.aaa', animeId: '1', title: 'Film Solo (ITA)', order: 0 }],
      'Film Solo'
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].variant, 'dub');
  });

  test('nessun match -> array vuoto, non un errore', () => {
    assert.deepEqual(animeworld.selectAnimes(AW_NARUTO, 'Titolo Inesistente'), []);
    assert.deepEqual(animeworld.selectAnimes([], 'One Piece'), []);
  });
});

describe('animeworld: buildResult() porta `variant` sulla riga', () => {
  const episode = { num: 1, token: 'tok' };

  test('la riga sub porta variant sub e il marcatore SUB ITA nel titolo', () => {
    const anime = animeworld.selectAnimes(AW_ONE_PIECE, 'One Piece')[0];
    const row = animeworld.buildResult(anime, episode, 'https://cdn.example/sub.mp4', 'best');
    assert.equal(row.variant, 'sub');
    assert.match(row.title, /One Piece SUB ITA - Ep 1 \[AW\]/);
    assert.equal(row.link, 'https://cdn.example/sub.mp4');
  });

  test('la riga dub porta variant dub e NESSUN marcatore SUB nel titolo', () => {
    const anime = animeworld.selectAnimes(AW_ONE_PIECE, 'One Piece')[1];
    const row = animeworld.buildResult(anime, episode, 'https://cdn.example/dub.mp4', 'best');
    assert.equal(row.variant, 'dub');
    assert.match(row.title, /One Piece \(ITA\) - Ep 1 \[AW\]/);
    assert.equal(/SUB/.test(row.title), false, 'una riga dub non deve dirsi SUB');
  });

  test('senza dichiarazione la riga non ha la chiave `variant`', () => {
    const row = animeworld.buildResult(
      AW_UNMARKED_MOVIE[0], episode, 'https://cdn.example/m.mp4', 'best'
    );
    assert.equal('variant' in row, false);
  });

  test('la riga conserva ancora hash vuoto e link risolvibile', () => {
    const anime = animeworld.selectAnimes(AW_ONE_PIECE, 'One Piece')[0];
    const row = animeworld.buildResult(anime, episode, 'https://cdn.example/x.mp4', 'best');
    assert.equal(row.hash, '', 'nessun torrent su questo sito: hash resta vuoto');
    assert.equal(typeof row.link, 'string');
    assert.equal(row.type, 'best');
  });
});

// ---------------------------------------------------------------------------
// AnimeUnity — the numeric `dub` field
// ---------------------------------------------------------------------------

describe('animeunity: il campo che dichiara la variante e\' `dub`, numerico', () => {
  test('`dub` 1 -> dub, 0 -> sub, e tutto il resto -> null', () => {
    assert.equal(animeunity.variantOfRecord({ dub: 1 }), 'dub');
    assert.equal(animeunity.variantOfRecord({ dub: 0 }), 'sub');
    // Tolerance for the wire spelling, and refusal for anything else: a value the
    // site invents later must not be turned into a confident label.
    assert.equal(animeunity.variantOfRecord({ dub: '1' }), 'dub');
    assert.equal(animeunity.variantOfRecord({ dub: '0' }), 'sub');
    assert.equal(animeunity.variantOfRecord({ dub: true }), 'dub');
    assert.equal(animeunity.variantOfRecord({ dub: false }), 'sub');
    assert.equal(animeunity.variantOfRecord({}), null);
    assert.equal(animeunity.variantOfRecord({ dub: null }), null);
    assert.equal(animeunity.variantOfRecord({ dub: '2' }), null);
    assert.equal(animeunity.variantOfRecord({ dub: 'Italian Dub' }), null);
    assert.equal(animeunity.variantOfRecord(null), null);
  });

  test('la variante segue il RECORD, non lo slug: il nome del record non porta il verdetto', () => {
    // `-ita` in the slug is a transliteration of a title, not a declaration.
    // Measured on the live payload the two agree 40/40, but they are separate
    // facts and the field is the one that gets read.
    assert.equal(animeunity.variantOfRecord({ slug: 'one-piece-ita', dub: 1 }), 'dub');
    assert.equal(animeunity.variantOfRecord({ slug: 'one-piece-ita', dub: 0 }), 'sub');
  });
});

describe('animeunity: pickRecordPair() tiene vivo un record per variante', () => {
  test('"One Piece" -> sub + dub, e i film non fanno da spettatori', () => {
    const out = animeunity.pickRecordPair(AU_ONE_PIECE, 'One Piece');
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((r) => r.variant), ['sub', 'dub']);
    assert.deepEqual(out.map((r) => r.slug), ['one-piece', 'one-piece-ita']);
  });

  test('pickRecord() continua a restituire UNA sola record, come prima', () => {
    // The single-record selector is unchanged in its verdict, not merely in shape:
    // this is the tiering every existing caller and test depends on.
    const single = animeunity.pickRecord(AU_ONE_PIECE, 'One Piece');
    assert.equal(single.slug, 'one-piece');
    assert.equal(single.dub, 0);
  });

  test('la coppia si regge anche chiedendo il titolo con il suffisso (ITA)', () => {
    const out = animeunity.pickRecordPair(AU_ONE_PIECE, 'One Piece (ITA)');
    const byVariant = Object.fromEntries(out.map((r) => [r.variant, r.slug]));
    assert.equal(byVariant.dub, 'one-piece-ita');
    assert.equal(byVariant.sub, 'one-piece');
  });

  test('un record senza `dub` resta utilizzabile e resta non dichiarato', () => {
    const out = animeunity.pickRecordPair(AU_UNDECLARED, 'Solo Series');
    assert.equal(out.length, 1);
    assert.equal(out[0].slug, 'solo-series');
    assert.equal('variant' in out[0], false, 'un record non dichiarato non nega una variante');
  });

  test('nessun record -> nessuna coppia', () => {
    assert.deepEqual(animeunity.pickRecordPair([], 'One Piece'), []);
  });
});

describe('animeunity: buildResult() porta `variant` sulla riga', () => {
  test('sub e dub sulla stessa serie, due righe distinte', () => {
    const [sub, dub] = animeunity.pickRecordPair(AU_ONE_PIECE, 'One Piece');
    const a = animeunity.buildResult(sub, 1, 'https://v.example/sub.mp4', 'best');
    const b = animeunity.buildResult(dub, 1, 'https://v.example/dub.mp4', 'best');
    assert.equal(a.variant, 'sub');
    assert.equal(b.variant, 'dub');
    assert.notEqual(a.link, b.link);
    assert.notEqual(a.title, b.title);
    assert.match(a.title, /\[AU\]$/);
  });

  test('senza dichiarazione la riga non ha la chiave `variant`', () => {
    const row = animeunity.buildResult(AU_UNDECLARED[0], 1, 'https://v.example/x.mp4', 'best');
    assert.equal('variant' in row, false);
  });

  test('hash resta vuoto: nessun torrent, magnet o infohash su questo sito', () => {
    const [sub] = animeunity.pickRecordPair(AU_ONE_PIECE, 'One Piece');
    const row = animeunity.buildResult(sub, 1, 'https://v.example/x.mp4', 'best');
    assert.equal(row.hash, '');
  });
});

// ---------------------------------------------------------------------------
// AnimeSaturn — the source that declares nothing
// ---------------------------------------------------------------------------

describe('animesaturn: il campo `sub` di una card NON e\' una variante', () => {
  // This is a trap worth pinning, because the field NAME is misleading: a parsed
  // card does carry a `sub` key, but it comes from the card's `ac__sub` element,
  // which on this site is the descriptor line ("08 Aprile 2019 · 8 ep") — the date
  // and episode count, not the audio track. Asserted here because a test (or a
  // later reader) that saw `sub` and reached for it would classify a film from its
  // release date.
  test('il `sub` della card e\' la riga descrittiva, non un marker audio', () => {
    const card = animesaturn.parseCandidates(
      '<a href="/anime/one-piece" class="ac group">' +
        '<h3 class="ac__title">One Piece</h3>' +
        '<span class="ac__type-badge">TV</span>' +
        '<p class="ac__sub">08 Aprile 2019 &middot; 8 ep</p>' +
        '</a>'
    );
    assert.equal(card.length, 1);
    assert.equal(card[0].sub, '08 Aprile 2019 · 8 ep');
    assert.equal(card[0].year, '2019');
    assert.equal(card[0].episodes, '8');
  });

  test('nessuna di queste righe viene letta come una variante', () => {
    // Measured on the real /filter payload: the "Doppiato" / "Sottotitolato" words
    // appear ONLY inside the search FORM (`<input name="dub">` plus its two
    // buttons), never on a result card. And no `language_type` is present at all.
    // So a card resolves to `unknown` rather than to a guessed `sub`.
    const card = animesaturn.parseCandidates(
      '<a href="/anime/one-piece" class="ac group">' +
        '<h3 class="ac__title">One Piece</h3>' +
        '<span class="ac__type-badge">TV</span>' +
        '<p class="ac__sub">08 Aprile 2019 &middot; 8 ep</p>' +
        '</a>'
    )[0];
    assert.equal('variant' in card, false, 'una card non porta `variant` di sua iniziativa');
    assert.equal(detectVariant(card), VARIANT_UNKNOWN);
    // The same must hold even if the descriptor line were to contain the word,
    // which is why this is asserted directly rather than left to chance.
    assert.equal(detectVariant({ sub: '08 Aprile 2019 · sottotitolato' }), VARIANT_UNKNOWN);
  });
});

// ---------------------------------------------------------------------------
// The contract itself, as consumed
// ---------------------------------------------------------------------------

describe('contratto: la chiave che i resolver leggono', () => {
  test('detectVariant() legge `variant` come lo scrivono le fonti', () => {
    // The whole point of the scrapers emitting the key: the resolver's normaliser
    // has to recognise what they actually write, not a differently-spelled field.
    const awRow = animeworld.buildResult(
      animeworld.selectAnimes(AW_ONE_PIECE, 'One Piece')[0], { num: 1 }, 'https://x/1.mp4', 'best'
    );
    const auRow = animeunity.buildResult(
      animeunity.pickRecordPair(AU_ONE_PIECE, 'One Piece')[1], 1, 'https://x/1.mp4', 'best'
    );
    assert.equal(detectVariant(awRow), VARIANT_SUB);
    assert.equal(detectVariant(auRow), VARIANT_DUB);
    assert.equal(detectVariant(animesaturn.parseCandidates('<a href="/anime/x" class="ac group"></a>')[0] ?? {}), VARIANT_UNKNOWN);
  });
});