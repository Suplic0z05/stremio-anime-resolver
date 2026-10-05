# stremio-anime-resolver -- immagine di produzione.
#
# Fatto da cui parte tutto: `package.json` dichiara
#   "engines": { "node": ">=20" }
# e "dependencies": {}. Quindi questo file NON esegue `npm ci` e NON esegue
# `npm install`: non c'e' un `package-lock.json` in questo repository, e
# `npm ci` fallisce per assenza del lockfile invece di installare zero pacchetti.
# Copiare i sorgenti ed eseguire Node direttamente e' il percorso che regge.
#
# Il tag `node:20-bookworm-slim` e' la minor corrispondente al pavimento
# `>=20`. Lo stesso pavimento compare in `deploy/stremio-anime-resolver.service`
# (`Environment=` non lo ripete perche' e' implicito, ma vedi il commento li').

FROM node:20-bookworm-slim

# HOST=0.0.0.0 e' obbligatorio qui e non un extra: `src/server.js` dichiara
# `DEFAULT_HOST = '127.0.0.1'` e legge l'ambiente con `process.env.HOST || DEFAULT_HOST`.
# Un server agganciato al loopback dentro il container e' irraggiungibile dal
# bridge docker, quindi senza questa riga l'immagine si avvia e non risponde a
# nessuno. E' esattamente il comportamento che l'unita systemd NON vuole: li'
# HOST resta 127.0.0.1 e il proxy fa da unico punto d'ingresso.
ENV NODE_ENV=production \
    PORT=7000 \
    HOST=0.0.0.0

WORKDIR /app

# `package.json` viene per primo e da solo, per due motivi reali:
# 1. contiene `"type": "module"`. Senza questo file, Node tratterebbe i `.js`
#    come CommonJS e il primo `import` di `src/server.js` fallirebbe;
# 2. isolarlo tiene la cache dei layer valida anche quando cambia solo `src/`.
COPY package.json ./

# Solo i sorgenti. `test/`, `deploy/` e `README.md` non servono a far girare il
# server: escluderli dal COPY e' cio' che li tiene fuori dall'immagine, insieme
# al `.dockerignore` che riduce il contesto di build.
COPY src ./src

# GPL-3.0-or-later: il codice include file derivati GPL v3 (vedi README), quindi
# la licenza viaggia con l'immagine.
COPY LICENSE ./

# L'utente `node` (uid 1000) esiste gia' nell'immagine ufficiale. Non serve
# creare utenti e non si esegue nessun package manager: il processo legge i
# propri sorgenti e basta, non scrive nulla (vedi `.dockerignore` e la nota su
# ReadWritePaths nell'unita systemd).
USER node

# La porta e' quella di `DEFAULT_PORT` in `src/server.js`, che e' anche il fallback
# silenzioso quando `PORT` non e' parsabile.
EXPOSE 7000

# Probe con Node stesso: `node:20-bookworm-slim` NON porta curl ne' wget, e
# aggiungerli violerebbe il vincolo "zero installazioni di pacchetti". Il
# `fetch` globale esiste su Node >= 18, quindi il piano B sarebbe
# `http.get`. La rotta `/health` in `src/server.js` risponde `{"ok":true}`
# senza toccare Kitsu, quindi il probe non ha effetti collaterali di rete.
# 127.0.0.1 va bene anche con HOST=0.0.0.0: un ascolto su tutte le interfacce
# include il loopback.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 7000) + '/health').then(function (r) { process.exit(r.ok ? 0 : 1) }).catch(function () { process.exit(1) })"

# `npm start` e' `node src/server.js` (chiave `scripts.start` di `package.json`).
# Qui si esegue il comando sottostante direttamente: e' lo stesso, senza mettere
# npm nel percorso di esecuzione e senza dipendere da uno script. Nessun
# `--init` serve: il processo registra SIGTERM esplicitamente in
# `src/server.js`, quindi `docker stop` chiude pulito anche con Node come PID 1.
CMD ["node", "src/server.js"]
