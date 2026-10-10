# Comptes individuels et historique — v0.1.8

## Migration sur Railway

La mise à jour ajoute des tables dans la même base SQLite, sans effacer les projets. Les anciennes sessions à clé partagée cessent de fonctionner.

Au premier accès :

1. La page propose **Créer le compte administrateur**.
2. Saisir votre nom, votre adresse e-mail et un mot de passe personnel de **12 caractères minimum**.
3. Saisir l’ancienne clé `PLANIFIKATEUR_OWNER_TOKEN` dans **Clé d’initialisation**.
4. Créer le compte. Vos projets et cartes existants restent disponibles.

La clé d’initialisation ne permet plus de se connecter après cette création. L’initialisation ne peut pas être répétée, même après un redémarrage. Conserver les variables Railway actuelles : `PLANIFIKATEUR_OWNER_TOKEN` reste requise par la configuration d’exposition publique, et `PLANIFIKATEUR_READ_TOKEN` sert toujours aux agents. Ne pas partager la clé d’initialisation avec les membres.

En développement local sans clé configurée, la création du premier compte est possible sur la machine locale. Il n’y a plus de connexion automatique anonyme.

## Inviter votre collègue

Cliquer sur votre initiale, en haut à droite, pour ouvrir **Mon compte**. L’administrateur dispose de **Membres de l’espace** :

- Saisir le nom et l’adresse e-mail du membre puis **Créer une invitation**.
- Copier le lien affiché et le transmettre uniquement à cette personne.
- Le membre ouvre le lien, choisit son nom et son mot de passe, puis active son compte.

Le lien est valable 7 jours, utilisable une seule fois. Son secret est dans le fragment de l’URL, pour éviter son envoi dans les logs HTTP. La base conserve seulement son empreinte. Renouveler le lien invalide le précédent. L’e-mail n’est pas envoyé automatiquement et son adresse n’est pas vérifiée par un service de messagerie : l’administrateur doit remettre le lien à la bonne personne.

Les personnes déjà connectées peuvent également ouvrir un lien d’activation ou de réinitialisation ; l’activation remplace leur session par celle du compte invité.

## Droits

| Action | Administrateur | Membre | Agent avec clé de lecture |
| --- | --- | --- | --- |
| Consulter et modifier les projets partagés | Oui | Oui | Consultation seulement |
| Consulter l’historique | Oui | Oui | Non |
| Inviter, désactiver et réactiver les membres | Oui | Non | Non |
| Créer et télécharger les sauvegardes SQLite | Oui | Non | Non |

Les projets sont communs à tous les comptes actifs. Il n’y a pas encore de permissions par projet ni de responsable assigné à une carte. L’administrateur initial est protégé contre la désactivation depuis l’interface.

## Connexion, mot de passe et sessions

Connexion par adresse e-mail et mot de passe. Les e-mails sont normalisés en minuscules et uniques ; les noms affichés peuvent être identiques, les identifiants des comptes les distinguent.

- Mots de passe conservés avec **scrypt et un sel aléatoire**, jamais en clair.
- Sessions conservées dans SQLite avec une empreinte du jeton, cookie HttpOnly / SameSite=Strict / Secure en HTTPS, expiration après 12 heures. Elles survivent aux redémarrages.
- Déconnexion : révocation immédiate de cette session. La déconnexion est refusée si des modifications locales ne sont pas sauvegardées.
- **Changer mon mot de passe** : saisir le mot de passe actuel puis le nouveau. Les autres sessions sont révoquées ; une nouvelle session remplace la session courante.
- **Désactiver** : bloque la connexion, révoque les sessions et empêche l’activation des invitations. Les cartes et l’historique de cette personne restent conservés.
- Mot de passe d’un membre oublié : l’administrateur utilise **Réinitialiser le mot de passe** et lui transmet le nouveau lien. L’ancien mot de passe reste valide jusqu’à l’activation du lien ; désactiver le compte permet de bloquer immédiatement tout accès.

La récupération autonome par e-mail et la récupération du mot de passe administrateur depuis l’interface ne sont pas implémentées. Conserver le mot de passe administrateur dans un gestionnaire de mots de passe. Les tentatives d’authentification, d’activation et de changement de mot de passe sont limitées à 20 par minute et par adresse vue par le serveur ; derrière Railway, plusieurs utilisateurs peuvent partager cette limite.

## Créateurs et journal des actions

Chaque nouvelle carte reçoit `createdBy` (id et nom) et `createdAt`, puis `updatedBy` / `updatedAt` lors des modifications. Les commentaires reçoivent le nom et `authorId` de leur auteur. Ces champs sont **attribués par le serveur** ; le client ne peut pas choisir ou remplacer l’auteur d’une carte existante.

Les cartes antérieures à la migration affichent **Auteur inconnu** ; les anciens commentaires gardent leur libellé mais n’ont pas d’identifiant d’auteur. Aucun auteur n’est deviné. Les projets importés en JSON sont de nouvelles créations attribuées à la personne qui importe. La copie HTML autonome continue de fonctionner localement sans compte authentifié.

Le détail d’une carte affiche son auteur et son historique. Le bouton **Historique des projets** donne accès au journal commun. Les créations, modifications, changements de statut, déplacements, commentaires, suppressions et actions de gestion des comptes sont enregistrés. Les suppressions n’effacent pas le journal. Celui-ci se consulte par pages et peut être actualisé depuis la fenêtre d’historique.

Les événements comprennent l’acteur, la date, le projet et la carte concernés, le type d’action, la révision et les champs modifiés. Les changements de contenu et leurs événements sont enregistrés dans la **même transaction SQLite** : une sauvegarde refusée pour conflit ne crée pas d’action fictive. Le journal est un historique applicatif ; un administrateur de l’hébergement disposant de la base peut techniquement le modifier.

## Préparation des notifications

Les événements de cartes conservent `recipientIds`, calculés à partir du créateur, des auteurs identifiés des commentaires et des abonnés explicites, en excluant les désabonnés, les comptes inactifs et la personne qui effectue l’action. Les destinataires sont des identifiants de comptes stables ; leurs adresses restent dans la table des comptes, sans être exposées par l’API de cartes.

Cela prépare les futures notifications. **Aucune notification n’est envoyée** dans cette version : canal, mentions, assignation et traitement des événements restent à ajouter. Une notification future devra vérifier que le destinataire est encore actif et respecte ses préférences.

## Sauvegardes

Les changements de comptes sont aussi pris en compte par les sauvegardes automatiques, même sans modification des projets. Les fichiers SQLite contiennent désormais les comptes, empreintes de mots de passe, invitations, sessions et le journal. Ils sont réservés à l’administrateur et doivent être conservés dans un emplacement privé.

La commande `db:restore` restaure **le contenu des projets**, conserve les comptes actuels, leurs mots de passe et le journal, puis ajoute une action de restauration. Elle ne réactive pas les anciens mots de passe, sessions ou invitations présents dans une copie. Une reprise complète d’un fichier SQLite sur une nouvelle installation est une opération différente, à effectuer avec le serveur arrêté.

## Routes réservées aux comptes

| Route | Usage |
| --- | --- |
| `GET /api/v1/session` | État de connexion, compte public et besoin d’initialisation |
| `POST /api/v1/session` | Connexion `{email,password}` |
| `DELETE /api/v1/session` | Déconnexion |
| `POST /api/v1/accounts/setup` | Premier administrateur `{token,name,email,password}` |
| `POST /api/v1/accounts/accept` | Activer une invitation `{token,name,password}` |
| `POST /api/v1/accounts/password` | Changer le mot de passe `{currentPassword,password}` |
| `GET /api/v1/users` | Comptes, réservé à l’administrateur |
| `POST /api/v1/users` | Inviter `{name,email}`, lien retourné une seule fois |
| `POST /api/v1/users/{id}/invitation` | Renouveler un lien d’activation/réinitialisation |
| `PATCH /api/v1/users/{id}` | Activer/désactiver `{active}` |
| `GET /api/v1/activity` | Historique commun |
| `GET /api/v1/projects/{projectId}/activity` | Historique d’un projet, même supprimé |
| `GET /api/v1/projects/{projectId}/cards/{cardId}/activity` | Historique d’une carte, même supprimée |

Les routes d’historique acceptent `limit` (1 à 100, défaut 50) et `before` (id d’événement exclusif). `meta.nextBefore` permet de charger la page suivante. Les routes de consultation des cartes conservent le projet obligatoire et la clé de lecture agent.

## Suivre une carte

Chaque compte peut utiliser « Suivre la carte » dans son détail, même sans être
son auteur. Le créateur et les auteurs de commentaires suivent automatiquement
la carte, sauf désabonnement explicite. « Ne plus suivre » désactive également
ce suivi automatique. Le choix est personnel et persiste après reconnexion ou
redémarrage du serveur ; il apparaît dans l’historique.

La préférence est conservée dans SQLite séparément du contenu : une sauvegarde
de carte concurrente ne l’écrase pas. Les comptes désactivés et l’auteur de
l’action sont exclus des `recipientIds`. Les événements de modification,
commentaire, statut et suppression incluent les abonnés actifs. Les changements
d’abonnement eux-mêmes ne génèrent pas de destinataires.

Routes réservées aux sessions personnelles, toujours avec le projet :

- `GET /api/v1/projects/{projectId}/cards/{cardId}/subscription` renvoie
  `{ "data": { "following": true } }` (ou `false`).
- `PUT` sur la même route avec `{ "following": true }` ou `false` définit
  uniquement le choix du compte connecté. Répéter le même choix est sans effet.

Ces routes sont inaccessibles à la clé de consultation des agents. Une carte
absente du projet demandé renvoie 404. Elles ne modifient pas la révision du
contenu. Les préférences sont incluses dans les sauvegardes SQLite ; la
restauration du contenu conserve les préférences actuelles des cartes encore
présentes et retire celles des cartes supprimées.

L’envoi de notifications reste une prochaine étape : cette version mémorise les
abonnements et prépare les destinataires, sans envoyer d’e-mail ni d’alerte.

## Supprimer un compte — v0.1.10

Depuis **Mon compte → Membres de l’espace**, l’administrateur peut cliquer
**Supprimer le compte**, puis confirmer ou annuler. Les comptes actifs,
désactivés et encore invités peuvent être supprimés. Le compte administrateur
est protégé contre la suppression.

`DELETE /api/v1/users/{id}` exige une session administrateur et renvoie
`{ "data": { "deleted": true } }`. Les membres et les clés d’agents ne peuvent
pas utiliser cette action. La suppression retire le compte, ses sessions,
ses invitations et ses abonnements ; ses cartes, commentaires et actions sont
conservés avec l’identité historique de leur auteur. Une nouvelle invitation
à la même adresse crée une nouvelle identité, sans récupérer les anciens droits
ou abonnements. L’historique consigne l’auteur de la suppression.

Les anciennes sauvegardes SQLite peuvent toujours contenir les données du
compte supprimé ; la restauration du contenu par l’outil du site ne recrée pas
les comptes supprimés.
