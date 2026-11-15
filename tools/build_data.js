// Fabrique les fichiers d'alertes utilisés quand l'application est hébergée en ligne (sans server.js) :
//   data/incidents.json   événements routiers Bison Futé
//   data/radars.json      radars fixes officiels
// Usage : node tools/build_data.js   (lancé automatiquement toutes les 15 min par GitHub, voir .github/workflows)
// Si un flux ne répond pas, le fichier précédent est conservé.
const fs = require('fs');
const path = require('path');
const feeds = require('../feeds');

const DIR = path.join(__dirname, '..', 'data');

async function build(name, load, wrap) {
  try {
    const items = await load();
    fs.writeFileSync(path.join(DIR, name), JSON.stringify(wrap(items)));
    console.log(name + ' : ' + items.length + ' éléments');
  } catch (e) {
    console.warn(name + ' non mis à jour (' + e.message + ')');
  }
}

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  await build('incidents.json', feeds.fetchIncidents, (incidents) => ({ ok: true, updated: Date.now(), incidents }));
  await build('radars.json', feeds.fetchRadars, (radars) => ({ ok: true, radars }));
})();
