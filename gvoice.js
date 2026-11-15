'use strict';
/* Voix humaine en ligne : Google Cloud Text-to-Speech, voix « Chirp 3 HD ».
 * Chargé avant app.js. Sans clé, rien ne change : la voix du téléphone parle.
 *
 * Règle d'or : une consigne au carrefour n'attend JAMAIS le réseau.
 *   - les phrases de la prochaine manœuvre sont préparées à l'avance (prefetch) ;
 *   - chaque phrase obtenue est gardée sur l'appareil (elle ne coûte qu'une fois) ;
 *   - si la phrase n'est pas prête en 600 ms, pas de réseau, ou écran verrouillé : la voix du téléphone parle.
 * La clé reste sur l'appareil (réglage ou config.js local) : jamais publiée, sinon n'importe qui la dépenserait.
 */
const GVoice = (() => {
  const API = 'https://texttospeech.googleapis.com/v1/';
  const CACHE = 'cap-gvoice-1';
  const WAIT = 600;                         // ms au plus avant de passer à la voix du téléphone
  const mem = new Map();                    // texte|voix -> URL de l'audio
  const pending = new Map();                // texte|voix -> promesse en cours
  const audio = new Audio();
  audio.preload = 'auto';
  let playing = false;
  let failures = 0;

  const store = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
  const key = () => store('gttsKey') || (window.CAP_CONFIG && window.CAP_CONFIG.gttsKey) || '';
  const voice = () => store('gttsVoice') || 'fr-FR-Chirp3-HD-Achird';
  const on = () => !!key() && store('gttsOn') !== '0' && failures < 5;
  // Écran verrouillé dans le navigateur (pas l'application) : le son web est coupé par l'iPhone, on laisse la voix du téléphone.
  const usable = () => on() && (document.visibilityState === 'visible' || (typeof Native !== 'undefined' && !!Native));
  const id = (text) => voice() + '|' + text;

  // Une phrase -> URL d'un MP3. Gardé en mémoire et dans le cache de l'appareil (survit au redémarrage).
  async function fetchClip(text) {
    const k = id(text);
    if (mem.has(k)) return mem.get(k);
    if (pending.has(k)) return pending.get(k);
    const p = (async () => {
      const fake = 'https://cap.local/gvoice/' + encodeURIComponent(k);
      let blob = null;
      try { const c = await caches.open(CACHE); const hit = await c.match(fake); if (hit) blob = await hit.blob(); } catch { /* pas de cache */ }
      if (!blob) {
        const res = await fetch(API + 'text:synthesize?key=' + encodeURIComponent(key()), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input: { text }, voice: { languageCode: 'fr-FR', name: voice() }, audioConfig: { audioEncoding: 'MP3' } }),
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) { failures++; throw new Error('Google voix ' + res.status); }
        failures = 0;
        const b64 = (await res.json()).audioContent || '';
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        blob = new Blob([bytes], { type: 'audio/mpeg' });
        try { const c = await caches.open(CACHE); await c.put(fake, new Response(blob)); } catch { /* cache plein : tant pis */ }
      }
      const url = URL.createObjectURL(blob);
      mem.set(k, url);
      return url;
    })();
    pending.set(k, p);
    try { return await p; } finally { pending.delete(k); }
  }

  // ---------- file d'attente : une phrase après l'autre, aucune perdue, aucune coupée (sauf par une consigne urgente)
  const queue = [];
  let running = false;
  let gen = 0;                              // change quand une consigne urgente vide la file
  let deviceUntil = 0;                      // la voix du téléphone parle (secours) jusqu'à cet instant

  // Joue un clip et attend sa fin (avec une sécurité si l'événement de fin n'arrive jamais).
  function playClip(url, rate) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; playing = false; audio.removeEventListener('ended', finish); audio.removeEventListener('error', finish); audio.removeEventListener('pause', finish); resolve(true); };
      audio.src = url;
      audio.playbackRate = rate || 1;
      audio.addEventListener('ended', finish);
      audio.addEventListener('error', finish);
      audio.addEventListener('pause', finish);
      playing = true;
      audio.play().then(() => {
        const ms = (isFinite(audio.duration) ? audio.duration * 1000 / (rate || 1) : 8000) + 1500;
        setTimeout(finish, ms);
      }).catch(() => { done = true; playing = false; resolve(false); });
    });
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const withTimeout = (p, ms) => Promise.race([p, sleep(ms).then(() => null)]).catch(() => null);

  async function pump() {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        const it = queue.shift();
        const g = gen;
        // La voix du téléphone finit sa phrase avant qu'on enchaîne (pas deux voix en même temps).
        while (Date.now() < deviceUntil && it.busyDevice()) await sleep(120);
        if (g !== gen) continue;
        const k = id(it.text);
        let url = mem.get(k) || null;
        if (!url && on()) url = await withTimeout(fetchClip(it.text), it.wait);
        if (g !== gen) continue;
        let ok = false;
        if (url) ok = await playClip(url, it.rate);
        if (!ok && g === gen) {
          // Pas prête à temps (ou lecture refusée) : la voix du téléphone dit la phrase, puis on attend qu'elle finisse.
          deviceUntil = Date.now() + 600 + it.text.length * 75;
          it.fallback();
          await sleep(250);
          while (Date.now() < deviceUntil && it.busyDevice()) await sleep(120);
        }
      }
    } finally { running = false; }
  }

  // Dit `text` avec la voix Google. `fallback` : voix du téléphone, si la phrase n'est pas prête à temps.
  // `wait` : combien de temps on accepte d'attendre la phrase (court pour une consigne, plus long pour une réponse).
  function say(text, urgent, fallback, rate, wait, busyDevice) {
    if (!on()) { fallback(); return; }
    const it = { text, fallback, rate, wait: wait || WAIT, busyDevice: busyDevice || (() => false) };
    if (urgent) { gen++; queue.length = 0; audio.pause(); playing = false; deviceUntil = 0; }
    // Une même phrase déjà en attente n'est pas dite deux fois.
    if (queue.some((q) => q.text === text)) return;
    queue.push(it);
    pump();
  }

  // Prépare à l'avance des phrases (ignore les erreurs : ce n'est qu'une avance).
  function prefetch(texts) {
    if (!on()) return;
    for (const t of texts) if (t && !mem.has(id(t))) fetchClip(t).catch(() => {});
  }

  // iPhone : le son est bloqué tant que l'utilisateur n'a pas touché l'écran. Un son vide, au premier appui, le débloque.
  const SILENT = 'data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4LjI5LjEwMAAAAAAAAAAAAAAA//tQxAADB8AhSmxhIIEVCSiJrDCQBTcu3UrAIwUdkRgQbFAZC1CQEwTJ9mjRvBA4UOLD8nKVOWfh+UlK3z/177OXrfOdKl7pyn3Xf//WreyTRUoAWgBgkOAGbZHBgG1OF6zM82DWbZaUmMBptgQhGjsyYqc9ae9XFz280948NMBWInljyzsNRFLPWdnZGWrddDsjK1unuSrVN9jJsK8KuQtQCtMBjCEtImISdNKJOopIpBFpNSMbIHCSRpRR5iakjTiyzLhchUUBwCgyKiweBv/7UsQbg8isVNoMPMjAAAA0gAAABEVFGmgqK////9bP/6XCykxBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
  let unlocked = false;
  function unlock() {
    if (unlocked || !key()) return;
    unlocked = true;
    audio.src = SILENT;
    audio.play().catch(() => { unlocked = false; });
  }
  document.addEventListener('pointerdown', unlock, { capture: true });

  async function list() {
    if (!key()) return [];
    const res = await fetch(API + 'voices?languageCode=fr-FR&key=' + encodeURIComponent(key()), { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error('Google voix ' + res.status);
    return ((await res.json()).voices || []).filter((v) => /Chirp3-HD/.test(v.name) && v.languageCodes.includes('fr-FR'))
      .map((v) => ({ name: v.name, gender: v.ssmlGender }));
  }

  return {
    on, key, voice, say, prefetch, list, unlock,
    busy() { return playing || running || queue.length > 0; },
    stop() { gen++; queue.length = 0; audio.pause(); playing = false; },
    usable,
    setKey(k) { try { if (k) localStorage.setItem('gttsKey', k); else localStorage.removeItem('gttsKey'); } catch { /* stockage indisponible */ } failures = 0; },
    setVoice(v) { try { localStorage.setItem('gttsVoice', v); } catch { /* idem */ } },
  };
})();
