'use strict';
/* Copilote : il ne parle qu'à trois moments calmes, jamais près d'une manœuvre.
 *   1. au départ : une ou deux phrases (heure d'arrivée, trafic, carburant, péage) ;
 *   2. sur un long trajet : après environ 2 h de conduite, il propose UNE pause à la station la moins chère devant.
 *      La pause est une étape : la destination finale est gardée, et on repart d'un mot ;
 *   3. à 5 km de l'arrivée : où se garer (gratuit d'abord), et, si Claude et Gmail sont connectés,
 *      une information utile tirée du mail de réservation (heure d'accueil, code…).
 * Tout fonctionne sans Claude ; Claude n'ajoute que l'information tirée des mails.
 * Chargé après butler.js : utilise S, $, speak, voiceBusy, Voice, AI, GAccount, Cost, fuelStations, fuelScore,
 * refineStation, parkingsNear, bestRoute, useRoute, frame, fmtDuration, roundSpoken, fmtDistSpoken, exitInfo, stepIndexAt.
 */
const Copilot = (() => {
  let driveSec = 0;
  let lastTick = 0;
  let pauseOfferedAt = -1e12;
  let arrivalDone = false;
  let briefed = false;

  const clock = (sec) => { const d = new Date(Date.now() + sec * 1000); const h = d.getHours(); return (h === 0 ? 'minuit' : h + (h === 1 ? ' heure' : ' heures')) + (d.getMinutes() ? ' ' + String(d.getMinutes()).padStart(2, '0') : ''); };
  const spokenDuration = (sec) => fmtDuration(sec).replace(/(\d+) h (\d+)/, '$1 heure $2').replace(/(\d+) h$/, '$1 heure').replace('min', 'minutes');

  // Aucune manœuvre importante dans les prochaines secondes : on peut parler.
  function roadClear() {
    const R = S.route;
    if (!R || voiceBusy()) return false;
    const i = stepIndexAt(S.d);
    const next = R.steps[i + 1];
    if (!next) return true;
    const toMan = next.start - S.d;
    return toMan > (exitInfo(i + 1, next) ? 2600 : 500);
  }

  // ---------- 1. départ
  function briefing() {
    const R = S.route;
    if (!R || briefed) return '';
    briefed = true;
    const time = R.viaTomTom ? R.duration : R.duration + (R.jamDelay || 0);
    const delay = Math.round((R.ttDelay || 0) / 60);
    let s = 'Arrivée prévue vers ' + clock(time) + ', ' + spokenDuration(time) + ' de route';
    s += delay >= 3 ? ', dont ' + delay + ' minutes de ralentissements.' : ', circulation fluide.';
    if (R.total > 30000) {
      const euros = Math.round(Cost.euros(R));
      s += ' Environ ' + euros + (euros > 1 ? ' euros' : ' euro') + ' de carburant' + (R.toll ? ', péage en plus.' : ', sans péage.');
    }
    if (time > 2 * 3600) s += ' Je vous proposerai une pause en route.';
    return s;
  }

  // ---------- étape (pause, station) sans perdre la destination
  async function stopAt(place, what) {
    if (!S.pos) return;
    S.resumeTo = S.resumeTo || S.finalDest || S.to;
    S.to = { ...place, full: place.label };
    $('to').value = place.label;
    useRoute(await bestRoute({ lon: S.pos[0], lat: S.pos[1] }, S.to, true));
    destMarker.setLngLat([S.to.lon, S.to.lat]);
    speak('Entendu. ' + what + ', puis nous repartirons vers ' + S.resumeTo.label.split(',')[0] + '.', true);
    saveTrip(true);
  }

  async function resume() {
    const dest = S.resumeTo;
    if (!dest || !S.pos) return;
    S.resumeTo = null;
    $('stopcard').hidden = true;
    S.to = dest;
    $('to').value = dest.label;
    useRoute(await bestRoute({ lon: S.pos[0], lat: S.pos[1] }, dest, true));
    destMarker.setLngLat([dest.lon, dest.lat]);
    S.mode = 'nav';
    $('stop').textContent = 'Arrêter';
    speak('C\'est reparti vers ' + dest.label.split(',')[0] + '.', true);
    saveTrip(true);
    cancelAnimationFrame(S.raf);
    S.lastT = 0;
    S.raf = requestAnimationFrame(frame);
  }

  // Appelé par arrive() : à une étape, on n'arrête pas le trajet, on propose de repartir.
  function onArrive() {
    if (!S.resumeTo) return false;
    S.mode = 'arrived';
    S.speed = 0;
    cancelAnimationFrame(S.raf);
    setHtml('man-icon', stepIcon({ type: 'arrive' }, 80));
    setHtml('man-dist', 'Étape');
    setHtml('man-text', escapeHtml(S.to.label));
    setHtml('man-road', '');
    setHtml('speed', '<b>0</b><span>km/h</span>');
    $('sign').hidden = true; $('lanes').hidden = true; $('then').hidden = true;
    $('banner').classList.remove('exit', 'exit-a');
    map.getSource('maneuver')?.setData(emptyFC);
    $('stopcard-text').textContent = 'Étape atteinte. Prochaine destination : ' + S.resumeTo.label.split(',')[0];
    $('stopcard').hidden = false;
    speak('Vous êtes à l\'étape. Dites « on repart » quand vous êtes prêt.', true);
    Voice.setPending(resume);
    return true;
  }

  // ---------- 2. pause sur long trajet
  async function offerPause() {
    pauseOfferedAt = driveSec;
    let data;
    try { data = await fuelStations(); } catch { return; }
    const list = (data.stations || []).filter((s) => s.dist > 2000);
    if (!list.length) return;
    for (const st of list) st.score = fuelScore(st, true);
    const best = list.reduce((a, b) => (b.score < a.score ? b : a));
    if (!roadClear()) return;
    const h = Math.floor(driveSec / 3600);
    speak('Vous roulez depuis ' + (h >= 2 ? h + ' heures' : 'un moment') + '. Je vous propose une pause à la station de ' + (best.city || 'la route') + ', dans ' + fmtDistSpoken(best.dist) +
      ', le sans plomb à ' + best.price.toFixed(2).replace('.', ' euro ') + '. On s\'y arrête ?', true);
    Voice.setPending(async () => {
      const st = typeof refineStation === 'function' ? await refineStation(best) : best;
      await stopAt({ label: 'Pause, station ' + (st.brand || st.city || ''), lon: st.lon, lat: st.lat }, 'Pause à la station dans ' + fmtDistSpoken(best.dist));
    });
    Voice.askAgain();
    if (Voice.available) setTimeout(() => Voice.listen(), 6500);
  }

  // ---------- 3. arrivée
  async function arrival() {
    arrivalDone = true;
    const dest = S.resumeTo ? null : (S.finalDest || S.to);
    if (!dest) return;
    const R = S.route;
    const left = R.duration * (1 - S.d / R.total);
    let text = 'Arrivée dans ' + Math.max(1, Math.round(left / 60)) + ' minutes.';
    try {
      const { list } = await parkingsNear(dest);
      const p = list[0];
      if (p && p.fee === 'free' && !p.customers) {
        text += ' Parking gratuit à ' + roundSpoken(p.dist * 1.3) + ' à pied de l\'arrivée. Dites « parking » pour y aller.';
      }
    } catch { /* pas de parking connu */ }
    // Avec Claude et Gmail : une information utile tirée du mail de réservation.
    if (typeof AI !== 'undefined' && AI.enabled && GAccount.connected()) {
      try {
        const r = await AI.converse('Cherche dans mes mails une réservation pour « ' + dest.label + ' ». S\'il y en a une, dis en une seule phrase l\'information utile pour arriver (heure d\'accueil, code, parking). Sinon, ne dis rien d\'autre que : rien.',
          { arrivee: dest.label, guidage_en_cours: true }, { commande: () => null, lieux: () => null, data: (n, i) => (n === 'mails' ? GAccount.mails(i.recherche) : n === 'agenda' ? GAccount.agenda(i.jours) : []) });
        if (r.said && !/^rien\.?$/i.test(r.said.trim())) text += ' ' + r.said;
      } catch { /* Claude indisponible : on s'en passe */ }
    }
    const t0 = Date.now();
    while (!roadClear() && Date.now() - t0 < 60000) await new Promise((r) => setTimeout(r, 1000));
    speak(text);
  }

  // Appelé 5 fois par seconde pendant le guidage.
  function tick() {
    const now = performance.now();
    const dt = lastTick ? Math.min(1, (now - lastTick) / 1000) : 0;
    lastTick = now;
    if (S.mode !== 'nav' || !S.route) return;
    if (S.speed > 5) driveSec += dt * (S.sim ? S.simMult || 1 : 1);
    const R = S.route;
    const left = R.total - S.d;
    if (driveSec > 2 * 3600 && driveSec - pauseOfferedAt > 3600 && left > 30000 && !S.resumeTo && roadClear()) offerPause();
    if (!arrivalDone && left < 5000 && left > 1500 && R.total > 15000 && roadClear()) arrival();
  }

  // Nouveau trajet : on remet les compteurs (sauf la durée de conduite, qui suit le conducteur).
  function reset() { briefed = false; arrivalDone = false; }
  function newDay() { driveSec = 0; pauseOfferedAt = -1e12; }

  $('stopcard-go').addEventListener('click', resume);
  return { briefing, tick, onArrive, stopAt, resume, reset, newDay, get driveSec() { return driveSec; }, set driveSec(v) { driveSec = v; } };
})();
