# PlaniFiKateur

Tableau de projets façon Trello dont les cartes servent de demandes à un agent IA.
Une carte passée **Prête à démarrer** est prise par le worker, qui code, teste,
ouvre une PR, attend la CI puis fusionne ; le webhook GitHub termine la carte.
Documentation fonctionnelle : `README.md` et `docs/` (API, agents, worker, GitHub,
comptes, sauvegardes, Google Drive, multi-projets).

## Structure

- `src/` : interface React 19 + Vite (`main.jsx`, `components/`). `src/lib/` est
  partagé avec le serveur (validation du workspace, infos, releases Drive).
- `server/` : API Node sans framework, montée dans Vite en dev (`vite.config.js`)
  et par `server/index.js` en production. Stockage SQLite via `node:sqlite`
  (`store.js`), parcours agent dans `workflows.js`.
- `worker/` : worker IA séparé (Codex ou Claude Agent SDK), avec **son propre
  `package.json`**. Profils d’exécution par dépôt dans `execution-profile.mjs`.
- `scripts/` : client agent de référence, sauvegarde/restauration, export HTML,
  Google Drive.
- `public/openapi.json` : spécification de l’API, servie à `/openapi.json`.
- `tests/*.test.js` : tests `node:test` (serveur et worker) ;
  `tests/browser/` : Playwright, projets ordinateur et mobile.

## Commandes

Node.js 24 est requis (`engines`).

```sh
npm ci && npm ci --prefix worker   # les tests importent aussi le code du worker
npm run dev                        # site + API sur 127.0.0.1:3000
npm test                           # tests Node
npm run test:browser               # compile, exporte l’aperçu, puis Playwright
```

Hors CI, Playwright cherche Chromium via `PLAYWRIGHT_CHROMIUM_EXECUTABLE` ou
`/usr/bin/chromium`.

## Conventions

- Textes de l’interface, messages d’erreur, documentation et commits du dépôt
  en français. Modules ES uniquement.
- Peu de dépendances : préférer les modules intégrés de Node (`node:sqlite`,
  `node:crypto`, `node:test`) avant d’ajouter un paquet.
- Réponses API `{ "data": ... }`, erreurs `{ "error": { "code", "message" } }`.
  Toute route ajoutée ou modifiée se reflète dans `public/openapi.json` et
  `docs/api.md` (ou `docs/agents.md` pour le parcours agent).
- Les secrets (`PLANIFIKATEUR_*_TOKEN`, clés GitHub, Drive, IA) ne sont jamais
  transmis au navigateur, ni écrits dans une carte, une URL, Git ou un journal.
- Les profils d’exécution du worker sont du code installé de confiance : ne
  jamais charger de règle de livraison depuis la branche en cours de modification.
- Le numéro de version figure dans `package.json`, `README.md`, `docs/agents.md`
  et `docs/github.md` : les mettre à jour ensemble lors d’une montée de version.

## Livraison

Appliquer les mêmes règles pour toute livraison, directe ou issue d'une carte :
**code → version et changelog → tests → PR → fusion automatique → tag →
vérification du déploiement**. Les consignes communes font autorité dans
[AGENTS.md](AGENTS.md) et le déroulement dans [docs/livraison.md](docs/livraison.md).

Utiliser le module commun de préparation, jamais une incrémentation improvisée.
Lors d'une intervention directe, lancer `npm run delivery:prepare` avec un
identifiant stable de livraison, le titre et le résumé, puis vérifier et publier
la PR. Lors d'une exécution `PLANIFIKATEUR_WORKER=1`, laisser le worker appeler
ce module et effectuer tests, commit, push, PR et fusion ; l'agent fournit le code
et un résumé clair. Aucune de ces situations ne dispense de version ni de changelog.

## Données

La base persistante est `PLANIFIKATEUR_DB_PATH` (par défaut
`.data/planifikateur.sqlite`). Ne jamais effacer le volume ou la base pour
résoudre un problème de démarrage : utiliser `npm run db:backup` /
`npm run db:restore` (voir `docs/backups.md`).
