/**
 * test-helpers/hold-loop.mjs
 *
 * L'equivalente di test dell'ascolto HTTP che, in produzione, tiene vivo il
 * ciclo degli eventi.
 *
 * ── PERCHE' STA FUORI DA `test/` ───────────────────────────────────────────────
 * `node --test` (senza selettore, quindi quello di `npm test`) considera un file
 * di test OGNI `.js`/`.mjs`/`.cjs` che sta dentro una directory `test/` o
 * `tests/`, anche in una sottodirectory. Un helper in `test/helpers/` viene quindi
 * eseguito come file di test e finisce nel censimento come un test che passa.
 * Misurato il 2026-10-05: un file in più dà `# tests 228 / # pass 225` invece di
 * `227 / 224`, su Node 20, 22, 24 e 26 insieme. La differenza è di UNO e UNO, non
 * un conteggio assoluto: i due numeri cambiano col crescere della suite, quindi
 * quello che va ricordato è il delta. Un numero di censimento sbagliato di uno è
 * peggio di un test perso, perché quando poi un test sparisce davvero nessuno se ne
 * accorge. Qui la discovery non lo vede (la directory non si chiama `test`/`tests` e
 * il nome del file non comincia con `test-` né finisce con `-test`), quindi il
 * censimento resta quello di prima.
 *
 * Non costa copertura di sintassi: `npm run check` fa `node --check` su
 * `find src test test-helpers`, e questa directory è nel `find`, quindi il modulo
 * viene syntax-checkato come tutto il resto.
 *
 * ── PERCHE' ESISTE ────────────────────────────────────────────────────────────
 * I due guard hanno oggi contratti OPPOSTI, ed e' la distinzione che questa pompa
 * rende misurabile:
 *
 *   `raceTimeout` (`src/resolver.js`) tiene il timer REFERENZIATO, e deve: il
 *   modulo ha bisogno di poter consegnare `ETIMEDOUT` anche quando non c'è un
 *   ascolto. Con `unref()` un processo senza socket morirebbe con codice 13 e
 *   stderr vuoto.
 *
 *   `withTimeout` (`src/manifest.js`) tiene il suo `unref()`, e deve: e' un
 *   guardiano che non deve impedire l'uscita quando qualcos'altro tiene gia' il
 *   loop (in produzione il socket, nel percorso kitsu il timer di abort).
 *
 * Nei test non c'è nessuna delle due cose, quindi serve l'equivalente esplicito
 * per i test che vogliono osservare una risposta, non un handle. E il caso e' opposto
 * rispetto al passato: con una pompa assente, un guard `unref()` e una promise
 * appesa (`withTimeout(new Promise(() => {}), 30_000)`) fanno DRAINARE il loop, la
 * promise non si assesta mai, la scadenza non arriva e `node:test` CANCELLA il resto
 * del file. Il sintomo è subdolo: `# fail 0` con decine di `# cancelled`, cioè una
 * suite "verde" che non ha verificato niente.
 *
 * ── PERCHE' POMPA CON `setImmediate` E NON CON `setTimeout` ────────────────────
 * `getActiveResourcesInfo()` elenca i timer che tengono vivo il ciclo come
 * 'Timeout' e gli immediati come 'Immediate'. I test di `test/routes.test.mjs`
 * contano i 'Timeout' per dimostrare che il guard NON tiene aperto il loop: un
 * `setTimeout` pending dentro una finta perderebbe il conteggio. Con
 * `setImmediate` la pompa non compare fra i 'Timeout' ma tiene il loop comunque,
 * quindi è l'unica forma che risolve il problema senza sporcare la misura.
 *
 * ── PERCHE' NON SI PROPAGA AI FIGLI ───────────────────────────────────────────
 * Questo modulo si carica solo dove viene importato. I figli lanciati da
 * `test/routes.test.mjs` e da `test/timeout-id.test.mjs` NON importano nulla di
 * tutto questo: nel figlio non c'è pompa, ed è proprio li che si osserva il
 * contratto vero del timer. Se la guardia di `raceTimeout` non avesse un handle
 * referenziato che tiene il ciclo, il processo drena e muore in silenzio con exit
 * 13 e stdout vuoto invece di consegnare la classificazione `ETIMEDOUT`.
 */

let held = null;

/**
 * Tiene vivo il ciclo degli eventi finche' non si chiama la funzione restituita.
 *
 * Idempotente: una seconda chiamata mentre la prima pompa e' ancora attiva
 * restituisce la stessa `release` e NON avvia una seconda pompa, cosi' un
 * `before` eseguito piu' volte non lascia girare due catene di immediati.
 *
 * @returns {() => void} rilascio; chiamarla due volte e' un no-op.
 */
export function holdLoop() {
  if (held) return held.release;

  const token = { stopped: false, handle: undefined };

  const pump = () => {
    if (token.stopped) return;
    // `setImmediate` e' REF di default: la catena si ri-arma ad ogni giro, quindi
    // c'e' sempre un immediato pendente e il loop non arriva mai a drainare.
    token.handle = setImmediate(pump);
  };

  const release = () => {
    if (token.stopped) return;
    token.stopped = true;
    clearImmediate(token.handle);
    held = null;
  };

  held = { release };
  pump();
  return release;
}
