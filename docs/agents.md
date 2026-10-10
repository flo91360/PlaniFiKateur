# Premier parcours agent — v0.1.9

Un seul agent actif, sans délégation. Le site pilote les demandes et la validation ;
l’agent s’exécute dans un service externe. Aucun modèle IA, outil de développement
ou service GitHub n’est lancé automatiquement par cette version.

## Utilisation dans le site

1. Ouvrir une carte. Renseigner sa **Description** avec la demande, le résultat
   attendu et les contraintes. Cette description est la demande transmise à
   l’agent, qui déduit les vérifications utiles et pose une question si nécessaire.
2. Cliquer **Prête pour un agent**. Cette action crée une exécution persistante.
3. L’agent prend la tâche et signale son avancement. Une question fait apparaître
   **À préciser**. Répondre puis cliquer **Répondre et reprendre**.
4. Un résultat fait apparaître **À valider** : résumé, vérifications déclarées
   par l’agent et liens HTTP(S) vers les livrables.
5. **Valider le résultat** clôt l’exécution. **Demander des corrections** exige
   un commentaire et remet la tâche dans la file. Les anciennes soumissions et
   décisions restent consultables.

Les listes restent l’organisation du projet ; les statuts des cartes suivent
l’exécution automatiquement. Le changement manuel de statut est bloqué pendant
une exécution active, y compris via l’API du tableau. Préparer une nouvelle
exécution après une validation conserve l’historique de la précédente.

L’interface actualise le travail toutes les cinq secondes. Elle conserve les
brouillons des champs de la carte ; enregistrer ces champs avant toute action.
Les transitions humaines exigent une version à jour pour éviter deux validations
contradictoires. Tous les membres actifs peuvent répondre et valider dans cet
espace actuellement partagé.

## Connecter l’agent

Un administrateur ouvre **Connexion de l’agent** dans une carte, crée sa clé et
la copie dans les secrets du service externe. Seul le projet sélectionné est
initialement autorisé. Ouvrir une carte d’un autre projet puis **Autoriser ce
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
| `POST` sur cette dernière route | Membre | Préparer avec `{delivery}` ou `{}` ; demande issue de la carte |
| `POST .../work/{execution}/{action}` | Selon l’action ci-dessous | Transition contrôlée |

Les actions d’agent :

| Action | JSON envoyé | Effet |
| --- | --- | --- |
| `claim` | `{version}` | Réserver ; réponse incluant `leaseToken`, nouvelle `version`, `leaseExpiresAt` |
| `heartbeat` | `{leaseToken}` | Prolonger la réservation sans changer la version |
| `progress` | `{version, leaseToken, message}` | Enregistrer une mise à jour importante et prolonger la réservation |
| `question` | `{version, leaseToken, message}` | Attendre une réponse humaine, sans délai d’expiration |
| `submit` | `{version, leaseToken, summary, checks, links: []}` | Soumettre un résultat pour validation |
| `interrupt` | `{version, leaseToken, message}` | Signaler un problème et rendre la tâche reprenable |

Les actions humaines exigent une session personnelle :

- `answer` : `{version, message}` ; remet l’exécution en file.
- `accept` : `{version}` ; accepte la dernière soumission.
- `reject` : `{version, message}` ; conserve le refus et remet le travail en file.
- `cancel` : `{version, message}` ; annule l’exécution et conserve son historique.

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
   et les liens vers les livrables. Attendre la validation. Un refus remet la
   tâche en file ; refaire `claim` et prendre en compte le commentaire.
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
`checks` et `links`. La réservation peut venir de la variable d’environnement ou
du JSON. La réponse à `claim` contient une réservation secrète : ne pas publier
sa sortie. Le client renvoie un code de sortie non nul en cas d’erreur.

Ce client ne génère pas de réponses et n’exécute pas un modèle IA. Il fournit le
contrat de connexion pour le service choisi ; un moteur IA et ses outils doivent
être configurés séparément. La création de branches et de PR GitHub fera partie
de l’étape suivante.

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

Pour une exécution préparée avec `delivery: "github"`, la soumission inclut `pullRequest: {url, headSha}`. Le résultat passe `merging` et ne demande aucune validation humaine ; il sera terminé après fusion GitHub confirmée par webhook signé. Les contrôles échoués remettent le travail en file. Voir [le parcours GitHub](github.md) pour la configuration et l’action `revise`. Les exécutions sans PR conservent le parcours décrit ci-dessus.

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
