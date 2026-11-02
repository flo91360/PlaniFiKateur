# Sauvegardes et restauration

À partir de la v0.1.6, le serveur crée une sauvegarde au démarrage (omise depuis la v0.1.82 si la dernière copie régulière contient déjà l’état exact de la base, ce qui évite une copie complète à chaque réveil d’un service mis en veille), puis toutes les **6 heures lorsque les projets, les comptes ou leur historique ont changé**. Il crée aussi une copie avant une suppression de projet, de liste ou de carte, une fois les droits vérifiés et seulement si un élément est réellement retiré : une demande refusée ou sans effet ne déclenche aucune copie. Une suppression n’est pas enregistrée si cette copie de sécurité échoue. La copie est omise lorsque la dernière sauvegarde du serveur, de moins de 24 heures, contient déjà l’état exact des éléments retirés : aucune action de l’historique ne les a modifiés depuis (champs, commentaires, pièces jointes, exécution, restauration). Supprimer une à une des cartes restées inchangées ne copie donc pas toute la base à chaque fois.

Les copies utilisent `VACUUM INTO` : chaque fichier SQLite est autonome et inclut les modifications validées, même si elles étaient dans le journal WAL. Les copies sont vérifiées avant publication ; un fichier partiel n’est jamais proposé au téléchargement. Les **5 dernières copies** de chaque sorte sont conservées (28 jusqu’à la v0.1.82) : d’un côté les copies régulières (démarrage, intervalle, manuelles), de l’autre les copies d’avant suppression, nommées `…-suppression.sqlite`. Depuis la v0.1.31, des suppressions répétées ne remplacent donc plus les copies régulières ; avec 5 copies toutes les 6 heures, l’historique couvre au plus un peu plus d’un jour, moins si vous redéployez souvent ; augmentez `PLANIFIKATEUR_BACKUP_KEEP` pour remonter plus loin.

## Passage au stockage en tables (v0.1.25)

Jusqu’à la v0.1.24, tout le tableau était un seul document JSON. À partir de la v0.1.25, projets, listes, cartes, commentaires et pièces jointes sont rangés dans des tables SQLite séparées. La conversion a lieu **une seule fois**, au premier démarrage de la nouvelle version :

1. le serveur copie d’abord la base telle quelle dans le répertoire des sauvegardes, sous le nom `planifikateur-avant-tables-<date>.sqlite` ;
2. il convertit le tableau, relit les tables et vérifie que le résultat est identique au document d’origine ;
3. il valide la conversion en une seule transaction. Au moindre écart, rien n’est modifié et le démarrage échoue avec un message explicite.

Cette copie n’est pas comptée dans les sauvegardes tournantes et n’est jamais supprimée automatiquement. Pour revenir à une version antérieure à la v0.1.25, restaurer cette copie (voir ci-dessous) **avant** de redémarrer l’ancienne version : une ancienne version ne lit pas les tables. Les sauvegardes des deux formats se restaurent avec la version actuelle.

## Railway

Avec `PLANIFIKATEUR_DB_PATH=/data/planifikateur.sqlite` et le volume monté à `/data`, les copies vont automatiquement dans **`/data/backups`**, sur le même volume. Aucun service supplémentaire ni clé supplémentaire n’est nécessaire.

Paramètres facultatifs dans les variables du service :

| Variable | Défaut | Valeurs |
| --- | --- | --- |
| `PLANIFIKATEUR_BACKUP_DIR` | `backups` à côté de la base | Répertoire sur un volume persistant, hors du répertoire web `dist` |
| `PLANIFIKATEUR_BACKUP_INTERVAL_HOURS` | `6` | 1 à 168 heures |
| `PLANIFIKATEUR_BACKUP_KEEP` | `5` | 1 à 100 fichiers de chaque sorte |

La base elle-même est limitée par une **rétention** appliquée au démarrage puis chaque jour :

| Variable | Défaut | Effet |
| --- | --- | --- |
| `PLANIFIKATEUR_ACTIVITY_RETENTION_DAYS` | `365` | Supprime les entrées d’historique plus anciennes ; `0` conserve tout |
| `PLANIFIKATEUR_EXECUTION_RETENTION_DAYS` | `365` | Supprime les exécutions IA terminées ou annulées sans activité depuis ce délai ; `0` conserve tout |

Les cartes, leurs commentaires et leurs pièces jointes ne sont jamais purgés, ni les exécutions en cours. Une exécution terminée ne garde que le nom, le type et la taille des pièces jointes de sa copie de carte ; le contenu reste dans la carte. Les sauvegardes déjà faites conservent l’historique complet de leur date.

Le volume doit pouvoir contenir la base et ses copies. Vous pouvez réduire le nombre de copies si l’espace est limité. Utiliser une seule instance du serveur.

## Conserver une copie en dehors de Railway

Dans le site connecté, l’administrateur ouvre **Mon compte** (barre supérieure) puis la section **Sauvegardes**, sous la gestion des membres. C’est le seul accès aux sauvegardes serveur : la vue d’ensemble, la fenêtre d’information et l’historique des projets ne les proposent pas. « Créer et télécharger une sauvegarde SQLite » capture les données déjà enregistrées sur le serveur. Attendre « Sauvegardé sur le serveur » avant cette opération. Les anciennes copies sont également téléchargeables ; leurs dates sont affichées dans votre fuseau horaire.

La consultation et le téléchargement des sauvegardes exigent la session administrateur, ou la clé de la copie quotidienne décrite ci-dessous. La clé de lecture agent ne donne pas accès aux sauvegardes, qui contiennent tous les projets.

**Les copies sur le même volume ne protègent pas contre la perte ou la suppression de ce volume.** Installer la copie quotidienne sur le VPS AWS, ou à défaut télécharger régulièrement une copie et la conserver dans un emplacement privé distinct. Le fichier contient les projets, cartes, commentaires, comptes, empreintes de mots de passe, invitations, sessions et historique. Il ne contient pas les clés d’environnement configurées dans Railway. Le conserver dans un emplacement privé.

Les échecs de sauvegarde sont affichés dans cette section et dans les logs. Le serveur continue de servir les données ; la prochaine sauvegarde programmée réessaiera.

## Copie quotidienne sur le VPS AWS

Depuis la v0.1.88, le VPS du worker peut récupérer chaque jour la dernière copie régulière du site (au plus six heures de retard sur la base). Le programme `worker/deploy/backup.py`, lancé vers 4 h 15 (heure du VPS) par le timer systemd `planifikateur-backup` :

1. lit la liste des copies avec une **clé dédiée**, `PLANIFIKATEUR_BACKUP_TOKEN`, qui ne donne accès qu’aux sauvegardes : lister, télécharger, confirmer. Elle ne permet ni de créer une copie ni de lire ou modifier le tableau, et elle est distincte de la clé de l’agent : le conteneur du worker ne la reçoit pas ;
2. télécharge la plus récente si elle n’est pas déjà conservée, en HTTPS et sans suivre de redirection, après avoir vérifié l’espace disque (deux fois sa taille plus 1 Go, option `--min-free-gb`) ;
3. vérifie le fichier (taille annoncée, contrôle d’intégrité SQLite, base PlaniFiKateur), puis le compresse dans `/home/admin/planifikateur-backups/<nom>.sqlite.gz`, lisible par `admin` seul. Un fichier incomplet ou endommagé n’est jamais conservé ;
4. garde la plus récente copie de chacun des **7 derniers jours**, des **4 dernières semaines** et des **6 derniers mois**, et supprime les autres copies de ce répertoire ;
5. confirme au site la copie conservée. La section Sauvegardes de **Mon compte** affiche cette confirmation, et l’administrateur voit une alerte quand la dernière date de plus de deux jours.

Les copies ne sont pas chiffrées par le programme : elles restent dans un répertoire privé du VPS (droits 700, fichiers 600). Activer le chiffrement du volume EBS dans AWS protège aussi le disque et ses instantanés.

### Mise en place

1. Sur le VPS, créer une clé : `openssl rand -hex 32`.
2. Dans Railway, ajouter cette clé au service du site sous le nom `PLANIFIKATEUR_BACKUP_TOKEN` (32 caractères au moins, différente des autres clés), puis laisser le service redémarrer.
3. Sur le VPS, créer le fichier privé `/home/admin/planifikateur-backup.env` :

   ```sh
   PLANIFIKATEUR_URL=https://votre-site.up.railway.app
   PLANIFIKATEUR_BACKUP_TOKEN=la-clé-créée-à-l’étape-1
   ```

4. Relancer l’installateur, qui active le timer quand ce fichier existe et lui donne les droits 600 :

   ```sh
   cd /home/admin/PlaniFiKateur
   sudo bash worker/deploy/install.sh
   ```

5. Lancer une première copie et vérifier son journal :

   ```sh
   sudo systemctl start planifikateur-backup.service
   sudo journalctl -u planifikateur-backup.service -n 20 --no-pager
   ls -l /home/admin/planifikateur-backups
   ```

Le programme est mis à jour avec le dépôt par la mise à jour automatique du worker ; seule une modification des fichiers `.service` et `.timer` demande de relancer l’installateur.

### Restaurer depuis le VPS

Décompresser la copie choisie (`gunzip -k nom.sqlite.gz`), la transférer de façon privée vers le serveur à restaurer, puis suivre [la restauration](#restaurer-une-sauvegarde).

## Sauvegarde depuis le serveur

Dans un terminal du conteneur disposant réellement du volume Railway, ou sur votre installation locale :

```sh
npm run db:backup
```

Le chemin de la copie créée est affiché. Une commande lancée sur votre ordinateur ou dans Codex agit sur sa propre base, pas sur la base Railway. Les variables d’environnement du service doivent être présentes dans le terminal utilisé.

## Restaurer une sauvegarde

Cette commande remplace **tous les projets** par ceux de la sauvegarde. Avant de l’utiliser, prévenir les autres utilisateurs et leur demander de fermer leurs cartes en cours d’édition.

1. Mettre le fichier de sauvegarde dans le conteneur ou choisir une copie existante dans `/data/backups`.
2. Vérifier que `PLANIFIKATEUR_DB_PATH` désigne bien la base à restaurer et que le fichier source est distinct.
3. Exécuter dans le terminal du serveur :

```sh
npm run db:restore -- /data/backups/nom-de-la-sauvegarde.sqlite --confirm
```

Le fichier est vérifié avant toute écriture. Une copie de l’état actuel est créée avant la restauration. Si la validation ou cette copie échoue, les projets ne sont pas remplacés. La restauration utilise la connexion SQLite et une écriture transactionnelle ; il ne faut ni remplacer à la main un fichier ouvert, ni supprimer ses fichiers WAL/SHM.

Les identifiants, listes, cartes, commentaires et critères de la sauvegarde sont conservés. Chaque projet restauré retrouve aussi les réglages qu’il avait dans la sauvegarde : droits des membres, validation avant fusion, dépôt GitHub, réglages IA et d’exécution, et accès des agents qui existent encore (v0.1.31). Un projet supprimé perd ces réglages et son identifiant reste réservé : il ne revient que par une restauration. Les comptes, mots de passe et sessions actuels ne sont pas remplacés ; l’historique courant est conservé et reçoit une action de restauration. La révision du serveur **augmente**, pour que les anciennes sessions ne puissent pas écraser les données restaurées. Si une écriture concurrente a lieu entre la lecture et la restauration, la commande refuse l’écrasement.

Les navigateurs sans saisie en cours reçoivent les projets restaurés par l’actualisation automatique. Les utilisateurs qui éditaient doivent exporter leurs modifications éventuelles et recharger le tableau en cas de conflit. Aucun redémarrage du serveur n’est nécessaire.

## Vérifier après déploiement

- Créer une carte, attendre sa sauvegarde et télécharger une copie SQLite.
- Vérifier que la section Sauvegardes liste des copies après un redéploiement du service.
- Tester une restauration sur une **base de test distincte** avant d’en avoir besoin en production.

Les tests automatisés vérifient déjà les copies depuis WAL, leur rétention, la restauration, les fichiers invalides, l’accès réservé à l’administrateur et à la clé de sauvegarde, et la copie quotidienne du VPS (`tests/deploy/test_backup.py`). Ils ne prouvent pas la configuration effective du volume Railway ; cette vérification doit être faite sur le service hébergé.

Les sauvegardes comprennent également les identités d’agents et les exécutions. La restauration du contenu conserve leur historique actuel, mais annule les exécutions actives et leurs réservations pour éviter une validation sur une demande restaurée. Voir [le guide agent](agents.md).
