import { mkdir } from 'node:fs/promises';
import { join, resolve, relative, sep } from 'node:path';
import { commandEnvironment } from './commands.mjs';
import { resultSchema, taskPrompt, prepareAttachments } from './codex.mjs';
import { parseModelResult } from './model-result.mjs';

export function createClaudeRunner(config, dependencies = {}) {
  return {
    async run({ run, job, cwd, signal, onThread, onRuntime, onUsage, feedback, environment }) {
      if (!config.claudeApiKey && !config.claudeOauthToken)
        return {
          status: 'question',
          summary: '',
          files: [],
          question:
            'Claude Code n’est pas authentifié. Un administrateur doit configurer ANTHROPIC_API_KEY ou CLAUDE_CODE_OAUTH_TOKEN dans l’environnement privé du worker, puis recréer le conteneur pour charger cette variable. Répondez dans cette discussion une fois la configuration appliquée.',
        };
      const { query } = dependencies.query ? dependencies : await import('@anthropic-ai/claude-agent-sdk');
      const home = join(cwd, '.planifikateur', 'home');
      await mkdir(home, { recursive: true });
      await mkdir(config.claudeHome, { recursive: true, mode: 0o700 });
      const attachments = await prepareAttachments(run, cwd);
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      if (signal?.aborted) throw signal.reason;
      signal?.addEventListener('abort', abort, { once: true });
      let question = '',
        response;
      const ai = job.ai || run.ai || {};
      const options = {
        cwd,
        abortController: controller,
        permissionMode: 'acceptEdits',
        settingSources: [],
        tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'AskUserQuestion'],
        env: {
          ...commandEnvironment(environment),
          HOME: home,
          CLAUDE_CONFIG_DIR: config.claudeHome,
          PLANIFIKATEUR_WORKER: '1',
          ...(environment?.ELECTRON_SKIP_BINARY_DOWNLOAD
            ? { ELECTRON_SKIP_BINARY_DOWNLOAD: environment.ELECTRON_SKIP_BINARY_DOWNLOAD }
            : {}),
          ...(config.claudeApiKey ? { ANTHROPIC_API_KEY: config.claudeApiKey } : {}),
          ...(config.claudeOauthToken ? { CLAUDE_CODE_OAUTH_TOKEN: config.claudeOauthToken } : {}),
        },
        ...(ai.model ? { model: ai.model } : {}),
        ...(ai.effort ? { effort: ai.effort } : {}),
        ...(job.threadId ? { resume: job.threadId } : {}),
        outputFormat: { type: 'json_schema', schema: resultSchema },
        sandbox: {
          enabled: true,
          failIfUnavailable: true,
          autoAllowBashIfSandboxed: true,
          allowUnsandboxedCommands: false,
          filesystem: { allowWrite: [cwd], denyRead: [config.codexHome, config.claudeHome] },
          credentials: {
            envVars: [
              { name: 'ANTHROPIC_API_KEY', mode: 'deny' },
              { name: 'CLAUDE_CODE_OAUTH_TOKEN', mode: 'deny' },
            ],
          },
        },
        canUseTool: async (name, input) => {
          if (name === 'AskUserQuestion') {
            question = (input.questions || [])
              .map(item =>
                [
                  item.question,
                  ...(item.options || []).map(
                    option => `${option.label}${option.description ? ` : ${option.description}` : ''}`,
                  ),
                ].join('\n'),
              )
              .join('\n\n');
            if (!question.trim() || question.length > 10000) throw new Error('Question Claude Code invalide.');
            // Stop the turn and let the card discussion supply the human response.
            controller.abort();
            return { behavior: 'deny', message: 'Question transmise à la discussion de la carte.' };
          }
          if (!options.tools.includes(name)) return { behavior: 'deny', message: 'Outil non autorisé.' };
          if (input.file_path) {
            const path = resolve(cwd, input.file_path),
              outside = relative(cwd, path);
            if (outside === '..' || outside.startsWith('..' + sep))
              return { behavior: 'deny', message: 'Le fichier doit rester dans le dépôt.' };
          }
          return { behavior: 'allow', updatedInput: input };
        },
      };
      try {
        for await (const event of query({ prompt: taskPrompt(run, feedback, attachments), options })) {
          if (event.type === 'system' && event.subtype === 'init') {
            await onThread(event.session_id);
            if (event.model) await onRuntime?.({ engine: 'claude-code', model: event.model, effort: ai.effort || '' });
          }
          if (event.type === 'result' && event.usage) {
            const usage = event.usage;
            onUsage?.({
              inputTokens:
                (usage.input_tokens || 0) +
                (usage.cache_read_input_tokens || 0) +
                (usage.cache_creation_input_tokens || 0),
              cachedInputTokens: usage.cache_read_input_tokens || 0,
              outputTokens: usage.output_tokens || 0,
              costUsd: event.total_cost_usd,
              durationMs: event.duration_ms,
            });
          }
          if (event.type === 'result') {
            if (event.subtype !== 'success' || event.is_error)
              throw new Error(
                'L’exécution Claude Code a échoué. Vérifiez son modèle, son effort, son authentification et son sandbox.',
              );
            response = event.structured_output ?? event.result;
          }
        }
        if (question) return { status: 'question', summary: '', question, files: [] };
        if (response === undefined) throw new Error('Claude Code s’est arrêté sans résultat.');
        return parseModelResult(response);
      } catch (error) {
        if (question) return { status: 'question', summary: '', question, files: [] };
        throw error;
      } finally {
        signal?.removeEventListener('abort', abort);
      }
    },
  };
}
