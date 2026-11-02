# Site PlaniFiKateur (interface et API) pour le VPS, derrière le mandataire HTTPS Caddy.
# Construit par deploy/site.py depuis `git archive` du commit testé, sans le dossier .git :
# le commit est donc transmis en argument, pour /build-info.json et la vérification du déploiement.
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ARG PLANIFIKATEUR_COMMIT_SHA=
ENV PLANIFIKATEUR_COMMIT_SHA=$PLANIFIKATEUR_COMMIT_SHA
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim
WORKDIR /app
ARG PLANIFIKATEUR_COMMIT_SHA=
# Un seul mandataire de confiance (Caddy) ; le port du site n’est jamais publié sur la machine.
ENV NODE_ENV=production \
    PLANIFIKATEUR_HOST=0.0.0.0 \
    PORT=3000 \
    PLANIFIKATEUR_DB_PATH=/data/planifikateur.sqlite \
    PLANIFIKATEUR_TRUST_PROXY=1 \
    PLANIFIKATEUR_COMMIT_SHA=$PLANIFIKATEUR_COMMIT_SHA
# Code en lecture seule pour le serveur ; seules les données (/data) lui appartiennent.
COPY --from=build /app /app
RUN chmod -R a+rX,go-w /app && mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
CMD ["node", "server/index.js"]
