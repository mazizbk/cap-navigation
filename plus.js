'use strict';
/* Ce que font Waze / Google Maps et qui manquait, en restant calme :
 *   1. virage serré devant alors qu'on roule vite : une phrase, assez tôt pour freiner doucement ;
 *   2. la voiture garée : position mémorisée à l'arrivée, « où est ma voiture » la retrouve à pied ;
 *   3. partager l'heure d'arrivée : toucher l'heure en bas de l'écran (pour le passager) ;
 *   4. pluie à l'arrivée : dite au départ seulement si elle est probable (Open-Meteo, sans clé).
 * Chargé après copilot.js : utilise S, $, Geo, speak, voiceBusy, stepIndexAt, exitInfo, roundSpoken, setNavNote, fmtDist.
 */
const Plus = (() => {
  // ---------- 1. virages serrés
  const STEP = 10;        // un cap tous les 10 m
  const WIN = 6;          // fenêtre de 60 m pour mesurer le virage

  // Repère sur le tracé les virages de petit rayon, hors carrefours (ceux-là ont déjà leur consigne).
  function findCurves(R) {
    const n = Math.floor(R.total / STEP);
    if (n < WIN + 2) return [];
    const brg = [];
    let prev = Geo.pointAt(R.coords, R.cum, 0);
    for (let i = 1; i <= n; i++) {
      const p = Geo.pointAt(R.coords, R.cum, i * STEP);
      brg.push(Geo.bearing(prev, p));
      prev = p;
    }
    const turnAt = (i) => { let t = 0; for (let k = i; k < i + WIN; k++) t += ((brg[k + 1] - brg[k] + 540) % 360) - 180; return t; };
    const junctions = R.steps.filter((s) => s.type !== 'depart' && s.type !== 'arrive' && (isTurn(s) || /fork|ramp|roundabout|rotary/.test(s.type))).map((s) => s.start);
    const out = [];
    let i = 0;
    while (i + WIN < brg.length) {
      const t = turnAt(i);
      if (Math.abs(t) < 35) { i++; continue; }
      // Virage trouvé : on le suit tant qu'il continue, et on garde son rayon le plus petit.
      let minR = (WIN * STEP) / (Math.abs(t) * Math.PI / 180);
      let j = i + 1;
      while (j + WIN < brg.length && Math.sign(turnAt(j)) === Math.sign(t) && Math.abs(turnAt(j)) >= 35) {
        minR = Math.min(minR, (WIN * STEP) / (Math.abs(turnAt(j)) * Math.PI / 180));
        j++;
      }
      const at = i * STEP;
      const nearJunction = junctions.some((d) => d > at - 80 && d < j * STEP + WIN * STEP + 40);
      if (minR < 160 && !nearJunction) out.push({ at, radius: minR, side: t > 0 ? 'droite' : 'gauche' });
      i = j + WIN;
    }
    return out;
  }

  let curvesFor = null;
  let curves = [];
  const said = new Set();

  function curveTick() {
    const R = S.route;
    if (!R || S.mode !== 'nav') return;
    if (curvesFor !== R) { curvesFor = R; said.clear(); try { curves = findCurves(R); } catch { curves = []; } }
    const v = S.speed;                       // m/s
    if (v < 50 / 3.6) return;                // en ville on roule déjà doucement : rien à dire
    const ahead = Math.min(450, Math.max(150, v * 9));
    const c = curves.find((k) => k.at > S.d + 40 && k.at - S.d < ahead && !said.has(k.at));
    if (!c) return;
    const safe = Math.sqrt(2.5 * c.radius);  // vitesse confortable dans ce virage (accélération latérale 2,5 m/s²)
    if (v < safe * 1.15 + 2) { said.add(c.at); return; }
    // Une consigne de direction tout près passe avant.
    const i = stepIndexAt(S.d);
    const next = R.steps[i + 1];
    if (voiceBusy() || (next && next.start - S.d < 300 && next.start > c.at - 100)) return;
    said.add(c.at);
    speak('Virage serré à ' + c.side + ' dans ' + roundSpoken(c.at - S.d) + '.');
  }

  // ---------- 2. la voiture garée
  const readCar = () => { try { return JSON.parse(localStorage.getItem('carParked') || 'null'); } catch { return null; } };
  function rememberCar() {
    if (!S.pos) return;
    try { localStorage.setItem('carParked', JSON.stringify({ lon: S.pos[0], lat: S.pos[1], t: Date.now(), label: S.to ? S.to.label.split(',')[0] : '' })); } catch { /* stockage indisponible */ }
    renderCarChip();
  }
  function carUrl(c) { return 'https://maps.apple.com/?daddr=' + c.lat.toFixed(6) + ',' + c.lon.toFixed(6) + '&dirflg=w'; }
  function findCar() {
    const c = readCar();
    if (!c) { speak('Je n\'ai pas de position de voiture enregistrée.'); return; }
    const here = S.pos;
    const d = here ? Geo.distance(here, [c.lon, c.lat]) : 0;
    if (here && d < 40) { speak('Votre voiture est juste ici.'); return; }
    speak('Votre voiture est garée' + (c.label ? ' près de ' + c.label : '') + (here ? ', à ' + roundSpoken(d) + '.' : '.') + ' J\'ouvre le chemin à pied.', true);
    setTimeout(() => window.open(carUrl(c), '_blank'), 1800);
  }
  function renderCarChip() {
    renderHabitChip();
    const box = $('shortcuts');
    if (!box) return;
    box.querySelector('.chip-car')?.remove();
    const c = readCar();
    if (!c || Date.now() - c.t > 7 * 864e5) return;     // au-delà d'une semaine, l'information n'est plus sûre
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip chip-car';
    b.textContent = '🚗 Ma voiture';
    b.addEventListener('click', findCar);
    box.prepend(b);
    box.hidden = false;
  }

  // ---------- 3. partager l'heure d'arrivée
  async function shareEta() {
    if (S.mode !== 'nav' || !S.to) return;
    const text = 'J\'arrive vers ' + $('eta').innerText.trim() + ' (' + S.to.label.split(',')[0] + ').';
    try {
      if (navigator.share) await navigator.share({ text });
      else { await navigator.clipboard.writeText(text); setNavNote('Heure d\'arrivée copiée'); }
    } catch { /* partage annulé */ }
  }

  // ---------- 4. pluie à l'arrivée
  let rainFor = null;
  let rainText = '';
  async function rainAtArrival(R) {
    if (rainFor === R) return rainText;
    rainFor = R; rainText = '';
    const dest = S.finalDest || S.to;
    if (!dest) return '';
    const at = new Date(Date.now() + (R.duration + (R.jamDelay || 0)) * 1000);
    try {
      const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + dest.lat.toFixed(3) + '&longitude=' + dest.lon.toFixed(3) +
        '&hourly=precipitation_probability,precipitation,temperature_2m&forecast_days=2&timezone=auto';
      const j = await (await fetch(url, { signal: AbortSignal.timeout(6000) })).json();
      const h = j.hourly;
      const key = at.getFullYear() + '-' + String(at.getMonth() + 1).padStart(2, '0') + '-' + String(at.getDate()).padStart(2, '0') + 'T' + String(at.getHours()).padStart(2, '0') + ':00';
      const k = h.time.indexOf(key);
      if (k < 0) return '';
      const prob = h.precipitation_probability[k] || 0;
      const mm = h.precipitation[k] || 0;
      if (prob >= 60 || mm >= 0.5) rainText = mm >= 3 ? 'Forte pluie prévue à l\'arrivée.' : 'Pluie prévue à l\'arrivée.';
      // Froid : jusqu'à +2 °C avec de l'humidité (pluie récente ou prévue), ou sous zéro : la route peut geler.
      const cold = Math.min(...h.temperature_2m.slice(Math.max(0, k - 2), k + 1));
      const wet = h.precipitation.slice(Math.max(0, k - 6), k + 1).some((v) => v > 0.1) || prob >= 40;
      if (cold <= 2 && (wet || cold <= 0)) rainText = (cold <= 0 ? 'Gel prévu à l\'arrivée' : 'Températures proches de zéro à l\'arrivée') + ', prudence : risque de verglas.' + (rainText ? ' ' + rainText : '');
    } catch { /* météo indisponible : on n'en parle pas */ }
    const el = $('summary-rain');
    if (el && R === S.route) { el.textContent = rainText ? (/verglas/.test(rainText) ? '❄️ ' : '🌧 ') + rainText : ''; el.hidden = !rainText; }
    return rainText;
  }

  // ---------- 5. rendez-vous : à l'heure ou en retard
  // S.meeting est posé quand on part vers un rendez-vous de l'agenda ; sinon on cherche un rendez-vous
  // d'aujourd'hui dont le lieu ressemble à la destination.
  const words = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter((w) => w.length > 3);
  async function findMeeting() {
    if (S.meeting && new Date(S.meeting.debut) > Date.now()) return S.meeting;
    try {
      if (typeof GAccount === 'undefined' || !GAccount.connected() || !S.to) return null;
      const dest = new Set(words(S.to.label));
      const now = Date.now();
      return (await GAccount.agenda(1)).find((e) => {
        const t = new Date(e.debut).getTime();
        return e.lieu && /T/.test(e.debut) && t > now && t - now < 8 * 3600e3 && words(e.lieu).filter((w) => dest.has(w)).length >= 2;
      }) || null;
    } catch { return null; }
  }
  let meeting = null;
  let lateSaid = 0;
  const hhmm = (d) => d.getHours() + ' heures' + (d.getMinutes() ? ' ' + String(d.getMinutes()).padStart(2, '0') : '');
  function meetingLine(etaMs) {
    const start = new Date(meeting.debut);
    const diff = Math.round((start - etaMs) / 60000);
    if (diff >= 5) return '';                 // large avance : rien à dire
    if (diff >= -1) return 'Vous arriverez juste à l\'heure pour « ' + meeting.titre + ' », à ' + hhmm(start) + '.';
    return 'Attention, environ ' + -diff + ' minutes de retard pour « ' + meeting.titre + ' ».';
  }
  // Pendant le trajet : si le trafic fait passer en retard, on le dit une fois (puis à nouveau seulement si ça empire de 10 min).
  function meetingTick() {
    if (!meeting || S.mode !== 'nav' || !S.etaMs) return;
    const late = Math.round((S.etaMs - new Date(meeting.debut)) / 60000);
    if (late >= 3 && late >= lateSaid + 10 && !voiceBusy() && Copilot && (performance.now() - (S.meetingSaidAt || 0) > 60000)) {
      lateSaid = late;
      S.meetingSaidAt = performance.now();
      speak('Avec la circulation, environ ' + late + ' minutes de retard pour votre rendez-vous.');
    }
  }

  // ---------- 6. habitudes : les trajets du même moment de la semaine
  const readLog = () => { try { return JSON.parse(localStorage.getItem('tripLog') || '[]'); } catch { return []; } };
  function logTrip() {
    const d = S.finalDest || S.to;
    if (!d || S.sim) return;
    const now = new Date();
    const log = readLog().filter((t) => Date.now() - t.t < 90 * 864e5);
    log.push({ label: d.label, lon: d.lon, lat: d.lat, t: now.getTime(), wd: now.getDay() % 6 !== 0 ? 1 : 0, h: now.getHours() + now.getMinutes() / 60 });
    try { localStorage.setItem('tripLog', JSON.stringify(log.slice(-300))); } catch { /* stockage plein */ }
  }
  // Destination habituelle à cette heure-ci (au moins 3 fois, et la plupart du temps), ou null.
  function habit() {
    const now = new Date();
    const wd = now.getDay() % 6 !== 0 ? 1 : 0;
    const h = now.getHours() + now.getMinutes() / 60;
    const same = readLog().filter((t) => t.wd === wd && Math.abs(t.h - h) <= 1.5);
    if (same.length < 3) return null;
    const groups = [];
    for (const t of same) {
      const g = groups.find((x) => Geo.distance([x.lon, x.lat], [t.lon, t.lat]) < 150);
      if (g) g.n++; else groups.push({ ...t, n: 1 });
    }
    groups.sort((a, b) => b.n - a.n);
    const best = groups[0];
    if (best.n < 3 || best.n < same.length * 0.5) return null;
    if (S.pos && Geo.distance(S.pos, [best.lon, best.lat]) < 500) return null;   // on y est déjà
    const p = Places.read();
    const near = (x) => x && Geo.distance([x.lon, x.lat], [best.lon, best.lat]) < 150;
    const name = near(p.home) ? 'à la maison' : near(p.work) ? 'au travail' : 'à ' + best.label.split(',')[0];
    return { place: { label: best.label, lon: best.lon, lat: best.lat }, name };
  }
  // Oui à « comme d'habitude ? » : on calcule et on part.
  async function goHabit(h) {
    S.to = { ...h.place, full: h.place.label };
    $('to').value = h.place.label;
    await planRoute();
    if (S.route) startNav(false);
  }
  function renderHabitChip() {
    const box = $('shortcuts');
    if (!box) return;
    box.querySelector('.chip-habit')?.remove();
    const h = habit();
    if (!h) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip chip-habit';
    b.textContent = '⭐ ' + h.name.replace(/^(à la |au |à )/, '').replace(/^./, (c) => c.toUpperCase());
    b.addEventListener('click', () => goTo(h.place));
    box.prepend(b);
    box.hidden = false;
  }

  // Au départ : rendez-vous, puis pluie, chacun seulement s'il y a quelque chose d'utile à dire.
  async function onStart() {
    const R = S.route;
    logTrip();
    hideCard();
    if (!S.resumeTo) { trip.t0 = Date.now(); trip.m = 0; trip.last = 0; }
    meeting = null; lateSaid = 0; S.etaMs = 0;
    const [t, ev] = await Promise.all([rainAtArrival(R), findMeeting()]);
    S.meeting = null;                         // utilisé pour ce trajet seulement
    if (S.route !== R) return;
    meeting = ev;
    if (meeting) { const late = Math.round(((S.etaMs || Date.now() + R.duration * 1000) - new Date(meeting.debut)) / 60000); lateSaid = late >= 3 ? late : 0; }
    const text = [meeting ? meetingLine(S.etaMs || Date.now() + R.duration * 1000) : '', t].filter(Boolean).join(' ');
    if (!text) return;
    setTimeout(() => { if (S.mode === 'nav' && !voiceBusy()) speak(text); }, 9000);
  }

  // ---------- 7. arrivée : bilan du trajet, et chemin à pied depuis le parking
  const trip = { t0: 0, m: 0, last: 0 };
  function tripTick() {
    const now = performance.now();
    if (trip.last && S.mode === 'nav') trip.m += S.speed * Math.min(2, (now - trip.last) / 1000) * (S.sim ? S.simMult || 1 : 1);
    trip.last = now;
  }
  function card(text, actions) {
    let el = $('arrivecard');
    if (!el) {
      el = document.createElement('div');
      el.id = 'arrivecard';
      el.className = 'panel';
      document.body.appendChild(el);
    }
    el.innerHTML = '';
    const span = document.createElement('div');
    span.className = 'ac-text';
    span.textContent = text;
    el.appendChild(span);
    const row = document.createElement('div');
    row.className = 'ac-row';
    for (const [label, fn, primary] of actions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn' + (primary ? ' btn-primary' : '');
      b.textContent = label;
      b.addEventListener('click', () => { el.hidden = true; fn(); });
      row.appendChild(b);
    }
    el.appendChild(row);
    el.hidden = false;
  }
  function hideCard() { const el = $('arrivecard'); if (el) el.hidden = true; }
  function walkUrl(from, to) {
    return 'https://maps.apple.com/?saddr=' + from[1].toFixed(6) + ',' + from[0].toFixed(6) + '&daddr=' + to.lat.toFixed(6) + ',' + to.lon.toFixed(6) + '&dirflg=w';
  }
  // Appelé par arrive() (arrivée finale, pas une étape).
  function onArrive() {
    const km = trip.m / 1000;
    const min = Math.max(1, Math.round((Date.now() - trip.t0) / 60000));
    const parts = [];
    if (trip.t0 && km >= 1) {
      parts.push(fmtDist(trip.m) + ' en ' + fmtDuration(min * 60));
      if (km >= 5) {
        parts.push('moyenne ' + Math.round(km / (min / 60)) + ' km/h');
        const euros = Cost.litres({ total: trip.m, duration: min * 60 }) * Cost.price;
        parts.push('≈ ' + euros.toFixed(euros < 10 ? 1 : 0).replace('.', ',') + ' € de carburant');
      }
    }
    const dest = S.finalDest;
    const here = S.pos;
    const walkM = dest && here ? Geo.distance(here, [dest.lon, dest.lat]) : 0;
    const actions = [];
    let text = parts.length ? 'Trajet : ' + parts.join(' · ') : 'Vous êtes arrivé.';
    if (walkM > 80) {
      const mins = Math.max(1, Math.round((walkM * 1.3) / 80));
      const name = dest.label.split(',')[0];
      text = 'Encore ' + mins + ' min à pied jusqu\'à ' + name + '.\n' + text;
      actions.push(['🚶 Chemin à pied', () => window.open(walkUrl(here, dest), '_blank'), true]);
      setTimeout(() => speak('Il reste environ ' + mins + (mins > 1 ? ' minutes' : ' minute') + ' à pied jusqu\'à ' + name + '. Le chemin est à l\'écran.'), 2500);
    }
    actions.push(['OK', () => {}, !actions.length]);
    card(text, actions);
  }

  // ---------- 8. « où suis-je ? »
  async function whereAmI() {
    if (!S.pos) { speak('Je n\'ai pas encore votre position.'); return; }
    let road = '';
    if (S.mode === 'nav' && S.route) {
      const st = S.route.steps[stepIndexAt(S.d)];
      road = [st && st.ref, st && st.name].filter(Boolean)[0] || '';
    }
    let town = '';
    try {
      const j = await (await fetch('https://photon.komoot.io/reverse?lon=' + S.pos[0].toFixed(5) + '&lat=' + S.pos[1].toFixed(5) + '&lang=fr', { signal: AbortSignal.timeout(5000) })).json();
      const pr = (j.features && j.features[0] && j.features[0].properties) || {};
      town = pr.city || pr.town || pr.village || pr.county || '';
      if (!road) road = pr.street || '';
    } catch { /* sans réseau : la route suffit */ }
    let text = 'Vous êtes' + (road ? ' sur ' + road : '') + (town ? (road ? ', à ' : ' à ') + town : '') + '.';
    if (text === 'Vous êtes.') text = 'Je ne sais pas encore où nous sommes précisément.';
    if (S.mode === 'nav' && S.to) text += ' Arrivée vers ' + $('eta').innerText.trim().replace(':', ' heures ') + '.';
    speak(text, true);
  }

  let last = 0;
  function tick() {
    tripTick();
    curveTick();
    const now = performance.now();
    if (now - last > 5000) { last = now; meetingTick(); }
  }

  $('eta')?.addEventListener('click', shareEta);
  renderCarChip();
  return { tick, onArrive, hideCard, whereAmI, findCurves, rememberCar, findCar, renderCarChip, renderHabitChip, shareEta, rainAtArrival, onStart, habit, goHabit, findMeeting };
})();
