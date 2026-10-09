# PlaniFiKateur

Un tableau de projets inspiré de Trello, conçu pour préparer des demandes consultables par des agents IA.

## Interface et connectivité

- Projets indépendants, listes personnalisées et cartes déplaçables.
- Suppression d’un projet avec confirmation, y compris du dernier projet ; ses listes et cartes sont supprimées avec lui.
- Création et édition avec titre, description, statut, priorité, étiquettes, critères et commentaires.
- Recherche, filtres, affichage mobile et navigation au clavier.
- Mode connecté : données SQLite partagées entre le site et l’API de consultation.
- Accès agent en lecture seule et connexion propriétaire pour l’interface.
- Détection des modifications concurrentes et messages de sauvegarde fiables.
- Import/export JSON pour transférer des projets locaux sans remplacer les projets existants.

Les données initiales sont des exemples. Aucun agent n’est exécuté ni aucune tâche déléguée automatiquement.

## Démarrer le site avec l’API

Prérequis : **Node.js 24** et npm. SQLite utilise le module intégré à Node, sans service à installer.

```sh
cd /workspace/PlaniFiKateur
npm ci
npm run dev
```

La version compilée utilise le même stockage :

```sh
npm run build
npm start
```

Le site et l’API écoutent sur `127.0.0.1:3000` par défaut. La base persistante `.data/planifikateur.sqlite` est ignorée par Git. Aucun secret n’est nécessaire pour un développement local. Toute exposition réseau ou exécution avec `NODE_ENV=production` exige des clés propriétaire et agent différentes. Les paramètres, les routes et des exemples de consultation sont décrits dans [la documentation API](docs/api.md).

La spécification OpenAPI est disponible dans [public/openapi.json](public/openapi.json), servie par le site à `/openapi.json`.

## Tests

```sh
npm test
npm run test:browser
```

Les tests Node vérifient l’API, l’accès en lecture seule, les filtres, la pagination, la validation, les conflits et la conservation des cartes après réouverture de SQLite.

Les tests navigateur couvrent les parcours sur ordinateur et mobile, la création d’une carte consultable par l’API, le partage entre navigateurs, les erreurs de sauvegarde, les conflits, l’import JSON et la copie autonome dans des aperçus qui interdisent les soumissions natives de formulaires.

Les tests utilisent Chromium installé sur la machine. S’il est absent, exécuter `npx playwright install chromium` ou définir `PLAYWRIGHT_CHROMIUM_EXECUTABLE` vers le navigateur de test.

## Copie HTML autonome

```sh
npm run export:preview
```

`dist/PlaniFiKateur-apercu-v0.1.5.html` contient l’interface, les scripts et les polices. Cette copie fonctionne hors ligne et conserve ses données dans le navigateur. **Elle n’héberge pas l’API.** Pour rendre ses projets consultables par les agents, les exporter en JSON puis les importer dans le site connecté au serveur via le bouton d’information.

Une copie déjà téléchargée ne reçoit pas les corrections du serveur. Le stockage d’une ancienne copie peut être isolé par le navigateur ; il ne sera pas transféré automatiquement. La version est affichée dans le menu des projets.

## Évolutions suivantes

Héberger le serveur sur une origine HTTPS avec un volume de données persistant. Ajouter ensuite les comptes et droits par projet, les routes de travail des agents et l’orchestration. La première API expose uniquement la consultation aux agents ; les écritures du site restent réservées à la session propriétaire.
