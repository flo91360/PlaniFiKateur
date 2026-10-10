# PR d’agent : tests puis fusion automatique — v0.1.11

Les livraisons GitHub n’exigent plus une validation humaine. Les résultats sans
PR conservent le parcours précédent. Une PR est fusionnée seulement après la
réussite des contrôles requis ; la carte est terminée après confirmation signée
de la fusion par GitHub.

## Configuration à effectuer une fois

1. Déployer cette version du site. Sur Railway, ajouter le secret
   `PLANIFIKATEUR_GITHUB_WEBHOOK_SECRET`, généré aléatoirement et conservé dans
   les variables privées du service. Ne pas le placer dans Git.
2. Dans une carte du projet, un administrateur ouvre **Dépôt GitHub et fusion
   automatique**, puis renseigne `propriétaire/dépôt`. La branche cible est
   `main`. Les workflows de ce dépôt doivent être présents dans chaque dépôt
   qui reçoit les PR de l’agent : `.github/workflows/ci.yml`,
   `.github/workflows/agent-merge.yml` et `scripts/merge-agent-pr.mjs`.
   Les commandes de tests devront être adaptées pour les autres applications.
3. Créer une identité d’agent autorisée sur ce projet. Dans le dépôt GitHub,
   **Settings → Secrets and variables → Actions**, enregistrer :
   - `PLANIFIKATEUR_URL` : origine HTTPS du site Railway, sans chemin.
   - `PLANIFIKATEUR_AGENT_TOKEN` : clé de cet agent. Une révocation impose de
     remplacer ce secret.
4. Dans **Settings → Webhooks**, ajouter :
   - URL : `https://votre-site/api/v1/github/webhook`.
   - Type : `application/json`.
   - Secret : même valeur que `PLANIFIKATEUR_GITHUB_WEBHOOK_SECRET`.
   - Événements : **Pull requests** et **Workflow runs** ; webhook actif.
5. Créer le label `planifikateur-agent` dans GitHub.
6. Laisser une première exécution du workflow **Tests** enregistrer les contrôles.
   Dans la protection de `main`, exiger **Tests serveur** et **Tests navigateur**,
   ainsi qu’une branche à jour avant fusion. Ne pas exiger d’approbation humaine.
   Les restrictions du dépôt doivent permettre au workflow la fusion des PR.

Le workflow effectue directement une fusion squash via l’API GitHub. Il ne
dépend pas du réglage natif **Allow auto-merge**. Il faut que les permissions
`contents: write` et `pull-requests: write` soient autorisées pour GitHub Actions.
Les règles de branche restent appliquées : un refus GitHub ne sera pas contourné.

La configuration distante n’a pas été appliquée depuis l’environnement de
travail : les appels à l’API GitHub de configuration y sont refusés. La création
du webhook, les secrets et les règles de branche restent donc à effectuer dans
les interfaces GitHub et Railway. Aucune fusion réelle n’a été vérifiée.

## Parcours de l’agent

1. Renseigner la description et les critères d’acceptation de la carte, puis
   préparer le travail avec **Livraison → PR GitHub · fusion automatique**.
   Le serveur exige un dépôt et un secret de webhook configurés. L’API utilise
   `delivery: "github"` ; les anciennes exécutions restent inchangées.
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
   nouveau, corriger, pousser et soumettre la nouvelle référence de commit.
7. Si GitHub demande de remettre la branche à jour, retirer le label, utiliser
   `POST .../work/{execution}/revise` avec la version courante pour reprendre
   l’exécution, mettre la branche à jour, pousser puis soumettre à nouveau avant
   de remettre le label. `revise` est réservé à l’agent responsable et renvoie
   une nouvelle réservation.

Les changements ultérieurs de commit rendent l’ancienne soumission inéligible.
Une PR est liée à une seule exécution ; les nouvelles versions de la même PR
peuvent être rattachées à cette exécution.

## Conditions de fusion

Le workflow **Fusion des PR agent** tourne avec le code de `main`, jamais avec
le code de la PR et ses secrets. Il vérifie :

- Une exécution terminée et réussie du bon workflow **Tests**, pour cette PR.
- Les deux jobs requis, présents une seule fois, terminés avec `success`.
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
signé avec le secret, la fait passer **Terminée — PR fusionnée**. Les événements
répétés sont sans effet ; fermer une PR sans fusion ne termine pas la carte.
En cas de webhook perdu, utiliser la redélivraison depuis GitHub. Un échec de
fusion reste visible dans les logs du workflow et ne clôture pas la carte.

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

Les PR de code ne peuvent pas être acceptées manuellement par la route `accept`.
L’annulation humaine reste possible. Une nouvelle demande dans la colonne
**Bugs** suit le même parcours ; indiquer dans la description la carte et la PR
à l’origine du problème facilite le diagnostic.
