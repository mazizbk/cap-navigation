'use strict';
/* Bouchons en direct et choix du trajet le plus rapide.
 * Chargé après app.js et hazards.js : utilise S, CONFIG, map, Geo, fetchRoutes, loadHazards… définis là-bas.
 *
 * Source : Nantes Métropole (open data, sans clé) publie chaque minute l'état de ~890 tronçons de l'agglomération :
 * fluide, dense, saturé ou bloqué, avec la vitesse et le temps de parcours mesurés.
 * Ailleurs, aucune donnée de bouchons n'est disponible sans clé : l'application le dit au lieu de faire semblant.
 */

const NANTES = { w: -1.80, s: 47.10, e: -1.35, n: 47.36 };
const JAM_COLOR = { 4: '#ffb020', 5: '#ff5a4d', 6: '#a3001e' }; // dense, saturé, bloqué
const JAM_NAME = { 4: 'trafic dense', 5: 'bouchon', 6: 'route bloquée' };
let jamCache = { at: 0, segs: null };

// Le trajet passe-t-il par l'agglomération de Nantes ?
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

function applyJams(R, segs) {
  R.trafficKnown = segs !== null && inNantes(R);
  R.jams = segs ? jamsOnRoute(R, segs) : [];
  R.jamDelay = R.jams.reduce((t, j) => t + j.delay, 0);
  R.cost = R.duration + R.jamDelay;
}

// Calcule les itinéraires possibles et retient le plus rapide compte tenu des bouchons connus.
async function bestRoute(from, to) {
  const routes = await fetchRoutes(from, to);
  let segs = [];
  if (routes.some(inNantes)) {
    try { segs = await fetchJamSegments(); } catch { segs = null; } // données indisponibles : on le saura (trafficKnown)
  }
  for (const R of routes) applyJams(R, segs);
  // Une variante n'est retenue que si elle fait gagner au moins une minute sur l'itinéraire habituel.
  const best = routes.reduce((a, b) => (b.cost < a.cost - 60 ? b : a), routes[0]);
  best.saved = best !== routes[0] ? routes[0].cost - best.cost : 0;
  best.choices = routes.length;
  return best;
}

// Retard dû aux bouchons encore devant nous.
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
  if (!inNantes(R)) return '';
  if (!R.trafficKnown) return 'Bouchons de Nantes : données indisponibles pour le moment';
  let text = R.jams.length
    ? '🚗 ' + R.jams.length + (R.jams.length > 1 ? ' ralentissements' : ' ralentissement') + ' à Nantes · +' + Math.max(1, Math.round(R.jamDelay / 60)) + ' min'
    : 'Trafic fluide sur votre trajet dans Nantes';
  if (R.saved >= 60) text += ' · trajet le plus rapide retenu (' + Math.round(R.saved / 60) + ' min de gagnées)';
  return text;
}

// Pendant le guidage, toutes les 3 minutes : on relit les bouchons, et si un autre trajet fait gagner
// au moins 3 minutes, on y bascule en le disant.
async function refreshTraffic() {
  const R = S.route;
  if (!R) return;
  if (inNantes(R)) {
    try {
      jamCache.at = 0;
      const segs = await fetchJamSegments();
      if (S.route !== R) return;
      applyJams(R, segs);
      drawJams();
    } catch { /* on garde les dernières données */ }
  }
  loadHazards(); // remet à jour la liste des alertes (dont les bouchons)
  if (S.mode !== 'nav' || S.rerouting || !S.pos || jamDelayAhead() < 180) return;
  try {
    const alt = await bestRoute({ lon: S.pos[0], lat: S.pos[1] }, S.to);
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
