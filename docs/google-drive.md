# Exécutables dans votre Google Drive

Après les tests et la compilation sur GitHub, les dépôts DefilOrdi et FunKart
peuvent envoyer leurs exécutables dans **un dossier existant de votre compte** :

```text
Votre dossier fourni/
  DefilOrdi/v0.7.1/DefilOrdi-Installation-0.7.1.exe
                  DefilOrdi-Portable-0.7.1.exe
  FunKart/v0.1.1/FunKart.exe
```

Le programme vérifie ce dossier et vos droits avant toute création. Il crée
seulement ses sous-dossiers, conserve les anciennes versions et refuse de
remplacer une version par celle d’un autre commit. Une relance réutilise les
fichiers déjà présents après vérification de leur taille et empreinte MD5.
Les transferts utilisent des blocs de 8 Mo ; les exécutables ne transitent ni par
le worker AWS ni par la base SQLite du site.

## Connecter votre compte une fois

L’accès est celui de **votre compte Google**, avec vos fichiers et votre quota.
Un compte de service n’est pas utilisé pour stocker des fichiers dans votre Drive
personnel. Cette connexion requiert votre consentement dans un navigateur.

1. Dans [Google Cloud Console](https://console.cloud.google.com/), créez ou
   sélectionnez un projet, puis activez **Google Drive API** dans la bibliothèque
   des API.
2. Dans **Google Auth Platform**, configurez l’application OAuth et votre adresse
   de contact. Pour un compte Gmail personnel, choisissez une audience externe.
   Pendant les essais, ajoutez votre compte aux utilisateurs de test.
3. Créez un client OAuth de type **Application de bureau**, puis téléchargez son
   fichier JSON. Gardez-le en dehors du dépôt Git.
4. Pour l’accès durable, passez le statut de publication de l’application en
   **Production** dans la section Audience avant l’autorisation finale. En mode
   Test, Google expire généralement les refresh tokens après sept jours pour
   les scopes Drive. Les règles Google de vérification s’appliquent si vous
   distribuez cette application à d’autres utilisateurs ; ici, vous autorisez
   votre propre compte.
5. Depuis votre clone de PlaniFiKateur, exécutez dans PowerShell (adaptez les
   chemins et utilisez le lien du dossier que vous avez choisi) :

   ```powershell
   node scripts/google-drive-login.mjs --client "$env:USERPROFILE\Downloads\client_secret.json" --folder "https://drive.google.com/drive/folders/IDENTIFIANT" --output "$env:USERPROFILE\google-drive-credentials.json"
   ```

   Ouvrez le lien affiché dans le navigateur sur **le même ordinateur**, choisissez
   votre compte puis autorisez l’accès. Le programme vérifie le dossier et écrit
   le fichier privé ; il ne montre aucun token dans le terminal.

L’autorisation Google demandée est le scope `https://www.googleapis.com/auth/drive`.
Google n’offre pas de scope OAuth limité à un dossier existant fourni par son
lien ; `drive.file` exige un accès préalablement accordé à ce dossier, par exemple
avec Google Picker. Le programme restreint ses opérations au dossier configuré
et à ses descendants, mais le token OAuth possède un accès plus large au niveau
de votre compte. Vous pouvez révoquer l’application dans les autorisations de
votre compte Google. Aucun partage public n’est ajouté : les droits du dossier
continuent de s’appliquer.

## Activer les deux dépôts

Dans **chacun** des dépôts `flo91360/DefilOrdi` et `flo91360/FunKart`, ouvrez
**Settings → Secrets and variables → Actions** :

- Onglet **Secrets** : créez `GOOGLE_DRIVE_CREDENTIALS` avec le contenu du fichier
  privé généré. Ne mettez pas ce contenu dans une carte, un commentaire ou Git.
- Onglet **Variables** : créez `GOOGLE_DRIVE_FOLDER_ID` avec l’identifiant de votre
  dossier existant (la partie du lien située après `/folders/`). Utilisez le même
  identifiant dans les deux dépôts.

Les secrets sont transmis uniquement au job de publication sur `main` après
réussite de la fabrication des exécutables. Les branches de travail et PR ne
reçoivent pas l’authentification Drive. Les publications d’un même dépôt sont
sérialisées pour éviter les créations simultanées de dossiers homonymes.

Pour le premier essai, lancez **Actions → Windows .exe / Construire le jeu →
Run workflow**, branche `main`. La case « publier » de FunKart peut rester décochée.
Les futures mises à jour de `main` déclenchent automatiquement fabrication et
archivage. Sans configuration Drive, le job indique que la publication n’est
pas activée et les tests du projet continuent de fonctionner.

Le worker augmente automatiquement la version corrective des profils DefilOrdi
et FunKart lorsqu’il livre du code, avant les tests. Les modifications manuelles
doivent aussi augmenter `package.json` et son lockfile, ou `config/version` dans
`project.godot`, pour publier de nouveaux exécutables sans écraser les anciens.
Une demande de fichier uniquement joint à une carte n’augmente pas la version.

## Retrouver une version et reprendre un envoi

Le dossier de version contient les `.exe` directement téléchargeables et la
Release GitHub reçoit le lien du dossier Drive. La carte **Infos** du projet
affiche ce lien et les fichiers de la version correspondant à son tag.
Le serveur retrouve ces métadonnées toutes les quinze minutes. Pour une mise à
jour immédiate, activez aussi **Releases** dans les événements du webhook signé
GitHub vers PlaniFiKateur. La date de publication d’une Release ne remplace jamais
la date de push du tag lorsque celle-ci est inconnue.

Si une publication échoue après un envoi partiel, relancez le job de publication
avec **Re-run failed jobs** : les fichiers validés sont réutilisés. Les erreurs de
Drive sont indépendantes des tests des PR et ne relancent pas le modèle IA.
Si Google refuse l’authentification, reconnectez le compte et remplacez le secret
dans les deux dépôts. Si une version existe pour un autre commit, augmentez la
version dans le code au lieu d’effacer son archive.
