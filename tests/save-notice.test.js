import test from 'node:test';
import assert from 'node:assert/strict';
import { describeRefusals } from '../src/lib/use-workspace.js';

test('refused and skipped changes are explained in one message', () => {
  assert.equal(describeRefusals({ rejected: [], skipped: [] }), '');
  assert.equal(
    describeRefusals({ rejected: [{ index: 0, code: 'project_forbidden', message: 'Lecture seule.' }] }),
    'Une modification a été refusée et retirée de la page : Lecture seule.',
  );
  assert.equal(
    describeRefusals({
      rejected: [
        { index: 0, message: 'Lecture seule.' },
        { index: 2, message: 'Lecture seule.' },
      ],
      skipped: [{ index: 1, reason: 'missing' }],
    }),
    '2 modifications ont été refusées et retirées de la page : Lecture seule. Une modification visait un élément supprimé entre-temps dans une autre session.',
  );
});
