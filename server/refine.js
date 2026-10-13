// Reformulation d’une demande de carte par l’API Messages d’Anthropic.
// Appel HTTP direct (fetch intégré à Node) pour ne pas ajouter de dépendance.
// La clé reste sur le serveur : elle n’est jamais renvoyée au navigateur.
export const DEFAULT_REFINE_MODEL = 'claude-opus-5-5';
// Modèles qui acceptent le repli automatique côté serveur (`fallbacks: "default"`).
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
const LIMITS = { title: 140, description: 20000, exchanges: 20, question: 1000, answer: 4000, questions: 6 };

const refineError = (status, code, message) => Object.assign(new Error(message), { status, code });

const schema = {
  type: 'object', additionalProperties: false,
  properties: {
    prompt: { type: 'string', description: 'La demande reformulée, prête à être transmise à l’agent.' },
    questions: { type: 'array', items: { type: 'string' }, description: 'Questions précises sur les points ambigus ou manquants ; liste vide si la demande est claire.' },
  },
  required: ['prompt', 'questions'],
};

export const refineInstructions = `Tu prépares des demandes pour un agent de développement IA (Codex ou Claude Code) qui les traitera plus tard, seul, dans le dépôt du projet.
Tu ne réalises pas la demande et tu ne modifies rien : tu analyses le texte rédigé ou dicté par une personne, puis tu le reformules en une demande claire et directement exploitable par cet agent.

Règles :
- Conserve fidèlement l’intention, le périmètre et toutes les informations utiles. N’invente ni fonctionnalité, ni contrainte, ni nom de fichier, ni détail technique absent de la demande.
- Le texte peut provenir d’une dictée : corrige les erreurs de transcription évidentes, la ponctuation, les hésitations et les répétitions.
- Rédige en français, à l’impératif, sans formule de politesse ni commentaire sur ton travail. Structure la demande avec des titres courts en texte brut, par exemple : « Objectif », « Contexte », « Comportement attendu », « Contraintes », « Vérification ». Omets une rubrique sans contenu utile.
- La rubrique « Vérification » décrit comment constater que la demande est réalisée, uniquement à partir de ce que la personne a exprimé.
- Si une information essentielle manque ou si un point est ambigu, ne tranche pas à la place de la personne : pose une question précise dans questions (six au maximum, les plus importantes d’abord) et signale ce point par « À préciser » dans la demande reformulée.
- Intègre les réponses déjà apportées aux questions précédentes et ne repose pas une question déjà répondue.
- Si la demande est claire et complète, renvoie une liste questions vide.`;

export function validateRefinement(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw refineError(400, 'invalid_refinement', 'Corps de requête invalide.');
  const text = (value, max, label) => {
    if (value == null) return '';
    if (typeof value !== 'string' || value.length > max) throw refineError(400, 'invalid_refinement', `${label} : texte invalide (maximum ${max} caractères).`);
    return value.trim();
  };
  const description = text(data.description, LIMITS.description, 'description');
  if (!description) throw refineError(400, 'invalid_refinement', 'Rédigez ou dictez une description avant de la reformuler.');
  const exchanges = data.exchanges ?? [];
  if (!Array.isArray(exchanges) || exchanges.length > LIMITS.exchanges) throw refineError(400, 'invalid_refinement', `exchanges : liste invalide (maximum ${LIMITS.exchanges} éléments).`);
  return {
    title: text(data.title, LIMITS.title, 'title'),
    description,
    listId: typeof data.listId === 'string' ? data.listId : '',
    exchanges: exchanges.map(item => {
      if (!item || typeof item !== 'object') throw refineError(400, 'invalid_refinement', 'Échange invalide.');
      return { question: text(item.question, LIMITS.question, 'question'), answer: text(item.answer, LIMITS.answer, 'answer') };
    }).filter(item => item.question && item.answer),
  };
}

export function refinePrompt({ project = {}, list = '', title = '', description, exchanges = [] }) {
  const context = [
    project.name && `Projet : ${project.name}`,
    project.description && `Présentation du projet : ${project.description}`,
    project.repository && `Dépôt GitHub : ${project.repository}`,
    list && `Liste de la carte : ${list}`,
    title && `Titre de la carte : ${title}`,
  ].filter(Boolean).join('\n');
  const answers = exchanges.map(item => `Question : ${item.question}\nRéponse : ${item.answer}`).join('\n\n');
  return `${context ? `${context}\n\n` : ''}Demande à reformuler :\n<<<\n${description}\n>>>${answers ? `\n\nRéponses déjà apportées :\n${answers}` : ''}`;
}

export function parseRefinement(message) {
  if (message?.stop_reason === 'refusal') throw refineError(422, 'refinement_refused', 'Le modèle a refusé de reformuler cette demande.');
  if (message?.stop_reason === 'max_tokens') throw refineError(502, 'refinement_incomplete', 'La reformulation a été interrompue avant la fin. Raccourcissez la description puis réessayez.');
  const content = Array.isArray(message?.content) ? message.content : [];
  // Après un repli, seule la sortie du dernier modèle compte.
  const text = content.slice(content.findLastIndex(block => block?.type === 'fallback') + 1).filter(block => block?.type === 'text').map(block => block.text).join('');
  let result;
  try { result = JSON.parse(text); } catch { throw refineError(502, 'refinement_invalid', 'La réponse du modèle est inexploitable. Réessayez.'); }
  const prompt = typeof result?.prompt === 'string' ? result.prompt.trim() : '';
  if (!prompt || prompt.length > LIMITS.description || !Array.isArray(result.questions)) throw refineError(502, 'refinement_invalid', 'La réponse du modèle est inexploitable. Réessayez.');
  const questions = result.questions.filter(question => typeof question === 'string' && question.trim()).map(question => question.trim().slice(0, LIMITS.question)).slice(0, LIMITS.questions);
  return { prompt, questions, model: typeof message.model === 'string' ? message.model : '' };
}

export function createRefiner({ apiKey = '', model = '', transport = fetch, timeoutMs = 120000 } = {}) {
  const selected = model || DEFAULT_REFINE_MODEL;
  const fallbacks = FALLBACK_MODELS.has(selected);
  return {
    enabled: !!apiKey,
    model: selected,
    async refine(request) {
      if (!apiKey) throw refineError(503, 'ai_not_configured', 'La reformulation IA n’est pas configurée : ajoutez ANTHROPIC_API_KEY aux variables du serveur du site.');
      let response;
      try {
        response = await transport('https://api.anthropic.com/v1/messages', {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
          headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', ...(fallbacks ? { 'anthropic-beta': 'server-side-fallback-2026-07-01' } : {}) },
          body: JSON.stringify({
            model: selected, max_tokens: 16000, system: refineInstructions,
            output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
            ...(fallbacks ? { fallbacks: 'default' } : {}),
            messages: [{ role: 'user', content: refinePrompt(request) }],
          }),
        });
      } catch (error) {
        throw refineError(504, 'ai_unreachable', error?.name === 'TimeoutError' ? 'Le service IA n’a pas répondu à temps. Réessayez.' : 'Le service IA est injoignable depuis le serveur. Réessayez.');
      }
      if (!response.ok) {
        // Les détails de l’erreur restent côté fournisseur : seul le statut est utile ici.
        await response.body?.cancel().catch(() => {});
        const status = response.status;
        if (status === 401 || status === 403) throw refineError(502, 'ai_unauthorized', 'La clé ANTHROPIC_API_KEY du serveur est refusée par Anthropic.');
        if (status === 429 || status === 529 || status >= 500) throw refineError(503, 'ai_busy', 'Le service IA est momentanément saturé. Réessayez dans un instant.');
        throw refineError(502, 'ai_rejected', `Le service IA a refusé la requête (HTTP ${status}). Vérifiez le modèle configuré.`);
      }
      let message;
      try { message = await response.json(); } catch { throw refineError(502, 'refinement_invalid', 'La réponse du modèle est inexploitable. Réessayez.'); }
      return parseRefinement(message);
    },
  };
}
