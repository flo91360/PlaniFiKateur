# Archivage des exécutables dans votre Google Drive

Le serveur PlaniFiKateur copie automatiquement les `.exe` publiés dans les
Releases GitHub de chaque projet vers **un dossier existant de votre Drive** :

```text
Votre dossier/
  DefilOrdi/v0.7.1/DefilOrdi-Installation-0.7.1.exe
                   DefilOrdi-Portable-0.7.1.exe
  FunKart/v0.2.0/FunKart.exe
```

Le sous-dossier du projet porte le nom de son dépôt GitHub, celui de la version
le tag de la Release.

## Versions gardées

Pour économiser le stockage, seules les **trois dernières versions** de chaque
dépôt restent dans le Drive (ordre des numéros : `v1.10.0` est plus récent que
`v1.9.0`). Après chaque vérification, les dossiers des versions plus anciennes
sont mis à la **corbeille du Drive** ; leurs `.exe` restent téléchargeables dans
les Releases GitHub. Google vide la corbeille au bout de 30 jours : la place
n’est libérée qu’à ce moment, ou tout de suite en vidant la corbeille. Les
versions plus anciennes que les trois dernières ne sont pas envoyées.

Seuls les dossiers de version créés par l’archivage pour ce dépôt sont
concernés : un dossier ajouté à la main n’est jamais retiré. La variable
`PLANIFIKATEUR_GOOGLE_DRIVE_KEEP` du serveur change le nombre de versions
gardées ; `0` les garde toutes.

## Ajouter un projet

1. Dans **Paramètres du projet**, renseigner son dépôt GitHub (`propriétaire/dépôt`).
2. Le dépôt publie une **Release GitHub** dont le tag est une version
   (`v1.2.3` ou `1.2.3`) avec ses `.exe` en pièces jointes.

C’est tout : aucun secret ni workflow Drive n’est nécessaire dans le dépôt du projet.

Le serveur consulte les dix dernières Releases de chaque dépôt toutes les quinze
minutes, au démarrage et à chaque enregistrement d’un dépôt. Pour un archivage
immédiat, cocher aussi l’événement **Releases** dans le webhook GitHub signé vers
PlaniFiKateur (voir [le guide GitHub](github.md)). Les brouillons, les tags qui ne
sont pas des numéros de version et les fichiers autres que `.exe` sont ignorés ;
au plus dix `.exe` par Release.

Une Release doit correspondre à une version : publier une nouvelle version pour
chaque nouvelle compilation. Si les `.exe` d’une version déjà archivée sont
remplacés sur GitHub, l’archive existante est conservée et le panneau indique
« fichiers différents pour une version existante ». Augmenter la version pour
archiver la nouvelle compilation.

## Suivre l’archivage

**Paramètres du projet → Archivage des .exe sur Google Drive** affiche, pour les
dernières versions, leur état, le lien du dossier Drive et l’erreur éventuelle.
L’administrateur peut **Vérifier les Releases maintenant**. Une erreur passagère
(téléchargement interrompu, Google indisponible) est retentée automatiquement,
avec un délai croissant de 15 minutes à 24 heures.

La carte **Version** de la liste Infos ne pointe plus vers le Drive : elle
télécharge l’exe directement depuis la Release GitHub de la version courante (la
page de la Release quand elle contient plusieurs `.exe`). Le lien du dossier
Drive n’y apparaît que si la Release ne porte aucun `.exe`.

## Fonctionnement et sécurité

- Chaque `.exe` est téléchargé sur le volume du serveur, dans un dossier temporaire
  supprimé après l’envoi. Sa taille et son empreinte SHA-256 annoncées par GitHub
  sont vérifiées avant tout envoi.
- L’envoi se fait par blocs de 8 Mo ; Google confirme ensuite la taille et
  l’empreinte MD5 du fichier reçu.
- Une version déjà archivée pour un autre commit n’est jamais remplacée. Une
  relance réutilise les fichiers identiques déjà présents.
- Les dépôts publics ne demandent aucun accès GitHub. Pour un dépôt privé,
  définir `PLANIFIKATEUR_GITHUB_TOKEN` sur le serveur, avec la lecture du contenu
  (Contents: Read) de ce dépôt.

## Connecter votre compte Google (une seule fois)

L’accès est celui de **votre compte Google**, avec vos fichiers et votre quota.

1. Dans [Google Cloud Console](https://console.cloud.google.com/), créer ou
   sélectionner un projet, puis activer **Google Drive API**.
2. Dans **Google Auth Platform**, configurer l’application OAuth (audience
   externe pour un compte Gmail personnel) et ajouter votre compte aux
   utilisateurs de test.
3. Créer un client OAuth de type **Application de bureau** et télécharger son
   fichier JSON, en dehors du dépôt Git.
4. Passer le statut de publication de l’application en **Production** avant
   l’autorisation finale. En mode Test, Google expire l’accès après environ sept
   jours et l’archivage s’arrête avec « Authentification Google refusée ».
5. Depuis un clone de PlaniFiKateur, dans PowerShell :

   ```powershell
   node scripts/google-drive-login.mjs --client "$env:USERPROFILE\Downloads\client_secret.json" --folder "https://drive.google.com/drive/folders/IDENTIFIANT" --output "$env:USERPROFILE\google-drive-credentials.json"
   ```

   Ouvrir le lien affiché dans le navigateur du même ordinateur et autoriser
   l’accès. Le programme vérifie le dossier et écrit le fichier privé.
6. Dans le service Railway du site, onglet **Variables** :
   - `PLANIFIKATEUR_GOOGLE_DRIVE_CREDENTIALS` : le contenu du fichier privé ;
   - `PLANIFIKATEUR_GOOGLE_DRIVE_FOLDER` : le lien ou l’identifiant du dossier ;
   - facultatif, `PLANIFIKATEUR_GOOGLE_DRIVE_KEEP` : nombre de versions gardées
     par dépôt (3 par défaut, `0` pour toutes).

   Railway redéploie le site ; le panneau d’archivage indique alors son état.

Le scope demandé est `https://www.googleapis.com/auth/drive` : Google n’offre pas
de scope limité à un dossier existant. Le serveur n’opère que dans le dossier
configuré et ses sous-dossiers, mais le jeton a un accès plus large à votre Drive :
ne le placez jamais dans une carte, un dépôt ou un journal. Vous pouvez révoquer
l’application dans les autorisations de votre compte Google ; il faut ensuite
refaire l’étape 5 et remplacer la variable Railway.

## API

- `GET /api/v1/projects/{id}/drive` (membre connecté) : état de l’archivage du
  dépôt du projet et des dernières versions, sans aucun secret.
- `POST` sur cette route (administrateur) : lance une vérification immédiate des
  Releases ; répond `202` avec l’état courant.
