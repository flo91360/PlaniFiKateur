# Changelog

Modifications livrées par PlaniFiKateur depuis la mise en place de ce journal, de la plus récente à la plus ancienne.

## 0.1.33 — 2026-10-14
<!-- planifikateur:etape-7-modifications-robustes -->

- **Modifications robustes** : Une modification refusée par le serveur est retirée de la page avec un message expliquant pourquoi, et les autres sont enregistrées : la page ne se fige plus. Critères, pièces jointes et étiquettes s’enregistrent élément par élément, si bien que deux personnes qui cochent la même checklist gardent toutes deux leur coche. Une erreur d’affichage montre un message au lieu d’une page blanche, et le panneau d’exécution indique son chargement au lieu de proposer trop tôt de confier la carte à l’agent.

## 0.1.32 — 2026-10-14
<!-- planifikateur:etape-6-fiabilite-worker -->

- **Fiabilité du worker et des fusions** : Le worker exécute les commandes de ses presets installés, quel que soit le profil reçu du site. Une erreur sur une tâche ou un projet n’arrête plus le traitement des autres cartes. Le serveur rattrape seul les webhooks GitHub perdus en relisant les PR en attente. Après un échec de CI, le modèle reçoit les jobs en échec et la fin de leurs journaux ; au troisième échec consécutif, une personne est consultée, et un contrôle sans verdict n’est plus renvoyé au modèle.

## 0.1.31 — 2026-10-14
<!-- planifikateur:etape-6-securite-serveur -->

- **Sécurité des droits, des suppressions et des sauvegardes** : Un projet supprimé perd son dépôt, ses réglages et l’accès de l’agent, et son identifiant ne peut plus être recréé ; une restauration le ramène avec ses réglages. Les copies avant suppression ne sont faites qu’après le contrôle des droits et ont leur propre rotation. Seul un responsable modifie la demande d’une carte prête, seul l’auteur modifie son commentaire, les liens des cartes Infos ne viennent que du serveur, et la limite de connexion distingue les clients derrière Railway.

## 0.1.30 — 2026-10-14
<!-- planifikateur:3496bcf5-4199-4584-9e12-598d74604a6a -->

- **Apparence** : Ajout d'une section « Apparence » dans « Mon compte » : chaque utilisateur choisit la couleur dominante du site dans une palette fixe, et ce choix est enregistré avec son compte sur le serveur. Rien n'a pu être exécuté dans cet environnement : toutes les commandes shell échouent (bwrap: Can't mount proc). Je n'ai lancé ni `npm run format`, ni `npm test`, ni `npm run test:browser`. Le code est mis en forme à la main et les contrastes ont été calculés à la main. Correction de ce tour : `npm test` signalait un problème de mise en forme Prettier dans `tests/accents.test.js`, sans indiquer la ligne. J'ai réécrit le fichier sans changer ce qu'il vérifie : boucles avec accolades, fonctions nommées au lieu de fonctions fléchées, lignes courtes. Je n'ai pas pu confirmer que Prettier l'accepte maintenant. Fonctionnement : - **Palette** (`src/lib/accents.js`, partagé entre le site et le serveur) : six couleurs, sans sélecteur libre. Forêt est la couleur actuelle du site et reste la couleur par défaut ; s'y ajoutent Océan, Prune, Framboise, Cuivre et Ardoise. - **Interface** : la couleur s'applique tout de suite, et revient à la précédente si l'enregistrement échoue. Le bouton « Rétablir la couleur par défaut » remet Forêt. À la déconnexion, le site revient à la couleur par défaut. - **Éléments concernés** (`src/style.css`) : boutons principaux, liens, contours de focus, cases à cocher, navigation latérale, message de confirmation, onglet du tableau, zones de dépôt, survol des icônes et pastille de l'en-tête. - **Serveur** : nouvelle table `user_preferences`, effacée quand le compte est supprimé. La couleur n'apparaît ni dans les données du compte ni dans la liste des membres. Points que vous pourriez remarquer : - Avec la couleur par défaut, quelques détails changent légèrement. Le contour de focus utilise la couleur principale, car l'ancien vert clair n'atteignait pas le contraste 3:1. La pastille de l'en-tête passe du beige au vert clair. Les liens prennent la couleur princi

## 0.1.29 — 2026-10-14
<!-- planifikateur:livraison-delais-reprise-20261014 -->

- **Reprise du worker après interruption des vérifications** : Délais distincts pour la préparation, le modèle, les tests et la publication ; diagnostic précis dans la carte et reprise des tests sauvegardés sans nouvel appel IA lorsque le contenu est inchangé.

## 0.1.28 — 2026-10-14
<!-- planifikateur:audit-etape-5b-20261014 -->

- **Validation avant fusion et notifications** : Un responsable peut exiger que chaque PR de l’agent soit approuvée avant sa fusion (Paramètres du projet → Validation avant fusion) : la PR attend alors « Approuver la fusion » depuis la carte et apparaît dans la boîte « À traiter », et une correction de l’agent demande une nouvelle approbation. Une cloche dans la barre supérieure affiche en direct les notifications : commentaires, changements de statut, ajout au suivi, changement de droits et étapes de l’agent sur les cartes que l’on a créées, commentées ou que l’on suit.

## 0.1.27 — 2026-10-14
<!-- planifikateur:audit-etape-5a-20261014 -->

- **Droits par projet** : Chaque membre a désormais un rôle sur chaque projet : lecture, contribution ou responsable, ou aucun accès (le projet est alors masqué). Seuls les responsables et les administrateurs confient une carte à l’agent, valident ou font corriger son travail et gèrent le projet ; les contributeurs modifient les cartes, commentent et peuvent annuler une exécution. Les droits se règlent dans « Paramètres du projet → Membres et droits ». Après la mise à jour, les projets existants gardent leur créateur comme responsable et donnent le rôle contribution aux autres membres.

## 0.1.26 — 2026-10-14
<!-- planifikateur:audit-etape-4b-20261014 -->

- **Mises à jour en direct et rétention des données** : Le site reçoit les changements en direct : une carte modifiée par une autre personne, une étape de l’agent ou une question apparaissent aussitôt, sans attendre la prochaine actualisation. Si le flux en direct est indisponible, le site revient à une vérification toutes les 5 secondes. L’historique et les exécutions IA terminées de plus de 365 jours sont supprimés chaque jour (durées réglables, ou désactivables), et une exécution terminée ne conserve plus le contenu des pièces jointes déjà présentes dans la carte. Les lectures des exécutions sont indexées.

## 0.1.25 — 2026-10-14
<!-- planifikateur:audit-etape-4a-20261014 -->

- **Données en tables et enregistrement sans conflit** : Le tableau est rangé dans des tables SQLite (projets, listes, cartes, commentaires, pièces jointes) au lieu d’un seul document. La conversion a lieu au premier démarrage, après une copie de la base existante (planifikateur-avant-tables-….sqlite dans le répertoire des sauvegardes) et une vérification complète : au moindre écart, rien n’est modifié. L’interface n’envoie plus tout le tableau mais seulement ses modifications : deux personnes peuvent modifier en même temps des cartes ou des champs différents sans message « Le tableau a changé », et chaque enregistrement apporte aussi les changements des autres. De nouvelles routes permettent aux intégrations de créer, modifier et supprimer projets, listes, cartes et commentaires.

## 0.1.24 — 2026-10-14
<!-- planifikateur:audit-etape-3-20261014 -->

- **Suivi de l’agent depuis les cartes** : Le détail de chaque carte affiche un panneau « Exécution IA » : étapes, dernier message, lien vers la PR et état des contrôles GitHub, avec des boutons pour confier la carte à l’agent, annuler l’exécution avec un motif, demander des corrections avant la fusion ou relancer l’agent. Une boîte « À traiter », dans la barre supérieure, liste avec un badge les questions de l’agent et les résultats à valider de tous les projets et ouvre la carte concernée en un clic. Modifier la demande d’une exécution en cours ou supprimer sa carte demande désormais une confirmation, avec la possibilité de rétablir la demande.

## 0.1.23 — 2026-10-14
<!-- planifikateur:audit-etape-2-20261014 -->

- **Lisibilité du code** : Le code est réorganisé sans changement de comportement visible. L’interface est découpée en composants (tableau, détail de carte, formulaires, barre latérale…) et tous ses appels passent par un client API unique. Le serveur déclare ses routes dans une table par domaine, vérifiée contre la spécification OpenAPI, et les transitions des exécutions IA suivent une machine d’états explicite et testée. Le worker enchaîne des étapes nommées (préparation, réalisation, vérifications, publication). ESLint refuse désormais tout avertissement, et un test navigateur instable sur mobile a été rendu fiable.

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
