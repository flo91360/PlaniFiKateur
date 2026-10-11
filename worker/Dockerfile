FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates chromium python3 make g++ gosu \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/worker
COPY --chown=node:node worker/package.json worker/package-lock.json ./
RUN --mount=type=secret,id=build_ca,target=/tmp/build-ca.pem \
    if [ -s /tmp/build-ca.pem ]; then \
      NODE_EXTRA_CA_CERTS=/tmp/build-ca.pem npm ci --omit=dev --no-audit --no-fund; \
    else npm ci --omit=dev --no-audit --no-fund; fi
COPY --chown=node:node worker/ ./
# Windows checkouts may contain CRLF even before .gitattributes is applied.
RUN sed -i 's/\r$//' git-askpass.mjs entrypoint.sh \
    && chmod +x git-askpass.mjs entrypoint.sh
ENV PLANIFIKATEUR_WORKER_STATE_DIR=/data \
    CODEX_HOME=/data/codex \
    PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium
ENTRYPOINT ["/opt/worker/entrypoint.sh"]
CMD ["node", "index.mjs"]
