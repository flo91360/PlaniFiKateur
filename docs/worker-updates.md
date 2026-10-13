# Mises à jour automatiques du worker sur le VPS AWS

Le service systemd `planifikateur-worker-update` consulte GitHub toutes les cinq
minutes, avec un décalage aléatoire maximal de trente secondes. Aucun accès SSH
depuis GitHub ni secret GitHub Actions supplémentaire n’est requis.

## Installation sur le VPS existant

Cette installation correspond au serveur Debian utilisé dans ce projet :
utilisateur `admin`, dépôt `/home/admin/PlaniFiKateur`, fichier privé
`/home/admin/planifikateur-worker.env`, conteneur `planifikateur-worker` et volume
Docker `planifikateur-worker-data`. Le worker doit déjà être démarré et connecté
à Codex. Les variables de connexion existantes suffisent ; le token GitHub doit pouvoir
lire les Actions du dépôt `flo91360/PlaniFiKateur`.

Depuis le terminal SSH du VPS :

```sh
cd /home/admin/PlaniFiKateur
git pull --ff-only
sudo bash worker/deploy/install.sh
```

L’installateur ajoute les deux unités systemd et active le timer, y compris après
un redémarrage du VPS. Python 3 est installé s’il manque. Le service s’exécute
sous `admin`, avec le groupe Docker ; les clés restent dans le fichier privé et
ne sont jamais copiées dans le dépôt ou les unités systemd.

Vérifier le timer puis demander une première vérification immédiatement :

```sh
systemctl list-timers planifikateur-worker-update.timer
sudo systemctl start planifikateur-worker-update.service
sudo journalctl -u planifikateur-worker-update.service -n 50 --no-pager
```

Le premier déploiement peut reconstruire l’image même si le conteneur créé
manuellement utilisait déjà le code courant : il ajoute l’identifiant de révision
qui permettra de reconnaître les futures mises à jour.

## Conditions et déroulement

1. Un verrou empêche deux mises à jour de s’exécuter simultanément.
2. Le programme récupère `origin/main`. Un checkout modifié localement ou sur
   une autre branche bloque la mise à jour ; aucune modification n’est écrasée.
3. Il exige une exécution réussie du workflow `ci.yml` pour le **commit exact**,
   sur `main`, déclenchée par un push dans le dépôt attendu. Les deux jobs
   **Tests serveur** et **Tests navigateur** doivent avoir réussi, une seule
   fois chacun, dans la dernière tentative. Des tests annulés, manquants ou en
   cours ne suffisent pas. Les contrôles sont revérifiés après la construction.
4. Les changements hors `worker/` et `.dockerignore` ne reconstruisent pas
   l’image déjà identifiée. Les changements du programme de mise à jour dans
   `worker/deploy/` sont récupérés pour les prochaines vérifications.
5. Une tâche locale marquée `running` diffère le déploiement. La vérification
   est répétée avant le remplacement. Une tâche commencée dans l’intervalle
   restant peut être interrompue lors de l’arrêt : le worker reçoit SIGTERM et
   dispose de soixante secondes pour enregistrer l’interruption et permettre
   sa reprise.
6. La nouvelle image est construite pendant que l’ancienne tourne. Son sandbox
   est testé sans clés ni accès au volume de production, avec le profil seccomp
   du dépôt et `apparmor=unconfined`, la configuration validée sur ce VPS.
7. Le nouveau conteneur utilise le **même fichier de variables et le même
   volume**. L’ancien est arrêté puis conservé sous le nom
   `planifikateur-worker-previous`. Les deux workers ne tournent pas en même temps.
8. Le nouveau worker doit rester démarré, sans redémarrage Docker ni erreur de
   connexion signalée, et annoncer son démarrage. Cette vérification couvre
   le démarrage ; elle ne garantit pas l’absence de bugs fonctionnels ultérieurs.
9. Si le démarrage échoue, le nouveau conteneur est arrêté et le précédent est
   réactivé. Une interruption du programme au milieu du remplacement est
   également récupérée à la prochaine vérification.

Le volume contenant les tâches et la connexion Codex n’est jamais supprimé. Un
retour arrière de conteneur ne restaure pas une ancienne copie des données du
volume : les nouvelles versions doivent rester compatibles avec l’état persistant.

Après un déploiement confirmé, le programme libère l’espace disque : il supprime
les images `planifikateur-worker` qui ne sont ni celle du worker actif ni celle
du conteneur précédent (conservée pour le retour arrière), les couches sans tag
et tout le cache de construction Docker. La construction suivante repart donc de
zéro, ce qui la rend plus longue. Un déploiement échoué ne nettoie rien, et un
échec du nettoyage ne remet pas en cause la mise à jour : il sera retenté au
prochain déploiement. Les autres images, les conteneurs et les volumes ne sont
jamais supprimés ; aucun `docker system prune` n’est exécuté.

Avant chaque construction, les anciennes images inutilisées et le cache sont
aussi supprimés, puis le programme exige au moins 2,5 Go libres (option
`--min-free-gb`). Sinon il s’arrête avec « Espace disque insuffisant… » sans
toucher au worker actif ni rejeter la révision : la mise à jour reprend
automatiquement une fois l’espace libéré. Le paquet Chromium et les outils de
compilation demandent à eux seuls plus d’un gigaoctet pendant leur installation ;
un disque de 8 Go est juste, 16 Go ou plus est recommandé.

Dans le volume, le worker supprime le checkout d’une tâche dès qu’elle est
terminée (voir `docs/worker.md`). Pour contrôler l’espace occupé par les tâches
et le cache npm :

```sh
sudo du -sh /var/lib/docker/volumes/planifikateur-worker-data/_data/{jobs,npm-cache}
```

Lors de la première vérification avec ce programme, un worker déjà à jour est
nettoyé une fois. Pour libérer l’espace immédiatement :

```sh
sudo systemctl start planifikateur-worker-update.service
sudo journalctl -u planifikateur-worker-update.service -n 20 --no-pager
sudo docker system df
```

## En cas d’échec

Une révision qui échoue à la construction, au contrôle du sandbox ou au démarrage
est mémorisée dans
`/home/admin/.local/state/planifikateur-worker-update/deployment.json`. Elle n’est
pas reconstruite toutes les cinq minutes : un nouveau commit permet de reprendre.
Les refus réseau ou GitHub sont réessayés à la prochaine vérification. Le journal
ne publie ni tokens ni sorties brutes de commandes susceptibles d’en contenir.

Après avoir corrigé une cause externe, relancer explicitement la même révision :

```sh
sudo systemctl stop planifikateur-worker-update.timer
sudo systemctl stop planifikateur-worker-update.service
sudo -u admin -g docker python3 worker/deploy/update.py --retry
sudo systemctl start planifikateur-worker-update.timer
```

Une mise à jour ne réactive pas un worker arrêté volontairement. Pour suspendre
les mises à jour automatiques :

```sh
sudo systemctl disable --now planifikateur-worker-update.timer
```

Les modifications futures des fichiers `.service` et `.timer` nécessitent de
relancer l’installateur pour mettre à jour les unités installées. Le programme
Python et l’image du worker sont actualisés depuis le dépôt automatiquement.

## Vérification reproductible

```sh
python3 -m unittest discover -s tests/deploy -v
npm test
```

Les scénarios de déploiement simulent Docker et GitHub pour vérifier les échecs,
les tâches en cours, les contrôles CI et la récupération, sans utiliser de clés.
Ils sont inclus dans `npm test`. La publication du code ne prouve pas que le
timer a été installé sur le VPS ; les commandes de vérification ci-dessus
confirment cette dernière étape sur votre serveur.
