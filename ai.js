'use strict';
/* Compréhension des commandes vocales par Claude (facultatif).
 * Sans clé : rien ne change, voice.js reconnaît des phrases fixes.
 * Avec une clé API Anthropic : on peut parler librement (« j'ai presque plus d'essence », « ramène-moi »,
 * « on arrive quand ? »). Claude traduit la phrase en UNE commande connue de l'application, ou répond en une phrase.
 * La clé reste sur l'appareil (stockage local) : elle n'est jamais publiée avec le site.
 */
const AI = (() => {
  const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.8.0/+esm';
  const MODEL = 'claude-opus-5-5';
  let sdk = null;
  let client = null;
  let clientKey = '';

  // La clé vient du réglage enregistré sur l'appareil, ou du fichier config.js LOCAL (jamais celui publié en ligne :
  // une clé Anthropic mise sur un site public serait utilisable par n'importe qui).
  const key = () => {
    try { const k = localStorage.getItem('anthropicKey'); if (k) return k; } catch { /* stockage indisponible */ }
    return (window.CAP_CONFIG && window.CAP_CONFIG.anthropicKey) || '';
  };
  const setKey = (k) => { try { if (k) localStorage.setItem('anthropicKey', k); else localStorage.removeItem('anthropicKey'); } catch { /* stockage indisponible */ } client = null; };

  const COMMANDS = ['recherche', 'destination', 'domicile', 'travail', 'station_moins_chere', 'station_plus_proche', 'stations', 'arreter', 'silence',
    'remettre_le_son', 'repeter', 'heure_arrivee', 'trafic', 'eviter_peages', 'autoriser_peages', 'eviter_autoroutes', 'autoriser_autoroutes',
    'demarrer', 'recentrer', 'changer_vue', 'autre_trajet', 'enregistrer_domicile', 'enregistrer_travail', 'parking', 'oui', 'non', 'trajet_economique', 'cout_trajet', 'aucune'];

  const TOOL = {
    name: 'commande',
    description: 'Exécute dans l\'application de navigation la commande que le conducteur vient de demander à voix haute.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        commande: { type: 'string', enum: COMMANDS, description: 'La commande à exécuter. « aucune » si la phrase n\'en demande pas.' },
        requetes: { type: 'array', items: { type: 'string' }, description: 'Pour « recherche » : 1 à 3 recherches courtes à lancer (nom exact d\'une enseigne, catégorie de lieu, nom de lieu). Jamais d\'adresse inventée. Liste vide sinon.' },
        lieu: { type: 'string', description: 'Pour « destination » : l\'adresse ou le lieu, tel qu\'on le taperait dans une recherche (ex. « gare de Nantes »). Vide sinon.' },
        reponse: { type: 'string', description: 'Pour « aucune » : une réponse d\'une seule phrase courte, dite à voix haute au conducteur. Vide sinon.' },
      },
      required: ['commande', 'requetes', 'lieu', 'reponse'],
      additionalProperties: false,
    },
  };

  const SYSTEM = [
    'Tu es l\'assistant vocal de Cap, une application de navigation en voiture. Le conducteur a un TDAH et conduit : il lui faut des réponses très courtes et sans ambiguïté.',
    'On te donne une phrase dictée (la reconnaissance vocale peut l\'avoir déformée) et l\'état de l\'application. Appelle toujours l\'outil « commande », une seule fois.',
    'Choisis la commande qui correspond à ce que le conducteur veut obtenir, même s\'il le dit de façon indirecte : « je n\'ai presque plus d\'essence » veut dire stations ; « ramène-moi » veut dire domicile ; « tais-toi » veut dire silence ; « c\'est quand qu\'on arrive » veut dire heure_arrivee.',
    '« autre_trajet » passe à la variante d\'itinéraire suivante (avant le départ). « changer_vue » bascule entre plan et photo aérienne. « enregistrer_domicile » / « enregistrer_travail » mémorisent la destination affichée.',
    '« parking » cherche où se garer près de l\'arrivée (gratuit d\'abord). « oui » / « non » répondent à une proposition que l\'application vient de faire. « trajet_economique » choisit la variante qui consomme le moins ; « cout_trajet » dit le coût en carburant.',
    '« recherche » : le conducteur cherche un lieu ou un type de lieu (« un McDo » -> ["McDonald\'s"], « j\'ai faim » -> ["restaurant", "boulangerie"], « une pharmacie de garde » -> ["pharmacie"]). « destination » : il donne une adresse ou un lieu précis. Dans les deux cas l\'application lui proposera une liste à choisir. Tu ne connais pas les horaires d\'ouverture : ne les promets jamais.',
    'Pour le carburant : « station_moins_chere » ou « station_plus_proche » seulement si le conducteur a précisé ce critère ; sinon « stations », qui lui présente les deux.',
    'Si la phrase ne demande rien que l\'application sache faire, choisis « aucune » et réponds en une phrase courte, en français, sans liste ni mise en forme, car elle sera lue à voix haute. Si tu ne sais pas, dis-le simplement. Ne donne jamais de conseil qui détourne l\'attention de la route.',
  ].join('\n');

  async function getClient() {
    if (!sdk) sdk = await import(SDK_URL);
    const Anthropic = sdk.default || sdk.Anthropic;
    if (!client || clientKey !== key()) {
      clientKey = key();
      // Appel direct depuis l'appareil : la clé est celle de l'utilisateur, stockée chez lui.
      client = new Anthropic({ apiKey: clientKey, dangerouslyAllowBrowser: true, maxRetries: 1, timeout: 15000 });
    }
    return { client, Anthropic };
  }

  // Renvoie { commande, lieu, reponse }, ou lève une erreur (voice.js revient alors aux phrases fixes).
  async function understand(heard, state) {
    const { client: c, Anthropic } = await getClient();
    let response;
    try {
      response = await c.beta.messages.create({
        model: MODEL,
        max_tokens: 2000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'low' },
        system: SYSTEM,
        tools: [TOOL],
        messages: [{ role: 'user', content: 'État de l\'application : ' + JSON.stringify(state) + '\nPhrase dictée : « ' + heard + ' »' }],
      });
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError) throw new Error('clé Claude refusée');
      if (error instanceof Anthropic.RateLimitError) throw new Error('trop de demandes à Claude');
      if (error instanceof Anthropic.APIError) throw new Error('Claude ' + (error.status || '') + ' ' + error.message);
      throw error;
    }
    if (response.stop_reason === 'refusal') throw new Error('demande refusée par Claude');
    for (const block of response.content) {
      if (block.type === 'tool_use' && block.name === 'commande' && block.input && COMMANDS.includes(block.input.commande)) return block.input;
    }
    // Pas d'appel d'outil : on prend le texte comme réponse à dire.
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
    if (text) return { commande: 'aucune', lieu: '', reponse: text };
    throw new Error('réponse de Claude vide');
  }

  // Réglages : la clé se colle une fois, sur l'appareil.
  const input = $('akey');
  const note = $('akey-note');
  const show = () => { note.textContent = key() ? 'Claude est activé pour les commandes vocales (clé enregistrée sur cet appareil).' : 'Sans clé, les commandes vocales reconnaissent des phrases fixes.'; };
  $('akey-save').addEventListener('click', () => { const v = input.value.trim(); if (v) { setKey(v); input.value = ''; } show(); });
  $('akey-clear').addEventListener('click', () => { setKey(''); input.value = ''; show(); });
  show();

  return { get enabled() { return !!key(); }, understand, MODEL };
})();
