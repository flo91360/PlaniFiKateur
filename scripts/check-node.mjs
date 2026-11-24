// Les tests exigent Node.js 24 (node:sqlite, test runner) : une autre version donnerait des échecs
// trompeurs. `engine-strict` (.npmrc) refuse déjà `npm ci` ; ce contrôle couvre une installation
// existante lancée avec une autre version.
const major = Number(process.versions.node.split('.')[0]);
if (major !== 24) {
  console.error(
    `Node.js 24 est requis (version actuelle : ${process.versions.node}). Utilisez \`nvm use\` (fichier .nvmrc).`,
  );
  process.exit(1);
}
