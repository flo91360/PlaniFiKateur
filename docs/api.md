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

- `PLANIFIKATEUR_OWNER_TOKEN` : connexion propriétaire dans l’interface.
- `PLANIFIKATEUR_READ_TOKEN` : accès des agents à l’API, **lecture seule sur tous les projets**.

Ne pas inclure leurs valeurs dans le code, une URL ou un fichier HTML. Les fournir aux processus via les variables d’environnement. Un agent transmet sa clé dans `Authorization: Bearer …`. L’interface utilise une session HttpOnly qui expire après 12 heures et après redémarrage du serveur. Les tentatives de connexion sont limitées à 20 par minute et par adresse.

`PLANIFIKATEUR_HOST=0.0.0.0` permet une écoute réseau ; `PORT` choisit le port. Le serveur refuse cette exposition ou `NODE_ENV=production` sans les deux clés. Pour un déploiement, prévoir un volume persistant pour SQLite et un reverse proxy HTTPS qui conserve l’en-tête Host. Définir `PLANIFIKATEUR_PUBLIC_ORIGIN=https://votre-domaine` pour marquer le cookie de session Secure. Aucun domaine ou hébergement public n’est créé par ces commandes. L’API n’active pas de CORS : l’interface et l’API doivent partager la même origine ; les agents serveur peuvent utiliser HTTPS directement.

Ce prototype possède un espace propriétaire unique. Les comptes individuels, permissions par projet et délégations d’agents restent des évolutions futures.

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

Les statuts sont `draft`, `ready`, `progress`, `clarify`, `review`, `done`. Une catégorie de liste et un statut sont indépendants.

```sh
# Développement local, sans clés configurées
curl 'http://127.0.0.1:3000/api/v1/projects'
curl 'http://127.0.0.1:3000/api/v1/projects/planifikateur/cards?status=ready&limit=20'
curl 'http://127.0.0.1:3000/api/v1/projects/planifikateur/cards/c1'

# Avec une clé agent déjà injectée dans le processus
curl --header "Authorization: Bearer $PLANIFIKATEUR_READ_TOKEN" \
  'https://votre-domaine/api/v1/projects/planifikateur/cards?status=ready'
```

Pour rechercher « Amélioration menu principal », commencer par `GET /api/v1/projects`, identifier le projet voulu puis utiliser son **id**, pas son nom, dans `GET /api/v1/projects/{projectId}/cards?q=Am%C3%A9lioration%20menu%20principal`. La recherche renvoie une liste uniquement dans ce projet. Si plusieurs cartes correspondent dans ce même projet, choisir l’id de la carte voulue puis consulter `GET /api/v1/projects/{projectId}/cards/{cardId}` ; ne pas sélectionner automatiquement le premier résultat. Les noms de projets et titres de cartes ne sont pas des identifiants uniques.

Cette modification impose le projet aux anciennes requêtes de cartes : les clients doivent ajouter `projectId` ou passer aux routes imbriquées. La clé agent conserve l’accès en lecture à tous les projets ; cette sélection explicite évite les confusions, sans introduire de permissions par projet. Les routes internes de l’interface (`workspace`) restent réservées à la session propriétaire.

Les réponses sont `{ "data": …, "meta": … }`. Une carte inclut `projectId`, `projectName`, `listId`, `listName`, `title`, `description`, `status`, `priority`, `tags`, `checklist` et `comments`. La pagination fournit `total`, `limit`, `offset` et `nextOffset` (null pour la dernière page). Toutes les réponses indiquent la `revision` du tableau : si elle change pendant un parcours paginé, recommencer la lecture pour obtenir une vue cohérente. Les données ne sont pas mises en cache.

```json
{
  "data": [],
  "meta": { "revision": 1, "total": 0, "limit": 50, "offset": 0, "nextOffset": null }
}
```

Les erreurs renvoient `{ "error": { "code": "…", "message": "…" } }`, avec 400 pour un paramètre invalide, 401 pour un accès non autorisé et 404 pour une ressource absente. Les modifications de cartes via la clé agent sont refusées.

La spécification **OpenAPI 3.1** est servie à `/openapi.json` et conservée dans `public/openapi.json`.

## Synchronisation de l’interface

Les routes `/api/v1/session` et `/api/v1/workspace` sont réservées à l’interface. GET session établit une session locale en développement ou indique qu’une connexion est requise. POST session reçoit `{ "token": "…" }` ; DELETE termine la session. GET workspace fournit projets et révision ; PUT enregistre un tableau validé, uniquement avec une session propriétaire, du JSON et l’en-tête `If-Match: "révision"`.

Une écriture périmée reçoit 409 et ne remplace jamais le tableau d’un autre navigateur. L’interface conserve alors les modifications en mémoire et permet de les exporter avant de recharger explicitement le serveur. Une sauvegarde réseau échouée peut être relancée. Les limites de contenu sont documentées dans `src/lib/workspace.js` ; une requête ne peut dépasser 4 Mo.

## Récupérer des projets locaux

Dans la nouvelle copie autonome, ouvrir le bouton d’information puis « Exporter les projets (JSON) ». Dans le site connecté, utiliser « Importer des projets ». L’import ajoute les projets avec de nouveaux identifiants sans remplacer ceux du serveur. Vérifier l’indication de sauvegarde avant de fermer la page.

Les anciennes copies HTML restent indépendantes : les projets de votre navigateur ne sont pas accessibles à l’agent tant qu’ils n’ont pas été importés sur le serveur. La nouvelle copie ne peut pas récupérer les données d’une ancienne copie si le navigateur isole le stockage par fichier.

## Actualisation et sauvegardes réservées au propriétaire

`GET /api/v1/workspace` accepte `If-None-Match: "révision"` et renvoie **304 sans corps** si la révision est inchangée. L’authentification propriétaire est vérifiée même pour cette réponse. Le site vérifie les changements toutes les 5 secondes et au retour sur l’onglet, sans envoyer de nouvelle écriture pour les données reçues. Les lectures sont suspendues pendant une fenêtre d’édition, un déplacement ou une sauvegarde ; une réponse arrivée pendant une saisie ou après une nouvelle sauvegarde est ignorée. Les conflits restent explicites et aucune fusion automatique n’est effectuée. Un problème réseau d’actualisation est affiché sans remplacer le tableau, puis réessayé automatiquement. La copie HTML hors ligne n’effectue aucune actualisation serveur.

Les routes suivantes nécessitent une **session propriétaire**, vérifient l’origine et refusent la clé agent :

| Route | Usage |
| --- | --- |
| `GET /api/v1/backups` | Copies disponibles, erreur éventuelle, intervalle et rétention |
| `POST /api/v1/backups` | Créer une copie, réponse 201 avec `data.name` |
| `GET /api/v1/backups/{filename}` | Télécharger une copie SQLite existante |

Les sauvegardes ne sont jamais servies comme fichiers publics. Une suppression de projet, liste ou carte est précédée d’une sauvegarde ; si elle échoue, l’écriture renvoie 503 (`backup_failed`) et laisse les données intactes. La restauration est une commande d’administration décrite dans [backups.md](backups.md), sans route publique de restauration.
