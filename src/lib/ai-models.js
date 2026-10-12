// Models shown by the Codex version installed on the worker:
// https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/models-manager/models.json
// Claude Code 2.1.296's current model families:
// https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md
// This catalog is a UI choice list, not a check of the worker account's access.
export const aiModels = {
  codex: [
    { value: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' },
    { value: 'gpt-6-astra', label: 'GPT-6-Astra' },
    { value: 'gpt-6-sol', label: 'GPT-6-Sol' },
    { value: 'gpt-6-luna', label: 'GPT-6-Luna' },
    { value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
    { value: 'gpt-5.6-terra', label: 'GPT-5.6-Terra' },
    { value: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' },
    { value: 'gpt-5.5', label: 'GPT-5.5' },
  ],
  'claude-code': [
    { value: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
    { value: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
    { value: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
  ],
};
