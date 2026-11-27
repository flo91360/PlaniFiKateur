import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.js';
import { createAppServer } from '../server/index.js';
import { MAX_REPORTS } from '../server/store/bug-reports.js';
import { seedAccount, loginRequest } from './helpers/accounts.mjs';

const machine = 'a'.repeat(64),
  product = 'flo91360/defilordi';

async function fixture(t) {
  const store = createStore(':memory:');
  const admin = seedAccount(store);
  const [project, second] = store.read().projects;
  store.workflows.configureGithub(project.id, 'flo91360/DefilOrdi', admin);
  store.workflows.configureGithub(second.id, 'flo91360/funkart', admin);
  const server = createAppServer({ store, config: {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const cookie = (await loginRequest(base)).headers.get('set-cookie').split(';')[0];
  const call = async (method, path, data, session = cookie) => {
    const response = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: { ...(session ? { Cookie: session } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}) },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  const { key, id } = (await call('POST', `/projects/${project.id}/licenses`, { name: 'Cabinet Dupont' })).body.data;
  const { token } = store.activateLicense({ key, machine, product });
  return { store, admin, project, second, call, token, licenseId: id };
}

const report = (token, extra = {}) => ({
  token,
  id: 'rapport-0001',
  description: 'Le jeu se fige après la troisième phrase.',
  version: '0.8.66',
  screen: 'Dactylo',
  system: 'Windows 10.0.22631',
  journal: 'TypeError: x is undefined',
  reportedAt: '2026-11-27T10:00:00.000Z',
  ...extra,
});

test('the software reports a bug with its licence token and the managers read it in the project', async t => {
  const { project, second, call, token, licenseId } = await fixture(t);
  const sent = await call('POST', '/bug-reports', report(token), '');
  assert.equal(sent.status, 201);
  assert.equal(sent.body.data.duplicate, false);
  // Renvoyé par la file d’attente : gardé une seule fois.
  const again = await call('POST', '/bug-reports', report(token), '');
  assert.equal(again.status, 200);
  assert.equal(again.body.data.id, sent.body.data.id);

  assert.equal((await call('GET', `/projects/${project.id}/bug-reports`, undefined, '')).status, 401);
  const listed = (await call('GET', `/projects/${project.id}/bug-reports`)).body.data;
  assert.equal(listed.length, 1);
  assert.deepEqual(
    {
      licenseId: listed[0].licenseId,
      licenseName: listed[0].licenseName,
      screen: listed[0].screen,
      hasScreenshot: listed[0].hasScreenshot,
      handled: listed[0].handled,
    },
    { licenseId, licenseName: 'Cabinet Dupont', screen: 'Dactylo', hasScreenshot: false, handled: false },
  );
  assert.deepEqual((await call('GET', `/projects/${second.id}/bug-reports`)).body.data, []);

  const id = listed[0].id;
  const handled = await call('PATCH', `/projects/${project.id}/bug-reports/${id}`, { handled: true });
  assert.equal(handled.body.data.handled, true);
  assert.equal((await call('PATCH', `/projects/${second.id}/bug-reports/${id}`, { handled: true })).status, 404);
  assert.equal(
    (await call('GET', `/projects/${project.id}/bug-reports/${id}/screenshot`)).body.error.code,
    'screenshot_missing',
  );
  assert.equal((await call('DELETE', `/projects/${project.id}/bug-reports/${id}`)).status, 200);
  assert.deepEqual((await call('GET', `/projects/${project.id}/bug-reports`)).body.data, []);
});

test('a bug report needs a genuine licence token, a description and a real image', async t => {
  const { project, call, token } = await fixture(t);
  assert.equal((await call('POST', '/bug-reports', report(undefined), '')).status, 401);
  const [body, signature] = token.split('.');
  const forged = `${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), license: 'autre' })).toString('base64url')}.${signature}`;
  assert.equal((await call('POST', '/bug-reports', report(forged), '')).body.error.code, 'bug_report_unauthorized');
  assert.equal((await call('POST', '/bug-reports', report(token, { description: '  ' }), '')).status, 400);
  assert.equal((await call('POST', '/bug-reports', report(token, { screenshot: 'javascript:1' }), '')).status, 400);
  const image = 'data:image/png;base64,iVBORw0KGgo=';
  const sent = await call('POST', '/bug-reports', report(token, { id: 'rapport-0002', screenshot: image }), '');
  assert.equal(sent.status, 201);
  const shot = await call('GET', `/projects/${project.id}/bug-reports/${sent.body.data.id}/screenshot`);
  assert.equal(shot.body.data.screenshot, image);
});

test('a project keeps its most recent bug reports only', async t => {
  const { store, project, token } = await fixture(t);
  const start = Date.parse('2026-11-01T00:00:00Z');
  for (let index = 0; index <= MAX_REPORTS; index++)
    store.receiveBugReport(report(token, { id: `rapport-${String(index).padStart(4, '0')}` }), start + index * 1000);
  const kept = store.bugReports(project.id);
  assert.equal(kept.length, MAX_REPORTS);
  assert.equal(kept.at(-1).receivedAt, new Date(start + 1000).toISOString());
});

test('an idea or an opinion is kept with its kind and every new report notifies the project managers', async t => {
  const { store, admin, project, call, token } = await fixture(t);
  const sent = await call('POST', '/bug-reports', report(token, { id: 'idee-0001', kind: 'idea' }), '');
  assert.equal(sent.status, 201);
  const crash = await call('POST', '/bug-reports', report(token, { id: 'plantage-01', crash: true }), '');
  assert.equal(crash.status, 201);
  assert.equal((await call('POST', '/bug-reports', report(token, { id: 'autre-0001', kind: 'note' }), '')).status, 400);
  // Renvoi de la file d’attente : pas de seconde notification.
  await call('POST', '/bug-reports', report(token, { id: 'idee-0001', kind: 'idea' }), '');

  const listed = store.bugReports(project.id);
  assert.deepEqual(listed.map(item => `${item.kind}:${item.crash}`).sort(), ['bug:true', 'idea:false']);
  const notified = store.notifications(admin).items.filter(item => item.action === 'bug_report.received');
  assert.equal(notified.length, 2);
  const idea = notified.find(item => item.details.title === 'Nouvelle idée');
  assert.ok(notified.some(item => item.details.title === 'Plantage signalé'));
  assert.match(idea.details.text, /^Cabinet Dupont : Le jeu se fige/);
  assert.equal(idea.projectId, project.id);
});
