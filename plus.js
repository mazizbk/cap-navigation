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
        '&hourly=precipitation_probability,precipitation&forecast_days=2&timezone=auto';
      const j = await (await fetch(url, { signal: AbortSignal.timeout(6000) })).json();
      const h = j.hourly;
      const key = at.getFullYear() + '-' + String(at.getMonth() + 1).padStart(2, '0') + '-' + String(at.getDate()).padStart(2, '0') + 'T' + String(at.getHours()).padStart(2, '0') + ':00';
      const k = h.time.indexOf(key);
      if (k < 0) return '';
      const prob = h.precipitation_probability[k] || 0;
      const mm = h.precipitation[k] || 0;
      if (prob >= 60 || mm >= 0.5) rainText = mm >= 3 ? 'Forte pluie prévue à l\'arrivée.' : 'Pluie prévue à l\'arrivée.';
    } catch { /* météo indisponible : on n'en parle pas */ }
    const el = $('summary-rain');
    if (el && R === S.route) { el.textContent = rainText ? '🌧 ' + rainText : ''; el.hidden = !rainText; }
    return rainText;
  }

  // Au départ : la pluie est dite après le briefing, seulement si elle est probable.
  async function onStart() {
    const R = S.route;
    const t = await rainAtArrival(R);
    if (!t || S.route !== R) return;
    setTimeout(() => { if (S.mode === 'nav' && !voiceBusy()) speak(t); }, 9000);
  }

  $('eta')?.addEventListener('click', shareEta);
  renderCarChip();
  return { tick: curveTick, findCurves, rememberCar, findCar, renderCarChip, shareEta, rainAtArrival, onStart };
})();
