// Petit serveur sans dépendance, pour utiliser l'application sur le PC.
//   node server.js          →  http://localhost:5173
//
// En plus des fichiers de l'application, il fournit les alertes en direct :
//   /api/incidents?bbox=ouest,sud,est,nord   événements routiers Bison Futé (rafraîchis toutes les 3 min)
//   /api/radars?bbox=…                       radars fixes officiels (rafraîchis une fois par jour)
// Ces flux n'autorisent pas les appels directs depuis un navigateur (pas de CORS), d'où ce relais.
// Sans ce serveur (hébergement en ligne), l'application lit à la place les fichiers data/*.json.
const http = require('http');
const fs = require('fs');
const path = require('path');
const feeds = require('./feeds');

const PORT = Number(process.env.PORT) || 5173;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.md': 'text/plain; charset=utf-8',
};

// Garde en mémoire le résultat d'un flux pendant `ttl` ms ; en cas de panne, ressert les dernières données.
function cached(load, ttl) {
  let state = { at: 0, items: [], ok: false, loading: null };
  return async () => {
    if (Date.now() - state.at < ttl) return state;
    if (!state.loading) {
      state.loading = load()
        .then((items) => { state = { at: Date.now(), items, ok: true, loading: null }; })
        .catch(() => { state = { ...state, at: Date.now() - ttl + 30000, loading: null }; }) // nouvel essai dans 30 s
        .then(() => state);
    }
    return state.loading;
  };
}
const incidents = cached(feeds.fetchIncidents, 3 * 60 * 1000);
const radars = cached(feeds.fetchRadars, 24 * 3600 * 1000);

function inBbox(items, url) {
  const bbox = (url.searchParams.get('bbox') || '').split(',').map(Number);
  if (bbox.length !== 4 || !bbox.every(Number.isFinite)) return items;
  const [w, s, e, n] = bbox;
  return items.filter((i) => i.lon >= w && i.lon <= e && i.lat >= s && i.lat <= n);
}

function sendJson(res, body) {
  res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function serveFile(url, res) {
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end('Interdit'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Introuvable'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/incidents') {
      const c = await incidents();
      return sendJson(res, { ok: c.ok, updated: c.at, incidents: inBbox(c.items, url) });
    }
    if (url.pathname === '/api/radars') {
      const c = await radars();
      return sendJson(res, { ok: c.ok, radars: inBbox(c.items, url) });
    }
    serveFile(url, res);
  } catch (e) {
    res.writeHead(500);
    res.end(String(e));
  }
}).listen(PORT, () => {
  console.log('Cap est lancé : http://localhost:' + PORT);
});
