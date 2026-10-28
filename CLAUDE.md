# PlaniFiKateur

Tableau de projets façon Trello dont les cartes servent de demandes à un agent IA.
Une carte passée **Prête à démarrer** est prise par le worker, qui code, teste,
ouvre une PR, attend la CI puis fusionne ; le webhook GitHub termine la carte.
Documentation fonctionnelle : `README.md` et `docs/` (API, agents, worker, GitHub,
comptes, sauvegardes, multi-projets).

## Structure

- `src/` : interface React 19 + Vite. `main.jsx` garde l’état et les actions ;
  l’affichage est dans `components/` (tableau, détail de carte, formulaires…).
  Tout appel à l’API passe par `src/lib/api-client.js` ; les composants lisent
  et enregistrent avec `useApiResource` / `useApiAction` (`src/lib/use-api.js`)
  et affichent leur retour avec `FormStatus`. Les droits sur le projet affiché
  viennent de `useProjectAccess()` (`src/lib/project-access.js`). Styles par
  zone dans `src/styles/`, couleurs communes en variables dans `base.css`.
  `src/lib/` est aussi partagé avec le serveur (validation du workspace, infos,
  releases GitHub).
- `server/` : API Node sans framework, montée dans Vite en dev (`vite.config.js`)
  et par `server/index.js` en production. `api.js` assemble la table de routes
  (`router.js`) décrite par domaine dans `server/routes/` ; `auth.js` gère
  sessions, clés et limites. Stockage SQLite via `node:sqlite` (`store.js`,
  avec comptes, historique et versions publiées dans `server/store/`),
  parcours agent dans `workflows.js`, assemblé depuis `server/workflows/`
  (socle, réglages, agents, exécutions, actions du worker, GitHub).
- `worker/` : worker IA séparé (Codex ou Claude Agent SDK), avec **son propre
  `package.json`**. Profils d’exécution par dépôt dans le registre déclaratif
  `execution-profile.mjs` (dépôts, version, consignes, environnement) ;
  `worker.mjs` enchaîne les étapes d’une tâche, `checkout.mjs` prépare le dépôt
  et `follow-up.mjs` suit les PR jusqu’à la fusion.
- `scripts/` : client agent de référence, sauvegarde/restauration, export HTML.
- `public/openapi.json` : spécification de l’API, servie à `/openapi.json`.
- `tests/*.test.js` : tests `node:test` (serveur et worker) ;
  `tests/browser/` : Playwright, un fichier par domaine, serveur de test et
  aides communs dans `support.js` ; le projet mobile ne rejoue que les tests
  marqués `@mobile`.

## Commandes

Node.js 24 est requis (`engines`).

```sh
npm ci && npm ci --prefix worker   # les tests importent aussi le code du worker
npm run dev                        # site + API sur 127.0.0.1:3000
npm run format                     # met en forme le code (Prettier)
npm test                           # format:check et lint (ESLint), puis tests Node
npm run test:browser               # compile, exporte l’aperçu, puis Playwright
```

Hors CI, Playwright cherche Chromium via `PLAYWRIGHT_CHROMIUM_EXECUTABLE` ou
`/usr/bin/chromium`.

## Conventions

- Textes de l’interface, messages d’erreur, documentation et commits du dépôt
  en français. Modules ES uniquement.
- Code mis en forme par Prettier (`.prettierrc.json`, largeur 120) : lancer
  `npm run format` avant les tests, qui refusent un code non formaté ou une
  erreur ESLint.
- Peu de dépendances : préférer les modules intégrés de Node (`node:sqlite`,
  `node:crypto`, `node:test`) avant d’ajouter un paquet.
- Réponses API `{ "data": ... }`, erreurs `{ "error": { "code", "message" } }`. Exceptions
  historiques gardées pour l’interface, à ne pas étendre : session et comptes (`/session`,
  `/accounts/setup|accept|password`), `GET/PUT /workspace` et `GET /backups` renvoient leur
  objet sans enveloppe.
  Toute route ajoutée ou modifiée se reflète dans `public/openapi.json` (le
  test `tests/openapi.test.js` compare la spécification à la table de routes)
  et dans `docs/api.md` (ou `docs/agents.md` pour le parcours agent).
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
