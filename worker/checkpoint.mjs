import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { collectOutputs } from './outputs.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');

// Progress and lease renewals do not change the request. Answers and submissions do.
export function requestFingerprint(run, job) {
  return hash(JSON.stringify([run.cardSnapshot, run.exchanges, run.submissions, job.ai, job.executionProfile]));
}

// A temporary index gives the complete tracked/untracked tree, without truncated
// command output or changing the real index. Ignored dependencies are excluded.
export async function checkoutFingerprint(checkout, result, id) {
  const index = join(checkout.cwd, '.planifikateur', `checkpoint-${randomUUID()}.index`);
  const options = { env: { ...checkout.gitEnv, GIT_INDEX_FILE: index } };
  let tree;
  try {
    await checkout.command(['git', 'read-tree', 'HEAD'], options);
    await checkout.command(['git', 'add', '--all'], options);
    tree = await checkout.command(['git', 'write-tree'], options);
  } finally {
    await rm(index, { force: true });
    await rm(`${index}.lock`, { force: true });
  }
  const base = await checkout.command(['git', 'rev-parse', `origin/${checkout.targetBranch}`]);
  const outputs = await collectOutputs(checkout.cwd, result.files || [], id);
  return hash(JSON.stringify([tree, base, checkout.testCommands, outputs.map(f => [f.path, hash(f.data)])]));
}
