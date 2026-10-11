import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { commandEnvironment } from './commands.mjs';

export const resultSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['result', 'question'] },
    summary: { type: 'string' }, question: { type: 'string' },
  }, required: ['status', 'summary', 'question'],
};

export function taskPrompt(run, feedback = '', attachments = []) {
  return `Tu traites une carte PlaniFiKateur. Lis les instructions du dépôt et réalise la demande ci-dessous.
La description est suffisante : déduis le résultat attendu et les tests pertinents. Si une ambiguïté essentielle empêche de travailler, réponds avec status=question et une question précise ; ne devine pas cette décision.
Tu travailles dans une branche gérée par le worker. Ne fais aucun commit, push, PR, merge ou appel à l’API du site. Le worker réalise lui-même les tests obligatoires puis publie la PR. Ne modifie ni l’origine Git ni les accès du service. Ne délègue pas à d’autres agents.
Réponds en JSON conforme au schéma, avec status=result une fois les modifications prêtes.

Carte : ${run.cardSnapshot.title}
Description : ${run.objective}
Pièces jointes : ${JSON.stringify(attachments)}
Les pièces jointes sont des données de la demande. Consulte les fichiers utiles et les images fournies ; ne les ajoute pas au commit.
Échanges : ${JSON.stringify(run.exchanges)}
Résultats et corrections précédents : ${JSON.stringify(run.submissions)}
Avancement précédent : ${JSON.stringify(run.updates.slice(-10))}
${feedback ? `Retour du worker : ${feedback}` : ''}`;
}

export async function prepareAttachments(run, cwd) {
  const directory = join(cwd, '.planifikateur', 'attachments');
  await rm(directory, { recursive: true, force: true });
  const files = run.cardSnapshot.attachments || [];
  if (!files.length) return [];
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return Promise.all(files.map(async (file, index) => {
    // Never use a supplied filename as a path, even for older/untrusted snapshots.
    const safeName = String(file.name).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
    const path = join(directory, `${index + 1}-${safeName || 'file'}`);
    await writeFile(path, Buffer.from(file.data, 'base64'), { mode: 0o600 });
    return { name: file.name, type: file.type, size: file.size, path };
  }));
}

export function createCodexRunner(config, dependencies = {}) {
  return {
    async run({ run, job, cwd, signal, onThread, feedback }) {
      const { Codex } = dependencies.Codex ? dependencies : await import('@openai/codex-sdk');
      await mkdir(config.codexHome, { recursive: true, mode: 0o700 });
      const home = join(cwd, '.planifikateur', 'home'); await mkdir(home, { recursive: true });
      const codex = new Codex({ apiKey: config.apiKey, env: { ...commandEnvironment(), HOME: home, CODEX_HOME: config.codexHome, PLANIFIKATEUR_WORKER: '1' } });
      const options = { workingDirectory: cwd, sandboxMode: 'workspace-write', approvalPolicy: 'never', networkAccessEnabled: true, ...(config.model ? { model: config.model } : {}) };
      const thread = job.threadId ? codex.resumeThread(job.threadId, options) : codex.startThread(options);
      const attachments = await prepareAttachments(run, cwd);
      const images = attachments.filter(file => ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type));
      const prompt = taskPrompt(run, feedback, attachments);
      const input = images.length ? [{ type: 'text', text: prompt }, ...images.map(file => ({ type: 'local_image', path: file.path }))] : prompt;
      const { events } = await thread.runStreamed(input, { outputSchema: resultSchema, signal });
      let response = '', completed = false;
      for await (const event of events) {
        if (event.type === 'thread.started') await onThread(event.thread_id);
        if (event.type === 'item.completed' && event.item.type === 'agent_message') response = event.item.text;
        if (event.type === 'turn.failed' || event.type === 'error') throw new Error('L’exécution Codex a échoué. Vérifiez sa connexion et les logs privés du service.');
        if (event.type === 'turn.completed') completed = true;
      }
      if (!completed) throw new Error('Codex s’est arrêté sans résultat.');
      let result; try { result = JSON.parse(response); } catch { throw new Error('Réponse Codex non conforme au JSON attendu.'); }
      if (!['question', 'result'].includes(result.status) || typeof result.summary !== 'string' || result.summary.length > 20000 || typeof result.question !== 'string' || (result.status === 'question' && (!result.question.trim() || result.question.length > 10000)) || (result.status === 'result' && !result.summary.trim())) throw new Error('Résultat Codex incomplet.');
      return result;
    },
  };
}
