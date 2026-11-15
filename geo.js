// Petites fonctions de géométrie (pas de dépendance).
// Convention : un point = [lon, lat] en degrés, les distances en mètres, les caps en degrés (0 = nord).
const Geo = (() => {
  const R = 6371008.8;
  const rad = (d) => (d * Math.PI) / 180;
  const deg = (r) => (r * 180) / Math.PI;

  function distance(a, b) {
    const dLat = rad(b[1] - a[1]);
    const dLon = rad(b[0] - a[0]);
    const s =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  function bearing(a, b) {
    const y = Math.sin(rad(b[0] - a[0])) * Math.cos(rad(b[1]));
    const x =
      Math.cos(rad(a[1])) * Math.sin(rad(b[1])) -
      Math.sin(rad(a[1])) * Math.cos(rad(b[1])) * Math.cos(rad(b[0] - a[0]));
    return (deg(Math.atan2(y, x)) + 360) % 360;
  }

  // Point situé à `dist` mètres de `p` dans la direction `brg`.
  function destination(p, brg, dist) {
    const d = dist / R;
    const b = rad(brg);
    const lat1 = rad(p[1]);
    const lon1 = rad(p[0]);
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b));
    const lon2 =
      lon1 +
      Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
    return [deg(lon2), deg(lat2)];
  }

  // Distances cumulées le long d'une polyligne : cum[i] = distance du début jusqu'au point i.
  function cumulative(coords) {
    const cum = [0];
    for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + distance(coords[i - 1], coords[i]));
    return cum;
  }

  // Index du segment contenant la distance d (recherche dichotomique).
  function segmentAt(cum, d) {
    let lo = 0;
    let hi = cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= d) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  // Point à la distance d le long de la ligne.
  function pointAt(coords, cum, d) {
    const total = cum[cum.length - 1];
    d = Math.max(0, Math.min(total, d));
    const i = segmentAt(cum, d);
    const len = cum[i + 1] - cum[i] || 1;
    const t = (d - cum[i]) / len;
    const a = coords[i];
    const b = coords[i + 1] || a;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }

  // Portion de ligne entre les distances d0 et d1.
  function slice(coords, cum, d0, d1) {
    const total = cum[cum.length - 1];
    d0 = Math.max(0, d0);
    d1 = Math.min(total, d1);
    if (d1 <= d0) return [pointAt(coords, cum, d0), pointAt(coords, cum, d0)];
    const out = [pointAt(coords, cum, d0)];
    const i0 = segmentAt(cum, d0);
    const i1 = segmentAt(cum, d1);
    for (let i = i0 + 1; i <= i1; i++) out.push(coords[i]);
    out.push(pointAt(coords, cum, d1));
    return out;
  }

  // Projette p sur la ligne. Renvoie { dist (écart en m), along (distance depuis le début), point }.
  function snap(coords, cum, p) {
    const kx = Math.cos(rad(p[1])) * 111320; // mètres par degré de longitude
    const ky = 110540; // mètres par degré de latitude
    let best = { dist: Infinity, along: 0, point: coords[0] };
    for (let i = 0; i < coords.length - 1; i++) {
      const ax = (coords[i][0] - p[0]) * kx;
      const ay = (coords[i][1] - p[1]) * ky;
      const bx = (coords[i + 1][0] - p[0]) * kx;
      const by = (coords[i + 1][1] - p[1]) * ky;
      const dx = bx - ax;
      const dy = by - ay;
      const l2 = dx * dx + dy * dy;
      const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2));
      const px = ax + dx * t;
      const py = ay + dy * t;
      const d = Math.hypot(px, py);
      if (d < best.dist) {
        best = {
          dist: d,
          along: cum[i] + (cum[i + 1] - cum[i]) * t,
          point: [p[0] + px / kx, p[1] + py / ky],
        };
      }
    }
    return best;
  }

  // Interpolation d'angle par le chemin le plus court.
  function lerpAngle(a, b, t) {
    const diff = ((b - a + 540) % 360) - 180;
    return (a + diff * t + 360) % 360;
  }

  return { distance, bearing, destination, cumulative, pointAt, slice, snap, lerpAngle };
})();
