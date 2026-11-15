# Cap — prototype de navigation immersive

Application web installable (PWA) de navigation en voiture : carte en vue inclinée sur photos aériennes,
guidage virage par virage avec voix, vraie photo de la route pendant le trajet, alertes trafic et zones de danger.
Aucune clé d'API, aucun compte : uniquement des données ouvertes.

## Lancer sur le PC

```bash
node server.js
```

Puis ouvrir http://localhost:5173. Il faut Node.js 18 ou plus récent, rien d'autre à installer.

Saisir une destination (le départ vide = position GPS), **Itinéraire**, puis **Simuler** pour rejouer le trajet
sans bouger (bouton ×1 / ×2 / ×5 / ×10 pour accélérer) ou **Démarrer** pour le guidage GPS réel.

## Ce que fait l'application

| Fonction | Source des données |
|---|---|
| Carte inclinée, bâtiments en relief, noms de rues | MapLibre GL + OpenFreeMap (OpenStreetMap) |
| Vue réelle (photos aériennes), bouton Plan / Vue réelle | IGN Géoplateforme — France uniquement |
| Recherche d'adresse | Nominatim (OpenStreetMap) |
| Itinéraire voiture, instructions, voies | OSRM (serveur public de démonstration) |
| Photo de la route pendant le trajet, photo de l'arrivée | Panoramax (Mapillary en secours pour l'arrivée, si jeton) |
| Alertes : accidents, obstacles, travaux, routes fermées | Bison Futé, open data temps réel — réseau routier national seulement |
| Zones de danger | Liste officielle des radars fixes (data.gouv.fr), OpenStreetMap en secours |
| Voix | Synthèse vocale du téléphone (sort sur les haut-parleurs de la voiture en Bluetooth) |

## Limites connues

- **Ce n'est pas la vue immersive de Google.** Google utilise sa propre maquette 3D photoréaliste, qui n'existe pas
  en données ouvertes. Ici : photos aériennes vues en biais + photos de rue là où des contributeurs en ont pris.
  La couverture Panoramax est très inégale (dense à Paris, quasi vide dans beaucoup de rues).
- **Pas de données Waze.** Waze bloque les accès automatisés à sa carte en direct ; ce blocage n'est pas contourné.
  Les alertes Bison Futé couvrent les nationales et autoroutes non concédées, pas les rues ni les signalements d'usagers.
- **Zones de danger, pas « radars ».** En France, signaler l'emplacement exact d'un radar pendant la conduite est
  interdit ; l'application annonce une zone (300 m en ville, 2 km sur route, 4 km sur autoroute) et dit « Ralentissez »
  si la vitesse GPS dépasse la limite. Elle n'agit jamais sur la voiture.
- **Écran de la voiture.** En Bluetooth, une voiture ne reçoit que du son et le titre « en cours de lecture ».
  L'option expérimentale affiche la consigne à la place du titre du morceau (non testée sur une vraie voiture).
- **Alertes : en direct sur le PC, toutes les 15 min en ligne.** Les flux Bison Futé et radars ne sont pas lisibles
  directement par un navigateur. Sur le PC, `server.js` les relaie en direct. En ligne, l'application lit
  `data/incidents.json` et `data/radars.json`, régénérés toutes les 15 minutes par `tools/build_data.js`.
- OSRM et Nominatim publics sont des services de démonstration : pas pour un usage intensif.

## Installer sur iPhone

Le GPS d'un navigateur n'est autorisé que sur une adresse **https**. L'application est prévue pour être publiée
gratuitement sur GitHub Pages : le fichier `.github/workflows/publier.yml` la met en ligne à chaque envoi de code
et rafraîchit les alertes toutes les 15 minutes. Le PC n'a pas besoin de rester allumé.

Une fois l'adresse en ligne (du type `https://<compte>.github.io/cap-navigation/`) :

1. ouvrir l'adresse dans **Safari** sur l'iPhone ;
2. bouton Partager → **Sur l'écran d'accueil** ;
3. lancer « Cap » depuis l'écran d'accueil et autoriser la localisation « Lorsque l'app est active ».

L'écran doit rester allumé pendant le guidage (l'application demande à iOS de ne pas le mettre en veille).
GitHub suspend les mises à jour automatiques d'un dépôt resté 60 jours sans modification.

## Fichiers

- `index.html`, `style.css` — l'interface
- `app.js` — carte, recherche, itinéraire, guidage, simulation, voix
- `street.js` — photo de la route qui suit le trajet
- `hazards.js` — alertes trafic, zones de danger, écran de la voiture
- `geo.js` — calculs de distance et de cap
- `server.js` — serveur local et relais des alertes (`/api/incidents`, `/api/radars`)
- `feeds.js` — lecture des flux Bison Futé et radars
- `tools/build_data.js`, `data/` — alertes en fichiers, pour la version en ligne
- `.github/workflows/publier.yml` — mise en ligne automatique
- `sw.js`, `manifest.webmanifest`, `icons/` — installation sur l'écran d'accueil
- `tools/make_icons.py` — régénère les icônes
