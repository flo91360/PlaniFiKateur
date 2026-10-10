# Consignes de travail

## Livraison automatique

Après chaque modification ou fonctionnalité terminée et vérifiée, créer un commit
avec un message explicite puis pousser sur la branche GitHub `main`, sans demander
une nouvelle confirmation. Cette consigne est autorisée par le propriétaire du
projet. Le push peut déclencher le déploiement automatique Railway.

- Exécuter les vérifications adaptées aux fichiers modifiés. Pour le code de
  l’API, utiliser `npm test`. Pour les parcours de l’interface ou les échanges
  entre le site et l’API, utiliser aussi `npm run test:browser`, qui compile le
  site avant de lancer les tests sur ordinateur et mobile.
- Vérifier `git diff --check` avant le commit. Pour une modification uniquement
  documentaire, cette vérification suffit.
- Réutiliser les résultats des vérifications déjà réussies pour le même état du
  code ; ne pas les relancer sans changement ou problème qui le justifie.
- Si les vérifications échouent, corriger avant de pousser. Si un blocage reste,
  expliquer le problème à l’utilisateur et ne pas pousser de code non validé.
- Inclure uniquement les fichiers du travail concerné, sans secrets, base SQLite,
  dépendances installées ni fichiers de compilation. Préserver les modifications
  sans rapport avec la tâche.
- Pousser sans forcer. Si la branche distante a avancé, intégrer ses changements
  et vérifier les éventuelles résolutions avant de pousser.
- Après le push, vérifier que `main` sur GitHub contient le commit et communiquer
  son identifiant avec un bref résumé des vérifications. Ne pas annoncer un
  déploiement Railway réussi sans l’avoir vérifié.

## Environnement du projet

Node.js 24 est requis. Installer les dépendances avec `npm ci`.
La base SQLite persistante est configurée par `PLANIFIKATEUR_DB_PATH` ; ne pas
effacer le volume ou la base pour résoudre un problème de démarrage.
