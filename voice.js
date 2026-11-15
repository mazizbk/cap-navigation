'use strict';
/* Commandes vocales : on touche le micro, on parle, l'application agit.
 * Chargé en dernier : utilise S, $, speak, planRoute, startNav, stopNav, bestRoute, useRoute, fuelStations… définis avant.
 *   - application iPhone native : reconnaissance vocale du téléphone (module speech-recognition) ;
 *   - navigateur : reconnaissance vocale du navigateur, quand elle existe.
 * Le micro n'écoute que pendant quelques secondes après un appui : rien n'est écouté en permanence.
 */
const Voice = (() => {
  const cap = window.Capacitor;
  const plugin = cap && cap.isNativePlatform && cap.isNativePlatform() && cap.Plugins ? cap.Plugins.SpeechRecognition : null;
  const WebRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  // En web app installée sur l'écran d'accueil de l'iPhone, la reconnaissance du navigateur ne fonctionne pas.
  const standalone = window.navigator.standalone === true;
  const available = !!plugin || (!!WebRec && !standalone);
  let listening = false;

  function hud(text, hold) {
    const el = $('voice-hud');
    el.textContent = text;
    el.hidden = !text;
    clearTimeout(hud.timer);
    if (text && !hold) hud.timer = setTimeout(() => { el.hidden = true; }, 4000);
  }

  // Écoute une phrase et la renvoie (chaîne vide si rien n'a été entendu).
  async function hearNative() {
    const perm = await plugin.requestPermissions();
    if (perm && perm.speechRecognition && perm.speechRecognition !== 'granted') throw new Error('micro refusé');
    let last = '';
    let lastAt = Date.now();
    const sub = await plugin.addListener('partialResults', (d) => {
      if (d && d.matches && d.matches[0]) { last = d.matches[0]; lastAt = Date.now(); hud('« ' + last + ' »', true); }
    });
    plugin.start({ language: 'fr-FR', maxResults: 1, partialResults: true, popup: false }).catch(() => {});
    const t0 = Date.now();
    // On s'arrête après 1,4 s de silence une fois qu'une phrase est entendue, ou après 8 s au plus.
    while (Date.now() - t0 < 8000 && !(last && Date.now() - lastAt > 1400)) await new Promise((r) => setTimeout(r, 150));
    try { await plugin.stop(); } catch { /* déjà arrêté */ }
    try { sub.remove(); } catch { /* idem */ }
    return last;
  }

  function hearWeb() {
    return new Promise((resolve, reject) => {
      const rec = new WebRec();
      rec.lang = 'fr-FR';
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      let heard = '';
      rec.onresult = (e) => { heard = e.results[0][0].transcript; };
      rec.onerror = (e) => { if (e.error === 'no-speech') resolve(''); else reject(new Error(e.error)); };
      rec.onend = () => resolve(heard);
      rec.start();
      setTimeout(() => { try { rec.stop(); } catch { /* déjà arrêté */ } }, 8000);
    });
  }

  async function listen() {
    if (listening) return;
    if (!available) {
      hud(standalone ? 'Commandes vocales : disponibles dans l\'application installée par câble, pas dans la web app.' : 'Ce navigateur ne sait pas reconnaître la voix.');
      return;
    }
    listening = true;
    document.body.classList.add('listening');
    stopVoice();
    hud('Je vous écoute…', true);
    let heard = '';
    try { heard = await (plugin ? hearNative() : hearWeb()); } catch (e) { hud('Micro indisponible : ' + e.message); }
    listening = false;
    document.body.classList.remove('listening');
    if (!heard) { if (!$('voice-hud').hidden && $('voice-hud').textContent === 'Je vous écoute…') hud('Je n\'ai rien entendu.'); return; }
    hud('« ' + heard + ' »');
    diag('commande vocale : ' + heard);
    try { await run(heard); } catch (e) { speak('Je n\'ai pas pu le faire.'); diag('commande vocale en échec : ' + e.message); }
  }

  const plain = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[.,!?]/g, ' ').replace(/\s+/g, ' ').trim();
  const euros = (v) => v.toFixed(2).replace('.', ' euro ');

  // Change de destination. En cours de guidage, on repart de la position actuelle sans quitter l'écran de conduite.
  async function navTo(place, said) {
    if (S.mode === 'nav' && S.pos) {
      S.to = { label: place.label, full: place.label, lon: place.lon, lat: place.lat };
      $('to').value = place.label;
      useRoute(await bestRoute({ lon: S.pos[0], lat: S.pos[1] }, S.to, true));
      destMarker.setLngLat([S.to.lon, S.to.lat]);
      saveTrip(true);
      speak(said + '.', true);
    } else {
      S.to = { label: place.label, full: place.label, lon: place.lon, lat: place.lat };
      $('to').value = place.label;
      await planRoute();
      if (S.route) speak(said + ' : ' + $('summary-text').innerText.split('\n')[0].replace('·', ',') + '. Dites « démarrer » pour partir.', true);
    }
  }

  async function run(heard) {
    const q = plain(heard);
    const nav = S.mode === 'nav';
    const places = Places.read();

    if (/\b(repete|redis|redire|pardon|comment)\b/.test(q)) { if (nav) repeatInstruction(); else speak('Aucun guidage en cours.'); return; }
    if (/\b(silence|tais toi|muet|coupe (le son|la voix))\b/.test(q)) { if (!S.muted) $('mute').click(); hud('Voix coupée'); return; }
    if (/\b(remets|reactive|active|rallume) (le son|la voix)\b|\bparle\b/.test(q)) { if (S.muted) $('mute').click(); speak('La voix est réactivée.'); return; }
    if (/\b(arrete|stop|annule|termine|quitte)\b/.test(q)) { if (nav) { stopNav(); speak('Guidage arrêté.', true); } else speak('Aucun guidage en cours.'); return; }

    if (/\b(station|essence|carburant|plein|sans plomb)\b/.test(q)) {
      const { stations, onRoute } = await fuelStations();
      if (!stations.length) { speak('Aucune station avec du sans plomb 95 ' + (onRoute ? 'sur les 60 prochains kilomètres.' : 'à moins de 10 kilomètres.')); return; }
      const cheapest = stations.reduce((a, b) => (b.price < a.price ? b : a));
      const nearest = stations.reduce((a, b) => (b.dist < a.dist ? b : a));
      if (/moins cher/.test(q)) { speak('Station la moins chère, ' + euros(cheapest.price) + ', à ' + fmtDistSpoken(cheapest.dist) + '.', true); await goToStation(cheapest); return; }
      if (/plus (proche|pres)/.test(q)) { speak('Station la plus proche, ' + euros(nearest.price) + ', à ' + fmtDistSpoken(nearest.dist) + '.', true); await goToStation(nearest); return; }
      openFuel();
      speak(cheapest === nearest
        ? 'La station la moins chère est aussi la plus proche : ' + euros(cheapest.price) + ', à ' + fmtDistSpoken(cheapest.dist) + '.'
        : 'La moins chère est à ' + fmtDistSpoken(cheapest.dist) + ', ' + euros(cheapest.price) + '. La plus proche est à ' + fmtDistSpoken(nearest.dist) + ', ' + euros(nearest.price) + '. Dites « station la moins chère » ou « station la plus proche ».');
      return;
    }

    if (/\b(maison|domicile|chez moi)\b/.test(q)) { if (places.home) await navTo(places.home, 'Itinéraire vers le domicile'); else speak('Le domicile n\'est pas encore enregistré.'); return; }
    if (/\b(travail|bureau|boulot)\b/.test(q)) { if (places.work) await navTo(places.work, 'Itinéraire vers le travail'); else speak('Le lieu de travail n\'est pas encore enregistré.'); return; }

    const toll = /peage/.test(q);
    const motorway = /autoroute/.test(q);
    if ((toll || motorway) && /\b(evite|eviter|sans|avec|autorise|accepte)\b/.test(q)) {
      const on = /\b(evite|eviter|sans)\b/.test(q);
      const id = toll ? 'avoid-tolls' : 'avoid-motorways';
      S[toll ? 'avoidTolls' : 'avoidMotorways'] = on;
      $(id).checked = on;
      try { localStorage.setItem(toll ? 'avoidTolls' : 'avoidMotorways', on ? '1' : '0'); } catch { /* stockage indisponible */ }
      const what = (on ? 'sans ' : 'avec ') + (toll ? 'péage' : 'autoroute');
      if (S.to) await navTo(S.to, 'Nouvel itinéraire ' + what); else speak('Entendu, ' + what + '.');
      return;
    }

    if (/\b(trafic|bouchon|bouchons|circulation|embouteillage)\b/.test(q)) {
      const t = S.route ? trafficSummary().replace(/[^\p{L}\p{N}\s+,.:'’-]/gu, ' ').replace(/\+/g, 'plus ').replace(/source.*$/, '') : '';
      speak(t || 'Pas d\'itinéraire en cours.');
      return;
    }
    if (/\b(combien|quand|heure|arrivee|arrive|reste|temps|distance)\b/.test(q)) {
      if (nav) speak('Arrivée ' + $('eta').innerText.replace(/\s+/g, ' ') + '. Il reste ' + $('remaining').innerText.replace(/\s+/g, ' ').replace('·', ',') + '.');
      else if (S.route) speak($('summary-text').innerText.split('\n')[0].replace('·', ',') + '.');
      else speak('Pas d\'itinéraire en cours.');
      return;
    }
    if (/\b(demarre|demarrer|c'est parti|on y va|lance|partons)\b/.test(q)) {
      if (!nav && S.route) startNav(false); else speak(nav ? 'Le guidage est déjà en cours.' : 'Choisissez d\'abord une destination.');
      return;
    }

    // « Va à… », « emmène-moi au… », « itinéraire vers… »
    const m = q.match(/\b(?:va|vas|aller|allons|emmene moi|conduis moi|itineraire|direction|navigue|guide moi|je veux aller)\s+(?:a la |a l'|au |aux |a |vers la |vers le |vers |pour |chez |jusqu'a |jusqu'au )?(.+)$/);
    if (m && m[1].length > 2) {
      const text = heard.slice(heard.length - m[1].length).trim().length === m[1].length ? heard.slice(heard.length - m[1].length).trim() : m[1];
      S.to = null;
      $('to').value = text;
      if (nav) {
        const to = await resolvePlace('to');
        await navTo(to, 'Itinéraire vers ' + to.label.split(',')[0]);
      } else {
        await planRoute();
        if (S.route && S.to) speak('Itinéraire vers ' + S.to.label.split(',')[0] + ' : ' + $('summary-text').innerText.split('\n')[0].replace('·', ',') + '. Dites « démarrer » pour partir.', true);
        else speak('Je n\'ai pas trouvé ' + text + '.');
      }
      return;
    }
    speak('Je n\'ai pas compris. Dites par exemple : station la moins chère, domicile, ou répète.');
  }

  for (const id of ['mic-btn', 'mic-nav']) $(id).addEventListener('click', listen);
  return { available, native: !!plugin, listen, run };
})();
