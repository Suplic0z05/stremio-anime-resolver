## Cosa cambia

Una frase. Se il titolo dice gia' questo, scrivi "nessun contesto" e lascia stare.

## Perche'

Il problema o la richiesta che risolve.

## Checklist

- [ ] `npm run check` passa
- [ ] `npm test` passa
- [ ] Ho aggiunto o aggiornato un test che copre la modifica (un cambiamento di
      comportamento senza test non e' verificabile, quindi in review non si puo'
      distinguere da un refactor)
- [ ] Le tre fonti sono ancora coperte, o ho detto esplicitamente quale non e'
      piu' compatibile e perche'
- [ ] Se ho toccato uno scraper, la copia upstream corrispondente sotto
      `/home/suplic0z/Projects/shiru-italian-streaming/` porta la stessa
      modifica sotto il banner
- [ ] Ho aggiornato il README se il comportamento cambia
- [ ] Nessun file generato, log, o segreto nel diff

## Su cosa ho misurato la variante

Le tre fonti non hanno la stessa affidabilita' nella lettura del linguaggio, e
le regole sono diverse:

- **AnimeSaturn**: due query distinte (`?dub=1` e `?dub=0`), 30/30 misurato per
  entrambe. Il marker e' in `/filter`, e la pagina dettaglio mostra i badge
  delle card *correlate*, che non sono auto-scoped: usarli per decidere la
  variante del titolo aperto e' sbagliato.
- **AnimeWorld**: discriminazione fra entry di lista e tooltip, perche' un
  titolo puo' portare `(ITA)` come sottotitolo di una voce che appartiene a una
  serie diversa, e il titolo da solo non distingue i due casi.
- **AnimeUnity**: marker esplicito; gia' stato corretto il caso del doppio
  suffisso che produceva una stringa composta.

Se aggiungi una fonte, il marker va letto dove esiste **a catalogo**. Un
`unknown` sincero e' un risultato corretto: e' quello che impedisce a un client
di mostrare sub italiano a chi voleva il dub.

## Non metto qui

- Log di scraping di terzi: sono rumore e cambiano ogni giorno.
- Numeri di benchmark senza il comando e la data che li ha prodotti.