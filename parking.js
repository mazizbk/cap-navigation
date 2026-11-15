'use strict';
/* Se garer à l'arrivée, et coût en carburant de chaque trajet.
 * Chargé après extras.js : utilise S, $, map, Geo, Places, goTo, bestRoute, useRoute, FUEL_URL… définis avant.
 *
 * Parkings : leur position vient des tuiles de la carte (rapide et fiable). Le fait qu'ils soient gratuits ou payants
 * vient d'OpenStreetMap, par un service plus lent et parfois indisponible : quand il ne répond pas, on l'écrit
 * (« tarif non indiqué ») au lieu de deviner. Les parkings gratuits sont toujours proposés en premier.
 */

// ================================================================= parkings près de l'arrivée
let dataMap = null; // petite carte invisible, qui sert seulement à lire les tuiles autour de la destination

function tilesAround(lon, lat, cls = 'parking') {
  return new Promise((resolve) => {
    const done = () => {
      const seen = new Set();
      const out = [];
      for (const f of dataMap.querySourceFeatures('omt', { sourceLayer: 'poi' })) {
        if (f.properties.class !== cls || !f.geometry || f.geometry.type !== 'Point') continue;
        const [x, y] = f.geometry.coordinates;
        const id = x.toFixed(5) + ',' + y.toFixed(5);
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ lon: x, lat: y, name: f.properties.name || '' });
      }
      resolve(out);
    };
    const timer = setTimeout(done, 9000); // réseau lent : on rend ce qu'on a
    const go = () => {
      dataMap.jumpTo({ center: [lon, lat], zoom: 14 });
      dataMap.once('idle', () => { clearTimeout(timer); done(); });
    };
    if (dataMap) { go(); return; }
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;left:-900px;top:0;width:520px;height:520px;visibility:hidden;pointer-events:none;';
    document.body.appendChild(el);
    const src = map.getStyle().sources.openmaptiles;
    dataMap = new maplibregl.Map({
      container: el, interactive: false, attributionControl: false, center: [lon, lat], zoom: 14,
      style: { version: 8, sources: { omt: { type: 'vector', url: src.url } },
        layers: [{ id: 'poi', type: 'circle', source: 'omt', 'source-layer': 'poi', paint: { 'circle-opacity': 0 } }] },
    });
    dataMap.once('load', go);
  });
}

// Détails (gratuit ou payant, accès réservé, nombre de places) : notre base, fabriquée chaque semaine à partir
// d'OpenStreetMap et publiée avec le site, découpée en carrés de 0,1°. On ne charge que les carrés autour de l'arrivée.
const PARK_BASE = /^(localhost|127\.|\[::1\])/.test(location.host) ? 'https://mazizbk.github.io/cap-navigation/data/parking/' : 'data/parking/';
const parkCells = {};
async function parkingDetails(lon, lat) {
  const keys = new Set();
  for (const dy of [-0.009, 0.009]) for (const dx of [-0.013, 0.013]) keys.add(Math.floor((lat + dy) * 10) + '_' + Math.floor((lon + dx) * 10));
  let ok = false;
  const out = [];
  await Promise.all([...keys].map(async (k) => {
    if (!(k in parkCells)) {
      try {
        const res = await fetch(PARK_BASE + k + '.json', { signal: AbortSignal.timeout(8000) });
        if (res.ok) parkCells[k] = await res.json();
        else if (res.status === 404) parkCells[k] = (await baseExists()) ? [] : null; // carré vide, ou base pas encore publiée
      } catch { /* réseau : on réessaiera */ }
    }
    if (parkCells[k]) { ok = true; out.push(...parkCells[k]); }
  }));
  if (!ok) return null;
  return out.map((r) => ({ lon: r[0], lat: r[1], fee: r[2], restricted: !!r[3], customers: !!r[4], capacity: r[5], kind: r[6], name: r[7] }));
}
// La base est-elle en ligne ? (un carré de Paris existe forcément)
let baseKnown = null;
async function baseExists() {
  if (baseKnown === null) {
    try { baseKnown = (await fetch(PARK_BASE + '488_23.json', { method: 'HEAD', signal: AbortSignal.timeout(8000) })).ok; } catch { return false; }
  }
  return baseKnown;
}

// Parkings à moins de 700 m de `dest`, gratuits d'abord, puis du plus proche au plus loin.
async function parkingsNear(dest) {
  const here = [dest.lon, dest.lat];
  const [tiles, details] = await Promise.all([tilesAround(dest.lon, dest.lat), parkingDetails(dest.lon, dest.lat)]);
  const list = [];
  for (const p of tiles) {
    const dist = Geo.distance(here, [p.lon, p.lat]);
    if (dist > 700) continue;
    const item = { ...p, dist, fee: 'unknown', capacity: 0, kind: '', restricted: /r[ée]sidence|priv[ée]|personnel|r[ée]serv|livraison|\bcars?\b|\bbus\b|minute|taxi|ambulance/i.test(p.name) };
    if (details) {
      let best = null;
      let bestD = 45;
      for (const d of details) { const dd = Geo.distance([p.lon, p.lat], [d.lon, d.lat]); if (dd < bestD) { bestD = dd; best = d; } }
      if (best) {
        item.fee = best.fee === 1 ? 'free' : best.fee === 2 ? 'paid' : 'unknown';
        if (best.restricted) item.restricted = true;
        item.customers = best.customers;
        item.capacity = best.capacity || 0;
        item.kind = best.kind || '';
        if (!item.name && best.name) item.name = best.name;
      }
    }
    if (!item.restricted) list.push(item);
  }
  // Plusieurs poches d'un même parking, à quelques dizaines de mètres : on n'en garde qu'une par tarif.
  for (let i = list.length - 1; i > 0; i--) {
    if (list.slice(0, i).some((o) => o.fee === list[i].fee && Geo.distance([o.lon, o.lat], [list[i].lon, list[i].lat]) < 70)) list.splice(i, 1);
  }
  const rank = { free: 0, unknown: 1, paid: 2 };
  list.sort((a, b) => a.dist - b.dist);
  // Gratuit et ouvert à tous d'abord ; puis gratuit mais réservé aux clients ; puis tarif inconnu ; payant en dernier.
  const order = (p) => (p.fee === 'free' ? (p.customers ? 1 : 0) : p.fee === 'unknown' ? 2 : 3);
  list.sort((a, b) => order(a) - order(b) || a.dist - b.dist);
  return { list, feesKnown: !!details };
}

const walk = (m) => { const w = m * 1.3; return fmtDist(w) + ' à pied (' + Math.max(1, Math.round(w / 75)) + ' min)'; };
const FEE_LABEL = { free: 'Gratuit', paid: 'Payant', unknown: 'Tarif non indiqué' };

async function openParking() {
  const dest = S.finalDest || S.to;
  $('park').hidden = false;
  $('park-list').innerHTML = '';
  if (!dest) { $('park-info').textContent = 'Choisissez d\'abord une destination.'; return null; }
  $('park-info').textContent = 'Recherche des parkings près de ' + dest.label.split(',')[0] + '…';
  const { list, feesKnown } = await parkingsNear(dest);
  S.parkings = list;
  if (!list.length) { $('park-info').textContent = 'Aucun parking public trouvé à moins de 700 m de l\'arrivée.'; return null; }
  const free = list.filter((p) => p.fee === 'free').length;
  $('park-info').textContent = list.length + ' parkings à moins de 700 m de ' + dest.label.split(',')[0] + '. ' +
    (feesKnown ? (free ? free + ' gratuit' + (free > 1 ? 's' : '') + ', en premier.' : 'Aucun n\'est indiqué comme gratuit.') : 'Le service qui indique s\'ils sont gratuits ne répond pas pour l\'instant : tarifs inconnus.') +
    ' Données OpenStreetMap, à vérifier sur place.';
  list.slice(0, 12).forEach((p, k) => {
    const li = document.createElement('li');
    if (k === 0) li.className = 'fuel-top';
    li.innerHTML = '<span class="park-fee park-' + p.fee + '">' + FEE_LABEL[p.fee] + '</span>' +
      '<span class="fuel-text"><b>' + escapeHtml(p.name || 'Parking') + '</b><span>' + walk(p.dist) + ' de l\'arrivée' +
      (p.kind ? ' · ' + p.kind : '') + (p.capacity ? ' · ' + p.capacity + ' places' : '') + (p.customers ? ' · réservé aux clients' : '') + '</span></span>';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn';
    b.textContent = 'Y aller';
    b.addEventListener('click', () => goToParking(p));
    li.appendChild(b);
    $('park-list').appendChild(li);
  });
  return list[0];
}

async function goToParking(p) {
  $('park').hidden = true;
  const dest = S.finalDest || S.to;
  const place = { label: (p.name || 'Parking') + ' (près de ' + dest.label.split(',')[0] + ')', lon: p.lon, lat: p.lat };
  if (S.mode === 'nav' && S.pos) {
    S.finalDest = dest;
    S.to = { ...place, full: place.label };
    $('to').value = place.label;
    try {
      useRoute(await bestRoute({ lon: S.pos[0], lat: S.pos[1] }, S.to, true));
      destMarker.setLngLat([S.to.lon, S.to.lat]);
      speak('Itinéraire vers le parking, à ' + walk(p.dist) + ' de l\'arrivée.', true);
      saveTrip(true);
    } catch { setNavNote('Itinéraire vers le parking impossible'); }
  } else {
    goTo(place);
    S.finalDest = dest; // pour pouvoir chercher un autre parking autour de la vraie destination
  }
}

$('park-btn').addEventListener('click', openParking);
$('park-close').addEventListener('click', () => { $('park').hidden = true; });

// ================================================================= coût en carburant
// Consommation de la voiture (L/100 km), réglable, et prix moyen du SP95-E10 autour du départ.
const Cost = {
  conso() { const v = parseFloat(readStore('conso')); return v > 2 && v < 25 ? v : 6.0; },
  price: 1.9,
  priceKnown: false,
  // La consommation dépend de l'allure : plus en ville et à 130 qu'à 90.
  factor(kmh) { return kmh < 35 ? 1.35 : kmh < 60 ? 1.1 : kmh < 95 ? 0.9 : kmh < 115 ? 1.0 : 1.2; },
  litres(R) { return (R.total / 100000) * this.conso() * this.factor((R.total / Math.max(1, R.duration)) * 3.6); },
  euros(R) { return this.litres(R) * this.price; },
};

async function loadFuelPrice(lon, lat) {
  try {
    const params = new URLSearchParams({
      select: 'avg(e10_prix) as p', where: "within_distance(geom, geom'POINT(" + lon.toFixed(4) + ' ' + lat.toFixed(4) + ")', 15km) and e10_prix is not null",
    });
    const res = await fetch(FUEL_URL + '?' + params, { signal: AbortSignal.timeout(10000) });
    const p = res.ok ? Number(((await res.json()).results || [{}])[0].p) : 0;
    if (p > 1 && p < 3.5) { Cost.price = p; Cost.priceKnown = true; }
  } catch { /* on garde le prix par défaut */ }
}

// Le trajet le moins gourmand parmi ceux proposés.
function cheapestRoute() {
  const alts = S.alts || [];
  return alts.length ? alts.reduce((a, b) => (Cost.euros(b) < Cost.euros(a) ? b : a)) : null;
}

function showTripCost() {
  const R = S.route;
  const box = $('trip-cost');
  if (!R) { box.hidden = true; return; }
  const eco = cheapestRoute();
  box.hidden = false;
  box.innerHTML = '⛽ Carburant ≈ <b>' + Cost.euros(R).toFixed(Cost.euros(R) < 10 ? 1 : 0).replace('.', ',') + ' €</b> (' + Cost.litres(R).toFixed(1).replace('.', ',') + ' L)' +
    (R.toll ? ' · péage en plus' : '') + (eco === R && (S.alts || []).length > 1 ? ' · <b class="eco">le plus économique</b>' : '') +
    '<br><button type="button" id="conso-edit" class="linklike">' + String(Cost.conso()).replace('.', ',') + ' L/100 km · SP95-E10 à ' + Cost.price.toFixed(2).replace('.', ',') + ' €' +
    (Cost.priceKnown ? ' (moyenne près du départ)' : ' (prix estimé)') + ' — modifier</button>';
  $('conso-edit').addEventListener('click', () => {
    const v = window.prompt('Consommation de la voiture, en litres aux 100 km :', String(Cost.conso()).replace('.', ','));
    const n = v ? parseFloat(v.replace(',', '.')) : NaN;
    if (n > 2 && n < 25) { try { localStorage.setItem('conso', String(n)); } catch { /* stockage indisponible */ } renderRouteChoices(); }
  });
  // Coût et repère « éco » sur chaque variante.
  document.querySelectorAll('#route-choices .choice').forEach((b, k) => {
    const alt = (S.alts || [])[k];
    if (!alt || b.querySelector('.cost')) return;
    const s = document.createElement('span');
    s.className = 'cost';
    s.textContent = '≈ ' + Math.round(Cost.euros(alt)) + ' €' + (alt === eco ? ' · éco' : '');
    b.appendChild(s);
  });
}

// Appelé par afterPlan (extras.js) : prix moyen autour du départ, puis affichage.
async function afterPlanCost() {
  S.finalDest = null;
  $('park-btn').hidden = false;
  showTripCost();
  const start = S.route && S.route.coords[0];
  if (start && !Cost.priceKnown) { await loadFuelPrice(start[0], start[1]); if (S.route) renderRouteChoices(); }
}

// ================================================================= position exacte d'une station-service
// Le fichier officiel des prix donne parfois une position arrondie (à 100 m près, voire de l'autre côté de la rue).
// Avant de guider vers une station, on la recale sur la station dessinée sur la carte la plus proche (à 300 m au plus).
async function refineStation(st) {
  try {
    const here = [st.lon, st.lat];
    let best = null;
    let bestD = 300;
    for (const p of await tilesAround(st.lon, st.lat, 'fuel')) {
      const d = Geo.distance(here, [p.lon, p.lat]);
      if (d < bestD) { bestD = d; best = p; }
    }
    if (best) { diag('station recalée de ' + Math.round(bestD) + ' m' + (best.name ? ' (' + best.name + ')' : '')); return { ...st, lon: best.lon, lat: best.lat, brand: best.name || '' }; }
  } catch { /* on garde la position officielle */ }
  return st;
}
