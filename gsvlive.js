'use strict';
/* Street View « qui avance avec vous » à l'approche des carrefours et des sorties (service Google payant au-delà
 * de 5 000 vues par mois ; une seule vue est chargée par trajet, les déplacements ensuite ne comptent pas).
 *   - la photo avance le long du trajet au fur et à mesure que la voiture roule ;
 *   - le chemin à suivre est dessiné SUR la photo, à partir de la position exacte de la photo donnée par Google ;
 *   - elle reste affichée jusqu'à ce que la manœuvre soit passée.
 * Sans clé « Street View dynamique », rien ne change : l'aperçu photo fixe reste utilisé.
 * Chargé après app.js : utilise S, $, Geo, setHtml, stepIcon, fmtDist, escapeHtml, isDecision, exitInfo.
 */
const GLive = (() => {
  const key = () => { try { return localStorage.getItem('gLiveKey') || (window.CAP_CONFIG && window.CAP_CONFIG.gLiveKey) || ''; } catch { return ''; } };
  let loading = null;
  let pano = null;
  let svc = null;
  let failed = false;
  let lastD = -1e9;
  let lastAt = 0;
  let step = -1;
  let here = null;      // position exacte de la photo affichée (donnée par Google)
  let busy = false;
  const canvas = document.createElement('canvas');

  function load() {
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      window.__capGLive = resolve;
      window.gm_authFailure = () => { failed = true; reject(new Error('clé refusée')); };
      const s = document.createElement('script');
      s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(key()) + '&callback=__capGLive&loading=async&language=fr&region=FR&v=weekly';
      s.async = true;
      s.onerror = () => { failed = true; reject(new Error('Google injoignable')); };
      document.head.appendChild(s);
    });
    return loading;
  }

  async function ensure() {
    await load();
    if (!google.maps.StreetViewPanorama) await google.maps.importLibrary('streetView');
    if (pano) return;
    const box = $('gsv-live');
    pano = new google.maps.StreetViewPanorama(box, {
      disableDefaultUI: true, clickToGo: false, linksControl: false, panControl: false, zoomControl: false, addressControl: false,
      fullscreenControl: false, motionTracking: false, motionTrackingControl: false, showRoadLabels: false, scrollwheel: false,
      disableDoubleClickZoom: true, visible: true, pov: { heading: 0, pitch: -6 }, zoom: 1,
    });
    svc = new google.maps.StreetViewService();
    canvas.id = 'gsv-trace';
    box.appendChild(canvas);
    pano.addListener('pov_changed', draw);
    pano.addListener('position_changed', () => { const p = pano.getPosition(); if (p) here = [p.lng(), p.lat()]; draw(); });
  }

  // Avance la photo : panorama le plus proche d'un point un peu devant la voiture, regard vers la route à prendre.
  async function follow(next) {
    if (busy) return;
    busy = true;
    try {
      const R = S.route;
      const ahead = Geo.pointAt(R.coords, R.cum, Math.min(R.total, S.d + 12));
      const res = await svc.getPanorama({ location: { lat: ahead[1], lng: ahead[0] }, radius: 35, preference: 'nearest', source: 'outdoor' });
      const loc = res.data.location;
      here = [loc.latLng.lng(), loc.latLng.lat()];
      const along = Geo.snap(R.coords, R.cum, here).along;
      // On regarde le chemin 35 m plus loin (ou le carrefour s'il est plus près) : la sortie apparaît du bon côté.
      const target = Geo.pointAt(R.coords, R.cum, Math.min(R.total, Math.max(along + 35, Math.min(next.start + 10, along + 60))));
      pano.setPano(loc.pano);
      pano.setPov({ heading: Geo.bearing(here, target), pitch: -7 });
    } catch { /* pas de photo ici : on garde la précédente */ } finally { busy = false; }
  }

  // Dessine le chemin à suivre sur la photo (projection depuis la position et l'orientation exactes de la photo).
  function draw() {
    if (!pano || !here || !S.route || $('gsv').hidden) return;
    const box = $('gsv-live');
    const W = box.clientWidth;
    const H = box.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== W * dpr || canvas.height !== H * dpr) { canvas.width = W * dpr; canvas.height = H * dpr; }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const pov = pano.getPov();
    const zoom = pano.getZoom() || 1;
    const hfov = (180 / Math.pow(2, zoom)) * Math.PI / 180;
    const vfov = 2 * Math.atan(Math.tan(hfov / 2) * H / W);
    const camH = 2.5; // hauteur de la caméra Google au-dessus de la route (environ)
    const R = S.route;
    const from = Geo.snap(R.coords, R.cum, here).along;
    const nxt = R.steps[step] || null;
    const to = Math.min(R.total, (nxt ? nxt.start + (nxt.roundabout ? nxt.distance : 0) : from) + 60);
    const pts = [];
    for (let d = from + 3; d <= to; d += 3) {
      const p = Geo.pointAt(R.coords, R.cum, d);
      const dist = Geo.distance(here, p);
      if (dist < 3 || dist > 220) continue;
      let rel = ((Geo.bearing(here, p) - pov.heading + 540) % 360) - 180;
      if (Math.abs(rel) > 80) { if (pts.length) break; continue; }
      rel *= Math.PI / 180;
      const elev = -Math.atan(camH / dist) - pov.pitch * Math.PI / 180;
      const x = W / 2 + (Math.tan(rel) / Math.tan(hfov / 2)) * (W / 2);
      const y = H / 2 - (Math.tan(elev) / Math.tan(vfov / 2)) * (H / 2);
      pts.push([x, y, dist]);
    }
    if (pts.length < 2) return;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    // Ruban : plus large près de la voiture, plus fin au loin (effet de perspective).
    for (const [color, extra] of [['rgba(14,20,32,0.85)', 6], ['#ffd23f', 0]]) {
      ctx.strokeStyle = color;
      for (let k = 1; k < pts.length; k++) {
        ctx.lineWidth = Math.max(3, 36 / Math.max(1, pts[k][2] / 6)) + extra;
        ctx.beginPath(); ctx.moveTo(pts[k - 1][0], pts[k - 1][1]); ctx.lineTo(pts[k][0], pts[k][1]); ctx.stroke();
      }
    }
    // Pointe de flèche au bout.
    const a = pts[pts.length - 2];
    const b = pts[pts.length - 1];
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const s = Math.max(10, 40 / Math.max(1, b[2] / 6));
    ctx.fillStyle = '#ffd23f'; ctx.strokeStyle = 'rgba(14,20,32,0.85)'; ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(b[0] + Math.cos(ang) * s, b[1] + Math.sin(ang) * s);
    ctx.lineTo(b[0] + Math.cos(ang + 2.4) * s, b[1] + Math.sin(ang + 2.4) * s);
    ctx.lineTo(b[0] + Math.cos(ang - 2.4) * s, b[1] + Math.sin(ang - 2.4) * s);
    ctx.closePath(); ctx.fill(); ctx.stroke();
  }

  // Appelé à chaque mise à jour du guidage (5 fois par seconde).
  function update(i, next, toMan) {
    if (failed) return false;
    const R = S.route;
    // Juste après la manœuvre, on continue de la montrer 40 m : on voit qu'on est sur la bonne route.
    const cur = R.steps[i];
    let target = next;
    let k = i + 1;
    if (i > 0 && isDecision(cur) && S.d - cur.start < 40) { target = cur; k = i; }
    const fast = target && exitInfo(k, target);
    const reach = fast ? 800 : 300;
    const dist = target ? target.start - S.d : 1e9;
    const show = target && isDecision(target) && target.type !== 'arrive' && dist < reach;
    if (!show) { if (step !== -1) { step = -1; $('gsv').hidden = true; $('gsv').classList.remove('live'); } return true; }
    if (step !== k) {
      step = k;
      lastD = -1e9;
      setHtml('gsv-arrow', '');
      setHtml('gsv-what', fast ? 'Vue de la sortie' : 'Vue du carrefour');
      setHtml('gsv-text', escapeHtml(target.act));
    }
    setHtml('gsv-dist', dist > 5 ? 'dans ' + fmtDist(dist) : 'ici');
    ensure().then(() => {
      $('gsv').classList.add('live');
      $('gsv').hidden = false;
      // La photo avance tous les 20 m environ (au plus une fois par seconde).
      const now = performance.now();
      if (S.d - lastD > 20 && now - lastAt > 1000) { lastD = S.d; lastAt = now; follow(target); }
      draw();
    }).catch(() => { failed = true; });
    return true;
  }

  return { enabled: () => !!key() && !failed, update };
})();
