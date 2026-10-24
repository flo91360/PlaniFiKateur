FROM node:22-bookworm-slim AS node22
FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates chromium python3 python3-venv make g++ gosu bubblewrap socat ripgrep libfontconfig1 libgl1 libpulse0 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/worker
COPY --from=node22 /usr/local/bin/node /opt/node22/bin/node
COPY --from=node22 /usr/local/lib/node_modules/npm /opt/node22/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /opt/node22/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /opt/node22/bin/npx
COPY worker/install-godot.py /tmp/install-godot.py
RUN python3 /tmp/install-godot.py && rm /tmp/install-godot.py
# Le code du worker appartient à root : ni l'agent ni les tests du projet ne peuvent le modifier.
COPY worker/package.json worker/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY worker/ ./
# Windows checkouts may contain CRLF even before .gitattributes is applied.
# Le checkout du VPS est créé avec un umask 077 : sans lecture pour tous, l'utilisateur node
# ne pourrait pas lire le code copié en root.
RUN sed -i 's/\r$//' git-askpass.mjs entrypoint.sh \
    && chmod +x git-askpass.mjs entrypoint.sh \
    && chmod -R a+rX,go-w /opt/worker
ENV PLANIFIKATEUR_WORKER_STATE_DIR=/data \
    PLANIFIKATEUR_WORKER_ISOLATION=bwrap \
    PLANIFIKATEUR_WORKER_STOP_STRAYS=1 \
    CODEX_HOME=/data/codex \
    PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium
ENTRYPOINT ["/opt/worker/entrypoint.sh"]
CMD ["node", "index.mjs"]
