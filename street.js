'use strict';
/* Vue de la route : pendant le guidage, on affiche la vraie photo de la rue à l'endroit où l'on se trouve,
 * orientée dans le sens de la marche (photos libres Panoramax, classiques ou à 360°).
 * Chargé après app.js : utilise S, CONFIG, Geo, $ définis là-bas.
 */

const street = {
  items: [],        // photos calées sur l'itinéraire, triées par distance : { along, thumb, sd, az, pano, year, who }
  frontier: 0,      // jusqu'où (en mètres le long du trajet) les photos ont déjà été cherchées
  loading: false,
  current: null,
  front: 'a',       // calque visible (fondu enchaîné entre deux calques)
  lastSeen: 0,
  big: false,
  junction: null,   // photo du prochain carrefour, quand il y en a une
};

function streetReset() {
  street.items = [];
  street.frontier = 0;
  street.current = null;
  street.loading = false;
  $('street').hidden = true;
  for (const id of ['street-a', 'street-b']) {
    $(id).style.backgroundImage = '';
    $(id).classList.remove('on');
  }
}

// Cherche les photos des ~700 prochains mètres. Appelé régulièrement, ne fait rien s'il y a assez d'avance.
async function streetLoad() {
  const R = S.route;
  if (street.loading || street.frontier >= R.total || street.frontier - S.d > 350) return;
  street.loading = true;
  const d0 = Math.max(street.frontier, S.d);
  const d1 = Math.min(R.total, d0 + 700);
  try {
    const seg = Geo.slice(R.coords, R.cum, d0, d1);
    const cum = Geo.cumulative(seg);
    let w = 180, s = 90, e = -180, n = -90;
    for (const c of seg) {
      if (c[0] < w) w = c[0];
      if (c[0] > e) e = c[0];
      if (c[1] < s) s = c[1];
      if (c[1] > n) n = c[1];
    }
    const pad = 0.0004;
    const url = CONFIG.panoramax + '?limit=500&bbox=' + [w - pad, s - pad, e + pad, n + pad].map((v) => v.toFixed(5)).join(',');
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok || S.route !== R) return;
    const best = new Map(); // une photo tous les 12 m suffit : on garde la plus récente
    for (const f of (await res.json()).features || []) {
      const c = f.geometry && f.geometry.coordinates;
      const p = f.properties || {};
      if (!c || !f.assets || !f.assets.thumb) continue;
      const snap = Geo.snap(seg, cum, c);
      if (snap.dist > 14) continue; // photo prise ailleurs que sur notre route
      const az = Number(p['view:azimuth']);
      const pano = (p['pers:interior_orientation'] || {}).field_of_view === 360;
      if (!pano) {
        // Photo classique : elle doit regarder à peu près dans notre sens de marche.
        if (!Number.isFinite(az)) continue;
        const dir = Geo.bearing(Geo.pointAt(seg, cum, snap.along), Geo.pointAt(seg, cum, snap.along + 12));
        if (Math.abs(((az - dir + 540) % 360) - 180) > 30) continue;
      }
      const item = {
        along: d0 + snap.along, az: Number.isFinite(az) ? az : 0, pano,
        thumb: f.assets.thumb.href, sd: f.assets.sd ? f.assets.sd.href : f.assets.thumb.href,
        date: p.datetime || '', who: (f.providers && f.providers.length && f.providers[f.providers.length - 1].name) || '',
      };
      const key = Math.round(item.along / 12);
      const prev = best.get(key);
      if (!prev || item.date > prev.date) best.set(key, item);
    }
    street.items = street.items.filter((it) => it.along > S.d - 60).concat([...best.values()]).sort((a, b) => a.along - b.along);
  } catch { /* pas de réseau : on réessaiera plus loin */
  } finally {
    if (S.route === R) street.frontier = d1;
    street.loading = false;
  }
}

// Appelé plusieurs fois par seconde pendant le guidage.
function streetUpdate() {
  // Photos de bénévoles, de qualité et de cadrage très variables : affichées seulement si on les a demandées.
  if (!S.streetOn) { $('street').hidden = true; return; }
  streetLoad();
  const cur = street.current;
  // On garde la photo affichée tant qu'on n'est pas nettement plus loin qu'elle : changer tous les quelques
  // mètres donne un effet saccadé. Entre deux photos, un lent zoom avant donne l'impression d'avancer.
  const keep = cur && cur.along > S.d - 22 && cur.along < S.d + 50;
  let pick = keep ? cur : null;

  // À l'approche d'un virage, ce qui compte est de reconnaître la rue où l'on va tourner : on affiche la photo
  // à 360° prise au carrefour lui-même, tournée vers cette rue (et non le bord de la route où l'on est).
  const t = S.turn;
  let junction = null;
  if (t) {
    let bestGap = Infinity;
    for (const it of street.items) {
      const gap = it.along - t.step.start; // négatif = juste avant le carrefour
      if (!it.pano || gap < -22 || gap > 12) continue;
      if (Math.abs(gap) < bestGap) { bestGap = Math.abs(gap); junction = it; }
    }
  }
  street.junction = junction;
  if (junction) pick = junction;
  else if (!keep) {
    let bestGap = Infinity;
    for (const it of street.items) {
      if (it.along < S.d - 5) continue;
      if (it.along > S.d + 45) break;
      const gap = Math.abs(it.along - (S.d + 15));
      if (gap < bestGap) { bestGap = gap; pick = it; }
    }
  }
  // La photo sert à se repérer avant une manœuvre. En ligne droite elle ne ferait que détourner le regard :
  // on ne l'affiche qu'à moins de 300 m d'une manœuvre, ou à l'arrêt.
  const inRing = !!S.route.steps[stepIndexAt(S.d)].roundabout; // dans un rond-point, les yeux restent sur la route
  if (inRing || (!junction && S.speed >= 3 && !(S.toMan < 300))) { $('street').hidden = true; street.current = null; return; }

  const now = performance.now();
  if (pick) street.lastSeen = now;
  // Pas de photo ici : on garde la dernière quelques secondes, puis on rend la place à la carte.
  if (!pick && now - street.lastSeen > 4000) { $('street').hidden = true; street.current = null; return; }
  if (pick && pick !== cur) streetShow(pick);
  if (street.current && street.current.pano) streetAim($('street-' + street.front), street.current);

  // Sur la photo du carrefour : une flèche et le nom de la rue à prendre.
  const show = !!junction && street.current === junction && !$('street').hidden;
  $('street-turn').hidden = !show;
  if (show) {
    setHtml('street-turn-icon', stepIcon(t.step, 40));
    // Texte court : le nom de la rue, sinon la direction du panneau, sinon la consigne.
    setHtml('street-turn-text', escapeHtml(t.step.name || t.step.dest[0] || t.step.text));
  }
}

// Direction dans laquelle regarder : devant soi ; sur la photo du carrefour, vers la rue où l'on va tourner.
function streetLook() {
  return S.turn && street.junction && street.current === street.junction ? S.turn.exit : S.bearing;
}

function streetShow(item) {
  street.current = item;
  // Image légère tant qu'on roule ; les photos à 360° sont recadrées, il leur faut la version détaillée.
  const src = item.pano || street.big || S.speed < 3 ? item.sd : item.thumb;
  const img = new Image();
  img.src = src;
  // decode() prépare l'image en arrière-plan : l'afficher ensuite ne fige pas l'animation de la carte.
  (img.decode ? img.decode() : new Promise((ok, ko) => { img.onload = ok; img.onerror = ko; })).then(() => {
    if (street.current !== item) return; // une photo plus récente est déjà demandée
    const back = street.front === 'a' ? 'b' : 'a';
    const el = $('street-' + back);
    // On prépare le calque caché sans animation, puis on lance le fondu et le lent zoom avant.
    el.style.transition = 'none';
    el.style.transform = 'scale(1)';
    el.style.backgroundImage = 'url("' + src + '")';
    el.classList.toggle('pano', item.pano);
    if (item.pano) streetAim(el, item);
    else { el.style.backgroundSize = 'cover'; el.style.backgroundPosition = '50% 62%'; }
    void el.offsetWidth; // applique les réglages ci-dessus avant de réactiver les animations
    // Durée du zoom = temps estimé jusqu'à la photo suivante (environ 35 m plus loin).
    const secs = clamp(35 / Math.max(2, S.speed * (S.sim ? S.simMult : 1)), 1.2, 9);
    el.style.transition = 'opacity 0.6s ease, background-position 0.3s linear, transform ' + secs.toFixed(1) + 's linear';
    el.style.transform = 'scale(1.22)';
    el.classList.add('on');
    $('street-' + street.front).classList.remove('on');
    street.front = back;
    $('street-cap').textContent = 'Panoramax' + (item.who ? ' · ' + item.who : '') + (item.date ? ' · ' + item.date.slice(0, 4) : '');
    $('street').hidden = false;
  }).catch(() => { /* image illisible : on garde la précédente */ });
}

// Photo à 360° : on recadre la portion qui regarde dans le sens de la marche (champ d'environ 100°).
function streetAim(el, item) {
  const width = el.clientWidth || 360;
  const height = el.clientHeight || 220;
  const imgW = width * 3.6;
  const imgH = imgW / 2; // une photo à 360° est deux fois plus large que haute, l'horizon est à mi-hauteur
  const f = (((streetLook() - item.az + 540) % 360)) / 360; // 0,5 = centre de l'image = direction de prise de vue
  el.style.backgroundSize = imgW + 'px ' + imgH + 'px';
  // Horizon placé au tiers supérieur du cadre, pour voir surtout la chaussée devant soi.
  el.style.backgroundPosition = Math.round(width / 2 - f * imgW) + 'px ' + Math.round(height * 0.38 - imgH / 2) + 'px';
}

$('street').addEventListener('click', () => {
  street.big = !street.big;
  $('street').classList.toggle('big', street.big);
  if (street.current) { const it = street.current; street.current = null; streetShow(it); } // recharge en meilleure qualité
});
