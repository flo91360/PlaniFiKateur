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

test('projects read back alone replace their previous version and keep the board order', async () => {
  const { mergeProjects } = await import('../src/lib/use-workspace.js');
  const base = [
    { id: 'a', v: 1 },
    { id: 'b', v: 1 },
    { id: 'c', v: 1 },
  ];
  assert.deepEqual(mergeProjects(base, [{ id: 'b', v: 2 }], ['b']), [
    { id: 'a', v: 1 },
    { id: 'b', v: 2 },
    { id: 'c', v: 1 },
  ]);
  // Projet devenu invisible ou supprimé : retiré.
  assert.deepEqual(mergeProjects(base, [], ['c']), [
    { id: 'a', v: 1 },
    { id: 'b', v: 1 },
  ]);
  // Projet inconnu de la page : il faut tout relire.
  assert.equal(mergeProjects(base, [{ id: 'z', v: 1 }], ['z']), null);
});
