# Worker Codex et Claude Code

Le worker est un service séparé du site. Il consulte les cartes prêtes en livraison
GitHub et traite **une seule tâche à la fois**, sans délégation. La description
constitue la demande ; aucun critère séparé n’est nécessaire.

Il réserve la carte, prépare une copie du dépôt et une branche
`planifikateur/<exécution>`, puis lance le SDK officiel `@openai/codex-sdk`.
La conversation Codex et le checkout sont conservés pour reprendre après une
question, un arrêt, des corrections ou des tests GitHub échoués. Le worker
renouvelle sa réservation toutes les 60 secondes. Une réservation perdue arrête
le travail ; une interruption se reprend avec une nouvelle réservation.
Une fois la tâche terminée (PR fusionnée ou fichier livré dans la carte), son
checkout `jobs/<exécution>` et ses dépendances sont supprimés du volume, y compris
pour les tâches terminées avant cette version. Les tâches en attente, en revue,
interrompues ou annulées conservent le leur.

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

Pour plusieurs dépôts, suivre [le guide des profils par projet](multi-projets.md).
Le worker découvre automatiquement les projets autorisés depuis le site.

Pour le VPS AWS déjà configuré, les [mises à jour automatiques](worker-updates.md)
se configurent avec un timer systemd : tests GitHub, construction, contrôle du
sandbox puis remplacement avec retour au conteneur précédent en cas d’échec.

1. Dans le site, associer le dépôt au projet et configurer la livraison GitHub
   selon [le guide GitHub](github.md). Créer une clé dans **Connexion de l’agent**,
   avec accès au projet concerné. La clé `PLANIFIKATEUR_READ_TOKEN` ne suffit pas.
2. Renseigner les variables suivantes dans les paramètres sécurisés du service,
   ou dans un fichier local privé hors du dépôt, jamais dans un commit ou le chat.

| Variable | Valeur / rôle |
| --- | --- |
| `PLANIFIKATEUR_URL` | `https://planifikateur-production.up.railway.app` |
| `PLANIFIKATEUR_AGENT_TOKEN` | Clé active créée dans le site |
| `PLANIFIKATEUR_GITHUB_TOKEN` | Token GitHub App ou token personnel dédié au dépôt, avec lecture Actions, écriture Contents, Issues et Pull requests, et écriture Workflows (portée `workflow` d’un token classique) pour les cartes qui modifient `.github/workflows/` |
| `OPENAI_API_KEY` | Authentification Codex par API ; consommation facturée à l’API |
| `PLANIFIKATEUR_WORKER_PROJECTS` | Facultatif : identifiants du périmètre supplémentaire en mode `manual` |
| `PLANIFIKATEUR_WORKER_REPOSITORIES` | Facultatif : dépôts autorisés en mode `manual` |
| `PLANIFIKATEUR_WORKER_STATE_DIR` | Répertoire persistant des copies et états, `/data` dans Docker |

L’identifiant du projet est visible dans **Paramètres du projet**, ainsi que
dans la réponse de l’API de consultation `GET /api/v1/projects`. Les noms affichés ne remplacent pas ces identifiants.
Sans la permission Workflows, GitHub refuse le push d’une branche qui crée ou
modifie un fichier de `.github/workflows/` (« refusing to allow a Personal Access
Token to create or update workflow … without `workflow` scope »). Le worker ne
réessaie pas : il pose une question sur la carte. Après avoir ajouté la
permission et redémarré le worker, répondre à la question relance la publication.
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
`PLANIFIKATEUR_WORKER_TIMEOUT_MS` (60 min), `PLANIFIKATEUR_WORKER_MAX_ATTEMPTS` (3).
Les délais par phase sont indépendants :
`PLANIFIKATEUR_WORKER_SETUP_TIMEOUT_MS` (15 min),
`PLANIFIKATEUR_WORKER_MODEL_TIMEOUT_MS` (30 min),
`PLANIFIKATEUR_WORKER_TESTS_TIMEOUT_MS` (30 min pour toutes les vérifications locales),
`PLANIFIKATEUR_WORKER_PUBLICATION_TIMEOUT_MS` (10 min).
Chaque valeur est en millisecondes, entre 1 s et 2 h ; le plafond global reste
applicable à l’ensemble de la prise en charge. Une ancienne variable globale à
20 min conserve sa valeur : la supprimer ou l’augmenter pour bénéficier du nouveau
plafond. Le panneau **Exécution IA** distingue un délai dépassé, un arrêt du worker et une
réservation perdue. Un délai dépassé entraîne une reprise automatique, sans demande
de validation humaine.

Le résultat IA et les tests réussis sont sauvegardés dans le volume du worker.
Après une interruption des tests ou de la publication, la reprise évite un nouvel
appel au modèle et ne relance que les vérifications restantes. Le contenu complet
du dépôt, les fichiers générés, la demande, les réponses, les soumissions et la
branche cible sont contrôlés avant de réutiliser ce résultat. Toute modification
invalide cette reprise ; un test échoué est renvoyé au modèle pour correction.
Une interruption pendant le travail IA reprend la conversation, sans présumer que
le modèle a terminé. Conserver le volume reste nécessaire.

Les commandes configurées côté service utilisent des tableaux JSON, sans shell :

```json
[["npm", "test"], ["npm", "run", "test:browser"]]
```

Ce sont les valeurs par défaut de `PLANIFIKATEUR_WORKER_TEST_COMMANDS`.
`PLANIFIKATEUR_WORKER_INSTALL_COMMANDS` vaut `[["npm", "ci"]]` par défaut.
Les commandes sont choisies par le propriétaire du service, jamais par une carte.
Pour un projet, seuls le preset et la branche viennent du site : depuis la
v0.1.32, le worker recalcule les commandes d’installation et de test et le
workflow GitHub à partir des presets installés avec lui (`execution-profile.mjs`).
Un profil enregistré par une version précédente, ou un site compromis, ne peut
donc pas lui faire exécuter d’autre commande, et une mise à jour du worker
s’applique aussi aux tâches en cours.

Une erreur propre à une tâche (dépôt renommé, PR inaccessible) ou à un projet
n’arrête plus le worker : elle est journalisée une fois, la tâche est réessayée
avec un délai croissant (1 à 30 minutes) et les autres cartes continuent d’être
servies. Les erreurs du site lui-même (clé refusée, réseau coupé) suspendent le
tour, puisqu’elles touchent toutes les tâches. Les checkouts des exécutions
annulées sont supprimés comme ceux des exécutions terminées.
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
5. Si le contrôle réussit, renseigner les variables de connexion obligatoires du tableau
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
   Le message **Worker IA démarré : une tâche à la fois.** confirme que le
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
docker run --rm --name planifikateur-worker --security-opt seccomp=worker/seccomp.json --security-opt systempaths=unconfined --env-file ..\planifikateur-worker.env --mount source=planifikateur-worker-data,target=/data planifikateur-worker
```

Codex utilise bubblewrap pour isoler les commandes. Le profil Docker par défaut
refuse la création des namespaces nécessaires. `worker/seccomp.json` reprend le
[profil par défaut de Moby](https://github.com/moby/profiles/blob/6fe7deb1b9fb7c0397a4593480d7d22b9ee8caef/seccomp/default.json)
(Apache 2.0, licence conservée dans `worker/seccomp.LICENSE`) et ajoute uniquement
les appels `unshare`, `clone`, `mount`, `umount2`, `pivot_root` et `setns` pour
cette isolation. Les capacités Docker restent inchangées et Codex conserve
`workspace-write` : les commandes peuvent modifier le dépôt, tandis que les
écritures en dehors du dépôt restent bloquées.

Claude Code isole aussi chaque commande de l’agent avec bubblewrap, dans de
nouveaux espaces de noms utilisateur et PID avec un `/proc` neuf. Docker masque
par défaut plusieurs chemins de `/proc` (`/proc/kcore`, `/proc/keys`…), et le
noyau refuse alors ce montage : toute commande échoue avec
`bwrap: Can't mount proc on /newroot/proc: Operation not permitted`.
L’option `--security-opt systempaths=unconfined` retire ce masquage ; le `/proc`
vu par l’agent reste celui de son propre espace PID, sans les processus du
worker ni leurs variables d’environnement. Le service de mise à jour automatique
(`worker/deploy/update.py`) ajoute cette option et recrée, avec la même image,
un conteneur lancé sans elle dès qu’aucune tâche n’est en cours.

Le worker vérifie ces deux propriétés au démarrage, avant de réserver une carte.
En cas d’échec, il affiche une erreur de configuration puis s’arrête. Il contrôle
ensuite le sandbox Claude Code : en cas d’échec, il affiche seulement un
avertissement, car l’agent peut encore modifier les fichiers et le worker lance
lui-même les tests. Le même contrôle peut être exécuté sans clé API ni
connexion au site :

```powershell
docker run --rm --security-opt seccomp=worker/seccomp.json --security-opt systempaths=unconfined planifikateur-worker node sandbox-check.mjs
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

1. Le statut **En cours** et l’avancement dans le panneau **Exécution IA**, les
   questions dans la **Discussion** de la carte. Si elle est **À préciser**,
   publier un commentaire pour répondre et relancer la même exécution.
2. Le commit et la PR liés à cette exécution, après tests locaux réussis.
3. Les deux contrôles GitHub réussis sur ce commit, puis sa fusion automatique.
4. La carte terminée après la livraison du webhook signé.

Le premier passage complet à travers GitHub exige les accès externes réellement
configurés. Les tests locaux ne remplacent pas cet essai.

## Moteur et modèle du projet, effort de chaque carte

Dans **Paramètres du projet → Moteur et modèle IA**, l’administrateur choisit
**Codex** ou **Claude Code** puis un modèle dans la liste correspondant au moteur.
**Par défaut** utilise le défaut du moteur ; pour Codex,
`PLANIFIKATEUR_CODEX_MODEL` reste le défaut du worker lorsqu’il est renseigné.
Le catalogue de l’interface suit les modèles publics de Codex 0.162.1 et de
Claude Code 2.1.296 ; l’accès effectif dépend du compte du worker. Il se maintient
dans `src/lib/ai-models.js` lors des mises à jour des moteurs, sans interroger les
comptes fournisseurs depuis le site. Un ancien identifiant hors catalogue reste
visible comme **modèle enregistré** et n’est pas remplacé silencieusement.
L’**Effort IA** est choisi à la création ou dans le détail de chaque carte.
Les niveaux proposés dépendent du moteur ; leur disponibilité effective dépend
aussi du modèle. **Par défaut** n’impose aucun niveau au fournisseur.

Le serveur conserve ces choix à la première prise en charge. Ils restent les
mêmes après une question, une interruption ou une correction. Modifier les
paramètres du projet affecte les prochaines exécutions ; les anciennes
conversations Codex continuent avec Codex. Le worker conserve aussi le modèle
résolu lorsqu’il est disponible : nom annoncé à l’initialisation par Claude Code,
ou métadonnées de session pour Codex. Le panneau **Exécution IA** du détail de la
carte affiche les réglages de l’exécution. Si le moteur ne rapporte pas de nom, le
modèle reste indiqué **par défaut**, sans inventer un identifiant.

Claude Code utilise `@anthropic-ai/claude-agent-sdk`, livré dans l’image du worker,
avec un sandbox obligatoire, sans commandes hors sandbox ni délégation à des
sous-agents. Ses questions `AskUserQuestion` sont relayées dans la discussion de
la carte, et sa session est reprise après réponse. Les livraisons de fichiers,
tests et PR passent par le même mécanisme que pour Codex.

Configurer **une seule** méthode d’authentification Anthropic dans le fichier
privé `planifikateur-worker.env` : `ANTHROPIC_API_KEY` ou
`CLAUDE_CODE_OAUTH_TOKEN` obtenu via votre installation officielle Claude Code.
Ne pas placer ces clés dans les paramètres du projet, les cartes ou Git.
Les crédits et autorisations Anthropic sont indépendants de ceux d’OpenAI.
Si le conteneur est déjà démarré, modifier le fichier ne modifie pas son
environnement : une nouvelle création du conteneur avec `--env-file` est
nécessaire, en conservant le volume `/data`. La prochaine livraison automatique
d’une nouvelle image chargera aussi ce fichier. Un simple `docker restart` ne
charge pas les nouvelles variables.

Les paramètres sont consultables par les comptes via
`GET /api/v1/projects/{projet}/ai` et modifiables par un administrateur via `PUT`
avec `{ "engine": "codex", "model": "identifiant-ou-chaîne-vide" }`.
Le champ des cartes est `aiEffort` (chaîne vide ou absent pour le défaut).
Un ancien worker ne peut pas prendre une carte avec un moteur, modèle explicite
ou effort qu’il ignorerait : le serveur exige le nouveau protocole de prise en
charge. Les essais automatisés des deux moteurs simulent les appels aux modèles ;
un premier essai réel Claude Code nécessite votre authentification Anthropic.

## Questions et fichiers générés

Le modèle publie ses questions dans la discussion de la carte et s’arrête avec
le statut **À préciser**. Une réponse dans cette discussion remet la tâche dans
la file. Le worker conserve l’identifiant de conversation Codex et transmet les
questions et réponses au tour suivant ; il ne crée pas une nouvelle conversation.
Les questions finales des anciennes conversations, même hors JSON, sont relayées
si elles sont clairement formulées comme une question. Les messages de réflexion
intermédiaires ne déclenchent pas une demande de précision.

Pour demander un fichier, décrire son format et le contenu attendu dans la carte,
par exemple : **« Génère un fichier Qt Designer `personne.ui` avec les champs
nom, prénom, adresse e-mail et un bouton Valider. »** Le modèle crée le fichier
dans `.planifikateur/generated/` et fournit son chemin dans le champ `files` de
son résultat. Le worker lit les fichiers explicitement déclarés, vérifie leur
présence et leur taille, puis les ajoute aux pièces jointes de la carte. Un fichier
Qt `.ui` est contrôlé comme XML avec une structure Qt Designer 4.0 ; ce contrôle
ne remplace pas un essai d’ouverture avec votre version de Qt Designer.

Une livraison composée uniquement de fichiers termine directement la carte ;
leurs noms figurent dans le panneau **Exécution IA**. Les tests du dépôt et une PR ne sont pas
nécessaires pour cette livraison. Si le modèle modifie aussi le dépôt, les tests
obligatoires, la PR et la fusion automatique restent nécessaires ; les fichiers
sont joints lors de la soumission. Les pièces jointes générées sont attribuées à
l’agent dans l’historique et enregistrées dans SQLite. Les limites existantes
restent applicables : dix fichiers par carte, 1 Mo par fichier et 2 Mo au total
dans les projets. Les chemins hors du dépôt, liens symboliques et fichiers internes
de Git ou de connexion ne peuvent pas être déclarés comme livrables.

## Vérification reproductible locale

Le worker exécute les tests navigateur avec un seul processus Playwright à la
fois (`PLANIFIKATEUR_WORKER=1`). Les mêmes tests desktop et mobile sont conservés ;
leur exécution prend plus de temps mais utilise moins de mémoire. Un VPS avec
1 Gio de RAM reste limité pour Codex, npm et Chromium : prévoir de préférence
au moins 2 Gio de RAM, et du swap pour absorber les pointes. Le swap réduit le
risque d’arrêt par manque de mémoire, mais ne remplace pas la RAM et peut ralentir
les tests. Ce réglage s’applique au prochain lancement des tests depuis le dépôt
mis à jour ; il ne change pas les processus Chromium déjà démarrés.

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

Une prolongation de réservation échouée temporairement (réseau, délai dépassé,
HTTP 429 ou 5xx) est réessayée tant que la dernière réservation confirmée reste
valide. Sans confirmation avant son expiration, les commandes sont interrompues ;
un refus définitif (par exemple HTTP 401 ou réservation invalide) les interrompt
immédiatement. Ces interruptions ne consomment pas les tentatives de travail du
modèle. Le journal affiche un code de diagnostic, sans clés ni corps de réponse.
Si une ancienne version a déjà placé la carte **À préciser**, répondre dans sa
discussion après la mise à jour permet de reprendre la même exécution.

Après un push, le worker relit la PR pour confirmer le commit exact testé, avec
des tentatives espacées si GitHub renvoie encore l’ancien commit. Une publication
non encore synchronisée interrompt temporairement la tâche et provoque une
reprise automatique ; elle ne consomme pas les tentatives de correction du
modèle. Une soumission réussie remet ce compteur à zéro, y compris avant une
nouvelle résolution de conflit avec `main`.

L’agent ne lance aucune commande Git. Quand l’intégration de `main` produit des
conflits, le worker reprend `CHANGELOG.md` de `main` (il y réécrit ensuite la
section de l’exécution), puis demande à l’agent de corriger les autres fichiers
en conflit directement. Après le passage de l’agent, ou au tour suivant si la
fusion est restée en cours, le worker indexe les fichiers sans marqueur de
conflit et valide lui-même la fusion, intègre le `main` à jour, prépare de
nouveau la version et relance les tests. Le travail non validé d’un tour
précédent est conservé dans un commit avant chaque intégration. Un checkout
bloqué dans une opération que le worker ne reprend pas (rebase, cherry-pick…),
illisible ou sur une autre branche est supprimé puis recréé depuis la branche
publiée sur GitHub.

Pour les tâches bloquées par l’ancienne erreur **« La PR ne pointe pas sur le
commit testé. »**, l’agent initial peut reprendre automatiquement la publication
dans la même PR, même si cette erreur technique avait été présentée comme une
question. Les véritables demandes de précision nécessitent toujours une réponse
humaine. Aucun commit différent de celui testé n’est accepté par ce mécanisme.
