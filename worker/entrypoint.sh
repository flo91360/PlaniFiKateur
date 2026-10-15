#!/bin/sh
set -eu
# Railway volumes can be mounted as root. Only initialize the worker's directories.
mkdir -p /data/codex
chown node:node /data /data/codex
# Les clés quittent l'environnement : le worker les lit dans ce fichier privé puis le supprime
# (worker/secrets.mjs). Sinon, tout processus de l'utilisateur node pourrait les lire dans
# /proc/<pid>/environ.
mkdir -p /run/planifikateur
chown node:node /run/planifikateur
chmod 700 /run/planifikateur
secrets=/run/planifikateur/secrets
umask 077
: > "$secrets"
for name in PLANIFIKATEUR_AGENT_TOKEN PLANIFIKATEUR_GITHUB_TOKEN OPENAI_API_KEY CODEX_API_KEY ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN; do
  eval "value=\${$name-}"
  if [ -n "$value" ]; then
    printf '%s=%s\n' "$name" "$value" >> "$secrets"
    unset "$name"
  fi
done
chown node:node "$secrets"
export PLANIFIKATEUR_WORKER_SECRETS="$secrets"
exec gosu node "$@"
