FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates chromium python3 make g++ gosu bubblewrap socat ripgrep \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/worker
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
