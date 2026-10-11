import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { commandEnvironment, runCommand } from './commands.mjs';

const require = createRequire(import.meta.url);

export async function checkSandbox(stateRoot) {
  if (process.platform !== 'linux') throw new Error('Le contrôle du sandbox requiert Linux ; utilisez l’image Docker du worker.');
  if (!['x64', 'arm64'].includes(process.arch)) throw new Error('Architecture Linux non prise en charge par le worker Codex.');
  const triple = process.arch === 'x64' ? 'x86_64-unknown-linux-musl' : 'aarch64-unknown-linux-musl';
  const vendor = join(dirname(require.resolve(`@openai/codex-linux-${process.arch}/package.json`)), 'vendor', triple);
  let executable = join(vendor, 'bin', 'codex');
  try { await access(executable); } catch { executable = join(vendor, 'codex', 'codex'); }
  await mkdir(stateRoot, { recursive: true });
  const root = await mkdtemp(join(stateRoot, 'sandbox-check-'));
  try {
    const cwd = join(root, 'workspace'), outside = join(root, 'outside.txt');
    await mkdir(cwd); await mkdir(join(root, 'home')); await mkdir(join(root, 'codex'));
    const probe = `const fs = require('node:fs');
fs.writeFileSync('allowed.txt', 'sandbox-ok');
try { fs.writeFileSync(process.argv[1], 'outside'); process.exit(2); }
catch (error) { if (!['EROFS', 'EACCES', 'EPERM'].includes(error.code)) throw error; }`;
    const result = await runCommand([executable, 'sandbox', '-c', 'sandbox_mode="workspace-write"', '-c', 'sandbox_workspace_write.network_access=true', '--', 'node', '-e', probe, outside], {
      cwd, env: { ...commandEnvironment(), HOME: join(root, 'home'), CODEX_HOME: join(root, 'codex') }, signal: AbortSignal.timeout(30000),
    });
    if (result.code !== 0 || await readFile(join(cwd, 'allowed.txt'), 'utf8') !== 'sandbox-ok') throw new Error('sandbox_unavailable');
    try { await access(outside); throw new Error('sandbox_unrestricted'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  } catch {
    throw new Error('Le sandbox Codex ne peut pas exécuter les commandes avec son isolation. Dans Docker, relancez avec --security-opt seccomp=worker/seccomp.json (voir docs/worker.md). Aucune tâche n’a été prise en charge.');
  } finally { await rm(root, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await checkSandbox(process.env.PLANIFIKATEUR_WORKER_STATE_DIR || '.data/worker');
    console.log('Sandbox Codex OK : commandes exécutables, écriture limitée au dépôt.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
