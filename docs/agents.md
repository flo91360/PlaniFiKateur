# Parcours agent par projet — v0.1.37

Un seul agent actif, sans délégation. Le site pilote les demandes et confirme la fusion GitHub ;
l’agent s’exécute dans un service externe. Le [worker Codex](worker.md) fournit ce
service : il doit être installé, connecté puis lancé séparément du site.

## Utilisation dans le site

1. Ouvrir une carte. Renseigner sa **Description** avec la demande, le résultat
   attendu et les contraintes. Cette description est la demande transmise à
   l’agent, qui déduit les vérifications utiles et pose une question si nécessaire.
2. Dans **Paramètres du projet**, configurer le dépôt GitHub et l’accès de l’agent.
   Ces paramètres s’appliquent à toutes les cartes de ce projet.
3. Passer la carte au statut **Prête à démarrer**, ou cliquer **Confier à l’agent**
   dans le panneau **Exécution IA** du détail. Le worker la détecte lors de sa
   prochaine consultation et le serveur crée automatiquement son exécution avec
   le dépôt du projet.
4. L’agent prend la tâche et signale son avancement. Une question fait apparaître
   **À préciser** et ajoute la question dans la **Discussion** de la carte.
   Publier un commentaire dans cette même carte pour répondre et remettre la tâche en file.
   La boîte **À traiter** de la barre supérieure, avec son badge, liste ces questions
   pour tous les projets ; un clic ouvre la carte dans son projet.
5. Le résultat passe en attente de tests et de fusion GitHub. La PR se fusionne
   automatiquement après les contrôles requis, puis le webhook termine la carte.
   L’avancement, le résultat, le lien vers la PR et la confirmation de fusion
   apparaissent dans la discussion de la carte.

Le panneau **Exécution IA** du détail de la carte résume l’exécution en cours :
étapes (prête, réalisation, PR et tests, terminée), dernier message, lien vers la
PR, état des contrôles GitHub, moteur, modèle et effort. Il propose les actions
humaines disponibles à cette étape :

- **Annuler l’exécution**, avec un motif, tant qu’elle n’est pas terminée ;
- **Demander des corrections** pendant les tests et la fusion de la PR : la
  demande est transmise à l’agent, qui reprend la même PR ;
- **Valider le résultat**, uniquement pour une ancienne exécution sans PR ;
- **Relancer l’agent** après une annulation ou une fusion, qui prépare une
  nouvelle exécution en conservant l’historique.

Les listes restent l’organisation du projet ; les statuts des cartes suivent
l’exécution automatiquement. Une carte en attente peut être retirée de la file en changeant son statut.
Après la prise en charge, le changement manuel de statut est bloqué, y compris via l’API du tableau. Préparer une nouvelle
exécution après une fusion conserve l’historique de la précédente.

L’interface actualise le travail dès qu’une étape est enregistrée, grâce au flux d’événements (`GET /api/v1/events`), et toutes les cinq secondes si ce flux est indisponible. Elle conserve les
brouillons des champs de la carte ; enregistrer ces champs avant toute action.
Modifier la demande d’une exécution en cours (titre, description, étiquettes,
pièces jointes ou effort) l’annulerait : le détail garde la saisie en brouillon et
demande confirmation à sa fermeture (aussitôt pour une pièce jointe ou l’effort),
avec la possibilité de rétablir la demande. La confirmation de suppression de la
carte signale aussi l’annulation.
Les transitions humaines exigent une version à jour pour éviter deux validations
contradictoires. Depuis la v0.1.37, les droits par projet s’appliquent : confier une carte à
l’agent (statut « Prête à démarrer » ou « Confier à l’agent »), valider son résultat et demander
des corrections sont réservés aux **responsables** du projet et aux administrateurs ; les
contributeurs peuvent répondre à ses questions et annuler une exécution. Voir
[les droits par projet](accounts.md#droits-par-projet--v0127).

## Connecter l’agent

Un administrateur ouvre **Connexion de l’agent** dans **Paramètres du projet**, crée sa clé et
la copie dans les secrets du service externe. Seul le projet sélectionné est
initialement autorisé. Ouvrir les paramètres d’un autre projet puis **Autoriser ce
projet** permet d’étendre l’accès. La clé ne sera pas réaffichée après fermeture.
Sa révocation invalide immédiatement les requêtes et interrompt les travaux en
cours ; il devient alors possible de créer une nouvelle clé.

La clé actuelle `PLANIFIKATEUR_READ_TOKEN` reste une clé de consultation. Elle
ne permet aucune prise en charge. La nouvelle clé d’agent est stockée hachée
et n’autorise ni la gestion des comptes, ni les sauvegardes, ni l’écriture libre
du tableau, ni la validation humaine. Un seul agent peut être actif à la fois.

Le service externe utilise `Authorization: Bearer <clé-agent>` sur HTTPS. Il peut
consulter les cartes et les listes de ses projets avec les routes de lecture
existantes. Ne jamais placer ses clés ou une réservation dans le contenu d’une
carte, une URL, Git ou un journal public.

## Contrat API

Toutes les routes imposent un projet et une carte explicites. Les réponses
utilisent `{ "data": ... }`, les erreurs `{ "error": { "code", "message" } }`.

| Méthode et route | Identité | Usage |
| --- | --- | --- |
| `GET /api/v1/agents` | Administrateur | Identités et projets autorisés, sans clés |
| `POST /api/v1/agents` | Administrateur | `{name, projectIds}` ; clé retournée une seule fois |
| `PUT /api/v1/agents/{id}` | Administrateur | `{name, projectIds}` ; modifier les projets autorisés |
| `DELETE /api/v1/agents/{id}` | Administrateur | Révoquer la clé |
| `GET /api/v1/projects/{projet}/work` | Agent | File des exécutions prêtes ou interrompues |
| `GET /api/v1/projects/{projet}/cards/{carte}/work` | Membre ou agent autorisé | Historique des exécutions, sans réservation secrète |
| `POST` sur cette dernière route | Membre | Préparer avec `{}` ; description de la carte, dépôt du projet, fusion automatique |
| `POST .../work/{execution}/{action}` | Selon l’action ci-dessous | Transition contrôlée |
| `GET /api/v1/attention` | Membre | Exécutions qui attendent une personne, tous projets confondus : questions de l’agent (`waiting`) et anciens résultats à valider (`review`) |

Les actions d’agent :

| Action | JSON envoyé | Effet |
| --- | --- | --- |
| `claim` | `{version}` | Réserver ; réponse incluant `leaseToken`, nouvelle `version`, `leaseExpiresAt` |
| `heartbeat` | `{leaseToken}` | Prolonger la réservation sans changer la version |
| `progress` | `{version, leaseToken, message}` | Enregistrer une mise à jour importante et prolonger la réservation |
| `question` | `{version, leaseToken, message}` | Attendre une réponse humaine, sans délai d’expiration |
| `submit` | `{version, leaseToken, summary, checks, links: [], pullRequest: {url, headSha}}` | Soumettre une PR pour fusion automatique |
| `interrupt` | `{version, leaseToken, message}` | Signaler un problème et rendre la tâche reprenable |

Les actions humaines exigent une session personnelle :

- `answer` : `{version, message}` ; remet l’exécution en file.
- `accept` : `{version}` ; uniquement pour les anciennes exécutions sans PR.
- `reject` : `{version, message}` ; conserve le refus et remet le travail en file.
- `cancel` : `{version, message}` ; annule l’exécution et conserve son historique.
- `approve` : `{version}` ; approuve la fusion de la PR au commit actuel, quand le projet exige une
  validation avant fusion (`GET/PUT /api/v1/projects/{projectId}/approval`, `{ required }`, réglé par un
  responsable). Les exécutions renvoient alors `approvalRequired` et `approval`, et la boîte « À traiter »
  liste les PR à approuver. Réservé aux responsables, comme `accept` et `reject`.

Une transition réussie renvoie l’exécution avec sa nouvelle `version` : utiliser
celle-ci pour l’action suivante. Chaque question, réponse, progression ou résultat
est rattaché à cette exécution, avec son auteur dans l’historique des actions.

## Boucle du service agent

1. Lire la file du projet, choisir une tâche, puis `claim` avec sa version.
2. Conserver **en privé** le `leaseToken` et la nouvelle version. Utiliser
   `cardSnapshot`, `objective`, `criteria`, `context`, les échanges précédents
   et les corrections demandées pour travailler.
3. Envoyer `heartbeat` environ toutes les 60 secondes pendant le travail.
4. Si des informations manquent, envoyer `question` puis revenir à la lecture
   de la file. La réponse humaine rend la tâche disponible ; refaire `claim`.
5. Sinon, envoyer `submit` avec le résumé, les vérifications réellement faites
   et `pullRequest: {url, headSha}`. Attendre les tests et la fusion GitHub. Un
   échec ou une demande de corrections remet la tâche en file ; refaire `claim`
   et prendre en compte les informations de reprise.
6. Sur `409`, relire l’exécution et arrêter le travail associé à la réservation
   périmée. **Ne jamais continuer à soumettre avec une ancienne réservation.**

Deux prises en charge simultanées, même via deux serveurs partageant SQLite,
donnent une réussite et un `409`. Une réservation dure cinq minutes ; après
expiration, l’exécution devient **Interrompue** lors de la prochaine consultation
ou action. Une reprise crée une nouvelle réservation et invalide l’ancienne.
Un redémarrage du serveur conserve la réservation et sa date d’expiration.
L’agent doit lui-même arrêter ses outils lorsqu’il perd la réservation : le site
peut refuser ses écritures, mais ne contrôle pas un processus externe.

## Client de référence

`scripts/agent-client.mjs` permet de brancher les appels comme outils d’un agent
ou de tester le protocole sans installer de dépendance supplémentaire. Configurer
`PLANIFIKATEUR_URL` (origine du site) et `PLANIFIKATEUR_AGENT_TOKEN` dans son
environnement. `PLANIFIKATEUR_LEASE_TOKEN` peut contenir la réservation actuelle.

```sh
node scripts/agent-client.mjs queue PROJET
node scripts/agent-client.mjs history PROJET CARTE
node scripts/agent-client.mjs claim PROJET CARTE EXECUTION < claim.json
node scripts/agent-client.mjs question PROJET CARTE EXECUTION < question.json
node scripts/agent-client.mjs submit PROJET CARTE EXECUTION < result.json
```

`claim.json` contient `{ "version": 1 }`. `question.json` contient la version
courante et `message` ; `result.json` contient la version courante, `summary`,
`checks`, `links` et `pullRequest: {url, headSha}`. La réservation peut venir de la variable d’environnement ou
du JSON. La réponse à `claim` contient une réservation secrète : ne pas publier
sa sortie. Le client renvoie un code de sortie non nul en cas d’erreur.

Ce client ne génère pas de réponses et n’exécute pas un modèle IA. Il fournit le
contrat de connexion pour le service choisi ; un moteur IA et ses outils doivent
être configurés séparément. La création de branches et de PR GitHub est assurée par le
[worker Codex](worker.md).

## Modifications, restauration et notifications

Modifier le titre, la description, les étiquettes ou les textes des critères de
la carte annule l’exécution active, afin de ne pas valider une demande obsolète.
Les commentaires, la priorité, le déplacement entre listes et la progression
des critères n’annulent pas la demande. Déplacer une carte vers un autre projet
ou la supprimer invalide également l’exécution et ses réservations.

Les sauvegardes SQLite contiennent les agents et exécutions. Restaurer le contenu
conserve les identités et l’historique actuels, mais annule les exécutions actives,
y compris les résultats à valider. Il faut préparer une nouvelle demande.

Les événements alimentent l’historique et les `recipientIds` des futures
notifications : demandeur, auteurs, participants et abonnés actifs, selon leurs
préférences, sans notifier l’auteur de l’action. Cette version n’envoie pas de
notifications et ne fournit pas encore de boîte de réception.

## Vérifications

Les tests couvrent le parcours complet, un refus suivi d’une seconde soumission,
les prises en charge concurrentes sur deux connexions SQLite, l’expiration et la
reprise, la révocation, les restrictions par projet, les réservations obsolètes,
la modification du contenu et la restauration. Le navigateur vérifie aussi le
parcours sur ordinateur et mobile.

## Livraisons GitHub — v0.1.11

Toutes les nouvelles exécutions utilisent `delivery: "github"` ; la soumission inclut `pullRequest: {url, headSha}`. Le résultat passe `merging` et ne demande aucune validation humaine ; il sera terminé après fusion GitHub confirmée par webhook signé. Les contrôles échoués remettent le travail en file ; après trois échecs consécutifs, l’exécution passe `waiting` avec une question, et la réponse d’une personne relance une correction. Un contrôle terminé sans verdict (`timed_out`, `action_required`, `skipped`…) laisse l’exécution en `merging`. Si un webhook se perd, le serveur relit lui-même la PR et ses contrôles sur GitHub. Voir [le parcours GitHub](github.md) pour la configuration et l’action `revise`. Seules les anciennes exécutions sans PR conservent leur parcours de validation historique.

## Une description suffit — v0.1.13

La description tient lieu d’objectif pour l’agent. Elle doit être non vide pour
préparer une exécution. Les critères d’acceptation ont été retirés des formulaires
et ne sont plus nécessaires : l’agent déduit le résultat attendu et les
vérifications utiles de la description. Il peut demander des précisions.

`POST .../cards/{carte}/work` reçoit `{}` ou `{ "delivery": "github" }`.
Le serveur calcule `objective` à partir de la description. `criteria` et `context`
restent présents mais vides dans les nouvelles exécutions pour conserver le
contrat de lecture des agents. `cardSnapshot` garde la carte au démarrage et
`requestSource: "card"` identifie ces exécutions. D’anciens paramètres `objective`,
`criteria` ou `context` envoyés à cette route ne remplacent pas la description.

Les listes de critères déjà stockées et les anciennes exécutions sont conservées
pour ne pas perdre les données historiques. Elles ne sont pas exigées pour les
nouvelles demandes. Les anciennes demandes restent consultables dans l’historique.

## Détection automatique des cartes prêtes — v0.1.16

`GET /api/v1/projects/{projet}/work` matérialise les cartes au statut `ready`
qui ont une description non vide et aucune exécution active. Le dépôt du projet
et le secret de webhook du serveur doivent être configurés. Les consultations
concurrentes créent une seule exécution par carte ; une seule réservation peut
réussir. Le demandeur est attribué à la personne ayant marqué la carte prête.
Les exécutions prêtes ou interrompues sont réutilisées sans perdre leur historique.
Une carte repassée à un autre statut avant sa prise en charge quitte la file.
Le `POST` de préparation reste disponible pour les anciens clients, mais n’est
plus nécessaire dans le parcours normal. La **Discussion** de la carte contient les questions et le suivi.
Un nouveau commentaire humain dans une carte « À préciser » répond à la dernière
question et relance la même exécution. Un commentaire dans un autre état reste
un commentaire ordinaire. Modifier un ancien commentaire ne relance pas la tâche.
Les questions des exécutions déjà enregistrées sont ajoutées à la discussion
lors de la mise à jour du serveur, sans doublons.
