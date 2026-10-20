# Changelog

Modifications livrées par PlaniFiKateur depuis la mise en place de ce journal, de la plus récente à la plus ancienne.

## 0.1.68 — 2026-10-20
<!-- planifikateur:audit-constats-moyens -->

- **Réponses à l’agent, documentation, performances, sauvegardes et jeton GitHub** : Répondre en commentaire à une question de l’agent après trois échecs des tests GitHub relance bien trois cycles de correction. Les mentions historiques de version de la documentation ne changent plus à chaque livraison. Le worker, « À traiter » et le suivi des exécutions ne relisent plus tout le tableau ni le contenu des pièces jointes. Supprimer une carte inchangée depuis la dernière sauvegarde ne recopie plus toute la base. Dans l’image Docker, le worker arrête les processus restants de l’agent avant chaque commande Git qui reçoit le jeton GitHub.

## 0.1.67 — 2026-10-20
<!-- planifikateur:audit-lots-et-fichiers-proteges -->

- **Serveur protégé des lots refusés et worker non modifiable par une carte** : Un lot de modifications compte au plus 1 000 éléments et l’isolement de ses refus est borné, avec une limite par compte : un seul compte ne peut plus bloquer le serveur. Une carte ne peut plus modifier le worker, sa chaîne de livraison ni les contrôles de sa fusion : le worker rétablit ces fichiers protégés et l’agent réalise la demande sans eux, sans qu’aucune PR ne soit à approuver.

## 0.1.66 — 2026-10-20
<!-- planifikateur:livraison-defilement-tactile-mobile -->

- **Défilement horizontal rétabli sur mobile** : Sur téléphone, le tableau défile de nouveau d’une liste à l’autre : la barre de défilement collée en bas de l’écran ne ramène plus le tableau en arrière pendant le geste.

## 0.1.65 — 2026-10-18
<!-- planifikateur:test-defilement-fiable -->

- **Modifications concurrentes préservées et tests fiables** : Fermer le détail d’une carte n’envoie plus que les champs modifiés dans ce détail : un titre, une description ou des étiquettes restés tels qu’ils ont été lus ne remplacent plus ce qu’une autre personne vient d’enregistrer. Le test de la barre de défilement attend la fin du calage sur une liste (mobile) ; ces deux échecs intermittents ne bloquent plus le tag d’une livraison.

## 0.1.64 — 2026-10-18
<!-- planifikateur:etape-15b-decoupage -->

- **Code découpé par domaine** : Le stockage sépare les comptes, l’historique et les versions publiées dans server/store/ ; le worker sépare la préparation du dépôt (checkout.mjs) et le suivi des PR (follow-up.mjs) de l’enchaînement des tâches ; les tests navigateur sont rangés par domaine avec un module commun. Aucun changement de comportement.

## 0.1.63 — 2026-10-18
<!-- planifikateur:etape-15a-performances -->

- **Enregistrements rapides et flux d’événements robuste** : Une modification limitée à un projet ne relit et ne réécrit plus que ce projet : sur un grand tableau, l’enregistrement passe de plusieurs secondes à une fraction de seconde. La consultation n’envoie plus le contenu des pièces jointes. Un navigateur qui ne lit plus le flux d’événements est déconnecté puis se reconnecte, au lieu d’accumuler la mémoire du serveur. Les relectures de l’interface partagent un même hook (usePolledResource) et yaml n’est plus qu’une dépendance de développement.

## 0.1.62 — 2026-10-18
<!-- planifikateur:etape-14b-cartes -->

- **Échéance, responsable et archivage des cartes** : Chaque carte peut recevoir une échéance et un responsable, membre du projet, visibles sur le tableau ; une échéance dépassée est signalée. Une carte archivée quitte le tableau et la file de l’agent ; la vue « Archivées » permet de la retrouver et de la restaurer. L’API accepte dueDate, assigneeId et archived, et la consultation des cartes exclut les cartes archivées sauf avec archived=true ou all.

## 0.1.61 — 2026-10-18
<!-- planifikateur:etape-14a-tableau -->

- **Tableau plus pratique** : Une carte glissée se dépose à l’endroit visé dans la liste. Le détail de la carte présente sa liste de contrôle (ajouter, cocher, renommer, retirer un critère) et le tableau sa progression. Les slogans laissent place à des textes utiles et l’auteur d’un premier commentaire est la personne connectée. Les sauvegardes de la base passent dans « Mon compte », avec la gestion des membres. Une base de production neuve commence sans projets de démonstration (PLANIFIKATEUR_DEMO pour choisir).

## 0.1.60 — 2026-10-18
<!-- planifikateur:icone-a-tester -->

- **Icône du statut « À tester »** : Le statut « À tester » d’une carte affiche une fiole orange au lieu d’une coche verte : la livraison n’est pas terminée, son demandeur doit encore la vérifier.

## 0.1.59 — 2026-10-18
<!-- planifikateur:bouton-ca-ne-marche-pas -->

- **Bouton « Ça ne marche pas » sur les cartes à tester** : Quand le test d’une livraison échoue, le bouton « Ça ne marche pas » d’une carte de la liste « À tester » renvoie la demande à l’agent avec ce qui ne va pas : le texte est ajouté en commentaire de la même carte, qui quitte la liste « À tester » et repasse en « Prête à démarrer ».

## 0.1.58 — 2026-10-18
<!-- planifikateur:liste-a-tester -->

- **Liste et statut « À tester »** : La liste « Terminées » et le statut « Terminée » deviennent « À tester » dans tous les projets : une tâche livrée attend d’être vérifiée par son demandeur. Les listes existantes sont renommées au démarrage du serveur.

## 0.1.57 — 2026-10-18
<!-- planifikateur:livraison-barre-defilement-collante -->

- **Barre de défilement toujours visible** : La barre de défilement horizontale du tableau reste collée au bas de l’écran : plus besoin de descendre en bas de la page pour passer d’une liste à l’autre.

## 0.1.56 — 2026-10-17
<!-- planifikateur:etape-13-interface-accessible -->

- **Interface fiable et accessible** : Une carte ouverte reste actualisée (commentaires, statut et fichiers des autres sessions) sans toucher au champ en cours de saisie, et son détail repart de zéro en changeant de carte. Une lecture impossible des exécutions IA s’affiche avec un bouton Réessayer au lieu de bloquer le panneau et le statut. Fermer un formulaire non enregistré (Échap, clic à côté, croix) demande confirmation. Textes secondaires plus contrastés (4,5:1 minimum) et aucune police sous 10 px. Les cartes du tableau sont des articles ouverts par le bouton de leur titre ; le menu mobile fermé est inerte et Échap le referme.

## 0.1.55 — 2026-10-17
<!-- planifikateur:agent-discussion -->

- **Réponses de l’agent dans Discussion** : L’agent répond aux questions de la liste Discussion : quand un responsable pose une question, puis à chaque relance en commentaire, le worker copie le dépôt en lecture seule et publie la réponse dans la discussion de la carte. Aucune branche, aucun commit ni PR ; la carte garde son statut et sa liste. Ces réponses utilisent un modèle plus léger (Haiku avec Claude Code, effort faible avec Codex). Le worker doit être mis à jour pour traiter ces questions.

## 0.1.54 — 2026-10-17
<!-- planifikateur:liste-discussion -->

- **Liste Discussion** : Chaque projet a une liste « Discussion », juste avant Terminées, pour échanger sur le fonctionnement du projet et ses futures évolutions. Ses cartes sont des questions : elles ne sont jamais confiées à l’agent (statut « Prête à démarrer » indisponible, exécution annulée si une carte y est déplacée) et aucune modification n’est effectuée.

## 0.1.53 — 2026-10-16
<!-- planifikateur:liste-terminees-toujours -->

- **Liste Terminées dans tous les projets** : La liste « Terminées » est présente dans chaque projet, même vide, juste avant Infos ; les nouveaux projets la reçoivent dès leur création.

## 0.1.52 — 2026-10-16
<!-- planifikateur:livraison-glisser-listes -->

- **Listes à glisser-déposer** : Les listes d’un projet se réorganisent par glisser-déposer en saisissant leur en-tête ; un repère indique où la liste sera posée et le nouvel ordre est sauvegardé. Les boutons Vers la gauche / Vers la droite restent disponibles au clavier et au toucher.

## 0.1.51 — 2026-10-16
<!-- planifikateur:liste-terminees -->

- **Liste Terminées automatique** : Les tâches terminées sont rangées automatiquement dans une nouvelle liste « Terminées » (à la main ou après la fusion de leur PR), pour que la liste Améliorations et les autres ne gardent que le travail à faire. Les cartes déjà terminées y sont déplacées au démarrage.

## 0.1.50 — 2026-10-16
<!-- planifikateur:etape-12-fiabilite -->

- **Fiabilité du worker et du serveur** : Quand main avance, la PR est mise à jour avec le résultat IA déjà publié, sans nouvel appel au modèle. La consommation est rapportée même sans résultat (question Claude Code, échec Codex). L’état local du worker tolère un fichier corrompu et ne reste plus « en cours » pour une tâche interrompue sur le site. Les synchronisations GitHub d’arrière-plan ne peuvent plus arrêter le serveur. Pièces jointes limitées à 2 Mo par carte et 20 Mo par projet, au lieu de 2 Mo pour tous les projets. Le blocage des connexions est compté par adresse et par compte : un tiers ne peut plus bloquer un titulaire.

## 0.1.49 — 2026-10-16
<!-- planifikateur:masquer-relance-terminee -->

- **Relance masquée sur une tâche terminée** : Le bouton « Relancer l’agent » n’apparaît plus sur une carte dont la PR est fusionnée ; il reste disponible après une annulation.

## 0.1.48 — 2026-10-15
<!-- planifikateur:effort-moyen-par-defaut -->

- **Effort Moyen appliqué aux cartes sans effort** : Une carte sans effort enregistré affichait Moyen dans son détail mais l’agent travaillait avec l’effort par défaut du fournisseur. Le serveur applique désormais Moyen à la prise en charge, comme l’affiche la carte.

## 0.1.47 — 2026-10-15
<!-- planifikateur:controles-annules-silencieux -->

- **Contrôles annulés sans message** : Une exécution des contrôles GitHub annulée parce qu'une nouvelle l'a remplacée n'ajoute plus de message trompeur au journal de la carte.

## 0.1.46 — 2026-10-15
<!-- planifikateur:etape-11-isolation-worker -->

- **Isolation du worker** : L’installation et les tests du projet s’exécutent dans bubblewrap sans accès aux clés ni à l’état du worker, les clés quittent l’environnement du processus, le jeton GitHub ne sert qu’aux échanges avec GitHub, Git n’exécute plus de hooks et une modification de .git par l’agent supprime le checkout, les outils de Claude restent dans le dépôt, et une PR qui modifie ses propres contrôles attend l’approbation d’un responsable.

## 0.1.45 — 2026-10-15
<!-- planifikateur:etape-10b-lisibilite-interface -->

- **Lisibilité de l’interface** : Les composants lisent et enregistrent par des hooks communs (useApiResource, useApiAction, FormStatus), les droits sur le projet viennent d’un contexte au lieu de passer de composant en composant, et les styles sont rangés par zone avec des variables de couleur communes, sans règles mortes.

## 0.1.44 — 2026-10-15
<!-- planifikateur:etape-10a-lisibilite-serveur -->

- **Lisibilité du serveur et suivi de la consommation** : Le parcours des exécutions est découpé en modules par domaine, les profils d’exécution forment un registre déclaratif (dépôts, version, consignes), l’archivage Drive distingue ses erreurs par code, et chaque exécution affiche sa consommation : tentatives, durée, tokens et coût estimé.

## 0.1.43 — 2026-10-15
<!-- planifikateur:etape-9-suivi-agent -->

- **Suivi de l’agent sur le tableau** : Les cartes du tableau affichent ce que fait l’agent (badge), chaque projet et chaque carte ont leur adresse partageable, et les paramètres du projet sont rangés en onglets qui résument leur état.

## 0.1.42 — 2026-10-15
<!-- planifikateur:etape-9a-organiser-sans-glisser -->

- **Organiser le tableau sans glisser-déposer** : Une carte se déplace vers une autre liste et monte ou descend dans la sienne depuis son détail, au clavier ou au toucher. Les listes se renomment, changent de couleur et de place et se suppriment lorsqu’elles sont vides ; les responsables modifient le nom, la description, le symbole et la couleur du projet. Les statistiques ne comptent plus les cartes Infos, et le statut « Flo regarde » devient « À relire ».

## 0.1.41 — 2026-10-15
<!-- planifikateur:worker-fusion-en-attente -->

- **Worker : fusion en attente et sandbox Claude** : Le worker termine les fusions résolues, intègre main et reprend les vérifications. Les conteneurs autorisent le montage isolé de /proc par bubblewrap et les anciennes configurations sont actualisées automatiquement.

## 0.1.40 — 2026-10-15
<!-- planifikateur:4237a24c-578c-4b1a-8c75-d3ba5de92cc8 -->

- **Sauvegarde serveur** : Les sauvegardes serveur ne sont plus accessibles que depuis la fenêtre « Espace personnel » du bandeau latéral ; l’accès en double de la fenêtre « À propos » est retiré. Les tests navigateur trouvent le bouton « Espace personnel » malgré l’initiale de l’avatar dans son nom.

## 0.1.39 — 2026-10-15
<!-- planifikateur:tests-mobile-allegees -->

- **Tests navigateur allégés** : Le projet mobile ne rejoue plus que les tests d’affichage marqués @mobile et la CI réutilise Chromium en cache : les tests navigateur sont nettement plus courts, en CI comme sur le worker.

## 0.1.38 — 2026-10-15
<!-- planifikateur:4eded793-f029-4a29-9a17-22ae66aa3073 -->

- **Visuel** : Ajout d'un espace de 14 px entre le bouton « Nouveau projet » et l'encadré de texte situé juste en dessous dans le bandeau de gauche (src/style.css, règle .new-project, avec un commentaire explicatif). Cause : l'encadré est poussé vers le bas du bandeau par une marge haute automatique. Quand le bandeau manque de hauteur (plusieurs projets ou petit écran), cette marge tombe à zéro et l'encadré se colle au bouton. Avec la nouvelle marge basse du bouton, un petit écart reste visible même quand le bandeau est plein. Quand il y a de la place, l'encadré reste en bas comme avant. Seule la règle de ce bouton change. Les tests du navigateur cliquent sur ce bouton par son nom, qui n'a pas changé. Non vérifié : les commandes shell échouent dans le bac à sable de l'agent (« Can't mount proc »), donc ni le formatage Prettier ni les tests n'ont été lancés, et l'écart n'a pas été constaté à l'écran.

## 0.1.37 — 2026-10-15
<!-- planifikateur:suppression-branches-fusionnees -->

- **Suppression des branches fusionnées** : Le worker supprime la branche d'une PR agent dès qu'il l'a fusionnée, pour ne plus accumuler de branches mortes sur GitHub.

## 0.1.36 — 2026-10-15
<!-- planifikateur:e036cf0d-da0b-451a-9e2d-557226d2f8ed -->

- **Bandeau** : Le bandeau « Exécution IA » apparaît dès la création d’une carte, avec « Créer et confier à l’agent ». Dans la création comme dans le détail, le bouton est actif dès que la description n’est pas vide : un clic enregistre la carte, attend la confirmation du serveur puis la confie à l’agent ; si l’enregistrement échoue, un message s’affiche et rien n’est lancé. L’avancement, le résultat, les contrôles GitHub, la fusion et les interruptions ne sont plus publiés comme commentaires : la discussion ne reçoit plus que les questions de l’agent et les réponses, et le bandeau affiche les vérifications, les livrables, les fichiers joints et un « Journal de l’agent » repliable et daté.

## 0.1.35 — 2026-10-15
<!-- planifikateur:etape-8b-actualisation-par-projet -->

- **Actualisation par projet** : Un changement dans un projet ne fait plus relire tout le tableau aux autres navigateurs : seul ce projet est relu, et un projet masqué n’est jamais annoncé. L’enregistrement ne renvoie plus que les projets modifiés. « À traiter », le suivi des cartes et l’abonnement d’une carte sont relus sur les événements qui les concernent, et non plus à chaque frappe.

## 0.1.34 — 2026-10-14
<!-- planifikateur:etape-8a-lectures-et-pieces-jointes -->

- **Tableau allégé et lectures ciblées** : Le tableau envoyé au navigateur n’inclut plus le contenu des pièces jointes : elles s’affichent et se téléchargent par leur propre route, et l’export JSON les récupère sur le serveur. Les droits, les notifications et les cartes se lisent sans relire tout le tableau, l’historique et l’écriture des modifications sont plus rapides : avec 900 cartes, une modification passe de 181 à 96 ms et le tableau de 4,8 à 2,2 Mo.

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
