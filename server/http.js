// Outils HTTP communs à l’API : erreurs typées, lecture du corps JSON et réponses.
export const MAX_BODY = 4 * 1024 * 1024;

export const httpError = (status, code, message) => Object.assign(new Error(message), { status, code });
export const fail = (status, code, message) => {
  throw httpError(status, code, message);
};

export async function readJson(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || ''))
    throw httpError(415, 'unsupported_media_type', 'Envoyez du JSON avec Content-Type: application/json.');
  if (Number(req.headers['content-length']) > MAX_BODY) {
    req.resume();
    throw httpError(413, 'payload_too_large', 'La requête dépasse 4 Mo.');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_BODY) {
      req.resume();
      throw httpError(413, 'payload_too_large', 'La requête dépasse 4 Mo.');
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError(400, 'invalid_json', 'JSON invalide.');
  }
}

export function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}
