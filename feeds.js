// Lecture des deux flux open data utilisés pour les alertes.
// Utilisé par server.js (en direct, sur le PC) et par tools/build_data.js (fichiers figés pour l'hébergement en ligne).

const FEED = 'https://tipi.bison-fute.gouv.fr/bison-fute-ouvert/publicationsDIR/Evenementiel-DIR/grt/RRN/content.xml';
const RADARS = 'https://www.data.gouv.fr/fr/datasets/r/402aa4fe-86a9-4dcd-af88-23753e290a58';

// ------------------------------------------------------------ événements routiers (Bison Futé, format DATEX II)
const first = (rec, tag) => (rec.match(new RegExp('<ns2:' + tag + '>([^<]*)</ns2:' + tag + '>')) || [])[1] || '';
const named = (rec, kind) =>
  (rec.match(new RegExp('<ns2:value lang="fr">([^<]*)</ns2:value></ns2:values></ns2:descriptor><ns2:tpegOtherPointDescriptorType>' + kind)) || [])[1] || '';
const unxml = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'").replace(/&quot;/g, '"');

// Type DATEX II → ce qu'on affiche. `p` = priorité quand plusieurs événements sont au même endroit.
function classify(type, rec) {
  switch (type) {
    case 'Accident': return { kind: 'accident', title: 'Accident', icon: '🚨', severe: true, p: 9 };
    case 'VehicleObstruction': return { kind: 'obstacle', title: 'Véhicule arrêté sur la route', icon: '⚠️', p: 7 };
    case 'AnimalPresenceObstruction': return { kind: 'obstacle', title: 'Animal sur la route', icon: '⚠️', p: 7 };
    case 'GeneralObstruction':
    case 'EnvironmentalObstruction':
    case 'InfrastructureDamageObstruction': return { kind: 'obstacle', title: 'Obstacle sur la route', icon: '⚠️', p: 7 };
    case 'AbnormalTraffic': return { kind: 'jam', title: 'Bouchon', icon: '🚗', p: 6 };
    case 'WeatherRelatedRoadConditions':
    case 'NonWeatherRelatedRoadConditions': return { kind: 'conditions', title: 'Chaussée dégradée ou glissante', icon: '❄️', p: 5 };
    case 'PoorEnvironmentConditions': return { kind: 'conditions', title: 'Visibilité réduite', icon: '🌫️', p: 5 };
    case 'RoadOrCarriagewayOrLaneManagement': {
      const t = first(rec, 'roadOrCarriagewayOrLaneManagementType');
      if (t === 'roadClosed' || t === 'carriagewayClosures') return { kind: 'closure', title: 'Route fermée', icon: '⛔', severe: true, p: 8 };
      if (t === 'laneClosures') return { kind: 'closure', title: 'Voie fermée', icon: '⛔', p: 4 };
      if (t === 'narrowLanes') return { kind: 'works', title: 'Voies rétrécies', icon: '🚧', p: 3 };
      if (t === 'contraflow') return { kind: 'works', title: 'Basculement de chaussée', icon: '🚧', p: 3 };
      return null; // restrictions poids lourds, etc. : sans intérêt en voiture
    }
    case 'ReroutingManagement': return { kind: 'detour', title: 'Déviation', icon: '↪️', p: 4 };
    case 'MaintenanceWorks':
    case 'ConstructionWorks': return { kind: 'works', title: 'Travaux', icon: '🚧', p: 2 };
    case 'SpeedManagement': {
      const v = first(rec, 'temporarySpeedLimit');
      return v ? { kind: 'speed', title: 'Vitesse limitée à ' + Math.round(Number(v)) + ' km/h', icon: '🐢', p: 1 } : null;
    }
    case 'PublicEvent': return { kind: 'event', title: 'Événement sur la voie publique', icon: '🎪', p: 1 };
    default: return null;
  }
}

function parseIncidents(xml) {
  const now = Date.now();
  const bySpot = new Map();
  for (const chunk of xml.split('<ns2:situationRecord ').slice(1)) {
    const rec = chunk.slice(0, chunk.indexOf('</ns2:situationRecord>'));
    const type = (rec.match(/^xsi:type="ns2:(\w+)"/) || [])[1];
    const info = type && classify(type, rec);
    if (!info) continue;
    if (/<ns2:vehicleType>(lorry|heavyVehicle|articulatedVehicle)/.test(rec) && info.kind !== 'accident') continue;

    const end = Date.parse(first(rec, 'overallEndTime'));
    const start = Date.parse(first(rec, 'overallStartTime'));
    if ((end && end < now) || (start && start > now)) continue;

    const lat = Number(first(rec, 'latitude'));
    const lon = Number(first(rec, 'longitude'));
    if (!lat || !lon) continue;

    const comments = [...rec.matchAll(/<ns2:generalPublicComment>.*?<ns2:value lang="fr">([^<]*)<\/ns2:value>.*?<ns2:commentType>(\w+)<\/ns2:commentType>/g)];
    const where = comments.find((c) => c[2] === 'locationDescriptor');
    const road = named(rec, 'linkName') || first(rec, 'roadNumber').replace(/^([A-Z])0+/, '$1');

    const item = {
      id: (rec.match(/ id="([^"]+)"/) || [])[1] || lat + ',' + lon,
      kind: info.kind, title: info.title, icon: info.icon, severe: !!info.severe, p: info.p,
      lon, lat,
      road: unxml(road), town: unxml(named(rec, 'townName')),
      detail: unxml(where ? where[1] : ''),
    };
    // Un même chantier donne souvent plusieurs enregistrements au même point : on garde le plus important.
    const key = lat.toFixed(3) + ',' + lon.toFixed(3);
    const prev = bySpot.get(key);
    if (!prev || item.p > prev.p) bySpot.set(key, item);
  }
  return [...bySpot.values()];
}

async function fetchIncidents() {
  const res = await fetch(FEED, { signal: AbortSignal.timeout(40000) });
  if (!res.ok) throw new Error('Bison Futé : HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  let xml = buf.toString('utf8');
  if (xml.includes('�')) xml = buf.toString('latin1'); // le flux est parfois en ISO-8859-1
  return parseIncidents(xml);
}

// ------------------------------------------------------------ radars fixes (liste officielle)
// Sert à signaler des « zones de danger » : l'application n'affiche jamais l'emplacement exact.
async function fetchRadars() {
  const res = await fetch(RADARS, { signal: AbortSignal.timeout(40000) });
  if (!res.ok) throw new Error('data.gouv.fr : HTTP ' + res.status);
  const text = Buffer.from(await res.arrayBuffer()).toString('latin1');
  const items = [];
  for (const line of text.split(/\r?\n/).slice(1)) {
    const c = line.split(';'); // numéro ; type ; date ; latitude ; longitude ; vitesse maximale
    const lat = Number(c[3]);
    const lon = Number(c[4]);
    if (lat && lon) items.push({ id: c[0].trim(), lat, lon, limit: parseInt(c[5], 10) || null });
  }
  if (!items.length) throw new Error('data.gouv.fr : liste vide');
  return items;
}

module.exports = { fetchIncidents, fetchRadars };
