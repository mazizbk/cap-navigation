'use strict';
/* Compte Google (lecture seule) : agenda et mails, et contacts de l'iPhone.
 * Chargé avant ai.js et voice.js.
 *   - sur le PC (navigateur) : connexion Google classique (fenêtre Google), jeton valable 1 heure ;
 *   - dans l'application iPhone : Google refuse la connexion à l'intérieur d'une application, donc on ouvre
 *     Safari, Google renvoie vers l'application, et on garde un jeton de renouvellement sur le téléphone.
 * Rien n'est publié : les jetons restent sur l'appareil. Seuls l'objet, l'expéditeur, la date et un court
 * extrait des mails sont lus (jamais le mail entier), et uniquement quand le conducteur le demande.
 */
const GAccount = (() => {
  const CFG = window.CAP_CONFIG || {};
  // Identifiants publics des deux accès Google (ce ne sont pas des secrets).
  const WEB_CLIENT = CFG.gWebClient || '717554430786-jk0pnhhdvkduj94366cb6o7qvhfb1mr2.apps.googleusercontent.com';
  const IOS_CLIENT = CFG.gIosClient || '717554430786-siugeo6edd3vrghl38j89t906g9h415c.apps.googleusercontent.com';
  const SCOPES = 'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/gmail.readonly';
  const cap = window.Capacitor;
  const native = !!(cap && cap.isNativePlatform && cap.isNativePlatform());
  const P = native ? cap.Plugins || {} : {};
  const REDIRECT_SCHEME = IOS_CLIENT ? 'com.googleusercontent.apps.' + IOS_CLIENT.replace('.apps.googleusercontent.com', '') : '';
  const REDIRECT = REDIRECT_SCHEME + ':/oauth2redirect';

  const get = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
  const put = (k, v) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* stockage indisponible */ } };

  let token = get('gTok');
  let expires = Number(get('gTokExp')) || 0;
  const saveToken = (t, secs) => { token = t; expires = Date.now() + (secs - 60) * 1000; put('gTok', t); put('gTokExp', String(expires)); };

  const available = () => (native ? !!(IOS_CLIENT && P.Browser) : !!WEB_CLIENT);
  const connected = () => !!(native ? get('gRefresh') : token && Date.now() < expires);

  // ---------- application iPhone : connexion par Safari (PKCE)
  const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  let verifier = '';
  let waiting = null;

  async function postForm(url, data) {
    const body = new URLSearchParams(data).toString();
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
      return await res.json();
    } catch {
      // Si le navigateur intégré bloque l'appel, on passe par la couche réseau native (uniquement pour cet appel).
      if (!P.CapacitorHttp) throw new Error('réseau');
      const r = await P.CapacitorHttp.post({ url, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, data: body });
      return typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
    }
  }

  async function nativeConnect() {
    const arr = crypto.getRandomValues(new Uint8Array(48));
    verifier = b64url(arr);
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
      client_id: IOS_CLIENT, redirect_uri: REDIRECT, response_type: 'code', scope: SCOPES,
      code_challenge: challenge, code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent',
    });
    const done = new Promise((resolve, reject) => { waiting = { resolve, reject }; setTimeout(() => reject(new Error('connexion abandonnée')), 300000); });
    await P.Browser.open({ url });
    return done;
  }

  async function onRedirect(url) {
    if (!REDIRECT_SCHEME || !url.startsWith(REDIRECT_SCHEME)) return;
    try { await P.Browser.close(); } catch { /* déjà fermé */ }
    const q = new URL(url.replace(REDIRECT_SCHEME + ':', 'https://x')).searchParams;
    if (!waiting) return;
    const w = waiting; waiting = null;
    if (q.get('error') || !q.get('code')) { w.reject(new Error(q.get('error') || 'pas de code')); return; }
    const j = await postForm('https://oauth2.googleapis.com/token', { client_id: IOS_CLIENT, code: q.get('code'), code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: REDIRECT });
    if (!j.access_token) { w.reject(new Error(j.error_description || j.error || 'jeton refusé')); return; }
    if (j.refresh_token) put('gRefresh', j.refresh_token);
    saveToken(j.access_token, j.expires_in || 3600);
    w.resolve(true);
  }
  if (native && P.App) P.App.addListener('appUrlOpen', (e) => { onRedirect(e.url).catch(() => {}); });

  async function nativeRefresh() {
    const rt = get('gRefresh');
    if (!rt) throw new Error('compte Google non connecté');
    const j = await postForm('https://oauth2.googleapis.com/token', { client_id: IOS_CLIENT, refresh_token: rt, grant_type: 'refresh_token' });
    if (!j.access_token) { put('gRefresh', ''); throw new Error('reconnectez le compte Google (accès expiré)'); }
    saveToken(j.access_token, j.expires_in || 3600);
  }

  // ---------- navigateur (PC) : connexion Google Identity Services
  let gisClient = null;
  function loadGis() {
    return new Promise((resolve, reject) => {
      if (window.google && google.accounts && google.accounts.oauth2) { resolve(); return; }
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.onload = resolve; s.onerror = () => reject(new Error('Google injoignable'));
      document.head.appendChild(s);
    });
  }
  async function webConnect(silent) {
    await loadGis();
    return new Promise((resolve, reject) => {
      gisClient = google.accounts.oauth2.initTokenClient({
        client_id: WEB_CLIENT, scope: SCOPES,
        callback: (r) => { if (r.error || !r.access_token) reject(new Error(r.error || 'refus')); else { saveToken(r.access_token, Number(r.expires_in) || 3600); resolve(true); } },
        error_callback: (e) => reject(new Error(e.type || 'fenêtre fermée')),
      });
      gisClient.requestAccessToken({ prompt: silent ? '' : 'consent' });
    });
  }

  async function connect() {
    if (!available()) throw new Error('connexion Google pas encore configurée');
    return native ? nativeConnect() : webConnect(false);
  }
  function disconnect() { token = ''; expires = 0; put('gTok', ''); put('gTokExp', ''); put('gRefresh', ''); }

  async function accessToken() {
    if (token && Date.now() < expires) return token;
    if (native) { await nativeRefresh(); return token; }
    throw new Error('compte Google non connecté (Réglages › Compte Google)');
  }

  async function api(url) {
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + await accessToken() }, signal: AbortSignal.timeout(10000) });
    if (res.status === 401) { token = ''; expires = 0; throw new Error('accès Google expiré, reconnectez le compte'); }
    if (!res.ok) throw new Error('Google ' + res.status);
    return res.json();
  }

  // Prochains rendez-vous : titre, début, lieu.
  async function agenda(days = 7) {
    const now = new Date();
    const to = new Date(now.getTime() + Math.min(31, Math.max(1, days)) * 86400000);
    const j = await api('https://www.googleapis.com/calendar/v3/calendars/primary/events?' + new URLSearchParams({
      timeMin: now.toISOString(), timeMax: to.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '10',
      fields: 'items(summary,start,end,location)',
    }));
    return (j.items || []).map((e) => ({ titre: e.summary || '(sans titre)', debut: e.start.dateTime || e.start.date, fin: e.end && (e.end.dateTime || e.end.date), lieu: e.location || '' }));
  }

  // Mails : au plus 5, objet / expéditeur / date / court extrait. Jamais le mail entier.
  async function mails(query) {
    const list = await api('https://gmail.googleapis.com/gmail/v1/users/me/messages?' + new URLSearchParams({ q: query || 'newer_than:30d', maxResults: '5' }));
    const out = [];
    for (const m of list.messages || []) {
      const d = await api('https://gmail.googleapis.com/gmail/v1/users/me/messages/' + m.id + '?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date');
      const h = Object.fromEntries((d.payload && d.payload.headers || []).map((x) => [x.name, x.value]));
      out.push({ objet: h.Subject || '', de: (h.From || '').replace(/<[^>]*>/, '').trim(), date: h.Date || '', extrait: (d.snippet || '').slice(0, 300) });
    }
    return out;
  }

  // Contacts de l'iPhone (application native seulement) : nom et adresses postales, rien d'autre.
  async function contact(name) {
    if (!native || !P.Contacts) throw new Error('contacts disponibles seulement dans l\'application iPhone');
    const perm = await P.Contacts.requestPermissions();
    if (perm && perm.contacts && perm.contacts !== 'granted') throw new Error('accès aux contacts refusé');
    const { contacts } = await P.Contacts.getContacts({ projection: { name: true, postalAddresses: true } });
    const norm = (t) => (t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const want = norm(name).split(/\s+/).filter(Boolean);
    return (contacts || []).map((c) => ({ nom: (c.name && (c.name.display || [c.name.given, c.name.family].filter(Boolean).join(' '))) || '', adresses: (c.postalAddresses || []).map((a) => [a.street, a.postcode, a.city, a.country].filter(Boolean).join(', ')).filter(Boolean) }))
      .filter((c) => c.nom && want.every((w) => norm(c.nom).includes(w))).slice(0, 5);
  }

  // Réglages
  function show() {
    const st = $('gacc-state');
    if (!available()) { st.textContent = native ? 'Connexion Google pas encore disponible dans cette version de l\'application.' : 'Connexion Google pas encore configurée.'; return; }
    st.textContent = connected() ? 'Compte Google connecté (lecture seule : agenda et mails).' : 'Non connecté.';
    $('gacc-btn').textContent = connected() ? 'Déconnecter' : 'Connecter mon compte Google';
  }
  $('gacc-btn').addEventListener('click', async () => {
    if (connected()) { disconnect(); show(); return; }
    $('gacc-state').textContent = native ? 'Safari s\'ouvre : connectez-vous, puis revenez ici.' : 'Fenêtre Google ouverte…';
    try { await connect(); speak('Compte Google connecté.'); } catch (e) { $('gacc-state').textContent = 'Échec : ' + e.message; return; }
    show();
  });
  show();

  return { native, available, connected, connect, agenda, mails, contact, contactsAvailable: () => native && !!P.Contacts };
})();
