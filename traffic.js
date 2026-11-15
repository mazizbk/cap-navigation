'use strict';
/* Trafic en direct et choix du trajet le plus rapide.
 * Chargé après app.js et hazards.js : utilise S, CONFIG, map, Geo, fetchRoutes, loadHazards… définis là-bas.
 *
 * Deux sources, par ordre de préférence :
 *  1. TomTom (si une clé est fournie dans config.js) : bouchons, accidents, travaux et routes fermées partout,
 *     autoroutes et Paris compris. Gratuit jusqu'à 2 500 demandes par mois : on en fait le moins possible.
 *  2. Nantes Métropole (open data, sans clé) : l'état de ~890 tronçons de l'agglomération, chaque minute.
 * Sans l'une ni l'autre sur un trajet, l'application dit « hors bouchons » au lieu de faire semblant.
 */

const JAM_COLOR = { 4: '#ffb020', 5: '#ff5a4d', 6: '#a3001e' }; // dense, saturé, bloqué

// ================================================================= TomTom
const TT = {
  url: 'https://api.tomtom.com/traffic/services/5/incidentDetails',
  fields: '{incidents{type,geometry{type,coordinates},properties{id,iconCategory,magnitudeOfDelay,events{description},from,to,length,delay,roadNumbers}}}',
  monthlyCap: 2300,   // on s'arrête avant les 2 500 demandes gratuites du mois
  chunk: 80000,       // longueur de trajet couverte par une demande (m)
  maxArea: 9000,      // la zone d'une demande ne doit pas dépasser 10 000 km²
  horizon: 100000,    // pendant le guidage, on ne relit que les 100 prochains km
  every: 10 * 60000,  // … toutes les 10 minutes
};
// Catégories TomTom → ce qu'on affiche.
const TT_KIND = {
  1: ['🚨', 'Accident'], 2: ['🌫️', 'Brouillard'], 3: ['⚠️', 'Conditions dangereuses'], 4: ['🌧️', 'Forte pluie'],
  5: ['❄️', 'Verglas'], 6: ['🚗', 'Bouchon'], 7: ['⛔', 'Voie fermée'], 8: ['⛔', 'Route fermée'],
  9: ['🚧', 'Travaux'], 10: ['💨', 'Vent fort'], 11: ['🌊', 'Inondation'], 14: ['⚠️', 'Véhicule en panne'],
};

function ttKey() { return (window.CAP_CONFIG && window.CAP_CONFIG.tomtomKey) || ''; }

// Compteur des demandes du mois, gardé sur l'appareil.
function ttUsage(add) {
  const month = new Date().toISOString().slice(0, 7);
  let u = { month, n: 0 };
  try { const saved = JSON.parse(localStorage.getItem('ttUsage') || 'null'); if (saved && saved.month === month) u = saved; } catch { /* stockage indisponible */ }
  if (add) { u.n += add; try { localStorage.setItem('ttUsage', JSON.stringify(u)); } catch { /* idem */ } }
  return u.n;
}

function bboxOf(coords) {
  let w = 180, s = 90, e = -180, n = -90;
  for (const c of coords) {
    if (c[0] < w) w = c[0];
    if (c[0] > e) e = c[0];
    if (c[1] < s) s = c[1];
    if (c[1] > n) n = c[1];
  }
  const pad = 0.003; // ~300 m de marge
  return [w - pad, s - pad, e + pad, n + pad];
}
const bboxAreaKm2 = (b) => (b[2] - b[0]) * 111.32 * Math.cos(((b[1] + b[3]) / 2) * Math.PI / 180) * (b[3] - b[1]) * 110.57;

// Découpe la portion [d0, d1] du trajet en zones assez petites pour TomTom.
function ttBoxes(R, d0, d1) {
  const boxes = [];
  const add = (a, b) => {
    const box = bboxOf(Geo.slice(R.coords, R.cum, a, b));
    if (bboxAreaKm2(box) > TT.maxArea && b - a > 5000) { add(a, (a + b) / 2); add((a + b) / 2, b); } else boxes.push(box);
  };
  for (let a = d0; a < d1; a += TT.chunk) add(a, Math.min(d1, a + TT.chunk));
  return boxes;
}

// Demande à TomTom les incidents de la portion [d0, d1] et les place sur le trajet.
async function tomtomOnRoute(R, d0, d1) {
  const boxes = ttBoxes(R, d0, d1);
  if (ttUsage(0) + boxes.length > TT.monthlyCap) throw new Error('quota TomTom du mois atteint');
  const seen = new Map();
  for (const box of boxes) {
    const params = new URLSearchParams({
      key: ttKey(), bbox: box.map((v) => v.toFixed(5)).join(','), fields: TT.fields, language: 'fr-FR', timeValidityFilter: 'present',
    });
    ttUsage(1);
    const res = await fetch(TT.url + '?' + params, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error('TomTom ' + res.status);
    for (const inc of (await res.json()).incidents || []) {
      const p = inc.properties || {};
      seen.set(p.id || JSON.stringify(inc.geometry).slice(0, 80), inc);
    }
  }
  return placeTomTom(R, [...seen.values()], d0, d1);
}

// Garde les incidents situés sur notre trajet, dans notre sens, et les range en « ralentissements » (portions
// colorées, avec un retard) et en « alertes ponctuelles ».
function placeTomTom(R, incidents, d0, d1) {
  // On ne compare qu'avec la portion de trajet concernée (plus rapide sur un long trajet).
  let i0 = 0;
  while (i0 + 1 < R.cum.length && R.cum[i0 + 1] < d0 - 500) i0++;
  let i1 = i0;
  while (i1 + 1 < R.cum.length && R.cum[i1] < d1 + 500) i1++;
  const coords = R.coords.slice(i0, i1 + 1);
  const cum = R.cum.slice(i0, i1 + 1);
  const jams = [];
  const points = [];
  for (const inc of incidents) {
    const g = inc.geometry;
    const p = inc.properties || {};
    if (!g || !g.coordinates) continue;
    const cat = p.iconCategory;
    const [icon, name] = TT_KIND[cat] || ['⚠️', 'Incident'];
    const desc = (p.events && p.events[0] && p.events[0].description) || '';
    const road = (p.roadNumbers && p.roadNumbers[0]) || '';
    if (g.type === 'LineString' && g.coordinates.length >= 2) {
      const a = Geo.snap(coords, cum, g.coordinates[0]);
      const b = Geo.snap(coords, cum, g.coordinates[g.coordinates.length - 1]);
      if (a.dist > 40 || b.dist > 40 || b.along - a.along < 20) continue; // autre route, ou sens opposé
      const mid = Geo.snap(coords, cum, g.coordinates[g.coordinates.length >> 1]);
      if (mid.dist > 80) continue; // ne fait que croiser notre trajet aux deux bouts
      const delay = cat === 8 ? 900 : p.delay || 0; // route fermée : forte pénalité pour chercher un autre trajet
      if (cat === 6 || cat === 8 || delay >= 30) {
        const state = cat === 8 || p.magnitudeOfDelay === 4 ? 6 : p.magnitudeOfDelay >= 3 ? 6 : p.magnitudeOfDelay === 2 ? 5 : 4;
        jams.push({ from: a.along, to: b.along, state, delay, label: cat === 6 ? (state === 4 ? 'Trafic dense' : 'Bouchon') : name, icon, road });
        continue;
      }
      points.push({ along: a.along, icon, title: name, detail: desc, road, severe: cat === 1 });
    } else if (g.type === 'Point') {
      const a = Geo.snap(coords, cum, g.coordinates);
      if (a.dist <= 25) points.push({ along: a.along, icon, title: name, detail: desc, road, severe: cat === 1 || cat === 8 });
    }
  }
  jams.sort((x, y) => x.from - y.from);
  return { jams, points };
}

// ================================================================= Nantes Métropole
const NANTES = { w: -1.80, s: 47.10, e: -1.35, n: 47.36 };
let jamCache = { at: 0, segs: null };

function inNantes(R) {
  return R.coords.some((c) => c[0] >= NANTES.w && c[0] <= NANTES.e && c[1] >= NANTES.s && c[1] <= NANTES.n);
}

// Tous les tronçons ralentis de l'agglomération (gardés 2 minutes en mémoire).
async function fetchJamSegments() {
  if (jamCache.segs && Date.now() - jamCache.at < 120000) return jamCache.segs;
  const segs = [];
  for (let offset = 0; offset < 400; offset += 100) {
    const url = CONFIG.nantes + '?limit=100&offset=' + offset +
      '&select=' + encodeURIComponent('cha_lib,cha_long,mf1_vit,tc1_temps,couleur_tp,geo_shape') +
      '&where=' + encodeURIComponent('couleur_tp in ("4","5","6")');
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error('trafic ' + res.status);
    const json = await res.json();
    segs.push(...(json.results || []));
    if (!json.results || json.results.length < 100) break;
  }
  jamCache = { at: Date.now(), segs };
  return segs;
}

// Repère sur un itinéraire les tronçons ralentis qu'il emprunte, dans le bon sens, et estime le retard de chacun.
function jamsOnRoute(R, segs) {
  let i0 = -1;
  let i1 = -1;
  const pad = 0.01;
  R.coords.forEach((c, i) => {
    if (c[0] >= NANTES.w - pad && c[0] <= NANTES.e + pad && c[1] >= NANTES.s - pad && c[1] <= NANTES.n + pad) {
      if (i0 < 0) i0 = i;
      i1 = i;
    }
  });
  if (i0 < 0 || i1 - i0 < 1) return [];
  const coords = R.coords.slice(i0, i1 + 1);
  const cum = R.cum.slice(i0, i1 + 1);
  const found = [];
  for (const s of segs) {
    const g = s.geo_shape && s.geo_shape.geometry;
    if (!g || g.type !== 'LineString' || g.coordinates.length < 2 || !s.cha_long) continue;
    const a = Geo.snap(coords, cum, g.coordinates[0]);
    if (a.dist > 30) continue;
    const b = Geo.snap(coords, cum, g.coordinates[g.coordinates.length - 1]);
    if (b.dist > 30) continue;
    const len = b.along - a.along; // positif seulement si le tronçon est parcouru dans notre sens
    if (len < 30 || len < s.cha_long * 0.4 || len > s.cha_long * 1.8 + 60) continue;
    // Temps normal sur cette portion, d'après l'itinéraire, pour en déduire le retard.
    let k = 0;
    while (k + 1 < R.steps.length && R.steps[k + 1].start <= a.along) k++;
    const st = R.steps[k];
    const free = st.duration > 0 ? st.distance / st.duration : 13;
    const time = s.tc1_temps > 0 ? s.tc1_temps * (len / s.cha_long) : len / Math.max(1.4, (s.mf1_vit || 5) / 3.6);
    found.push({ from: a.along, to: b.along, state: Number(s.couleur_tp), delay: Math.max(0, time - len / free) });
  }
  found.sort((x, y) => x.from - y.from);
  const merged = [];
  for (const j of found) {
    const last = merged[merged.length - 1];
    if (last && j.from - last.to < 200) { // tronçons qui se suivent : un seul bouchon
      last.to = Math.max(last.to, j.to);
      last.state = Math.max(last.state, j.state);
      last.delay += j.delay;
    } else merged.push({ ...j });
  }
  return merged.filter((j) => j.delay >= 30 || j.state >= 5);
}

// ================================================================= commun
// Renseigne le trafic d'un itinéraire : ralentissements (R.jams), alertes ponctuelles (R.points), retard total.
// `d0`/`d1` limitent la lecture TomTom à une portion (pendant le guidage) ; ce qui est au-delà est conservé.
async function applyTraffic(R, d0, d1) {
  R.jams = R.jams || [];
  R.points = R.points || [];
  R.trafficKnown = false;
  R.trafficSource = '';
  if (ttKey()) {
    try {
      const from = d0 || 0;
      const to = d1 || R.total;
      const tt = await tomtomOnRoute(R, from, to);
      R.jams = R.jams.filter((j) => j.from >= to).concat(tt.jams).sort((x, y) => x.from - y.from);
      R.points = R.points.filter((p) => p.along >= to).concat(tt.points);
      R.trafficKnown = true;
      R.trafficSource = 'TomTom';
      R.ttAt = Date.now();
    } catch (e) {
      R.trafficNote = e.message;
      diag('trafic TomTom indisponible : ' + e.message);
    }
  }
  if (!R.trafficKnown && inNantes(R)) {
    try {
      R.jams = jamsOnRoute(R, await fetchJamSegments());
      R.points = [];
      R.trafficKnown = true;
      R.trafficSource = 'Nantes Métropole';
    } catch { /* données indisponibles */ }
  }
  R.jamDelay = R.jams.reduce((t, j) => t + j.delay, 0);
  R.cost = R.duration + R.jamDelay;
}

// Calcule les itinéraires possibles et retient le plus rapide compte tenu du trafic connu.
// `near` : pendant le guidage, on ne regarde que les 100 prochains km (économie de demandes).
async function bestRoute(from, to, near) {
  const routes = await fetchRoutes(from, to);
  const span = (R) => (near ? Math.min(R.total, TT.horizon) : R.total);
  await applyTraffic(routes[0], 0, span(routes[0]));
  // Les variantes ne sont examinées que si l'itinéraire habituel perd au moins 3 minutes.
  for (const R of routes.slice(1)) {
    if (routes[0].jamDelay >= 180) await applyTraffic(R, 0, span(R));
    else { R.jams = []; R.points = []; R.jamDelay = 0; R.cost = R.duration; }
  }
  // Une variante n'est retenue que si elle fait gagner au moins une minute.
  const best = routes.reduce((a, b) => (b.cost < a.cost - 60 ? b : a), routes[0]);
  best.saved = best !== routes[0] ? routes[0].cost - best.cost : 0;
  best.choices = routes.length;
  return best;
}

// Retard dû aux ralentissements encore devant nous.
function jamDelayAhead() {
  const R = S.route;
  if (!R || !R.jams) return 0;
  let total = 0;
  for (const j of R.jams) {
    if (j.to <= S.d) continue;
    total += j.delay * (j.from >= S.d ? 1 : (j.to - S.d) / (j.to - j.from));
  }
  return total;
}

// Colore en orange / rouge les portions ralenties du trajet.
function drawJams() {
  const src = map.getSource('jams');
  if (!src) return;
  const R = S.route;
  src.setData({
    type: 'FeatureCollection',
    features: (R && R.jams ? R.jams : []).map((j) => ({
      type: 'Feature',
      properties: { color: JAM_COLOR[j.state] || JAM_COLOR[4] },
      geometry: { type: 'LineString', coordinates: Geo.slice(R.coords, R.cum, j.from, j.to) },
    })),
  });
}

// Phrase affichée avant le départ.
function trafficSummary() {
  const R = S.route;
  if (!R) return '';
  if (!R.trafficKnown) {
    if (ttKey()) return 'Trafic TomTom indisponible' + (R.trafficNote ? ' (' + R.trafficNote + ')' : '');
    return inNantes(R) ? 'Bouchons de Nantes : données indisponibles pour le moment' : '';
  }
  const where = R.trafficSource === 'TomTom' ? '' : ' à Nantes';
  let text = R.jams.length
    ? '🚗 ' + R.jams.length + (R.jams.length > 1 ? ' ralentissements' : ' ralentissement') + where + ' · +' + Math.max(1, Math.round(R.jamDelay / 60)) + ' min'
    : 'Trafic fluide sur votre trajet' + (where ? ' dans Nantes' : '');
  if (R.saved >= 60) text += ' · trajet le plus rapide retenu (' + Math.round(R.saved / 60) + ' min de gagnées)';
  return text + ' · source ' + R.trafficSource;
}

// Pendant le guidage : on relit le trafic (toutes les 3 min pour Nantes, toutes les 10 min et sur les 100 prochains km
// pour TomTom) ; si un autre trajet fait gagner au moins 3 minutes, on y bascule en le disant.
async function refreshTraffic() {
  const R = S.route;
  if (!R) return;
  const useTomTom = !!ttKey();
  if (!useTomTom || Date.now() - (R.ttAt || 0) > TT.every) {
    await applyTraffic(R, S.d, Math.min(R.total, S.d + TT.horizon));
    if (S.route !== R) return;
    drawJams();
  }
  loadHazards(); // remet à jour la liste des alertes (dont les ralentissements)
  if (S.mode !== 'nav' || S.rerouting || !S.pos || jamDelayAhead() < 180) return;
  try {
    const alt = await bestRoute({ lon: S.pos[0], lat: S.pos[1] }, S.to, true);
    if (S.route !== R || S.mode !== 'nav' || S.rerouting) return;
    const i = stepIndexAt(S.d);
    const st = R.steps[i];
    const frac = st.distance > 0 ? clamp((S.d - st.start) / st.distance, 0, 1) : 1;
    const current = R.duration - (st.tStart + st.duration * frac) + jamDelayAhead();
    const gain = current - alt.cost;
    if (gain < 180) return;
    diag('trajet plus rapide : ' + Math.round(gain / 60) + ' min gagnées');
    useRoute(alt);
    speak('Bouchon devant. Je passe par un trajet plus rapide, ' + Math.round(gain / 60) + ' minutes de moins.', true);
  } catch { /* pas de réseau : on garde le trajet actuel */ }
}

// Remplace l'itinéraire suivi pendant le guidage (erreur de route ou trajet plus rapide).
function useRoute(R) {
  S.route = R;
  S.d = 0;
  S.spoken = {};
  S.manKey = '';
  S.offCount = 0;
  S.wrongCount = 0;
  S.gps = null;
  S.hazardDone = {};
  S.lastStep = undefined;
  S.navT0 = performance.now();
  S.planAtStart = R.duration;
  drawRoute();
  streetReset();
  loadHazards();
}
