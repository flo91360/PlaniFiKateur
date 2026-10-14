import { createHmac, timingSafeEqual } from 'node:crypto';
const fail = (status, code, message) => {
  throw Object.assign(new Error(message), { status, code });
};
export async function githubEvent(req, secret) {
  if (!secret) fail(503, 'github_not_configured', 'Le secret du webhook GitHub n’est pas configuré.');
  const signature = req.headers['x-hub-signature-256'];
  if (typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/.test(signature))
    fail(401, 'invalid_signature', 'Signature GitHub requise.');
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || ''))
    fail(415, 'unsupported_media_type', 'Envoyez du JSON.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 4 * 1024 * 1024) {
      req.resume();
      fail(413, 'payload_too_large', 'Webhook trop volumineux.');
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  if (!timingSafeEqual(Buffer.from(signature.slice(7), 'hex'), createHmac('sha256', secret).update(raw).digest()))
    fail(401, 'invalid_signature', 'Signature GitHub incorrecte.');
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    fail(400, 'invalid_json', 'JSON invalide.');
  }
  return { event: req.headers['x-github-event'], data };
}
export function pullRequestLink(data, repository) {
  if (!data || typeof data.url !== 'string' || !/^[a-f0-9]{40}$/.test(data.headSha || ''))
    fail(400, 'invalid_pull_request', 'Indiquez une PR GitHub et son commit testé (SHA complet).');
  let url;
  try {
    url = new URL(data.url);
  } catch {
    fail(400, 'invalid_pull_request', 'URL de PR invalide.');
  }
  const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)$/.exec(url.pathname);
  if (
    url.origin !== 'https://github.com' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !match ||
    `${match[1]}/${match[2]}`.toLowerCase() !== repository.toLowerCase() ||
    !Number.isSafeInteger(Number(match[3])) ||
    Number(match[3]) < 1
  )
    fail(400, 'invalid_pull_request', 'La PR doit appartenir au dépôt du projet.');
  return {
    repository: repository.toLowerCase(),
    number: Number(match[3]),
    url: `https://github.com/${repository}/pull/${Number(match[3])}`,
    headSha: data.headSha,
  };
}
