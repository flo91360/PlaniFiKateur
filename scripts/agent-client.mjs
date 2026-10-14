// Small API client for an external agent. It neither runs a model nor executes tools.
const [action, projectId, cardId, executionId] = process.argv.slice(2);
const id = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
try {
  const allowed = ['queue', 'history', 'claim', 'revise', 'heartbeat', 'progress', 'question', 'submit', 'interrupt'];
  if (
    !allowed.includes(action) ||
    !id(projectId) ||
    (action !== 'queue' && !id(cardId)) ||
    (!['queue', 'history'].includes(action) && !id(executionId))
  )
    throw new Error(
      'Usage : node scripts/agent-client.mjs queue PROJET | history PROJET CARTE | ACTION PROJET CARTE EXECUTION (JSON sur stdin).',
    );
  if (!process.env.PLANIFIKATEUR_AGENT_TOKEN) throw new Error('PLANIFIKATEUR_AGENT_TOKEN est requis.');
  const base = new URL(process.env.PLANIFIKATEUR_URL || 'http://127.0.0.1:3000');
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash)
    throw new Error('PLANIFIKATEUR_URL doit être l’origine HTTP(S) du site, sans identifiants.');
  if (base.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))
    throw new Error('Utilisez HTTPS en dehors de la machine locale.');
  const read = ['queue', 'history'].includes(action);
  const path =
    action === 'queue'
      ? `projects/${projectId}/work`
      : `projects/${projectId}/cards/${cardId}/work${action === 'history' ? '' : `/${executionId}/${action}`}`;
  let payload;
  if (!read) {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 4 * 1024 * 1024) throw new Error('JSON trop volumineux.');
    }
    try {
      payload = JSON.parse(input);
    } catch {
      throw new Error('Envoyez le JSON de l’action sur stdin.');
    }
    if (process.env.PLANIFIKATEUR_LEASE_TOKEN) payload.leaseToken = process.env.PLANIFIKATEUR_LEASE_TOKEN;
  }
  const response = await fetch(new URL(`/api/v1/${path}`, base), {
    method: read ? 'GET' : 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
    headers: {
      Authorization: `Bearer ${process.env.PLANIFIKATEUR_AGENT_TOKEN}`,
      ...(read ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(read ? {} : { body: JSON.stringify(payload) }),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      `${response.status} ${result.error?.code || 'api_error'} : ${result.error?.message || 'Action refusée.'}`,
    );
  // A successful claim includes a secret leaseToken: keep that output private.
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) {
  process.stderr.write((error.message || 'Erreur du client agent.') + '\n');
  process.exitCode = 1;
}
