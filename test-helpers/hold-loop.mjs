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
 * eseguito come file di test e finisce nel censimento come un test che passa:
 * misurato, `# tests 228 / # pass 225` invece di `227 / 224`, su 20, 22, 24 e 26
 * insieme. Un numero di censimento sbagliato di uno e' peggio di un test perso,
 * perche' quando poi un test sparisce davvero nessuno se ne accorge. Qui la
 * discovery non lo vede (la directory non si chiama `test`/`tests` e il nome del
 * file non comincia con `test-` ne finisce con `-test`), quindi il censimento
 * resta esattamente quello di prima.
 *
 * Il prezzo e' che `npm run check` fa `find src test` e quindi non lo syntax-checka.
 * Copre pero' l'unico rischio reale (una sintassi rotta), perche' il modulo viene
 * importato da tre file di test: se non si carica, la suite muore subito e rumorosamente.
 *
 * ── PERCHE' ESISTE ────────────────────────────────────────────────────────────
 * Le guard di `src/resolver.js` (`raceTimeout`) e di `src/manifest.js`
 * (`withTimeout`) sono `unref()` per CONTRATTO: un timer di guardia non deve
 * tenere aperto il processo, perche' quando la risposta e' gia' stata inviata
 * non c'e' piu' niente da consegnare (vedi il contratto dichiarato in
 * `src/resolver.js`, "USCITA DEL PROCESSO"). Da sole quindi NON tengono vivo il
 * ciclo degli eventi: e in produzione non devono, perche' a tenerlo aperto ci
 * pensa il socket del server.
 *
 * Un file di test invece non ha un ascolto: il loop puo' DRAINARE. A quel punto
 * una promise appesa (`withTimeout(new Promise(() => {}), 30_000)`) non si
 * assesta mai, la scadenza non arriva mai e `node:test` CANCELLA il resto del
 * file. Il sintomo e' subdolo: `# fail 0` con decine di `# cancelled`, cioe'
 * una suite "verde" che non ha verificato niente.
 *
 * ── PERCHE' POMPA CON `setImmediate` E NON CON `setTimeout` ────────────────────
 * `getActiveResourcesInfo()` elenca i timer che tengono vivo il ciclo come
 * 'Timeout' e gli immediati come 'Immediate'. I test di `test/routes.test.mjs`
 * contano i 'Timeout' per dimostrare che il guard NON tiene aperto il loop: un
 * `setTimeout` pending dentro una finta perderebbe il conteggio. Con
 * `setImmediate` la pompa non compare fra i 'Timeout' ma tiene il loop
 * comunque, quindi e' l'unica forma che risolve il problema senza sporcare la
 * misura.
 *
 * ── PERCHE' NON SI PROPAGA AI FIGLI ───────────────────────────────────────────
 * Questo modulo si carica solo dove viene importato. Il figlio lanciato da
 * `test/routes.test.mjs` (che arma un guard e deve uscire da solo) NON importa
 * nulla di tutto questo, quindi l'asserzione "il guard non tiene aperto il
 * PROCESSO" resta vera: nel figlio non c'e' pompa, solo la guardia `unref()`, e
 * se la guardia smettesse di fare il suo lavoro il figlio resterebbe vivo per
 * tutto il budget.
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