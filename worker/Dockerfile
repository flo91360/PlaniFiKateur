FROM node:22-bookworm-slim AS node22
FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates chromium python3 make g++ gosu bubblewrap socat ripgrep libfontconfig1 libgl1 libpulse0 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/worker
COPY --from=node22 /usr/local/bin/node /opt/node22/bin/node
COPY --from=node22 /usr/local/lib/node_modules/npm /opt/node22/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /opt/node22/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /opt/node22/bin/npx
COPY worker/install-godot.py /tmp/install-godot.py
RUN python3 /tmp/install-godot.py && rm /tmp/install-godot.py
COPY --chown=node:node worker/package.json worker/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --chown=node:node worker/ ./
# Windows checkouts may contain CRLF even before .gitattributes is applied.
RUN sed -i 's/\r$//' git-askpass.mjs entrypoint.sh \
    && chmod +x git-askpass.mjs entrypoint.sh
ENV PLANIFIKATEUR_WORKER_STATE_DIR=/data \
    CODEX_HOME=/data/codex \
    PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium
ENTRYPOINT ["/opt/worker/entrypoint.sh"]
CMD ["node", "index.mjs"]
