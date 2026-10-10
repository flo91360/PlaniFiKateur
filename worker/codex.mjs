import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { commandEnvironment } from './commands.mjs';

export const resultSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['result', 'question'] },
    summary: { type: 'string' }, question: { type: 'string' },
  }, required: ['status', 'summary', 'question'],
};

export function taskPrompt(run, feedback = '') {
  return `Tu traites une carte PlaniFiKateur. Lis les instructions du dépôt et réalise la demande ci-dessous.
La description est suffisante : déduis le résultat attendu et les tests pertinents. Si une ambiguïté essentielle empêche de travailler, réponds avec status=question et une question précise ; ne devine pas cette décision.
Tu travailles dans une branche gérée par le worker. Ne fais aucun commit, push, PR, merge ou appel à l’API du site. Le worker réalise lui-même les tests obligatoires puis publie la PR. Ne modifie ni l’origine Git ni les accès du service. Ne délègue pas à d’autres agents.
Réponds en JSON conforme au schéma, avec status=result une fois les modifications prêtes.

Carte : ${run.cardSnapshot.title}
Description : ${run.objective}
Échanges : ${JSON.stringify(run.exchanges)}
Résultats et corrections précédents : ${JSON.stringify(run.submissions)}
Avancement précédent : ${JSON.stringify(run.updates.slice(-10))}
${feedback ? `Retour du worker : ${feedback}` : ''}`;
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
      const { events } = await thread.runStreamed(taskPrompt(run, feedback), { outputSchema: resultSchema, signal });
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
