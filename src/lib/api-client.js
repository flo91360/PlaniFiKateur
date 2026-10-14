// Client unique de l’API du site : session par cookie, corps JSON et erreurs
// { "error": { "code", "message" } } converties en ApiError.
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const DEFAULT_MESSAGE = 'Action indisponible.';

async function send(path, { method = 'GET', data, headers = {}, signal }) {
  return fetch(`/api/v1/${path}`, {
    method,
    credentials: 'same-origin',
    signal,
    headers: data == null ? headers : { 'Content-Type': 'application/json', ...headers },
    ...(data == null ? {} : { body: JSON.stringify(data) }),
  });
}

// Renvoie le corps JSON complet, ou null pour une réponse 304 (révision inchangée).
// `fallback` remplace un message d’erreur absent ou une réponse illisible.
export async function apiFetch(path, { fallback = DEFAULT_MESSAGE, ...options } = {}) {
  const response = await send(path, options);
  if (response.status === 304) return null;
  let result;
  try {
    result = await response.json();
  } catch {
    throw new ApiError(response.status, 'invalid_response', fallback);
  }
  if (!response.ok) throw new ApiError(response.status, result.error?.code, result.error?.message || fallback);
  return result;
}

// La plupart des routes répondent { "data": … } : renvoie directement data.
export const apiData = async (path, options) => (await apiFetch(path, options)).data;

// Téléchargement d’un fichier (sauvegarde SQLite) sous forme de Blob.
export async function apiBlob(path, { fallback = DEFAULT_MESSAGE, ...options } = {}) {
  const response = await send(path, options);
  if (!response.ok) throw new ApiError(response.status, 'download_failed', fallback);
  return response.blob();
}
