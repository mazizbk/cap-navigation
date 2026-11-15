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
  let pending = null;      // action proposée, en attente d'un « oui »
  let nextHandler = null;  // la prochaine réponse va à ce traitement (dialogue du majordome)
  let expectReply = false; // la dernière réponse de l'application attend une suite : on réécoutera sans appui

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

  async function listen(depth = 0) {
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
    expectReply = false;
    try { if (nextHandler) { const f = nextHandler; nextHandler = null; await f(heard); } else await run(heard); } catch (e) { speak('Je n\'ai pas pu le faire.'); diag('commande vocale en échec : ' + e.message); }
    // L'application vient de poser une question (« Dites démarrer… ») : on attend la fin de sa phrase, puis on réécoute.
    if (expectReply && depth < 3 && !S.muted) {
      expectReply = false;
      const t0 = Date.now();
      while (Date.now() - t0 < 15000 && (voiceBusy() || performance.now() < (S.voiceUntil || 0))) await new Promise((r) => setTimeout(r, 200));
      await new Promise((r) => setTimeout(r, 300));
      listen(depth + 1);
    }
  }

  const plain = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’`]/g, "'").replace(/[.,!?-]/g, ' ').replace(/\s+/g, ' ').trim();
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
      if (S.route) speak(said + ' : ' + $('summary-text').innerText.split('\n')[0].replace(' ·', ',') + '. Dites « démarrer » pour partir.', true);
      if (S.route) expectReply = true;
    }
  }

  // Commandes comprises par Claude -> phrase fixe équivalente, exécutée par runRules.
  const CANON = { domicile: 'domicile', travail: 'travail', station_moins_chere: 'station la moins chère', station_plus_proche: 'station la plus proche',
    stations: 'station', arreter: 'arrête', silence: 'silence', remettre_le_son: 'remets le son', repeter: 'répète', heure_arrivee: 'combien de temps',
    trafic: 'trafic', eviter_peages: 'évite les péages', autoriser_peages: 'avec péage', eviter_autoroutes: 'évite les autoroutes',
    autoriser_autoroutes: 'avec autoroute', demarrer: 'démarrer', recentrer: 'recentre', changer_vue: 'change la vue', autre_trajet: 'autre trajet',
    enregistrer_domicile: 'enregistre comme domicile', enregistrer_travail: 'enregistre comme travail',
    parking: 'parking', oui: 'oui', non: 'non', trajet_economique: 'trajet le plus économique', cout_trajet: 'combien coûte le trajet en carburant', ma_voiture: 'où est ma voiture', partager_arrivee: "partage mon heure d'arrivée" };

  function appState() {
    const places = Places.read();
    const nav = S.mode === 'nav';
    return {
      guidage_en_cours: nav,
      destination: S.to ? S.to.label : null,
      heure_arrivee: nav ? $('eta').innerText.replace(/\s+/g, ' ') : null,
      reste: nav ? $('remaining').innerText.replace(/\s+/g, ' ') : null,
      itineraire_pret: !nav && !!S.route,
      domicile_enregistre: !!places.home,
      travail_enregistre: !!places.work,
      voix_coupee: !!S.muted,
      accueil: !!S.butlerGreeting,
      titre: (typeof Butler !== 'undefined' ? Butler.title() : 'monsieur'),
      compte_google_connecte: GAccount.connected(),
      contacts_disponibles: GAccount.contactsAvailable(),
      evite_peages: !!S.avoidTolls,
      evite_autoroutes: !!S.avoidMotorways,
    };
  }

  // Avec une clé Claude : la phrase est d'abord comprise par Claude. En cas d'échec (réseau, clé), on revient aux phrases fixes.
  async function run(heard) {
    if (typeof Sug !== 'undefined' && Sug.pickFromSpeech(plain(heard))) return;
    // À une étape (pause) : « on repart » relance tout de suite le trajet vers la destination finale.
    if (S.resumeTo && S.mode === 'arrived' && /^(on repart|c'est reparti|on y va|oui|allons y|reprends|repars)/.test(plain(heard))) { await Copilot.resume(); return; }
    // Les ordres courts et sans ambiguïté sont exécutés tout de suite, sans attendre Claude (2 secondes de gagnées).
    const quick = /^(stop|arrete|repete|silence|oui|non|ok|d'accord|demarrer|demarre|domicile|travail|parking|trafic|recentre|station|station la (moins chere|plus proche))$/.test(plain(heard));
    const answersProposal = !!pending && /^(oui|non|ok|d'accord|vas y|on y va|on repart|c'est reparti|allons y|volontiers|avec plaisir|pas la peine|non merci)/.test(plain(heard));
    if (!quick && !answersProposal && typeof AI !== 'undefined' && AI.enabled) {
      try {
        hud('« ' + heard + ' » … Claude réfléchit', true);
        const r = await AI.converse(heard, appState(), {
          commande: (name) => (CANON[name] ? runRules(CANON[name]) : null),
          data: (name, input) => (name === 'agenda' ? GAccount.agenda(input.jours) : name === 'mails' ? GAccount.mails(input.recherche) : GAccount.contact(input.nom)),
          lieux: (requetes, ouvert, near) => { hud(''); return Sug.open(requetes[0], requetes.slice(1), true, ouvert ? 'ouvert' : heard, near); },
        });
        if (r.done) { if (r.said && $('sug').hidden) { hud(r.said); speak(r.said); } return; }
        hud(r.said);
        speak(r.said);
        if (/\?\s*$/.test(r.said)) expectReply = true; // il attend une réponse : on réécoute
        return;
      } catch (e) {
        diag('Claude indisponible : ' + e.message);
        hud('');
      }
    }
    return runRules(heard);
  }

  // Cherche un lieu dit à voix haute, en privilégiant ce qui est près de la voiture (ou du domicile).
  async function findPlace(text) {
    const home = Places.read().home;
    const c = S.pos ? { lat: S.pos[1], lng: S.pos[0] } : home ? { lat: home.lat, lng: home.lon } : map.getCenter();
    try {
      const res = await fetch('https://photon.komoot.io/api/?lang=fr&limit=1&q=' + encodeURIComponent(text) + '&lat=' + c.lat.toFixed(3) + '&lon=' + c.lng.toFixed(3), { signal: AbortSignal.timeout(8000) });
      const f = res.ok ? ((await res.json()).features || [])[0] : null;
      if (!f || !f.geometry) return null;
      const p = f.properties || {};
      const name = p.name || [p.housenumber, p.street].filter(Boolean).join(' ') || text;
      const label = [name, p.city].filter(Boolean).join(', ');
      return { label, full: label, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] };
    } catch { return null; }
  }

  async function runRules(heard) {
    const q = plain(heard);
    const nav = S.mode === 'nav';
    const places = Places.read();

    // Réponse à une proposition de l'application (« Dites oui pour y aller »).
    if (/^(oui|ok|d'accord|vas y|y aller|on y va|on repart|c'est reparti|allons y|parfait|volontiers|avec plaisir)\b/.test(q) && pending) { const act = pending; pending = null; await act(); return; }
    if (/^(non|pas la peine|laisse|annule)\b/.test(q) && pending) { pending = null; speak('D\'accord.'); return; }
    pending = null;
    if (/\b(ou est|retrouve|ou j'ai gare|ou ai je gare)\b.*\b(voiture|auto)\b|^ma voiture$/.test(q)) { Plus.findCar(); return; }
    if (/\b(partage|envoie)\b.*\b(arrivee|heure)\b/.test(q)) { speak("Touchez l'heure d'arrivée en bas de l'écran pour la partager."); return; }
    if (/\b(parking|garer|stationner|stationnement)\b/.test(q)) {
      const best = await openParking();
      if (!best) { speak('Je ne trouve pas de parking public près de l\'arrivée.'); return; }
      const fee = best.fee === 'free' ? (best.customers ? 'gratuit mais réservé aux clients' : 'gratuit') : best.fee === 'paid' ? 'payant' : 'au tarif non indiqué';
      speak('Parking ' + fee + (best.name ? ', ' + best.name : '') + ', à ' + walk(best.dist).replace(' (', ', ').replace(')', '') + ' de l\'arrivée. Dites « oui » pour y aller.', true);
      pending = () => goToParking(best);
      expectReply = true;
      return;
    }
    if (/\b(economique|economie|moins cher|consomme)\b/.test(q) && /\b(trajet|itineraire|route|chemin)\b/.test(q)) {
      const eco = cheapestRoute();
      if (nav || !eco) { speak(nav ? 'Arrêtez d\'abord le guidage pour changer de trajet.' : 'Choisissez d\'abord une destination.'); return; }
      await chooseRoute(S.alts.indexOf(eco));
      speak('Trajet le plus économique : ' + $('summary-text').innerText.split('\n')[0].replace(' ·', ',') + ', environ ' + Math.round(Cost.euros(eco)) + ' euros de carburant. Dites « démarrer » pour partir.', true);
      expectReply = true;
      return;
    }
    if (/\b(coute|cout|prix du trajet|combien.*(carburant|essence))\b/.test(q) && S.route) {
      speak('Environ ' + Math.max(1, Math.round(Cost.euros(S.route))) + (Cost.euros(S.route) < 1.5 ? ' euro' : ' euros') + ' de carburant' + (S.route.toll ? ', péage en plus.' : '.'));
      return;
    }
    if (/\b(rendez vous|rdv|agenda|prochain rendez)\b/.test(q)) {
      if (!GAccount.connected()) { speak('Connectez d\'abord votre compte Google dans les réglages.'); return; }
      const ev = (await GAccount.agenda(7)).find((e) => e.lieu);
      if (!ev) { speak('Aucun rendez-vous avec une adresse dans les 7 prochains jours.'); return; }
      const d = new Date(ev.debut);
      speak(ev.titre + ', ' + d.toLocaleDateString('fr-FR', { weekday: 'long' }) + ' à ' + d.getHours() + ' heures ' + (d.getMinutes() || '') + '.', true);
      await Sug.open(ev.lieu, [], true, heard);
      return;
    }
    if (/\benregistre/.test(q) && /\b(domicile|maison|travail|bureau)\b/.test(q)) {
      const home = /\b(domicile|maison)\b/.test(q);
      if (!S.to) { speak('Choisissez d\'abord une destination.'); return; }
      Places.set(home ? 'home' : 'work', S.to);
      speak('Destination enregistrée comme ' + (home ? 'domicile.' : 'travail.'));
      return;
    }
    if (/\b(recentre|recentrer|centre la carte|ou suis je)\b/.test(q)) { $('recenter').click(); hud('Carte recentrée'); return; }
    if (/\b(change|changer|passe|mets|affiche)\b.*\b(vue|plan|satellite|carte|photo aerienne)\b|^vue\b/.test(q)) { $('view-toggle').click(); speak('Vue changée.'); return; }
    if (/\b(autre|deuxieme|second|suivant|prochain)\b.*\b(trajet|itineraire|route|chemin)\b/.test(q)) {
      const alts = S.alts || [];
      if (nav || alts.length < 2) { speak(nav ? 'Arrêtez d\'abord le guidage pour changer de trajet.' : 'Il n\'y a pas d\'autre trajet proposé.'); return; }
      await chooseRoute((alts.indexOf(S.route) + 1) % alts.length);
      speak('Autre trajet : ' + $('summary-text').innerText.split('\n')[0].replace(' ·', ',') + '. Dites « démarrer » pour partir.', true);
      expectReply = true;
      return;
    }
    if (/\b(repete|redis|redire|pardon|comment)\b/.test(q)) { if (nav) repeatInstruction(); else speak('Aucun guidage en cours.'); return; }
    if (/\b(silence|tais toi|muet|coupe (le son|la voix))\b/.test(q)) { setMuted(true); hud('Voix coupée'); return; }
    if (/\b(remets|reactive|active|rallume) (le son|la voix)\b|\bparle\b/.test(q)) { setMuted(false); speak('La voix est réactivée.'); return; }
    if (/\b(arrete|stop|annule|termine|quitte)\b/.test(q)) { if (nav) { stopNav(); speak('Guidage arrêté.', true); } else speak('Aucun guidage en cours.'); return; }

    if (/\b(station|essence|carburant|plein|sans plomb)\b/.test(q)) {
      const { stations, onRoute } = await fuelStations();
      if (!stations.length) { speak('Aucune station avec du sans plomb 95 ' + (onRoute ? 'sur les 20 prochains kilomètres.' : 'à moins de 10 kilomètres.')); return; }
      for (const st of stations) st.score = fuelScore(st, onRoute);
      const cheapest = stations.reduce((a, b) => (b.score < a.score ? b : a));
      const nearest = stations.reduce((a, b) => (b.dist < a.dist ? b : a));
      if (/moins cher/.test(q)) { speak('Station la moins chère, ' + euros(cheapest.price) + ', à ' + fmtDistSpoken(cheapest.dist) + '.', true); await goToStation(cheapest); return; }
      if (/plus (proche|pres)/.test(q)) { speak('Station la plus proche, ' + euros(nearest.price) + ', à ' + fmtDistSpoken(nearest.dist) + '.', true); await goToStation(nearest); return; }
      openFuel();
      speak(cheapest === nearest
        ? 'La station la moins chère est aussi la plus proche : ' + euros(cheapest.price) + ', à ' + fmtDistSpoken(cheapest.dist) + '.'
        : 'La moins chère est à ' + fmtDistSpoken(cheapest.dist) + ', ' + euros(cheapest.price) + '. La plus proche est à ' + fmtDistSpoken(nearest.dist) + ', ' + euros(nearest.price) + '. Dites « station la moins chère » ou « station la plus proche ».');
      if (cheapest !== nearest) expectReply = true;
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
      if (nav) speak('Arrivée ' + $('eta').innerText.replace(/\s+/g, ' ') + '. Il reste ' + $('remaining').innerText.replace(/\s+/g, ' ').replace(' ·', ',') + '.');
      else if (S.route) speak($('summary-text').innerText.split('\n')[0].replace(' ·', ',') + '.');
      else speak('Pas d\'itinéraire en cours.');
      return;
    }
    if (/\b(demarre|demarrer|c'est parti|on y va|lance|partons)\b/.test(q)) {
      if (!nav && S.route) startNav(false); else speak(nav ? 'Le guidage est déjà en cours.' : 'Choisissez d\'abord une destination.');
      return;
    }

    // « Va à… », « emmène-moi au… », « itinéraire vers… »
    const m = q.match(/\b(?:va|vas|aller|allons|emmene moi|conduis moi|itineraire|direction|navigue|guide moi|je veux aller|trouve moi|trouve|cherche moi|cherche|ou est|ou se trouve|je cherche)\s+(?:un |une |des |le |la |les )?(?:a la |a l'|au |aux |a |vers la |vers le |vers |pour |chez |jusqu'a |jusqu'au )?(.+)$/);
    if (m && m[1].length > 2) {
      await Sug.open(m[1], [], true, heard);
      return;
    }
    speak('Je n\'ai pas compris. Dites par exemple : station la moins chère, domicile, ou répète.');
    expectReply = true;
  }

  for (const id of ['mic-btn', 'mic-nav']) $(id).addEventListener('click', () => listen());

  // « Dis Siri, ouvre Cap » : si l'option est cochée, l'application écoute dès qu'elle s'ouvre ou revient à l'écran.
  const auto = $('auto-listen');
  auto.checked = readStore('autoListen') === '1';
  auto.addEventListener('change', () => { try { localStorage.setItem('autoListen', auto.checked ? '1' : '0'); } catch { /* stockage indisponible */ } });
  let hiddenAt = 0;
  const openListen = () => { if (auto.checked && available && !listening) setTimeout(() => listen(), 700); };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') hiddenAt = Date.now();
    else if (hiddenAt && Date.now() - hiddenAt > 3000) openListen();
  });

  // Commande passée dans l'adresse : …/?dire=station la moins chère  (web)  ou  capnav://dire?q=…  (application iPhone, raccourcis Siri).
  const fromUrl = (url) => {
    try {
      const u = new URL(url);
      const hash = new URLSearchParams(u.hash.slice(1));
      const k = u.searchParams.get('anthropic') || hash.get('anthropic');
      if (k && /^sk-ant-[\w-]{40,}$/.test(k) && typeof AI !== 'undefined') {
        AI.setKey(k);
        if (location.hash) history.replaceState(null, '', location.pathname + location.search);
        hud('Clé Claude enregistrée sur ce téléphone ✓');
        speak('Claude est activé.');
        return true;
      }
      if (u.host === 'majordome' || u.searchParams.has('majordome') || hash.has('majordome')) { if (typeof Butler !== 'undefined') Butler.start(); return true; }
      // Clé de la voix humaine Google (code QR) : capnav://cle?gtts=…  (+ voix=Achird pour choisir la voix)
      const g = u.searchParams.get('gtts') || hash.get('gtts');
      if (g && /^AIza[\w-]{30,}$/.test(g) && typeof GVoice !== 'undefined') {
        GVoice.setKey(g);
        try { localStorage.setItem('gttsOn', '1'); } catch { /* stockage */ }
        const vx = u.searchParams.get('voix') || hash.get('voix');
        if (vx && /^[A-Za-z]+$/.test(vx)) GVoice.setVoice('fr-FR-Chirp3-HD-' + vx);
        if (location.hash) history.replaceState(null, '', location.pathname + location.search);
        hud('Voix humaine activée ✓');
        speak('Bonjour. Voici ma nouvelle voix.', true);
        return true;
      }
      const said = u.searchParams.get('dire') || u.searchParams.get('q');
      if (said) { hud('« ' + said + ' »'); run(said).catch(() => {}); return true; }
    } catch { /* adresse illisible */ }
    return false;
  };
  if (cap && cap.Plugins && cap.Plugins.App) cap.Plugins.App.addListener('appUrlOpen', (e) => fromUrl(e.url));
  // Application lancée par le lien lui-même (raccourci iPhone « Ouvrir les URL » alors qu'elle était fermée).
  if (cap && cap.Plugins && cap.Plugins.App && cap.Plugins.App.getLaunchUrl) cap.Plugins.App.getLaunchUrl().then((r) => { if (r && r.url) fromUrl(r.url); }).catch(() => {});
  window.addEventListener('load', () => { if (!fromUrl(location.href)) openListen(); });
  return { available, native: !!plugin, listen, run, runRules, askAgain() { expectReply = true; }, setPending(fn) { pending = fn; }, onNextAnswer(fn) { nextHandler = fn; } };
})();
