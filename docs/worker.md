# Worker Codex — v0.1.14

Le worker est un service séparé du site. Il consulte les cartes prêtes en livraison
GitHub et traite **une seule tâche à la fois**, sans délégation. La description
constitue la demande ; aucun critère séparé n’est nécessaire.

Il réserve la carte, prépare une copie du dépôt et une branche
`planifikateur/<exécution>`, puis lance le SDK officiel `@openai/codex-sdk`.
La conversation Codex et le checkout sont conservés pour reprendre après une
question, un arrêt, des corrections ou des tests GitHub échoués. Le worker
renouvelle sa réservation toutes les 60 secondes. Une réservation perdue arrête
le travail ; une interruption se reprend avec une nouvelle réservation.

Le worker exécute lui-même les tests. En cas d’échec, il renvoie leur sortie à
Codex pour correction, avec au plus trois tours locaux. Il crée le commit et
pousse uniquement sa branche, sans force. Une PR est liée au commit testé sur le
site **avant** de recevoir le label `planifikateur-agent`. Cet ordre déclenche un
nouveau contrôle GitHub après l’enregistrement de la soumission. En reprise, le
label est retiré puis remis après la nouvelle soumission. GitHub reste responsable
des contrôles et de la fusion ; seul le webhook signé termine la carte.

Si `main` avance pendant l’attente, le worker reprend la PR avec `revise`, intègre
`main`, relance Codex et les tests et soumet le nouveau commit. Une PR fermée sans
fusion provoque une question. Trois tentatives sans intervention humaine
provoquent aussi une question, afin d’éviter une boucle de dépenses. Une réponse
humaine autorise un nouveau cycle de tentatives.

## Connexion

1. Dans le site, associer le dépôt au projet et configurer la livraison GitHub
   selon [le guide GitHub](github.md). Créer une clé dans **Connexion de l’agent**,
   avec accès au projet concerné. La clé `PLANIFIKATEUR_READ_TOKEN` ne suffit pas.
2. Renseigner les variables suivantes dans les paramètres sécurisés du service,
   ou dans un fichier local privé hors du dépôt, jamais dans un commit ou le chat.

| Variable | Valeur / rôle |
| --- | --- |
| `PLANIFIKATEUR_URL` | `https://planifikateur-production.up.railway.app` |
| `PLANIFIKATEUR_AGENT_TOKEN` | Clé active créée dans le site |
| `PLANIFIKATEUR_GITHUB_TOKEN` | Token GitHub App ou token personnel dédié au dépôt, avec lecture Actions, écriture Contents, Issues et Pull requests |
| `OPENAI_API_KEY` | Authentification Codex par API ; consommation facturée à l’API |
| `PLANIFIKATEUR_WORKER_PROJECTS` | Identifiant du projet, ou identifiants séparés par des virgules |
| `PLANIFIKATEUR_WORKER_REPOSITORIES` | Dépôts explicitement autorisés, par exemple `flo91360/PlaniFiKateur` |
| `PLANIFIKATEUR_WORKER_STATE_DIR` | Répertoire persistant des copies et états, `/data` dans Docker |

L’identifiant du projet est visible dans la réponse de l’API de consultation
`GET /api/v1/projects`. Les noms affichés ne remplacent pas ces identifiants.
Pour GitHub, utiliser un token personnel ou d’application permettant de déclencher
les workflows sur les PR : un `GITHUB_TOKEN` d’un workflow GitHub ne déclenche
généralement pas d’autres workflows. Ne pas copier les clés du site dans les
variables du frontend. L’action de fusion a également besoin de ses propres
secrets `PLANIFIKATEUR_URL` et `PLANIFIKATEUR_AGENT_TOKEN` côté GitHub.

Une connexion Codex existante peut remplacer la clé API : effectuer `codex login`
sur la machine du worker et conserver son `CODEX_HOME`. Ne pas copier l’authentification
de cet environnement cloud vers Railway. La disponibilité et les limites de cette
connexion dépendent du compte et de son offre. La configuration serveur par clé
API est la plus simple pour un worker hébergé.

## Démarrer sur une machine

Node.js 24, Git et Chromium sont requis pour PlaniFiKateur. Pour un autre dépôt,
installer aussi les outils dont ses tests ont besoin.

```sh
npm ci --prefix worker
npm run worker:once
```

`worker:once` cherche une carte et traite au plus une exécution, sans attendre la
fusion distante. Il peut aussi remettre le label d’une soumission interrompue.
La carte reste en attente des tests GitHub jusqu’au webhook de fusion.

```sh
npm run worker
```

Cette commande maintient la boucle de consultation. SIGINT/SIGTERM arrête le
travail et signale une interruption si le site est accessible ; sinon la
réservation expire. Le redémarrage reprend depuis la file du site. Conserver
`PLANIFIKATEUR_WORKER_STATE_DIR` et `CODEX_HOME`, et utiliser une seule instance par
volume. Les jetons d’accès et de réservation ne sont pas stockés dans l’état des
tâches. Les tests et Codex reçoivent un environnement filtré sans clés GitHub/site.
Les copies sont distinctes par tâche, mais ce service reste destiné à vos dépôts
de confiance : il exécute leur code et n’isole pas des utilisateurs hostiles.

Paramètres facultatifs : `PLANIFIKATEUR_CODEX_MODEL`, `PLANIFIKATEUR_WORKER_POLL_MS`
(10 s), `PLANIFIKATEUR_WORKER_HEARTBEAT_MS` (60 s),
`PLANIFIKATEUR_WORKER_TIMEOUT_MS` (20 min), `PLANIFIKATEUR_WORKER_MAX_ATTEMPTS` (3).
Les commandes configurées côté service utilisent des tableaux JSON, sans shell :

```json
[["npm", "test"], ["npm", "run", "test:browser"]]
```

Ce sont les valeurs par défaut de `PLANIFIKATEUR_WORKER_TEST_COMMANDS`.
`PLANIFIKATEUR_WORKER_INSTALL_COMMANDS` vaut `[["npm", "ci"]]` par défaut.
Les commandes sont choisies par le propriétaire du service, jamais par une carte.
Les sorties en erreur sont limitées et les clés connues sont masquées avant
publication sur la carte. Le worker vérifie la branche et l’origine avant le push.

## Service Railway séparé

Ajouter un deuxième service depuis le même dépôt GitHub. Garder le site existant.
Configurer le contexte de build à la racine et le Dockerfile **`worker/Dockerfile`**
(`RAILWAY_DOCKERFILE_PATH=worker/Dockerfile`). Utiliser la commande de l’image,
sans commande de démarrage du site ni domaine public ni vérification HTTP.
Attacher un volume à **`/data`** et renseigner les variables ci-dessus.
Garder une seule réplique. L’image contient Node 24, Git et Chromium ; le service
installe les dépendances du dépôt cloné à chaque reprise avant de lancer Codex.

Le worker exécute du développement et des navigateurs : l’offre gratuite du site
ne garantit pas les ressources nécessaires. Pour le premier essai, il peut aussi
tourner sur votre ordinateur tout en consultant le site Railway.

## Essai réel

Créer une **nouvelle** petite carte de test, par exemple : « Dans le menu des
projets, afficher le numéro de version précédé du mot Version. Conserver le reste
du fonctionnement. » Choisir **Livraison → PR GitHub · fusion automatique**, puis
**Prête pour un agent**. Lancer le worker et observer :

1. La prise en charge et l’avancement dans la carte.
2. Le commit et la PR liés à cette exécution, après tests locaux réussis.
3. Les deux contrôles GitHub réussis sur ce commit, puis sa fusion automatique.
4. La carte terminée après la livraison du webhook signé.

Le premier passage complet à travers GitHub exige les accès externes réellement
configurés. Les tests locaux ne remplacent pas cet essai.

## Vérification reproductible locale

```sh
node --test tests/worker.test.js
```

Ce test utilise la vraie API HTTP, SQLite, un dépôt Git temporaire, un fichier
modifié, des commandes de test réelles et le vrai traitement du webhook signé.
**Codex et GitHub sont simulés** : aucune consommation de modèle, PR ou fusion
GitHub réelle. Il vérifie aussi la concurrence, les questions, l’arrêt/reprise,
les tests échoués, la récupération du label, une avancée de `main` et la reprise
de conversation du SDK. Les parcours du site restent couverts par
`npm run test:browser`.
