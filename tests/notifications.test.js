import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.js';
import { diffWorkspace } from '../src/lib/workspace-changes.js';
import { seedAccount } from './helpers/accounts.mjs';
import { hashPassword } from '../server/accounts.js';

async function fixture(t) {
  const store = createStore(':memory:');
  t.after(() => store.close());
  const alice = seedAccount(store);
  const { token } = store.inviteUser({ name: 'Bob', email: 'bob@example.test' }, alice);
  const bob = store.acceptInvitation(token, 'Bob', await hashPassword('bob-mot-de-passe-123'));
  const events = [];
  store.subscribe(event => events.push(event));
  // Modifie la carte c1 comme le ferait l’interface de `actor`.
  const edit = (actor, change) => {
    const before = store.readFor(actor).projects;
    const after = structuredClone(before);
    change(after[0].cards.find(card => card.id === 'c1'));
    return store.change(diffWorkspace(before, after), actor);
  };
  const comment = (actor, text) =>
    edit(actor, card =>
      card.comments.push({
        id: `comment-${text.length}-${Date.now()}`,
        author: actor.name,
        text,
        date: new Date().toISOString(),
      }),
    );
  return { store, alice, bob, events, edit, comment };
}

test('participants are notified of what others do on their cards, never of their own actions', async t => {
  const { store, alice, bob, events, comment } = await fixture(t);
  assert.deepEqual(store.notifications(alice).items, []);
  comment(alice, 'Alice lance la discussion');
  comment(bob, 'Bob répond');
  const forAlice = store.notifications(alice);
  assert.equal(forAlice.unread, 1);
  assert.deepEqual(
    forAlice.items.map(item => [item.action, item.actor.name, item.cardId, item.read]),
    [['comment.created', 'Bob', 'c1', false]],
  );
  assert.equal(forAlice.items[0].cardTitle, store.read().projects[0].cards[0].title);
  assert.ok(events.some(event => event.type === 'notifications' && event.userIds.includes(alice.id)));
  const forBob = store.notifications(bob);
  assert.deepEqual(
    forBob.items.map(item => item.action),
    [],
    'Bob a seulement commenté après Alice : il n’est notifié que des actions suivantes.',
  );
  comment(alice, 'Alice reprend');
  assert.deepEqual(
    store.notifications(bob).items.map(item => [item.action, item.actor.name]),
    [['comment.created', 'Alice']],
  );
  const read = store.readNotifications(alice, forAlice.items[0].id);
  assert.deepEqual([read.unread, read.lastReadId], [0, forAlice.items[0].id]);
  assert.equal(store.notifications(alice).items[0].read, true);
  store.readNotifications(alice, 0);
  assert.equal(store.notifications(alice).unread, 0, 'Le marqueur ne recule jamais.');
  assert.throws(() => store.readNotifications(alice, -1), /upTo/);
});

test('status changes, follower additions and agent questions notify once; hidden projects stay silent', async t => {
  const { store, alice, bob, edit } = await fixture(t);
  edit(bob, card =>
    card.comments.push({ id: 'bob-1', author: 'Bob', text: 'Je participe', date: new Date().toISOString() }),
  );
  edit(alice, card => {
    card.status = 'draft';
  });
  store.setSubscription('website', 'w-card', alice, true, bob.id);
  assert.deepEqual(
    store
      .notifications(bob)
      .items.map(item => item.action)
      .sort(),
    ['card.status_changed', 'card.subscriber_added'],
  );
  // Une question de l’agent : une seule notification, pas aussi celle de son commentaire.
  store.workflows.configureGithub('planifikateur', 'flo91360/PlaniFiKateur', alice);
  const { token } = store.workflows.configureAgent({ name: 'Agent', projectIds: ['planifikateur'] }, alice);
  const agent = store.workflows.agent(token);
  let run = store.workflows.prepare('planifikateur', 'c3', {}, alice);
  run = store.workflows.agentAction('planifikateur', 'c3', run.id, 'claim', { version: run.version }, agent);
  store.workflows.agentAction(
    'planifikateur',
    'c3',
    run.id,
    'question',
    { version: run.version, leaseToken: run.leaseToken, message: 'Quelle couleur ?' },
    agent,
  );
  assert.deepEqual(
    store
      .notifications(alice)
      .items.filter(item => item.cardId === 'c3')
      .map(item => item.action),
    ['work.question'],
  );
  // Projet masqué à Bob : ses notifications n’en parlent plus.
  store.configureProjectAccess('website', { memberRole: 'none' }, alice);
  assert.equal(
    store.notifications(bob).items.some(item => item.projectId === 'website'),
    false,
  );
});
