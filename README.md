# PlaniFiKateur

Un tableau de projets inspiré de Trello, conçu pour préparer des demandes consultables par des agents IA.

## Interface et connectivité

- Projets indépendants, listes personnalisées et cartes déplaçables.
- Suppression d’un projet avec confirmation, y compris du dernier projet ; ses listes et cartes sont supprimées avec lui.
- Création et édition avec titre, description, statut, priorité, étiquettes, critères et commentaires.
- Recherche, filtres, affichage mobile et navigation au clavier.
- Mode connecté : données SQLite partagées entre le site et l’API de consultation.
- Comptes individuels par e-mail et mot de passe, invitations, déconnexion et gestion des membres par l’administrateur.
- Créateur des cartes et auteur des commentaires attribués par le serveur ; historique des actions pour préparer les notifications.
- Accès agent en lecture seule avec une clé dédiée.
- Consultation des cartes avec projet obligatoire, pour éviter de mélanger des titres identiques entre projets.
- Actualisation automatique toutes les 5 secondes et au retour sur l’onglet, suspendue pendant l’édition et les sauvegardes.
- Détection des modifications concurrentes et messages de sauvegarde fiables.
- Sauvegardes SQLite automatiques, copies avant suppression, téléchargement administrateur et restauration avec copie de sécurité.
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

Le site et l’API écoutent sur `127.0.0.1:3000` par défaut. La base persistante `.data/planifikateur.sqlite` est ignorée par Git. Aucune clé d’environnement n’est nécessaire pour un développement local, mais le premier compte doit être créé depuis le site. Toute exposition réseau ou exécution avec `NODE_ENV=production` exige des clés d’initialisation et agent différentes. Les paramètres, les routes et des exemples de consultation sont décrits dans [la documentation API](docs/api.md).

Après le déploiement de la v0.1.10, créer le compte administrateur avec l’ancienne clé `PLANIFIKATEUR_OWNER_TOKEN`, puis inviter les membres depuis « Mon compte ». Les projets existants sont conservés. Voir [les comptes et l’historique](docs/accounts.md) pour la migration et les droits.

La spécification OpenAPI est disponible dans [public/openapi.json](public/openapi.json), servie par le site à `/openapi.json`.

## Tests

```sh
npm test
npm run test:browser
```

Les tests Node vérifient l’API, l’accès en lecture seule, les filtres, la pagination, la validation, les conflits et la conservation des cartes après réouverture de SQLite.

Les tests navigateur couvrent les parcours sur ordinateur et mobile, la création d’une carte consultable par l’API, le partage entre navigateurs, les erreurs de sauvegarde, les conflits, l’import JSON et la copie autonome dans des aperçus qui interdisent les soumissions natives de formulaires.

Les tests utilisent Chromium installé sur la machine. S’il est absent, exécuter `npx playwright install chromium` ou définir `PLAYWRIGHT_CHROMIUM_EXECUTABLE` vers le navigateur de test.

## Sauvegardes

Les copies sont automatiquement créées à côté de la base, sur le volume persistant. Depuis le site, le bouton d’information permet de les consulter et de les télécharger. Voir [la procédure de sauvegarde et restauration](docs/backups.md) pour Railway, les paramètres et les commandes `npm run db:backup` / `npm run db:restore`.

Conserver également des copies hors du volume Railway.

## Copie HTML autonome

```sh
npm run export:preview
```

`dist/PlaniFiKateur-apercu-v0.1.10.html` contient l’interface, les scripts et les polices. Cette copie fonctionne hors ligne et conserve ses données dans le navigateur. **Elle n’héberge pas l’API.** Pour rendre ses projets consultables par les agents, les exporter en JSON puis les importer dans le site connecté au serveur via le bouton d’information.

Une copie déjà téléchargée ne reçoit pas les corrections du serveur. Le stockage d’une ancienne copie peut être isolé par le navigateur ; il ne sera pas transféré automatiquement. La version est affichée dans le menu des projets.

## Évolutions suivantes

Héberger le serveur sur une origine HTTPS avec un volume de données persistant. Le parcours d’un seul agent est disponible : préparation, réservation exclusive, questions, résultats et validation humaine. Connecter un service agent externe avec sa clé dédiée ; voir [le guide agent](docs/agents.md). Les droits des membres par projet, les notifications, le travail GitHub et la délégation restent à ajouter.

Les comptes peuvent suivre ou ne plus suivre une carte depuis son détail, même sans en être auteurs. Les abonnements persistants alimentent les destinataires des futures notifications ; aucun envoi de notification n’est encore actif. Voir [la documentation des comptes](docs/accounts.md#suivre-une-carte).

Le détail des cartes comprend **Travail IA** : objectif, critères, échanges, livrables et validation. Le serveur conserve les exécutions ; aucun moteur IA n’est lancé automatiquement. Le client de référence est `scripts/agent-client.mjs`.

L’administrateur peut supprimer un membre depuis « Mon compte », après confirmation. L’accès est révoqué immédiatement et les contributions restent attribuées à leur auteur.
