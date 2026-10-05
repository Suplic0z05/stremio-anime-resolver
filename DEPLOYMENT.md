# DEPLOYMENT

Come eseguire `stremio-anime-resolver` fuori dal portatile: in locale, in
container, come servizio systemd, e pubblico dietro un reverse proxy.

I file in questo documento sono **artefatti prodotti, non un servizio attivo**.
Nessun comando delle sezioni 2-5 e' stato eseguito: nessuna porta e' rimasta
aperta, nessun servizio systemd avviato, nessun pacchetto installato, nessuna
configurazione di sistema toccata. Sono stati eseguiti solo i controlli che non
tocano il sistema — `npm run check`, `npm test`, il server in primo piano per la
tabella di `PORT`, e qualche `curl` in chiaro — elencati alla fine; l'ultima
sezione elenca esattamente cosa NON e' stato verificato.

---

## 1. I fatti che questo documento usa

Tutti letti dai sorgenti, non ricordati. Se un giorno un valore qui cambia,
cambia il file che lo dichiara e basta.

| Cosa | Valore | Dove e' dichiarato |
|---|---|---|
| Comando di avvio | `node src/server.js` | `package.json` (`scripts.start`) (`"start"`) |
| Porta | `7000` | `src/server.js` (`DEFAULT_PORT`) |
| Variabile porta | `PORT` | `src/server.js` (`process.env.PORT`) |
| Host di default | `127.0.0.1` | `src/server.js` (`DEFAULT_HOST`) |
| Variabile host | `HOST` | `src/server.js` (`process.env.HOST`) |
| Pavimento Node | `>=20` | `package.json` (`engines.node`) (`engines.node`) |
| Dipendenze npm | nessuna | `package.json` (`dependencies`) (`"dependencies": {}`) |
| Probe di salute | `GET /health` -> `{"ok":true}` | `src/server.js` (rotta `/health`, `src/server.js:143-147`) |
| URL per Stremio | `GET /manifest.json` | `src/manifest.js` (`createManifestRoute`) |
| Budget per richiesta remota | `30000` ms | `src/manifest.js` (`DEFAULT_TIMEOUT_MS`) (`DEFAULT_TIMEOUT_MS`) |
| Stato persistente | nessuno | nessuna scrittura su filesystem in `src/` |
| Log | metodo, path, status, durata su **stderr** | `src/server.js` (`log('info', 'request', ...`) |

Le due letture che contano di piu', perche' sono le trappole:

- **`HOST` di default e' il loopback.** Il server oggi risponde solo a se
  stesso. Non e' un vincolo: e' una riga di default in `src/server.js` (`DEFAULT_HOST`), e
  `HOST=0.0.0.0` la sovrascrive.
- **`PORT` ha un fallback silenzioso.** `src/server.js` (`process.env.PORT`) e'
  `Number.parseInt(process.env.PORT ?? '', 10) || DEFAULT_PORT`. Un refuso non
  si annuncia: si manifesta come addon che "non risponde" sulla 7000. La tabella
  seguente e' la misura riportata dal README (misurata eseguendo il server, non
  dedotta dal codice):

  | `PORT` | porta effettiva | perche' |
  |---|---|---|
  | non impostata | **7000** | `parseInt(undefined)` -> `NaN` -> falsy |
  | `7311` | **7311** | il caso normale |
  | `abc` | **7000** | `NaN` -> falsy, **nessun avviso** |
  | `0` | **7000** | `0` e' falsy: `PORT=0` **non** chiede "una porta libera" |
  | `70000` | **non parte** | `RangeError` dal `validatePort` **di Node**, non da questo codice: muore al `listen` |

  > **Provenienza di `validatePort`.** La funzione esiste ed è **interna a
  > `node:net`**: si raggiunge solo da `Server.listen`, non da un controllo di porta
  > scritto qui. `grep -rn validatePort .` su questo albero restituisce **zero
  > occorrenze in `src/` e in `test/`**. Lo stack la nomina per intero —
  > `node:net:2613` → `at Server.listen (node:net:2613:5)` →
  > `at file:///…/src/server.js:207:10`, con `code: 'ERR_SOCKET_BAD_PORT'` —
  > misurato con `PORT=70000 node src/server.js`. L'unica riga del progetto che la
  > raggiunge è `src/server.js:207`, il `server.listen(port, host, …)`.

  Sotto 1024 il fallimento e' un altro: `PORT=80x` viene parsato come `80` e
  si ferma su `EACCES`. Se l'errore e' un permesso e non un numero, il numero
  e' il refuso.

---

## 2. In locale

Prima di tutto, la verifica che non richiede rete:

```bash
cd /home/suplic0z/Projects/stremio-anime-resolver

node --check src/server.js          # sintassi di un file solo
npm run check                       # node --check su TUTTI i .js/.mjs di src/ e test/
npm test                            # node --test test/
```

`npm run check` e' un `node --check` su **tutti** i file `.js` e `.mjs` sotto `src/`
e `test/`, non su una lista scritta a mano. Lo script, per intero:

```
for f in $(find src test \( -name '*.js' -o -name '*.mjs' \) | sort); do node --check "$f" || exit 1; done
```

Quindi aggiungere un file a `src/` o a `test/` lo copre automaticamente: non c'e'
niente da aggiornare qui quando se ne crea uno. Per vedere l'elenco che lo script
sta per controllare:

```bash
find src test \( -name '*.js' -o -name '*.mjs' \) | sort
```

`npm run check` e `npm test` **sono stati eseguiti** (2026-10-05, dopo che questo
documento era stato scritto). `npm run check` esce **0**. `npm test` aveva **1
fallimento** su `test/api-surface.test.mjs:326`, il test
`height letto da title/declared, e 0 quando non c'e' qualita'`: si aspetta `0`
dove il codice ora restituisce `720`, perche' la scala di marche di qualita' lette
dal testo dell'URL e' stata aggiunta in seguito. Se falliscono, il problema e' dei
sorgenti e non di nessuna delle righe sotto.

> **Il conteggio dei test non e' un numero da mettere qui.** La suite e' in
> movimento: fra due esecuzioni consecutive ne sono cambiati il totale e il test
> che fallisce, perche' piu' lane ci stanno lavorando sopra. Per il numero vero:
> `npm test`, e leggere la riga `ℹ fail`. Quello che si riporta e' il comando, non
> il totale.

Avvio normale:

```bash
cd /home/suplic0z/Projects/stremio-anime-resolver
npm start
# [server] listening on http://127.0.0.1:7000
```

Avvio con porta diversa, e le due rotte da controllare:

```bash
PORT=7311 node src/server.js

curl -s http://127.0.0.1:7311/health          # {"ok":true}
curl -s http://127.0.0.1:7311/manifest.json   # il manifest dell'addon
```

`/health` e' il probe economico: risponde `{"ok":true}` **senza toccare Kitsu**
(`src/server.js` (rotta `/health`, `src/server.js:143-147`)), quindi una porta sbagliata si vede subito invece di
dedurla dall'assenza di risultati, che e' il sintomo che fa perdere tempo.

`GET /health` risponde `200`, `HEAD /health` risponde `200`, e **`POST /health`
risponde `405`** con `{"error":"method not allowed"}`: il controllo del metodo e' in
`src/server.js:135-139` e gira **prima** di qualunque instradazione sul path, quindi un `405`
qui non significa che `/health` sia rotto — significa che hai usato `curl` senza
`-X GET`.

Non serve `npm install`: `package.json` (`dependencies`) dichiara zero dipendenze e il progetto
usa solo stdlib piu `fetch` globale.

---

## 3. Container

Il `Dockerfile` e' alla radice e usa `node:20-bookworm-slim`, la minor
ufficiale corrispondente al pavimento `>=20` di `package.json` (`engines.node`) -- lo stesso
pavimento dichiarato in `deploy/stremio-anime-resolver.service`.

```bash
cd /home/suplic0z/Projects/stremio-anime-resolver
docker build -t stremio-anime-resolver:0.1.0 .
```

Costruire, non e' stato eseguito. Tre cose da sapere prima di farlo:

- **Nessuna `npm install` dentro l'immagine.** Non c'e' `package-lock.json` in
  questo repository, quindi `npm ci` fallirebbe per assenza del lockfile invece
  di installare zero pacchetti. L'immagine copia `package.json`, `src/` e
  `LICENSE` e lancia Node direttamente.
- **`package.json` va copiato per forza**: contiene `"type": "module"`. Senza
  quello, Node tratterebbe i `.js` come CommonJS e il primo `import` di
  `src/server.js` fallirebbe.
- **`HOST=0.0.0.0` e' impostato nell'immagine.** Con il default
  `127.0.0.1` di `src/server.js` (`DEFAULT_HOST`) il processo si aggancerebbe al loopback
  **dentro** il container, irraggiungibile dal bridge: l'immagine si avvia e non
  risponde a nessuno.

Esecuzione, bind del lato host sul loopback per tenere la stessa postura della
sezione systemd:

```bash
docker run -d \
  --name stremio-anime-resolver \
  --restart unless-stopped \
  -p 127.0.0.1:7000:7000 \
  stremio-anime-resolver:0.1.0
```

Verifiche:

```bash
docker inspect --format '{{.State.Health.Status}}' stremio-anime-resolver
docker logs stremio-anime-resolver
curl -s http://127.0.0.1:7000/health
```

Il `HEALTHCHECK` e' scritto dentro l'immagine e usa `node -e` con `fetch`
globale: `node:20-bookworm-slim` non porta `curl` ne' `wget`, e aggiungerli
violerebbe il vincolo "zero installazioni di pacchetti". Punta a `/health`, che
non ha effetti collaterali di rete.

`--init` non serve: il processo registra `SIGTERM` esplicitamente
(handler `SIGTERM`), quindi `docker stop` chiude pulito anche con Node come
PID 1.

Rimozione:

```bash
docker rm -f stremio-anime-resolver
docker image rm stremio-anime-resolver:0.1.0
```

---

## 4. systemd

`deploy/stremio-anime-resolver.service` e' gia' scritto per questa macchina:
`WorkingDirectory` ed `ExecStart` sono assoluti, e `ExecStart` usa
`/usr/bin/node` (percorso verificato) invece di passare da `npm start`, che
equivale a `node src/server.js` (chiave `scripts.start` di `package.json`).

I comandi qui sotto li esegue **un umano**, non l'agente che ha prodotto i
file:

```bash
cd /home/suplic0z/Projects/stremio-anime-resolver

sudo install -m 0644 \
  deploy/stremio-anime-resolver.service \
  /etc/systemd/system/stremio-anime-resolver.service

sudo systemctl daemon-reload
sudo systemctl enable --now stremio-anime-resolver.service
```

Verifica:

```bash
systemctl status stremio-anime-resolver.service
journalctl -u stremio-anime-resolver.service -f
curl -s http://127.0.0.1:7000/health
```

`HOST=127.0.0.1` e' dichiarato esplicitamente nell'unita': il servizio ascolta
solo sul loopback e l'unico ingresso e' il reverse proxy in locale. Se in
futuro vuoi che un'altra macchina raggiunga direttamente la porta, cambia
`Environment=HOST=127.0.0.1` in `Environment=HOST=0.0.0.0` **e** metti un
controllo accessi davanti, altrimenti avrai un proxy scansato.

Annulla:

```bash
sudo systemctl disable --now stremio-anime-resolver.service
sudo rm /etc/systemd/system/stremio-anime-resolver.service
sudo systemctl daemon-reload
```

### Utente dedicato (miglioramento, non obbligatorio)

L'unita' cosi' com'e' gira come `suplic0z`, l'utente proprietario dell'albero.
Un account dedicato sarebbe piu' corretto, ma **su questo filesystem non puo'
funzionare senza spostare i sorgenti**, perche' `/home/suplic0z/Projects` e'
`0750`:

```bash
sudo useradd --system --no-create-home --shell /usr/bin/nologin stremio-anime-resolver

sudo install -d -o root -g root -m 0755 /opt/stremio-anime-resolver
sudo cp -a /home/suplic0z/Projects/stremio-anime-resolver/. /opt/stremio-anime-resolver/
sudo chown -R root:root /opt/stremio-anime-resolver
sudo chmod -R a+rX /opt/stremio-anime-resolver
```

Poi nell'unita': `User=stremio-anime-resolver`, `Group=stremio-anime-resolver`,
`WorkingDirectory=/opt/stremio-anime-resolver`,
`ExecStart=/usr/bin/node /opt/stremio-anime-resolver/src/server.js`, e
`ProtectHome=yes` al posto di `read-only` (fuori da `/home` il vincolo non
serve piu'). I sorgenti restano di `root` e il servizio li legge e basta.

---

## 5. Esposizione pubblica

### 5.1 Il punto che va detto per primo

**L'URL del manifest deve essere raggiungibile dal client Stremio, non da te.**
Il client e' un'altra macchina, o un altro processo, o un altro utente: se il
bind resta su `127.0.0.1`, quel client non lo raggiunge e l'addon semplicemente
"non compare" fra gli addon installati, senza errore apparente.

Quindi: l'URL che si incolla in Stremio e' quello che il *client* sa
risolvere, non quello che `curl` risolve sulla tua shell. Le tre implicazioni
concrete:

- `http://127.0.0.1:7000/manifest.json` funziona solo per un Stremio sulla
  stessa macchina. Su un'altra macchina no.
- `http://192.168.1.50:7000/manifest.json` funziona in LAN se il bind e' su
  `0.0.0.0` e il firewall lascia passare la porta.
- `https://streams.example.com/manifest.json` funziona ovunque, ed e' l'unica
  forma che regge su una rete pubblica.

Il manifest e' una costante statica (`MANIFEST` in `src/manifest.js` (`MANIFEST`), non
ha un campo `url` e i `resources` sono relativi), quindi proxyarlo sotto un
qualsiasi hostname non richiede riscritture di URL: Stremio risolve le rotte
`/catalog/...`, `/meta/...`, `/stream/...` sullo stesso host del manifest.

### 5.2 Caddy

`/etc/caddy/Caddyfile`:

```
streams.example.com {
	encode zstd gzip

	# Il probe resta aperto anche in presenza di allowlist: `/health` risponde
	# `{"ok":true}` senza toccare Kitsu (rotta `/health` in src/server.js), quindi non e'
	# un proxy verso l'esterno e non costa niente esporlo.
	@health path /health
	handle @health {
		header Content-Type application/json
		respond `{"ok":true}` 200
	}

	handle {
		# NON usare basic_auth qui. Vedi la sezione Sicurezza: Stremio non
		# invia header Authorization quando recupera il manifest, quindi il
		# client riceverebbe 401 e l'addon non comparirebbe.
		#
		# Scegliere UNA delle due forme qui sotto.
		#
		# (a) allowlist di rete: la piu' semplice, e non ha il difetto del
		#     basic auth perche' il client Stremio arriva gia' da un IP noto.
		# @allowlist remote_ip 192.168.1.0/24 100.64.0.0/10
		# handle @allowlist {
		# 	reverse_proxy 127.0.0.1:7000
		# }
		#
		# (b) nessun filtro: solo se il proxy e' raggiungibile da una VPN o da
		#     WireGuard, e la VPN fa da access control. Caddy ottiene
		#     automaticamente il certificato Let's Encrypt per il dominio.
		reverse_proxy 127.0.0.1:7000
	}
}
```

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

### 5.3 nginx

`/etc/nginx/conf.d/stremio-anime-resolver.conf`:

```
upstream stremio_anime_resolver {
    server 127.0.0.1:7000;
    keepalive 8;
}

server {
    listen 80;
    server_name streams.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name streams.example.com;

    # nginx >= 1.25.1. Sotto quella versione togli questa riga e metti
    # `listen 443 ssl http2;` al posto di `listen 443 ssl;`.
    http2 on;

    ssl_certificate     /etc/letsencrypt/live/streams.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/streams.example.com/privkey.pem;

    access_log /var/log/nginx/stremio-anime-resolver.access.log;
    error_log  /var/log/nginx/stremio-anime-resolver.error.log;

    # Probe, senza log e senza allowlist: `/health` non tocca Kitsu.
    location = /health {
        access_log off;
        proxy_pass http://stremio_anime_resolver/health;
        proxy_set_header Host $host;
    }

    location / {
        # Allowlist di rete. `basic_auth` NON e' un'opzione praticabile:
        # vedi la sezione Sicurezza. Decommenta e adatta a chi deve leggere.
        allow 192.168.1.0/24;
        allow 100.64.0.0/10;   # intervallo Tailscale
        deny all;

        proxy_pass http://stremio_anime_resolver;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection        "";

        # `/stream` e `/meta` aspettano Kitsu e i tre scraper con un budget
        # di 30000 ms (DEFAULT_TIMEOUT_MS in src/manifest.js). Il default nginx e' 60s, quindi
        # regge gia'; qui e' esplicito perche' alzare il timeout dell'addon
        # oltre 75s richiederebbe di alzare anche questo.
        proxy_read_timeout 75s;
        proxy_send_timeout 75s;

        # Gli stream sono URL diretti gia' risolti: il proxy non deve
        # accodare nulla, passa solo JSON piccoli.
        proxy_buffering off;
    }
}
```

```bash
sudo nginx -t
sudo systemctl reload nginx
```

---

## 6. Sicurezza

Sezione corta e brutale, perche' qui i fatti sono scomodi.

**Cosa fa davvero questo addon.** Non ospita contenuti: recupera da Kitsu i
metadati di una serie e da tre siti anime (`animeworld`, `animesaturn`,
`animeunity`, i file in `src/sources/`) degli URL di stream, e li restituisce
come JSON. Il lettore non scarica nulla da qui: scarica direttamente da
quella terza parte.

**I URL che restituisce non sono tuoi e non sono tuoi a renderli affidabili.**
Sono raccolti da tre siti che non hanno nessun rapporto con questa
installazione. Sono:

- **non autenticati**: chiunque li abbia trovati puo' usarli, e non c'e'
  nessun modo per dimostrare a Stremio che sono legittimi;
- **effimeri**: il token che porta il link scade, e la scadenza e' di poche ore
  (`README.md`, la sezione sulla scadenza del token, `expires` pari a *now + 12h*). Il progetto per questo non
  implementa cache degli URL risolti a nessun livello (`README.md`, la sezione sull'assenza di cache):
  un URL in cache non e' un URL lento, e' un URL rotto. Quindi quando un link
  smette di funzionare, non e' un bug di questa installazione: e' la scadenza;
- **fuori dal tuo controllo**: il loro contenuto, la loro disponibilita' e la
  loro disponibilita' giuridica non dipendono da te. Nessun errore di questo
  repository puo' renderli sicuri.

**Questo addon non ha autenticazione propria.** Nessuna chiave, nessun token,
nessun header, nessun login: chi arriva alla porta ottiene esattamente il
servizio pubblico. Non e' un difetto di questa implementazione, e' il modo in
cui funziona il protocollo addon di Stremio -- il client non sa fare
autenticazione, e il manifest non ha un campo per dichiararla.

**Conseguenza: non esporlo su internet pubblico senza un reverse proxy che
fornisca TLS e controllo accessi.** Un bind su `0.0.0.0` con la porta
7000 aperta pubblicamente significa che chiunque puo' usare il tuo server per
risolvere stream, e che il traffico passa in chiaro.

**Il basic auth non risolve, e va detto esplicitamente perche' sembra la
risposta ovvia.** Stremio recupera `/manifest.json` senza header
`Authorization`, e il manifest non ha un campo per dichiararne uno: dietro un
`auth_basic` il client riceve 401 e l'addon semplicemente non compare, senza
messaggio d'errore utile. Le forme che funzionano sono altre:

1. **TLS + allowlist IP** (esempi sopra). Il client arriva da un IP noto, o da
   una VPN: in quel caso l'IP gia' e' l'identita'.
2. **VPN / WireGuard / Tailscale e basta**: il servizio resta su
   `127.0.0.1` e i client raggiungibili sono solo quelli sulla VPN. E' la
   configurazione con il minor numero di superfici, e su questa macchina
   Tailscale e' gia' presente.
3. **Un percorso casuale e lungo** (`https://esempio/4f9c1e.../manifest.json`)
   non e' una misura di sicurezza. Allunga la stringa da indovinare, non
   aggiunge controllo accessi, e finisce nei log di accesso.

**Il resto che conta:**

- Il servizio non scrive nulla su disco e non ha database: non c'e' roba da
  proteggere ne' backup da fare. L'unita' systemd lo dichiara esplicitamente
  con `ProtectSystem=strict` e **senza** `ReadWritePaths`, che qui sarebbe
  una riga falsa.
- Gira senza privilegi (`CapabilityBoundingSet=` vuoto): la porta 7000 e' sopra
  1024, quindi non serve `CAP_NET_BIND_SERVICE`.
- Non si installa niente e non ha dipendenze npm: la superficie dei pacchetti
  da aggiornare e' **una sola immagine** e nient'altro.
- Un proxy ben scritto **non deve** inoltrare richieste verso URL arbitrari
  passati dal client: questo addon non accetta un URL da inoltrare (chiama
  Kitsu e i tre scrapi su endpoint fissi), quindi non e' un open proxy, ma
  vale la pena saperlo se domani lo copri con qualcos'altro.

---

## 7. Cosa NON e' stato verificato

Questo documento descrive **artefatti prodotti, non un servizio funzionante**.
Nessuno dei comandi delle sezioni 2-5 e' stato eseguito. In particolare:

- **L'immagine non e' stata costruita.** `docker build` non e' mai stato
  lanciato su questo `Dockerfile`. La sintassi e' plausibile per ispezione
  (`FROM` / `ENV` / `WORKDIR` / tre `COPY` espliciti / `USER node` / `EXPOSE`
  / `HEALTHCHECK` in forma shell / `CMD` in forma exec), ma non e' una prova.
- **`systemd-analyze verify` non e' stato eseguito**, e nessun `systemctl`,
  `daemon-reload`, `enable` o `start`. L'unita' e' coerente per ispezione:
  sezioni `[Unit]`/`[Service]`/`[Install]` in ordine, `ExecStart` in forma
  exec con path assoluti, `Type=simple`, `WantedBy` presente. Non e' verificato
  che systemd 262 la accetti, ne' che le direttive di hardening siano tutte
  disponibili su questa build.
- **Nessun servizio di sistema e' stato avviato.** Il server *si e' avviato*,
  pero', in primo piano e per pochi secondi, per misurare le righe della tabella
  dei fallback di `PORT`: nessuna porta e' rimasta aperta e nessun servizio
  systemd e' stato toccato.
- **Nessun pacchetto installato.** Docker e `systemd-analyze` risultano
  presenti su questa macchina; **Caddy e nginx non sono installati**, quindi
  gli snippet delle sezioni 5.2 e 5.3 non sono stati `validate` ne' `nginx -t`:
  sono da leggere e da adattare ai tuoi domini e ai tuoi percorsi di
  certificato.
- **Le unit systemd (`systemd-analyze verify`) verificano la sintassi, non la
  sicurezza**: le direttive commentate (`MemoryDenyWriteExecute`,
  `SystemCallFilter`, `ProtectProc`, `ProcSubset`) sono commentate perche' si
  sa che rompono Node, non perche' siano state provate a romperlo qui.

### Cosa e' stato eseguito dopo, il 2026-10-05

La tabella dei fallback di `PORT` **e' stata rimisurata qui**, lanciando
`src/server.js` in primo piano con ogni valore e leggendo la riga `listening` che
il server scrive su stderr: `(unset)` → `7000`, `7311` → `7311`, `abc` → `7000`,
`0` → `7000`, `70000` → nessun ascolto e `RangeError`. Sono state eseguite anche
`npm run check` (esce `0`) e `npm test`, che aveva **un fallimento** su
`test/api-surface.test.mjs:326` (`height letto da title/declared, e 0 quando non
c'e' qualita'`): il test si aspetta `0` dove il codice ora restituisce `720`,
incoerenza nata quando la scala di marche di qualita' lette dal testo dell'URL e'
stata aggiunta. Il **conteggio** dei test non e' riportato di proposito, perche'
cambia fra due esecuzizioni consecutive finche' le lane ci lavorano; il comando e'
`npm test` e la riga da leggere e' `ℹ fail`. Sono state eseguite anche quattro
richieste in chiaro contro `/health` e `/api`. Restano non verificate tutte le
righe sopra.
