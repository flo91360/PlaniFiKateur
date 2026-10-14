# Changelog

Modifications livrées par PlaniFiKateur depuis la mise en place de ce journal, de la plus récente à la plus ancienne.

## 0.1.22 — 2026-10-14
<!-- planifikateur:audit-etape-1-20261014 -->

- **Hygiène du code et de l’interface** : Les textes de l’interface décrivent le parcours réel de l’agent IA au lieu d’annoncer des agents « bientôt ». Le code est mis en forme par Prettier et contrôlé par ESLint avant chaque lancement de npm test, et un test bloqué échoue après 60 secondes. Les erreurs internes de l’API sont journalisées sans paramètres ni corps de requête. La configuration d’exécution d’un projet n’accepte plus que le profil et la branche : aucune commande ne peut être imposée au worker par l’API. La spécification OpenAPI décrit toutes les routes servies, contrôlées par un test.

## 0.1.21 — 2026-10-13
<!-- planifikateur:worker-liberer-checkouts -->

- **Disque du worker** : Le worker supprime le dossier local d’une tâche dès qu’elle est terminée, y compris pour les tâches terminées avant la mise à jour, afin que le disque du serveur ne se remplisse plus. Les tâches en attente, en revue ou annulées conservent leur dossier.

## 0.1.20 — 2026-10-13
<!-- planifikateur:livraison-controle-base-20261013 -->

- **Livraisons à jour de main** : Une livraison est refusée si elle ne contient pas les derniers changements de main. La CI contrôle cette condition pour toutes les PR. Les abonnements des cartes sont actualisés automatiquement, y compris lors des changements réalisés par une autre personne (PR #22).

## 0.1.19 — 2026-10-13
<!-- planifikateur:livraison-parcours-commun-20261013 -->

- **Parcours de livraison commun** : Les interventions directes et les cartes préparent la même version et le même changelog. GitHub contrôle ces éléments, publie un tag après les tests et vérifie le commit déployé sur Railway.
- **Effort des cartes** : les niveaux d’effort ont été mis à jour dans le sélecteur (PR #20, déjà fusionnée sans nouvelle version).
- **Affectation d’une personne** : possibilité d’abonner un autre membre actif à une carte et d’afficher les membres abonnés (PR #21, déjà fusionnée sans nouvelle version).

## 0.1.18 — 2026-10-13

- **Publication bloquée par un workflow GitHub** : quand GitHub refuse le push parce que la carte modifie un fichier de `.github/workflows/` et que le token du worker n’a pas la permission « workflow », la carte reçoit une question claire (fichiers concernés, permission à ajouter) au lieu d’échecs répétés ; répondre après correction du token relance la publication.
- **Documentation du worker** : la permission Workflows du `PLANIFIKATEUR_GITHUB_TOKEN` est décrite.

## 0.1.17 — 2026-10-13

- **Dicter la description** : un bouton micro sous la description d’une carte transcrit la parole avec la reconnaissance vocale du navigateur (Chrome, Edge, Safari) ; le texte s’ajoute à la description à l’arrêt.
- **Reformuler avec l’IA** : la baguette magique réécrit la description en demande claire pour l’agent avec Claude Code et l’abonnement du propriétaire (`CLAUDE_CODE_OAUTH_TOKEN`), sans rien modifier, en s’appuyant sur le README et CLAUDE.md du dépôt ; les points ambigus donnent lieu à des questions.
- **Workflow de livraison des sessions Claude Code** : CLAUDE.md décrit le parcours systématique (implémentation, tests, version, changelog, README, fusion sur main et tag).
- **Tag de version automatique** : le workflow GitHub « Tag de version » crée `v<version>` dès que la version de package.json change sur main.

## 2026-10-13

- **Changelog de chaque projet** : le worker ajoute à chaque livraison une section à CHANGELOG.md (version, date, titre de la carte et résumé), et la carte Changelog affiche un lien cliquable vers ce fichier.
