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
  let seq = 0;
  let failures = 0;
  audio.addEventListener('ended', () => { playing = false; });
  audio.addEventListener('error', () => { playing = false; });

  const store = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
  const key = () => store('gttsKey') || (window.CAP_CONFIG && window.CAP_CONFIG.gttsKey) || '';
  const voice = () => store('gttsVoice') || 'fr-FR-Chirp3-HD-Achernar';
  const on = () => !!key() && store('gttsOn') !== '0' && failures < 5;
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

  function play(url, rate) {
    audio.src = url;
    audio.playbackRate = rate || 1;
    playing = true;
    return audio.play().catch((e) => { playing = false; throw e; });
  }

  // Dit `text` avec la voix Google. `fallback` (voix du téléphone) est appelé si ce n'est pas possible à temps.
  function say(text, urgent, fallback, rate) {
    const my = ++seq;
    if (!on() || document.visibilityState !== 'visible' || !navigator.onLine) { fallback(); return; }
    if (!urgent && playing) {
      // Une annonce est en cours : on enchaîne à la fin, sans la couper.
      audio.addEventListener('ended', () => { if (seq === my) say(text, true, fallback, rate); }, { once: true });
      return;
    }
    if (urgent) { audio.pause(); playing = false; }
    const k = id(text);
    if (mem.has(k)) { play(mem.get(k), rate).catch(fallback); return; }
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; fallback(); } }, WAIT);
    fetchClip(text).then((url) => {
      if (done || seq !== my) return;          // trop tard : la voix du téléphone a déjà parlé
      done = true; clearTimeout(timer);
      play(url, rate).catch(fallback);
    }).catch(() => { if (!done) { done = true; clearTimeout(timer); fallback(); } });
  }

  // Prépare à l'avance des phrases (ignore les erreurs : ce n'est qu'une avance).
  function prefetch(texts) {
    if (!on() || !navigator.onLine) return;
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
    busy() { return playing; },
    stop() { seq++; audio.pause(); playing = false; },
    setKey(k) { try { if (k) localStorage.setItem('gttsKey', k); else localStorage.removeItem('gttsKey'); } catch { /* stockage indisponible */ } failures = 0; },
    setVoice(v) { try { localStorage.setItem('gttsVoice', v); } catch { /* idem */ } },
  };
})();
