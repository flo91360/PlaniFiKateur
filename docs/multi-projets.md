# Améliorer les projets depuis PlaniFiKateur

Le même worker AWS peut traiter PlaniFiKateur, DefilOrdi, FunKart et TrameErgo, une tâche à
la fois. Le projet fournit le dépôt, le moteur IA, le modèle et le profil
d’exécution ; la carte fournit le titre, la description, les pièces jointes et
l’effort. Les secrets restent dans l’environnement privé du worker.

## Configuration depuis le site

Dans **Paramètres du projet** :

1. Associer le dépôt GitHub.
2. Choisir le moteur et le modèle IA.
3. Dans **Exécution et connexion du projet**, choisir le profil et la branche
   cible, puis enregistrer. Sans réglage explicite, les dépôts nommés DefilOrdi,
   FunKart et TrameErgo reçoivent automatiquement leur profil ; les autres utilisent le
   profil PlaniFiKateur.
4. Dans **Connexion de l’agent**, autoriser ce projet pour l’identité du worker.
5. Consulter le diagnostic du worker. Il vérifie les outils, la présence d’une
   authentification IA, l’accès au dépôt et à la branche, et le workflow des PR.
   Une authentification configurée ne garantit pas encore l’accès au modèle :
   cet accès est vérifié lors de l’exécution. La réception du webhook est
   confirmée à la première livraison. Un diagnostic devient périmé après cinq
   minutes ou un changement de configuration.

Ensuite, créer une carte avec une description et la mettre **Prête à démarrer**.
Les questions et réponses passent par les commentaires. Le worker effectue les
tests locaux, publie la branche et la PR, puis attend les contrôles du projet et
fusionne automatiquement. Le webhook signé termine la carte.

## Profils fournis

| Profil | Outils et vérifications locales | Workflow GitHub et contrôles exigés |
| --- | --- | --- |
| PlaniFiKateur | Node 24 ; `npm ci`, `npm test`, `npm run test:browser` | `ci.yml`, nom **Tests**, jobs **Tests serveur** et **Tests navigateur** |
| DefilOrdi | Node 22 ; `npm ci`, `npm run typecheck`, `npm test`, `npm run build` | `build-windows.yml`, nom **Windows .exe**, job **build** |
| FunKart | Godot 4.4.1 ; import, `tests/test_profiles.gd`, `tests/autoplay.gd -- --fast` | `build.yml`, nom **Construire le jeu**, job **export** |
| TrameErgo | Node 22 ; dans `tablette/` : `npm ci`, `npm test`, `npm run build` | `tablette.yml`, nom **Application tablette et Windows**, jobs **tablette** et **build** |
| AutoCorrectNEPSY | Python 3.10+ ; environnement virtuel `.planifikateur/venv`, `pip install -e ".[test]"`, `pytest -q` | `tests.yml`, nom **Tests et exécutable Windows**, jobs **Version**, **Tests Python 3.10 (Linux)**, **Tests Python 3.12 (Linux)**, **Tests Python 3.12 (Windows)** et **Exécutable Windows** |

TrameErgo est une application Vue 3 placée dans `tablette/`, publiée sur
GitHub Pages pour les tablettes et empaquetée par Tauri en `.exe` Windows. Le
worker Linux lance les tests Vitest et la construction web ; les parcours
Playwright (Chromium et WebKit) et l’installateur Windows sont les jobs
**tablette** et **build** du workflow, exigés avant la fusion. À chaque
livraison de code, le worker augmente la même version dans
`tablette/package.json`, son lockfile, `tablette/src-tauri/Cargo.toml` et
l’entrée du paquet dans `Cargo.lock`, comme le vérifie la CI du dépôt.

AutoCorrectNEPSY est un paquet Python (correction du subtest Copie de figures de
la NEPSY-II, interface Tkinter et exécutable Windows). Le worker crée un
environnement virtuel dans `.planifikateur/venv`, exclu de Git, y installe le
paquet en mode modifiable avec ses dépendances de test, puis lance `pytest`
(les tests de l’interface sont ignorés faute d’écran) ; le contrôle « Outils
du projet » exige Python 3.10 ou plus avec `venv` dans l’image. Comme pour
TrameErgo, le workflow du dépôt vérifie la version (job **Version**), rejoue
les tests sous Linux et Windows, construit `AutoCorrectNEPSY.exe` après les
tests et publie la Release `v<version>` à chaque nouvelle version sur `main` ;
tous ces jobs sont exigés avant la fusion. À chaque livraison, le worker
augmente la version de la table `[project]` de `pyproject.toml` et le
`__version__` de `autocorrect_nepsy/__init__.py`, et ajoute au changelog une
section `## [x.y.z] - date`. Le dépôt étant public, son `.gitignore`, qui
écarte scans et cotations d’enfants, est protégé, comme le contrôle de version
`packaging/verifier_version.py` et les fichiers qui pourraient reconfigurer
pytest à la racine.

Chaque profil est une entrée du registre `executionPresets` de
`worker/execution-profile.mjs`, installé avec le worker. Il déclare tout ce qui
lui est propre : outils, commandes et contrôles GitHub, mais aussi les dépôts qui
le choisissent par défaut (`repositories`), son fichier de version
(`versioning.format` : `npm` pour `package.json` et son lockfile, éventuellement
dans un sous-dossier `directory`, `godot` pour `project.godot`, `pyproject` pour
`pyproject.toml` et le `__version__` des modules de `modules` ; `cargo` pour le
paquet Rust à garder à la même version, `changelog` pour le format du titre, et
les documents dont le numéro suit la version), ses consignes au modèle
(`instructions`, par exemple l’emplacement de l’application pour TrameErgo), ses variables d’environnement, la
version minimale de Python exigée (`python`) et les
fichiers protégés (`protectedPaths`) : une carte ne peut pas les modifier, pas plus
que les workflows GitHub ou les scripts npm (voir [le worker](worker.md#isolation-du-code-exécuté)). Ajouter un
projet revient à ajouter une entrée : le reste du worker s’en déduit sans tester
les noms de profils.

## Changelog de chaque projet

À chaque livraison de code, quel que soit le profil, le worker ajoute lui-même
une section en tête du fichier `CHANGELOG.md` du dépôt (créé s’il manque), avant
les tests locaux et dans le même commit que la PR. Pour DefilOrdi, FunKart,
TrameErgo et AutoCorrectNEPSY, la section porte la nouvelle version préparée par le worker et sa
date (`## 1.4.2 — 2026-10-13`, ou `## [1.4.2] - 2026-10-13` pour TrameErgo et
AutoCorrectNEPSY, format attendu par leur CI) ; pour PlaniFiKateur, dont la version n’est pas
augmentée automatiquement, seulement la date. Elle reprend le titre de la carte
et le résumé de l’agent, ramenés à une ligne, avec un marqueur de l’exécution :
une nouvelle tentative ou une reprise sur `main` à jour remplace la section de
la même exécution au lieu d’en ajouter une. L’historique déjà présent est
conservé ; un `CHANGELOG.md` qui n’est pas un fichier ordinaire bloque la
livraison. Chaque version fusionnée sur GitHub contient ainsi l’ensemble des
modifications livrées depuis la mise en place du changelog.

Cette règle fait partie du code installé du worker : elle ne dépend pas des
workflows des dépôts et ne peut pas être modifiée par la branche livrée.

Le conteneur contient Node 22 et 24, Chromium, Python 3 avec `venv` et le
binaire officiel Godot 4.4.1 avec vérification SHA-512. La fabrication des
exécutables Windows de DefilOrdi, TrameErgo et AutoCorrectNEPSY et des exports
Windows/Linux de FunKart reste sur GitHub Actions. Le worker évite le
téléchargement du binaire Electron pendant ses vérifications locales.

Les workflows doivent se déclencher sur `pull_request` et vérifier le commit de
la PR (`github.event.pull_request.head.sha`). Les contrôles absents, ignorés,
annulés ou échoués empêchent la fusion. Les autres workflows du dépôt ne peuvent
pas remplacer le workflow et les jobs du profil. Les protections de branche
doivent autoriser la fusion sans approbation humaine après ces contrôles.

Le webhook de chaque dépôt doit envoyer **Pull requests** et **Workflow runs**
à `https://planifikateur-production.up.railway.app/api/v1/github/webhook` avec
le secret déjà configuré dans le site. Ajouter **Pushes** pour les cartes Info.
Les droits GitHub du worker doivent couvrir les dépôts concernés, les Actions,
le contenu, les issues et les PR. Le label de livraison manquant est créé par
le worker lors de la publication.

## Découverte et compatibilité

`PLANIFIKATEUR_WORKER_DISCOVERY=auto` est le défaut. Seuls l’URL du site, la clé
active d’agent, les accès GitHub et l’authentification IA sont nécessaires : les
listes de projets et dépôts ne sont plus à modifier sur AWS. Les anciennes
variables de listes sont ignorées dans ce mode. Le site reste responsable des
projets autorisés et GitHub reste responsable de l’accès aux dépôts.

Pour conserver un périmètre supplémentaire défini sur le worker, utiliser
`PLANIFIKATEUR_WORKER_DISCOVERY=manual` avec `PLANIFIKATEUR_WORKER_PROJECTS` et
`PLANIFIKATEUR_WORKER_REPOSITORIES`.

Le profil est mémorisé à la préparation de l’exécution ; moteur, modèle et effort
à la première prise en charge. Une modification ultérieure ne redirige pas une
tâche existante. Une conversation commencée peut reprendre avec son ancien
moteur même si le nouveau moteur du projet n’est pas encore configuré.
Les anciennes exécutions déjà prises en charge conservent les commandes du
worker précédent. Un ancien worker est refusé pour les nouveaux profils.

Hors Docker, fournir Node 22 dans `PLANIFIKATEUR_NODE22_BIN` et placer Godot 4.4.1
dans `PATH`. Le contrôleur continue de tourner avec Node 24.

## API

- Compte connecté : `GET /api/v1/projects/{id}/execution`.
- Administrateur : `PUT` sur cette route, par exemple
  `{ "preset": "defilordi", "branch": "main" }`.
- Compte connecté : `GET /api/v1/projects/{id}/worker-status`.
- Agent actif : `GET /api/v1/agent/projects`, limité aux projets autorisés,
  avec dépôt, profil, moteur, modèle et indicateur du secret de webhook.
- Agent actif autorisé sur le projet :
  `POST /api/v1/agent/projects/{id}/diagnostic`.

Le `PUT` n’accepte que `preset` et `branch` : tout autre champ, par exemple
`installCommands`, `testCommands` ou `workflow`, est refusé avec 400
(`invalid_execution_profile`). Les commandes et contrôles GitHub viennent
uniquement du profil installé avec le worker : ils ne proviennent jamais de
l’API, de la carte ni du code de la PR, et ne sont pas exécutés par un shell
implicite.

## Mise en service et vérification

Déployer le site puis laisser le programme de mise à jour AWS installer le
nouveau worker avec son volume et ses connexions conservés. Autoriser les trois
projets dans le site ; les droits GitHub et les webhooks se règlent une fois par
dépôt. Une première carte permet de vérifier le modèle réel, la publication,
les contrôles GitHub, la fusion et le retour du webhook.

Les tests automatisés du worker couvrent découverte, réservation, modification,
tests, commit, push, PR, fusion et notification pour les deux profils, avec des
modèles et réponses GitHub simulés et de vrais dépôts Git locaux. Ils ne
remplacent pas une exécution IA réelle sur le VPS avec ses comptes.
Les tests réels de DefilOrdi (TypeScript, 43 tests Vitest, compilation) et de
FunKart (profils et course automatique sous Godot 4.4.1) ont également été
exécutés lors de l’intégration.

Une carte terminée confirme la fusion du code. DefilOrdi publie ensuite ses
exécutables sur les Releases au push sur `main`. FunKart produit ses artifacts
au push et publie une Release lors d’un tag `v*` ou de son action de publication.
La création automatique de nouvelles versions FunKart depuis le site reste une
étape distincte de la fusion.
