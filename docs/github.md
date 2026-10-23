# PR d’agent : tests puis fusion automatique — v0.1.73

Toutes les nouvelles tâches sont livrées par PR GitHub avec fusion automatique,
sans sélection du mode de livraison. Depuis la v0.1.28, un responsable peut exiger
dans **Paramètres du projet → Validation avant fusion** que chaque PR soit en plus
approuvée depuis la carte (**Approuver la fusion**) : `merge-eligibility` répond
alors `approval_required` tant que le commit testé n’est pas approuvé, et une
correction de l’agent demande une nouvelle approbation. Les anciennes exécutions sans PR restent
consultables et peuvent terminer leur parcours précédent. Une PR est fusionnée seulement après la
réussite des contrôles requis ; la carte est terminée après confirmation signée
de la fusion par GitHub.

Les interventions directes utilisent la même préparation et les mêmes contrôles
que les cartes : voir [le parcours commun de livraison](livraison.md).
La carte terminée confirme la fusion ; « Livraison de version » confirme ensuite
le tag et la version réellement servie par Railway.

## Configuration à effectuer une fois

1. Déployer cette version du site. Sur Railway, ajouter le secret
   `PLANIFIKATEUR_GITHUB_WEBHOOK_SECRET`, généré aléatoirement et conservé dans
   les variables privées du service. Ne pas le placer dans Git.
2. Dans **Paramètres du projet**, un administrateur ouvre **Dépôt GitHub et
   fusion automatique**, puis renseigne `propriétaire/dépôt`. La branche cible est
   du profil. Choisir le profil d’exécution correspondant au projet selon
   [le guide multi-projets](multi-projets.md). Chaque dépôt conserve son propre
   workflow et ses commandes : ne pas copier les tests PlaniFiKateur dans les
   autres applications.
3. Créer une identité d’agent autorisée sur ce projet. Configurer le worker avec
   l’URL du site, la clé de cet agent et son token GitHub selon
   [le guide du worker](worker.md). Le worker utilise ces accès pour vérifier
   puis fusionner la PR ; aucun secret Actions n’est requis dans ce parcours.
4. Dans **Settings → Webhooks**, ajouter :
   - URL : `https://votre-site/api/v1/github/webhook`.
   - Type : `application/json`.
   - Secret : même valeur que `PLANIFIKATEUR_GITHUB_WEBHOOK_SECRET`.
   - Événements : **Pull requests**, **Workflow runs** et **Releases** (archivage
     Google Drive immédiat, voir [google-drive.md](google-drive.md)) ; webhook actif.
5. Le worker crée le label `planifikateur-agent` s’il manque lors de la livraison.
6. Laisser une première exécution du workflow **Tests** enregistrer les contrôles.
   Dans la protection de la branche cible, exiger les contrôles du profil,
   ainsi qu’une branche à jour avant fusion. Ne pas exiger d’approbation humaine.
   Les restrictions du dépôt doivent permettre au workflow la fusion des PR.

Le worker effectue directement une fusion squash via l’API GitHub. Il ne
dépend pas du réglage natif **Allow auto-merge**. Son token doit pouvoir lire les
Actions et écrire le contenu, les issues et les pull requests.
Les règles de branche restent appliquées : un refus GitHub ne sera pas contourné.
Après la fusion, il supprime la branche de la PR (jamais la branche cible) ; un
refus de suppression est seulement journalisé et ne remet pas la fusion en cause.

Le workflow `.github/workflows/agent-merge.yml` reste un mécanisme complémentaire
optionnel, avec les mêmes vérifications dans `worker/merge.mjs`. Pour l’utiliser,
installer aussi ce module et `scripts/merge-agent-pr.mjs` dans le dépôt cible,
autoriser `contents: write` et `pull-requests: write` pour Actions et définir les
secrets Actions `PLANIFIKATEUR_URL` et `PLANIFIKATEUR_AGENT_TOKEN`. Leur absence
ne bloque pas la fusion par le worker. Une révocation de l’agent impose de
remplacer sa clé dans chaque service qui l’utilise.

La configuration des webhooks et des règles de branche nécessite les droits
d’administration correspondants. Si l’intégration de l’environnement refuse
ces appels, effectuer cette configuration initiale dans GitHub et Railway.
Le guide multi-projets distingue les vérifications locales des livraisons
réelles sur le VPS.

## Parcours de l’agent

1. Renseigner la description de la carte et choisir le statut **Prête à démarrer**.
   La consultation de la file par le worker crée automatiquement l’exécution.
   Le serveur exige un dépôt et un secret de webhook configurés. L’API accepte `{}` et impose
   `delivery: "github"` ; toute autre livraison est refusée. Le dépôt est repris
   des paramètres du projet et mémorisé au démarrage de l’exécution. Modifier
   le dépôt du projet ne redirige pas les exécutions déjà commencées.
2. Réserver l’exécution et travailler sur une branche issue de `main` à jour.
3. Créer une PR vers `main` dans le même dépôt. Les PR venant de forks et les PR
   encore en brouillon ne sont pas fusionnées par ce parcours.
4. Soumettre le résultat à PlaniFiKateur avant de déclencher la fusion :

```json
{
  "version": 3,
  "leaseToken": "réservation courante",
  "summary": "Menu corrigé",
  "checks": "Tests locaux exécutés ; contrôles GitHub attendus",
  "links": [],
  "pullRequest": {
    "url": "https://github.com/propriétaire/dépôt/pull/7",
    "headSha": "SHA complet de 40 caractères du commit de la PR"
  }
}
```

5. Ajouter le label `planifikateur-agent`. L’ajout de label ou le passage hors
   brouillon lance les contrôles. L’agent consulte l’historique de son exécution
   pendant cette attente, sans envoyer de heartbeat : sa réservation de travail
   est libérée à la soumission.
6. Si les tests échouent, leur webhook remet l’exécution en file. Réserver à
   nouveau, corriger, pousser et soumettre la nouvelle référence de commit. Le
   worker transmet au modèle les jobs et étapes en échec avec la fin de leurs
   journaux. Après **trois échecs consécutifs**, l’exécution passe en question
   (« À préciser ») : une personne consulte les journaux puis répond pour
   relancer une correction, ou annule. Une exécution annulée reste en attente
   des tests et de la fusion : elle ne renvoie pas la tâche à Codex lorsque
   GitHub remplace les premiers contrôles par ceux déclenchés par l’ajout du
   label. Un contrôle terminé sans verdict (délai dépassé, approbation requise,
   ignoré…) ne renvoie pas non plus la tâche au modèle : la carte l’indique, et
   les contrôles sont à relancer depuis GitHub.
7. Si GitHub demande de remettre la branche à jour, retirer le label, utiliser
   `POST .../work/{execution}/revise` avec la version courante pour reprendre
   l’exécution, mettre la branche à jour, pousser puis soumettre à nouveau avant
   de remettre le label. `revise` est réservé à l’agent responsable et renvoie
   une nouvelle réservation.

Les changements ultérieurs de commit rendent l’ancienne soumission inéligible.
Une PR est liée à une seule exécution ; les nouvelles versions de la même PR
peuvent être rattachées à cette exécution.

## Conditions de fusion

La fusion est exécutée par le code installé du worker, hors du dépôt modifié
par Codex. Le workflow complémentaire **Fusion des PR agent** tourne avec le
code de `main`, jamais avec le code de la PR et ses secrets. Ils vérifient :

- Une exécution terminée et réussie du workflow du profil, pour cette PR.
- Les jobs requis du profil, présents une seule fois, terminés avec `success`.
  `skipped`, `neutral`, `cancelled`, échec ou job absent ne suffisent pas.
- Le même dépôt, la branche `main`, une PR ouverte, sans brouillon, avec le label.
- Le commit courant de la PR identique au commit testé et une branche à jour.
- L’absence d’une nouvelle tentative de tests en cours.
- L’éligibilité actuelle de la tâche auprès de PlaniFiKateur, avec la clé d’agent.
  Une tâche annulée, modifiée, reprise ou liée à un autre commit bloque la fusion.

La requête de fusion contient le SHA attendu : une nouvelle modification de la
PR entre vérification et fusion provoque un refus GitHub. La protection stricte
de `main` couvre aussi les changements de la branche cible entre ces opérations.

Un succès CI laisse la carte **Tests et fusion GitHub en attente**. Seul un
webhook `pull_request` fermé avec `merged: true`, la bonne PR et le bon commit,
signé avec le secret, la fait passer **À tester — PR fusionnée**. Les événements
répétés sont sans effet ; fermer une PR sans fusion ne termine pas la carte.
En cas de webhook perdu (redéploiement du site, panne de livraison), le serveur
rattrape seul la situation depuis la v0.1.32 : toutes les 5 minutes, pour chaque
PR de l’agent en attente depuis plus de 3 minutes, il relit la PR et les
exécutions de son workflow auprès de l’API GitHub, avec
`PLANIFIKATEUR_GITHUB_TOKEN` (nécessaire pour un dépôt privé), et applique les
mêmes règles qu’au webhook. La redélivraison depuis GitHub reste possible. Un échec de
fusion est publié en annotation GitHub, consultable automatiquement via l’API,
et ne clôture pas la carte.

Railway peut ensuite déployer si sa connexion GitHub et le déploiement automatique
sont activés. La fusion n’est pas une confirmation de déploiement réussi.

## API complémentaire

- `GET /api/v1/projects/{id}/github` : configuration publique du projet pour ses
  membres, avec l’indicateur `webhookConfigured`, sans secret.
- `PUT` sur cette route, administrateur : `{ "repository": "propriétaire/dépôt" }`.
- `GET /api/v1/github/merge-eligibility?repository=...&number=...&sha=...` : réservé
  à un agent actif autorisé ; renvoie `{ "data": { "eligible": true|false } }`.
- `POST /api/v1/github/webhook` : signature `X-Hub-Signature-256` calculée sur les
  octets originaux du corps ; aucun cookie ou token d’agent ne remplace celle-ci.
  GitHub ne signe que le corps : son identifiant de livraison (`X-GitHub-Delivery`)
  pourrait être changé lors d’un rejeu, et ne sert donc pas de protection. Un corps
  signé rejoué n’a pas d’effet : chaque traitement est idempotent (contrôles déjà
  vus ignorés, fusion constatée une seule fois, versions et notes de release
  réécrites à l’identique).

Les PR de code ne peuvent pas être acceptées manuellement par la route `accept`.
L’annulation humaine reste possible. Une nouvelle demande dans la colonne
**Bugs** suit le même parcours ; indiquer dans la description la carte et la PR
à l’origine du problème facilite le diagnostic.
