'use strict';
/* Pont vers l'application iPhone native (dossier ios-app/).
 * Chargé AVANT app.js. Dans un navigateur ou en web app, `Native` vaut null et rien ne change.
 * Dans l'application native, il donne accès à ce que le web ne sait pas faire sur iPhone :
 *   - le GPS qui continue quand l'écran est verrouillé ;
 *   - la voix du téléphone (qui continue aussi écran verrouillé) ;
 *   - le maintien de l'écran allumé.
 * Non testé sur un appareil : préparé d'après la documentation des modules.
 */
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
  async function pickVoice() {
    voiceIndex = -1;
    try {
      const { voices } = await P.TextToSpeech.getSupportedVoices();
      let best = -1;
      (voices || []).forEach((v, k) => {
        if (!/^fr/i.test(v.lang || '')) return;
        const id = (v.name || '') + ' ' + (v.voiceURI || '');
        const score = (/premium/i.test(id) ? 6 : /enhanced|optimis|am.lior/i.test(id) ? 4 : 0) + (/^fr[-_]FR/i.test(v.lang) ? 2 : 0) - (/compact/i.test(id) ? 1 : 0);
        if (score > best) { best = score; voiceIndex = k; voiceName = v.name || ''; }
      });
    } catch { /* liste indisponible : voix par défaut */ }
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
        const opts = { text, lang: 'fr-FR', rate: 1.0, pitch: 1.0, volume: 1.0, category: 'playback' };
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
