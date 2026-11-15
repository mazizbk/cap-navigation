'use strict';
/* Alertes sur le trajet + affichage sur l'écran de la voiture.
 * Chargé après app.js : utilise S, CONFIG, map, Geo, $, speak, fmtDist… définis là-bas.
 *
 * Deux sources d'alertes, sans clé ni compte :
 *  - événements en temps réel (accidents, obstacles, travaux, routes fermées) : open data Bison Futé, via server.js ;
 *  - zones de danger : radars fixes connus d'OpenStreetMap. Comme l'impose la loi française, on signale
 *    une zone (300 m en ville, 2 km sur route, 4 km sur autoroute), jamais l'emplacement exact.
 */

function routeBbox(pad) {
  let w = 180, s = 90, e = -180, n = -90;
  for (const c of S.route.coords) {
    if (c[0] < w) w = c[0];
    if (c[0] > e) e = c[0];
    if (c[1] < s) s = c[1];
    if (c[1] > n) n = c[1];
  }
  return [w - pad, s - pad, e + pad, n + pad];
}

// Lit un jeu d'alertes : d'abord en direct auprès de server.js (sur le PC), sinon dans le fichier data/<nom>.json
// publié avec l'application en ligne (rafraîchi toutes les 15 min). Renvoie null si aucun des deux ne répond.
async function alertData(name, pad) {
  const box = routeBbox(pad);
  try {
    const res = await fetch('api/' + name + '?bbox=' + box.map((v) => v.toFixed(4)).join(','), { signal: AbortSignal.timeout(40000) });
    const json = res.ok ? await res.json() : null;
    if (json && json.ok) return json[name];
  } catch { /* pas de serveur local */ }
  try {
    const res = await fetch('data/' + name + '.json', { signal: AbortSignal.timeout(20000), cache: 'no-cache' });
    const json = res.ok ? await res.json() : null;
    if (!json || !json.ok) return null;
    if (json.updated && Date.now() - json.updated > 6 * 3600 * 1000) return null; // données trop anciennes pour être fiables
    return json[name].filter((i) => i.lon >= box[0] && i.lon <= box[2] && i.lat >= box[1] && i.lat <= box[3]);
  } catch { return null; }
}

async function fetchIncidents() {
  const list = await alertData('incidents', 0.02);
  if (!list) throw new Error('Alertes trafic indisponibles');
  return list;
}

async function fetchCameras() {
  // 1) Liste officielle des radars fixes (data.gouv.fr).
  const official = await alertData('radars', 0.01);
  if (official) return official.map((r) => ({ id: r.id, lat: r.lat, lon: r.lon, tags: { maxspeed: r.limit } }));

  // 2) À défaut, OpenStreetMap, interrogé le long du tracé (échantillonné) plutôt que sur tout le rectangle.
  const R = S.route;
  const spacing = Math.max(150, R.total / 350);
  const pts = [];
  for (let d = 0; d <= R.total; d += spacing) {
    const p = Geo.pointAt(R.coords, R.cum, d);
    pts.push(p[1].toFixed(5), p[0].toFixed(5));
  }
  const last = R.coords[R.coords.length - 1];
  pts.push(last[1].toFixed(5), last[0].toFixed(5));
  const radius = Math.round(spacing / 2 + 50);
  const q = '[out:json][timeout:25];node["highway"="speed_camera"](around:' + radius + ',' + pts.join(',') + ');out body;';
  const res = await fetch(CONFIG.overpass, { method: 'POST', body: new URLSearchParams({ data: q }), signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error('Overpass ' + res.status);
  return (await res.json()).elements || [];
}

async function loadHazards() {
  const R = S.route;
  // Nouvel itinéraire : on efface les anciennes alertes. Simple rafraîchissement : on les garde le temps de charger.
  if (S.hazardsFor !== R) { S.hazards = []; clearHazardMarkers(); }
  let failed = 0; // nombre de sources qui n'ont pas répondu
  const [incidents, cameras] = await Promise.all([
    fetchIncidents().catch(() => { failed++; return []; }),
    fetchCameras().catch(() => { failed++; return []; }),
  ]);
  if (S.route !== R) return; // l'itinéraire a changé entre-temps
  const list = [];

  for (const inc of incidents) {
    const snap = Geo.snap(R.coords, R.cum, [inc.lon, inc.lat]);
    if (snap.dist > 60) continue;
    list.push({
      id: 'i' + inc.id, type: 'incident', along: snap.along, lon: inc.lon, lat: inc.lat,
      icon: inc.icon, title: inc.title, severe: inc.severe, detail: inc.detail,
      place: [inc.road, inc.town].filter(Boolean).join(' · '),
    });
  }

  for (const cam of cameras) {
    const snap = Geo.snap(R.coords, R.cum, [cam.lon, cam.lat]);
    if (snap.dist > 35) continue;
    const limit = parseInt(cam.tags && cam.tags.maxspeed, 10) || null;
    const len = limit >= 110 ? 4000 : limit >= 70 || limit === null ? 2000 : 300;
    // Le radar est quelque part dans la zone : on ne la centre pas dessus.
    const start = Math.max(0, snap.along - len * 0.8);
    list.push({ id: 'z' + cam.id, type: 'zone', along: start, end: start + len, limit, icon: '⚠️', title: 'Zone de danger' });
  }

  // Bouchons en direct repérés sur le trajet (voir traffic.js).
  for (const j of R.jams || []) {
    const len = j.to - j.from;
    const min = Math.round(j.delay / 60);
    const start = Geo.pointAt(R.coords, R.cum, j.from);
    list.push({
      id: 'j' + Math.round(j.from), type: 'incident', jam: true, along: j.from, lon: start[0], lat: start[1],
      icon: j.icon || '🚗', severe: j.state === 6,
      title: (j.label || (j.state === 6 ? 'Route bloquée' : j.state === 5 ? 'Bouchon' : 'Trafic dense')) + ' sur ' + fmtDist(len),
      say: lowerFirst(j.label || (j.state === 6 ? 'route bloquée' : j.state === 5 ? 'bouchon' : 'trafic dense')) + ' sur ' + fmtDistSpoken(len) +
        (min >= 1 ? ', environ ' + min + (min > 1 ? ' minutes' : ' minute') + ' de retard' : ''),
      place: min >= 1 ? '+' + min + ' min' : '',
    });
  }

  // Alertes ponctuelles du trafic en direct (accident, véhicule en panne, travaux… voir traffic.js).
  for (const p of R.points || []) {
    const at = Geo.pointAt(R.coords, R.cum, p.along);
    list.push({
      id: 't' + Math.round(p.along) + p.title, type: 'incident', along: p.along, lon: at[0], lat: at[1],
      icon: p.icon, title: p.title, place: p.road || '', detail: p.detail, severe: p.severe,
    });
  }

  list.sort((a, b) => a.along - b.along);
  S.hazards = list;
  S.hazardsFor = R;
  clearHazardMarkers();

  for (const h of list) {
    if (h.type !== 'incident' || h.jam) continue; // les bouchons sont dessinés sur le tracé, pas en pastille
    const el = document.createElement('div');
    el.className = 'incident' + (h.severe ? ' severe' : '');
    el.textContent = h.icon;
    const popup = new maplibregl.Popup({ offset: 18, closeButton: false })
      .setText([h.title, h.place, h.detail].filter(Boolean).join(' — '));
    S.hazardMarkers.push(new maplibregl.Marker({ element: el }).setLngLat([h.lon, h.lat]).setPopup(popup).addTo(map));
  }

  const nInc = list.filter((h) => h.type === 'incident' && !h.jam).length;
  const nZone = list.filter((h) => h.type === 'zone').length;
  const parts = [];
  if (nInc) parts.push(nInc + (nInc > 1 ? ' alertes trafic' : ' alerte trafic'));
  if (nZone) parts.push(nZone + (nZone > 1 ? ' zones de danger' : ' zone de danger'));
  let text = parts.length ? '⚠️ ' + parts.join(' · ') + ' sur le trajet' : 'Aucune alerte connue sur le trajet';
  if (failed === 2) text = 'Alertes indisponibles pour le moment';
  else if (failed) text += ' (une source ne répond pas)';
  $('summary-hazards').textContent = text;
}

function clearHazardMarkers() {
  for (const m of S.hazardMarkers) m.remove();
  S.hazardMarkers = [];
}

// Appelé pendant le guidage : affiche et annonce l'alerte qui concerne le conducteur maintenant.
// Renvoie { title, sub } si une alerte est affichée, sinon null.
function updateHazards() {
  let active = null;
  const warn = clamp(S.speed * 40, 500, 2000); // on prévient environ 40 s avant
  for (const h of S.hazards) {
    if (h.type === 'zone') {
      if (S.d >= h.along && S.d <= h.end) { active = h; break; }
    } else if (h.along - S.d <= warn && h.along - S.d > -60) { active = h; break; }
  }
  const box = $('alert');
  document.body.classList.toggle('has-alert', !!active);
  if (!active) { box.hidden = true; return null; }

  let title = active.title;
  let sub;
  let over = false;
  if (active.type === 'zone') {
    over = !!active.limit && S.speed * 3.6 > active.limit + 3;
    sub = active.limit ? 'Limite ' + active.limit + ' km/h' : 'Respectez la limitation';
    if (over) title = 'Ralentissez';
    if (!S.hazardDone[active.id]) {
      S.hazardDone[active.id] = true;
      speakAlert('Attention, zone de danger.' + (active.limit ? ' Limite ' + active.limit + ' kilomètres heure.' : ''));
    }
    if (over && performance.now() - S.overAt > 9000) {
      S.overAt = performance.now();
      speakAlert('Ralentissez. Limite ' + active.limit + '.');
    }
  } else {
    const dist = active.along - S.d;
    sub = (dist > 30 ? 'Dans ' + fmtDist(dist) : 'Ici') + (active.place ? ' · ' + active.place : '');
    if (!S.hazardDone[active.id]) {
      S.hazardDone[active.id] = true;
      speakAlert('Attention. Dans ' + fmtDistSpoken(dist) + ', ' + (active.say || lowerFirst(active.title)) + '.' +
        (active.severe ? ' Ralentissez et soyez prudent.' : ''));
    }
  }
  box.hidden = false;
  box.classList.toggle('over', over || !!active.severe);
  setHtml('alert-icon', active.icon);
  setHtml('alert-title', escapeHtml(title));
  setHtml('alert-sub', escapeHtml(sub));
  return { title, sub };
}

// ---------------------------------------------------------------- écran de la voiture (Bluetooth)
// Une voiture ne reçoit par Bluetooth que du son et le « titre en cours de lecture ».
// On s'en sert : la voix passe par les haut-parleurs, et la consigne s'affiche à la place du titre du morceau.
// Pour cela il faut une lecture audio active : on joue un silence en boucle pendant le guidage.
const car = { audio: null, last: '' };

function silentWavUrl() {
  const n = 8000; // 1 s, 8 kHz, mono, 8 bits
  const buf = new ArrayBuffer(44 + n);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n, true); str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  str(36, 'data'); v.setUint32(40, n, true);
  new Uint8Array(buf, 44).fill(128);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

function carStart() {
  if (!S.carScreen) return;
  if (!car.audio) {
    car.audio = new Audio(silentWavUrl());
    car.audio.loop = true;
  }
  car.audio.play().catch(() => {});
  if ('mediaSession' in navigator) {
    for (const action of ['play', 'pause']) {
      try { navigator.mediaSession.setActionHandler(action, () => car.audio.play().catch(() => {})); } catch { /* non géré */ }
    }
  }
}

function carShow(title, sub) {
  if (!S.carScreen || !('mediaSession' in navigator) || !window.MediaMetadata) return;
  const key = title + '|' + sub;
  if (key === car.last) return;
  car.last = key;
  navigator.mediaSession.metadata = new MediaMetadata({
    title, artist: sub || '', album: 'Cap navigation',
    artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
  });
}

function carStop() {
  if (car.audio) car.audio.pause();
  car.last = '';
  if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
}

$('car-screen').checked = S.carScreen;
$('car-screen').addEventListener('change', (e) => {
  S.carScreen = e.target.checked;
  try { localStorage.setItem('carScreen', S.carScreen ? '1' : '0'); } catch { /* stockage indisponible */ }
});
