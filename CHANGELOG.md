# Changelog

Modifications livrées par PlaniFiKateur depuis la mise en place de ce journal, de la plus récente à la plus ancienne.

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
