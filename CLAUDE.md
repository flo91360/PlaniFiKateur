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

**Exécution par le worker** (`PLANIFIKATEUR_WORKER=1`) : préparer uniquement les
modifications. Le worker exécute les tests, crée le commit, pousse la branche
`planifikateur/<exécution>` et ouvre la PR. Ne pas committer, pousser, fusionner
ni déléguer à d’autres agents.

**Intervention directe** (session Claude Code) : appliquer ce workflow à chaque
session, de bout en bout et sans redemander confirmation (autorisé par le
propriétaire ; peut déclencher le déploiement Railway) :

1. Implémenter la fonctionnalité demandée, avec ses tests.
2. Vérifier (voir ci-dessous) jusqu’à ce que tout passe.
3. Incrémenter la version : correctif (`x.y.Z+1`) par défaut, mineure si la
   personne le demande. Mettre à jour ensemble `package.json`,
   `package-lock.json` (`npm version <version> --no-git-tag-version`),
   `README.md`, `docs/agents.md` et `docs/github.md`.
4. Ajouter en tête de `CHANGELOG.md` une section `## <version> — <AAAA-MM-JJ>`
   décrivant chaque modification livrée, du point de vue de l’utilisateur.
5. Mettre à jour `README.md` (et `docs/`) si l’usage, la configuration ou une
   route change.
6. Préparer un commit explicite contenant le code, la version et le changelog.
7. Fusionner automatiquement sur `main` : pousser directement sur `main`, ou, si
   la session impose une autre branche, ouvrir la PR, attendre la CI verte
   (« Tests serveur » et « Tests navigateur ») puis la fusionner soi-même. En cas
   de conflit, intégrer `main`, revérifier, puis fusionner.
8. Créer le tag annoté `v<version>` sur le commit de `main` et le pousser
   (`git push origin v<version>`). Si l’environnement refuse le push du tag, le
   dire explicitement avec la commande à lancer ou la Release à créer sur GitHub.

- Vérifications selon les fichiers touchés : `npm test` pour l’API et le worker ;
  ajouter `npm run test:browser` pour l’interface ou les échanges site ↔ API.
  Pour de la documentation seule, `git diff --check` suffit.
- Toujours `git diff --check` avant le commit. Ne pas relancer des vérifications
  déjà réussies sur le même état du code.
- Ne pas pousser de code non validé : corriger, ou expliquer le blocage.
- Committer uniquement les fichiers de la tâche : pas de secrets, de base SQLite,
  de `node_modules` ni de `dist/`. Préserver les modifications sans rapport.
- Pousser sans forcer ; si la branche distante a avancé, intégrer puis revérifier.
- Après le push, confirmer l’identifiant du commit sur GitHub avec un résumé des
  vérifications. Ne pas annoncer un déploiement Railway réussi sans l’avoir vu.

## Données

La base persistante est `PLANIFIKATEUR_DB_PATH` (par défaut
`.data/planifikateur.sqlite`). Ne jamais effacer le volume ou la base pour
résoudre un problème de démarrage : utiliser `npm run db:backup` /
`npm run db:restore` (voir `docs/backups.md`).
