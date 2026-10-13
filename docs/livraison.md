# Un seul parcours de livraison

Une intervention directe et une carte utilisent les mêmes étapes :

**code → nouvelle version et changelog → vérifications locales → PR → tests
GitHub → fusion automatique → tests de main → tag → vérification du déploiement.**

Le module `worker/delivery.mjs` prépare et contrôle la version et le changelog.
Il est appelé par le worker pour les cartes et par `scripts/delivery.mjs` pour
une session directe. Le choix Codex ou Claude ne change pas ces obligations.

## Préparation commune

Une livraison de code augmente au minimum le correctif par rapport à la branche
cible. Une version majeure ou mineure explicitement supérieure est conservée.
Les profils PlaniFiKateur et DefilOrdi mettent à jour `package.json` et le
lockfile ; FunKart met à jour `config/version` et TrameErgo la version qmake.
PlaniFiKateur synchronise aussi les références courantes dans README.md,
docs/agents.md et docs/github.md.

Une entrée de CHANGELOG.md porte la version, la date de Paris, le titre et un
résumé utile à l'utilisateur. Relancer la préparation avec le même identifiant
remplace cette entrée sans créer de doublon. Les autres versions restent dans
l'historique. Si la branche cible a avancé et déjà publié cette version, la
préparation augmente de nouveau la version avant les tests.

Une demande qui produit uniquement une pièce jointe dans une carte, sans changer
le dépôt, n'est pas une livraison de code : elle ne crée pas de version Git.

## Utilisation en session directe

Créer une branche `livraison/<nom-unique>` depuis main à jour. Implémenter la
demande, puis préparer avec un identifiant stable pendant toute cette livraison :

```sh
npm run delivery:prepare -- --id livraison-menu --title "Menu" --summary "Le menu permet de retrouver les projets."
npm run delivery:check
npm test
npm run test:browser
git diff --check
```

Ne pas réutiliser l'identifiant pour une livraison ultérieure. Inclure les
métadonnées de livraison dans le commit, pousser la branche et ouvrir une PR.
Attendre les tests réussis pour son commit exact et la fusionner automatiquement,
sans demander de validation humaine supplémentaire. Si main avance, intégrer
ses changements, préparer à nouveau et revérifier avant fusion. Ne pas pousser
directement sur main pour contourner les contrôles.

## Utilisation par le worker

L'agent prépare le code et son résumé. Le worker appelle le même module avant les
tests obligatoires de chaque profil, crée le commit, pousse la branche et ouvre
la PR. La préparation et le contrôle utilisent le code installé avec le worker,
sans charger de règle de livraison depuis la branche modifiée.

Le programme de mise à jour AWS doit avoir installé cette version du worker pour
qu'il prépare les nouvelles métadonnées. Une ancienne installation est détectée
par les échecs de contrôle de ses PR ; vérifier sa révision et le timer si elle
persiste. Un push du site ne prouve pas à lui seul que le worker a été remplacé.

## Contrôles GitHub et publication PlaniFiKateur

Le job requis « Tests serveur » commence par `delivery:check`, sur la version de
la PR et sa branche cible. Une version inchangée ou inférieure, un lockfile
incohérent ou un changelog sans entrée pour cette version fait échouer la CI et
bloque la fusion automatique du worker. Ce contrôle vaut pour toutes les PR,
quelle que soit leur origine. La protection de main doit conserver les contrôles
requis et une branche à jour ; un administrateur peut autrement contourner la CI.

Après fusion, le même contrôle s'applique au push de main. Le workflow « Livraison
de version » attend la réussite de « Tests », vérifie le dépôt, le commit exact,
les deux jobs, la dernière tentative et l'absence d'une exécution plus récente.
Il crée le tag annoté `v<version>` sur ce commit, avec les notes de livraison.
Un tag existant sur un autre commit fait échouer la publication ; aucun tag n'est
déplacé. Une relance pour le même commit est possible sans nouvelle version.

Railway reste connecté à main et déclenche son déploiement automatiquement après
la fusion. Ce démarrage peut précéder la fin des tests de main : GitHub vérifie
ensuite, après le tag, que le site sert bien la version **et le SHA complet**
attendus dans `/build-info.json`, sans cache. L'étape « Vérifier le déploiement
Railway » échoue explicitement si la version ne devient pas accessible. Elle
peut être relancée sans recréer le tag ni rappeler le modèle IA. L'URL est la
variable Actions `PLANIFIKATEUR_URL`, avec l'URL actuelle du site par défaut.

Une carte terminée confirme actuellement la fusion par webhook ; le résultat
complet de publication et déploiement est celui du workflow de livraison GitHub.
Les profils des autres dépôts conservent leurs compilations et leur hébergement
propres, avec la même obligation de nouvelle version et de changelog.
