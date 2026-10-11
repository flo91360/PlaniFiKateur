import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const html = readFileSync(new URL(`../../dist/PlaniFiKateur-apercu-v${version}.html`, import.meta.url), 'utf8');

for (const mode of ['standalone', 'sandbox-with-storage', 'sandbox-without-storage']) {
  test(`creation and editing in ${mode}`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const embedded = mode !== 'standalone';
    const storageAvailable = mode !== 'sandbox-without-storage';
    const permissions = storageAvailable ? 'allow-scripts allow-same-origin' : 'allow-scripts';
    await page.route('http://planifikateur.test/**', route => {
      const wrapper = `<iframe title="Aperçu" sandbox="${permissions}" src="/app" style="position:fixed;inset:0;width:100%;height:100%;border:0"></iframe>`;
      return route.fulfill({ contentType: 'text/html', body: embedded && route.request().url().endsWith('/wrapper') ? wrapper : html });
    });
    await page.goto(`http://planifikateur.test/${embedded ? 'wrapper' : 'app'}`);
    const app = embedded ? page.frameLocator('iframe') : page;
    const openMenu = async () => {
      const menu = app.getByRole('button', { name: 'Ouvrir les projets', exact: true });
      if (await menu.isVisible()) await menu.click();
    };

    await openMenu();
    await app.getByRole('button', { name: 'Nouveau projet', exact: true }).click();
    await expect(app.getByRole('button', { name: 'Créer le projet', exact: true })).toBeDisabled();
    await app.getByLabel('Nom du projet', { exact: true }).fill('test');
    await app.getByLabel('Présentation', { exact: true }).fill('test');
    await app.getByRole('button', { name: 'Créer le projet', exact: true }).click();
    await expect(app.getByRole('dialog')).toHaveCount(0);
    await expect(app.getByRole('heading', { name: 'test', exact: true })).toBeVisible();
    await expect(app.locator('.project-title p')).toHaveText('test');
    await expect(app.locator('.list-column')).toHaveCount(3);

    await app.getByRole('button', { name: 'Ajouter une liste', exact: true }).click();
    await app.getByLabel('Nom de la liste', { exact: true }).fill('Ma liste');
    await app.getByLabel('Nom de la liste', { exact: true }).press('Enter');
    await expect(app.getByRole('heading', { name: 'Ma liste', exact: true })).toBeVisible();

    await expect(app.getByRole('button', { name: 'Nouvelle carte', exact: true })).toHaveCount(0);
    await app.getByRole('button', { name: 'Ajouter une carte dans Ma liste', exact: true }).click();
    await expect(app.getByLabel('Liste', { exact: true })).toHaveCount(0);
    await app.getByLabel('Titre de la carte', { exact: true }).fill('Ma carte');
    await app.getByLabel('Description', { exact: true }).fill('Première ligne');
    await app.getByLabel('Description', { exact: true }).press('Enter');
    await expect(app.getByRole('dialog')).toHaveCount(1);
    await app.getByLabel('Statut', { exact: true }).selectOption('ready');
    await app.getByLabel('Priorité', { exact: true }).selectOption('high');
    await app.getByLabel('Étiquettes', { exact: true }).fill('UX, Recherche, UX');
    await expect(app.getByRole('heading', { name: /^Critères d’acceptation/ })).toHaveCount(0);
    await app.getByLabel('Votre commentaire').fill('Un premier commentaire');
    await app.getByLabel('Ajouter des fichiers', { exact: true }).setInputFiles({ name: 'bug.txt', mimeType: 'text/plain', buffer: Buffer.from('Étapes du bug') });
    await expect(app.getByRole('link', { name: 'bug.txt', exact: true })).toBeVisible();
    await app.getByRole('button', { name: 'Créer la carte', exact: true }).click();
    await expect(app.locator('.list-column').filter({ has: app.getByRole('heading', { name: 'Ma liste', exact: true }) }).locator('.card')).toHaveCount(1);
    await app.locator('.card').click();
    await expect(app.getByLabel('Déplacer vers', { exact: true })).toHaveCount(0);
    await expect(app.locator('.detail-status')).toContainText('dans Ma liste');
    await expect(app.getByLabel('Statut', { exact: true })).toHaveValue('ready');
    await app.getByLabel('Statut', { exact: true }).selectOption({ label: 'Flo regarde' });
    await expect(app.locator('.detail-status')).toContainText('Flo regarde');
    await expect(app.getByLabel('Priorité', { exact: true })).toHaveValue('high');
    await expect(app.getByLabel('Étiquettes', { exact: true })).toHaveValue('UX, Recherche');
    await expect(app.getByRole('heading', { name: /^Critères d’acceptation/ })).toHaveCount(0);
    await expect(app.getByLabel('Description', { exact: true })).toHaveValue('Première ligne');
    await expect(app.getByText('Un premier commentaire', { exact: true })).toBeVisible();
    await expect(app.getByRole('link', { name: 'bug.txt', exact: true })).toBeVisible();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=', 'base64');
    await app.getByLabel('Ajouter des fichiers', { exact: true }).setInputFiles({ name: 'capture.png', mimeType: 'image/png', buffer: png });
    await expect(app.getByRole('img', { name: 'Aperçu de capture.png', exact: true })).toBeVisible();
    await app.getByRole('button', { name: 'Retirer bug.txt', exact: true }).click();
    await expect(app.getByRole('link', { name: 'bug.txt', exact: true })).toHaveCount(0);

    await app.getByLabel('Votre commentaire').fill('Commentaire par clic');
    await app.getByRole('button', { name: 'Publier', exact: true }).click();
    await expect(app.getByText('Commentaire par clic', { exact: true })).toBeVisible();
    await app.getByLabel('Votre commentaire').fill('Commentaire par raccourci');
    await app.getByLabel('Votre commentaire').press('Control+Enter');
    await expect(app.getByText('Commentaire par raccourci', { exact: true })).toBeVisible();
    await app.getByRole('button', { name: 'Terminé', exact: true }).click();
    await app.getByLabel('Filtrer par statut', { exact: true }).selectOption({ label: 'Flo regarde' });
    await expect(app.locator('.card')).toHaveCount(1);
    await expect(app.locator('.card .status')).toHaveText('Flo regarde');
    await app.getByLabel('Filtrer par statut', { exact: true }).selectOption('ready');
    await expect(app.locator('.card')).toHaveCount(0);
    await app.getByLabel('Filtrer par statut', { exact: true }).selectOption('all');

    if (storageAvailable) {
      await page.reload();
      await openMenu();
      await app.getByRole('navigation', { name: 'Projets' }).getByRole('button', { name: /test/ }).click();
      await app.locator('.card').click();
      await expect(app.getByLabel('Statut', { exact: true })).toHaveValue('flo');
      await expect(app.getByLabel('Priorité', { exact: true })).toHaveValue('high');
      await expect(app.getByText('Un premier commentaire', { exact: true })).toBeVisible();
      await expect(app.getByText('Commentaire par clic', { exact: true })).toBeVisible();
      await app.getByRole('button', { name: 'Terminé', exact: true }).click();
    } else {
      await expect(app.getByRole('alert').filter({ hasText: 'Les modifications restent en mémoire' })).toBeVisible();
    }

    await openMenu();
    await app.getByRole('button', { name: 'Nouveau projet', exact: true }).click();
    await app.getByLabel('Nom du projet', { exact: true }).fill('Projet au clavier');
    await app.getByLabel('Nom du projet', { exact: true }).press('Enter');
    await expect(app.getByRole('heading', { name: 'Projet au clavier', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });
}
