import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const root = 'existing-root-12345', credentials = { client_id: 'test-client', client_secret: 'test-secret', refresh_token: 'test-refresh' };
const md5 = bytes => createHash('md5').update(bytes).digest('hex');
// In-memory Google Drive: OAuth refresh, folder listing/creation and resumable uploads.
export function fakeDrive(options = {}) {
  const entries = new Map([[root, { id: root, name: 'Mon dossier', mimeType: 'application/vnd.google-apps.folder', capabilities: { canAddChildren: true } }]]);
  const calls = [], sessions = new Map(); let sequence = 0, refreshes = 0, uploads = 0;
  const transport = async (url, request = {}) => {
    url = new URL(url); calls.push({ url, request });
    if (url.origin === 'https://oauth2.googleapis.com') { refreshes++; return Response.json({ access_token: 'access-test', expires_in: 3600 }); }
    assert.equal(url.origin, 'https://www.googleapis.com');
    assert.equal(request.redirect, 'error'); assert.equal(request.headers.Authorization, 'Bearer access-test');
    if (options.onceUnauthorized) { options.onceUnauthorized = false; return new Response(null, { status: 401 }); }
    if (url.pathname.startsWith('/upload/')) {
      if (request.method === 'POST') {
        uploads++; if (options.failUpload) return new Response(null, { status: 403 });
        const id = `session-${++sequence}`, metadata = JSON.parse(request.body);
        sessions.set(id, { metadata, chunks: [] });
        return new Response(null, { headers: { location: options.foreignSession || `https://www.googleapis.com/upload/drive/v3/files?upload_id=${id}` } });
      }
      const session = sessions.get(url.searchParams.get('upload_id'));
      session.chunks.push(request.body);
      const bytes = Buffer.concat(session.chunks), total = Number(request.headers['Content-Range'].split('/')[1]);
      if (bytes.length < total) return new Response(null, { status: 308, headers: { range: `bytes=0-${bytes.length - 1}` } });
      const file = { ...session.metadata, id: `drive-file-${++sequence}`, size: String(total), md5Checksum: md5(bytes) };
      entries.set(file.id, file); return Response.json(file);
    }
    if (url.pathname === '/drive/v3/files') {
      if (request.method === 'POST') {
        const data = { id: `drive-folder-${++sequence}`, ...JSON.parse(request.body) };
        entries.set(data.id, data); return Response.json(data);
      }
      const query = /^'([^']+)' in parents and name = '([^']+)'/.exec(url.searchParams.get('q'));
      return Response.json({ files: [...entries.values()].filter(file => file.parents?.includes(query[1]) && file.name === query[2]) });
    }
    const file = entries.get(url.pathname.split('/').at(-1));
    return file ? Response.json(file) : new Response(null, { status: 404 });
  };
  return { entries, calls, options, transport, wait: async () => {}, get uploads() { return uploads; }, get refreshes() { return refreshes; } };
}
