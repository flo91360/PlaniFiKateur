# Consignes de travail

## Livraison commune obligatoire

Une intervention directe et une carte du worker suivent le même parcours, sans
confirmation supplémentaire du propriétaire :

1. Implémenter la demande sur une branche de travail.
2. Préparer une version supérieure à celle de la branche cible, les références
   documentaires et l'entrée correspondante de CHANGELOG.md avec le module
   commun `worker/delivery.mjs`, avant les vérifications.
3. Vérifier la livraison et exécuter les tests requis.
4. Committer les fichiers de la livraison, pousser la branche et ouvrir une PR.
5. Attendre les contrôles GitHub réussis sur le commit exact, puis fusionner
   automatiquement sur main. Aucune revue humaine supplémentaire n'est demandée.
6. Vérifier le tag immuable v<version>, créé par GitHub après les tests de main.
7. Vérifier la version et le commit réellement déployés. Un push ou une fusion
   seuls ne prouvent pas que Railway a déployé la livraison.

Le guide unique est [docs/livraison.md](docs/livraison.md). Le push direct sur main
ne remplace pas ces étapes. Pour une intervention directe, utiliser une branche
`livraison/<nom-unique>` et `npm run delivery:prepare -- --id <id-unique>
--title "Titre" --summary "Résumé utilisateur"`, puis `npm run delivery:check`.
Après les tests, créer la PR, attendre la CI et la fusionner sans redemander
confirmation. En cas d'avancée de main, intégrer ses changements et préparer
à nouveau la livraison avant de vérifier les modifications concernées.

Lorsque `PLANIFIKATEUR_WORKER=1`, l'agent prépare le code et son résumé ; le worker
appelle le même module, teste, committe et publie la PR. L'agent ne committe pas,
ne pousse pas, ne fusionne pas et ne délègue pas lui-même. Cela change seulement
qui exécute les étapes, jamais les obligations de livraison.

- Lancer `npm run format` après les modifications de code : `npm test` vérifie
  d'abord la mise en forme (Prettier) et ESLint, puis exécute les tests Node.
- Pour l'API et le worker : `npm test`. Pour l'interface ou les échanges avec
  l'API : ajouter `npm run test:browser` (compilation incluse).
- Toujours vérifier `git diff --check` avant le commit. Ne pas relancer des
  vérifications déjà réussies sans changement ni problème qui le justifie.
- Corriger les échecs avant publication ; ne pas fusionner une livraison invalide.
- N'inclure que les fichiers concernés, sans secrets, SQLite, dépendances ou
  compilation. Préserver les modifications sans rapport avec la tâche.
- Pousser sans forcer. Préserver les versions déjà publiées et leurs tags.
- Confirmer le commit sur GitHub, le tag et les résultats des contrôles. Ne pas
  annoncer un déploiement réussi sans avoir vérifié le site.

## Environnement du projet

Node.js 24 est requis. Installer les dépendances avec `npm ci`.
La base SQLite persistante est configurée par `PLANIFIKATEUR_DB_PATH` ; ne pas
effacer le volume ou la base pour résoudre un problème de démarrage.
