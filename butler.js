'use strict';
/* Mode majordome : quand on monte en voiture, Cap s'ouvre (raccourci iPhone sur la connexion Bluetooth de l'Audi,
 * qui ouvre le lien capnav://majordome), salue le conducteur, prend de ses nouvelles et lui demande où aller.
 * Avec Claude, la conversation est libre ; sans Claude, un dialogue simple et fixe.
 * Chargé après voice.js : utilise S, $, speak, voiceBusy, Voice, AI, GAccount, Sug, Places.
 */
const Butler = (() => {
  const get = (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } };
  const set = (k, v) => { try { localStorage.setItem(k, v); } catch { /* stockage indisponible */ } };
  const title = () => get('butlerTitle', 'monsieur');
  let lastAt = 0;

  // Attend que la voix ait fini de parler (au plus 12 s).
  async function quiet() {
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, 400));
    while (Date.now() - t0 < 12000 && (voiceBusy() || performance.now() < (S.voiceUntil || 0))) await new Promise((r) => setTimeout(r, 200));
    await new Promise((r) => setTimeout(r, 250));
  }

  // Prochain rendez-vous d'aujourd'hui avec une adresse (si le compte Google est connecté).
  async function todaysMeeting() {
    try {
      if (!GAccount.connected()) return null;
      const now = new Date();
      const ev = (await GAccount.agenda(1)).find((e) => e.lieu && new Date(e.debut) > now && new Date(e.debut).toDateString() === now.toDateString());
      return ev || null;
    } catch { return null; }
  }

  // Après « Vous allez bien ? » : réponse, puis la question de la destination.
  async function onMood(heard) {
    if (typeof AI !== 'undefined' && AI.enabled) {
      // Claude répond avec le ton du majordome et pose lui-même la question suivante (voir ai.js : accueil).
      S.butlerGreeting = true;
      try { await Voice.run(heard); } finally { S.butlerGreeting = false; }
      return;
    }
    const q = heard.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const low = /\b(pas (tres )?bien|fatigue|creve|mal|bof|moyen|stresse|triste|malade)\b/.test(q);
    const first = low ? 'Je suis navré, ' + title() + '. Je ferai en sorte que le trajet soit le plus simple possible.' : 'Ravi de l\'entendre, ' + title() + '.';
    await askDestination(first);
  }

  async function askDestination(first) {
    // 1. Un trajet était en cours (application fermée en route) : on propose de le reprendre.
    if (!$('resume-nav').hidden) {
      speak(first + ' Voulez-vous reprendre le trajet en cours ?', true);
      Voice.setPending(() => $('resume-nav').click());
      Voice.askAgain();
      return;
    }
    // 2. Un rendez-vous aujourd'hui avec une adresse : on le propose.
    const ev = await todaysMeeting();
    if (ev) {
      const d = new Date(ev.debut);
      const leave = typeof Plus !== 'undefined' ? await Plus.leaveLine(ev) : '';
      speak(first + ' Vous avez « ' + ev.titre + ' » à ' + d.getHours() + ' heures' + (d.getMinutes() ? ' ' + d.getMinutes() : '') + '. ' + (leave ? leave + ' ' : '') + 'Souhaitez-vous que nous y allions ?', true);
      Voice.setPending(() => { S.meeting = ev; return Sug.open(ev.lieu, [], true, ''); });
      Voice.askAgain();
      return;
    }
    // 3. Un trajet habituel à cette heure-ci : on le propose (un « oui » suffit pour partir).
    const hab = typeof Plus !== 'undefined' ? Plus.habit() : null;
    if (hab) {
      speak(first + ' ' + await Plus.habitPhrase(hab), true);
      Voice.setPending(() => Plus.goHabit(hab));
      Voice.askAgain();
      return;
    }
    // 3. Sinon, la question simple.
    speak(first + ' Où souhaitez-vous aller ?', true);
    Voice.askAgain();
  }

  // Salutation, puis écoute de la réponse.
  async function start(force) {
    if (!force && Date.now() - lastAt < 30 * 60000) return false; // pas deux accueils en une demi-heure
    if (!force && get('butlerOn', '1') !== '1') return false;
    if (S.mode === 'nav') return false; // déjà en route : pas de bonjour en plein guidage
    lastAt = Date.now();
    const h = new Date().getHours();
    const hello = h >= 18 || h < 5 ? 'Bonsoir' : 'Bonjour';
    await new Promise((r) => setTimeout(r, 900)); // le temps que l'application s'affiche
    speak(hello + ' ' + title() + '. Vous allez bien ?', true);
    await quiet();
    Voice.onNextAnswer(onMood);
    Voice.listen();
    return true;
  }

  // Réglages
  $('butler-title').value = title();
  $('butler-title').addEventListener('change', () => set('butlerTitle', $('butler-title').value.trim() || 'monsieur'));
  $('butler-on').checked = get('butlerOn', '1') === '1';
  $('butler-on').addEventListener('change', () => set('butlerOn', $('butler-on').checked ? '1' : '0'));
  $('butler-test').addEventListener('click', () => { $('prefs').hidden = true; start(true); });

  return { start, title, answer: onMood };
})();
