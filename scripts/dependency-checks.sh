#!/usr/bin/env bash
# Contrôles des dépendances et des images Docker, partagés par ci.yml (requis pour la fusion quand
# les fichiers concernés changent) et dependencies.yml (contrôle hebdomadaire).
#   changed <base>  : écrit `changed=true|false` (voir scripts/dependency-changes.mjs)
#   audit           : vulnérabilités élevées ou critiques, site et worker
#   worker-image    : même construction que worker/deploy/update.py
#   site-image      : même construction que deploy/site.py, puis démarrage et version servie
set -euo pipefail

case "${1:-}" in
  changed)
    node scripts/dependency-changes.mjs "${2:-}"
    ;;
  audit)
    npm audit --audit-level=high
    npm audit --prefix worker --audit-level=high
    ;;
  worker-image)
    docker build -f worker/Dockerfile -t planifikateur-worker:ci .
    docker run --rm --entrypoint node planifikateur-worker:ci --check /opt/worker/index.mjs
    ;;
  site-image)
    context="${RUNNER_TEMP:-$(mktemp -d)}/site"
    rm -rf "$context" && mkdir -p "$context"
    # Même contexte que deploy/site.py : le contenu exact du commit, sans .git.
    git archive --format=tar HEAD | tar -x -C "$context"
    sha="$(git rev-parse HEAD)"
    docker build -f deploy/site.Dockerfile --build-arg PLANIFIKATEUR_COMMIT_SHA="$sha" -t planifikateur-site:ci "$context"
    docker rm -f planifikateur-site-ci >/dev/null 2>&1 || true
    docker run -d --name planifikateur-site-ci \
      -e PLANIFIKATEUR_OWNER_TOKEN=ci-owner-key-0123456789abcdef0123456789 \
      -e PLANIFIKATEUR_READ_TOKEN=ci-read-key-0123456789abcdef01234567890 \
      planifikateur-site:ci >/dev/null
    for attempt in $(seq 1 30); do
      commit=$(docker exec planifikateur-site-ci node -e "fetch('http://127.0.0.1:3000/build-info.json').then(r=>r.json()).then(b=>console.log(b.commit),()=>{})" || true)
      if [ "$commit" = "$sha" ]; then
        echo "Site démarré : $commit"
        docker rm -f planifikateur-site-ci >/dev/null
        exit 0
      fi
      sleep 2
    done
    docker logs planifikateur-site-ci
    docker rm -f planifikateur-site-ci >/dev/null
    exit 1
    ;;
  *)
    echo "Usage : $0 changed <base> | audit | worker-image | site-image" >&2
    exit 2
    ;;
esac
