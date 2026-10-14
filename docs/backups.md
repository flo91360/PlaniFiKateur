# Sauvegardes et restauration

À partir de la v0.1.6, le serveur crée une sauvegarde au démarrage, puis toutes les **6 heures lorsque les projets, les comptes ou leur historique ont changé**. Il crée aussi une copie avant une suppression de projet, de liste ou de carte, une fois les droits vérifiés et seulement si un élément est réellement retiré : une demande refusée ou sans effet ne déclenche aucune copie. Une suppression n’est pas enregistrée si cette copie de sécurité échoue.

Les copies utilisent `VACUUM INTO` : chaque fichier SQLite est autonome et inclut les modifications validées, même si elles étaient dans le journal WAL. Les copies sont vérifiées avant publication ; un fichier partiel n’est jamais proposé au téléchargement. Les **28 dernières copies** de chaque sorte sont conservées : d’un côté les copies régulières (démarrage, intervalle, manuelles), de l’autre les copies d’avant suppression, nommées `…-suppression.sqlite`. Depuis la v0.1.30, des suppressions répétées ne remplacent donc plus les copies régulières ; ces dernières ne garantissent pas 7 jours d’historique si vous redéployez souvent.

## Passage au stockage en tables (v0.1.25)

Jusqu’à la v0.1.24, tout le tableau était un seul document JSON. À partir de la v0.1.25, projets, listes, cartes, commentaires et pièces jointes sont rangés dans des tables SQLite séparées. La conversion a lieu **une seule fois**, au premier démarrage de la nouvelle version :

1. le serveur copie d’abord la base telle quelle dans le répertoire des sauvegardes, sous le nom `planifikateur-avant-tables-<date>.sqlite` ;
2. il convertit le tableau, relit les tables et vérifie que le résultat est identique au document d’origine ;
3. il valide la conversion en une seule transaction. Au moindre écart, rien n’est modifié et le démarrage échoue avec un message explicite.

Cette copie n’est pas comptée dans les 28 sauvegardes tournantes et n’est jamais supprimée automatiquement. Pour revenir à une version antérieure à la v0.1.25, restaurer cette copie (voir ci-dessous) **avant** de redémarrer l’ancienne version : une ancienne version ne lit pas les tables. Les sauvegardes des deux formats se restaurent avec la version actuelle.

## Railway

Avec `PLANIFIKATEUR_DB_PATH=/data/planifikateur.sqlite` et le volume monté à `/data`, les copies vont automatiquement dans **`/data/backups`**, sur le même volume. Aucun service supplémentaire ni clé supplémentaire n’est nécessaire.

Paramètres facultatifs dans les variables du service :

| Variable | Défaut | Valeurs |
| --- | --- | --- |
| `PLANIFIKATEUR_BACKUP_DIR` | `backups` à côté de la base | Répertoire sur un volume persistant, hors du répertoire web `dist` |
| `PLANIFIKATEUR_BACKUP_INTERVAL_HOURS` | `6` | 1 à 168 heures |
| `PLANIFIKATEUR_BACKUP_KEEP` | `28` | 1 à 100 fichiers de chaque sorte |

La base elle-même est limitée par une **rétention** appliquée au démarrage puis chaque jour :

| Variable | Défaut | Effet |
| --- | --- | --- |
| `PLANIFIKATEUR_ACTIVITY_RETENTION_DAYS` | `365` | Supprime les entrées d’historique plus anciennes ; `0` conserve tout |
| `PLANIFIKATEUR_EXECUTION_RETENTION_DAYS` | `365` | Supprime les exécutions IA terminées ou annulées sans activité depuis ce délai ; `0` conserve tout |

Les cartes, leurs commentaires et leurs pièces jointes ne sont jamais purgés, ni les exécutions en cours. Une exécution terminée ne garde que le nom, le type et la taille des pièces jointes de sa copie de carte ; le contenu reste dans la carte. Les sauvegardes déjà faites conservent l’historique complet de leur date.

Le volume doit pouvoir contenir la base et ses copies. Vous pouvez réduire le nombre de copies si l’espace est limité. Utiliser une seule instance du serveur.

## Conserver une copie en dehors de Railway

Dans le site connecté, ouvrir le bouton d’information puis la section **Sauvegardes**. « Créer et télécharger une sauvegarde SQLite » capture les données déjà enregistrées sur le serveur. Attendre « Sauvegardé sur le serveur » avant cette opération. Les anciennes copies sont également téléchargeables ; leurs dates sont affichées dans votre fuseau horaire.

La consultation et le téléchargement des sauvegardes exigent la session administrateur. La clé de lecture agent ne donne pas accès aux sauvegardes, qui contiennent tous les projets.

**Les copies sur le même volume ne protègent pas contre la perte ou la suppression de ce volume.** Télécharger régulièrement une copie et la conserver dans un emplacement privé distinct. L’envoi automatique vers un stockage externe n’est pas configuré dans cette version. Le fichier contient les projets, cartes, commentaires, comptes, empreintes de mots de passe, invitations, sessions et historique. Il ne contient pas les clés d’environnement configurées dans Railway. Le conserver dans un emplacement privé.

Les échecs de sauvegarde sont affichés dans cette section et dans les logs. Le serveur continue de servir les données ; la prochaine sauvegarde programmée réessaiera.

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

Les identifiants, listes, cartes, commentaires et critères de la sauvegarde sont conservés. Chaque projet restauré retrouve aussi les réglages qu’il avait dans la sauvegarde : droits des membres, validation avant fusion, dépôt GitHub, réglages IA et d’exécution, et accès des agents qui existent encore (v0.1.30). Un projet supprimé perd ces réglages et son identifiant reste réservé : il ne revient que par une restauration. Les comptes, mots de passe et sessions actuels ne sont pas remplacés ; l’historique courant est conservé et reçoit une action de restauration. La révision du serveur **augmente**, pour que les anciennes sessions ne puissent pas écraser les données restaurées. Si une écriture concurrente a lieu entre la lecture et la restauration, la commande refuse l’écrasement.

Les navigateurs sans saisie en cours reçoivent les projets restaurés par l’actualisation automatique. Les utilisateurs qui éditaient doivent exporter leurs modifications éventuelles et recharger le tableau en cas de conflit. Aucun redémarrage du serveur n’est nécessaire.

## Vérifier après déploiement

- Créer une carte, attendre sa sauvegarde et télécharger une copie SQLite.
- Vérifier que la section Sauvegardes liste des copies après un redéploiement du service.
- Tester une restauration sur une **base de test distincte** avant d’en avoir besoin en production.

Les tests automatisés vérifient déjà les copies depuis WAL, leur rétention, la restauration, les fichiers invalides et l’accès réservé à l’administrateur. Ils ne prouvent pas la configuration effective du volume Railway ; cette vérification doit être faite sur le service hébergé.

Les sauvegardes comprennent également les identités d’agents et les exécutions. La restauration du contenu conserve leur historique actuel, mais annule les exécutions actives et leurs réservations pour éviter une validation sur une demande restaurée. Voir [le guide agent](agents.md).
