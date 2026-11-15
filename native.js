'use strict';
/* Pont vers l'application iPhone native (dossier ios-app/).
 * Chargé AVANT app.js. Dans un navigateur ou en web app, `Native` vaut null et rien ne change.
 * Dans l'application native, il donne accès à ce que le web ne sait pas faire sur iPhone :
 *   - le GPS qui continue quand l'écran est verrouillé ;
 *   - la voix du téléphone (qui continue aussi écran verrouillé) ;
 *   - le maintien de l'écran allumé.
 * Non testé sur un appareil : préparé d'après la documentation des modules.
 */
// Note d'une voix française : plus elle est haute, plus la voix est naturelle. Sert au choix automatique.
// L'iPhone contient des voix volontairement robotiques ou fantaisistes (Eddy, Flo, Rocko, Grand-mère, Cloches…) :
// elles sont écartées d'office. Les voix « premium » puis « optimisées » passent devant, puis les voix classiques.
function voiceScore(name, uri, lang) {
  const id = (name || '') + ' ' + (uri || '');
  if (!/^fr/i.test(lang || '')) return -100;
  if (/eloquence|speech\.synthesis\.voice|novelty|grand-?m.re|grand-?p.re|eddy|flo\b|grandma|grandpa|reed|rocko|sandy|shelley|jacques|bells|boing|bubbles|cellos|whisper|zarvox|trinoids|organ|albert|bahh|fred|junior|ralph|kathy|wobble|superstar|jester|bad news|good news/i.test(id)) return -50;
  let s = /^fr[-_]FR/i.test(lang) ? 20 : 0;
  if (/premium/i.test(id)) s += 60;
  else if (/enhanced|optimis|am.lior/i.test(id)) s += 40;
  if (/siri/i.test(id)) s += 30;
  if (/audrey|aur.lie|thomas|marie|am.lie|chantal|nicolas|hortense|denise|henri|google fran/i.test(id)) s += 10;
  if (/natural|neural|online/i.test(id)) s += 35; // voix neuronales de certains navigateurs
  if (/compact/i.test(id)) s -= 5;
  return s;
}
const savedVoice = () => { try { return localStorage.getItem('voiceName') || ''; } catch { return ''; } };
const voiceRate = () => { try { const v = parseFloat(localStorage.getItem('voiceRate')); return v >= 0.7 && v <= 1.3 ? v : 1; } catch { return 1; } };

const Native = (() => {
  const cap = window.Capacitor;
  if (!cap || typeof cap.isNativePlatform !== 'function' || !cap.isNativePlatform()) return null;
  const P = cap.Plugins || {};
  let speaking = 0;      // nombre d'annonces en cours ou en attente
  let watcherId = null;
  let voiceIndex;        // voix française la plus naturelle installée sur le téléphone (-1 : celle par défaut)
  let voiceName = '';

  // Les voix « premium » ou « optimisées » (à télécharger dans Réglages > Accessibilité > Contenu énoncé > Voix)
  // sont bien plus naturelles que la voix par défaut. On prend la meilleure disponible.
  let list = [];         // voix françaises utilisables : { index, name, score }
  async function pickVoice() {
    voiceIndex = -1;
    voiceName = '';
    try {
      const { voices } = await P.TextToSpeech.getSupportedVoices();
      list = (voices || []).map((v, k) => ({ index: k, name: v.name || ('Voix ' + k), score: voiceScore(v.name, v.voiceURI, v.lang) }))
        .filter((v) => v.score >= 0).sort((x, y) => y.score - x.score);
      const wanted = savedVoice();
      const pick = list.find((v) => v.name === wanted) || list[0];
      if (pick) { voiceIndex = pick.index; voiceName = pick.name; }
    } catch { /* liste indisponible : voix par défaut du téléphone */ }
  }

  return {
    hasVoice: !!P.TextToSpeech,
    hasGps: !!P.BackgroundGeolocation,

    // Voix native. `urgent` coupe l'annonce en cours.
    async speak(text, urgent) {
      if (!P.TextToSpeech) return false;
      try {
        if (urgent) { await P.TextToSpeech.stop(); speaking = 0; }
        speaking++;
        if (voiceIndex === undefined) await pickVoice();
        const opts = { text, lang: 'fr-FR', rate: voiceRate(), pitch: 1.0, volume: 1.0, category: 'playback' };
        if (voiceIndex >= 0) opts.voice = voiceIndex;
        await P.TextToSpeech.speak(opts);
      } catch { /* annonce interrompue ou voix indisponible */ } finally {
        speaking = Math.max(0, speaking - 1);
      }
      return true;
    },
    stopVoice() { speaking = 0; if (P.TextToSpeech) P.TextToSpeech.stop().catch(() => {}); },
    busy() { return speaking > 0; },
    voiceName() { return voiceName; },
    // Liste des voix françaises du téléphone, de la plus naturelle à la moins naturelle.
    async voices() { await pickVoice(); return list.map((v) => ({ name: v.name, score: v.score })); },
    async useVoice() { await pickVoice(); },

    // GPS natif : appelle `onFix` à chaque position, y compris écran verrouillé.
    async watch(onFix, onError) {
      if (!P.BackgroundGeolocation) return false;
      try {
        watcherId = await P.BackgroundGeolocation.addWatcher({
          backgroundTitle: 'Cap', backgroundMessage: 'Guidage en cours', requestPermissions: true, stale: false, distanceFilter: 0,
        }, (loc, err) => {
          if (err) { onError(err); return; }
          if (!loc) return;
          onFix({ coords: { longitude: loc.longitude, latitude: loc.latitude, accuracy: loc.accuracy, speed: loc.speed, heading: loc.bearing } });
        });
        return true;
      } catch (e) { onError(e); return false; }
    },
    unwatch() {
      if (watcherId !== null && P.BackgroundGeolocation) P.BackgroundGeolocation.removeWatcher({ id: watcherId }).catch(() => {});
      watcherId = null;
    },

    keepAwake(on) {
      if (!P.KeepAwake) return;
      (on ? P.KeepAwake.keepAwake() : P.KeepAwake.allowSleep()).catch(() => {});
    },
  };
})();
