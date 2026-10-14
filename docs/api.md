# API de consultation des cartes

Le site servi par Node et l’API utilisent le même stockage SQLite. Les modifications de l’interface deviennent consultables après l’indication « Sauvegardé sur le serveur ». La copie HTML autonome conserve des données locales ; elle n’héberge pas d’API.

## Démarrer

Node.js **24** est requis (`node:sqlite`). Depuis le dépôt :

```sh
npm ci
npm run build
npm start
```

Par défaut, le site et l’API écoutent uniquement sur `127.0.0.1:3000`. Ce mode de développement fonctionne sans clé. `npm run dev` propose la même API avec Vite et le rechargement de l’interface.

La base est conservée dans `.data/planifikateur.sqlite` et initialisée avec les projets de démonstration uniquement à sa création. `PLANIFIKATEUR_DB_PATH` permet de choisir un autre fichier. Les sauvegardes cohérentes sont automatiques et téléchargeables depuis le site ; voir [la procédure de sauvegarde et restauration](backups.md). Ne pas copier ou remplacer à la main une base ouverte. Le stockage n’est pas commité dans Git.

## Accès des agents

Pour un accès réseau, configurer dans les paramètres sécurisés de l’hébergement deux clés longues, aléatoires et différentes :

- `PLANIFIKATEUR_OWNER_TOKEN` : initialisation du premier compte administrateur, utilisée une seule fois dans l’interface.
- `PLANIFIKATEUR_READ_TOKEN` : accès des agents à l’API, **lecture seule sur tous les projets**.

Ne pas inclure leurs valeurs dans le code, une URL ou un fichier HTML. Les fournir aux processus via les variables d’environnement. Un agent transmet sa clé dans `Authorization: Bearer …`. L’interface utilise une session personnelle HttpOnly qui expire après 12 heures et persiste après un redémarrage du serveur. Voir [les comptes individuels](accounts.md). Les tentatives de connexion sont limitées à 20 par minute et par adresse.

`PLANIFIKATEUR_HOST=0.0.0.0` permet une écoute réseau ; `PORT` choisit le port. Le serveur refuse cette exposition ou `NODE_ENV=production` sans les deux clés. Pour un déploiement, prévoir un volume persistant pour SQLite et un reverse proxy HTTPS qui conserve l’en-tête Host. Définir `PLANIFIKATEUR_PUBLIC_ORIGIN=https://votre-domaine` pour marquer le cookie de session Secure. Aucun domaine ou hébergement public n’est créé par ces commandes. L’API n’active pas de CORS : l’interface et l’API doivent partager la même origine ; les agents serveur peuvent utiliser HTTPS directement.

L’espace est partagé entre les comptes actifs. Un administrateur invite les membres ; chacun se connecte avec son e-mail et son mot de passe. Les permissions par projet et les délégations d’agents restent des évolutions futures.

## Routes GET

| Route | Réponse |
| --- | --- |
| `/api/v1/projects` | Projets et nombres de listes/cartes |
| `/api/v1/projects/{projectId}` | Informations d’un projet |
| `/api/v1/projects/{projectId}/lists` | Listes et nombre de cartes de chaque liste |
| `/api/v1/projects/{projectId}/cards` | Cartes du projet, filtrées et paginées |
| `/api/v1/projects/{projectId}/cards/{cardId}` | Carte complète appartenant au projet indiqué |
| `/api/v1/cards?projectId={projectId}` | Cartes du projet obligatoire, filtrées et paginées |
| `/api/v1/cards/{cardId}?projectId={projectId}` | Carte complète avec projet obligatoire |

Les routes de collection de cartes acceptent `listId`, `status`, `q`, `limit` (1 à 200, défaut 50) et `offset` (défaut 0). Les routes `/cards` et `/cards/{cardId}` exigent désormais `projectId` : son absence renvoie 400 (`project_required`). Un projet inexistant ou une carte appartenant à un autre projet renvoie 404. Un paramètre `projectId` répété, vide ou contradictoire avec le chemin est refusé avec 400. `q` cherche dans le titre, la description et les étiquettes, sans distinction de casse. Un filtre de liste sans résultat renvoie une liste vide ; un projet inexistant renvoie 404.

Les statuts sont `draft`, `ready`, `progress`, `clarify`, `review`, `flo` (« Flo regarde »), `done`. Une catégorie de liste et un statut sont indépendants.

```sh
# Développement local : configurer PLANIFIKATEUR_READ_TOKEN sur le serveur
# et dans le terminal qui effectue les requêtes
curl --header "Authorization: Bearer $PLANIFIKATEUR_READ_TOKEN" 'http://127.0.0.1:3000/api/v1/projects'
curl --header "Authorization: Bearer $PLANIFIKATEUR_READ_TOKEN" 'http://127.0.0.1:3000/api/v1/projects/planifikateur/cards?status=ready&limit=20'
curl --header "Authorization: Bearer $PLANIFIKATEUR_READ_TOKEN" 'http://127.0.0.1:3000/api/v1/projects/planifikateur/cards/c1'

# Avec une clé agent déjà injectée dans le processus
curl --header "Authorization: Bearer $PLANIFIKATEUR_READ_TOKEN" \
  'https://votre-domaine/api/v1/projects/planifikateur/cards?status=ready'
```

Pour rechercher « Amélioration menu principal », commencer par `GET /api/v1/projects`, identifier le projet voulu puis utiliser son **id**, pas son nom, dans `GET /api/v1/projects/{projectId}/cards?q=Am%C3%A9lioration%20menu%20principal`. La recherche renvoie une liste uniquement dans ce projet. Si plusieurs cartes correspondent dans ce même projet, choisir l’id de la carte voulue puis consulter `GET /api/v1/projects/{projectId}/cards/{cardId}` ; ne pas sélectionner automatiquement le premier résultat. Les noms de projets et titres de cartes ne sont pas des identifiants uniques.

Cette modification impose le projet aux anciennes requêtes de cartes : les clients doivent ajouter `projectId` ou passer aux routes imbriquées. La clé agent conserve l’accès en lecture à tous les projets ; cette sélection explicite évite les confusions, sans introduire de permissions par projet. Les routes internes de l’interface (`workspace`) restent réservées à la session personnelle.

Les réponses sont `{ "data": …, "meta": … }`. Une carte inclut `projectId`, `projectName`, `listId`, `listName`, `title`, `description`, `status`, `priority`, `tags`, `checklist` et `comments`. La pagination fournit `total`, `limit`, `offset` et `nextOffset` (null pour la dernière page). Toutes les réponses indiquent la `revision` du tableau : si elle change pendant un parcours paginé, recommencer la lecture pour obtenir une vue cohérente. Les données ne sont pas mises en cache.

```json
{
  "data": [],
  "meta": { "revision": 1, "total": 0, "limit": 50, "offset": 0, "nextOffset": null }
}
```

Les erreurs renvoient `{ "error": { "code": "…", "message": "…" } }`, avec 400 pour un paramètre invalide, 401 pour un accès non autorisé et 404 pour une ressource absente. Les modifications de cartes via la clé agent sont refusées.

La spécification **OpenAPI 3.1** est servie à `/openapi.json` et conservée dans `public/openapi.json`. Elle décrit toutes les routes servies, y compris celles réservées à l’interface (session, comptes, `workspace`, historique, sauvegardes, paramètres du projet, suivi des cartes) et au worker. `tests/openapi.test.js` échoue si une route servie par `server/api.js` n’y figure pas : toute nouvelle route doit être ajoutée à la spécification et à la liste de ce test.

## Synchronisation de l’interface

Les routes `/api/v1/session` et `/api/v1/workspace` sont réservées à l’interface. GET session indique le compte connecté et si le premier compte administrateur doit être créé ; il n’établit pas de session anonyme. POST session reçoit `{ "email": "…", "password": "…" }` ; DELETE termine la session. GET workspace fournit projets et révision ; PUT enregistre un tableau validé, uniquement avec une session personnelle, du JSON et l’en-tête `If-Match: "révision"`.

Une écriture périmée reçoit 409 et ne remplace jamais le tableau d’un autre navigateur. L’interface conserve alors les modifications en mémoire et permet de les exporter avant de recharger explicitement le serveur. Une sauvegarde réseau échouée peut être relancée. Les limites de contenu sont documentées dans `src/lib/workspace.js` ; une requête ne peut dépasser 4 Mo.

## Récupérer des projets locaux

Dans la nouvelle copie autonome, ouvrir le bouton d’information puis « Exporter les projets (JSON) ». Dans le site connecté, utiliser « Importer des projets ». L’import ajoute les projets avec de nouveaux identifiants sans remplacer ceux du serveur. Vérifier l’indication de sauvegarde avant de fermer la page.

Les anciennes copies HTML restent indépendantes : les projets de votre navigateur ne sont pas accessibles à l’agent tant qu’ils n’ont pas été importés sur le serveur. La nouvelle copie ne peut pas récupérer les données d’une ancienne copie si le navigateur isole le stockage par fichier.

## Actualisation et sauvegardes

`GET /api/v1/workspace` accepte `If-None-Match: "révision"` et renvoie **304 sans corps** si la révision est inchangée. L’authentification du compte est vérifiée même pour cette réponse. Le site vérifie les changements toutes les 5 secondes et au retour sur l’onglet, sans envoyer de nouvelle écriture pour les données reçues. Les lectures sont suspendues pendant une fenêtre d’édition, un déplacement ou une sauvegarde ; une réponse arrivée pendant une saisie ou après une nouvelle sauvegarde est ignorée. Les conflits restent explicites et aucune fusion automatique n’est effectuée. Un problème réseau d’actualisation est affiché sans remplacer le tableau, puis réessayé automatiquement. La copie HTML hors ligne n’effectue aucune actualisation serveur.

Les routes suivantes nécessitent une **session administrateur**, vérifient l’origine et refusent la clé agent :

| Route | Usage |
| --- | --- |
| `GET /api/v1/backups` | Copies disponibles, erreur éventuelle, intervalle et rétention |
| `POST /api/v1/backups` | Créer une copie, réponse 201 avec `data.name` |
| `GET /api/v1/backups/{filename}` | Télécharger une copie SQLite existante |

Les sauvegardes ne sont jamais servies comme fichiers publics. Une suppression de projet, liste ou carte est précédée d’une sauvegarde ; si elle échoue, l’écriture renvoie 503 (`backup_failed`) et laisse les données intactes. La restauration est une commande d’administration décrite dans [backups.md](backups.md), sans route publique de restauration.

Les cartes incluent `createdBy`, `createdAt`, `updatedBy`, `updatedAt` et les commentaires `authorId`. Les identités sont attribuées par le serveur et restent nulles pour les créateurs inconnus d’avant la migration. Les routes de comptes et d’historique sont décrites dans [accounts.md](accounts.md). Aucun mot de passe, e-mail de compte ou secret de session n’est retourné par les routes de cartes.

## Reformulation des descriptions

Avec une session personnelle, `POST /api/v1/projects/{projectId}/refine` reçoit
`{ "description": "…", "title": "…", "listId": "…", "exchanges": [{ "question": "…", "answer": "…" }] }`
et renvoie `{ "data": { "prompt": "…", "questions": ["…"], "model": "…", "sources": ["README", "CLAUDE.md"] } }`. Seule
`description` est obligatoire (20 000 caractères au plus). Le serveur transmet la
description, le titre et le contexte du projet (nom, présentation, dépôt GitHub,
liste) à Claude Code, par le SDK Claude Agent et l’abonnement du propriétaire.
Quand un dépôt est associé, le serveur y ajoute le README et `CLAUDE.md` (ou
`AGENTS.md` à défaut) de la branche cible, lus par l’API GitHub avec
`PLANIFIKATEUR_GITHUB_TOKEN` s’il est défini, tronqués à 12 000 caractères chacun
et conservés tant que la branche reste sur le même commit (vérification au plus
une fois par minute). `sources` liste les fichiers transmis ; un dépôt
inaccessible n’empêche pas la reformulation, qui se fait alors sans eux.
Claude Code s’exécute sans aucun outil, dans un dossier temporaire vide, sans
charger de réglages ni conserver de session : il ne réalise rien et ne modifie
rien. Il reformule la demande pour l’agent, signale les points ambigus
« À préciser » et pose au plus six questions. `exchanges` transmet les réponses
aux questions précédentes ; les questions sans réponse sont ignorées. La route
n’enregistre rien : la carte change uniquement si la personne remplace elle-même
sa description.

Variables du serveur du site, jamais transmises au navigateur :

| Variable | Rôle |
| --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | Jeton d’abonnement créé avec `claude setup-token`. Sans lui, la route répond 503 (`ai_not_configured`). C’est la seule variable transmise au processus Claude Code avec `PATH`, la langue et le proxy éventuel. |
| `PLANIFIKATEUR_REFINE_MODEL` | Facultatif : modèle imposé ; sinon, modèle par défaut de l’abonnement. |

Erreurs : 400 (`invalid_refinement`), 429 au-delà de dix reformulations par minute
et par compte (`too_many_refinements`) ou quand la limite de l’abonnement est
atteinte (`ai_quota`), 502 pour un jeton refusé ou expiré (`ai_unauthorized`), un
modèle indisponible (`ai_rejected`) ou une réponse inexploitable, 503 si Claude est
saturé (`ai_busy`), 504 au-delà de deux minutes (`ai_timeout`).

## Archivage Google Drive

Avec une session personnelle, `GET /api/v1/projects/{projectId}/drive` renvoie l’état de l’archivage des `.exe` des Releases du dépôt du projet : `enabled`, erreurs éventuelles (`configurationError`, `error`, `repositoryError`), `lastRun` et les dix dernières versions (`tag`, `state` parmi `archived`, `error` ou `conflict`, `message`, `folderUrl`, `files`). Aucun secret n’est renvoyé. `POST` sur la même route, réservé à l’administrateur, lance une vérification immédiate et répond `202` ; `503` (`drive_disabled`) si le serveur n’est pas configuré. Voir [l’archivage Google Drive](google-drive.md).

Le suivi personnel des cartes utilise les routes de souscription documentées dans [Comptes individuels](accounts.md#suivre-une-carte), avec une session et un projet explicite.

## Travail des agents

La consultation reste disponible avec la clé de lecture. Les transitions de travail utilisent une identité d’agent distincte, limitée aux projets autorisés, et des réservations exclusives. Voir [le parcours et le contrat API](agents.md). La validation des résultats exige toujours une session humaine.

Les livraisons GitHub utilisent le mode `delivery: "github"` et l’état `merging`. Voir [la fusion automatique et les webhooks](github.md).
