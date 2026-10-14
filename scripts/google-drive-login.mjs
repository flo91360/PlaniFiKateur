import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDriveClient } from './google-drive.mjs';
import { driveFolderId } from '../src/lib/drive-release.js';

// Desktop OAuth clients support a loopback redirect with an ephemeral port.
export async function authorizeGoogle(client, { onUrl, transport = fetch, timeoutMs = 10 * 60000 } = {}) {
  if (!client?.client_id || !client.client_secret)
    throw new Error('Utilisez le JSON d’un client OAuth Google de type Application de bureau.');
  const state = randomBytes(32).toString('base64url'),
    verifier = randomBytes(48).toString('base64url');
  let finish;
  const callback = new Promise((resolve, reject) => {
    finish = { resolve, reject };
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (request.method !== 'GET' || url.pathname !== '/oauth/callback') {
      response.writeHead(404).end();
      return;
    }
    const received = Buffer.from(url.searchParams.get('state') || ''),
      expected = Buffer.from(state);
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      response.writeHead(400).end('Autorisation invalide.');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    if (url.searchParams.has('error') || !url.searchParams.get('code')) {
      response.end('Autorisation refusée. Vous pouvez fermer cette fenêtre.');
      finish.reject(new Error('La connexion Google a été refusée.'));
      return;
    }
    response.end('Autorisation reçue. Revenez dans le terminal pour vérifier le dossier.');
    finish.resolve(url.searchParams.get('code'));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const redirect = `http://127.0.0.1:${server.address().port}/oauth/callback`;
  const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  auth.search = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirect,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    scope: 'https://www.googleapis.com/auth/drive',
    state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  });
  const timer = setTimeout(
    () => finish.reject(new Error('Connexion Google expirée. Relancez la commande.')),
    timeoutMs,
  );
  try {
    const [, code] = await Promise.all([Promise.resolve().then(() => onUrl(auth.href)), callback]);
    const response = await transport('https://oauth2.googleapis.com/token', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: client.client_id,
        client_secret: client.client_secret,
        code,
        code_verifier: verifier,
        redirect_uri: redirect,
        grant_type: 'authorization_code',
      }),
    });
    if (!response.ok) throw new Error(`Autorisation Google refusée (${response.status}).`);
    const result = await response.json();
    if (!result.refresh_token)
      throw new Error(
        'Google n’a pas fourni d’accès durable. Relancez l’autorisation avec le consentement hors ligne.',
      );
    return { client_id: client.client_id, client_secret: client.client_secret, refresh_token: result.refresh_token };
  } finally {
    clearTimeout(timer);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

export async function login(args = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--client', '--folder', '--output'].includes(args[i]) || !args[i + 1] || options[args[i]])
      throw new Error(
        'Usage : node scripts/google-drive-login.mjs --client <client.json> --folder <lien du dossier> --output <fichier privé.json>',
      );
    options[args[i]] = args[i + 1];
  }
  if (Object.keys(options).length !== 3)
    throw new Error('Indiquez --client, --folder et --output (voir docs/google-drive.md).');
  driveFolderId(options['--folder']);
  let data;
  try {
    data = JSON.parse(await readFile(options['--client'], 'utf8'));
  } catch {
    throw new Error('Le fichier du client OAuth est absent ou invalide.');
  }
  if (!data.installed) throw new Error('Le client OAuth doit être de type Application de bureau.');
  const credentials = await authorizeGoogle(data.installed, {
    onUrl: url => console.log(`Ouvrez ce lien dans votre navigateur et connectez votre compte Google :\n${url}`),
  });
  await createDriveClient(credentials, options['--folder']).validateRoot();
  try {
    await writeFile(resolve(options['--output']), JSON.stringify(credentials), { mode: 0o600, flag: 'wx' });
  } catch {
    throw new Error('Impossible de créer le fichier privé. Choisissez un nouveau chemin de sortie accessible.');
  }
  console.log(
    `Dossier vérifié. Authentification enregistrée dans ${resolve(options['--output'])}.\nCopiez son contenu dans la variable PLANIFIKATEUR_GOOGLE_DRIVE_CREDENTIALS du service Railway du site. Ne partagez pas ce fichier.`,
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  login().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
