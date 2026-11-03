# Changelog

Modifications livrées par PlaniFiKateur depuis la mise en place de ce journal, de la plus récente à la plus ancienne.

## 0.1.101 — 2026-11-03
<!-- planifikateur:licences-logiciel -->

- **Licences du logiciel d’un projet** : Les responsables d’un projet créent, désactivent ou prolongent dans Paramètres → Licences une clé par personne autorisée à lancer l’exécutable du dépôt. Le logiciel l’échange contre un jeton signé Ed25519, vérifié hors ligne et renouvelé en silence ; une licence désactivée ou expirée cesse de fonctionner au plus tard 30 jours après.

## 0.1.100 — 2026-11-03
<!-- planifikateur:telechargement-exe-reserve -->

- **Téléchargement de l’exe réservé aux comptes du projet** : L’exécutable d’une Release GitHub se télécharge désormais par PlaniFiKateur, réservé aux comptes qui voient le projet : le serveur redirige vers l’adresse signée et temporaire fournie par GitHub. Un dépôt privé reste ainsi téléchargeable sans compte GitHub, et le jeton n’est jamais transmis au navigateur.

## 0.1.99 — 2026-11-03
<!-- planifikateur:discussion-ergo -->

- **Réponses de la colonne Discussion** : Dans la colonne Discussion de tous les projets, l’agent s’adresse désormais à une ergothérapeute qui ne connaît pas la programmation : réponses courtes et claires, avec des mots simples, sans jargon ni nom de fichier, et détails techniques seulement si on les demande. Le worker n’interrompt plus une carte quand une prolongation de réservation croise la soumission de son résultat.

## 0.1.98 — 2026-11-03
<!-- planifikateur:moins-de-notifications-push -->

- **Moins de notifications sur le téléphone** : Pour une carte, seul le résultat final ou une étape qui vous attend devient une notification : question de l’agent, résultat ou PR à valider, carte terminée ou passée « À tester », tests GitHub en échec après les corrections de l’agent, exécution interrompue ou annulée. Les étapes intermédiaires (PR proposée qui fusionnera seule, contrôles GitHub réussis ou relancés pour correction, fusion approuvée, corrections demandées) restent dans l’historique et le bandeau « Exécution IA » de la carte, sans notification ni dans la cloche ni sur le téléphone. Chaque notification de la cloche arrive donc sur le téléphone, et la pastille de l’icône reste égale au nombre de non lues sans ouvrir l’application. Les commentaires, changements de statut faits par une personne, ajouts au suivi, cartes supprimées et droits modifiés notifient toujours.

## 0.1.97 — 2026-11-03
<!-- planifikateur:d81288dc-59ce-4a20-8386-8d62c99dd0b9 -->

- **Notifications** : La pastille rouge se met maintenant à jour sans ouvrir l'application, à chaque nouvelle notification du compte. Les 358 tests serveur passent. Les tests navigateur n'ont pas été lancés ici, le worker s'en charge. **Cause :** la pastille compte toutes les notifications de la cloche. Mais le serveur ne prévenait le téléphone que pour quelques étapes de l'agent (question, résultat à valider, tests en échec, carte à tester, exécution interrompue). Un commentaire, un changement de statut ou une autre étape de l'agent ajoutait donc une notification non lue sans prévenir le téléphone. La pastille ne bougeait qu'à l'ouverture de l'application. **Ce qui change :** - **Toutes les notifications sont envoyées au téléphone**, chacune avec le nombre actuel de non lues. Cela comprend les commentaires, les changements de statut, les cartes supprimées, l'ajout au suivi d'une carte, les droits modifiés sur un projet et toutes les étapes de l'agent (annulation, corrections demandées, fusion approuvée, contrôles GitHub…). Chaque message a un titre clair et indique qui a fait l'action, par exemple « Nouveau commentaire — Menu · Site, Bob a ajouté un commentaire ». - **Pas de rafale** : quand une même action produit plusieurs notifications, par exemple la suppression d'un projet, chaque personne ne reçoit qu'un seul message, avec le bon total sur la pastille. **Limites à connaître :** - **Chaque mise à jour de la pastille s'accompagne d'une notification visible.** Les navigateurs, et l'iPhone en particulier, l'imposent : ils ne permettent pas de changer la pastille sans afficher de notification. - **Après lecture sur un autre appareil**, la pastille de ce téléphone ne baisse qu'à l'ouverture de l'application ou au message suivant, pour la même raison. **Fichiers modifiés :** - `server/push.js` : un message pour chaque type de notification. - `server/store.js` : envoi au téléphone de toute notification, un seul envoi par personne et par action. - `tests/push.test.js` : un nouveau test vér

## 0.1.96 — 2026-11-03
<!-- planifikateur:c3d5af0f-34b3-4b59-8b27-845218568c46 -->

- **Notifications téléphones** : Oui, c'est fait : quand le site est installé sur l'écran d'accueil, son icône affiche maintenant une pastille rouge avec le nombre de notifications non lues du compte. Les 357 tests serveur passent. Les tests navigateur n'ont pas été lancés ici, le worker s'en charge. - **Application fermée** : chaque notification envoyée au téléphone contient le nombre actuel de notifications non lues. Le téléphone l'affiche sur l'icône dès réception. - **Application ouverte** : la pastille suit le compteur de la cloche et disparaît quand tout est lu. **Limites à connaître :** - **Envois** : le serveur ne prévient le téléphone que pour les étapes de l'agent qui vous attendent (question, résultat à valider, tests en échec, carte à tester). Un commentaire seul ne met donc à jour la pastille qu'à la prochaine ouverture de l'application, mais il est bien compté. - **Après lecture** : quand vous lisez vos notifications sur un autre appareil, la pastille de ce téléphone ne baisse qu'à l'ouverture de l'application ou à la notification suivante. - **Appareils compatibles** : la pastille fonctionne sur iPhone et iPad en iOS 16.4 ou plus, avec les notifications activées depuis l'icône de l'écran d'accueil. Sur Android, cela dépend du lanceur. Sur ordinateur, Chrome et Edge l'affichent. Fichiers modifiés : - `server/push.js` - `public/sw.js` - `src/lib/use-notifications.js` - `tests/push.test.js` - `docs/accounts.md` Le test push vérifie que le message envoyé contient bien le compteur, qui passe de 1 à 2 avec une seconde notification non lue. Au lancement de `npm test`, la vérification du formatage a échoué : elle n'a pas pu lire des fichiers de config personnels présents dans le dossier de travail (`.zshrc`, `.vscode`, etc.), sans rapport avec cette carte. J'ai donc vérifié séparément le formatage et le lint des fichiers modifiés, qui sont propres.

## 0.1.95 — 2026-11-02
<!-- planifikateur:2d085541-fe3f-4314-b198-1662881813cc -->

- **Notifications Iphone** : Je ne peux pas dire avec certitude pourquoi rien n'arrive sur ton iPhone : le serveur ne garde aucune trace de la réponse d'Apple, donc la cause n'est pas visible d'ici. J'ai repéré quatre causes possibles et ajouté de quoi la voir. Les tests serveur passent ; le test navigateur n'a pas pu tourner ici (Chromium ne démarre pas dans cet environnement) et sera lancé par le worker. **Causes possibles :** 1. **Le site n'est pas ouvert depuis l'icône de l'écran d'accueil.** Sur iPhone, les notifications ne marchent que dans ce cas, avec iOS 16.4 ou plus récent. Les activer dans les Réglages de l'iPhone ne suffit pas : il faut toucher « Activer les notifications » dans Mon compte, depuis l'icône. 2. **Seules certaines étapes de l'agent sont envoyées** sur le téléphone : question, résultat ou PR à valider, tests en échec, carte à tester, exécution interrompue. Rien n'est envoyé pour une action que tu as faite toi-même. Les commentaires et changements de statut restent seulement dans la cloche du site. 3. **Le serveur a pu oublier ton iPhone alors que l'appli affichait encore « abonné ».** Ça arrive si Apple a refusé un envoi une fois, si la base a été restaurée, ou avec le passage récent au VPS. Avant cette correction, rien ne réenregistrait l'appareil. 4. **Apple peut avoir refusé les envois sans que tu le voies.** Le journal du serveur indiquait seulement le code d'erreur, sans la raison donnée par Apple. **Ce que j'ai changé :** - **Bouton « Envoyer une notification de test »** dans Mon compte → Notifications sur cet appareil. Il envoie une vraie notification et affiche soit « envoyée », soit la raison du refus d'Apple en clair (par exemple : « Le service de notification d'Apple a refusé l'identification du serveur (HTTP 403, BadJwtToken) : désactivez puis réactivez les notifications »). - **Réenregistrement automatique** : à chaque ouverture du site, l'iPhone renvoie son abonnement au serveur. S'il avait été fait avec une ancienne clé du serveur, il est retiré et le bou

## 0.1.94 — 2026-11-02
<!-- planifikateur:retrait-approbation-dependances -->

- **Retrait de l’approbation des dépendances** : Une carte qui ajoute ou change une dépendance est de nouveau fusionnée automatiquement dès que la CI est verte, sans approbation. La règle « aucune intervention humaine dans le déploiement » est inscrite dans CLAUDE.md et AGENTS.md.

## 0.1.93 — 2026-11-02
<!-- planifikateur:site-sur-le-vps -->

- **Site hébergé sur le VPS** : Le site peut tourner sur le VPS du worker, sans Railway : image Docker construite depuis le commit testé, HTTPS automatique par Caddy, mise à jour toutes les deux minutes avec retour à la version précédente si le nouveau site ne sert pas le bon commit, reprise des données depuis la dernière copie quotidienne. Le worker est recréé quand son fichier de variables change. Guide de bascule dans docs/vps.md.

## 0.1.92 — 2026-11-02
<!-- planifikateur:notifications-web-push -->

- **Notifications sur l’appareil (Web Push)** : Mon compte → Notifications sur cet appareil abonne le navigateur (ou le site installé sur iPhone) aux notifications système : question de l’agent, résultat à valider, PR à approuver, tests en échec, exécution interrompue et carte à tester. Envoi chiffré (RFC 8291) et identifié par VAPID (RFC 8292) avec les seuls modules de Node, vers les services de notification connus uniquement.

## 0.1.91 — 2026-11-02
<!-- planifikateur:approbation-dependances -->

- **Approbation exigée quand les dépendances changent** : Une carte qui ajoute ou modifie une dépendance (manifeste npm, paquets du lockfile, ou manifeste d’un autre écosystème comme requirements.txt, Cargo.toml ou go.mod) publie toujours sa PR, mais sa fusion attend qu’un responsable approuve son commit. La carte liste les changements à vérifier. Une dépendance retirée et la version du projet dans le lockfile ne demandent rien.

## 0.1.90 — 2026-11-02
<!-- planifikateur:indicateur-worker -->

- **Indicateur du worker dans la barre du haut** : La barre du haut montre l’état du worker IA : prêt, au travail ou silencieux, avec le nombre de cartes en cours et en attente. Un clic ouvre son détail : dernier contact, révision en service, et cartes en cours de réalisation, en attente de l’agent dans l’ordre de prise en charge et en tests GitHub, chacune ouvrable directement. Nouvelle route GET /api/v1/worker-activity.

## 0.1.89 — 2026-11-02
<!-- planifikateur:controle-dependances -->

- **Contrôle des dépendances et de l’image du worker** : Un nouveau workflow « Dépendances » signale chaque semaine, et à chaque modification d’un lockfile ou du worker, les vulnérabilités élevées des dépendances du site et du worker (npm audit), et construit l’image Docker du worker comme la mise à jour du VPS, pour voir un Dockerfile cassé avant le déploiement. Les dépendances body-parser, qs et fast-uri sont mises à jour pour corriger les alertes en cours.

## 0.1.88 — 2026-11-02
<!-- planifikateur:sauvegarde-vps-quotidienne -->

- **Copie quotidienne des données sur le VPS** : Le VPS du worker peut conserver chaque jour une copie des données du site hors de Railway : il récupère la dernière sauvegarde avec une clé dédiée (PLANIFIKATEUR_BACKUP_TOKEN), la vérifie, la compresse et garde une copie par jour sur 7 jours, par semaine sur 4 semaines et par mois sur 6 mois. La section Sauvegardes affiche la dernière copie confirmée, et l’administrateur est alerté si aucune copie n’a été confirmée depuis deux jours. Mise en place décrite dans docs/backups.md.

## 0.1.87 — 2026-11-02
<!-- planifikateur:surveillance-worker -->

- **Surveillance du worker IA** : Le site sait si le worker IA tourne : chaque requête du worker enregistre son dernier contact, et l’administrateur voit une alerte après 15 minutes de silence. La mise à jour automatique du VPS envoie au site le résultat de chaque passage (à jour, en attente ou en échec) ; un échec qui dure plus de 15 minutes est signalé. La révision du worker apparaît dans le diagnostic des projets et dans le panneau Connexion de l’agent.

## 0.1.86 — 2026-11-02
<!-- planifikateur:fenetre-echap-saisie -->

- **Saisie protégée même avec Échap immédiat** : Un Échap tapé juste après la frappe dans une fenêtre (nouvelle carte, liste, modification) demande toujours confirmation avant de perdre la saisie. La fenêtre apprenait la saisie un rendu trop tard et pouvait se fermer sans prévenir ; ce décalage faisait aussi échouer un test navigateur de temps en temps.

## 0.1.85 — 2026-11-02
<!-- planifikateur:plafond-depense-ia -->

- **Plafond de dépense IA par exécution** : Une exécution ne peut plus consommer sans limite : au-delà de 10 $ estimés avec Claude Code, ou de 20 millions de tokens avec Codex, depuis le début de l’exécution ou la dernière réponse, l’agent s’arrête et demande l’accord sur la carte, qui passe À préciser. Répondre accorde une nouvelle tranche et reprend la même conversation. Les plafonds se règlent sur le worker (PLANIFIKATEUR_WORKER_MAX_COST_USD, PLANIFIKATEUR_WORKER_MAX_TOKENS). Le coût d’une conversation Claude Code reprise n’est plus compté deux fois.

## 0.1.84 — 2026-11-02
<!-- planifikateur:quota-github-worker -->

- **Quota GitHub du worker préservé** : Le worker interroge beaucoup moins GitHub : une PR en attente de fusion est relue au plus une fois par minute, aussitôt si le site signale un changement (résultat des tests, validation), et ses contrôles ne sont plus consultés tant qu’une validation manque. La configuration des projets est recontrôlée toutes les 15 minutes au lieu de chaque minute. Une PR en attente ne peut plus épuiser le quota de 5 000 requêtes par heure et bloquer les autres projets.

## 0.1.83 — 2026-11-01
<!-- planifikateur:sauvegardes-cinq-max -->

- **Cinq sauvegardes conservées** : Le serveur ne garde plus que les 5 dernières sauvegardes de chaque sorte (régulières et d’avant suppression) au lieu de 28, ce qui libère le volume. Les copies en trop sont supprimées à la prochaine sauvegarde ; PLANIFIKATEUR_BACKUP_KEEP permet toujours d’en garder davantage.

## 0.1.82 — 2026-11-01
<!-- planifikateur:railway-veille-compression -->

- **Réduire la consommation sur Railway** : Compression brotli/gzip des fichiers de l’interface (précompressés à la compilation) et des réponses JSON de l’API, hors flux d’événements. Un onglet masqué depuis une minute ferme son flux et suspend ses lectures périodiques, pour que le service puisse se mettre en veille. Plus de copie complète de la base à chaque démarrage quand rien n’a changé ; vérifications GitHub espacées (PR toutes les 15 minutes, versions toutes les heures).

## 0.1.81 — 2026-11-01
<!-- planifikateur:icone-site-fk -->

- **Icône du site** : Le site a désormais une icône FK : elle s’affiche dans l’onglet du navigateur et sur l’écran d’accueil d’un téléphone lorsqu’on y ajoute PlaniFiKateur.

## 0.1.80 — 2026-10-30
<!-- planifikateur:compteur-a-explorer -->

- **Cartes à explorer dans le récapitulatif** : Le récapitulatif en haut d’un projet affiche le nombre de cartes encore « À explorer », c’est-à-dire les demandes à finir de saisir.

## 0.1.79 — 2026-10-28
<!-- planifikateur:theme-sombre -->

- **Thème sombre** : Le site propose un thème sombre : il suit le réglage du système par défaut, se bascule depuis l’en-tête et se choisit dans Mon compte, mémorisé sur l’appareil.

## 0.1.78 — 2026-10-28
<!-- planifikateur:arret-archivage-drive -->

- **Archivage Google Drive retiré** : Le serveur ne copie plus les .exe des Releases GitHub dans Google Drive : le service d’archivage, sa route /api/v1/projects/{projectId}/drive, son panneau dans les paramètres du projet et les scripts Google Drive sont retirés. Les exe se téléchargent depuis GitHub par la carte Version ; rien n’est supprimé dans le Drive.

## 0.1.77 — 2026-10-28
<!-- planifikateur:exe-github-carte-version -->

- **Exe téléchargé depuis GitHub** : La carte Version de chaque projet télécharge l’exe directement depuis sa Release GitHub (la page de la Release s’il y a plusieurs .exe) au lieu du dossier Google Drive, qui ne sert plus qu’en l’absence d’exe dans la Release. L’archivage Drive continue pour l’instant.

## 0.1.76 — 2026-10-25
<!-- planifikateur:profil-autocorrectnepsy-livraison -->

- **AutoCorrectNEPSY livré comme les autres projets** : Le profil AutoCorrectNEPSY suit le nouveau workflow du dépôt : jobs Version, tests Linux et Windows et Exécutable Windows exigés avant la fusion, changelog au format [x.y.z] attendu par sa CI, contrôle de version packaging/verifier_version.py protégé.

## 0.1.75 — 2026-10-24
<!-- planifikateur:profil-autocorrectnepsy -->

- **Profil AutoCorrectNEPSY pour le paquet Python** : Nouveau profil d’exécution AutoCorrectNEPSY : environnement virtuel Python dans .planifikateur/venv, installation du paquet et tests pytest, jobs tests (3.10) et tests (3.12) du workflow Tests exigés avant la fusion, version augmentée ensemble dans pyproject.toml et __version__, .gitignore protégé car le dépôt est public. L’image du worker ajoute python3-venv et le contrôle des outils vérifie Python 3.10 ou plus.

## 0.1.74 — 2026-10-23
<!-- planifikateur:profil-trameergo-tauri -->

- **Profil TrameErgo pour l’application Vue et Tauri** : Le profil TrameErgo suit la nouvelle application tablette (Vue 3 et Tauri) : installation, tests Vitest et construction dans tablette/ avec Node 22, jobs tablette et build exigés avant la fusion, version augmentée ensemble dans package.json, son lockfile, Cargo.toml et Cargo.lock, et changelog au format attendu par sa CI. Le contrôle Qt est retiré.

## 0.1.73 — 2026-10-23
<!-- planifikateur:worker-droits-lecture -->

- **Mises à jour du worker rétablies** : L’image du worker rend son code lisible par l’utilisateur node, même quand le dépôt du VPS est récupéré avec un umask 077. Les mises à jour automatiques du worker AWS, bloquées depuis la 0.1.46, peuvent de nouveau aboutir.

## 0.1.72 — 2026-10-23
<!-- planifikateur:lien-drive-carte-version -->

- **Lien Drive sur la carte Version** : La carte Version de la liste Infos affiche directement un lien vers le dossier Google Drive de la version, comme les cartes Mode d’emploi et Changelog vers GitHub.

## 0.1.71 — 2026-10-22
<!-- planifikateur:retrait-liste-controle -->

- **Retrait de la liste de contrôle** : La liste de contrôle n’apparaît plus dans le détail des cartes ni sur le tableau : l’agent IA ne s’en servait pas. Les critères déjà enregistrés restent en base.

## 0.1.70 — 2026-10-21
<!-- planifikateur:drive-trois-versions -->

- **Drive : seules les trois dernières versions gardées** : Pour économiser la place du Drive, l’archivage ne garde que les trois dernières versions de chaque dépôt : les dossiers des versions plus anciennes vont à la corbeille du Drive, et leurs .exe restent dans les Releases GitHub. Le nombre se règle avec PLANIFIKATEUR_GOOGLE_DRIVE_KEEP (0 pour tout garder).

## 0.1.69 — 2026-10-20
<!-- planifikateur:audit-constats-bas -->

- **En-têtes de sécurité, erreurs tardives, dépendances à jour et finitions de l’audit** : Les pages du site interdisent les scripts externes et l’affichage dans un autre site, et les fichiers compilés restent en cache. Une erreur survenue pendant un flux ou un téléchargement ne peut plus arrêter le serveur. Vite passe en version 8 et lucide-react en version 1 ; les actions GitHub sont épinglées par empreinte et l’isolation du worker est réellement testée en CI. Les petits textes passent à 11 px, plusieurs panneaux utilisent les outils communs de chargement et de messages, et la documentation de l’API et du parcours agent est complétée.

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
