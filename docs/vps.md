# Héberger le site sur le VPS AWS — v0.1.93

Depuis la v0.1.93, le site peut tourner sur le même VPS que le worker, ce qui évite l’abonnement
Railway. Trois conteneurs Docker y fonctionnent alors :

| Conteneur | Rôle |
| --- | --- |
| `planifikateur-site` | interface et API, base SQLite dans le volume `planifikateur-site-data` |
| `planifikateur-site-proxy` | Caddy : HTTPS (certificat Let’s Encrypt obtenu et renouvelé seul), seul conteneur joignable depuis Internet |
| `planifikateur-worker` | le worker IA, inchangé |

Le port du site n’est jamais publié sur la machine : seul Caddy l’atteint, par le réseau Docker
`planifikateur`. Les certificats sont gardés dans le volume `planifikateur-site-data-caddy`.
La configuration de Caddy est écrite par `deploy/site.py` ; quand elle change, le mandataire est
recréé une fois (coupure d’environ une seconde, certificats conservés).

## Mises à jour automatiques

Le service `planifikateur-site-update` (toutes les deux minutes) suit les mêmes règles que celui
du worker ([mises à jour du worker](worker-updates.md)) et partage son verrou :

1. seul un commit de `main` dont la CI (**Tests serveur** et **Tests navigateur**) a réussi est
   déployé ;
2. l’image est construite depuis le contenu exact de ce commit (`git archive`), pendant que le
   site actuel reste en ligne ;
3. l’ancien site s’arrête puis le nouveau démarre sur le même volume (SQLite n’accepte qu’un
   serveur à la fois). Pendant ces quelques secondes, Caddy garde les requêtes et réessaie la
   connexion jusqu’à 60 secondes au lieu de répondre une erreur 502 : une page ou une action
   lancée à ce moment attend un peu puis aboutit. Seules les connexions refusées sont
   réessayées, une requête déjà reçue par le site n’est jamais rejouée. Les mises à jour en
   direct du tableau se reconnectent seules ;
4. le nouveau site doit servir le commit attendu sur `/build-info.json` dans les deux minutes,
   sinon l’ancien est redémarré et cette révision n’est plus retentée (option `--retry` pour
   forcer) ; le conteneur précédent est gardé sous `planifikateur-site-previous` ;
5. le volume de données n’est jamais supprimé ni remplacé.

La vérification du déploiement après chaque tag (`tag-version.yml`) attend jusqu’à 25 minutes
que le site serve la nouvelle version.

## Bascule depuis Railway

Prévoir une demi-heure. Les étapes 1 à 3 se font sans coupure ; la bascule elle-même (étapes 4
à 6) interrompt le site quelques minutes.

### 1. Adresse fixe et ports (console AWS)

- **EC2 → Adresses IP Elastic** : associer une adresse IP Elastic à l’instance, pour que
  l’adresse ne change pas à chaque redémarrage.
- **Groupe de sécurité** de l’instance : autoriser en entrée **TCP 80** et **TCP 443** (et
  **UDP 443** pour HTTP/3) depuis `0.0.0.0/0` et `::/0`. Le port 80 sert à Let’s Encrypt et
  redirige vers HTTPS.

### 2. Nom de domaine

Avec un domaine à vous, créer un enregistrement **A** vers l’IP Elastic (par exemple
`planifikateur.mondomaine.fr`). Sans domaine, utiliser le service gratuit sslip.io : pour l’IP
`203.0.113.7`, le nom est `203-0-113-7.sslip.io`, sans configuration.

### 3. Fichier privé du site

Dans Railway, ouvrir le service du site → **Variables** → **Raw Editor** et copier les variables.
Sur le VPS, créer `/home/admin/planifikateur-site.env` avec ces variables, **sans guillemets**
autour des valeurs (Docker les garderait), en retirant `PORT`, `PLANIFIKATEUR_DB_PATH`,
`PLANIFIKATEUR_HOST` et les variables `RAILWAY_*`, puis ajouter le nom de domaine :

```sh
nano /home/admin/planifikateur-site.env
# PLANIFIKATEUR_DOMAIN=203-0-113-7.sslip.io
# PLANIFIKATEUR_OWNER_TOKEN=…
# PLANIFIKATEUR_READ_TOKEN=…
# PLANIFIKATEUR_BACKUP_TOKEN=…
# … (clés GitHub, webhook, IA : les mêmes que sur Railway)
chmod 600 /home/admin/planifikateur-site.env
```

### 4. Dernière copie des données de Railway

1. Arrêter le worker pour qu’il n’écrive plus sur Railway : `docker stop planifikateur-worker`.
2. Sur le site Railway, en administrateur : **Sauvegardes → Créer une sauvegarde**. Ne plus rien
   modifier sur Railway ensuite : ce qui serait écrit après cette copie serait perdu.
3. Sur le VPS, récupérer cette copie avec la copie quotidienne :

```sh
sudo systemctl start planifikateur-backup.service
sudo journalctl -u planifikateur-backup.service -n 5 --no-pager
```

### 5. Installation

```sh
cd /home/admin/PlaniFiKateur
git pull --ff-only
sudo bash deploy/install-site.sh
```

Le script vérifie la copie la plus récente de `/home/admin/planifikateur-backups`, la place dans
le volume (jamais par-dessus une base existante), construit et démarre le site, démarre Caddy
puis active les mises à jour automatiques. Pour une autre copie :
`sudo bash deploy/install-site.sh /chemin/copie.sqlite.gz`.

Ouvrir `https://<domaine>` : le premier chargement peut attendre quelques secondes le
certificat. Se connecter avec son compte habituel.

### 6. Raccorder le worker, la copie quotidienne et GitHub

- Dans `/home/admin/planifikateur-worker.env` et `/home/admin/planifikateur-backup.env`,
  remplacer `PLANIFIKATEUR_URL` par `https://<domaine>`, puis lancer
  `sudo systemctl start planifikateur-worker-update.service` : le worker arrêté est recréé avec
  ses nouvelles variables et redémarre (vérifier avec
  `sudo journalctl -u planifikateur-worker-update.service -n 20 --no-pager`).
- GitHub, dépôt → **Settings → Webhooks** : remplacer l’adresse du webhook par
  `https://<domaine>/api/v1/github/webhook`.
- GitHub, dépôt → **Settings → Secrets and variables → Actions → Variables** : créer
  `PLANIFIKATEUR_URL` = `https://<domaine>` pour la vérification des déploiements.

### 7. Repointer les logiciels sous licence

Le serveur des licences ([licences du logiciel d’un projet](api.md#licences-du-logiciel-dun-projet))
fait partie du site : il a suivi la base, avec sa clé privée, ses licences et ses postes. Les
logiciels déjà livrés n’ont donc besoin ni de nouvelle clé publique ni de nouvelle clé de licence.
En revanche, chaque logiciel contient l’**adresse** du serveur, qui est encore celle de Railway
(pour DefilOrdi : `SERVEUR_LICENCES` dans `src/main/licence-config.ts`).

Tant que ces logiciels interrogent Railway, ils voient l’ancienne base : une licence désactivée
ou prolongée sur le VPS ne change rien pour eux, et une licence créée sur le VPS est refusée à
l’activation comme clé inconnue. Il faut donc, juste après la bascule :

1. remplacer l’adresse Railway par `https://<domaine>` dans chaque logiciel sous licence, puis
   publier une nouvelle version ;
2. installer cette version sur chaque poste. Une version restée sur l’ancienne adresse continue
   de fonctionner hors ligne avec son jeton, puis s’arrête au plus tard 30 jours après son dernier
   renouvellement, une fois Railway arrêté : elle demande alors une clé qu’elle ne peut plus
   activer.

Avec un domaine à vous, l’adresse ne changera plus lors d’un prochain déménagement. Avec sslip.io,
elle dépend de l’IP Elastic : la garder associée à l’instance.

### 8. Arrêter Railway

Après une journée sans problème, et une fois les logiciels sous licence repointés (étape 7),
dans Railway : supprimer le service du site (ou au moins retirer son déploiement) pour ne plus
être facturé. Garder une copie téléchargée de la base au préalable.

À refaire sur chaque appareil : se reconnecter et, si besoin, réactiver **Notifications sur cet
appareil** (une nouvelle adresse est un nouveau site pour le navigateur) ; sur iPhone, ajouter
la nouvelle adresse à l’écran d’accueil.

## Sauvegardes après la bascule

Le site continue ses copies toutes les 6 heures dans le volume, et la copie quotidienne les
range dans `/home/admin/planifikateur-backups`. **Ces deux copies sont sur le même disque que
le site** : elles protègent contre une erreur ou une mise à jour ratée, pas contre la perte du
VPS. Activer les instantanés automatiques du volume EBS (AWS → **EC2 → Lifecycle Manager**,
une stratégie quotidienne gardant 7 instantanés), ou copier régulièrement
`/home/admin/planifikateur-backups` ailleurs.

## Dépannage

```sh
sudo journalctl -u planifikateur-site-update.service -n 50 --no-pager
docker logs --tail 100 planifikateur-site
docker logs --tail 100 planifikateur-site-proxy   # certificat, ports 80/443
```

Revenir à la version précédente à la main : `docker stop planifikateur-site`, puis
`docker rename planifikateur-site planifikateur-site-failed`,
`docker rename planifikateur-site-previous planifikateur-site` et
`docker start planifikateur-site`. Ne jamais supprimer le volume `planifikateur-site-data` ;
restaurer une copie avec `docker exec planifikateur-site npm run db:restore -- /data/backups/<copie>.sqlite --confirm`
(voir [sauvegardes](backups.md)).
