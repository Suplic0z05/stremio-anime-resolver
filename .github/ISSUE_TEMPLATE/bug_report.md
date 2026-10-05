---
name: Bug
about: Un resolver che non risolve, o che risolve la variante sbagliata
title: ''
labels: bug
assignees: ''

---

## Cosa ti chiedo di riportare, e perche' ognuno di questi campi

I campi sotto sono scelti perche' sono esattamente le cose che distinguono le
cause diverse. "Non funziona" non distingue uno scraper rotto da una variante
sbagliata da una porta sbagliata: e il primo errore che si paga e' diagnosticare
la porta sbagliata.

## Ambiente

- Versione del resolver: il tag o il commit, o la riga `version` di
  `package.json`.
- `node --version`:
- Dove gira: Stremio desktop / Android / TV / altro client / nessuno dei due
  (chiamo l'API a mano).

## Cosa ti aspettavi, e cosa e' successo

Cosa ti aspettavi:

Cosa e' successo:

## Fonte, episodio e variante

- Fonte: animeworld / animesaturn / animeunity
- Serie e stagione:
- Episodi: numeri assoluti (per Kitsu `/anime/<id>/episodes?page=N`, il numero
  assoluto non coincide quasi mai col numero visibile sull'episodio)
- Variante richiesta: dub / sub / unknown (non so)

## Le due prove che localizzano il guasto

Incolla l'output di queste due, e non serve descriverlo a parole:

```bash
curl -s http://<host>:<port>/health
curl -s "http://<host>:<port>/api/streams?title=<titolo>&episode=<N>&variant=<dub|sub>"
```

Se `/health` non risponde, il problema e' di ascolto/porta e nient' altro.
Se risponde ma `/api/streams` torna vuoto, il problema e' a valle.

## URL del manifest

Cosa hai aperto in Stremio (deve essere `/manifest.json`, non la radice):

## Log

Solo se hai errori in console. Il rumore `failed to initialize fff` che vedi
all'avvio e' innocuo: non riportarlo come bug.