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
label est retiré puis remis après la nouvelle soumission. GitHub exécute les
contrôles ; le worker effectue la fusion squash après leur réussite et une
vérification de l’éligibilité auprès du site. Seul le webhook signé termine la
carte. Le worker réutilise ses clés existantes : aucun secret GitHub Actions
supplémentaire n’est nécessaire pour cette fusion.

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

L’identifiant du projet est visible dans **Paramètres du projet**, ainsi que
dans la réponse de l’API de consultation `GET /api/v1/projects`. Les noms affichés ne remplacent pas ces identifiants.
Pour GitHub, utiliser un token personnel ou d’application permettant de déclencher
les workflows sur les PR : un `GITHUB_TOKEN` d’un workflow GitHub ne déclenche
généralement pas d’autres workflows. Ne pas copier les clés du site dans les
variables du frontend. Le worker attend la dernière exécution des contrôles
sur le commit soumis : un ancien succès ne suffit pas pendant une nouvelle
exécution. Un refus de fusion est réessayé automatiquement sans appel à Codex ;
le motif apparaît dans les logs Docker. Les règles de branche restent appliquées.

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

La compatibilité du sandbox avec Railway doit être vérifiée sur le service réel.
Le profil `--security-opt seccomp=worker/seccomp.json` utilisé sur votre machine
est une option de lancement Docker ; il ne peut pas être appliqué par le
Dockerfile. La configuration du service ne modifie pas ce profil. Ne pas activer
le traitement des cartes avant d’avoir réussi le contrôle ci-dessous.

1. Dans le projet Railway du site, ajouter un service vide nommé **worker-codex**.
   Garder le service du site existant. Associer le même dépôt GitHub et la branche
   `main`, avec le contexte **Root Directory** à la racine du dépôt.
2. Dans **Variables**, ajouter **`RAILWAY_DOCKERFILE_PATH`** avec la valeur
   **`worker/Dockerfile`** pour sélectionner l’image du worker. Dans **Settings**,
   garder une seule réplique et une politique de redémarrage **On Failure**, avec
   au plus une relance pour cet essai. Supprimer une éventuelle commande de build
   personnalisée du site. Ne pas ajouter de domaine public ni de vérification
   HTTP. Vérifier dans les logs de construction que ce Dockerfile est utilisé.
   Le builder Metal de Railway n’accepte pas les montages Docker de type
   `secret` dans les instructions `RUN` : le Dockerfile du worker installe
   directement les dépendances avec `npm ci`, sans ce montage.

   **Config as Code est déprécié** : selon le message affiché par Railway,
   les services ne l’ayant jamais utilisé ne peuvent plus l’activer depuis le
   28 août 2026. Le fichier `worker/railway.toml` reste un exemple pour les
   services historiques uniquement ; les nouveaux services se configurent dans
   le tableau de bord. Ne pas utiliser **Add File Path** pour ce premier essai.
3. Attacher un volume à **`/data`**. Pour le premier essai, définir la commande
   **Start Command** suivante avant de fournir les clés du site ou de GitHub :

   ```sh
   sh -c 'node sandbox-check.mjs && sleep infinity'
   ```

   Déployer. Cette commande teste l’exécution des commandes et le refus d’une
   écriture en dehors du dépôt, sans consulter la file ni appeler le modèle.
   Le succès affiche **Sandbox Codex OK : commandes exécutables, écriture limitée
   au dépôt.** Le service reste démarré pour permettre la configuration.
4. Si le contrôle échoue, garder le service arrêté : Railway n’a pas encore
   démontré sa compatibilité avec l’isolation requise. Un déploiement construit
   avec succès ne suffit pas. Aucune carte n’a été prise en charge et aucun
   appel au modèle n’a été effectué par ce contrôle. Dans **Settings → Deploy**,
   régler **Restart Policy** sur **Never** pour éviter une boucle de démarrage.
   La ligne **Diagnostic** donne le code de sortie et l’erreur technique du
   contrôle, avec les clés connues masquées. Un refus de création de namespaces
   par bubblewrap requiert un réglage de l’hôte ; il ne se corrige pas en ajoutant
   une variable d’environnement ni une instruction dans le Dockerfile. Une autre
   option d’isolation de Codex (`use_legacy_landlock`) a aussi été essayée dans
   Docker : la version 0.162.1 exige toujours bubblewrap pour isoler les sockets
   de l’app-server, et cette option ne constitue donc pas une solution validée.
5. Si le contrôle réussit, renseigner les cinq variables obligatoires du tableau
   **Connexion**, puis l’authentification Codex. Une clé API se configure dans
   `OPENAI_API_KEY`. Pour utiliser une connexion ChatGPT, se connecter sur ce
   service via SSH Railway et lancer, dans `/opt/worker` :

   ```sh
   $(find /opt/worker/node_modules/@openai -type f -name codex -print -quit) login --device-auth
   ```

   Valider dans le navigateur. La connexion est conservée dans le volume
   `/data/codex` et reste soumise aux limites de l’offre et à une éventuelle
   reconnexion. Ne pas exporter l’authentification de l’environnement Codex cloud.
6. Arrêter le worker sur votre ordinateur, effacer la commande temporaire
   **Start Command**, puis redéployer. L’image utilise alors `node index.mjs`.
   Le worker vérifie de nouveau son isolation avant de consulter les cartes.
   Le message **Worker Codex démarré : une tâche à la fois.** confirme que le
   contrôle a réussi ; une carte de test prête permet de vérifier le parcours
   jusqu’à la fusion et au webhook.

Les push sur `main` pourront ensuite redéployer ce service si le déploiement
automatique GitHub est activé pour lui. Conserver le volume lors des mises à
jour ; il contient les copies de travail, l’état des tâches et la connexion
Codex. La construction, le login et une fusion réels sur Railway restent à
vérifier sur votre service.

Le worker exécute du développement et des navigateurs : l’offre gratuite du site
ne garantit pas les ressources nécessaires. Pour le premier essai, il peut aussi
tourner sur votre ordinateur tout en consultant le site Railway.

### Démarrage Docker sous Windows

Depuis la racine du dépôt, lancer le worker avec le profil seccomp fourni :

```powershell
docker build -f worker/Dockerfile -t planifikateur-worker .
docker run --rm --name planifikateur-worker --security-opt seccomp=worker/seccomp.json --env-file ..\planifikateur-worker.env --mount source=planifikateur-worker-data,target=/data planifikateur-worker
```

Codex utilise bubblewrap pour isoler les commandes. Le profil Docker par défaut
refuse la création des namespaces nécessaires. `worker/seccomp.json` reprend le
[profil par défaut de Moby](https://github.com/moby/profiles/blob/6fe7deb1b9fb7c0397a4593480d7d22b9ee8caef/seccomp/default.json)
(Apache 2.0, licence conservée dans `worker/seccomp.LICENSE`) et ajoute uniquement
les appels `unshare`, `clone`, `mount`, `umount2`, `pivot_root` et `setns` pour
cette isolation. Les capacités Docker restent inchangées et Codex conserve
`workspace-write` : les commandes peuvent modifier le dépôt, tandis que les
écritures en dehors du dépôt restent bloquées.

Le worker vérifie ces deux propriétés au démarrage, avant de réserver une carte.
En cas d’échec, il affiche une erreur de configuration puis s’arrête. Le même
contrôle peut être exécuté sans clé API ni connexion au site :

```powershell
docker run --rm --security-opt seccomp=worker/seccomp.json planifikateur-worker node sandbox-check.mjs
```

La configuration Codex doit être stockée dans le volume Linux `/data/codex`,
sans montage du dossier Windows `.codex`. Pour se connecter avec son compte
ChatGPT depuis ce volume :

```powershell
docker run --rm -it --security-opt seccomp=worker/seccomp.json --mount source=planifikateur-worker-data,target=/data planifikateur-worker sh
```

Dans le terminal Linux du conteneur, exécuter :

```sh
$(find /opt/worker/node_modules/@openai -type f -name codex -print -quit) login --device-auth
exit
```

Suivre l’adresse et le code de connexion affichés avant de quitter le terminal.
Si la carte est déjà « À préciser », publier ensuite un commentaire confirmant
que l’environnement est corrigé pour relancer la même exécution.

Si Docker affiche `exec /opt/worker/entrypoint.sh: no such file or directory`,
une ancienne image peut contenir un script avec des fins de ligne Windows.
Le Dockerfile normalise désormais les deux scripts exécutables au format Linux,
et `.gitattributes` impose ce format lors des prochains téléchargements Git.
Récupérer la correction puis reconstruire l’image depuis la racine du dépôt :

```powershell
git pull
docker build -f worker/Dockerfile -t planifikateur-worker .
```

Relancer ensuite la commande `docker run` avec le fichier de variables et les
mêmes montages de volumes et l’option `--security-opt` ci-dessus. Les données du
worker sont conservées.

## Essai réel

Créer une **nouvelle** petite carte de test, par exemple : « Dans le menu des
projets, afficher le numéro de version précédé du mot Version. Conserver le reste
du fonctionnement. » Passer cette carte au statut **Prête à démarrer**.
Le worker la détecte automatiquement ; aucun bouton de lancement n’est nécessaire. Le dépôt se configure une fois dans
**Paramètres du projet** et la livraison se fait toujours par fusion automatique. Lancer le worker et observer :

1. Le statut **En cours**, l’avancement et les questions dans la **Discussion**
   de la carte. Si elle est **À préciser**, publier un commentaire pour répondre
   et relancer la même exécution.
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

Si une carte a été supprimée ou déplacée hors de son projet, le worker archive
localement son ancienne exécution et continue à consulter les tâches disponibles.
Les fichiers de travail et la conversation sont conservés dans le volume.
Une erreur d’accès ou de réseau ne provoque pas cet archivage.
