'use strict';
/* Mode nuit automatique : la carte s'assombrit entre le coucher et le lever du soleil (calculés pour l'endroit où l'on est),
 * pour ne pas éblouir le conducteur. Réglable : automatique, toujours jour, toujours nuit.
 * Chargé après app.js : utilise S, map, $, Places.
 */
const Night = (() => {
  let on = false;
  const saved = new Map(); // couleurs de jour d'origine, pour les remettre au matin

  // Hauteur du soleil (degrés) à un instant et un endroit donnés (formules astronomiques simplifiées, précises à la minute près).
  function sunAltitude(date, lat, lon) {
    const rad = Math.PI / 180;
    const d = date.getTime() / 86400000 - 10957.5; // jours depuis le 1er janvier 2000 à midi
    const g = (357.529 + 0.98560028 * d) * rad;
    const q = 280.459 + 0.98564736 * d;
    const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad;
    const e = (23.439 - 0.00000036 * d) * rad;
    const dec = Math.asin(Math.sin(e) * Math.sin(L));
    const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
    const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
    const ha = ((gmst * 15 + lon) * rad) - ra;
    return Math.asin(Math.sin(lat * rad) * Math.sin(dec) + Math.cos(lat * rad) * Math.cos(dec) * Math.cos(ha)) / rad;
  }

  function where() {
    if (S.pos) return { lon: S.pos[0], lat: S.pos[1] };
    const h = Places.read().home;
    if (h) return h;
    const c = map.getCenter();
    return { lon: c.lng, lat: c.lat };
  }

  const pref = () => { try { return localStorage.getItem('theme') || 'auto'; } catch { return 'auto'; } };
  function wanted() {
    const p = pref();
    if (p === 'jour') return false;
    if (p === 'nuit') return true;
    const w = where();
    return sunAltitude(new Date(), w.lat, w.lon) < -3; // un peu après le coucher du soleil
  }

  // Couleurs de nuit des couches du plan (fond sombre, routes grises, textes clairs).
  function nightPaint(layer) {
    const id = layer.id;
    if (layer.type === 'background') return { 'background-color': '#0d141f' };
    if (layer.type === 'fill') return { 'fill-color': /water|ocean|sea|river|lake/.test(id) ? '#0a1d30' : /park|wood|grass|forest|landcover/.test(id) ? '#122019' : '#141c28' };
    if (layer.type === 'line') {
      if (/water|river|stream|canal/.test(id)) return { 'line-color': '#0a1d30' };
      if (/casing/.test(id)) return { 'line-color': '#0d141f' };
      if (/motorway|trunk/.test(id)) return { 'line-color': '#5b6475' };
      if (/road|street|highway|primary|secondary|tertiary|minor|service|track|path|bridge|tunnel/.test(id)) return { 'line-color': '#394252' };
      if (/boundary|admin/.test(id)) return { 'line-color': '#3a4456' };
      return null;
    }
    if (layer.type === 'fill-extrusion') return { 'fill-extrusion-color': '#2a3442' };
    if (layer.type === 'symbol') return { 'text-color': '#c4cedc', 'text-halo-color': '#0d141f' };
    return null;
  }

  function paintAll(night) {
    for (const layer of map.getStyle().layers) {
      if (layer.source !== 'openmaptiles' && layer.type !== 'background') continue;
      if (layer.id === S.buildingLayer) continue;
      const p = nightPaint(layer);
      if (!p) continue;
      for (const [prop, val] of Object.entries(p)) {
        const key = layer.id + '|' + prop;
        try {
          if (night) {
            if (!saved.has(key)) saved.set(key, map.getPaintProperty(layer.id, prop));
            map.setPaintProperty(layer.id, prop, val);
          } else if (saved.has(key)) {
            map.setPaintProperty(layer.id, prop, saved.get(key));
          }
        } catch { /* propriété absente pour cette couche */ }
      }
    }
  }

  // Appliqué après chaque changement de vue ou de mode conduite, car ceux-ci repeignent la photo et les bâtiments.
  function apply() {
    if (!map.getLayer('ortho')) return;
    document.body.classList.toggle('night', on);
    paintAll(on);
    const driving = S.mode === 'nav';
    if (on) {
      map.setPaintProperty('ortho', 'raster-brightness-max', driving ? 0.38 : 0.5);
      map.setPaintProperty('ortho', 'raster-saturation', -0.5);
      map.setPaintProperty(S.buildingLayer, 'fill-extrusion-color', '#2a3442');
    }
  }

  function check() {
    const w = wanted();
    if (w === on) return;
    on = w;
    if (!on) { // retour au jour : on remet les couleurs d'origine, puis le style de la vue et du mode en cours
      apply();
      setRealView(S.real);
      setDriveStyle(S.mode === 'nav');
      document.body.classList.remove('night');
      return;
    }
    apply();
  }

  // Réglage
  const sel = $('theme-select');
  sel.value = pref();
  sel.addEventListener('change', () => { try { localStorage.setItem('theme', sel.value); } catch { /* stockage */ } on = !wanted(); check(); });
  map.on('load', () => setTimeout(check, 300));
  if (map.loaded()) setTimeout(check, 300);
  setInterval(check, 60000);

  return { apply, check, isOn: () => on, sunAltitude };
})();
