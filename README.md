# PlaniFiKateur

Un tableau de projets inspiré de Trello, conçu pour préparer des demandes consultables par des agents IA.

## Interface et connectivité

- Projets indépendants, listes personnalisées et cartes déplaçables, à la souris ou depuis le détail de la carte (liste et position, au clavier ou au toucher).
- Listes modifiables (nom, couleur, place, suppression d’une liste vide) et projet modifiable par ses responsables (nom, description, symbole, couleur).
- Suppression d’un projet avec confirmation, y compris du dernier projet ; ses listes et cartes sont supprimées avec lui.
- Création et édition avec titre, description, statut, priorité, étiquettes et commentaires.
- Dictée de la description au micro et reformulation de la demande par l’IA (« Reformuler avec l’IA »).
- Recherche, filtres, affichage mobile et navigation au clavier.
- Panneau « Exécution IA » dans le détail de carte : étapes, PR et contrôles GitHub, boutons pour confier la carte à l’agent, annuler, demander des corrections ou relancer.
- Badge sur chaque carte du tableau où l’agent travaille : en attente, au travail, question, résultat à valider, PR à approuver, tests GitHub en cours ou en échec.
- Adresse propre à chaque projet et à chaque carte ouverte (`#/projets/…/cartes/…`) : partageable, conservée au rechargement, refermée par « Précédent ».
- Paramètres du projet en onglets (Accès, Agent IA, Dépôt), chacun résumant son état.
- Consommation de chaque exécution IA dans le détail de la carte : tentatives, durée, tokens et coût estimé (Claude Code).
- Boîte « À traiter » avec badge : questions de l’agent et résultats à valider de tous les projets, ouverts en un clic.
- Confirmation avant toute modification qui annulerait une exécution IA en cours.
- Mode connecté : données SQLite partagées entre le site et l’API de consultation, rangées en tables (projets, listes, cartes, commentaires, pièces jointes).
- Enregistrement des seules modifications : deux personnes peuvent travailler en même temps sur des cartes ou des champs différents sans conflit, et des routes par élément (`POST`, `PATCH`, `DELETE`) permettent aux intégrations de modifier projets, listes, cartes et commentaires.
- Critères, pièces jointes et étiquettes enregistrés élément par élément ; une modification refusée par le serveur est retirée de la page avec un message, sans bloquer les suivantes.
- Garde-fou d’affichage : une erreur dans une partie de la page affiche un message au lieu d’une page blanche.
- Tableau allégé : les pièces jointes se téléchargent à la demande, les droits et les notifications se lisent sans relire tout le tableau.
- Actualisation par projet : un changement ne fait relire que le projet concerné, et l’enregistrement ne renvoie que les projets modifiés.
- Comptes individuels par e-mail et mot de passe, invitations, déconnexion et gestion des membres par l’administrateur.
- Droits par projet : lecture, contribution ou responsable, projet masqué aux autres membres ; seuls les responsables confient une carte à l’agent.
- Validation avant fusion, en option par projet : la PR de l’agent attend l’approbation d’un responsable.
- Worker isolé : installation et tests du projet dans bubblewrap, sans accès aux clés ni à l’état du worker ; une PR qui modifie ses propres contrôles (workflows, scripts de test) attend l’approbation d’un responsable.
- Notifications en direct (commentaires, statuts, étapes de l’agent) sur les cartes que l’on a créées, commentées ou que l’on suit.
- Créateur des cartes et auteur des commentaires attribués par le serveur ; historique des actions pour préparer les notifications.
- Accès agent en lecture seule avec une clé dédiée.
- Consultation des cartes avec projet obligatoire, pour éviter de mélanger des titres identiques entre projets.
- Mise à jour en direct par un flux d’événements (tableau, exécutions IA, suivis), avec une vérification toutes les 5 secondes en secours ; suspendue pendant l’édition et les sauvegardes.
- Rétention configurable de l’historique et des exécutions terminées (365 jours par défaut).
- Fusion des modifications concurrentes par le serveur et messages de sauvegarde fiables.
- Sauvegardes SQLite automatiques, copies avant suppression, téléchargement administrateur et restauration avec copie de sécurité.
- Import/export JSON pour transférer des projets locaux sans remplacer les projets existants.

Les données initiales sont des exemples. Une carte n’est confiée à l’agent IA
que lorsqu’elle passe au statut **Prête à démarrer**, dans un projet dont le
dépôt GitHub et l’agent sont configurés (voir [Évolutions suivantes](#évolutions-suivantes)).

## Dicter et reformuler une demande

Sous la description d’une carte (création ou détail), **Dicter** active le micro.
Parlez aussi longtemps que nécessaire : la transcription s’affiche pendant
l’enregistrement et s’ajoute à la description quand vous cliquez sur **Arrêter**.
La dictée utilise la reconnaissance vocale du navigateur (Chrome, Edge ou Safari ;
Firefox ne la propose pas) : aucune clé n’est nécessaire et l’audio ne passe pas
par le serveur du site, mais le navigateur peut l’envoyer à son propre service de
reconnaissance (Google pour Chrome, par exemple). L’accès au micro doit être
autorisé pour le site.

**Reformuler avec l’IA** (baguette magique) demande à Claude, via votre
abonnement Claude Code, d’analyser la description sans rien réaliser ni modifier
(aucun outil ni accès aux fichiers), puis de la réécrire en demande claire pour
l’agent : objectif, comportement attendu, contraintes et vérification. Si un
dépôt GitHub est associé au projet, Claude reçoit aussi son README et son
`CLAUDE.md` (ou `AGENTS.md` à défaut), lus sur la branche cible : il emploie le
vocabulaire du projet et évite les questions auxquelles ils répondent déjà. Ces
fichiers sont relus seulement quand la branche change de commit, tronqués à
12 000 caractères chacun ; un dépôt privé nécessite `PLANIFIKATEUR_GITHUB_TOKEN`
(déjà utilisé pour la carte Infos). Les points ambigus sont signalés « À préciser » et donnent lieu à des questions :
répondez-y puis **Reformuler avec mes réponses**, ou appliquez la proposition
telle quelle. La proposition reste modifiable et ne remplace la description
qu’avec **Remplacer la description** ; **Rétablir le texte précédent** annule ce
remplacement.

Pour l’activer, créez un jeton d’abonnement avec `claude setup-token` (Claude
Code, sur votre poste) et placez-le dans la variable `CLAUDE_CODE_OAUTH_TOKEN`
du service **du site** (le jeton déjà utilisé par le worker convient aussi). Les
reformulations consomment le quota de cet abonnement, partagé avec le worker
s’il utilise le même compte. Le modèle par défaut est celui de l’abonnement ;
`PLANIFIKATEUR_REFINE_MODEL` permet d’en imposer un (par exemple
`claude-sonnet-5-5`). Le jeton n’est jamais transmis au navigateur. La fonction
n’est pas disponible dans la copie HTML hors ligne. Voir
[la route de reformulation](docs/api.md#reformulation-des-descriptions).

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

Après le déploiement de la v0.1.17, créer le compte administrateur avec l’ancienne clé `PLANIFIKATEUR_OWNER_TOKEN`, puis inviter les membres depuis « Mon compte ». Les projets existants sont conservés. Voir [les comptes et l’historique](docs/accounts.md) pour la migration et les droits.

La spécification OpenAPI est disponible dans [public/openapi.json](public/openapi.json), servie par le site à `/openapi.json`.

## Tests

```sh
npm run format
npm test
npm run test:browser
```

`npm test` vérifie d’abord la mise en forme (Prettier, `npm run format:check`) et
ESLint (`npm run lint`) ; un test qui dépasse 60 secondes échoue au lieu de bloquer.
Les tests Node vérifient l’API, l’accès en lecture seule, les filtres, la pagination, la validation, les conflits et la conservation des cartes après réouverture de SQLite.

Les tests navigateur couvrent les parcours sur ordinateur (et sur mobile pour les tests d’affichage marqués `@mobile`), la création d’une carte consultable par l’API, le partage entre navigateurs, les erreurs de sauvegarde, les conflits, l’import JSON et la copie autonome dans des aperçus qui interdisent les soumissions natives de formulaires.

Les tests utilisent Chromium installé sur la machine. S’il est absent, exécuter `npx playwright install chromium` ou définir `PLAYWRIGHT_CHROMIUM_EXECUTABLE` vers le navigateur de test.

## Sauvegardes

Les copies sont automatiquement créées à côté de la base, sur le volume persistant. Depuis le site, l’administrateur les consulte et les télécharge dans la fenêtre **Espace personnel** du menu latéral, seul accès aux sauvegardes serveur. Voir [la procédure de sauvegarde et restauration](docs/backups.md) pour Railway, les paramètres et les commandes `npm run db:backup` / `npm run db:restore`.

Conserver également des copies hors du volume Railway.

## Copie HTML autonome

```sh
npm run export:preview
```

`dist/PlaniFiKateur-apercu-v0.1.56.html` contient l’interface, les scripts et les polices. Cette copie fonctionne hors ligne et conserve ses données dans le navigateur. **Elle n’héberge pas l’API.** Pour rendre ses projets consultables par les agents, les exporter en JSON puis les importer dans le site connecté au serveur via le bouton d’information.

Une copie déjà téléchargée ne reçoit pas les corrections du serveur. Le stockage d’une ancienne copie peut être isolé par le navigateur ; il ne sera pas transféré automatiquement. La version est affichée dans le menu des projets.

La liste **Terminées** rassemble automatiquement les tâches terminées : une carte
passée au statut « Terminée », à la main ou après la fusion de sa PR, y est déplacée
pour que les autres listes ne gardent que le travail à faire. Chaque projet l’a,
même vide, juste avant la colonne Infos ; une liste déjà nommée « Terminées » est
reprise. Les cartes déjà terminées y sont rangées au
démarrage du serveur.

La liste **Discussion** sert à échanger sur le fonctionnement du projet et ses
futures évolutions : la description d’une carte y est une question, jamais une
demande de modification. Le statut « Prête à démarrer » y est indisponible, et une
carte déplacée dans Discussion quitte la file de l’agent (son exécution en cours
est annulée). Quand un responsable pose la question, puis à chaque relance qu’il
écrit en commentaire, le worker copie le dépôt en lecture seule et l’agent répond
dans la discussion de la carte : ni branche, ni commit, ni PR, et la carte garde
son statut et sa liste. Ces réponses utilisent un modèle plus léger (Haiku avec
Claude Code, effort faible avec Codex). Chaque projet l’a, même vide, juste avant Terminées ; une
liste déjà nommée « Discussion » est reprise.

La colonne **Info / Infos** contient une carte de version propre au dépôt associé
au projet : son titre est le dernier tag publié et sa description indique sa date
de publication, en heure de Paris. Le serveur consulte GitHub au démarrage, après une
configuration de dépôt et toutes les quinze minutes. Les pushs de tags et les
Releases publiées reçus par le webhook signé mettent la carte à jour immédiatement.
Pour les dépôts privés, la variable serveur `PLANIFIKATEUR_GITHUB_TOKEN` doit avoir
un accès en lecture aux dépôts concernés ; elle n’est jamais transmise au navigateur.

Dans les événements du webhook GitHub, activer **Pushes** et **Releases** en plus
des événements existants. La date affichée est celle du push ou de la création du
tag ; pour un tag créé par une Release GitHub (par exemple depuis GitHub Actions),
c’est la date de publication de la Release. Sans l’une ni l’autre, la date est
indiquée comme indisponible : la date du commit ou la date de création d’un tag
annoté ne sont pas des dates de publication. Les métadonnées sont
conservées dans SQLite et la carte est actualisée sans dupliquer son contenu ni
supprimer sa discussion. Une erreur GitHub conserve la dernière valeur connue.

La même colonne contient aussi une carte **Mode d’emploi du projet**, créée par
défaut pour chaque projet. Dès qu’un dépôt GitHub est associé, elle affiche le
lien vers son README (`https://github.com/<dépôt>#readme`), cliquable directement
sous la carte du tableau (**Lire le mode d’emploi (README)**) et dans son détail
(**Consulter le mode d’emploi (README)**) : une personne qui teste
le projet y trouve ce qui a été réalisé et comment l’utiliser. Pour un dépôt
privé, la lecture du README demande un accès GitHub au dépôt.

La carte **Changelog** est également créée par défaut dans cette colonne, y
compris pour les projets existants. Elle présente les notes des releases GitHub
publiées, de la plus récente à la plus ancienne, avec le tag et la date de chaque
version. La synchronisation récupère aussi les anciennes releases ; les événements
signés de publication et de modification actualisent leurs notes sans doublons.
Les brouillons sont exclus. L’historique est conservé dans SQLite et reste visible
si GitHub est indisponible. L’aperçu dans la description est limité à 20 000
caractères ; ouvrir la carte permet de lire son contenu et de discuter des nouveautés.
Dès qu’un dépôt est associé, un lien **Lire le changelog (CHANGELOG.md)**
s’affiche directement sous la carte du tableau, et **Consulter le changelog
(CHANGELOG.md)** dans son détail. Il ouvre le fichier `CHANGELOG.md` de la branche
par défaut (`https://github.com/<dépôt>/blob/HEAD/CHANGELOG.md`), que le worker
complète à chaque livraison avec la nouvelle version, la date, le titre de la
carte et le résumé des modifications (voir
[le guide multi-projets](docs/multi-projets.md#changelog-de-chaque-projet)).
Sans release publiée, la description rappelle ce lien.

## Évolutions suivantes

Les interventions directes et les cartes suivent le [même parcours de livraison](docs/livraison.md) :
version et changelog préparés par le même module, tests, PR, fusion automatique,
tag après les tests de main et vérification de la version déployée sur Railway.
GitHub refuse une livraison PlaniFiKateur sans nouvelle version ni changelog.

Le serveur archive automatiquement les `.exe` des Releases GitHub de chaque projet
dans votre dossier Google Drive, avec un sous-dossier par dépôt et par version. Un
nouveau projet n’a besoin que de son dépôt GitHub. La carte Infos reçoit le lien de
téléchargement. Voir [l’archivage Google Drive](docs/google-drive.md).

Héberger le serveur sur une origine HTTPS avec un volume de données persistant. Le parcours d’un seul agent est disponible : préparation, réservation exclusive, questions, résultats et validation humaine. Connecter un service agent externe avec sa clé dédiée ; voir [le guide agent](docs/agents.md). Les droits des membres sont réglés par projet ([droits par projet](docs/accounts.md#droits-par-projet--v0127)) ; les notifications sont affichées dans le site ([notifications](docs/accounts.md#notifications--v0128)) ; l’envoi par e-mail et la délégation restent à ajouter.

Les comptes peuvent suivre ou ne plus suivre une carte depuis son détail, même sans en être auteurs. Les abonnements persistants alimentent les destinataires des futures notifications ; aucun envoi de notification n’est encore actif. Voir [la documentation des comptes](docs/accounts.md#suivre-une-carte).

Les **Paramètres du projet** rassemblent le dépôt GitHub et les autorisations de l’agent. La discussion de chaque carte permet de suivre son traitement, répondre aux questions et consulter les livrables. Passer une carte au statut **Prête à démarrer**, ou cliquer **Confier à l’agent** dans son panneau **Exécution IA**, suffit : le worker la détecte automatiquement. La description de la carte constitue directement la demande pour l’agent. Le serveur conserve les exécutions. Le [worker Codex](docs/worker.md), lancé séparément avec `npm run worker`, prend les cartes, réalise les modifications et tests, ouvre la PR et effectue sa fusion après les contrôles GitHub réussis et la vérification de la carte. Le client de référence reste `scripts/agent-client.mjs`.

L’administrateur peut supprimer un membre depuis « Mon compte », après confirmation. L’accès est révoqué immédiatement et les contributions restent attribuées à leur auteur.

Toutes les nouvelles livraisons suivent **tests GitHub → fusion automatique → carte terminée** ; un projet peut exiger en plus l’approbation d’un responsable avant la fusion. Configurer les accès du worker, le webhook et les contrôles requis selon [le guide GitHub](docs/github.md).

La description suffit à préparer une tâche IA. L’agent en déduit le résultat attendu et les vérifications à réaliser ; aucun critère d’acceptation séparé n’est demandé.

Les cartes peuvent contenir des pièces jointes dès leur création ou depuis leur
fiche : fichiers, images et captures collées dans la zone prévue. Les images PNG,
JPEG, GIF et WebP ont un aperçu ; chaque fichier peut être téléchargé ou retiré.
La limite est de 10 fichiers et 2 Mo par carte, 1 Mo par fichier et 20 Mo de
pièces jointes par projet. Les contenus sont conservés dans SQLite, inclus dans
les sauvegardes et les exports JSON, et accessibles avec les mêmes droits que les
cartes. Le worker prépare les fichiers dans `.planifikateur/attachments/` (exclu
par le worker des commits) et transmet les images à Codex. Modifier les pièces
jointes d’une demande en cours annule cette exécution et remet la carte en
brouillon, comme une modification de sa description.
