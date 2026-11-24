import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.js';
import { checkAlerts, deploymentAlert, WORKER_SILENCE_MS } from '../server/alerts.js';
import { pushMessage, pushWanted } from '../server/push.js';
import { seedAccount } from './helpers/accounts.mjs';

function fixture(t) {
  const store = createStore(':memory:');
  t.after(() => store.close());
  const admin = seedAccount(store);
  const pushes = [];
  const unsubscribe = store.subscribe(event => event.type === 'push' && pushes.push(event));
  t.after(unsubscribe);
  const alerts = () => store.notifications(admin).items.filter(item => item.action === 'system.alert');
  return { store, admin, pushes, alerts };
}

test('a worker silent for more than 15 minutes alerts the administrators once per incident', t => {
  const { store, admin, pushes, alerts } = fixture(t);
  const project = store.read().projects[0];
  const { agent } = store.workflows.configureAgent({ name: 'Worker', projectIds: [project.id] }, admin);
  const seen = Date.now();
  store.workflows.touchAgent(agent, seen);
  checkAlerts(store, { now: seen + WORKER_SILENCE_MS - 1000 });
  assert.equal(alerts().length, 0, 'Pas d’alerte avant 15 min.');
  checkAlerts(store, { now: seen + WORKER_SILENCE_MS + 60000 });
  checkAlerts(store, { now: seen + WORKER_SILENCE_MS + 120000 });
  assert.equal(alerts().length, 1, 'Une seule alerte par incident.');
  assert.equal(alerts()[0].details.title, 'Worker muet');
  assert.match(alerts()[0].details.text, /depuis 16 min/);
  assert.deepEqual(pushes.at(-1).userIds, [admin.id]);
  const message = pushMessage(pushes.at(-1));
  assert.equal(message.title, 'Worker muet');
  assert.match(message.body, /^Le worker IA ne s’est plus manifesté/);
  assert.equal(message.url, '/');
  // Retour du worker : l’incident est refermé, le suivant est de nouveau signalé.
  const back = seen + WORKER_SILENCE_MS + 180000;
  store.workflows.touchAgent(agent, back);
  checkAlerts(store, { now: back + 1000 });
  assert.deepEqual(store.alerts(), []);
  checkAlerts(store, { now: back + WORKER_SILENCE_MS + 60000 });
  assert.equal(alerts().length, 2);
});

test('a failed backup or a stale off-site copy alerts the administrators', t => {
  const { store, alerts } = fixture(t);
  const now = Date.now();
  let status = { error: 'La sauvegarde a échoué. Vérifiez le stockage et les logs du serveur.', offsite: null };
  const backups = { status: () => status };
  checkAlerts(store, { backups, now });
  checkAlerts(store, { backups, now });
  assert.deepEqual(
    alerts().map(item => item.details.title),
    ['Sauvegarde en échec'],
  );
  status = { error: '', offsite: { at: new Date(now - 49 * 3600000).toISOString() } };
  checkAlerts(store, { backups, now });
  assert.deepEqual(
    store.alerts().map(alert => alert.kind),
    ['offsite'],
  );
  assert.match(alerts()[0].details.text, /depuis 49 h/);
  status = { error: '', offsite: { at: new Date(now).toISOString() } };
  checkAlerts(store, { backups, now });
  assert.deepEqual(store.alerts(), []);
});

test('an unverified deployment of the site alerts the administrators, a verified one closes the incident', t => {
  const { store, alerts } = fixture(t);
  const event = (conclusion, repository = 'flo91360/PlaniFiKateur') => ({
    action: 'completed',
    repository: { full_name: repository },
    workflow_run: { path: '.github/workflows/tag-version.yml', conclusion, head_sha: 'a'.repeat(40) },
  });
  assert.equal(deploymentAlert(store, event('failure', 'flo91360/FunKart')), false, 'Autre dépôt : ignoré.');
  assert.equal(deploymentAlert(store, { ...event('failure'), action: 'requested' }), false);
  assert.equal(deploymentAlert(store, event('failure')), true);
  deploymentAlert(store, event('timed_out'));
  assert.equal(alerts().length, 1);
  assert.equal(alerts()[0].details.title, 'Déploiement non vérifié');
  assert.match(alerts()[0].details.text, /commit aaaaaaa de flo91360\/PlaniFiKateur/);
  deploymentAlert(store, event('success'));
  assert.deepEqual(store.alerts(), []);
  deploymentAlert(store, event('failure'));
  assert.equal(alerts().length, 2);
  assert.equal(pushWanted({ action: 'system.alert' }), true);
});
