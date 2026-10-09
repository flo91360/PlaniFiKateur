# PlaniFiKateur

Un tableau de projets inspiré de Trello, conçu pour préparer des demandes qui pourront ensuite être confiées à des agents IA.

## Première version : interface utilisateur

- Projets indépendants avec leurs listes personnalisées.
- Création, édition et suppression de cartes ; déplacement par glisser-déposer ou depuis le détail.
- Statut indépendant de la liste, priorité, étiquettes et critères d’acceptation.
- Création des cartes depuis leur liste, avec tous les champs disponibles dès le départ : description, statut, priorité, étiquettes, critères et premier commentaire.
- Discussion sur chaque carte, recherche et filtre par statut.
- Interface adaptative, navigation au clavier et sauvegarde locale dans le navigateur.

Les projets et cartes présents au premier lancement sont des exemples. Aucun agent IA n’est connecté. Les données ne sont pas encore partagées entre appareils ou utilisateurs. Effacer le stockage du navigateur efface les modifications locales.

## Développement

Prérequis : Node.js 22 ou 24 et npm. L’interface utilise React et Vite ; les polices sont servies avec l’application.

```sh
cd /workspace/PlaniFiKateur
npm ci
npm run dev -- --port 5173
```

```sh
npm test
npm run build
npm run preview -- --port 4173
```

`npm test` vérifie la génération des identifiants, notamment dans les aperçus HTTP et les lecteurs HTML sans API `crypto`. Ces identifiants servent uniquement aux données locales, jamais à l’authentification.

`npm run test:browser` compile le fichier autonome et vérifie les parcours sur ordinateur et mobile, y compris dans un aperçu intégré qui interdit les soumissions natives de formulaires, avec et sans accès au stockage. Les actions locales passent directement par les clics ; Entrée valide les champs simples, Ctrl/⌘ + Entrée publie un commentaire et Entrée seule conserve les retours à la ligne dans les descriptions.

Ces tests utilisent Chromium installé sur la machine. S’il est absent, installez le navigateur de test avec `npx playwright install chromium`, ou indiquez son chemin via `PLAYWRIGHT_CHROMIUM_EXECUTABLE`.

## Aperçu HTML téléchargeable

```sh
npm run export:preview
```

Le fichier `dist/PlaniFiKateur-apercu-v0.1.4.html` contient l’interface, ses scripts et ses polices. Ouvrez-le dans un navigateur. Une copie déjà téléchargée ne reçoit pas les corrections du serveur : téléchargez et ouvrez le nouveau fichier après une mise à jour. La version est affichée en bas du menu des projets.

## Parcours à vérifier

1. Créer un projet, puis une liste et une carte.
2. Ouvrir la carte, modifier sa description, son statut et sa priorité.
3. Ajouter un critère d’acceptation, le cocher et publier un commentaire.
4. Déplacer la carte vers une autre liste, rechercher son titre et filtrer son statut.
5. Recharger la page et vérifier la conservation des modifications.
6. Vérifier le tableau et le menu des projets sur mobile.

## Prochaines étapes

Valider les parcours et l’organisation visuelle, puis connecter une API et une base PostgreSQL. La délégation aux agents pourra utiliser les mêmes projets, cartes, statuts et critères d’acceptation via cette API.
