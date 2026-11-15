'use strict';
/* Boîte de suggestions : quand on demande un lieu (à la voix ou au doigt), on propose plusieurs réponses à choisir.
 * Chargé après parking.js, avant ai.js et voice.js : utilise S, $, map, Geo, Places, goTo, bestRoute, useRoute, ttKey, ttUsage…
 *
 * Sources :
 *   - TomTom (magasins, enseignes, services : c'est lui qui trouve « Leclerc Lanester ») ;
 *   - OpenStreetMap / Photon (adresses, lieux) ;
 *   - Claude, s'il a une clé : il transforme une phrase vague (« j'ai faim », « un McDo ») en recherches précises,
 *     mais n'invente jamais d'adresse : seuls les lieux réellement trouvés sont proposés ;
 *   - Google : sa carte de résultats s'affiche dans la boîte, en consultation seulement (son service de recherche
 *     de lieux est payant et n'est pas activé).
 * Les temps de trajet de la liste viennent d'un seul calcul groupé (gratuit) ; le vrai itinéraire, avec ses variantes,
 * n'est calculé qu'une fois le lieu choisi.
 */
const Sug = (() => {
  let items = [];
  let seq = 0;
  let lastQuery = '';
  let wantOpen = false;   // le conducteur a demandé un lieu « ouvert »

  const here = () => {
    if (S.pos) return { lon: S.pos[0], lat: S.pos[1] };
    const home = Places.read().home;
    if (home) return { lon: home.lon, lat: home.lat };
    const c = map.getCenter();
    return { lon: c.lng, lat: c.lat };
  };

  async function tomtom(q, c) {
    if (!ttKey() || ttUsage(0, 's') >= TT.monthlyCap) return [];
    ttUsage(1, 's');
    const params = new URLSearchParams({ key: ttKey(), lat: c.lat.toFixed(5), lon: c.lon.toFixed(5), radius: '40000', limit: '6', language: 'fr-FR', countrySet: 'FR', typeahead: 'false', openingHours: 'nextSevenDays' });
    const res = await fetch('https://api.tomtom.com/search/2/search/' + encodeURIComponent(q) + '.json?' + params, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    return ((await res.json()).results || []).map((r) => {
      const name = (r.poi && r.poi.name) || r.address.streetName || r.address.freeformAddress;
      const street = [r.address.streetNumber, r.address.streetName].filter(Boolean).join(' ');
      const hours = r.poi && r.poi.openingHours && r.poi.openingHours.timeRanges;
      return { name, where: [r.poi ? street : '', r.address.municipality].filter(Boolean).join(', '), lon: r.position.lon, lat: r.position.lat, kind: r.poi ? 'lieu' : 'adresse', hours: hours && hours.length ? hours : null };
    });
  }

  async function photon(q, c) {
    const url = 'https://photon.komoot.io/api/?lang=fr&limit=6&q=' + encodeURIComponent(q) + '&lat=' + c.lat.toFixed(3) + '&lon=' + c.lon.toFixed(3);
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    return ((await res.json()).features || []).filter((f) => f.geometry).map((f) => {
      const p = f.properties || {};
      const street = [p.housenumber, p.street].filter(Boolean).join(' ');
      return { name: p.name || street || q, where: [p.name ? street : '', p.city].filter(Boolean).join(', '), lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], kind: p.name ? 'lieu' : 'adresse' };
    });
  }

  // Ouvert maintenant ? D'après les horaires des 7 prochains jours donnés par TomTom. null si horaires inconnus.
  const DAYS = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];
  const hhmm = (d) => d.getHours() + ' h' + (d.getMinutes() ? ' ' + String(d.getMinutes()).padStart(2, '0') : '');
  const DAYS_FULL = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
  function openState(x) {
    if (!x.hours) return null;
    const at = (p) => { const [y, m, d] = p.date.split('-').map(Number); return new Date(y, m - 1, d, p.hour, p.minute); };
    const now = new Date();
    let next = null;
    for (const r of x.hours) {
      const a = at(r.startTime);
      const b = at(r.endTime);
      if (now >= a && now < b) return { open: true, text: 'Ouvert jusqu\'à ' + hhmm(b), said: 'ouvert jusqu\'à ' + hhmm(b) };
      if (a > now && (!next || a < next)) next = a;
    }
    if (!next) return { open: false, text: 'Fermé', said: 'fermé' };
    const sameDay = next.toDateString() === now.toDateString();
    const when = (sameDay ? '' : DAYS[next.getDay()] + ' ') + hhmm(next);
    return { open: false, text: 'Fermé · ouvre ' + when, said: 'fermé, ouvre ' + (sameDay ? '' : DAYS_FULL[next.getDay()] + ' ') + 'à ' + hhmm(next) };
  }

  // Ajoute des résultats à la liste : sans doublon (60 m), et plus de 60 km de distance = écarté (sauf ville lointaine demandée).
  function merge(found, c) {
    for (const f of found) {
      if (!f || !Number.isFinite(f.lon)) continue;
      f.dist = Geo.distance([c.lon, c.lat], [f.lon, f.lat]);
      if (items.some((o) => Geo.distance([o.lon, o.lat], [f.lon, f.lat]) < 60)) continue;
      items.push(f);
    }
  }

  // Temps de trajet pour toute la liste, en un seul appel (service libre, gratuit).
  async function times(c) {
    const todo = items.slice(0, 10).filter((x) => x.time === undefined);
    if (!todo.length) return;
    try {
      const coords = [[c.lon, c.lat]].concat(todo.map((x) => [x.lon, x.lat])).map((p) => p[0].toFixed(5) + ',' + p[1].toFixed(5)).join(';');
      const url = CONFIG.osrm.replace('/route/', '/table/') + coords + '?sources=0&annotations=duration,distance';
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const j = await res.json();
      todo.forEach((x, k) => { x.time = j.durations[0][k + 1]; x.road = j.distances ? j.distances[0][k + 1] : null; });
    } catch { /* on garde la distance à vol d'oiseau */ }
  }

  function render(status) {
    const ul = $('sug-list');
    ul.innerHTML = '';
    items.slice(0, 5).forEach((x, k) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      const st = openState(x);
      b.innerHTML = '<span class="sug-n">' + (k + 1) + '</span><span class="sug-t"><b>' + escapeHtml(x.name) + '</b>' +
        (st ? '<em class="' + (st.open ? 'is-open' : 'is-closed') + '">' + st.text + '</em>' : (wantOpen ? '<em class="is-unknown">Horaires inconnus</em>' : '')) + '<span>' +
        escapeHtml(x.where || '') + (x.where ? ' · ' : '') + fmtDist(x.road || x.dist) + (x.time ? ' · ' + fmtDuration(x.time) : '') + '</span></span>';
      b.addEventListener('click', () => choose(k));
      li.appendChild(b);
      ul.appendChild(li);
    });
    $('sug-info').textContent = status || (items.length ? 'Touchez un lieu, ou dites « le premier », « le deuxième »…' : 'Aucun lieu trouvé.');
  }

  // Ouvre la boîte pour `query`. `extra` : recherches supplémentaires (proposées par Claude). `say` : lire les choix à voix haute.
  async function open(query, extra = [], say = true, said = '', near = '') {
    const my = ++seq;
    // « pharmacie ouverte », « de garde », « maintenant » : on garde l'intention, on retire ces mots de la recherche.
    const OPEN = /\b(ouverte?s?|de garde|maintenant|en ce moment|tout de suite|actuellement)\b/gi;
    wantOpen = OPEN.test([query, said].join(' '));
    query = query.replace(OPEN, '').replace(/\s+/g, ' ').trim() || query;
    extra = extra.map((q) => q.replace(OPEN, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    lastQuery = query;
    items = [];
    $('sug').hidden = false;
    $('sug-q').textContent = '« ' + query + ' »';
    $('sug-g').hidden = true;
    $('sug-gbtn').textContent = 'Voir sur Google';
    render('Recherche…');
    let c = here();
    // « près de mon hôtel », « à Nantes » : on centre la recherche sur ce lieu-là, pas sur la voiture.
    if (near) {
      try {
        const g = await photon(near, c);
        if (g[0]) { c = { lon: g[0].lon, lat: g[0].lat }; $('sug-q').textContent = '« ' + query + ' » près de ' + g[0].name; }
      } catch { /* on reste autour de la voiture */ }
      if (my !== seq) return;
    }
    const queries = [...new Set([query, ...extra].filter(Boolean))].slice(0, 4);
    const lists = await Promise.all(queries.flatMap((q) => [tomtom(q, c).catch(() => []), photon(q, c).catch(() => [])]));
    if (my !== seq) return;
    // TomTom d'abord (meilleur pour les commerces), puis OpenStreetMap, requête par requête.
    for (const l of lists) merge(l, c);
    // Pertinence : les mots demandés présents dans le nom passent devant, le nom qui commence par la demande encore plus.
    // À pertinence égale, le plus proche d'abord (pour « pharmacie », « restaurant »…).
    const norm = (t) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    const STOP = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'l', 'a', 'au', 'aux', 'un', 'une', 'd', 'et', 'en', 'pres', 'ici', 'pas', 'trop', 'loin']);
    const words = [...new Set(norm(queries.join(' ')).split(' ').filter((w) => w.length > 1 && !STOP.has(w)))];
    items = items.filter((x) => !/[a-z][A-Z]{2,}|[A-Z]{3,}\d|\d[a-z]+[A-Z]/.test(x.name)); // noms illisibles (codes)
    items = items.filter((x) => !/universitaire|scolaire|cantine|crous|d'entreprise|inter-?entreprises|du personnel|r[ée]serv[ée]/i.test(x.name)); // lieux non ouverts au public
    for (const x of items) {
      const n = norm(x.name);
      const all = n + ' ' + norm(x.where || '');
      x.rel = words.filter((w) => all.includes(w)).length + words.filter((w) => n.includes(w)).length * 0.5 +
        (queries.some((q) => n.startsWith(norm(q))) ? 2 : 0);
    }
    // Homonymes lointains (« restaurant italien » à Eymet) : autour d'un lieu précisé, on ne garde que les 40 km.
    // Sinon, un lieu lointain n'est gardé que s'il correspond nettement mieux que les lieux proches (« tour Eiffel »).
    const nearOnes = items.filter((x) => x.dist < 40000);
    if (near && nearOnes.length) items = nearOnes;
    else if (nearOnes.length >= 2) {
      const bestNear = Math.max(...nearOnes.map((x) => x.rel));
      items = items.filter((x) => x.dist < 40000 || x.rel >= bestNear + 1);
    }
    items.sort((a, b) => b.rel - a.rel || a.dist - b.dist);
    // Un lieu très proche passe devant s'il porte le même nom qu'un lointain.
    await times(c);
    // Temps de route plutôt que distance à vol d'oiseau (Port-Louis est proche… de l'autre côté de la rade).
    const cost = (x) => (x.time != null ? x.time : x.dist / 12);
    items.sort((a, b) => b.rel - a.rel || cost(a) - cost(b));
    if (wantOpen) {
      // Ouverts d'abord, puis horaires inconnus, fermés en dernier.
      const rank = (x) => { const st = openState(x); return st ? (st.open ? 0 : 2) : 1; };
      items.sort((a, b) => rank(a) - rank(b) || b.rel - a.rel || cost(a) - cost(b));
    }
    if (my !== seq) return;
    render();
    if (!items.length) { if (say) speak('Je n\'ai rien trouvé pour ' + query + '.'); return; }
    if (say) {
      const top = items.slice(0, 3).map((x, k) => {
        const st = openState(x);
        return ['Un', 'Deux', 'Trois'][k] + ' : ' + x.name + (x.where ? ', ' + x.where.split(', ').pop() : '') + ', ' + (x.time && !near ? 'à ' + fmtDuration(x.time).replace(' h ', ' heure ').replace('min', 'minutes') : fmtDistSpoken(x.road || x.dist)) +
          (st ? ', ' + st.said : wantOpen ? ', horaires inconnus' : '');
      });
      const anyOpen = items.slice(0, 5).some((x) => { const st = openState(x); return st && st.open; });
      const garde = wantOpen && !anyOpen && /pharmac/i.test(query) ? 'Aucune n\'est indiquée ouverte maintenant. Pour la pharmacie de garde, appelez le 32 37. ' : '';
      speak(garde + top.join('. ') + '. Dites le numéro', true);
      if (typeof Voice !== 'undefined') Voice.askAgain();
    }
  }

  async function choose(k) {
    const x = items[k];
    if (!x) return;
    close();
    const place = { label: x.name + (x.where ? ', ' + x.where.split(', ').pop() : ''), lon: x.lon, lat: x.lat };
    if (S.mode === 'nav' && S.pos) {
      // En guidage : on garde le trajet actuel jusqu'au choix, puis on repart de la position.
      S.to = { ...place, full: place.label };
      $('to').value = place.label;
      try {
        useRoute(await bestRoute({ lon: S.pos[0], lat: S.pos[1] }, S.to, true));
        destMarker.setLngLat([S.to.lon, S.to.lat]);
        speak('Itinéraire vers ' + place.label + '.', true);
        saveTrip(true);
      } catch { setNavNote('Itinéraire impossible'); }
    } else {
      goTo(place);
    }
  }

  function close() { seq++; $('sug').hidden = true; $('sug-g').src = 'about:blank'; }

  // « le premier », « le 2 », « numéro trois », « annule »… Renvoie true si la phrase a été traitée.
  function pickFromSpeech(q) {
    if ($('sug').hidden) return false;
    if (/^(annule|non|ferme|laisse|aucun)\b/.test(q)) { close(); speak('D\'accord.'); return true; }
    const words = { premier: 0, premiere: 0, un: 0, une: 0, 1: 0, deuxieme: 1, second: 1, seconde: 1, deux: 1, 2: 1, troisieme: 2, trois: 2, 3: 2, quatrieme: 3, quatre: 3, 4: 3, cinquieme: 4, cinq: 4, 5: 4 };
    // La phrase entière doit être un choix (« le deuxième », « numéro 2 », « le 3 ») : « trouve une pharmacie » n'en est pas un.
    const m = q.match(/^(?:je prends |prends |choisis )?(?:le |la |l'|numero |n )?(premiere?|un|une|deuxieme|seconde?|deux|troisieme|trois|quatrieme|quatre|cinquieme|cinq|[1-5])(?: (?:choix|lieu|proposition|resultat))?$/);
    if (!m) return false;
    choose(words[m[1]]);
    return true;
  }

  function google() {
    const f = $('sug-g');
    if (!f.hidden) { f.hidden = true; $('sug-gbtn').textContent = 'Voir sur Google'; return; }
    if (!S.gkey) { $('sug-info').textContent = 'Pas de clé Google Maps : carte Google indisponible.'; return; }
    const c = here();
    f.src = 'https://www.google.com/maps/embed/v1/search?key=' + encodeURIComponent(S.gkey) + '&q=' + encodeURIComponent(lastQuery) +
      '&center=' + c.lat.toFixed(5) + ',' + c.lon.toFixed(5) + '&zoom=12&language=fr';
    f.hidden = false;
    $('sug-gbtn').textContent = 'Masquer Google';
  }

  $('sug-close').addEventListener('click', close);
  $('sug-gbtn').addEventListener('click', google);
  return { open, close, choose, pickFromSpeech, isOpen: () => !$('sug').hidden };
})();
