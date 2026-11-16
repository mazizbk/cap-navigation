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
    const ahead = Math.min(450, Math.max(150, Math.round((v * 9) / 50) * 50));
    const phrase = (k, m) => 'Virage serré à ' + k.side + ' dans ' + roundSpoken(m) + '.';
    // Virage à moins de 900 m : sa phrase est préparée dans la voix humaine (dite à l'heure, sans attendre le réseau).
    const soon = curves.find((k) => k.at > S.d && k.at - S.d < 900 && !k.pre);
    if (soon && typeof GVoice !== 'undefined' && GVoice.on()) {
      soon.pre = true;
      GVoice.prefetch([ahead - 50, ahead, ahead + 50].filter((m) => m >= 150 && m <= 450).map((m) => sayable(phrase(soon, m))));
    }
    const c = curves.find((k) => k.at > S.d + 40 && k.at - S.d < ahead && !said.has(k.at));
    if (!c) return;
    const safe = Math.sqrt(2.5 * c.radius);  // vitesse confortable dans ce virage (accélération latérale 2,5 m/s²)
    if (v < safe * 1.15 + 2) { said.add(c.at); return; }
    // Une consigne de direction tout près passe avant.
    const i = stepIndexAt(S.d);
    const next = R.steps[i + 1];
    if (voiceBusy() || (next && next.start - S.d < 300 && next.start > c.at - 100)) return;
    said.add(c.at);
    const dist = c.at - S.d;
    speak(phrase(c, dist > ahead - 40 ? ahead : dist), false, []);
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
  // À l'arrivée : la durée réelle du trajet est ajoutée au dernier trajet noté (pour comparer avec « d'habitude »).
  function saveDuration(km, eur) {
    if (S.sim || !trip.t0) return;
    const log = readLog();
    const lastT = log[log.length - 1];
    const d = S.finalDest || S.to;
    if (!lastT || !d || Geo.distance([lastT.lon, lastT.lat], [d.lon, d.lat]) > 300 || lastT.t < trip.t0 - 120000) return;
    lastT.dur = Math.round((Date.now() - trip.t0) / 60000);
    if (km) { lastT.km = Math.round(km * 10) / 10; lastT.eur = Math.round((eur || 0) * 100) / 100; }
    try { localStorage.setItem('tripLog', JSON.stringify(log)); } catch { /* stockage plein */ }
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
    // Durée habituelle : la médiane des trajets complets vers cet endroit.
    const durs = same.filter((t) => t.dur && Geo.distance([best.lon, best.lat], [t.lon, t.lat]) < 150).map((t) => t.dur).sort((x, y) => x - y);
    const usual = durs.length >= 2 ? durs[Math.floor(durs.length / 2)] : 0;
    return { place: { label: best.label, lon: best.lon, lat: best.lat }, name, usual };
  }
  // Phrase du majordome : « On va au travail ? 24 minutes ce matin, 8 de plus que d'habitude. »
  async function habitPhrase(h) {
    let s = 'On va ' + h.name + ', comme d\'habitude ?';
    if (!S.pos) return s;
    try {
      const R = await Promise.race([bestRoute({ lon: S.pos[0], lat: S.pos[1] }, h.place, true), new Promise((r) => setTimeout(() => r(null), 5000))]);
      if (!R) return s;
      const min = Math.round((R.viaTomTom ? R.duration : R.duration + (R.jamDelay || 0)) / 60);
      const more = h.usual ? min - h.usual : 0;
      const said = min >= 60 ? Math.floor(min / 60) + (min >= 120 ? ' heures' : ' heure') + (min % 60 ? ' ' + (min % 60) : '') : min + ' minutes';
      s = 'On va ' + h.name + ' ? ' + said + (more >= 5 ? ', ' + more + ' de plus que d\'habitude.' : h.usual ? ', comme d\'habitude.' : '.');
    } catch { /* sans réseau : la question simple */ }
    return s;
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
    if (!S.resumeTo) { trip.t0 = Date.now(); trip.m = 0; trip.lastPos = null; drive.hard = 0; drive.v = []; }
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
  const trip = { t0: 0, m: 0, lastPos: null };

  // ---------- conduite douce : freinages et accélérations brusques (d'après la vitesse GPS)
  const drive = { v: [], hard: 0, lastHard: 0 };
  function smoothTick() {
    if (S.sim || S.mode !== 'nav') return;
    const now = performance.now();
    const v = S.speed || 0;
    drive.v.push([now, v]);
    while (drive.v.length > 1 && now - drive.v[0][0] > 2500) drive.v.shift();
    const [t0, v0] = drive.v[0];
    const dt = (now - t0) / 1000;
    if (dt < 1.5) return;
    const a = (v - v0) / dt;                                // m/s²
    const rough = Math.abs(a) > 3.5 && Math.abs(a) < 9;     // au-delà de 9 : saut de GPS, ignoré
    if (rough && v0 + v > 8 && now - drive.lastHard > 8000) { drive.hard++; drive.lastHard = now; }
  }
  function calmScore(km) {
    const per10 = (drive.hard / Math.max(km, 3)) * 10;
    return Math.max(1, Math.min(10, Math.round(10 - per10 * 2)));
  }

  // ---------- bilan du mois (trajets réels notés à l'arrivée)
  function monthStats() {
    const now = new Date();
    const list = readLog().filter((t) => t.km && new Date(t.t).getMonth() === now.getMonth() && new Date(t.t).getFullYear() === now.getFullYear());
    const km = list.reduce((s, t) => s + t.km, 0);
    const min = list.reduce((s, t) => s + (t.dur || 0), 0);
    const eur = list.reduce((s, t) => s + (t.eur || 0), 0);
    return { n: list.length, km, min, eur };
  }
  function monthLine() {
    const m = monthStats();
    if (m.n < 2) return '';
    return 'Ce mois : ' + Math.round(m.km) + ' km · ' + fmtDuration(m.min * 60) + ' au volant' + (m.eur >= 1 ? ' · ≈ ' + Math.round(m.eur) + ' €' : '');
  }
  function monthSay() {
    const m = monthStats();
    if (!m.n) { speak('Pas encore de trajet noté ce mois-ci.'); return; }
    const h = Math.floor(m.min / 60), mn = m.min % 60;
    const time = (h ? h + (h > 1 ? ' heures ' : ' heure ') : '') + (mn ? mn + ' minutes' : '');
    speak('Ce mois-ci : ' + m.n + (m.n > 1 ? ' trajets, ' : ' trajet, ') + Math.round(m.km) + ' kilomètres, ' + (time.trim() || 'moins d’une minute') + ' au volant' + (m.eur >= 1 ? ', environ ' + Math.round(m.eur) + ' euros de carburant.' : '.'), true);
  }

  // ---------- heure de départ pour un rendez-vous (trafic compris, + 5 min pour se garer)
  async function leaveLine(ev) {
    if (!S.pos || !ev || !ev.lieu) return '';
    const job = (async () => {
      const g = (await geocode(ev.lieu))[0];
      if (!g) return '';
      const R = await bestRoute({ lon: S.pos[0], lat: S.pos[1] }, g, true);
      const min = Math.round((R.viaTomTom ? R.duration : R.duration + (R.jamDelay || 0)) / 60) + 5;
      const leave = new Date(new Date(ev.debut).getTime() - min * 60000);
      leave.setMinutes(Math.floor(leave.getMinutes() / 5) * 5);
      const late = (Date.now() - leave.getTime()) / 60000;
      if (late > 8) return 'Il faudrait déjà être parti : environ ' + Math.round(late) + ' minutes de retard.';
      if (late > -5) return 'Il faut partir maintenant.';
      return 'Il faut partir vers ' + leave.getHours() + ' heures' + (leave.getMinutes() ? ' ' + leave.getMinutes() : '') + '.';
    })().catch(() => '');
    return (await Promise.race([job, new Promise((r) => setTimeout(() => r(''), 6000))])) || '';
  }
  // Distance parcourue : somme des déplacements entre deux positions. Appelé à chaque image et à chaque position GPS
  // (celles-ci continuent écran verrouillé), donc le compte reste juste même téléphone en veille.
  function tripTick(raw) {
    const pos = raw || S.pos;
    if (S.mode !== 'nav' || !pos) return;
    if (trip.lastPos) {
      const d = Geo.distance(trip.lastPos, pos);
      if (d < 3000) trip.m += d;               // au-delà : saut de GPS, ignoré
    }
    trip.lastPos = pos.slice();
    if (raw) smoothTick();
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
    const euros = trip.t0 && km >= 1 ? Cost.litres({ total: trip.m, duration: min * 60 }) * Cost.price : 0;
    saveDuration(km >= 1 ? km : 0, euros);
    const parts = [];
    if (trip.t0 && km >= 1) {
      parts.push(fmtDist(trip.m) + ' en ' + fmtDuration(min * 60));
      if (km >= 5) {
        parts.push('moyenne ' + Math.round(km / (min / 60)) + ' km/h');
        parts.push('≈ ' + euros.toFixed(euros < 10 ? 1 : 0).replace('.', ',') + ' € de carburant');
      }
    }
    const extra = [];
    if (trip.t0 && km >= 3 && !S.sim) extra.push('Conduite calme : ' + calmScore(km) + '/10' + (drive.hard ? ' (' + drive.hard + (drive.hard > 1 ? ' à-coups)' : ' à-coup)') : ''));
    const month = monthLine();
    if (month) extra.push(month);
    const dest = S.finalDest;
    const here = S.pos;
    const walkM = dest && here ? Geo.distance(here, [dest.lon, dest.lat]) : 0;
    const actions = [];
    let text = (parts.length ? 'Trajet : ' + parts.join(' · ') : 'Vous êtes arrivé.') + (extra.length ? '\n' + extra.join('\n') : '');
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

  // ---------- 9. voiture garée quand l'iPhone se déconnecte du Bluetooth de la voiture
  // Lancé par l'automatisation Raccourcis « Bluetooth déconnecté » → capnav://garee (lat/lon facultatifs).
  async function parkHere(lat, lon, t, quiet) {
    const when = isFinite(t) ? t : Date.now();
    const prev = readCar();
    if (prev && Math.abs((prev.t || 0) - when) < 120000) return true; // déjà noté (raccourci + appli)
    let pos = (isFinite(lat) && isFinite(lon)) ? [lon, lat] : null;
    if (!pos && navigator.geolocation) {
      pos = await new Promise((ok) => navigator.geolocation.getCurrentPosition(
        (p) => ok(p.coords.accuracy < 150 ? [p.coords.longitude, p.coords.latitude] : null),
        () => ok(null), { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }));
    }
    if (!pos) pos = S.pos;
    if (!pos) { if (S.mode !== 'nav' && !quiet) speak('Je n’ai pas pu noter où est garée la voiture.'); return false; }
    let label = '';
    try {
      const j = await (await fetch('https://photon.komoot.io/reverse?lon=' + pos[0].toFixed(5) + '&lat=' + pos[1].toFixed(5) + '&lang=fr', { signal: AbortSignal.timeout(4000) })).json();
      const pr = (j.features && j.features[0] && j.features[0].properties) || {};
      label = pr.street || pr.name || '';
    } catch { /* sans réseau : la position suffit */ }
    try { localStorage.setItem('carParked', JSON.stringify({ lon: pos[0], lat: pos[1], t: when, label })); } catch { /* stockage indisponible */ }
    renderCarChip();
    if (S.mode !== 'nav' && !quiet) speak('Voiture garée' + (label ? ' ' + label : '') + ', c’est noté.');
    return true;
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
  return { trackFix: (raw) => tripTick(raw), habitPhrase, tick, onArrive, hideCard, whereAmI, findCurves, rememberCar, parkHere, findCar, renderCarChip, renderHabitChip, shareEta, rainAtArrival, onStart, habit, goHabit, findMeeting, leaveLine, monthSay, monthStats, calmScore, _drive: drive };
})();
