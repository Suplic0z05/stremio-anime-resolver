# stremio-anime-resolver

Addon Stremio che risolve episodi di anime a **link diretti HTTPS** e i metadati
da **Kitsu**. Node >= 20, ESM, **zero dipendenze npm**: solo stdlib e `fetch`
globale.

```bash
node --test test/     # test
npm start             # serve l'addon (src/server.js)
```

---

## Porta di ascolto, e la variabile che la cambia

Il server ascolta su **7000** e su **`127.0.0.1`**. La porta si cambia con la
variabile d'ambiente **`PORT`**, l'host con **`HOST`**: entrambe lette in un solo
punto, il blocco `isEntrypoint` in `src/server.js`.

```js
const port = Number.parseInt(process.env.PORT ?? '', 10) || DEFAULT_PORT
const host = process.env.HOST || DEFAULT_HOST
```

> `src/server.js:204-205`. Il guard di ingresso è `src/server.js:203`
> (`if (isEntrypoint) {`, lanciato da `src/server.js:201`) e le due righe sono le
> prime due del suo corpo: è **l'unico** punto del file che legge `process.env` per
> la rete, perché `createAddonServer()` (`src/server.js:195`) non prende porta né
> host — li riceve già risolti da qui. Il `server.listen` che le riceve è
> `src/server.js:207`, e per una porta fuori range rimanda a `node:net`.
>
> **Questi numeri si spostano**: `src/server.js` è un file che cambia, quindi per
> riverificarli non fidarsi di questa riga ma eseguire
> `grep -n "process.env.PORT\|process.env.HOST\|server\.listen\|isEntrypoint" src/server.js`.

Avvio con porta non di default, e le due URL che ne conseguono:

```bash
PORT=7311 node src/server.js
# [server] listening on http://127.0.0.1:7311

# l'URL da dare a Stremio è il manifest, non la radice:
curl -s http://127.0.0.1:7311/manifest.json
```

Verificato eseguendo il server, non letto: con `PORT=7311` (Node v26.10.0) la porta
7311 risponde `200 {"ok":true}` su `/health` e `200` con il JSON del manifest su
`/manifest.json`, mentre `127.0.0.1:7000` rifiuta la connessione. Quindi `7000` è
davvero il fallback, non un secondo ascolto.

**`/health` è il probe economico**: risponde `{"ok":true}` senza toccare Kitsu
(ramo `/health` dentro `createRequestListener`, `src/server.js:143-147`), quindi una
porta sbagliata si vede subito invece di dedurla dall'assenza di risultati — che
è il sintomo che fa perdere tempo.

> La riga che si legge male è `src/server.js:135-139`, il ramo **405** per un metodo
> diverso da `GET`/`HEAD`: rifiuta **prima** di guardare il path, quindi un `405` non
> dice che `/health` sia rotto. Misurato sul server in ascolto:
> `GET /health` → `200 {"ok":true}`, `HEAD /health` → `200`, `POST /health` →
> `405 {"error":"method not allowed"}`.
> `src/server.js:141` è `pathSegments(req)`, l'unico punto in cui i segmenti del
> path vengono spezzati per tutte le rotte. Come sopra, per i numeri:
> `grep -n "method not allowed\|pathSegments(req)\|=== 'health'" src/server.js`.

### Tre modi in cui `PORT` ti tradisce, e il quarto in cui ti ferma

`|| DEFAULT_PORT` è un fallback **silenzioso**. Le quattro righe qui sotto sono
misurate lanciando il server quattro volte:

| `PORT` | porta effettiva | perché |
|---|---|---|
| non impostata | **7000** | `parseInt` su `undefined` → `NaN` → falsy |
| `7311` | **7311** | il caso normale |
| `abc` | **7000** | `parseInt('abc')` → `NaN` → falsy: **nessun avviso** |
| `0` | **7000** | `0` è falsy: **`PORT=0` non chiede "una porta libera"** |
| `70000` | **non parte** | `RangeError` dal `validatePort` **di Node**, non da questo codice: il server muore al `listen` |

L'ultima riga è l'unica che **non** si arresta su un fallback. Tutte le altre
ricadono su `|| DEFAULT_PORT` e continuano a funzionare; `70000` supera il
`parseInt` senza problemi e viene consegnato a `node:http`, che lo rifiuta.

> **Provenienza di `validatePort`.** La funzione esiste, ma **non è di questo
> progetto**: è interna a `node:net` e si raggiunge solo attraverso
> `Server.listen`. `grep -rn validatePort .` su questo albero restituisce **zero
> occorrenze in `src/` e in `test/`**. La riga che la chiama è `src/server.js:207`
> (`server.listen(port, host, …)`), e lo stack la nomina per intero:
>
> ```
> node:net:2613
>     validatePort(options.port, 'options.port');
>     ^
>
> RangeError [ERR_SOCKET_BAD_PORT]: options.port should be >= 0 and < 65536. Received type number (70000).
>     at Server.listen (node:net:2613:5)
>     at file:///…/src/server.js:207:10
>   code: 'ERR_SOCKET_BAD_PORT'
> ```
>
> Misurato con `PORT=70000 node src/server.js` (Node v26.10.0). La regola di
> questo progetto è non nominare cose che non ci sono, quindi il nome va
> attribuito: è codice di Node, non un controllo di porta scritto qui.

Un refuso in `PORT` non si annuncia: si manifesta come "il mio addon non risponde"
sulla 7000. Sulle porte sotto 1024 il fallimento è un altro ancora — `PORT=80x`
viene parsato come `80` e si ferma su `EACCES` — quindi se l'errore è un permesso e
non un numero, il numero è il refuso.

`HOST` è la leva della rete: `HOST=0.0.0.0` espone l'addon alla LAN, comodo in una
rete fidata e da non fare su una rete pubblica. Il default loopback è una scelta,
non un vincolo di piattaforma.

---

## I tre scraper sono file derivati, non codice nuovo

`src/sources/animeworld.js`, `src/sources/animesaturn.js` e
`src/sources/animeunity.js` sono **copie di file derivati** da
[`shiru-italian-streaming`](https://github.com/Suplic0z05/shiru-italian-streaming)
(**GNU GPL v3**), percorso originale:

| qui | upstream |
|---|---|
| `src/sources/animeworld.js` | `animeworldsearch/sources/animeworld.js` |
| `src/sources/animesaturn.js` | `animesaturnsearch/sources/animesaturn.js` |
| `src/sources/animeunity.js` | `animeunitysearch/sources/animeunity.js` |

Questo progetto è quindi **GPL-3.0-or-later** (vedi `LICENSE`, testo GPL v3
completo): la GPL copre i file copiati, e quindi questo progetto.

**Cosa significa "copiato" in pratica.** Il corpo di ciascun file è
**byte-identico** all'originale; l'unica differenza è il banner di provenienza in
testa. Non è una scelta di stile: quelle routine di parsing, ricerca e
risoluzione URL sono coperte da test upstream e sono state **misurate** contro i
siti reali. AnimeSaturn, per esempio, contiene la dimostrazione empirica della
chiave XOR che ricava la chiave dai primi 8 byte conoscendo
`https://` in chiaro, e AnimeUnity contiene quattro deviazioni del sito che
rispondono tutte **HTTP 200 con un corpo inutilizzabile** — quattro trappole che
un `if (!res.ok)` non intercetta. Riscriverle o "migliorarle" significa rifare
quelle misurazioni o perderle.

**Se una delle fonti è sbagliata, la correzione va fatta a monte e poi
ricopiata.** Non qui.

### Adattamento a Node: nessuno, e questo è un risultato misurato

I tre file erano già moduli ESM senza sintassi da bundler, e `fetch`,
`AbortController`, `AbortSignal.timeout`, `String#normalize` e `Buffer` sono
tutti globali su Node >= 18. Esportano `new class …`, cioè **un'istanza**:
`resolver.js` importa il default statico e non usa mai `new`. Verificato:

```
animeworld   | typeof default: object | single/batch/movie/validate: function | is class? false
animesaturn  | typeof default: object | single/batch/movie/validate: function | is class? false
animeunity   | typeof default: object | single/batch/movie/validate: function | is class? false
```

Il contratto che i tre file mantengono, e che `src/resolver.js` consuma senza
modificarlo:

- `single()`, `batch()`, `movie()` risolvono in un **array reale**. Il consumer
  fa spread del valore atteso (`results.push(...result.value)`), quindi restituire
  `{ results, errors }` sarebbe un `TypeError`. Le diagnostiche viaggiano sulla
  proprietà `errors` dell'array.
- nessuna corrispondenza genuina → `[]`. Fallimento reale (HTTP 500, timeout,
  errore di trasporto) → **throw** con messaggio che nomina URL e status.
- batch parziale: se sopravvive almeno un risultato si restituisce l'array; si
  fa throw solo a zero superstiti.
- `validate()` è async, risolve `true`/`false` e non fa mai throw.
- `hash` è `''` su **ogni** risultato: questi tre siti non pubblicano torrent,
  magnet né infohash.

---

## Questi stream NON sono torrent

I link sono **HTTPS diretti a file media**. `TorrentResult.hash` resta `''`
perché qui non esiste un infohash da metterci: inventarne uno produrrebbe un
risultato plausibile e morto, che è peggio di uno vuoto. Non è un bug da
correggere e non è un campo da riempire "per compatibilità".

Conseguenza diretta: **questi stream non sono riproducibili con il motore
BitTorrent** di uno Shiru stock. Vanno riprodotti da un client che segua un URL
HTTP diretto, ed è per questo che il campo che interessa qui è `link`
(diventato `url` nello `Stream` di Stremio).

## HTTPS in `getInfoHash` sembra dare torto a tutto questo, e non lo fa

C'è **un punto** in cui il codice di Shiru accetta una URL che inizia con `http`,
ed è il punto in cui un lettore futuro conclude che HTTPS sia supportato.
`client/lib/util.js:125-131`:

```js
if (typeof input === 'string' && input.startsWith('http')) {
  const res = await fetch(input)
  if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`)
  input = new Uint8Array(await res.arrayBuffer())
}
const parsed = await parseTorrent(input)
if (!parsed.infoHash) throw new Error('Invalid torrent data or magnet link')
```

La URL viene **scaricata**, e va detto chiaramente: qui un percorso HTTP esiste,
è solo che non fa quello che sembra.

Ma per cosa viene scaricata. `parseTorrent` vuole metainfo **bencoded** e vuole
calcolarne l'`infoHash`. Un `.mp4` o un `.m3u8` non ha un `infoHash`: l'input
finisce nel `throw`, la funzione è interamente dentro un `try`/`catch` che finisce
in `return null`, e il risultato è `null`. **Il download è riuscito e il file è già
in memoria** — è questo che rende la strada costosa, non il fatto che fallisca.

**HTTP è il canale di trasporto dei file `.torrent`, non dei video.** La stessa
funzione accetterebbe volentieri `https://host/x.torrent`, che è esattamente il caso
per cui è stata scritta. `startsWith('http')` basta e avanza per un torrent
remoto; non distingue un `.torrent` da un `.mp4`. L'unico controllo che
distingue — chiedere a `parseTorrent` se quei byte sono un torrent — arriva
**dopo** che i byte sono in memoria, e per l'app è la riga che lancia l'errore.

Questo è il punto esatto in cui l'installazione di
[`shiru-italian-streaming`](../shiru-italian-streaming/README.md) non fallisce in
modo pulito: `null` dopo un download completo. È il motivo per cui quel repository va
dichiarato **non installabile**, invece di lasciarlo passare una validazione che
non può concludere.

> **Provenienza.** Letto in `~/Archive/Shiru/Shiru-master`, l'unica copia del
> sorgente presente su questa macchina, che è **6.8.1-beta.4**
> (`electron/package.json:3`). Le righe 125-131 sono il codice, e il loro numero
> coincide con quello che l'attribuzione alla 6.9.0 indica; ma le due copie non sono
> la stessa versione, quindi il numero di riga è confermato **su 6.8.1-beta.4**.

## Gli URL di Saturn e Unity sono temporanei

Le risoluzioni di AnimeSaturn e AnimeUnity **non** sono URL stabili:

- **AnimeSaturn** – quattro hop (`/api/watch/{slug}/ep-N`, la shell dell'embed,
  `play.saturncdn.net/embed/{i}/playlist`, poi la decodifica base64 + XOR del
  campo `d`). Il token porta una scadenza: `expires` è circa *now + 12 h*, e i
  valori si rigenerano a ogni richiesta. Il file upstream lo dichiara esplicitamente
  ("hops 2-4 run per episode and are never cached across calls").
- **AnimeUnity** – l'URL finale è un VixCloud dietro un `downloadUrl` con token
  di breve durata.

**Di conseguenza questo progetto non implementa alcuna cache degli URL risolti,
a nessun livello**: niente memoizzazione in `resolver.js`, niente cache HTTP su
`link`. Un URL in cache non è un URL lento, è un URL rotto. AnimeWorld non ha
questa problematica (nessun token), ma la regola vale uguale per tutte e tre,
così il comportamento non dipende dalla fonte.

## Due limiti dei dati che escono dalle fonti

### Il formato del media non è lo stesso per le tre fonti

| Fonte | Cosa restituisce | Dove si legge |
|---|---|---|
| **AnimeWorld** | **MP4** diretto | `animeworld.js:380` — "Ask the episode API for the direct .mp4" |
| **AnimeUnity** | **MP4** diretto, VixCloud con token breve | `animeunity.js:44`, `animeunity.js:465` |
| **AnimeSaturn** | **HLS *e* MP4**, secondo il titolo | `animesaturn.js:451-465` |

AnimeSaturn **non** è una fonte HLS, e il file lo dichiara come correzione
esplicita di un'assunzione precedente (`animesaturn.js:76-79`, "IMPORTANT
CORRECTION to the assumption that every payload ends in .m3u8: it does not"). Lo
stesso endpoint serve due forme diverse, e per questo il gate dell'hop 4 ne
accetta quattro e non una:

```js
if (!/\.(m3u8|mp4|m4v|webm)(\?|$)/i.test(media)) {
```

Lo stesso file esemplifica le due forme con `playlist.m3u8` (One Piece) e
`KimetsuNoYaiba_Ep_01_SUB_ITA.mp4`. La conseguenza pratica è che **quello che
ricevi non è omogeneo**: un client che accetta solo MP4, o che non implementa HLS,
perde una parte del catalogo di Saturn senza che nulla lo dichiari.

**Nessun tetto di risoluzione è codificato qui.** Misurato sui tre scraper, che
sono l'unico posto dove un tetto avrebbe effetto su cio' che viene servito:

```bash
grep -rnE '480|720|1080|360' src/sources/
```

Restituisce **una sola riga**, e e' un commento: `src/sources/animeunity.js:121`, un
nome di file d'esempio. Nessuno dei tre legge una variant list di un master
playlist. La risoluzione che ottieni e' quella che il sito ha pubblicato quel
giorno, non una scelta di questo codice.

> Attenzione a **dove** si cerca. Fuori da `src/sources/`, `480` compare eccome:
> `src/manifest.js:421-422` tiene una scala di marche di qualita' lette dal testo
> dell'URL (`480p`, `480` nel path, e cosi' via). Quella non e' un tetto: e' una
> **chiave di ordinamento**, e serve a mettere piu' in alto lo stream di qualita'
> piu' alta. Non filtra niente, non scarta niente, non sceglie — dichiara solo
> quale altezza un URL *dichiara* di avere.
>
> E il comando storico qui era `grep -n '480\|variant'`, che **mescola due domande
> diverse**: `480` non compare nei tre scraper, ma `variant` ne compare 28 volte in
> `animesaturn.js` — e quel numero non dice niente sui tetti di risoluzione, dice
> solo che il doppiaggio e' implementato. Un grep che unisce due conceti restituisce
> un numero che sembra misurare entrambi e non misura nessuno.

### Doppiaggio e sottotitolati: il segnale era testo, e ora è un vocabolario

Nessuno dei tre espone un campo audio strutturato. Il segnale **esiste** in due
fonti su tre, ed è leggibile:

| Fonte | Segnale di doppiaggio | Accertamento |
|---|---|---|
| **AnimeWorld** | **sì, e dichiarato** | `src/sources/animeworld.js:551` — `const marker = /\(\s*ITA\s*\)/i.test(anime.title) ? '' : ' SUB ITA'` |
| **AnimeSaturn** | **sì, per preferenza** | `src/sources/animesaturn.js:475` — `candidates.filter((c) => /^(tv\|dub)$/i.test(c.type))`, commento "TV/DUB cards are scanned first" a `:471` |
| **AnimeUnity** | **no**, fansub dichiarato | `src/sources/animeunity.js:119-122` — "FANSUB, NOT DUB … the stream's own filename marks it SUB. Nothing here claims a dub." |

AnimeWorld è il caso più esplicito, perché il file contiene la misura su cui si
basa (`src/sources/animeworld.js:530-536`): `"(ITA)"` in `data-jtitle` marca la voce doppiata e
la sua assenza quella sottotitolata.

```
"Naruto (ITA)"    -> Naruto_Ep_001_ITA.mp4                (dub)
"Boruto: …"       -> Boruto_Ep_001_SUB_ITA.mp4            (sub)
"Pokemon Sun & Moon" -> PokemonSoleELuna_Ep_003_SUB_ITA.mp4  (sub)
```

Quindi il marcatore che lo scraper appende al titolo è `' SUB ITA'`, non un generico
`' ITA'`: se il titolo del sito porta già `(ITA)` il file è il doppiato e non serve
aggiungere nulla, altrimenti il risultato viene dichiarato sottotitolato. Il
commento registra anche **perché** la scelta è quella e non una scioltezzaza — un
`ITA` senza marcatore dichiarava il doppiaggio su un file sub:

```
"So a bare \"ITA\" claimed DUB for a sub file: One Piece episode 5 came back
titled \"One Piece ITA - Ep 5 [AW]\" while linking OnePiece_Ep_0005_SUB_ITA.mp4."
```

E dichiara anche il limite, che è il limite comune alle tre
(`src/sources/animeworld.js:542`): "The title marker is the **only** discriminator the index
exposes: `collectResults` returns just `{href, animeId, title, order}`, there is no
sub/dub field to read" — e non può diventare un risultato doppio, perché il sito
tiene sub e dub come voci di catalogo separate e `selectAnime` ne restituisce
esattamente una.

La regola per un consumatore è quindi asimmetrica, e **non** è "tratta tutto come
sottotitolato":

- **AnimeUnity** è sottotitolato, e il `SUB` nel nome del file è l'unica prova.
- **AnimeSaturn** cerca la card `dub`, quindi arriva sub solo se il sito non ha una
  voce doppiata per quel titolo.
- **AnimeWorld** dichiara il sub esplicitamente nel titolo del risultato, e il dub
  quando il sito lo etichetta `(ITA)`.

### Il segnale è diventato un campo, senza diventare una verità

Il limite qui sopra **resta vero sul piano dei dati**: il segnale arriva dentro la
stringa del titolo o dentro l'ordine di preferenza della ricerca. Quello che e'
cambiato e' **chi fa la traduzione**. Non e' piu il client: ora c'e' un vocabolario
condiviso in `src/variant.js`, e i posti che se ne servono sono cinque.

| Dove | Cosa fa |
|---|---|
| `src/variant.js` | il vocabolario: `VARIANT_DUB`, `VARIANT_SUB`, `VARIANT_UNKNOWN`, piu `detectVariant`, `variantLabel`, `parseVariantParam` |
| `src/resolver.js` | legge la riga della fonte e la porta sulla riga interna |
| `src/routes/api.js` | restituisce `variant` **sempre**, anche quando e' `unknown` |
| `src/manifest.js` | usa la variante per la `description` e per il `bingeGroup` della proiezione Stremio |
| `src/sources/animesaturn.js` | **copia locale e pinnata**, non un import — vedi sotto |

```bash
grep -rn 'VARIANT_DUB\|VARIANT_SUB\|VARIANT_UNKNOWN' src/ --include='*.js' -l
```

**Perche' Saturn non importa `src/variant.js`.** Non e' una scelta di stile: quel
file e' un derivato del repository GPL upstream, e li' `src/variant.js` **non
esiste**, quindi un `import` si risolverebbe in `ERR_MODULE_NOT_FOUND` al load. La
copia e' **pinnata, non fidata**: `test/saturn-variant.test.mjs` asserisce che ogni
marcatore risolto li' si risolve identico attraverso `src/variant.js`, cosi' le due
copie non possono divergere senza rompere un test. Il resto dei tre file derivati
non ha una variante da portare e non ha quindi niente da copiare.

La regola che regge `src/variant.js` e' che si crede **solo a un campo esplicito**,
e solo se contiene esattamente uno dei due marcatori. Un `[ITA]` nudo o un ` ITA`
sciolto **non** vengono interpretati: dicono che la lingua e' italiana, non se
l'audio fosse doppiato o il dialogo sottotitolato, e leggere l'uno come l'altro
sarebbe proprio l'affermazione plausibile che questo progetto si rifiuta di fare.
Un titolo che dice solo `ITA` viene riportato `unknown`, che e' un'affermazione
vera. **`unknown` non viene mai sostituito di default con `sub`**: quel default e'
indistinguibile da una risposta reale, ed e' quello che farebbe sparire un doppiato
in silenzio.

Percio' un client oggi **non e' piu obbligato a leggere il titolo**: può leggere un
campo. Ma il campo non e' piu forte del titolo, e la sua affidabilita' continua a
dipendere da come il sito etichetta oggi.

```bash
# il plumbing e' reale ed e' spedito, non una promessa:
grep -c '480\|variant' src/sources/animesaturn.js   # 28 righe (0 in `480`, tutte in `variant`)
```

**Il limite che resta, e che nessun campo risolve**: `variant` e' una
**classificazione lato addon**, derivata da marcatori raccolti con lo scraping. Non
e' una dichiarazione del sito, non e' un metadata autorevole, e non e' una garanzia
di questo codice. Se un sito cambia etichetta, la classificazione cambia con lui e
nessuno riceve un errore: semplicemente risponde `unknown`, o sbaglia con aria di
sicurezza. E' esattamente per questo che il filtro di `/api/streams?variant=dub` e'
**stretto**: una riga non dichiarata e' `unknown` e quindi *esclusa*, perche'
includerla starebbe affermando un fatto che nessuno ha dichiarato.

Entrambi i limiti valgono anche per l'altro repository: i corpi dei tre file sono
**identici bit per bit**, e l'unica differenza è il banner di provenienza in testa.
Nessun limite è stato introdotto qui.

**Il comando, e perché l'offset è diverso per ciascuno.** Il banner non è della
stessa lunghezza nei tre file, quindi un offset unico darebbe un falso mismatch:

| qui | banner | corpo dalla riga | upstream |
|---|---|---|---|
| `src/sources/animeworld.js` | **28** righe | **`+29`** | `animeworldsearch/sources/animeworld.js` |
| `src/sources/animesaturn.js` | **40** righe | **`+41`** | `animesaturnsearch/sources/animesaturn.js` |
| `src/sources/animeunity.js` | **29** righe | **`+30`** | `animeunitysearch/sources/animeunity.js` |

```bash
cd /home/suplic0z/Projects/stremio-anime-resolver
U=/home/suplic0z/Projects/shiru-italian-streaming

tail -n +29 src/sources/animeworld.js   | cmp - "$U/animeworldsearch/sources/animeworld.js"    && echo OK
tail -n +41 src/sources/animesaturn.js  | cmp - "$U/animesaturnsearch/sources/animesaturn.js"  && echo OK
tail -n +30 src/sources/animeunity.js   | cmp - "$U/animeunitysearch/sources/animeunity.js"     && echo OK
```

`cmp` senza output ed `exit 0` vuol dire identico; qualunque differenza stampa
`differ: N byte` o `EOF`. Eseguito il 2026-10-05: **tre `OK`**, cioe' `cmp`
pulito per tutti e tre.

**Prima di fidarsi dell'offset, un controllo che non costa niente**: l'ultima riga
del corpo deve essere il commento che chiude il banner, e ognuno dei tre nomi si
riconosce:

```bash
sed -n '29p' src/sources/animeworld.js   # // AnimeWorld Source for Shiru
sed -n '41p' src/sources/animesaturn.js  # // AnimeSaturn Source for Shiru
sed -n '30p' src/sources/animeunity.js   # // AnimeUnity Source for Shiru
```

Se quella riga non e' quella, l'offset e' sbagliato — ed e' esattamente cosi' che
un offset tarato male produce un **mismatch falso**: si taglia dentro il corpo, si
confrontano pezzi diversi, e il corpo perfettamente identico sembra divergente.
Misurato, sbagliando l'offset di Saturn:

```
$ tail -n +29 src/sources/animesaturn.js | cmp - …/animesaturn.js
… differ: byte 4, line 1          # exit 1 — ma i due file sono identici
```

Lo stesso controllo con `md5sum`, che dà lo stesso verdict:

```bash
tail -n +29 src/sources/animeworld.js  | md5sum   # da9d452c688fec5815e0f4bfe74cb6b6
md5sum "$U/animeworldsearch/sources/animeworld.js" # da9d452c688fec5815e0f4bfe74cb6b6
```

**Una cosa che sembra una contraddizione e non lo e'.** Il banner di
`src/sources/animesaturn.js` dichiara testualmente `ONE DELIBERATE DEVIATION, and
it is in the shared body rather than in this banner`: il tagging dub/sub di Saturn
**non** importa `detectVariant`, tiene i token set in locale. Quindi il corpo non e'
"sorgente puro". Eppure `cmp` resta pulito, perche' **le due copie portano la
deviazione insieme**: e' una scelta progettuale condivisa, non un edit applicato
solo da una parte. Percio' "identici bit per bit" e "c'e' una deviazione
dichiarata" sono entrambi veri e non si contraddicono — quello che non si puo' fare
e' chiamarla una deviazione *da* upstream senza sapere che cosa ha upstream.

## I metadati vengono da Kitsu, e Kitsu non ha titoli italiani

`src/kitsu.js` parla solo con `https://kitsu.io/api/edge`:

- `GET /anime?filter[text]=<q>&page[limit]=N` → ricerca
- `GET /anime/{id}?include=genres` → metadati + generi (un colpo solo, niente N+1)
- `GET /anime/{id}/episodes?page[limit]=N&page[offset]=M&sort=number` → episodi,
  con paginazione fino a esaurire (`meta.count` dà il totale)

### `/catalog` restituisce 20 righe e non pagina: è una **limitazione**

Il tetto di 20 non è una scelta di questo progetto. È il tetto di Kitsu
(`meta.count: 22491` titoli in catalogo, misurato sull'API vera), e la catena è:

```bash
grep -n 'KitsuMaxPageSize' src/kitsu.js                       # 20
grep -n 'DEFAULT_LIMIT' src/manifest.js                       # 20, "tetto paginazione Kitsu"
grep -n 'export async function search' src/kitsu.js           # 493: (query, { limit, timeoutMs })
```

`clampPageSize` tronca **prima** di mettere sulla rete: `?limit=100` non diventa un
400, diventa 20. Verificato: `/catalog/anime/kitsu-anime.json?search=a` → 20 righe,
e con `&limit=100` → **20 righe uguali**, nessun errore.

E la parte che conta: **`skip` non esiste.** `kitsu.search` ha firma
`(query, { limit, timeoutMs })` — nessun offset da passare — quindi `/catalog` non
può restituire la riga 21, la 41, la 22491. Un `?skip=20` viene **ignorato**:
`parseExtraSegment` lascia le chiavi sconosciute nella mappa e nessuno le legge, e
cosi' la risposta è la stessa del `skip=0`, mai un 400 e mai un 404. Su un
catalogo di 22 491 titoli con 20 righe per risposta, questo è il collo di
bottiglia vero: un client che si limita a sfogliare vede **20 titoli, cioè lo
0,09% del catalogo**. Tutto il resto è raggiungibile solo formulando una ricerca.

**Quindi la ricerca è l'unico modo per arrivare al resto, ed è dichiarata per
questo.** `src/manifest.js:113-118`:

```js
catalogs: [{
  type: CATALOG_TYPE,
  id: CATALOG_ID,
  name: CATALOG_NAME,
  extra: [{ name: 'search', isRequired: false }],
}],
```

Senza quella dichiarazione il client Stremio **non chiede mai la ricerca**, e per
un catalogo di 22 000 titoli servono 1 100 richieste da 20 righe per esaurirlo —
impossibile. Con `extra`, la ricerca è un campo che il client mette in primo piano.

**Le due forme, entrambe vive**, misurate il 2026-10-05 contro il server in
ascolto:

```bash
# forma a QUERY
curl -s 'http://127.0.0.1:7000/catalog/anime/kitsu-anime.json?search=Naruto'        # 200, 20 righe

# forma a SEGMENTO di path, quella che Stremio usa davvero per un `extra`
curl -s 'http://127.0.0.1:7000/catalog/anime/kitsu-anime/search=Naruto.json'        # 200, risultati
curl -s 'http://127.0.0.1:7000/catalog/anime/kitsu-anime/search.json?search=Naruto' # 200, risultati
```

`src/routes/catalog.js` le tratta insieme e dà la precedenza al segmento: il 4°
segmento del path viene parsato in coppie `chiave=valore`, e un `search` non vuoto
vince su `?search=`. La ragione è che un client che invia un `extra` dichiarato
**non** appende un `?search=` di suo percorso.

Un caso che vale la pena sapere, perché è un `200` che sembra un bug:

```bash
curl -s 'http://127.0.0.1:7000/catalog/anime/kitsu-anime.json'   # 200 {"metas":[]}
```

Il browse senza ricerca **restituisce vuoto**, e la chiave `metas` c'è comunque:
un `{}` o un array nudo romperebbero il client. Non è un errore e non è un 404; è
il comportamento di Kitsu su una ricerca vuota.

Cinque fatti misurati sull'API vera che la struttura del file riflette. Tutti e
cinque sono stati trovati da una misura o da una chiamata live, non da un mock.

1. **`page[limit]` ha un tetto di 20, su entrambi gli endpoint.** Oltre, HTTP 400:

   | richiesta | N=20 | N=21 | N=50 | N=200 |
   |---|---|---|---|---|
   | `/anime?filter[text]=…` | 200, 20 risultati | **400** | **400** | **400** |
   | `/anime/12/episodes` | 200, 20 risultati | **400** | **400** | **400** |

   Il 400 lo dice da solo: `"detail": "Limit exceeds maximum page size of 20."`.
   Per questo ogni `page[limit]` passa da `clampPageSize()` **in un unico punto**
   (`requestJson()`): `search('x', {limit: 50})` non genera un 400, genera una
   richiesta ben formata per 20. Il clamp esiste anche in `paginate()`, che
   pagina con lo stesso tetto.

   *Nota su come misurare questo.* In bash, `curl "...filter\[text\]=..."` dentro
   doppi apici **conserva i backslash**: curl manda `filter\[text\]`, Kitsu
   **ignora in silenzio** l'intera query string e risponde **200 con i primi 10
   record del catalogo non filtrato** (Cowboy Bebop, Trigun) e
   `meta.count: 22491`. Una misura corrotta quindi non errore: restituisce un 200
   plausibile. La scala va letta insieme a `meta.count` e al primo titolo
   restituito, mai dal solo codice di stato.

2. **`sort=-searchScore` risponde HTTP 400** su `/anime`. Non viene mai inviato, da
   nessuna delle due funzioni, e `test/kitsu.test.mjs` lo verifica su *ogni* URL
   registrato invece che una volta sola. `sort=number` sull'/episodes è
   legittimo: sono due endpoint diversi.

3. **1410 episodi = 71 richieste.** One Piece (id Kitsu **12**) ha
   `meta.count: 1410`, e con pagine da 20 sono `ceil(1410/20) = 71` pagine più
   la richiesta del record: **72 richieste**. A latenza reale di 300–2100 ms per
   pagina, in sequenza sarebbero ~78 s contro i 30 s della rotta.

   Quindi la paginazione è un **pool a concorrenza limitata**
   (`PAGE_CONCURRENCY = 6`), non un ciclo e non `Promise.all`: 71 richieste
   simultanee contro un'API sola non sono più veloci, sono un 429. Con `cursor`
   letto e avanzato senza `await` in mezzo, due worker non possono mai prendere
   lo stesso offset; e con `meta.count` noto la lista degli offset è esatta, il
   pool non può sbordare oltre la fine.

   **Misurato dal vivo** su questa macchina: `meta(12)` → **1410 episodi in
   7,7 s / 8,4 s / 11,1 s / 18,2 s** con 72 richieste, e la numerazione esce
   monotona 1..1410. Il budget (`META_BUDGET_MS = 28 s`, appena sotto i 30 s della
   rotta) è il margine: se non basta, si **fallisce esplicitamente** con
   `KitsuError` e `reason: 'budget'`. Una lista di 1410 episodi troncata in
   silenzio a 20 è un dato falso che sembra giusto.

4. **`/anime/{id}` è una risorsa singola**: `data` è l'oggetto, non un array. Va
   letto in entrambe le forme, o `meta()` dichiara "id inesistente" su un id
   sano. (L'ho scoperto sul live: il mio mock restituiva un array.)

5. **Il tipo JSON:API di un genere è `genres`, al plurale**, sia in `included` sia
   in `relationships.genres.data`. Filtrare su `genre` non matcha niente e il
   fallimento è silenzioso: HTTP 200 con `genres: []` su ogni meta. (Anche questo
   emerso dal live, non dai mock.)

**Kitsu non espone titoli italiani**: `attributes.titles.it` è `null` su One
Piece. Qui non viene inventata nessuna traduzione — l'ordine è `titles.en`, poi
`canonicalTitle`, poi `slug`. I titoli italiani che l'utente vede vengono dai
siti di streaming, non dai metadati.

**`episodeCount` è `null` per una serie in corso** (One Piece). Viene passato
avanti tale e quale e **non viene mai usato** come autorità sul numero di
episodi: l'unica fonte per quello è `/episodes` paginato, dove `meta.count` dice
**1410**.

Anche la numerazione è assoluta per scelta: `episodes[].number` preferisce
`absoluteNumber` e cade su `number`. Stremio chiede in termini assoluti (misurato:
episodio 954 di One Piece), e con `number` solo si sbaglierebbe la serie.

---

## API

### `GET /api`, `GET /api/sources`, `GET /api/streams`

Il protocollo Stremio ha tre risorse (`catalog`, `meta`, `stream`) e una forma di
risposta pensata per un client che sa parlare di `meta.videos[]`. **Queste tre
rotte sono un'altra cosa**: JSON semplice, per un client che non implementa il
protocollo — Kodi, uno script MPV, un'estensione del browser, un `curl`. E'
l'unico posto dove la **distinzione dub/sub è leggibile da una macchina** senza
passare dalla proiezione Stremio.

Non e' un tentativo di reimplementare Stremio, e non e' una seconda fonte di
verita': legge lo **stesso** resolver, quindi una correzione ai scraper arriva
sulle due superfici insieme. Non compare nel manifesto di proposito — un client
Stremio che la vedesse in `/manifest.json` la tratterebbe come una risorsa da
guidare, e non lo e'.

| Rotta | A cosa serve |
|---|---|
| `GET /api` | descrive la superficie: endpoint, varianti, fonti, rotte Stremio |
| `GET /api/sources` | **la stessa risposta descrittiva** di `/api`, verificato con `diff` |
| `GET /api/streams` | la risposta vera: gli stream, con la variante |

```bash
curl -s http://127.0.0.1:7000/api | python3 -m json.tool
curl -s 'http://127.0.0.1:7000/api/streams?title=Naruto&episode=1' | python3 -m json.tool
```

#### I parametri di `/api/streams`

| Parametro | Obbligatorio | Default | Cosa fa |
|---|---|---|---|
| `title` | **si** | — | il titolo da risolvere |
| `episode` | no | `1` | deve essere un intero `>= 1` |
| `variant` | no | `all` | `dub`, `sub` o `all` |
| `source` | no | tutte e tre | una sola fonte: `animeworld`, `animesaturn`, `animeunity` |

Quattro parametri, non cinque: **`limit` non esiste su `/api/streams`**.
`grep -n "limit" src/routes/api.js` non restituisce niente. Il `limit` di questo
progetto sta su `/catalog` ed è un'altra cosa, con un altro tetto.

#### La risposta, come arriva davvero

Eseguita sul server in ascolto il 2026-10-05, `?title=Naruto&episode=1`, e
**soltanto le righe `url` sono troncate** per leggibilita' (nella risposta reale
sono URL interi con token effimeri):

```json
{
  "title": "Naruto",
  "episode": 1,
  "variant": "all",
  "count": 6,
  "totalCount": 6,
  "availableVariants": ["dub", "sub"],
  "variantsKnown": true,
  "variantsKnownBy": {
    "animeworld": true,
    "animesaturn": true,
    "animeunity": true
  },
  "streams": [
    { "source": "animeworld", "label": "AnimeWorld",
      "title": "Naruto SUB ITA - Ep 1",
      "url": "https://srv23-masafi.sweetpixel.org/DDL/ANIME/Naruto/Naruto_Ep_001_SUB_ITA.mp4…",
      "variant": "sub", "variantLabel": "ITA SUB", "height": 0 },
    { "source": "animeunity", "label": "AnimeUnity",
      "title": "Naruto (ITA) - Ep 1",
      "url": "https://au-d1-02.vix-content.net/download/1/d/c0/…/1080p.mp4?token=…&expires=…",
      "variant": "dub", "variantLabel": "ITA DUB", "height": 1080 }
  ],
  "errors": []
}
```

Sei righe, mostrate due: la `sub` di AnimeWorld e la `dub` di AnimeUnity. Le chiavi
sono costruite in `src/routes/api.js:194-210`, e ciascuna ha un motivo:

- **`variant`** è il valore **richiesto**, non quello trovato: dice come hai
  filtrato, e da solo non dice nulla di cio' che ha risposto.
- **`count` e `totalCount` insieme** sono la coppia che rende il filtro leggibile:
  `count` sono le righe **dopo** il filtro, `totalCount` **prima`. Con
  `?variant=dub` la risposta porta `"count": 3, "totalCount": 6`, e quei 3 sono
  gli unici doppiati che le fonti dichiarano. Se i due numeri fossero uno solo, non
  si saprebbe se il filtro abbia escluso qualcosa o se il titolo non avesse un dub.
- **`availableVariants`** e' l'insieme delle varianti **presenti in questa risposta**.
  Puo' essere `["dub","sub"]` anche con `variantsKnown: true`.
- **`variantsKnown` non e' derivato da `availableVariants`**, ed e' una correzione
  esplicita: rispondere "non lo so" a partire dal risultato obbligherebbe lo stesso
  `false` a significare due cose diverse — «questo scraper e' cieco» e «questo
  titolo non aveva un doppiaggio». La prima e' un'accusa che il resolver non puo
  risolvere, la seconda e' un fatto. `variantsKnownBy` dice quale fonte abbia
  risposto, cosi' la domanda resta separabile.
- **`variant` e' sempre presente su ogni stream, anche quando e' `unknown`**: e' il
  punto in cui una chiave che il resolver **omette** diventa un campo garantito
  per il client.
- **`variantLabel`** e' la stessa cosa per gli umani (`ITA DUB`, `ITA SUB`, `ITA`).
- **`height`** e' l'altezza che la riga **dichiara**, cercata in cascata da
  `streamQualityHeight` (`src/manifest.js`): prima i campi numerici espliciti
  (`height`, `quality`, `resolution`), poi un numero nudo dentro `quality`/
  `resolution`, poi — e solo per le forme **etichettate** (`1080p`, `1920x1080`) —
  `name`, `description` e `title`, e infine l'URL. Vale `0` quando nessuno di
  questi dichiara niente. Non e' una misurazione e non e' un filtro: nella
  risposta qui sopra le **due** righe di AnimeUnity portano `1080` perche' il loro
  path dice `1080p.mp4`, e le **quattro** righe di AnimeWorld e AnimeSaturn
  portano `0` perche' ne' i loro URL ne' i loro titoli dichiarano niente. Il
  numero nudo e' accettato **solo** dove un campo lo dichiara: cercarlo anche nei
  titoli produrrebbe falsi positivi (`Episodio 954`).
- **`errors`** raccoglie i messaggi delle fonti che hanno fallito **mentre altre
  rispondevano**. Se falliscono tutte, non e' un `200` con array vuoto: e' un 5xx.

#### Il filtro e' stretto, e per una ragione che conta

`variant` filtra **rigido**. `?variant=dub` restituisce **solo** righe che una
fonte ha dichiarato esplicitamente doppiate. Una riga che la fonte non ha
etichettato e' `unknown` e quindi **esclusa**, perche' includerla starebbe
affermando un fatto che nessuno ha dichiarato.

```bash
# 3 dub su 6 righe: le tre "unknown" non ci sono, e non per caso
curl -s 'http://127.0.0.1:7000/api/streams?title=Naruto&episode=1&variant=dub'
#   -> "count": 3, "totalCount": 6
```

#### I 400 sono 400, e l'array vuoto non è un errore

Un input sbagliato e' `400` e **dice quale parametro** e' sbagliato: e' un errore
del chiamante, e il chiamante lo puo' correggere. Un risultato vuoto e' `200` con
`streams: []`, che e' una risposta onesta e non un errore. Misurato:

| Richiesta | Risposta |
|---|---|
| `/api/streams` (senza `title`) | `400` `{"error":"manca il parametro obbligatorio \`title\`"}` |
| `?title=Naruto&episode=abc` | `400` `{"error":"\`episode\` deve essere un intero >= 1"}` |
| `?title=Naruto&variant=english` | `400` `{"error":"\`variant\` deve essere \`dub\`, \`sub\` o \`all\`"}` |
| `?title=Naruto&source=nope` | `400` `{"error":"fonte sconosciuta: nope"}` |
| `/api/nope` | `404` `{"error":"endpoint sconosciuto","endpoints":{…}}` |

`episode=abc` non diventa un episodio 1 silenzioso: un numero non parsabile e' un
input sbagliato, e fingere che sia 1 produrrebbe un risultato plausibile e falso.

#### Il caveat, che è il punto

`variant` qui e' una **classificazione lato addon**, derivata da marcatori raccolti
con lo scraping. Non e' una dichiarazione del sito e non e' una garanzia di questo
codice. Un campo comodo da leggere e' una cosa diversa da un campo vero: e' per
questo che `unknown` esiste, e' per questo che il filtro e' stretto, e non e' un
dettaglio di forma della risposta.

### `src/resolver.js`

```js
// riga INTERNA del resolver (quello che resolveSeries/resolveMovie restituiscono)
Stream = { name, title, url, source, variant? }

resolveSeries({ title, episode, sources? }) → Promise<Stream[]>
resolveMovie({ title, sources? })           → Promise<Stream[]>
```

`source` è `'animeworld' | 'animesaturn' | 'animeunity'`. `title` è il titolo
restituito dalla fonte **senza** il suo marcatore (`"One Piece ITA - Ep 5 [AW]"`
→ `"One Piece ITA - Ep 5"`): il pattern è letterale sui tre marcatori `[AW]`,
`[AS]`, `[AU]`, perché un `\[...\]` generico si mangerebbe anche un legittimo
`[ITA]` finale restituendo un titolo che non dice più che è sottotitolato.

#### `variant?`: presente, oppure **assente** — non `unknown`

`variant` è una chiave **enumerable** che il resolver imposta **solo quando la
fonte ha dichiarato una variante**, e la **omette del tutto** altrimenti
(`src/resolver.js:304`):

```js
const variant = detectVariant(row)
if (variant !== VARIANT_UNKNOWN) stream.variant = variant
```

La differenza tra *assente* e `unknown` è deliberata e non è una sfumatura di
stile: una riga con `variant: 'unknown'` porta un campo presente e privo di
significato su tutte e tre le fonti, cioè un campo su cui nessuno può fare
affidamento; omettendolo la shape resta quella dichiarata finché una fonte non
dichiara davvero qualcosa. Il punto in cui un client ha **sempre** un campo è
un altro, ed è unico: `src/routes/api.js`.

#### Due livelli distinti, e non confonderli

La riga interna **non** è quello che un client Stremio vede. La proiezione sul
protocollo è `normalizeStreams` in `src/manifest.js:501`, e produce un'altra
forma:

```js
// proiezione PROTOCOLLO (quello che Stremio legge)
{ name, description, url, source }
  + behaviorHints: { bingeGroup }   // solo se la variante è dub o sub
```

Esplicitamente, perche' la confusione dei due livelli e' facile:

- **La riga Stremio non ha un campo `variant`.** La variante viene calcolata in
  locale dentro la proiezione e usata per costruire la `description` e il
  `bingeGroup`, poi **non viene emessa**. Un client che vuole la variante fa
  `/api/streams`.
- **La proiezione ha perso `title`**, che è un alias **deprecato**: il tipo
  `Stream` di Stremio porta `name` + `description`, e i client non trattano `title`
  come campo a sé. Emetterlo era un doppione — il dato esisteva, nessun client lo
  mostrava.
- **Il `bingeGroup` è l'unico canale leggibile da una macchina** che distingue
  dub da sub senza fare parsing del testo, ed è deterministico, quindi stabile fra
  richieste. La chiave è **omessa** quando la variante è `unknown`: un gruppo
  `unknown` inventato raggrupperebbe fra loro righe che non hanno niente in
  comune, che è peggio che non raggrupparle.
- **Il gruppo è deliberatamente costante per tutta la serie**:
  `<fonte>-ita-<variante>` (`src/manifest.js:574`), con dentro il
  **discriminante** — fonte e variante — e non l'episodio. Episodio 1 ed episodio
  900 di One Piece danno quindi entrambi `animeunity-ita-dub`: è il comportamento
  giusto, non una collisione da correggere. L'id del video **non** entra, e la
  ragione è il motore, non una preferenza di leggibilità: `is_binge_match()` in
  `stremio-core/src/types/resource/stream.rs` confronta i due
  `behavior_hints.binge_group` con una **semplice uguaglianza di stringa**
  (`a == b`), e quel confronto gira in `stremio-core/src/models/player.rs`,
  `next_stream_update`, fra lo stream selezionato dell'episodio **corrente** e la
  lista di stream dell'episodio **successivo**: due episodi diversi, per
  definizione. Un valore per-episodio rende `a == b` irraggiungibile e il binge si
  spegne **in silenzio** — `is_binge_match` restituisce `false`, nessun errore,
  nessun sintomo, solo l'autoplay che smette di proseguire. Il test ufficiale
  `stremio-core/src/unit_tests/player/next_stream.rs` serve due id diversi
  (`tt123456:1:2` e `tt123456:1:3`) con gli stessi valori letterali e asserisce
  che il match riesca: il caso "id dentro il gruppo" non è un'ipotesi pessimistica,
  è il comportamento che il motore documenta come funzionante **senza** id.
  L'esempio canonico della documentazione ufficiale è `"gobsAddon-720p"`
  (`Stremio/stremio-addon-sdk`, `docs/api/responses/stream.md`) e dice la stessa
  cosa: nel valore ci sta il discriminante — addon, variante, qualità — l'id
  dell'episodio no.
- **Perché l'id è escluso, e non soltanto inutilizzato.** Il ragionamento
  inverso — «senza id tutte le righe di una serie condividerebbero lo stesso
  gruppo, quindi un client che raggruppa potrebbe trattare episodio 1 ed episodio
  900 come intercambiabili» — è la forma esatta che questa sezione ebbe una volta,
  e va dunque smontata per iscritto: l'id dentro il gruppo non distingue
  l'episodio *all'interno* di un gruppo, **rende irraggiungibile il confronto**,
  perché il confronto che il motore deve fare non avviene mai fra due righe dello
  stesso episodio. E l'episodio non è un dato che il gruppo debba portare: è già
  l'id del video che il client sta guardando, quindi scriverlo anche nel gruppo
  sarebbe un doppione. Anche il nome della fonte viene ridotto a slug
  (`src/manifest.js:568-574`) per la stessa ragione di contratto: il valore finisce
  in un campo che i client usano come chiave di raggruppamento, e `Anime Unity`
  non è una chiave. Il test che fissa la scelta è `due episodi diversi danno lo
  stesso bingeGroup` (`test/routes.test.mjs:353`); la prova con i riferimenti ai
  file del motore è nel docstring di `bingeGroupOf` (`src/manifest.js:541-566`).
- **`group` è il nome DEPRECATO di questo campo, e il motore non lo legge più.**
  L'unico nome da emettere è `behaviorHints.bingeGroup`: rimettere `group` non
  produce niente, e nessun client lo cerca.
- **`description` non è mai vuota**, in nessun ramo (`describeStream` in
  `src/manifest.js:522`). Con variante dichiarata è `ITA DUB — <titolo>` o
  `ITA SUB — <titolo>`, dove `<titolo>` è il titolo che la fonte aveva portato e,
  in mancanza, il `name`.
  Prima il titolo veniva scartato e la riga restava solo `ITA DUB`: il client
  perdeva un dato che aveva già in mano. **Senza** variante dichiarata il
  comportamento è **invariato** — titolo portato, poi `name` — e il ramo di
  fallback esiste perché una riga senza etichetta è indistinguibile da una riga
  troncata.

Tre regole che la firma da sola non dice:

- **`Promise.allSettled`, mai in sequenza.** I tre siti sono indipendenti e nessuno
  risponde per gli altri. In sequenza un sito lento sommerebbe la sua latenza a
  quella degli altri due, e un sito morto deciderebbe se gli altri vengono
  proprio interrogati. C'è un test con una barriera che farebbe deadlock su un
  runner sequenziale.
- **`[]` a meno che non abbiano fallito TUTTE.** "Nessun sito ha questo titolo" e
  "tutti e tre sono rotti" sono risposte diverse e una sola è un errore.
  Un'uscita di due fonti non deve diventare una pagina "non trovato". L'errore
  aggregato porta comunque i messaggi di tutte, così un sito morto resta
  nominabile nel log.
- **Tetto di ~25 s per fonte**, così un CDN fermo è una fonte in timeout e non
  una richiesta che sopravvive al client Stremio.

`hash` non viene mai copiato nello `Stream`: `link` sì, e nient'altro, anche se
la fonte consegna un hash. Le diagnostiche sono sulla proprietà **non
enumerable** `streams.errors` — leggibile, ma invisibile a `deepStrictEqual` e a
`JSON.stringify`, così l'array restituito è esattamente lo shape dichiarato.

`sources` accetta tre forme, che è anche il seam usato dai test per non fare
rete: omesso (tutti e tre i default), un array di id (`['animesaturn']`), o un
array di `{ id, label, instance }` per iniettare un'istanza.

### `src/kitsu.js`

```js
search(query, { limit = 20 })  // → [{ kitsuId, slug, type, title, year, poster, episodeCount }]
meta(kitsuId)                  // → { id, type, name, poster, background, description, year, genres, episodes }

KitsuMaxPageSize = 20          // tetto misurato di page[limit], su /anime E su /episodes
EPISODE_PAGE_SIZE = 20         // = KitsuMaxPageSize, per costruzione
PAGE_CONCURRENCY = 6           // pool di pagine /episodes in volo
META_BUDGET_MS = 28_000        // budget di una meta(), sotto i 30 s della rotta
REQUEST_TIMEOUT_MS = 20_000    // per singola richiesta
```

Timeout per richiesta via `AbortController`. Ogni uscita è una `KitsuError` con
`.status` (HTTP, o `null` per timeout/trasporto) e `.reason` — `'http'`,
`'network'`, `'timeout'`, `'invalid_json'`, `'empty'`, `'budget'` — così un caller
distingue una sorgente che ha sbagliato da una lista troncata senza dover
riconoscere il testo del messaggio. **I body di risposta non finiscono mai** nel
messaggio, nell'errore serializzato o nel log: un body di errore Kitsu può portare
dettaglio di richiesta che in un log di server non ci vuole.

### Test di reale

`test/kitsu.test.mjs` finisce con due test che colpiscono **Kitsu vero senza
mock**, skipppati di default perché la CI resta offline:

```bash
SAR_LIVE=1 node --test test/kitsu.test.mjs
```

Uno verifica che `search('One Piece', { limit: 50 })` risponda 20 risultati
(clampati) e che nessuna richiesta superi `page[limit]=20`; l'altro che
`meta(12)` torni con tutti i 1410 episodi, monotoni 1..1410, entro il budget, con
generi e immagini HTTPS reali.

### Perché i mock erano insufficienti, e cosa è costato

Tre difetti di `meta()` sono sopravvissuti a 30+ test su mock e sono usciti solo
col Kitsu vero: la risorsa singola letta come collezione, il tipo `genre` invece di
`genres`, e un abort a metà corpo riportato come "corpo non JSON" invece che come
timeout. Un mock che risponde a qualunque `page[limit]` non può vedere un tetto;
uno che sbaglia la forma di `data` non può vedere uno shape sbagliato. Per questo
le fixture di test copiano le forme reali e c'è un test di reale dietro una env
var.

## Assunzioni fatte, e come disfarle

1. **`meta().id` è l'id Kitsu nudo**, senza prefisso tipo `kitsu:`. Motivo:
   `meta()` riceve quell'id come input, quindi `meta(meta(x).id)` resta valido
   senza che il chiamante conosca una convenzione sui prefissi. Se le route
   preferiscono un id con prefisso, il cambio è una riga in `src/kitsu.js`
   (`id: String(record.id ?? id)`) più lo strip in routes.
2. **`meta().description` ripiega sul titolo** quando `synopsis` manca, così
   Stremio non riceve `null` in un campo che si aspetta testo.
3. **`title` vuoto → `[]`, non throw.** L'unica condizione di throw dichiarata è
   "tutte le fonti hanno fallito"; un titolo vuoto non è un guasto di una fonte,
   quindi tenerla distinta rende il contratto esatto: `[]` è una risposta, un
   throw è un errore.
4. **`timeoutMs` è sovrascrivibile** in `resolveSeries`/`resolveMovie`/`search`/
   `meta`, con default 25 s e 20 s. Serve a testare il timeout senza aspettare
   25 s; il default è il valore dichiarato. Anche `budgetMs` e `maxEpisodes` su
   `meta` sono sovrascrivibili per lo stesso motivo.
5. **`META_BUDGET_MS = 28 s` è vicino di proposito ai 30 s della rotta**
   (`DEFAULT_TIMEOUT_MS` in `src/manifest.js`, file dell'altra lane). Il budget
   serve a far diagnosticare **questo modulo** prima che scatti il timeout
   generico della rotta, quindi deve spendere tutta la finestra che la rotta è
   disposta a concedere. Conseguenza dichiarata: con la macchina sotto carico
   (misurato loadavg fino a 61 su 16 CPU, per via degli LSP e delle altre lane) un
   `meta()` di One Piece **può superare il budget e fallire esplicitamente** invece
   di rispondere. È il comportamento voluto — ma se in produzione il carico è
   stabilmente sopra quota, la leva è la concorrenza (`PAGE_CONCURRENCY`), non
   l'allungamento del budget, che non può superare i 30 s della rotta.
6. **`package.json` punta `main`/`exports` a `src/manifest.js` e `start` a
   `src/server.js`**, file dell'altra lane: sono riferimenti, non scritture, ma il
   progetto non parte finché quelli non esistono.
