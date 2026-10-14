import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CARD_STATUS,
  STATES,
  TRANSITIONS,
  canTransition,
  isTerminal,
  legacyPublicationQuestion,
  transition,
} from '../server/execution-states.js';
import { STATUSES } from '../src/lib/workspace.js';

test('every execution state has a valid card status and every transition stays within the states', () => {
  for (const state of STATES) assert.ok(STATUSES.includes(CARD_STATUS[state]), state);
  for (const [action, rule] of Object.entries(TRANSITIONS)) {
    assert.ok(rule.from.length, action);
    for (const state of [...rule.from, ...[rule.to].flat()]) assert.ok(STATES.includes(state), `${action} : ${state}`);
    assert.ok(!rule.from.some(isTerminal), `${action} ne part jamais d’un état terminé`);
  }
});

test('terminal executions accept no action and open ones can always be cancelled', () => {
  for (const state of ['done', 'cancelled']) {
    assert.equal(isTerminal(state), true);
    assert.deepEqual(
      Object.keys(TRANSITIONS).filter(action => canTransition(state, action)),
      [],
    );
  }
  for (const state of STATES.filter(state => !isTerminal(state))) assert.equal(canTransition(state, 'cancel'), true);
});

test('the nominal path and its detours follow the declared transitions', () => {
  const run = { state: 'ready' };
  transition(run, 'claim');
  transition(run, 'question');
  assert.equal(run.state, 'waiting');
  transition(run, 'answer');
  transition(run, 'claim');
  transition(run, 'submit', 'merging');
  transition(run, 'checksFailed');
  transition(run, 'claim');
  transition(run, 'submit', 'merging');
  transition(run, 'revise');
  transition(run, 'submit', 'merging');
  transition(run, 'merged');
  assert.equal(run.state, 'done');
  const review = transition(transition({ state: 'ready' }, 'claim'), 'submit', 'review');
  assert.equal(transition(review, 'reject').state, 'ready');
});

test('an impossible transition is a programming error and leaves the state unchanged', () => {
  const run = { state: 'ready' };
  assert.throws(() => transition(run, 'accept'), /Transition accept impossible depuis ready/);
  assert.throws(() => transition({ state: 'running' }, 'submit', 'cancelled'), /impossible/);
  assert.throws(() => transition({ state: 'running' }, 'unknown'), /impossible/);
  assert.equal(run.state, 'ready');
});

test('only the legacy technical publication question lets the agent revise a waiting execution', () => {
  const run = {
    delivery: 'github',
    state: 'waiting',
    submissions: [{ pullRequest: { number: 1 } }],
    exchanges: [{ question: 'La PR ne pointe pas sur le commit testé.', answer: null }],
  };
  assert.equal(legacyPublicationQuestion(run), true);
  assert.equal(legacyPublicationQuestion({ ...run, exchanges: [{ question: 'Quel menu ?', answer: null }] }), false);
  assert.equal(legacyPublicationQuestion({ ...run, submissions: [{ pullRequest: null }] }), false);
  assert.equal(
    legacyPublicationQuestion({ ...run, exchanges: [{ ...run.exchanges[0], answer: { text: 'Oui' } }] }),
    false,
  );
});
