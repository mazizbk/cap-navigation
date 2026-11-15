'use strict';
/* Cap — prototype de navigation immersive.
 * Carte : MapLibre GL + tuiles OpenFreeMap (données OpenStreetMap)
 * Adresses : Nominatim · Itinéraire : OSRM · Photos de rue : Panoramax (puis Mapillary si un jeton est fourni)
 */

const CONFIG = {
  style: 'https://tiles.openfreemap.org/styles/liberty',
  osrm: 'https://router.project-osrm.org/route/v1/driving/',
  nominatim: 'https://nominatim.openstreetmap.org/search',
  panoramax: 'https://api.panoramax.xyz/api/search',
  overpass: 'https://overpass-api.de/api/interpreter',
  nantes: 'https://data.nantesmetropole.fr/api/explore/v2.1/catalog/datasets/244400404_fluidite-axes-routiers-nantes-metropole/records',
  incidents: 'api/incidents', // fourni par server.js (relais du flux open data Bison Futé)
  // Facultatif : dans la console du navigateur, localStorage.setItem('mapillaryToken', '…')
  mapillaryToken: readStore('mapillaryToken'),
  startView: { center: [2.35, 46.8], zoom: 5 },
  colors: { route: '#19d3b5', done: 'rgba(255,255,255,0.28)', casing: '#0b3d36' },
};

function readStore(key) {
  try { return localStorage.getItem(key) || ''; } catch { return ''; }
}

const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------------------------------------------------------------- état
const S = {
  from: null, to: null,      // lieux { label, lon, lat }
  route: null,               // { coords, cum, steps, total, duration }
  mode: 'plan',              // 'plan' | 'nav' | 'arrived'
  sim: false, simMult: 1,
  following: true,
  d: 0, pos: null, bearing: 0, speed: 0, zoom: 17, pitch: 60,
  gps: null,                 // dernier relevé GPS { along, t, speed, off, raw, heading }
  offCount: 0, rerouting: false,
  spoken: {}, muted: false,
  photo: null, photoShown: false,
  hazards: [], hazardDone: {}, hazardMarkers: [], overAt: 0, // alertes sur le trajet (voir hazards.js)
  carScreen: readStore('carScreen') === '1',
  gsvOn: readStore('gsvOn') !== '0', // aperçu photo du prochain carrefour pendant le guidage
  streetOn: false, // photos de rue libres (Panoramax) : retirées, trop inégales. Remplacées par Google Street View.
  // Clé Google Maps : celle du fichier config.js (installée par tools/set_key.ps1), sinon celle saisie sur l'appareil.
  gkey: (window.CAP_CONFIG && window.CAP_CONFIG.googleKey) || readStore('gkey'),
  real: readStore('view') !== 'plan', buildingLayer: '', topH: 0,
  raf: 0, lastT: 0, lastUi: 0, watchId: null, wake: null,
  manKey: '',
};

// ---------------------------------------------------------------- carte
const map = new maplibregl.Map({
  container: 'map',
  style: CONFIG.style,
  center: CONFIG.startView.center,
  zoom: CONFIG.startView.zoom,
  pitch: 45,
  maxPitch: 75,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');

const vehicleEl = document.createElement('div');
vehicleEl.className = 'vehicle';
vehicleEl.innerHTML =
  '<svg viewBox="0 0 48 48" width="48" height="48"><circle cx="24" cy="24" r="22" fill="rgba(25,211,181,.22)"/>' +
  '<path d="M24 7 L37 38 L24 31 L11 38 Z" fill="#fff" stroke="#0b3d36" stroke-width="2.5" stroke-linejoin="round"/></svg>';
const vehicle = new maplibregl.Marker({ element: vehicleEl, rotationAlignment: 'map', pitchAlignment: 'map' });
const destMarker = new maplibregl.Marker({ color: '#ff5a4d' });
const startMarker = new maplibregl.Marker({ color: '#19d3b5', scale: 0.7 });

const emptyFC = { type: 'FeatureCollection', features: [] };

map.on('load', () => {
  // Bâtiments en relief : on réutilise la couche 3D du style, ou on en crée une.
  let buildingLayer = map.getStyle().layers.find((l) => l.type === 'fill-extrusion')?.id;
  if (!buildingLayer) {
    buildingLayer = 'building-3d';
    map.addLayer({
      id: buildingLayer, type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building', minzoom: 14,
      paint: {
        'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 8],
        'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
      },
    });
  }
  S.buildingLayer = buildingLayer;

  // Vue réelle : vraies photos aériennes (IGN, France entière) posées sous les bâtiments en relief.
  // Les noms de rues et de lieux du plan restent affichés par-dessus.
  map.addSource('ortho', {
    type: 'raster', tileSize: 256, maxzoom: 19, attribution: 'Photos aériennes © IGN',
    tiles: ['https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&FORMAT=image/jpeg&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}'],
  });
  map.addLayer({ id: 'ortho', type: 'raster', source: 'ortho', minzoom: 6, paint: { 'raster-fade-duration': 0 } }, buildingLayer);
  setRealView(S.real);
  try {
    map.setSky({
      'sky-color': '#7fb6f5', 'horizon-color': '#e6f0fb', 'fog-color': '#eef2f6',
      'sky-horizon-blend': 0.7, 'horizon-fog-blend': 0.7, 'fog-ground-blend': 0.55,
    });
  } catch { /* version de MapLibre sans ciel */ }

  // Itinéraire (sous les bâtiments pour qu'ils le masquent naturellement).
  map.addSource('route', { type: 'geojson', lineMetrics: true, data: emptyFC });
  map.addLayer({
    id: 'route-casing', type: 'line', source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': CONFIG.colors.casing, 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 5, 14, 10, 18, 26] },
  }, buildingLayer);
  map.addLayer({
    id: 'route-line', type: 'line', source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': CONFIG.colors.route,
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 3, 14, 7, 18, 20],
      'line-gradient': progressGradient(0),
    },
  }, buildingLayer);

  // Bouchons en direct : portions du trajet colorées en orange (dense), rouge (saturé) ou rouge sombre (bloqué).
  map.addSource('jams', { type: 'geojson', data: emptyFC });
  map.addLayer({
    id: 'route-jam', type: 'line', source: 'jams',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 3, 14, 7, 18, 20] },
  }, buildingLayer);

  // Flèche de manœuvre à l'approche d'un carrefour.
  map.addSource('maneuver', { type: 'geojson', data: emptyFC });
  map.addLayer({
    id: 'maneuver-casing', type: 'line', source: 'maneuver', filter: ['==', ['geometry-type'], 'LineString'],
    layout: { 'line-cap': 'butt', 'line-join': 'round' },
    paint: { 'line-color': '#0e1420', 'line-width': ['interpolate', ['linear'], ['zoom'], 14, 8, 18, 18] },
  }, buildingLayer);
  map.addLayer({
    id: 'maneuver-line', type: 'line', source: 'maneuver', filter: ['==', ['geometry-type'], 'LineString'],
    layout: { 'line-cap': 'butt', 'line-join': 'round' },
    paint: { 'line-color': '#ffd23f', 'line-width': ['interpolate', ['linear'], ['zoom'], 14, 5, 18, 13] },
  }, buildingLayer);
  map.addLayer({
    id: 'maneuver-head', type: 'fill', source: 'maneuver', filter: ['==', ['geometry-type'], 'Polygon'],
    paint: { 'fill-color': '#ffd23f', 'fill-outline-color': '#0e1420' },
  }, buildingLayer);

  // La mention des sources reste accessible par le « i », mais repliée : dépliée, elle masque un morceau de carte.
  const attrib = document.querySelector('.maplibregl-ctrl-attrib');
  if (attrib) { attrib.classList.remove('maplibregl-compact-show'); attrib.removeAttribute('open'); }

  if (S.route) drawRoute();
});

// Mode conduite : tout ce qui n'aide pas à suivre le trajet s'efface pour que le tracé et la flèche ressortent.
function setDriveStyle(on) {
  if (!map.getLayer('ortho')) return;
  // Photo aérienne assombrie et moins colorée : elle reste un repère, sans noyer le tracé.
  map.setPaintProperty('ortho', 'raster-saturation', on ? -0.45 : 0);
  map.setPaintProperty('ortho', 'raster-brightness-max', on ? 0.6 : 1);
  // Pas de volumes translucides ni d'icônes de commerces pendant qu'on roule.
  map.setPaintProperty(S.buildingLayer, 'fill-extrusion-opacity', on && S.real ? 0 : S.real ? 0.26 : 0.86);
  for (const layer of map.getStyle().layers) {
    if (layer.type === 'symbol' && /^poi|airport|aerodrome/.test(layer.id)) {
      map.setLayoutProperty(layer.id, 'visibility', on ? 'none' : 'visible');
    }
  }
  map.setPaintProperty('route-casing', 'line-color', on ? '#ffffff' : CONFIG.colors.casing);
}

// Bascule entre la vue réelle (photos aériennes) et le plan dessiné.
function setRealView(real) {
  S.real = real;
  try { localStorage.setItem('view', real ? 'real' : 'plan'); } catch { /* stockage indisponible */ }
  $('view-toggle').textContent = real ? 'Plan' : 'Vue réelle';
  if (!map.getLayer('ortho')) return;
  map.setLayoutProperty('ortho', 'visibility', real ? 'visible' : 'none');
  // Sur les photos, des bâtiments translucides laissent voir les vrais toits ; sur le plan, ils sont pleins.
  map.setPaintProperty(S.buildingLayer, 'fill-extrusion-color', real
    ? '#f4f1ea'
    : ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 8], 0, '#e9e4dc', 40, '#d5d9e2', 150, '#b9c3d6']);
  map.setPaintProperty(S.buildingLayer, 'fill-extrusion-opacity', real ? 0.26 : 0.86);
}

function progressGradient(p) {
  return ['step', ['line-progress'], CONFIG.colors.done, clamp(p, 0.00001, 0.99999), CONFIG.colors.route];
}

// L'utilisateur bouge la carte pendant le guidage : on arrête de suivre le véhicule.
for (const ev of ['dragstart', 'zoomstart', 'rotatestart', 'pitchstart']) {
  map.on(ev, (e) => {
    if (S.mode !== 'plan' && e.originalEvent && S.following) {
      S.following = false;
      $('recenter').hidden = false;
    }
  });
}

// ---------------------------------------------------------------- recherche d'adresse
function setStatus(msg, isError) {
  if (isError && msg) diag('message : ' + msg);
  const el = $('status');
  el.textContent = msg || '';
  el.classList.toggle('error', !!isError);
}

function shortLabel(displayName) {
  return displayName.split(',').slice(0, 3).map((s) => s.trim()).join(', ');
}

async function geocode(q) {
  const url = new URL(CONFIG.nominatim);
  url.search = new URLSearchParams({ format: 'jsonv2', q, limit: '5', 'accept-language': 'fr' });
  const res = await fetch(url);
  if (!res.ok) throw new Error('La recherche d\'adresse a échoué (' + res.status + ').');
  const list = await res.json();
  return list.map((x) => ({ label: shortLabel(x.display_name), full: x.display_name, lon: +x.lon, lat: +x.lat }));
}

function locate() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('La géolocalisation n\'est pas disponible sur cet appareil.'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ label: 'Ma position', lon: p.coords.longitude, lat: p.coords.latitude, gps: true }),
      (err) => reject(new Error(err.code === 1
        ? 'Position refusée : autorisez la localisation, ou saisissez une adresse de départ.'
        : 'Position introuvable : saisissez une adresse de départ.')),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 5000 },
    );
  });
}

async function showCandidates(which) {
  const input = $(which);
  const q = input.value.trim();
  if (!q) return;
  setStatus('Recherche…');
  try {
    const list = await geocode(q);
    setStatus(list.length ? '' : 'Aucune adresse trouvée pour « ' + q + ' ».', !list.length);
    const ul = $('results');
    ul.innerHTML = '';
    for (const place of list) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = place.full;
      b.addEventListener('click', () => {
        S[which] = place;
        input.value = place.label;
        ul.hidden = true;
        if (which === 'to' || S.to) planRoute();
        else $('to').focus();
      });
      li.appendChild(b);
      ul.appendChild(li);
    }
    ul.hidden = !list.length;
  } catch (e) {
    setStatus(e.message, true);
  }
}

async function resolvePlace(which) {
  if (S[which]) return S[which];
  const q = $(which).value.trim();
  if (which === 'from' && !q) return (S.from = await locate());
  if (!q) throw new Error('Indiquez une destination.');
  const list = await geocode(q);
  if (!list.length) throw new Error('Aucune adresse trouvée pour « ' + q + ' ».');
  S[which] = list[0];
  $(which).value = list[0].label;
  return list[0];
}

for (const which of ['from', 'to']) {
  $(which).addEventListener('input', () => { S[which] = null; $('results').hidden = true; });
  $(which).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); showCandidates(which); }
  });
}
$('from-gps').addEventListener('click', async () => {
  setStatus('Localisation…');
  try {
    S.from = await locate();
    $('from').value = 'Ma position';
    setStatus('');
    map.flyTo({ center: [S.from.lon, S.from.lat], zoom: 15 });
    if (S.to) planRoute();
  } catch (e) { setStatus(e.message, true); }
});
$('search-form').addEventListener('submit', (e) => { e.preventDefault(); planRoute(); });

// ---------------------------------------------------------------- itinéraire
// Demande l'itinéraire habituel et ses variantes (jusqu'à trois trajets), pour pouvoir choisir le plus rapide.
async function fetchRoutes(from, to) {
  const url = `${CONFIG.osrm}${from.lon},${from.lat};${to.lon},${to.lat}?steps=true&overview=false&geometries=geojson&alternatives=true`;
  const res = await fetch(url);
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.code !== 'Ok') throw new Error('Aucun itinéraire voiture trouvé entre ces deux points.');
  return json.routes.map(buildRoute);
}

// Met bout à bout les géométries des étapes et calcule où chaque étape commence.
function buildRoute(r) {
  const coords = [];
  const steps = [];
  for (const leg of r.legs) {
    for (const st of leg.steps) {
      const g = st.geometry.coordinates;
      const startIdx = coords.length ? coords.length - 1 : 0;
      for (let i = coords.length ? 1 : 0; i < g.length; i++) coords.push(g[i]);
      const m = st.maneuver;
      const step = {
        startIdx, distance: st.distance, duration: st.duration, name: st.name || '', ref: st.ref || '',
        type: m.type, modifier: m.modifier || 'straight', exit: m.exit,
        lanes: st.intersections?.[0]?.lanes || null,
        junction: junctionOf(st),     // toutes les branches du carrefour, pour le schéma
        roundabout: roundaboutOf(st), // toutes les sorties du rond-point
        exitNo: st.exits || '',       // numéro de sortie (autoroute)
        // Directions du panneau, les villes d'abord (« Vannes - Centre » parle plus que « D 767 »).
        dest: (st.destinations || '').split(/[,;:]/).map((d) => d.trim()).filter(Boolean)
          .sort((a, b) => /^[A-Z]{1,2} ?\d/.test(a) - /^[A-Z]{1,2} ?\d/.test(b)).slice(0, 3),
      };
      describe(step);
      steps.push(step);
    }
  }
  const cum = Geo.cumulative(coords);
  let t = 0;
  for (const s of steps) { s.start = cum[s.startIdx]; s.tStart = t; t += s.duration; }
  // « Tournez légèrement à droite » alors que la route vire ensuite à angle droit : la consigne sous-estime
  // ce que le conducteur va vivre. On mesure le virage réel (de 25 m avant à 45 m après) et on corrige le mot.
  const total = cum[cum.length - 1];
  const dirAt = (d) => Geo.bearing(Geo.pointAt(coords, cum, d), Geo.pointAt(coords, cum, d + 8));
  for (const s of steps) {
    if (!/^(turn|continue|new name|end of road)$/.test(s.type) || !s.modifier.startsWith('slight')) continue;
    if (s.start < 25 || s.start + 55 > total) continue;
    const turn = ((dirAt(s.start + 45) - dirAt(s.start - 25) + 540) % 360) - 180;
    const right = s.modifier.includes('right');
    if ((right ? turn : -turn) < 70) continue;
    s.modifier = right ? 'right' : 'left';
    s.junction = null; // le schéma du premier croisement ne montrerait qu'un léger écart
    describe(s);
  }
  return { coords, cum, steps, total: cum[cum.length - 1], duration: t };
}

// Branches du carrefour où a lieu la manœuvre. Chaque branche : son angle par rapport à notre sens d'arrivée
// (0 = tout droit, 90 = à droite, -90 = à gauche), si on a le droit de s'y engager, et son rôle.
function junctionOf(st) {
  const all = st.intersections || [];
  const branchesOf = (x) => {
    if (!x || x.in === undefined || x.out === undefined || x.bearings.length < 3) return null;
    const heading = (x.bearings[x.in] + 180) % 360;
    return x.bearings.map((b, k) => ({
      angle: ((b - heading + 540) % 360) - 180,
      open: !!x.entry[k],
      role: k === x.in ? 'in' : k === x.out ? 'out' : '',
    }));
  };
  // Le schéma doit dire la même chose que la consigne. Sur un grand carrefour (chaussées séparées, terre-plein),
  // la consigne « tournez à gauche » est rattachée au premier croisement alors que le virage se fait au suivant :
  // on cherche donc, dans les 45 premiers mètres, le croisement dont la sortie correspond vraiment à la consigne.
  const mod = st.maneuver.modifier || 'straight';
  const agrees = (branches) => {
    const a = branches.find((b) => b.role === 'out').angle;
    if (mod === 'straight') return Math.abs(a) < 30;
    if (mod === 'uturn') return Math.abs(a) > 140;
    const sideOk = mod.includes('left') ? a < -5 : a > 5;
    if (mod.startsWith('slight')) return sideOk && Math.abs(a) < 65;
    return sideOk && Math.abs(a) >= 25;
  };
  for (const x of all) {
    if (Geo.distance(all[0].location, x.location) > 45) break;
    const branches = branchesOf(x);
    if (branches && agrees(branches)) return branches;
  }
  return null; // aucun croisement ne correspond : une simple flèche, fidèle à la consigne, vaut mieux qu'un schéma faux
}

// Sorties d'un rond-point, en degrés autour de l'anneau à partir de notre entrée (sens des aiguilles d'une montre).
// On retrouve le centre de l'anneau à partir de trois points du trajet effectué dessus.
function roundaboutOf(st) {
  // Seulement les vrais ronds-points, dont l'étape couvre uniquement le trajet dans l'anneau.
  // (Un « roundabout turn » est un mini-giratoire traité comme un carrefour : son étape inclut toute la rue suivante.)
  if ((st.maneuver.type !== 'roundabout' && st.maneuver.type !== 'rotary') || st.driving_side === 'left') return null;
  const g = st.geometry.coordinates;
  if (g.length < 3) return null;
  const kx = Math.cos((g[0][1] * Math.PI) / 180);
  const P = (c) => [(c[0] - g[0][0]) * kx, c[1] - g[0][1]];
  const [a, b, c] = [P(g[0]), P(g[g.length >> 1]), P(g[g.length - 1])];
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return null; // points alignés : pas un arc exploitable
  const sq = (p) => p[0] * p[0] + p[1] * p[1];
  const ux = (sq(a) * (b[1] - c[1]) + sq(b) * (c[1] - a[1]) + sq(c) * (a[1] - b[1])) / d;
  const uy = (sq(a) * (c[0] - b[0]) + sq(b) * (a[0] - c[0]) + sq(c) * (b[0] - a[0])) / d;
  const center = [g[0][0] + ux / kx, g[0][1] + uy];
  const entry = Geo.bearing(center, g[0]);
  const around = (p) => (Geo.bearing(center, p) - entry + 360) % 360;
  const out = around(g[g.length - 1]);
  const turned = (deg) => (360 - deg) % 360; // angle déjà parcouru dans l'anneau pour atteindre ce point
  // Distance, depuis l'entrée, d'un point du parcours dans l'anneau.
  const alongOf = (loc) => {
    let best = 0;
    let bestD = Infinity;
    let run = 0;
    let alongBest = 0;
    for (let j = 0; j < g.length; j++) {
      if (j) run += Geo.distance(g[j - 1], g[j]);
      const d = Geo.distance(g[j], loc);
      if (d < bestD) { bestD = d; best = j; alongBest = run; }
    }
    return alongBest;
  };
  const passed = []; // sorties devant lesquelles on passe avant la nôtre
  for (const x of st.intersections.slice(1)) {
    // Une sortie possible = une branche ouverte qui n'est ni celle d'où l'on vient ni la suite de l'anneau.
    if (!x.bearings.some((_, k) => k !== x.in && k !== x.out && x.entry[k])) continue;
    const deg = around(x.location);
    // On écarte ce qui est collé à notre entrée ou à notre sortie (bretelles, voies d'insertion).
    if (turned(deg) < 25 || turned(deg) > turned(out) - 15) continue;
    passed.push({ deg, along: alongOf(x.location) });
  }
  // On ne compte les sorties en direct que si notre décompte confirme le numéro de sortie de l'itinéraire :
  // mieux vaut ne rien dire que d'annoncer un mauvais nombre.
  const reliable = st.maneuver.exit ? passed.length === st.maneuver.exit - 1 : false;
  return {
    exits: reliable ? passed.map((e) => e.deg) : [], alongs: reliable ? passed.map((e) => e.along) : null, out,
    center, radius: Geo.distance(center, g[0]), entryBearing: entry,
  };
}

// Complète un rond-point avec TOUTES ses branches (pas seulement celles devant lesquelles passe l'itinéraire).
// On les lit dans les données de la carte déjà chargées : toute route qui part de l'anneau vers l'extérieur
// est une branche ; son sens de circulation dit si c'est une sortie ou seulement une entrée.
// Le résultat n'est utilisé que s'il confirme le numéro de sortie donné par l'itinéraire.
function completeRoundabout(step) {
  const rb = step.roundabout;
  if (!rb || rb.full || (rb.tries || 0) >= 8) return;
  rb.tries = (rb.tries || 0) + 1;
  let feats;
  try { feats = map.querySourceFeatures('openmaptiles', { sourceLayer: 'transportation' }); } catch { return; }
  const r = rb.radius;
  const outer = Math.max(r * 1.7, r + 10); // cercle de contrôle, un peu à l'extérieur de l'anneau
  const found = [];
  for (const f of feats) {
    const cls = f.properties.class || '';
    if (!cls || /path|track|rail|transit|ferry|pier|raceway|busway|construction/.test(cls)) continue;
    const lines = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const line of lines) {
      const dist = line.map((v) => Geo.distance(rb.center, v));
      if (!dist.some((d) => d <= r * 1.35)) continue; // cette route ne touche pas l'anneau
      for (let j = 0; j < line.length - 1; j++) {
        const inA = dist[j] <= outer;
        const inB = dist[j + 1] <= outer;
        if (inA === inB) continue; // ne franchit pas le cercle de contrôle
        const outward = inA; // tracée de l'anneau vers l'extérieur
        const oneway = f.properties.oneway;
        const isExit = !oneway ? true : oneway === 1 ? outward : !outward;
        const t = (outer - dist[j]) / (dist[j + 1] - dist[j]);
        const pt = [line[j][0] + (line[j + 1][0] - line[j][0]) * t, line[j][1] + (line[j + 1][1] - line[j][1]) * t];
        found.push({ deg: (Geo.bearing(rb.center, pt) - rb.entryBearing + 360) % 360, exit: isExit });
      }
    }
  }
  // Une même branche apparaît plusieurs fois (tuiles voisines, deux chaussées) : on regroupe par angle.
  const exits = [];
  for (const b of found.filter((x) => x.exit).sort((a, c) => a.deg - c.deg)) {
    if (!exits.some((e) => Math.abs(((e - b.deg + 540) % 360) - 180) < 15)) exits.push(b.deg);
  }
  const turned = (deg) => (360 - deg) % 360;
  // Notre sortie, repérée au même endroit que les autres : là où l'itinéraire franchit le cercle de contrôle.
  // (Mesurée sur l'anneau, elle peut être décalée de plusieurs dizaines de degrés quand la bretelle est courbe.)
  let ours = rb.out;
  const R = S.route;
  for (let d = step.start + step.distance; d < step.start + step.distance + 90; d += 2) {
    const p = Geo.pointAt(R.coords, R.cum, d);
    if (Geo.distance(rb.center, p) >= outer) { ours = (Geo.bearing(rb.center, p) - rb.entryBearing + 360) % 360; break; }
  }
  const mine = exits.find((e) => Math.abs(((e - ours + 540) % 360) - 180) < 20);
  if (mine === undefined) return; // notre sortie n'est pas retrouvée : carte pas encore chargée, on réessaiera
  const before = exits.filter((e) => e !== mine && turned(e) > 12 && turned(e) < turned(mine) - 8);
  if (!step.exit || before.length !== step.exit - 1) return; // décompte non confirmé : on ne s'en sert pas
  rb.full = true;
  rb.out = mine; // même repère que les autres sorties, pour un schéma cohérent
  rb.exits = exits.filter((e) => e !== mine);
  // Distance le long de l'anneau jusqu'à chaque sortie à laisser passer (arc = angle × rayon).
  if (!rb.alongs) rb.alongs = before.map((e) => (turned(e) * Math.PI / 180) * r).sort((a, c) => a - c);
}


// De quel côté se placer avant la manœuvre. Les voies quand on les connaît, sinon le bon sens du côté où l'on tourne.
function placeAdvice(step) {
  const lane = laneAdvice(step.lanes);
  if (lane) return lane;
  if (step.roundabout || /roundabout|rotary|arrive|depart|merge/.test(step.type)) return '';
  const sharp = step.modifier === 'left' || step.modifier === 'right' || step.modifier.startsWith('sharp');
  const branch = /ramp|fork/.test(step.type);
  if (!sharp && !branch) return '';
  if (step.modifier.includes('right')) return 'Serrez à droite';
  if (step.modifier.includes('left')) return 'Serrez à gauche';
  return '';
}

// Rédige la consigne d'une étape, et sépare pour l'affichage l'action (« Tournez à droite ») de l'endroit (« Rue Henri Dunant »).
function describe(step) {
  step.text = instruction(step);
  step.road = step.name || step.dest[0] || step.ref || '';
  step.act = step.road && step.text.endsWith(step.road)
    ? step.text.slice(0, -step.road.length).replace(/\s(sur|vers)\s*$/, '')
    : step.text;
}

const TURN = {
  uturn: 'Faites demi-tour', 'sharp right': 'Tournez franchement à droite', right: 'Tournez à droite',
  'slight right': 'Tournez légèrement à droite', straight: 'Continuez tout droit',
  'slight left': 'Tournez légèrement à gauche', left: 'Tournez à gauche', 'sharp left': 'Tournez franchement à gauche',
};
const side = (mod) => (mod.includes('left') ? 'à gauche' : mod.includes('right') ? 'à droite' : 'tout droit');
const ORDINAL = ['', 'première', 'deuxième', 'troisième', 'quatrième', 'cinquième', 'sixième', 'septième', 'huitième'];

function instruction(s) {
  const road = s.name || s.ref;
  const on = road ? ' sur ' + road : '';
  switch (s.type) {
    case 'depart': return 'Partez' + on;
    case 'arrive': return 'Vous êtes arrivé';
    case 'roundabout':
    case 'rotary':
      return 'Au rond-point, prenez la ' + (ORDINAL[s.exit] || s.exit + 'e') + ' sortie' + (road ? ' vers ' + road : '');
    case 'exit roundabout':
    case 'exit rotary': return 'Sortez du rond-point' + on;
    case 'roundabout turn': return 'Au rond-point, ' + TURN[s.modifier].toLowerCase() + on;
    case 'fork': return 'Restez ' + side(s.modifier) + (s.dest.length ? ' vers ' + s.dest[0] : on);
    case 'on ramp': return 'Prenez la bretelle ' + side(s.modifier) + (s.dest.length ? ' vers ' + s.dest[0] : on);
    case 'off ramp':
      return 'Prenez la sortie ' + (s.exitNo ? s.exitNo + ' ' : '') + side(s.modifier) + (s.dest.length ? ' vers ' + s.dest[0] : on);
    case 'merge': return 'Insérez-vous ' + side(s.modifier) + on;
    case 'new name':
    case 'continue':
      return s.modifier === 'straight' || !TURN[s.modifier] ? 'Continuez' + on : TURN[s.modifier] + on;
    default: return (TURN[s.modifier] || 'Continuez') + on;
  }
}

async function planRoute() {
  $('results').hidden = true;
  $('summary').hidden = true;
  setStatus('Calcul de l\'itinéraire…');
  try {
    const from = await resolvePlace('from');
    if (!from.gps && $('to').value.trim() && !S.to) await new Promise((r) => setTimeout(r, 1100)); // 1 requête/s max chez Nominatim
    const to = await resolvePlace('to');
    S.route = await bestRoute(from, to); // le plus rapide, bouchons connus compris (voir traffic.js)
    S.photo = null;
    drawRoute();
    startMarker.setLngLat([from.lon, from.lat]).addTo(map);
    destMarker.setLngLat([to.lon, to.lat]).addTo(map);
    fitRoute();
    $('summary-text').innerHTML =
      '<b>' + fmtDuration(S.route.duration + (S.route.jamDelay || 0)) + '</b> ' + (S.route.trafficKnown ? (S.route.trafficSource === 'TomTom' ? 'trafic compris' : 'bouchons de Nantes compris') : 'hors bouchons') + ' · ' + fmtDist(S.route.total) + '<br><span>vers ' + escapeHtml(to.label) + '</span>';
    $('summary-hazards').textContent = '';
    $('summary-traffic').textContent = trafficSummary();
    $('summary').hidden = false;
    setStatus('');
    loadPhoto(to); // en arrière-plan, pour l'afficher à l'approche
    loadHazards(); // idem : alertes trafic et zones de danger
    $('resume-nav').hidden = true;
    saveTrip(false);
  } catch (e) {
    setStatus(e.message || 'Erreur réseau.', true);
  }
}

function drawRoute() {
  if (!map.getSource('route')) return;
  map.getSource('route').setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: S.route.coords } });
  map.setPaintProperty('route-line', 'line-gradient', progressGradient(0));
  drawJams();
}

function fitRoute() {
  const b = new maplibregl.LngLatBounds();
  for (const c of S.route.coords) b.extend(c);
  const top = $('planner').hidden ? 60 : $('planner').offsetHeight + 40;
  map.fitBounds(b, { padding: { top, bottom: 60, left: 40, right: 40 }, pitch: 30, bearing: 0, duration: 900 });
}

// ---------------------------------------------------------------- formats
function fmtDist(m) {
  if (m >= 10000) return Math.round(m / 1000) + ' km';
  if (m >= 1000) return (m / 1000).toFixed(1).replace('.', ',') + ' km';
  if (m >= 100) return Math.round(m / 50) * 50 + ' m';
  return Math.max(10, Math.round(m / 10) * 10) + ' m';
}
function fmtDistSpoken(m) {
  if (m >= 1000) {
    const km = Math.round(m / 100) / 10;
    return String(km).replace('.', ',') + (km >= 2 ? ' kilomètres' : ' kilomètre');
  }
  return fmtDist(m).replace(' m', ' mètres');
}
function fmtDuration(s) {
  const min = Math.max(1, Math.round(s / 60));
  return min < 60 ? min + ' min' : Math.floor(min / 60) + ' h ' + String(min % 60).padStart(2, '0');
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------- pictogrammes
const ANGLE = {
  straight: 0, none: 0, 'slight right': 40, right: 90, 'sharp right': 135,
  'slight left': -40, left: -90, 'sharp left': -135, uturn: 180,
};

function arrowSvg(angle, size) {
  const stroke = 'stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" fill="none"';
  if (Math.abs(angle) === 180) {
    return `<svg viewBox="0 0 48 48" width="${size}" height="${size}"><path d="M31 44 V20 a8.5 8.5 0 0 0 -17 0 V28" ${stroke}/>` +
      '<path d="M5.5 25 L14 36 L22.5 25 Z" fill="currentColor"/></svg>';
  }
  const a = (angle * Math.PI) / 180;
  const dx = Math.sin(a);
  const dy = -Math.cos(a);
  const cx = 24;
  const cy = angle === 0 ? 34 : 27;
  const len = angle === 0 ? 18 : 13;
  const ex = cx + dx * len;
  const ey = cy + dy * len;
  const tip = [ex + dx * 9, ey + dy * 9];
  const l = [ex - dy * 8, ey + dx * 8];
  const r = [ex + dy * 8, ey - dx * 8];
  return `<svg viewBox="0 0 48 48" width="${size}" height="${size}"><path d="M${cx} 44 L${cx} ${cy} L${ex.toFixed(1)} ${ey.toFixed(1)}" ${stroke}/>` +
    `<path d="M${tip.map((n) => n.toFixed(1))} L${l.map((n) => n.toFixed(1))} L${r.map((n) => n.toFixed(1))} Z" fill="currentColor"/></svg>`;
}

// Schéma du carrefour vu d'en haut : on arrive par le bas, toutes les branches sont dessinées à leur angle réel,
// celle à prendre est surlignée avec une flèche. Les branches où l'on ne peut pas s'engager sont en pointillés.
const GREY = 'rgba(255,255,255,.3)';
function junctionSvg(branches, size) {
  const cx = 32;
  const cy = 35;
  const end = (angle, len) => {
    const a = (angle * Math.PI) / 180;
    return [cx + Math.sin(a) * len, cy - Math.cos(a) * len];
  };
  const fx = (n) => n.toFixed(1);
  let grey = '';
  for (const b of branches) {
    if (b.role) continue;
    const [x, y] = end(b.angle, 25);
    grey += `<path d="M${cx} ${cy} L${fx(x)} ${fx(y)}" stroke="${GREY}" stroke-width="7" stroke-linecap="round"${b.open ? '' : ' stroke-dasharray="1 9"'}/>`;
  }
  const out = branches.find((b) => b.role === 'out');
  const [ox, oy] = end(out.angle, 19);
  const a = (out.angle * Math.PI) / 180;
  const dx = Math.sin(a);
  const dy = -Math.cos(a);
  const head = [[ox + dx * 10, oy + dy * 10], [ox - dy * 8, oy + dx * 8], [ox + dy * 8, oy - dx * 8]];
  return `<svg viewBox="0 0 64 64" width="${size}" height="${size}" fill="none">${grey}` +
    `<path d="M${cx} 62 L${cx} ${cy} L${fx(ox)} ${fx(oy)}" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<path d="M${head.map((p) => fx(p[0]) + ' ' + fx(p[1])).join(' L')} Z" fill="currentColor"/></svg>`;
}

// Schéma du rond-point : l'anneau, toutes ses sorties, et le chemin à suivre jusqu'à la bonne.
function roundaboutSvg(rb, size) {
  const cx = 32;
  const cy = 31;
  const r = 13;
  // `deg` = position autour de l'anneau depuis notre entrée (en bas), dans le sens des aiguilles d'une montre.
  const at = (deg, radius) => {
    const a = ((180 + deg) * Math.PI) / 180;
    return [cx + Math.sin(a) * radius, cy - Math.cos(a) * radius];
  };
  const fx = (n) => n.toFixed(1);
  const stub = (deg, color, w) => {
    const [x1, y1] = at(deg, r);
    const [x2, y2] = at(deg, r + 13);
    return `<path d="M${fx(x1)} ${fx(y1)} L${fx(x2)} ${fx(y2)}" stroke="${color}" stroke-width="${w}" stroke-linecap="round"/>`;
  };
  let svg = `<circle cx="${cx}" cy="${cy}" r="${r}" stroke="${GREY}" stroke-width="6"/>`;
  for (const e of rb.exits) if (Math.abs(e - rb.out) > 12 && e > 18 && e < 342) svg += stub(e, GREY, 6);
  // On circule dans le sens inverse des aiguilles d'une montre, de l'entrée (0°) jusqu'à la sortie.
  const travelled = (360 - rb.out) % 360;
  const [ex, ey] = at(rb.out, r);
  const [sx, sy] = at(0, r);
  svg += `<path d="M${cx} 63 L${fx(sx)} ${fx(sy)} A${r} ${r} 0 ${travelled > 180 ? 1 : 0} 0 ${fx(ex)} ${fx(ey)}" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>`;
  svg += stub(rb.out, 'currentColor', 6);
  const [tx, ty] = at(rb.out, r + 13);
  const a = ((180 + rb.out) * Math.PI) / 180;
  const dx = Math.sin(a);
  const dy = -Math.cos(a);
  const head = [[tx + dx * 8, ty + dy * 8], [tx - dy * 7, ty + dx * 7], [tx + dy * 7, ty - dx * 7]];
  svg += `<path d="M${head.map((p) => fx(p[0]) + ' ' + fx(p[1])).join(' L')} Z" fill="currentColor"/>`;
  return `<svg viewBox="0 0 64 64" width="${size}" height="${size}" fill="none">${svg}</svg>`;
}

function stepIcon(s, size = 56) {
  if (s.type === 'arrive') {
    return `<svg viewBox="0 0 48 48" width="${size}" height="${size}"><path d="M24 4c-8 0-14 6-14 14 0 10 14 26 14 26s14-16 14-26c0-8-6-14-14-14z" fill="currentColor"/><circle cx="24" cy="18" r="5.5" fill="#0e1420"/></svg>`;
  }
  // En grand, on montre le vrai dessin du carrefour ; en petit (« puis… »), une simple flèche reste plus lisible.
  if (size >= 40 && s.roundabout) return roundaboutSvg(s.roundabout, size);
  if (size >= 40 && s.junction && s.type !== 'depart') return junctionSvg(s.junction, size);
  if (s.type === 'roundabout' || s.type === 'rotary') {
    return `<svg viewBox="0 0 48 48" width="${size}" height="${size}"><circle cx="24" cy="22" r="13" fill="none" stroke="currentColor" stroke-width="5"/>` +
      `<path d="M24 46 V35" stroke="currentColor" stroke-width="5" stroke-linecap="round"/>` +
      `<text x="24" y="28" text-anchor="middle" font-size="17" font-weight="700" fill="currentColor" font-family="system-ui">${s.exit || ''}</text></svg>`;
  }
  return arrowSvg(s.type === 'depart' ? 0 : ANGLE[s.modifier] ?? 0, size);
}

function lanesHtml(lanes) {
  return lanes.map((ln) => {
    const ind = ln.indications.find((i) => i !== 'none') || 'straight';
    return `<span class="lane${ln.valid ? ' ok' : ''}">${arrowSvg(ANGLE[ind] ?? 0, 32)}</span>`;
  }).join('');
}

// ---------------------------------------------------------------- voix
function speak(text, urgent) {
  if (S.muted || !('speechSynthesis' in window)) return;
  try {
    if (urgent) speechSynthesis.cancel(); // une consigne immédiate passe devant
    // Une consigne de direction n'est jamais abandonnée : elle attend son tour.
    // Seule exception : la simulation à grande vitesse, où les annonces s'empileraient.
    else if (speechSynthesis.pending && S.sim && S.speed * S.simMult > 30) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'fr-FR';
    u.rate = 1.05;
    speechSynthesis.speak(u);
  } catch { /* pas de synthèse vocale */ }
}

// Les alertes (trafic, zone de danger) ne coupent jamais une consigne de direction : elles attendent la fin.
function speakAlert(text) {
  if ('speechSynthesis' in window && (speechSynthesis.speaking || speechSynthesis.pending)) S.alertQueue = text;
  else speak(text);
}

// Où se placer : traduit les voies autorisées en une phrase (« Prenez la voie de droite »).
// Les voies sont données de gauche à droite ; rien à dire si toutes conviennent.
function laneAdvice(lanes) {
  if (!lanes || lanes.length < 2) return '';
  const ok = lanes.map((l) => !!l.valid);
  const n = ok.length;
  const count = ok.filter(Boolean).length;
  if (count === 0 || count === n) return '';
  const first = ok.indexOf(true);
  const last = ok.lastIndexOf(true);
  if (last - first + 1 !== count) return ''; // voies autorisées non contiguës : trop compliqué à dire
  const NB = ['', '', 'deux', 'trois', 'quatre'];
  const group = (side) => (count === 1 ? 'Prenez la voie ' + side : 'Prenez l\'une des ' + (NB[count] || count) + ' voies ' + side);
  if (last === n - 1) return group('de droite');
  if (first === 0) return group('de gauche');
  return count === 1 ? 'Prenez la voie du milieu' : 'Prenez l\'une des voies du milieu';
}

function announce(k, next, toMan) {
  const done = S.spoken[k] || 0;
  let near = Math.max(90, S.speed * 9);
  let now = Math.max(22, S.speed * 2.2);
  // Un simple changement de nom de rue n'est pas une décision : on ne parle pas, pour que les vraies consignes ressortent.
  if (!isTurn(next) && (next.type === 'new name' || next.type === 'continue')) return;
  // Dans un rond-point, annoncer « dans 70 mètres, sortez » ferait prendre une sortie trop tôt.
  const ring = S.route.steps[k - 1];
  if (ring && ring.roundabout && next.type.startsWith('exit')) {
    if (ring.roundabout.alongs) return; // le décompte des sorties s'en charge (voir updateUi)
    near = 0;                            // sinon une seule annonce, au pied de la sortie
    now = Math.max(12, S.speed * 1.5);
  }
  const lane = placeAdvice(next);
  let flag = 0;
  let text = '';
  if (toMan <= now) { flag = 4; text = next.text; }
  else if (near && toMan <= near) {
    flag = 2;
    text = 'Dans ' + fmtDistSpoken(toMan) + ', ' + lowerFirst(next.text);
    // Deux manœuvres rapprochées : on prévient de la seconde pour se placer tout de suite.
    const after = S.route.steps[k + 1];
    if (after && after.type !== 'arrive' && !after.type.startsWith('exit') && after.start - next.start < 160) text += ', puis ' + lowerFirst(after.text);
    if (lane) text += '. ' + lane;
  } else if (near && toMan > 400) {
    flag = 1;
    text = 'Dans ' + fmtDistSpoken(toMan) + ', ' + lowerFirst(next.text) + (lane ? '. ' + lane : '');
  }
  if (!flag || done >= flag) return;
  S.spoken[k] = flag;
  S.lastSaid = text;
  if (next.type !== 'arrive' || flag === 2) speak(text, flag === 4);
}
const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);

// ---------------------------------------------------------------- guidage
// Une étape où l'on change vraiment de direction (pas un simple « continuez » ni l'arrivée).
function isTurn(step) {
  if (step.type === 'arrive' || step.type === 'depart') return false;
  return step.modifier !== 'straight' || step.type.includes('roundabout') || step.type.includes('rotary');
}

function stepIndexAt(d) {
  const steps = S.route.steps;
  let i = 0;
  while (i + 1 < steps.length && steps[i + 1].start <= d + 0.5) i++;
  return i;
}

async function startNav(sim) {
  if (!S.route) return;
  S.sim = sim;
  S.mode = 'nav';
  S.d = 0;
  S.speed = 0;
  S.spoken = {};
  S.following = true;
  S.photoShown = false;
  S.gps = null;
  S.offCount = 0;
  S.manKey = '';
  S.hazardDone = {};
  $('alert').hidden = true;
  carStart();
  S.pos = S.route.coords[0];
  S.bearing = Geo.bearing(S.pos, Geo.pointAt(S.route.coords, S.route.cum, 15));
  S.zoom = Math.max(map.getZoom(), 15);
  S.pitch = map.getPitch();
  S.navT0 = performance.now();
  S.planAtStart = S.route.duration;
  S.pace = 1; // 1 = on roule au rythme prévu, 1,5 = moitié plus lent
  S.lastStep = undefined;
  S.rbSaid = -1;
  S.gpsLost = false;
  S.wrongCount = 0;
  S.rerouteFailed = false;
  S.alertQueue = '';
  S.lastSaid = '';
  S.camK = 0;               // 0 = cadrage normal, 1 = cadrage « virage »
  S.camBearing = S.bearing; // orientation de la caméra (peut anticiper celle de la voiture)
  S.turn = null;

  $('planner').hidden = true;
  $('nav').hidden = false;
  $('recenter').hidden = true;
  $('arrival').hidden = true;
  $('sim-ctl').hidden = !sim;
  S.simPaused = false;
  S.simKmh = S.simKmh || 0; // on garde les réglages du trajet précédent
  simShow();
  $('stop').textContent = 'Arrêter';
  document.body.classList.add('navigating');
  saveTrip(true);
  setDriveStyle(true);
  startMarker.remove();
  vehicle.setLngLat(S.pos).setRotation(S.bearing).addTo(map);
  streetReset();
  S.topH = 0;
  S.padTop = S.padTarget = Math.round(window.innerHeight * 0.42);
  map.setPadding({ top: S.padTop, bottom: 0, left: 0, right: 0 });
  map.flyTo({ center: S.pos, bearing: S.bearing, zoom: 17.5, pitch: 58, duration: 1400 });
  S.zoom = 17.5;
  S.pitch = 58;

  speak('C\'est parti. ' + S.route.steps[0].text + '.', true);
  try { S.wake = await navigator.wakeLock?.request('screen'); } catch { /* l'écran pourra se mettre en veille */ }

  if (!sim) {
    S.watchId = navigator.geolocation.watchPosition(onFix, (err) => {
      setNavNote(err.code === 1 ? 'Localisation refusée' : 'Signal GPS perdu…');
      diag('GPS erreur ' + err.code + ' ' + err.message);
    }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 });
  }
  S.lastT = 0;
  cancelAnimationFrame(S.raf);
  setTimeout(() => { if (S.mode === 'nav') S.raf = requestAnimationFrame(frame); }, 1450);
}

// Vitesse du véhicule. Certains appareils ne la donnent pas avec la position : on la calcule alors
// à partir de la distance parcourue entre deux relevés, en lissant pour éviter les à-coups.
function fixSpeed(p, raw) {
  const now = performance.now();
  const prev = S.prevFix;
  S.prevFix = { raw, t: now };
  if (Number.isFinite(p.coords.speed) && p.coords.speed !== null) return Math.max(0, p.coords.speed);
  if (!prev || now - prev.t < 300 || now - prev.t > 10000) return S.speed;
  const measured = Geo.distance(prev.raw, raw) / ((now - prev.t) / 1000);
  return S.speed + (Math.min(measured, 60) - S.speed) * 0.5;
}

function onFix(p) {
  if (S.mode !== 'nav' || !S.route) return;
  S.fixCount = (S.fixCount || 0) + 1;
  S.lastAccuracy = p.coords.accuracy;
  const raw = [p.coords.longitude, p.coords.latitude];
  const snap = Geo.snap(S.route.coords, S.route.cum, raw);
  const tolerance = Math.max(30, (p.coords.accuracy || 0) * 1.5);
  const off = snap.dist > tolerance;
  if (S.gpsLost) { // le signal revient
    S.gpsLost = false;
    setNavNote('');
    speak('Signal GPS retrouvé.');
  }
  S.gps = {
    along: snap.along, t: performance.now(), off, raw,
    speed: fixSpeed(p, raw),
    heading: Number.isFinite(p.coords.heading) && p.coords.heading !== null ? p.coords.heading : null,
  };
  S.offCount = off ? S.offCount + 1 : 0;
  // Erreur de route sans s'éloigner du tracé : on roule à contresens de l'itinéraire (virage manqué puis demi-tour,
  // mauvaise sortie de rond-point qui longe la bonne…). Le cap du GPS le révèle avant la distance.
  let wrongWay = false;
  if (!off && S.gps.heading !== null && S.gps.speed > 3) {
    const dir = Geo.bearing(snap.point, Geo.pointAt(S.route.coords, S.route.cum, snap.along + 15));
    wrongWay = S.route.total - snap.along > 30 && Math.abs(((S.gps.heading - dir + 540) % 360) - 180) > 110;
  }
  S.wrongCount = wrongWay ? (S.wrongCount || 0) + 1 : 0;
  if (S.offCount >= 4 || S.wrongCount >= 4) reroute(raw);
}

async function reroute(from) {
  if (S.rerouting) return;
  S.rerouting = true;
  setNavNote('Recalcul de l\'itinéraire…');
  speak('Vous avez quitté l\'itinéraire. Je recalcule.', true);
  diag('recalcul (écart ' + S.offCount + ', contresens ' + S.wrongCount + ')');
  try {
    useRoute(await bestRoute({ lon: from[0], lat: from[1] }, S.to, true));
    S.rerouteFailed = false;
  } catch { /* on garde l'ancien itinéraire, nouvel essai au prochain écart */
    S.offCount = 0;
    S.wrongCount = 0;
    if (!S.rerouteFailed) { // on le dit une fois, pas à chaque tentative
      S.rerouteFailed = true;
      speak('Recalcul impossible pour le moment. Vérifiez le réseau.');
    }
  } finally {
    S.rerouting = false;
    setNavNote('');
  }
}

function setNavNote(msg) {
  $('then').hidden = !msg;
  $('then').textContent = msg;
  S.note = msg;
}

function frame(t) {
  if (S.mode !== 'nav') return;
  const dt = S.lastT ? Math.min(0.12, (t - S.lastT) / 1000) : 0.016;
  S.lastT = t;
  const R = S.route;
  const i = stepIndexAt(S.d);
  const next = R.steps[i + 1];
  const toMan = next ? next.start - S.d : R.total - S.d;
  let off = false;

  if (S.sim) {
    const st = R.steps[i];
    let target = st.duration > 0 ? st.distance / st.duration : 8;
    target = clamp(target, 4, 38);
    if (toMan < 45) target = Math.min(target, 5 + toMan * 0.2); // on ralentit avant de tourner
    if (S.simKmh) target = S.simKmh / 3.6; // vitesse imposée par l'utilisateur
    S.speed += (target - S.speed) * Math.min(1, dt * 1.2);
    if (S.simPaused) S.speed = 0; // en pause : on reste sur place, l'affichage continue
    else S.d = Math.min(R.total, S.d + S.speed * dt * S.simMult);
  } else if (S.gps) {
    // Plus de relevé depuis 7 s (tunnel, parking couvert…) : on le dit, plutôt que de laisser croire que tout va bien.
    if (!S.gpsLost && t - S.gps.t > 7000) {
      S.gpsLost = true;
      setNavNote('Signal GPS perdu');
      speak('Signal GPS perdu. Suivez la dernière consigne.');
    }
    off = S.gps.off;
    S.speed = S.gps.speed;
    if (!off) {
      // Entre deux relevés GPS (1 par seconde), on prolonge le mouvement pour que ce soit fluide.
      const ahead = Math.min(2, (t - S.gps.t) / 1000);
      const predicted = Math.min(R.total, S.gps.along + S.gps.speed * ahead);
      S.d += (predicted - S.d) * Math.min(1, dt * 3);
    }
  }

  if (off) {
    S.pos = [S.pos[0] + (S.gps.raw[0] - S.pos[0]) * Math.min(1, dt * 3), S.pos[1] + (S.gps.raw[1] - S.pos[1]) * Math.min(1, dt * 3)];
    if (S.gps.heading !== null) S.bearing = Geo.lerpAngle(S.bearing, S.gps.heading, Math.min(1, dt * 3));
  } else {
    S.pos = Geo.pointAt(R.coords, R.cum, S.d);
    if (R.total - S.d > 4) {
      const aheadPt = Geo.pointAt(R.coords, R.cum, S.d + 14);
      S.bearing = Geo.lerpAngle(S.bearing, Geo.bearing(S.pos, aheadPt), Math.min(1, dt * 4));
    }
  }

  vehicle.setLngLat(S.pos).setRotation(S.bearing);

  // Virage : c'est le moment où il faut voir le plus. À l'approche (150 m), la caméra se rapproche, se redresse
  // pour montrer le carrefour, regarde un peu plus loin que la voiture et pivote déjà vers la rue de sortie.
  // `approach` va de 0 (loin) à 1 (au carrefour) ; `leaving` garde ce cadrage quelques mètres après le virage.
  const cur = R.steps[i];
  const turnAhead = next && isTurn(next);
  if (turnAhead && next.exitBearing === undefined) {
    next.exitBearing = Geo.bearing(Geo.pointAt(R.coords, R.cum, next.start + 6), Geo.pointAt(R.coords, R.cum, next.start + 32));
  }
  const approach = turnAhead ? clamp(1 - toMan / 150, 0, 1) : 0;
  const leaving = i > 0 && isTurn(cur) ? clamp(1 - (S.d - cur.start) / 45, 0, 1) : 0;
  S.camK += (Math.max(approach, leaving) - S.camK) * Math.min(1, dt * 2.5);
  S.turn = turnAhead && toMan < 150 ? { approach, toMan, exit: next.exitBearing, step: next } : null;
  S.toMan = toMan;

  if (S.following) {
    const zoomT = 18.3 - clamp(S.speed / 33, 0, 1) * 2.3 + 0.9 * S.camK;
    const pitchT = 58 - 12 * S.camK; // plus incliné = beaucoup plus d'images aériennes à charger, donc moins fluide
    S.zoom += (zoomT - S.zoom) * Math.min(1, dt * 1.3);
    S.pitch += (pitchT - S.pitch) * Math.min(1, dt * 1.3);
    const bearingT = approach > 0 ? Geo.lerpAngle(S.bearing, next.exitBearing, 0.4 * approach) : S.bearing;
    S.camBearing = Geo.lerpAngle(S.camBearing, bearingT, Math.min(1, dt * 3));
    const center = !off && S.camK > 0.03 ? Geo.pointAt(R.coords, R.cum, S.d + 28 * S.camK) : S.pos;
    // Quand la photo apparaît ou disparaît, la carte se décale progressivement au lieu de sauter.
    S.padTop += (S.padTarget - S.padTop) * Math.min(1, dt * 3);
    map.jumpTo({ center, bearing: S.camBearing, zoom: S.zoom, pitch: S.pitch, padding: { top: S.padTop, bottom: 0, left: 0, right: 0 } });
  }

  if (t - S.lastUi > 200) {
    S.lastUi = t;
    updateUi(i, next, toMan);
  }

  if (R.total - S.d < (S.sim ? 2 : 18) && !off) return arrive();
  S.raf = requestAnimationFrame(frame);
}

const ui = {}; // dernier contenu affiché, pour ne toucher au DOM que si ça change
function setHtml(id, html) {
  if (ui[id] !== html) { ui[id] = html; $(id).innerHTML = html; }
}

function updateUi(i, next, toMan) {
  const R = S.route;
  // Griser la partie déjà parcourue oblige la carte à redessiner tout le tracé : une fois par seconde suffit.
  const nowMs = performance.now();
  if (nowMs - (S.lastGradient || 0) > 1000 && map.getLayer('route-line')) {
    S.lastGradient = nowMs;
    map.setPaintProperty('route-line', 'line-gradient', progressGradient(S.d / R.total));
  }

  if (next) {
    // À l'approche d'un rond-point, on va chercher toutes ses sorties dans la carte (au plus une fois par seconde).
    if (next.roundabout && toMan < 350 && !next.roundabout.full && performance.now() - (next.roundabout.at || 0) > 1000) {
      next.roundabout.at = performance.now();
      completeRoundabout(next);
    }
    setHtml('man-icon', stepIcon(next, 80));
    setHtml('man-dist', fmtDist(toMan));
    setHtml('man-text', escapeHtml(next.act));
    setHtml('man-road', next.road && next.act !== next.text ? escapeHtml(next.road) : '');
    // Panneau façon signalisation : numéro de sortie et directions (surtout sur voie rapide et autoroute).
    const sign = (next.exitNo ? '<b>Sortie ' + escapeHtml(next.exitNo) + '</b>' : '') + next.dest.slice(next.name ? 0 : 1).map((d) => '<span>' + escapeHtml(d) + '</span>').join('');
    setHtml('sign', sign);
    $('sign').hidden = !sign;
    // Voies : affichées tôt (2 km sur voie rapide, 600 m ailleurs) pour avoir le temps de se placer,
    // avec la consigne en clair à côté des flèches.
    const fast = /ramp|fork|merge/.test(next.type) || S.speed > 22;
    const advice = placeAdvice(next);
    const lanes = toMan < (fast ? 2000 : 600)
      ? (next.lanes && next.lanes.length > 1 ? '<div class="lane-row">' + lanesHtml(next.lanes) + '</div>' : '') +
        (advice && next.lanes && next.lanes.length > 1 ? '<div class="lane-advice">' + escapeHtml(advice) + '</div>' : '')
      : '';
    setHtml('lanes', lanes);
    $('lanes').hidden = !lanes;
    announce(i + 1, next, toMan);

    // Jauge d'approche : elle se remplit sur les 300 derniers mètres et devient blanche quand c'est maintenant.
    const bar = $('approach-fill');
    bar.style.width = (clamp(1 - toMan / 300, 0, 1) * 100).toFixed(0) + '%';
    bar.classList.toggle('now', toMan < 40);

    // Dans un rond-point : décompte en direct des sorties à laisser passer.
    const here = R.steps[i];
    if (here.roundabout && here.roundabout.alongs) {
      const left = here.roundabout.alongs.filter((a) => a > S.d - here.start + 4).length;
      setHtml('man-road', left ? '' : escapeHtml(next.road));
      setHtml('man-text', left ? 'Laissez passer ' + left + (left > 1 ? ' sorties' : ' sortie') + ', puis sortez' : 'Prenez la prochaine sortie');
      if (left === 0 && S.rbSaid !== i) {
        S.rbSaid = i;
        if (here.roundabout.alongs.length) speak('Prenez la prochaine sortie' + (next.road ? ', ' + next.road : '') + '.', true);
      }
    }

    // Après chaque virage, une confirmation : on est sur la bonne route, et pour combien de temps.
    if (i !== S.lastStep) {
      const st = R.steps[i];
      if (S.lastStep !== undefined && i > 0 && toMan > 500 && st.type !== 'depart' && !S.spoken[i + 1]) {
        speak('Continuez' + (st.name ? ' sur ' + st.name : '') + ' pendant ' + fmtDistSpoken(toMan) + '.');
      }
      S.lastStep = i;
    }
    // Une alerte mise en attente passe dès que la voix est libre.
    if (S.alertQueue && !(speechSynthesis.speaking || speechSynthesis.pending)) {
      speak(S.alertQueue);
      S.alertQueue = '';
    }

    if (!S.note) {
      const after = R.steps[i + 2];
      const soon = after && !after.type.startsWith('exit') && after.type !== 'arrive' && after.start - next.start < 160 && toMan < 400;
      $('then').hidden = !soon;
      if (soon) setHtml('then', '<span class="then-icon">' + stepIcon(after, 22) + '</span> Puis ' + escapeHtml(lowerFirst(after.text)));
    }
  }
  updateManeuver(i, next, toMan);

  // Arrivée estimée, temps et distance restants, vitesse.
  const st = R.steps[i];
  const frac = st.distance > 0 ? clamp((S.d - st.start) / st.distance, 0, 1) : 1;
  let left = Math.max(0, R.duration - (st.tStart + st.duration * frac));
  // Sans données de trafic, on corrige l'heure d'arrivée avec ce qu'on constate : si le trajet avance
  // plus lentement que prévu (bouchon, feux), le temps restant est allongé dans la même proportion.
  if (!S.sim) {
    const elapsed = (nowMs - S.navT0) / 1000;
    const planned = S.planAtStart - left; // temps que le trajet déjà fait aurait dû prendre
    if (elapsed > 90 && planned > 45) S.pace += (clamp(elapsed / planned, 0.8, 2.5) - S.pace) * 0.05;
    left *= S.pace;
  }
  left += jamDelayAhead(); // retard des bouchons connus encore devant nous
  const eta = new Date(Date.now() + left * 1000);
  setHtml('eta', String(eta.getHours()).padStart(2, '0') + ':' + String(eta.getMinutes()).padStart(2, '0'));
  setHtml('remaining', fmtDuration(left) + ' · ' + fmtDist(R.total - S.d));
  setHtml('speed', '<b>' + Math.round(S.speed * 3.6) + '</b><span>km/h</span>');

  // Alertes et bouchons changent pendant qu'on roule : on les relit toutes les 3 minutes,
  // et on bascule sur un trajet plus rapide s'il en existe un (voir traffic.js).
  if (nowMs - (S.hazardsAt || 0) > 180000) { S.hazardsAt = nowMs; if (S.hazardsLoadedOnce) refreshTraffic(); S.hazardsLoadedOnce = true; }

  // Street View du prochain carrefour (si une clé Google est enregistrée).
  streetUpdate();
  updateGoogleView(i, next, toMan);
  // Le véhicule reste visible sous le bandeau et la photo : on décale le centre de la carte quand leur hauteur change.
  const topH = $('top').offsetHeight;
  if (Math.abs(topH - S.topH) > 6) {
    S.topH = topH;
    const free = window.innerHeight - topH - 170; // place restante entre la pile du haut et les cartes du bas
    const wantedY = topH + free * 0.6;             // hauteur à laquelle on veut voir le véhicule
    S.padTarget = Math.max(0, Math.round(2 * wantedY - window.innerHeight)); // appliqué en douceur dans frame()
  }

  // Alertes (accident, travaux, zone de danger…) puis recopie sur l'écran de la voiture.
  const alert = updateHazards();
  if (alert) carShow(alert.title, alert.sub);
  else if (next) {
    const when = toMan < 100 ? 'Maintenant' : 'Dans ' + fmtDist(toMan >= 1000 ? Math.round(toMan / 500) * 500 : toMan);
    carShow(when + ' · ' + next.text, 'Arrivée ' + ui.eta);
  }

  if (R.total - S.d < 300 && !S.photoShown) showPhoto();
}

// Dessine sur la chaussée la trajectoire du prochain virage.
function updateManeuver(i, next, toMan) {
  const src = map.getSource('maneuver');
  if (!src) return;
  const show = next && next.type !== 'arrive' && toMan < 260;
  const key = show ? String(i + 1) + ':' + S.route.total : '';
  if (key === S.manKey) return;
  S.manKey = key;
  if (!show) return src.setData(emptyFC);
  const R = S.route;
  // Rond-point : la flèche suit tout le parcours dans l'anneau, jusqu'à la sortie à prendre.
  const through = next.roundabout ? next.distance : 0;
  const line = Geo.slice(R.coords, R.cum, next.start - 40, next.start + through + 45);
  const end = line[line.length - 1];
  const b = Geo.bearing(line[line.length - 2], end);
  const head = [Geo.destination(end, b, 13), Geo.destination(end, b - 90, 8), Geo.destination(end, b + 90, 8)];
  head.push(head[0]);
  src.setData({
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: line } },
      { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [head] } },
    ],
  });
}

function arrive() {
  S.mode = 'arrived';
  S.speed = 0;
  cancelAnimationFrame(S.raf);
  setHtml('man-icon', stepIcon({ type: 'arrive' }, 80));
  $('sign').hidden = true;
  setHtml('man-dist', 'Arrivée');
  setHtml('man-text', escapeHtml(S.to?.label || 'Vous êtes arrivé'));
  setHtml('man-road', '');
  setHtml('speed', '<b>0</b><span>km/h</span>');
  $('lanes').hidden = true;
  $('then').hidden = true;
  $('stop').textContent = 'Terminer';
  map.getSource('maneuver')?.setData(emptyFC);
  speak('Vous êtes arrivé.', true);
  $('alert').hidden = true;
  document.body.classList.remove('has-alert');
  carShow('Vous êtes arrivé', S.to?.label || '');
  saveTrip(false);
  showPhoto();
}

function stopNav() {
  S.mode = 'plan';
  cancelAnimationFrame(S.raf);
  if (S.watchId !== null) navigator.geolocation.clearWatch(S.watchId);
  S.watchId = null;
  S.wake?.release?.().catch(() => {});
  S.wake = null;
  try { speechSynthesis.cancel(); } catch { /* rien */ }
  vehicle.remove();
  gsvReset();
  $('gsv-frame').src = 'about:blank';
  carStop();
  streetReset();
  $('alert').hidden = true;
  document.body.classList.remove('has-alert');
  map.getSource('maneuver')?.setData(emptyFC);
  S.manKey = '';
  setNavNote('');
  document.body.classList.remove('navigating');
  saveTrip(false);
  setDriveStyle(false);
  $('nav').hidden = true;
  $('planner').hidden = false;
  map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
  if (S.route) { drawRoute(); fitRoute(); }
}

$('start-nav').addEventListener('click', () => {
  if (!navigator.geolocation) return setStatus('Pas de GPS sur cet appareil : utilisez « Simuler ».', true);
  startNav(false);
});
$('start-sim').addEventListener('click', () => startNav(true));
$('stop').addEventListener('click', stopNav);
$('recenter').addEventListener('click', () => {
  S.following = true;
  S.camBearing = S.bearing;
  $('recenter').hidden = true;
  if (S.mode === 'arrived') map.easeTo({ center: S.pos, bearing: S.bearing, zoom: 17.5, pitch: 60 });
});
$('mute').addEventListener('click', () => {
  S.muted = !S.muted;
  $('mute').textContent = S.muted ? '🔇' : '🔊';
  if (S.muted) try { speechSynthesis.cancel(); } catch { /* rien */ }
});
// Simulation : l'utilisateur choisit lui-même la vitesse du véhicule, en km/h, et peut mettre en pause.
// « Auto » (0) = la vitesse normale de chaque route, avec ralentissement avant les virages.
function simShow() {
  $('sim-x').textContent = S.simKmh ? S.simKmh + ' km/h' : 'Auto';
  $('sim-pause').textContent = S.simPaused ? '▶' : '⏸';
  $('sim-minus').disabled = !S.simKmh;
  $('sim-plus').disabled = S.simKmh >= 200;
  $('sim-mult').textContent = '×' + S.simMult;
}
function simStep(dir) {
  // Depuis « Auto », on part de la vitesse actuelle arrondie à la dizaine.
  const base = S.simKmh || Math.round((S.speed * 3.6) / 10) * 10;
  const next = base + dir * 10;
  S.simKmh = !S.simKmh && dir < 0 ? 0 : next < 10 ? 0 : Math.min(200, next);
  simShow();
}
$('sim-minus').addEventListener('click', () => simStep(-1));
$('sim-plus').addEventListener('click', () => simStep(1));
$('sim-x').addEventListener('click', () => { S.simKmh = 0; simShow(); }); // toucher la vitesse = retour en Auto
$('sim-pause').addEventListener('click', () => { S.simPaused = !S.simPaused; simShow(); });
// Les deux réglages se combinent : la vitesse en km/h est celle du véhicule (compteur, annonces),
// le multiplicateur fait simplement défiler le temps plus vite (×2 = le trajet passe deux fois plus vite).
const SIM_MULTS = [1, 2, 5, 10, 20];
$('sim-mult').addEventListener('click', () => {
  S.simMult = SIM_MULTS[(SIM_MULTS.indexOf(S.simMult) + 1) % SIM_MULTS.length] || 1;
  simShow();
});
// Quand on revient sur l'application, le verrou d'écran doit être redemandé.
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && S.mode === 'nav') {
    try { S.wake = await navigator.wakeLock?.request('screen'); } catch { /* rien */ }
    // Pendant que l'écran était éteint ou l'application en arrière-plan, le guidage était en pause.
    // On le signale et on redonne tout de suite la consigne en cours.
    if (S.hiddenAt && performance.now() - S.hiddenAt > 4000) {
      speak('Guidage repris.', true);
      repeatInstruction();
    }
  } else if (document.visibilityState === 'hidden') {
    S.hiddenAt = performance.now();
  }
});

// Redit la consigne en cours, avec la distance actuelle. Sert au retour sur l'application et quand on touche le bandeau.
function repeatInstruction() {
  if (S.mode !== 'nav' || !S.route) return;
  const i = stepIndexAt(S.d);
  const next = S.route.steps[i + 1];
  if (!next) return;
  const toMan = next.start - S.d;
  const place = placeAdvice(next);
  speak((toMan > 40 ? 'Dans ' + fmtDistSpoken(toMan) + ', ' + lowerFirst(next.text) : next.text) + (place ? '. ' + place : '') + '.');
}
$('banner').addEventListener('click', repeatInstruction);

// Plus de réseau : le guidage continue sur l'itinéraire déjà calculé, mais sans recalcul ni nouvelles alertes.
window.addEventListener('offline', () => {
  if (S.mode !== 'nav') return;
  setNavNote('Pas de réseau');
  speak('Connexion perdue. Le guidage continue, sans recalcul ni alertes.');
});
window.addEventListener('online', () => {
  if (S.mode !== 'nav') return;
  setNavNote('');
  speak('Connexion rétablie.');
});

// ---------------------------------------------------------------- Google Street View
// Les photos de rue libres étant trop inégales, on s'appuie sur Google Street View, de deux façons officielles :
//  - sans clé : un lien « Maps URLs » qui ouvre Street View au point voulu, tourné dans le sens de la marche ;
//  - avec la clé Google Maps de l'utilisateur (Maps Embed API) : Street View affiché dans l'application,
//    dans le repérage avant le départ et à l'approche de chaque carrefour pendant le guidage.
// La clé reste sur l'appareil (stockage local du navigateur) ; elle n'est envoyée qu'à Google.
function routeBearingAt(d) {
  const R = S.route;
  const a = Math.max(0, Math.min(R.total - 10, d));
  return Geo.bearing(Geo.pointAt(R.coords, R.cum, a), Geo.pointAt(R.coords, R.cum, a + 10));
}

function streetViewUrl(d) {
  const p = Geo.pointAt(S.route.coords, S.route.cum, d);
  return 'https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=' + p[1].toFixed(6) + ',' + p[0].toFixed(6) +
    '&heading=' + Math.round(routeBearingAt(d)) + '&pitch=0&fov=85';
}

function streetViewEmbedUrl(d) {
  const p = Geo.pointAt(S.route.coords, S.route.cum, d);
  return 'https://www.google.com/maps/embed/v1/streetview?key=' + encodeURIComponent(S.gkey) +
    '&location=' + p[1].toFixed(6) + ',' + p[0].toFixed(6) + '&heading=' + Math.round(routeBearingAt(d)) + '&pitch=0&fov=85';
}

// Endroit d'où l'on regarde une manœuvre : 35 m avant, ou juste avant l'arrivée.
const viewpointOf = (step) => {
  if (step.type === 'arrive') return S.route.total - 25;
  // Sortie, bretelle ou bifurcation : on recule de 150 m pour avoir les panneaux de direction dans le champ.
  return Math.max(0, step.start - (/ramp|fork|merge/.test(step.type) ? 150 : 35));
};
// Une étape où le conducteur doit choisir (virage, sortie, bretelle, rond-point, arrivée).
const isDecision = (step) => !step.type.startsWith('exit') && (step.type === 'arrive' || isTurn(step) || /ramp|fork|merge/.test(step.type));

// Affiche Street View au point `d` du trajet SANS quitter l'application : une vue plein écran avec un bouton Fermer.
// (Sans clé Google, on n'a pas le droit d'intégrer la vue : on ouvre alors Google dans un autre onglet.)
function showStreetView(d) {
  if (!S.gkey) { window.open(streetViewUrl(d), '_blank', 'noopener'); return; }
  $('svbox-frame').src = streetViewEmbedUrl(d);
  $('svbox').hidden = false;
}
$('svbox-close').addEventListener('click', () => {
  $('svbox').hidden = true;
  $('svbox-frame').src = 'about:blank';
});
// Les liens gardent leur adresse Google (utile sans clé), mais avec la clé le clic reste dans l'application.
for (const id of ['summary-sv', 'arrival-sv']) {
  $(id).addEventListener('click', (e) => {
    if (!S.gkey || !S.route) return;
    e.preventDefault();
    showStreetView(S.route.total - 25);
  });
}

// Appelé quand un itinéraire vient d'être calculé.
async function loadPhoto() {
  $('summary-sv').href = streetViewUrl(S.route.total - 25);
}
$('view-toggle').addEventListener('click', () => setRealView(!S.real));

// À l'arrivée (véhicule arrêté) : un bouton pour voir l'entrée.
function showPhoto() {
  S.photoShown = true;
  if (S.mode !== 'arrived') return;
  $('arrival-sv').href = streetViewUrl(S.route.total - 25);
  $('arrival').hidden = false;
}
$('arrival-close').addEventListener('click', () => { $('arrival').hidden = true; });

// Repérage : liste des carrefours du trajet, avec schéma, consigne et le vrai lieu dans Street View.
function buildRecon() {
  const R = S.route;
  const ul = $('recon-list');
  ul.innerHTML = '';
  R.steps.forEach((s, k) => {
    if (k === 0 || !isDecision(s)) return;
    const li = document.createElement('li');
    li.innerHTML =
      '<span class="recon-icon">' + stepIcon(s, 44) + '</span>' +
      '<span class="recon-text"><small>à ' + fmtDist(s.start) + '</small><b>' + escapeHtml(s.act) + '</b>' +
      (s.road && s.act !== s.text ? '<i>' + escapeHtml(s.road) + '</i>' : '') + '</span>';
    const a = document.createElement('a');
    a.className = 'btn';
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = 'Street View';
    a.href = streetViewUrl(viewpointOf(s));
    if (S.gkey) {
      // Avec la clé : la vue s'affiche dans l'application, en haut de la liste.
      a.addEventListener('click', (e) => {
        e.preventDefault();
        showStreetView(viewpointOf(s));
      });
    }
    li.appendChild(a);
    ul.appendChild(li);
  });
}
$('recon-btn').addEventListener('click', () => { buildRecon(); $('recon').hidden = false; });
$('recon-close').addEventListener('click', () => { $('recon').hidden = true; });

// Pendant le guidage, avec la clé : un APERÇU du prochain carrefour.
// Une photo ne peut pas suivre une voiture qui roule (elle met une à trois secondes à se charger, et Google
// prend la photo la plus proche du point demandé, pas ce point exact). On n'essaie donc pas de montrer
// « ce que vous voyez maintenant » : on montre une seule image fixe de l'endroit où il faudra tourner,
// présentée comme telle, avec la flèche à suivre et la distance qui décompte. Elle ne change pas en route.
const gsv = { step: -1, requested: false, loaded: false };

function gsvReset() {
  gsv.step = -1; gsv.requested = false; gsv.loaded = false;
  $('gsv').hidden = true;
}

function updateGoogleView(i, next, toMan) {
  const ok = !!S.gkey && S.gsvOn && next && isDecision(next) && next.type !== 'arrive' && !S.route.steps[i].roundabout;
  if (!ok) { if (gsv.step !== -1) gsvReset(); return; }
  if (gsv.step !== i + 1) { gsvReset(); gsv.step = i + 1; }

  const fast = /ramp|fork|merge/.test(next.type);
  const shownFrom = fast ? 800 : 300;                                             // distance à laquelle l'aperçu apparaît
  const lead = Math.max(150, S.speed * (S.sim ? S.simMult : 1) * 8);              // avance pour le charger (8 s de route)
  if (toMan < 30) { $('gsv').hidden = true; return; }                             // on y est : les yeux sur la route
  if (toMan > shownFrom + lead) return;

  if (!gsv.requested) {
    gsv.requested = true;
    const step = gsv.step;
    const frame = $('gsv-frame');
    frame.onload = () => { if (gsv.step === step) gsv.loaded = true; };
    // Point de vue : juste avant la manœuvre, jamais derrière la voiture.
    frame.src = streetViewEmbedUrl(Math.max(S.d + 10, viewpointOf(next)));
    setHtml('gsv-icon', stepIcon(next, 52));
    setHtml('gsv-what', fast ? 'Aperçu de la sortie' : next.roundabout ? 'Aperçu du rond-point' : 'Aperçu du carrefour');
    setHtml('gsv-text', escapeHtml(next.act + (next.road && next.act !== next.text ? ' · ' + next.road : '')));
  }
  if (gsv.loaded && toMan <= shownFrom) {
    setHtml('gsv-dist', 'dans ' + fmtDist(toMan));
    $('gsv').hidden = false;
  }
}

$('gsv-toggle').checked = S.gsvOn;
$('gsv-toggle').addEventListener('change', (e) => {
  S.gsvOn = e.target.checked;
  try { localStorage.setItem('gsvOn', S.gsvOn ? '1' : '0'); } catch { /* stockage indisponible */ }
  if (!S.gsvOn) gsvReset();
});

// Réglage de la clé Google Maps.
$('gkey').value = S.gkey;
$('gkey-state').textContent = window.CAP_CONFIG && window.CAP_CONFIG.googleKey
  ? 'La clé est fournie par l\'application : rien à saisir.'
  : S.gkey ? 'Une clé est enregistrée sur cet appareil.' : 'Aucune clé enregistrée sur cet appareil.';
function saveGoogleKey(value) {
  S.gkey = value.trim();
  $('gkey').value = S.gkey;
  try { localStorage.setItem('gkey', S.gkey); } catch { /* stockage indisponible */ }
  $('gkey-state').textContent = S.gkey ? 'Clé enregistrée sur cet appareil. Ouvrez « Repérer les carrefours » pour voir Street View.' : 'Clé retirée.';
}
$('gkey-paste').addEventListener('click', async () => {
  try {
    const text = (await navigator.clipboard.readText()).trim();
    // Une clé Google Maps commence par « AIza » : on évite d'enregistrer par erreur un autre texte copié.
    if (!/^AIza[\w-]{20,}$/.test(text)) { $('gkey-state').textContent = 'Le presse-papiers ne contient pas une clé Google (elle commence par « AIza »). Copiez-la d\'abord depuis la page Google.'; return; }
    saveGoogleKey(text);
  } catch {
    $('gkey-state').textContent = 'Lecture du presse-papiers refusée : collez la clé dans le champ (appui long → Coller), puis « Enregistrer ».';
  }
});
$('gkey-save').addEventListener('click', () => saveGoogleKey($('gkey').value));

// ---------------------------------------------------------------- diagnostic (pour déboguer sur le téléphone)
// Sur iPhone on n'a pas de console : ce journal garde les erreurs et l'état du GPS, de la voix et du réseau.
// Il s'affiche avec le bouton « Diagnostic » et peut être copié pour être transmis.
const DIAG = [];
function diag(msg) {
  DIAG.push(new Date().toTimeString().slice(0, 8) + ' ' + msg);
  if (DIAG.length > 200) DIAG.shift();
}
window.addEventListener('error', (e) => diag('ERREUR ' + e.message + ' (' + (e.filename || '').split('/').pop() + ':' + e.lineno + ')'));
window.addEventListener('unhandledrejection', (e) => diag('ERREUR ' + (e.reason && e.reason.message ? e.reason.message : e.reason)));
window.addEventListener('offline', () => diag('réseau perdu'));
window.addEventListener('online', () => diag('réseau rétabli'));
document.addEventListener('visibilitychange', () => diag('écran ' + document.visibilityState));

function diagReport() {
  const installed = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const lines = [
    'Cap — diagnostic du ' + new Date().toLocaleString('fr-FR'),
    'Appareil : ' + navigator.userAgent,
    'Écran : ' + window.innerWidth + '×' + window.innerHeight + ', installée : ' + (installed ? 'oui' : 'non'),
    'Connexion sécurisée (https) : ' + (window.isSecureContext ? 'oui' : 'NON — le GPS sera refusé'),
    'GPS : ' + ('geolocation' in navigator ? 'disponible' : 'ABSENT') + ', relevés reçus : ' + (S.fixCount || 0) +
      (S.lastAccuracy ? ', précision ' + Math.round(S.lastAccuracy) + ' m' : ''),
    'Voix : ' + ('speechSynthesis' in window ? speechSynthesis.getVoices().filter((v) => v.lang.startsWith('fr')).length + ' voix françaises' : 'ABSENTE'),
    'Écran maintenu allumé : ' + ('wakeLock' in navigator ? (S.wake ? 'actif' : 'disponible') : 'NON GÉRÉ'),
    'Réseau : ' + (navigator.onLine ? 'connecté' : 'HORS LIGNE'),
    'Clé Google : ' + (S.gkey ? 'enregistrée' : 'aucune'),
    'Trafic TomTom : ' + (ttKey() ? 'clé présente, ' + ttUsage(0) + ' demandes ce mois (limite ' + TT.monthlyCap + ')' : 'pas de clé'),
    'Mode : ' + S.mode + (S.route ? ', trajet de ' + fmtDist(S.route.total) + ', ' + S.hazards.length + ' alertes' : ', pas de trajet'),
    '--- journal ---',
  ];
  return lines.concat(DIAG.length ? DIAG : ['(rien à signaler)']).join('\n');
}
$('diag-btn').addEventListener('click', () => {
  $('diag').textContent = diagReport();
  $('diag').hidden = false;
  $('diag-copy').hidden = false;
});
$('diag-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(diagReport()); $('diag-copy').textContent = 'Copié'; } catch { $('diag-copy').textContent = 'Copie impossible : sélectionnez le texte'; }
});

// ---------------------------------------------------------------- reprise après rechargement
// Si la page est rechargée (ou l'application fermée puis rouverte), on ne perd pas le trajet :
// départ, arrivée et « guidage en cours » sont gardés sur l'appareil pendant 12 heures.
function saveTrip(navigating) {
  try {
    if (!S.to) { localStorage.removeItem('trip'); return; }
    localStorage.setItem('trip', JSON.stringify({
      at: Date.now(), to: S.to, from: S.from && !S.from.gps ? S.from : null, // départ « ma position » : on relocalisera
      navigating: !!navigating, sim: !!S.sim,
    }));
  } catch { /* stockage indisponible */ }
}

async function restoreTrip() {
  let trip = null;
  try { trip = JSON.parse(localStorage.getItem('trip') || 'null'); } catch { /* rien à reprendre */ }
  if (!trip || !trip.to || Date.now() - trip.at > 12 * 3600 * 1000) return;
  S.to = trip.to;
  $('to').value = trip.to.label;
  if (trip.from) { S.from = trip.from; $('from').value = trip.from.label; }
  await planRoute();
  if (trip.navigating && S.route) {
    // Le guidage était en cours : un seul appui pour repartir (la voix exige un geste de l'utilisateur).
    S.resumeSim = trip.sim;
    $('resume-nav').hidden = false;
    saveTrip(true);
  }
}
$('resume-nav').addEventListener('click', () => { $('resume-nav').hidden = true; startNav(!!S.resumeSim); });
window.addEventListener('load', restoreTrip);

// ---------------------------------------------------------------- application installable
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

window.cap = { S, map }; // pratique pour déboguer dans la console
