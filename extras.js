'use strict';
/* Recherche confortable et carburant.
 * Chargé après app.js et traffic.js : utilise S, $, map, Geo, planRoute, bestRoute, useRoute… définis là-bas.
 *   - suggestions d'adresses pendant la frappe (Photon, données OpenStreetMap) ;
 *   - lieux enregistrés : Domicile, Travail, destinations récentes ;
 *   - stations-service : prix du SP95 / SP95-E10, la moins chère et la plus proche (données officielles
 *     du ministère de l'Économie, déclarées par les stations).
 */

// ================================================================= lieux enregistrés
const Places = {
  read() { try { return JSON.parse(localStorage.getItem('places') || '{}'); } catch { return {}; } },
  write(p) { try { localStorage.setItem('places', JSON.stringify(p)); } catch { /* stockage indisponible */ } },
  set(kind, place) {
    const p = this.read();
    p[kind] = { label: place.label, lon: place.lon, lat: place.lat };
    this.write(p);
    renderShortcuts();
  },
  addRecent(place) {
    const p = this.read();
    const list = (p.recents || []).filter((r) => Geo.distance([r.lon, r.lat], [place.lon, place.lat]) > 60);
    list.unshift({ label: place.label, lon: place.lon, lat: place.lat });
    p.recents = list.slice(0, 5);
    this.write(p);
    renderShortcuts();
  },
};

function goTo(place) {
  S.to = { label: place.label, full: place.label, lon: place.lon, lat: place.lat };
  $('to').value = place.label;
  $('results').hidden = true;
  planRoute();
}

// Raccourcis sous les champs : Domicile, Travail, puis les dernières destinations.
function renderShortcuts() {
  const p = Places.read();
  const box = $('shortcuts');
  box.innerHTML = '';
  const chip = (icon, text, place) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = icon + ' ' + text;
    b.addEventListener('click', () => goTo(place));
    box.appendChild(b);
  };
  const near = (a, b) => a && b && Geo.distance([a.lon, a.lat], [b.lon, b.lat]) < 60;
  if (p.home) chip('🏠', 'Domicile', p.home);
  if (p.work) chip('💼', 'Travail', p.work);
  for (const r of p.recents || []) {
    if (near(r, p.home) || near(r, p.work)) continue;
    const short = r.label.split(',')[0];
    chip('🕘', short.length > 22 ? short.slice(0, 21) + '…' : short, r);
  }
  box.hidden = !box.children.length;
  if (typeof Plus !== 'undefined') Plus.renderCarChip();
}

// Appelé par planRoute quand un itinéraire vient d'être calculé.
function afterPlan() {
  if (S.to) Places.addRecent(S.to);
  $('save-place').hidden = false;
  $('save-note').textContent = '';
  if (typeof afterPlanCost === 'function') afterPlanCost(); // coût en carburant, bouton « Se garer »
}
$('save-home').addEventListener('click', () => { if (S.to) { Places.set('home', S.to); $('save-note').textContent = 'Enregistré comme Domicile.'; } });
$('save-work').addEventListener('click', () => { if (S.to) { Places.set('work', S.to); $('save-note').textContent = 'Enregistré comme Travail.'; } });

// ================================================================= suggestions pendant la frappe
let suggestTimer = 0;
let suggestSeq = 0;

async function suggest(which, q) {
  const seq = ++suggestSeq;
  const home = Places.read().home;
  const c = home ? { lat: home.lat, lng: home.lon } : map.getCenter(); // on privilégie les résultats proches
  const url = 'https://photon.komoot.io/api/?lang=fr&limit=5&q=' + encodeURIComponent(q) + '&lat=' + c.lat.toFixed(3) + '&lon=' + c.lng.toFixed(3);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok || seq !== suggestSeq || $(which).value.trim() !== q) return; // une frappe plus récente a pris le relais
    const ul = $('results');
    ul.innerHTML = '';
    for (const f of (await res.json()).features || []) {
      const p = f.properties || {};
      const street = [p.housenumber, p.street].filter(Boolean).join(' ');
      const name = p.name || street;
      if (!name || !f.geometry) continue;
      const where = [p.name ? street : '', [p.postcode, p.city].filter(Boolean).join(' '), p.country !== 'France' ? p.country : ''].filter(Boolean).join(', ');
      const place = { label: [name, p.city].filter(Boolean).join(', '), full: name + (where ? ', ' + where : ''), lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] };
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = '<b>' + escapeHtml(name) + '</b>' + (where ? '<br><span>' + escapeHtml(where) + '</span>' : '');
      b.addEventListener('click', () => {
        S[which] = place;
        $(which).value = place.label;
        ul.hidden = true;
        if (which === 'to' || S.to) planRoute();
        else $('to').focus();
      });
      li.appendChild(b);
      ul.appendChild(li);
    }
    ul.hidden = !ul.children.length;
  } catch { /* pas de réseau : la touche Entrée lance toujours la recherche classique */ }
}

for (const which of ['from', 'to']) {
  $(which).addEventListener('input', () => {
    clearTimeout(suggestTimer);
    const q = $(which).value.trim();
    if (q.length < 3) return;
    suggestTimer = setTimeout(() => suggest(which, q), 350);
  });
}

// ================================================================= carburant (SP95 et SP95-E10)
const FUEL_URL = 'https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/prix-des-carburants-en-france-flux-instantane-v2/records';

// Stations autour de nous, ou devant nous sur le trajet si un guidage est en cours.
async function fuelStations() {
  const onRoute = S.mode === 'nav' && S.route;
  let where;
  let origin;
  let seg = null;
  let segCum = null;
  let d0 = 0;
  if (onRoute) {
    d0 = S.d;
    seg = Geo.slice(S.route.coords, S.route.cum, d0, Math.min(S.route.total, d0 + 20000)); // les 20 prochains km : on ne traverse pas la France pour quelques centimes
    segCum = Geo.cumulative(seg);
    let w = 180, s = 90, e = -180, n = -90;
    for (const c of seg) { if (c[0] < w) w = c[0]; if (c[0] > e) e = c[0]; if (c[1] < s) s = c[1]; if (c[1] > n) n = c[1]; }
    where = 'in_bbox(geom, ' + [s - 0.02, w - 0.02, n + 0.02, e + 0.02].map((v) => v.toFixed(4)).join(', ') + ')';
  } else {
    try { const me = await locate(); origin = [me.lon, me.lat]; } catch { const c = map.getCenter(); origin = [c.lng, c.lat]; }
    where = "within_distance(geom, geom'POINT(" + origin[0].toFixed(5) + ' ' + origin[1].toFixed(5) + ")', 10km)";
  }
  const params = new URLSearchParams({
    limit: '100', where: where + ' and (e10_prix is not null or sp95_prix is not null)',
    select: 'id,adresse,ville,cp,geom,e10_prix,e10_maj,sp95_prix,sp95_maj,horaires_automate_24_24',
  });
  const res = await fetch(FUEL_URL + '?' + params, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error('prix indisponibles (' + res.status + ')');
  const fresh = (iso) => iso && Date.now() - Date.parse(iso) < 30 * 86400000; // prix déclaré depuis moins de 30 jours
  const out = [];
  for (const r of (await res.json()).results || []) {
    if (!r.geom) continue;
    const pt = [r.geom.lon, r.geom.lat];
    const offers = [];
    if (r.e10_prix && fresh(r.e10_maj)) offers.push({ fuel: 'SP95-E10', price: Number(r.e10_prix), at: r.e10_maj });
    if (r.sp95_prix && fresh(r.sp95_maj)) offers.push({ fuel: 'SP95', price: Number(r.sp95_prix), at: r.sp95_maj });
    if (!offers.length) continue;
    offers.sort((a, b) => a.price - b.price);
    const st = { lon: pt[0], lat: pt[1], address: r.adresse || '', city: r.ville || '', open24: r.horaires_automate_24_24 === 'Oui', offers, price: offers[0].price, fuel: offers[0].fuel };
    if (onRoute) {
      const snap = Geo.snap(seg, segCum, pt);
      if (snap.dist > 1500 || snap.along < 150) continue; // trop loin du trajet, ou déjà dépassée
      st.dist = snap.along;      // distance à parcourir avant d'y arriver
      st.detour = snap.dist;     // écart par rapport au trajet
    } else {
      st.dist = Geo.distance(origin, pt);
    }
    out.push(st);
  }
  return { stations: out, onRoute };
}

function fuelScore(st, onRoute) {
  const detourKm = (onRoute ? 2 * st.detour : 2 * st.dist) / 1000;
  return st.price * 40 + detourKm * 0.065 * st.price; // 6,5 L/100 km en ville
}

async function openFuel() {
  $('fuel').hidden = false;
  $('fuel-info').textContent = 'Recherche des stations…';
  $('fuel-list').innerHTML = '';
  let data;
  try { data = await fuelStations(); } catch (e) { $('fuel-info').textContent = 'Impossible de lire les prix : ' + e.message; return; }
  const { stations, onRoute } = data;
  if (!stations.length) { $('fuel-info').textContent = onRoute ? 'Aucune station avec SP95 sur les 20 prochains kilomètres du trajet.' : 'Aucune station avec SP95 à moins de 10 km.'; return; }
  // « La moins chère » compte le détour : coût d'un plein de 40 L + carburant brûlé pour y aller et revenir sur sa route.
  for (const st of stations) st.score = fuelScore(st, onRoute);
  const cheapest = stations.reduce((a, b) => (b.score < a.score ? b : a));
  const nearest = stations.reduce((a, b) => (b.dist < a.dist ? b : a));
  $('fuel-info').textContent = stations.length + ' stations ' + (onRoute ? 'sur les 20 prochains km du trajet' : 'à moins de 10 km') + '. Prix déclarés par les stations (source : ministère de l\'Économie).';
  const euro = (v) => v.toFixed(3).replace('.', ',') + ' €';
  const item = (st, tag) => {
    const li = document.createElement('li');
    if (tag) li.className = 'fuel-top';
    const others = st.offers.slice(1).map((o) => o.fuel + ' ' + euro(o.price)).join(' · ');
    li.innerHTML =
      '<span class="fuel-price"><b>' + euro(st.price) + '</b><small>' + st.fuel + '</small></span>' +
      '<span class="fuel-text">' + (tag ? '<em>' + tag + '</em>' : '') +
      '<b>' + escapeHtml(st.address) + '</b><span>' + escapeHtml(st.city) + ' · ' + (onRoute ? 'dans ' + fmtDist(st.dist) + (st.detour > 150 ? ', à ' + fmtDist(st.detour) + ' du trajet' : ', sur le trajet') : 'à ' + fmtDist(st.dist)) +
      (st.open24 ? ' · 24 h/24' : '') + (others ? ' · ' + others : '') + '</span></span>';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn';
    b.textContent = 'Y aller';
    b.addEventListener('click', () => goToStation(st));
    li.appendChild(b);
    $('fuel-list').appendChild(li);
  };
  item(cheapest, cheapest === nearest ? 'La moins chère et la plus proche' : 'La moins chère près d’ici');
  if (nearest !== cheapest) item(nearest, 'La plus proche');
  for (const st of stations.filter((s) => s !== cheapest && s !== nearest).sort((a, b) => a.score - b.score).slice(0, 10)) item(st, '');
}

async function goToStation(st) {
  $('fuel').hidden = true;
  if (typeof refineStation === 'function') st = await refineStation(st); // position exacte, d'après la carte
  const place = { label: 'Station ' + (st.brand ? st.brand + ', ' : '') + (st.city || 'service') + ' (' + st.fuel + ')', lon: st.lon, lat: st.lat };
  if (S.mode === 'nav' && S.pos) {
    // En cours de guidage : la station devient une étape, la destination finale est gardée.
    try { await Copilot.stopAt(place, 'Direction la station'); } catch { setNavNote('Itinéraire vers la station impossible'); }
  } else goTo(place);
}

$('fuel-btn').addEventListener('click', openFuel);
$('fuel-nav').addEventListener('click', openFuel);
$('fuel-close').addEventListener('click', () => { $('fuel').hidden = true; });

renderShortcuts();

// ================================================================= réglage de la voix
// Liste les voix françaises de l'appareil, de la plus naturelle à la moins naturelle, et permet de les écouter.
async function fillVoices() {
  $('gtts-note').textContent = GVoice.key() ? (GVoice.on() ? 'Voix Google active : ' + GVoice.voice().replace('fr-FR-Chirp3-HD-', '') + '. Sans réseau, la voix du téléphone prend le relais.' : 'Voix Google en pause (clé refusée ou coupée).') : 'Pas de clé : voix du téléphone.';
  let google = [];
  try { google = await GVoice.list(); } catch (err) { $('gtts-note').textContent = 'Clé Google refusée : ' + err.message; }
  const native = Native && Native.hasVoice;
  const list = native ? await Native.voices() : webVoices().map((x) => ({ name: x.name, score: x.score }));
  const sel = $('voice-select');
  const current = GVoice.on() ? GVoice.voice() : native ? Native.voiceName() : (frVoice ? frVoice.name : '');
  sel.innerHTML = '';
  for (const g of google) {
    const o = document.createElement('option');
    o.value = 'g:' + g.name;
    o.textContent = g.name.replace('fr-FR-Chirp3-HD-', '') + (g.gender === 'MALE' ? ' (homme)' : ' (femme)') + ' — humaine, en ligne';
    o.selected = g.name === current;
    sel.appendChild(o);
  }
  for (const v of list) {
    const o = document.createElement('option');
    o.value = v.name;
    o.textContent = v.name + (v.score >= 60 ? ' — très naturelle' : v.score >= 40 ? ' — naturelle' : ' — ordinaire');
    o.selected = v.name === current;
    sel.appendChild(o);
  }
  const best = list[0] ? list[0].score : 0;
  $('voice-note').textContent = !list.length ? 'Aucune voix française trouvée sur cet appareil.'
    : best >= 40 ? 'Voix naturelle trouvée et utilisée : ' + (current || list[0].name) + '.'
    : 'Cet appareil n\'a que des voix ordinaires. Pour une voix humaine sur iPhone : Réglages › Accessibilité › Contenu énoncé › Voix › Français, téléchargez une voix « premium » (Audrey, Thomas…), puis revenez ici.';
}
async function applyVoice() {
  const val = $('voice-select').value;
  if (val.startsWith('g:')) { GVoice.setVoice(val.slice(2)); try { localStorage.setItem('gttsOn', '1'); localStorage.setItem('voiceRate', $('voice-rate').value); } catch { /* stockage */ } return; }
  if (GVoice.key()) { try { localStorage.setItem('gttsOn', '0'); } catch { /* stockage */ } }
  try { localStorage.setItem('voiceName', val); localStorage.setItem('voiceRate', $('voice-rate').value); } catch { /* stockage indisponible */ }
  if (Native && Native.hasVoice) await Native.useVoice(); else pickVoice();
}
$('voice-select').addEventListener('change', applyVoice);
$('voice-rate').addEventListener('change', applyVoice);
$('voice-rate').value = String(voiceRate());
$('voice-test').addEventListener('click', async () => {
  await applyVoice();
  const was = S.muted;
  S.muted = false;
  speak('Dans 300 mètres, au rond-point, prenez la deuxième sortie vers la rue de Nantes.', true);
  S.muted = was;
});
$('voice-on').checked = !S.muted;
$('voice-on').addEventListener('change', (ev) => setMuted(!ev.target.checked));
$('voice-settings').addEventListener('toggle', () => { if ($('voice-settings').open) fillVoices(); });
if ('speechSynthesis' in window) speechSynthesis.addEventListener('voiceschanged', () => { if ($('voice-settings').open) fillVoices(); });
// Quand on revient des Réglages de l'iPhone après avoir téléchargé une voix, la liste se met à jour toute seule.
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') return;
  if (Native && Native.hasVoice) await Native.useVoice(); else pickVoice();
  if ($('voice-settings').open) fillVoices();
});

$('gtts-save').addEventListener('click', async () => {
  const v = $('gtts-key').value.trim();
  GVoice.setKey(v);
  $('gtts-key').value = '';
  try { localStorage.setItem('gttsOn', v ? '1' : '0'); } catch { /* stockage */ }
  GVoice.unlock();
  await fillVoices();
});

// ================================================================= toujours la dernière version
// À l'ouverture et à chaque retour dans l'application, on compare la version chargée à celle en ligne.
// Différente : on recharge tout de suite, sauf pendant un guidage (on attend la fin du trajet).
const LOADED_VERSION = (window.CAP_CONFIG && window.CAP_CONFIG.version) || '';
async function checkVersion() {
  if (!LOADED_VERSION || !navigator.onLine) return;
  try {
    const res = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return;
    const online = (await res.json()).version;
    if (!online || online === LOADED_VERSION) return;
    if (S.mode === 'nav') { S.updateWaiting = true; return; }
    diag('nouvelle version ' + online + ' : rechargement');
    location.reload();
  } catch { /* pas de réseau : on garde la version actuelle */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkVersion(); });
setTimeout(checkVersion, 1500);
$('app-version').textContent = LOADED_VERSION ? 'Version du ' + LOADED_VERSION : 'Version locale';
