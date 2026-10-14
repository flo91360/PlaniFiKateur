import { spawn } from 'node:child_process';

export function runCommand(command, { cwd, env, signal, maxOutput = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const child = spawn(command[0], command.slice(1), {
      cwd,
      env,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '',
      killTimer;
    const append = chunk => {
      output = (output + chunk.toString()).slice(-maxOutput);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const kill = sig => {
      try {
        process.kill(process.platform === 'win32' ? child.pid : -child.pid, sig);
      } catch (e) {
        if (e.code !== 'ESRCH') throw e;
      }
    };
    const abort = () => {
      if (!child.pid) return;
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 3000);
      killTimer.unref();
    };
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) reject(signal.reason);
      else resolve({ code, output });
    });
  });
}

// Deliberately exclude the site key, GitHub key and parent process credentials.
export function commandEnvironment(env = process.env) {
  const result = {};
  for (const name of [
    'PATH',
    'LANG',
    'LC_ALL',
    'TZ',
    'PLAYWRIGHT_CHROMIUM_EXECUTABLE',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'NODE_EXTRA_CA_CERTS',
  ])
    if (env[name]) result[name] = env[name];
  return result;
}
