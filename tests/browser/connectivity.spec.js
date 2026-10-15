import { createHmac } from 'node:crypto';
import { driveReleaseBody } from '../../src/lib/drive-release.js';
import { test as base, expect } from '@playwright/test';
import { createAppServer } from '../../server/index.js';
import { createStore } from '../../server/store.js';
import { seed } from '../../src/data/demo.js';
import { isSystemCard } from '../../src/lib/infos.js';
import { createBackups } from '../../server/backups.js';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedAccount, testEmail, testPassword } from '../helpers/accounts.mjs';
import { createRefiner } from '../../server/refine.js';
import { readWorkspace } from '../../server/workspace-tables.js';

const ownerToken = 'owner-browser-test-key';
const readToken = 'agent-browser-test-key';
const test = base.extend({
  githubEnabled: [false, { option: true }],
  initialAccounts: [true, { option: true }],
  driveArchive: [null, { option: true }],
  refiner: [null, { option: true }],
  repositoryContext: [null, { option: true }],
  appServer: async ({ initialAccounts, githubEnabled, driveArchive, refiner, repositoryContext }, use) => {
    const store = createStore(':memory:');
    const user = initialAccounts ? seedAccount(store) : null;
    if (githubEnabled) {
      const initial = store.read();
      initial.projects.forEach(p =>
        p.cards.forEach(c => {
          c.status = 'draft';
        }),
      );
      store.write(initial.projects, initial.revision, user);
    }
    const dir = mkdtempSync(join(tmpdir(), 'planifikateur-browser-backups-'));
    const backups = createBackups(store, { directory: dir });
    const server = createAppServer({
      store,
      config: {
        ownerToken,
        readToken,
        backups,
        githubWebhookSecret: githubEnabled ? 'browser-github-secret' : '',
        ...(driveArchive ? { driveArchive } : {}),
        ...(refiner ? { refiner } : {}),
        ...(repositoryContext ? { repositoryContext } : {}),
      },
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await use(`http://127.0.0.1:${server.address().port}`);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    backups.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  },
});
const login = async (page, url) => {
  await page.goto(url);
  await page.getByLabel('Adresse e-mail', { exact: true }).fill(testEmail);
  await page.getByLabel('Mot de passe', { exact: true }).fill(testPassword);
  await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
  await expect(page.locator('.project-heading h1')).toHaveText('PlaniFiKateur');
};
// Sans flux d’événements, l’interface revient à l’actualisation périodique (filet de sécurité).
const blockServerEvents = page => page.route('**/api/v1/events', route => route.abort());
const newProject = async (page, name) => {
  const menu = page.getByRole('button', { name: 'Ouvrir les projets', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('button', { name: 'Nouveau projet', exact: true }).click();
  await page.getByLabel('Nom du projet', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'Créer le projet', exact: true }).click();
};
// Les sauvegardes serveur ne sont proposées que dans la fenêtre « Espace personnel » du menu latéral.
const openWorkspace = async page => {
  const menu = page.getByRole('button', { name: 'Ouvrir les projets', exact: true });
  if ((await menu.isVisible()) && !(await page.locator('.sidebar.open').count())) await menu.click();
  await page.getByRole('button', { name: /Espace personnel/ }).click();
  await expect(page.getByRole('dialog', { name: 'Votre espace personnel' })).toBeVisible();
};

test(
  'a UI-created card is readable by an agent and another browser',
  { tag: '@mobile' },
  async ({ page, request, browser, appServer }) => {
    await page.goto(appServer);
    await page.getByLabel('Adresse e-mail', { exact: true }).fill(testEmail);
    await page.getByLabel('Mot de passe', { exact: true }).fill('wrong');
    await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText('Adresse e-mail ou mot de passe incorrect.');
    await login(page, appServer);
    await newProject(page, 'Projet connecté');
    await page.getByRole('button', { name: 'Ajouter une carte dans Bugs', exact: true }).click();
    await expect(page.getByLabel('Effort IA', { exact: true })).toHaveValue('medium');
    await expect(page.getByLabel('Effort IA', { exact: true }).locator('option[value=""]')).toHaveCount(0);
    // Le bandeau d’exécution IA est présent dès la création ; son bouton attend une description.
    const creationPanel = page.getByRole('region', { name: 'Exécution IA', exact: true });
    const entrustAtCreation = creationPanel.getByRole('button', { name: 'Créer et confier à l’agent', exact: true });
    await expect(creationPanel).toBeVisible();
    await page.getByLabel('Titre de la carte', { exact: true }).fill('Bug visible par les agents');
    await expect(entrustAtCreation).toBeDisabled();
    await page.getByLabel('Description', { exact: true }).fill('Le contexte de la demande.');
    await expect(entrustAtCreation).toBeEnabled();
    await page.getByLabel('Statut', { exact: true }).selectOption('ready');
    await page.getByLabel('Votre commentaire').fill('Une précision');
    await page.getByRole('button', { name: 'Créer la carte', exact: true }).click();
    await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
    const projectData = await (
      await request.get(`${appServer}/api/v1/projects`, { headers: { Authorization: `Bearer ${readToken}` } })
    ).json();
    const projectId = projectData.data.find(p => p.name === 'Projet connecté').id;
    const response = await request.get(`${appServer}/api/v1/projects/${projectId}/cards?status=ready&q=Bug%20visible`, {
      headers: { Authorization: `Bearer ${readToken}` },
    });
    expect(response.status()).toBe(200);
    const { data } = await response.json();
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      title: 'Bug visible par les agents',
      projectName: 'Projet connecté',
      listName: 'Bugs',
      description: 'Le contexte de la demande.',
      aiEffort: 'medium',
    });
    expect(data[0].comments[0].text).toBe('Une précision');
    expect(
      (
        await request.put(`${appServer}/api/v1/workspace`, {
          headers: { Authorization: `Bearer ${readToken}` },
          data: {},
        })
      ).status(),
    ).toBe(401);
    const context = await browser.newContext();
    const other = await context.newPage();
    await login(other, appServer);
    const menu = other.getByRole('button', { name: 'Ouvrir les projets', exact: true });
    if (await menu.isVisible()) await menu.click();
    await other
      .getByRole('navigation', { name: 'Projets' })
      .getByRole('button', { name: /Projet connecté/ })
      .click();
    await expect(other.getByRole('heading', { name: 'Bug visible par les agents', exact: true })).toBeVisible();
    await context.close();
  },
);

test('two browsers editing the same board merge their changes without a conflict', async ({
  page,
  browser,
  request,
  appServer,
}) => {
  await login(page, appServer);
  const context = await browser.newContext();
  const other = await context.newPage();
  await login(other, appServer);
  // Le second navigateur ne s’actualise plus (lectures complètes ou par projet) : ses
  // modifications partent d’un tableau périmé.
  await other.route(/\/api\/v1\/workspace(\?|$)/, route =>
    route.request().method() === 'GET' ? route.abort() : route.continue(),
  );
  const card = seed[0].cards[0];
  await page.getByRole('heading', { name: card.title, exact: true }).click();
  await page.getByLabel('Titre de la carte', { exact: true }).fill('Titre choisi par le premier');
  await page.getByRole('button', { name: 'Terminé', exact: true }).click();
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
  await newProject(page, 'Premier éditeur');
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
  // Même carte, autre champ, depuis un tableau qui ignore encore le nouveau titre.
  await other.getByRole('heading', { name: card.title, exact: true }).click();
  await other.getByLabel('Priorité', { exact: true }).selectOption('low');
  await other.getByRole('button', { name: 'Terminé', exact: true }).click();
  await expect(other.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
  await expect(other.getByRole('alert')).toHaveCount(0);
  // La réponse du serveur apporte aussi les changements de l’autre session.
  await expect(other.getByRole('heading', { name: 'Titre choisi par le premier', exact: true })).toBeVisible();
  await newProject(other, 'Second éditeur');
  await expect(other.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
  const headers = { Authorization: `Bearer ${readToken}` };
  const { data } = await (await request.get(`${appServer}/api/v1/projects`, { headers })).json();
  expect(data.some(p => p.name === 'Premier éditeur')).toBe(true);
  expect(data.some(p => p.name === 'Second éditeur')).toBe(true);
  const saved = await (
    await request.get(`${appServer}/api/v1/projects/${seed[0].id}/cards/${card.id}`, { headers })
  ).json();
  expect(saved.data).toMatchObject({ title: 'Titre choisi par le premier', priority: 'low' });
  await context.close();
});

test('a change made elsewhere is read back for its project only', async ({ page, browser, appServer }) => {
  await login(page, appServer);
  const context = await browser.newContext();
  const other = await context.newPage();
  await login(other, appServer);
  await expect(other.locator('.project-heading h1')).toHaveText(seed[0].name);
  // Laisser le flux d’événements se connecter avant d’observer les lectures.
  await other.waitForTimeout(500);
  const reads = [];
  other.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/api/v1/workspace' && request.method() === 'GET') reads.push(url.search);
  });
  const card = seed[0].cards[0];
  await page.getByRole('heading', { name: card.title, exact: true }).click();
  await page.getByLabel('Titre de la carte', { exact: true }).fill('Titre annoncé en direct');
  await page.getByRole('button', { name: 'Terminé', exact: true }).click();
  await expect(other.getByRole('heading', { name: 'Titre annoncé en direct', exact: true })).toBeVisible();
  expect(reads).toEqual([`?projects=${seed[0].id}`]);
  await context.close();
});

test('a refused save keeps local edits and reloading is explicit', async ({ page, appServer }) => {
  await login(page, appServer);
  await page.route('**/api/v1/workspace', route =>
    route.request().method() === 'PATCH'
      ? route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            error: { code: 'managed_status', message: 'Le statut de cette carte est piloté par son exécution IA.' },
          }),
        })
      : route.continue(),
  );
  await newProject(page, 'Projet refusé');
  await expect(page.getByRole('alert')).toContainText('piloté par son exécution IA');
  await expect(page.getByRole('heading', { name: 'Projet refusé', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Recharger le tableau', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('seront abandonnées');
  await page.unroute('**/api/v1/workspace');
  await page.getByRole('button', { name: 'Recharger depuis le serveur', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'PlaniFiKateur', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(
    page.getByRole('navigation', { name: 'Projets' }).getByRole('button', { name: /Projet refusé/ }),
  ).toHaveCount(0);
});

test('a failed save preserves edits and can be retried', async ({ page, request, appServer }) => {
  await login(page, appServer);
  await page.route('**/api/v1/workspace', async route => {
    if (route.request().method() === 'PATCH') await route.abort();
    else await route.continue();
  });
  await newProject(page, 'Projet conservé');
  await expect(page.getByRole('alert')).toContainText('Vos modifications restent');
  await expect(page.getByRole('heading', { name: 'Projet conservé', exact: true })).toBeVisible();
  await page.unroute('**/api/v1/workspace');
  await page.getByRole('button', { name: 'Réessayer la sauvegarde', exact: true }).click();
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
  const { data } = await (
    await request.get(`${appServer}/api/v1/projects`, { headers: { Authorization: `Bearer ${readToken}` } })
  ).json();
  expect(data.some(p => p.name === 'Projet conservé')).toBe(true);
});

test('a refused change is explained and removed from the page without blocking later saves', async ({
  page,
  request,
  appServer,
}) => {
  await login(page, appServer);
  // Le serveur refuse la seule modification du lot : réponse réelle, complétée de ce refus.
  await page.route('**/api/v1/workspace', async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    const sent = route.request().postDataJSON();
    expect(sent.partial).toBe(true);
    const response = await route.fetch({ postData: JSON.stringify({ changes: [], partial: true }) });
    const json = await response.json();
    json.data.rejected = sent.changes.map((change, index) => ({
      index,
      type: change.type,
      code: 'project_forbidden',
      message: 'Votre rôle sur ce projet ne permet que la lecture.',
    }));
    await route.fulfill({ response, json });
  });
  await newProject(page, 'Projet refusé');
  const notice = page.getByRole('alert').filter({ hasText: 'Une modification a été refusée' });
  await expect(notice).toContainText('ne permet que la lecture');
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
  await expect(
    page.getByRole('navigation', { name: 'Projets' }).getByRole('button', { name: /Projet refusé/ }),
  ).toHaveCount(0);
  await page.unroute('**/api/v1/workspace');
  await notice.getByRole('button', { name: 'Compris', exact: true }).click();
  await expect(notice).toHaveCount(0);
  await newProject(page, 'Projet accepté');
  await expect(page.getByRole('heading', { name: 'Projet accepté', exact: true })).toBeVisible();
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
  const { data } = await (
    await request.get(`${appServer}/api/v1/projects`, { headers: { Authorization: `Bearer ${readToken}` } })
  ).json();
  expect(data.map(project => project.name)).toContain('Projet accepté');
  expect(data.map(project => project.name)).not.toContain('Projet refusé');
});

test('saved attachments are previewed and downloaded from their route, not carried by the board', async ({
  page,
  appServer,
}) => {
  await login(page, appServer);
  const card = seed[0].cards[2];
  // PNG 1×1 transparent.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    'base64',
  );
  await page.getByRole('heading', { name: card.title, exact: true }).click();
  await page.getByLabel('Ajouter des fichiers', { exact: true }).setInputFiles([
    { name: 'capture.png', mimeType: 'image/png', buffer: png },
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Notes de réunion') },
  ]);
  await expect(page.getByRole('link', { name: 'notes.txt', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Terminé', exact: true }).click();
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
  const board = await page.request.get(`${appServer}/api/v1/workspace`);
  const saved = (await board.json()).projects[0].cards.find(item => item.id === card.id).attachments;
  expect(saved.map(file => [file.name, 'data' in file])).toEqual([
    ['capture.png', false],
    ['notes.txt', false],
  ]);
  await page.reload();
  await expect(page.locator('.project-heading h1')).toHaveText(seed[0].name);
  await page.getByRole('heading', { name: card.title, exact: true }).click();
  const preview = page.getByRole('img', { name: 'Aperçu de capture.png', exact: true });
  await expect(preview).toHaveAttribute('src', /\/attachments\//);
  await expect.poll(() => preview.evaluate(image => image.naturalWidth)).toBe(1);
  const downloading = page.waitForEvent('download');
  await page.getByRole('link', { name: 'notes.txt', exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('notes.txt');
  expect(readFileSync(await download.path(), 'utf8')).toBe('Notes de réunion');
});

test('cards, lists and the project are rearranged and edited without drag and drop', async ({
  page,
  request,
  appServer,
}) => {
  await login(page, appServer);
  const headers = { Authorization: `Bearer ${readToken}` };
  const cardsOf = async () =>
    (await (await request.get(`${appServer}/api/v1/projects/${seed[0].id}/cards`, { headers })).json()).data;
  // Les cartes Infos ne comptent pas parmi les idées du projet.
  const ideas = seed[0].cards.filter(item => !isSystemCard(seed[0].id, item.id)).length;
  expect(ideas).toBeLessThan(seed[0].cards.length);
  await expect(page.locator('.stats')).toContainText(`${ideas}idées au total`);
  // Déplacer une carte vers une autre liste, puis la remonter dans sa liste.
  const card = seed[0].cards[0];
  const target = seed[0].lists[1];
  await page.getByRole('heading', { name: card.title, exact: true }).click();
  await page.getByLabel('Déplacer vers la liste', { exact: true }).selectOption(target.id);
  await expect(page.locator('.detail-status')).toContainText(`dans ${target.name}`);
  const order = page.getByRole('group', { name: 'Position dans la liste', exact: true });
  const before = await order.locator('span').textContent();
  const [index] = before.split(' / ').map(Number);
  if (index > 1) {
    await order.getByRole('button', { name: 'Monter', exact: true }).click();
    await expect(order.locator('span')).toHaveText(new RegExp(`^${index - 1} / `));
  }
  await page.getByRole('button', { name: 'Terminé', exact: true }).click();
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
  expect((await cardsOf()).find(item => item.id === card.id).listId).toBe(target.id);
  // Renommer et déplacer une liste, puis supprimer une liste vide.
  await page.getByRole('button', { name: `Modifier la liste ${target.name}`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Modifier la liste', exact: true });
  await dialog.getByLabel('Nom de la liste', { exact: true }).fill('Pistes retenues');
  await dialog.getByRole('button', { name: 'Vers la gauche', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Supprimer la liste', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Enregistrer la liste', exact: true }).click();
  await expect(page.locator('.list-header h2').first()).toHaveText('Pistes retenues');
  await page.getByRole('button', { name: 'Ajouter une liste', exact: true }).click();
  await page.getByLabel('Nom de la liste', { exact: true }).fill('Liste éphémère');
  await page.getByRole('button', { name: 'Créer la liste', exact: true }).click();
  await page.getByRole('button', { name: 'Modifier la liste Liste éphémère', exact: true }).click();
  await page.getByRole('button', { name: 'Supprimer la liste', exact: true }).click();
  await expect(page.locator('.list-header h2', { hasText: 'Liste éphémère' })).toHaveCount(0);
  // Modifier le projet.
  await page.getByRole('button', { name: 'Modifier le projet', exact: true }).click();
  const project = page.getByRole('dialog', { name: 'Modifier le projet', exact: true });
  await project.getByLabel('Nom du projet', { exact: true }).fill('PlaniFiKateur renommé');
  await project.getByLabel('Symbole', { exact: true }).fill('★');
  await project.getByRole('button', { name: 'Enregistrer le projet', exact: true }).click();
  await expect(page.locator('.project-heading h1')).toHaveText('PlaniFiKateur renommé');
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
  const { data } = await (await request.get(`${appServer}/api/v1/projects`, { headers })).json();
  const saved = data.find(item => item.id === seed[0].id);
  expect([saved.name, saved.emoji]).toEqual(['PlaniFiKateur renommé', '★']);
  const board = await (await page.request.get(`${appServer}/api/v1/workspace`)).json();
  const names = board.projects.find(item => item.id === seed[0].id).lists.map(list => list.name);
  expect(names[0]).toBe('Pistes retenues');
  expect(names).not.toContain('Liste éphémère');
});

test('each project and card has its own address, kept on reload and closed by going back', async ({
  page,
  appServer,
}) => {
  await login(page, appServer);
  const project = seed[1],
    card = project.cards[0];
  await page.goto(`${appServer}/#/projets/${project.id}/cartes/${card.id}`);
  await expect(page.getByLabel('Titre de la carte', { exact: true })).toHaveValue(card.title);
  await expect(page.locator('.project-heading h1')).toHaveText(project.name);
  await expect(page).toHaveTitle(`${card.title} · ${project.name} · PlaniFiKateur`);
  await page.getByRole('button', { name: 'Terminé', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/projets/${project.id}$`));
  // Ouvrir une carte ajoute une entrée d’historique : « Précédent » la referme.
  await page.getByRole('heading', { name: card.title, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/projets/${project.id}/cartes/${card.id}$`));
  await page.goBack();
  await expect(page.getByLabel('Titre de la carte', { exact: true })).toHaveCount(0);
  await expect(page.locator('.project-heading h1')).toHaveText(project.name);
  // Adresse d’une carte inconnue : le projet s’ouvre, sans carte.
  await page.goto(`${appServer}/#/projets/${project.id}/cartes/absente`);
  await page.reload();
  await expect(page.locator('.project-heading h1')).toHaveText(project.name);
  await expect(page).toHaveURL(new RegExp(`#/projets/${project.id}$`));
});

test('JSON import adds local cards to the API without replacing existing projects', async ({
  page,
  request,
  appServer,
}) => {
  await login(page, appServer);
  await page.getByRole('button', { name: 'Informations sur PlaniFiKateur', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'À propos de PlaniFiKateur' })).toContainText(
    'Confier une carte à l’agent IA',
  );
  const imported = structuredClone(seed[0]);
  imported.name = 'Projet importé';
  imported.cards[0].title = 'Une idée importée';
  await page.getByLabel('Importer des projets JSON').setInputFiles({
    name: 'projects.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ projects: [imported] })),
  });
  await page.getByRole('button', { name: 'C’est compris', exact: true }).click();
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
  const { data } = await (
    await request.get(`${appServer}/api/v1/projects`, { headers: { Authorization: `Bearer ${readToken}` } })
  ).json();
  expect(data).toHaveLength(3);
  const cards = await (
    await request.get(
      `${appServer}/api/v1/projects/${data.find(p => p.name === 'Projet importé').id}/cards?q=importée`,
      { headers: { Authorization: `Bearer ${readToken}` } },
    )
  ).json();
  expect(cards.data).toHaveLength(1);
  expect(cards.data[0].projectName).toBe('Projet importé');
});

test('project deletion requires confirmation, removes cards and permits an empty workspace', async ({
  page,
  request,
  appServer,
}) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await login(page, appServer);
  await page.getByRole('button', { name: 'Supprimer le projet', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText(seed[0].name);
  await page.getByRole('button', { name: 'Annuler', exact: true }).click();
  await expect(page.getByRole('heading', { name: seed[0].name, exact: true })).toBeVisible();
  const headers = { Authorization: `Bearer ${readToken}` };
  expect((await (await request.get(`${appServer}/api/v1/projects`, { headers })).json()).data).toHaveLength(2);
  await page.getByRole('button', { name: 'Supprimer le projet', exact: true }).click();
  await page.getByRole('button', { name: 'Confirmer la suppression', exact: true }).click();
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
  await expect(page.getByRole('heading', { name: seed[1].name, exact: true })).toBeVisible();
  expect((await request.get(`${appServer}/api/v1/projects/${seed[0].id}`, { headers })).status()).toBe(404);
  expect(
    (
      await request.get(`${appServer}/api/v1/projects/${seed[0].id}/cards/${seed[0].cards[0].id}`, { headers })
    ).status(),
  ).toBe(404);
  expect(
    (await (await request.get(`${appServer}/api/v1/projects/${seed[1].id}/cards`, { headers })).json()).data,
  ).toHaveLength(seed[1].cards.length);
  await page.getByRole('button', { name: 'Supprimer le projet', exact: true }).click();
  await page.getByRole('button', { name: 'Confirmer la suppression', exact: true }).click();
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Aucun projet pour le moment', exact: true })).toBeVisible();
  expect((await (await request.get(`${appServer}/api/v1/projects`, { headers })).json()).data).toEqual([]);
  await page.locator('.empty-workspace').getByRole('button', { name: 'Créer un projet', exact: true }).click();
  await page.getByLabel('Nom du projet', { exact: true }).fill('Nouveau départ');
  await page.getByRole('button', { name: 'Créer le projet', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Nouveau départ', exact: true })).toBeVisible();
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
  expect(pageErrors).toEqual([]);
});

test('another browser receives changes automatically and unchanged polls do not save', async ({
  page,
  browser,
  appServer,
}) => {
  await page.clock.install();
  await login(page, appServer);
  const context = await browser.newContext();
  const other = await context.newPage();
  await login(other, appServer);
  let writes = 0;
  page.on('request', req => {
    if (req.url().endsWith('/api/v1/workspace') && req.method() !== 'GET') writes++;
  });
  await newProject(other, 'Projet partagé en direct');
  await expect(other.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
  await page.clock.runFor(5100);
  await expect(
    page.getByRole('navigation', { name: 'Projets' }).getByRole('button', { name: /Projet partagé en direct/ }),
  ).toHaveCount(1);
  await other.getByRole('button', { name: 'Supprimer le projet', exact: true }).click();
  await other.getByRole('button', { name: 'Confirmer la suppression', exact: true }).click();
  await expect(other.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
  await page.clock.runFor(5100);
  await expect(
    page.getByRole('navigation', { name: 'Projets' }).getByRole('button', { name: /Projet partagé en direct/ }),
  ).toHaveCount(0);
  await page.clock.runFor(5100);
  expect(writes).toBe(0);
  await context.close();
});

test('automatic refresh pauses while editing and preserves a draft during a concurrent change', async ({
  page,
  browser,
  appServer,
}) => {
  await page.clock.install();
  await login(page, appServer);
  const context = await browser.newContext();
  const other = await context.newPage();
  await login(other, appServer);
  await page.getByRole('heading', { name: seed[0].cards[0].title, exact: true }).click();
  await page.getByLabel('Description', { exact: true }).fill('Mon texte en cours de rédaction');
  await newProject(other, 'Changement pendant la saisie');
  await expect(other.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
  await page.clock.runFor(10100);
  await expect(page.getByLabel('Description', { exact: true })).toHaveValue('Mon texte en cours de rédaction');
  await expect(
    page.getByRole('navigation', { name: 'Projets' }).getByRole('button', { name: /Changement pendant la saisie/ }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Terminé', exact: true }).click();
  await page.clock.runFor(500);
  // La description est enregistrée par-dessus le changement de l’autre session, sans conflit.
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(
    page.getByRole('navigation', { name: 'Projets' }).getByRole('button', { name: /Changement pendant la saisie/ }),
  ).toHaveCount(1);
  await page.getByRole('heading', { name: seed[0].cards[0].title, exact: true }).click();
  await expect(page.getByLabel('Description', { exact: true })).toHaveValue('Mon texte en cours de rédaction');
  await context.close();
});

test('refresh recovers after a network error without losing the current board', async ({
  page,
  browser,
  appServer,
}) => {
  await page.clock.install();
  await blockServerEvents(page);
  await login(page, appServer);
  await page.route('**/api/v1/workspace', route =>
    route.request().method() === 'GET' ? route.abort() : route.continue(),
  );
  await page.clock.runFor(5100);
  await expect(page.getByText('Actualisation indisponible.', { exact: false })).toBeVisible();
  await expect(page.getByRole('heading', { name: seed[0].name, exact: true })).toBeVisible();
  const context = await browser.newContext();
  const other = await context.newPage();
  await login(other, appServer);
  await newProject(other, 'Après reconnexion');
  await expect(other.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
  await page.unroute('**/api/v1/workspace');
  await page.clock.runFor(5100);
  await expect(
    page.getByRole('navigation', { name: 'Projets' }).getByRole('button', { name: /Après reconnexion/ }),
  ).toHaveCount(1);
  await expect(page.getByText('Actualisation indisponible.', { exact: false })).toHaveCount(0);
  await context.close();
});

test('owner can create and download a SQLite backup from the interface', async ({ page, appServer }) => {
  await login(page, appServer);
  await newProject(page, 'Projet dans ma sauvegarde');
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
  await page.getByRole('button', { name: 'Informations sur PlaniFiKateur', exact: true }).click();
  const about = page.getByRole('dialog', { name: 'À propos de PlaniFiKateur' });
  await expect(about).toContainText('Confier une carte à l’agent IA');
  await expect(about.getByRole('heading', { name: 'Sauvegardes', exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Créer et télécharger une sauvegarde SQLite', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'C’est compris', exact: true }).click();
  await page.getByRole('button', { name: 'Historique des projets', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Activité des projets' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Créer et télécharger une sauvegarde SQLite', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Fermer', exact: true }).click();
  await openWorkspace(page);
  await expect(page.getByRole('heading', { name: 'Sauvegardes', exact: true })).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Créer et télécharger une sauvegarde SQLite', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^planifikateur-.*\.sqlite$/);
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const db = new DatabaseSync(await download.path(), { readOnly: true });
  const projects = readWorkspace(db);
  db.close();
  expect(projects.some(p => p.name === 'Projet dans ma sauvegarde')).toBe(true);
});

test('a delayed refresh cannot replace a form opened while the read was in flight', async ({
  page,
  browser,
  appServer,
}) => {
  await page.clock.install();
  await blockServerEvents(page);
  await login(page, appServer);
  const context = await browser.newContext();
  const other = await context.newPage();
  await login(other, appServer);
  await newProject(other, 'Réponse retardée');
  await expect(other.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
  let held, captured;
  const pending = new Promise(resolve => {
    captured = resolve;
  });
  await page.route('**/api/v1/workspace', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    held = () => route.fulfill({ response });
    captured();
  });
  await page.clock.runFor(5100);
  await pending;
  await page.getByRole('button', { name: 'Ajouter une carte dans Bugs', exact: true }).click();
  await page.getByLabel('Titre de la carte', { exact: true }).fill('Mon brouillon intact');
  await held();
  await expect(page.getByLabel('Titre de la carte', { exact: true })).toHaveValue('Mon brouillon intact');
  await expect(
    page.getByRole('navigation', { name: 'Projets' }).getByRole('button', { name: /Réponse retardée/ }),
  ).toHaveCount(0);
  await page.unroute('**/api/v1/workspace');
  await page.getByRole('button', { name: 'Annuler', exact: true }).click();
  await expect(
    page.getByRole('navigation', { name: 'Projets' }).getByRole('button', { name: /Réponse retardée/ }),
  ).toHaveCount(1);
  await context.close();
});

test('closing an unchanged card does not save stale data and resumes refresh', async ({ page, browser, appServer }) => {
  await page.clock.install();
  await login(page, appServer);
  const context = await browser.newContext();
  const other = await context.newPage();
  await login(other, appServer);
  let writes = 0;
  page.on('request', req => {
    if (req.url().endsWith('/api/v1/workspace') && req.method() !== 'GET') writes++;
  });
  await page.getByRole('heading', { name: seed[0].cards[0].title, exact: true }).click();
  await newProject(other, 'Pendant la consultation');
  await expect(other.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
  await page.getByRole('button', { name: 'Terminé', exact: true }).click();
  await expect(
    page.getByRole('navigation', { name: 'Projets' }).getByRole('button', { name: /Pendant la consultation/ }),
  ).toHaveCount(1);
  expect(writes).toBe(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await context.close();
});

test('administrator invites a member whose cards, comments and actions carry their own identity', async ({
  page,
  browser,
  appServer,
}) => {
  await login(page, appServer);
  await page.getByRole('button', { name: 'Mon compte', exact: true }).click();
  await page.getByLabel('Nom du membre', { exact: true }).fill('Bob');
  await page.getByLabel('E-mail du membre', { exact: true }).fill('bob@example.test');
  await page.getByRole('button', { name: 'Créer une invitation', exact: true }).click();
  await expect(page.getByLabel('Lien d’invitation')).toHaveValue(/#invitation=[a-f0-9]{64}$/);
  const invitation = await page.getByLabel('Lien d’invitation').inputValue();
  const context = await browser.newContext();
  const member = await context.newPage();
  await member.goto(invitation);
  await member.getByLabel('Votre nom', { exact: true }).fill('Bob');
  await member.getByLabel('Mot de passe', { exact: true }).fill('bob-browser-password-123');
  await member.getByRole('button', { name: 'Activer mon compte', exact: true }).click();
  await expect(member.locator('.project-heading h1')).toHaveText('PlaniFiKateur');
  await newProject(member, 'Projet de Bob');
  await member.getByRole('button', { name: 'Ajouter une carte dans Bugs', exact: true }).click();
  await member.getByLabel('Titre de la carte', { exact: true }).fill('Carte créée par Bob');
  await member.getByLabel('Votre commentaire').fill('Précision de Bob');
  await member.getByRole('button', { name: 'Créer la carte', exact: true }).click();
  await expect(member.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
  await expect(
    member
      .locator('.card')
      .filter({ has: member.getByRole('heading', { name: 'Carte créée par Bob', exact: true }) })
      .locator('.card-avatar'),
  ).toHaveText('B');
  await expect(member.locator('.sidebar-footer .user-avatar')).toHaveText('B');
  await member.getByRole('heading', { name: 'Carte créée par Bob', exact: true }).click();
  await expect(member.locator('.card-authorship')).toContainText('Créée par Bob');
  await expect(member.locator('.comment strong')).toContainText('Bob');
  await expect(member.locator('.comment .user-avatar')).toHaveText('B');
  await expect(member.locator('.activity-list')).toContainText('Bob a créé la carte');
  await member.getByRole('button', { name: 'Terminé', exact: true }).click();
  await member.getByRole('button', { name: 'Mon compte', exact: true }).click();
  await expect(member.getByRole('heading', { name: 'Membres de l’espace', exact: true })).toHaveCount(0);
  await member.getByRole('button', { name: 'Fermer', exact: true }).click();
  await openWorkspace(member);
  await expect(
    member.getByRole('button', { name: 'Créer et télécharger une sauvegarde SQLite', exact: true }),
  ).toHaveCount(0);
  const memberRow = page.locator('.member-list li').filter({ hasText: 'bob@example.test' });
  await memberRow.getByRole('button', { name: 'Désactiver', exact: true }).click();
  await expect(memberRow).toContainText('Désactivé');
  expect((await context.request.get(`${appServer}/api/v1/workspace`)).status()).toBe(401);
  await context.close();
});

const accentColor = page =>
  page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--primary').trim());

test('the accent chosen in « Mon compte » applies at once and follows the account in another browser', async ({
  page,
  browser,
  appServer,
}) => {
  await login(page, appServer);
  await expect.poll(() => accentColor(page)).toBe('#28734b');
  await page.getByRole('button', { name: 'Mon compte', exact: true }).click();
  const palette = page.getByRole('group', { name: 'Couleur dominante', exact: true });
  const forest = palette.getByRole('button', { name: 'Forêt (par défaut)', exact: true });
  const plum = palette.getByRole('button', { name: 'Prune', exact: true });
  const reset = page.getByRole('button', { name: 'Rétablir la couleur par défaut', exact: true });
  await expect(forest).toHaveAttribute('aria-pressed', 'true');
  await expect(reset).toBeDisabled();
  await plum.click();
  await expect(plum).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.sidebar')).toHaveCSS('background-color', 'rgb(43, 29, 79)');
  await expect(page.locator('.accounts-panel [role="status"]')).toHaveText('Couleur enregistrée sur votre compte.');
  await expect.poll(() => accentColor(page)).toBe('#6d28d9');

  const context = await browser.newContext();
  const other = await context.newPage();
  await login(other, appServer);
  await expect(other.locator('.sidebar')).toHaveCSS('background-color', 'rgb(43, 29, 79)');
  await context.close();

  await reset.click();
  await expect(page.locator('.sidebar')).toHaveCSS('background-color', 'rgb(25, 61, 47)');
  await expect.poll(() => accentColor(page)).toBe('#28734b');
  await expect(forest).toHaveAttribute('aria-pressed', 'true');
  await expect(reset).toBeDisabled();

  await palette.getByRole('button', { name: 'Océan', exact: true }).click();
  await expect(page.locator('.sidebar')).toHaveCSS('background-color', 'rgb(23, 46, 87)');
  await page.getByRole('button', { name: 'Se déconnecter', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Se connecter', exact: true })).toBeVisible();
  await expect.poll(() => accentColor(page)).toBe('#28734b');
  await login(page, appServer);
  await expect(page.locator('.sidebar')).toHaveCSS('background-color', 'rgb(23, 46, 87)');
});

test(
  'project roles hide, open read-only or reserve the agent to managers',
  { tag: '@mobile' },
  async ({ page, browser, request, appServer }) => {
    await login(page, appServer);
    // Compte de Bob créé et activé, puis projet confidentiel masqué aux autres membres.
    const invited = await page.request.post(`${appServer}/api/v1/users`, {
      data: { name: 'Bob', email: 'bob@example.test' },
    });
    const { token } = (await invited.json()).data;
    const password = 'bob-browser-password-123';
    expect(
      (await request.post(`${appServer}/api/v1/accounts/accept`, { data: { token, name: 'Bob', password } })).status(),
    ).toBe(200);
    const secret = (
      await (await page.request.post(`${appServer}/api/v1/projects`, { data: { name: 'Projet confidentiel' } })).json()
    ).data;
    expect(
      (
        await page.request.put(`${appServer}/api/v1/projects/${secret.id}/members`, { data: { memberRole: 'none' } })
      ).status(),
    ).toBe(200);
    // Droits du site vitrine réglés depuis l’interface : lecture pour Bob, rien pour les autres.
    await page.reload();
    await expect(page.locator('.project-heading h1')).toHaveText('PlaniFiKateur');
    const menu = page.getByRole('button', { name: 'Ouvrir les projets', exact: true });
    if (await menu.isVisible()) await menu.click();
    await page
      .getByRole('navigation', { name: 'Projets' })
      .getByRole('button', { name: /Site vitrine/ })
      .click();
    await page.getByRole('button', { name: 'Paramètres du projet', exact: true }).click();
    await page.getByRole('tab', { name: /^Accès/ }).click();
    await page.getByText('Membres et droits', { exact: true }).click();
    await page.getByLabel('Rôle des autres membres', { exact: true }).selectOption('none');
    await page.getByLabel('Rôle de Bob', { exact: true }).selectOption('viewer');
    await page.getByRole('button', { name: 'Enregistrer les droits', exact: true }).click();
    await expect(page.getByText('Droits enregistrés pour ce projet.', { exact: true })).toBeVisible();
    const context = await browser.newContext();
    const member = await context.newPage();
    await member.goto(appServer);
    await member.getByLabel('Adresse e-mail', { exact: true }).fill('bob@example.test');
    await member.getByLabel('Mot de passe', { exact: true }).fill(password);
    await member.getByRole('button', { name: 'Se connecter', exact: true }).click();
    await expect(member.locator('.project-heading h1')).toHaveText('PlaniFiKateur');
    const projects = member.getByRole('navigation', { name: 'Projets' });
    await expect(projects.getByRole('button', { name: /Projet confidentiel/ })).toHaveCount(0);
    // Contribution sur PlaniFiKateur : modifier oui, confier à l’agent non.
    await member.getByRole('heading', { name: seed[0].cards[2].title, exact: true }).click();
    await expect(member.getByLabel('Statut', { exact: true }).locator('option[value="ready"]')).toHaveAttribute(
      'disabled',
      '',
    );
    await expect(member.getByRole('region', { name: 'Exécution IA', exact: true })).toContainText(
      'Seuls les responsables du projet peuvent confier cette carte',
    );
    await expect(member.getByRole('button', { name: 'Confier à l’agent', exact: true })).toHaveCount(0);
    await member.getByLabel('Priorité', { exact: true }).selectOption('high');
    await member.getByRole('button', { name: 'Terminé', exact: true }).click();
    await expect(member.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
    // Une carte prête attend l’agent : sa demande n’est modifiable que par un responsable.
    await member.getByRole('heading', { name: seed[0].cards[1].title, exact: true }).click();
    await expect(member.getByLabel('Description', { exact: true })).not.toBeEditable();
    await expect(member.getByText(/seul un responsable peut encore modifier la demande/)).toBeVisible();
    await expect(member.getByLabel('Priorité', { exact: true })).toBeEnabled();
    await member.getByRole('button', { name: 'Terminé', exact: true }).click();
    // Lecture seule sur le site vitrine.
    const memberMenu = member.getByRole('button', { name: 'Ouvrir les projets', exact: true });
    if (await memberMenu.isVisible()) await memberMenu.click();
    await projects.getByRole('button', { name: /Site vitrine/ }).click();
    await expect(member.locator('.read-only-badge')).toHaveText('Lecture seule');
    await expect(member.getByRole('button', { name: /^Ajouter une carte/ })).toHaveCount(0);
    await expect(member.getByRole('button', { name: 'Supprimer le projet', exact: true })).toHaveCount(0);
    await member.getByRole('heading', { name: seed[1].cards[0].title, exact: true }).click();
    await expect(member.getByLabel('Titre de la carte', { exact: true })).not.toBeEditable();
    await expect(member.getByLabel('Votre commentaire', { exact: true })).toHaveCount(0);
    await expect(
      member.getByText('Lecture seule : votre rôle sur ce projet ne permet pas de commenter.'),
    ).toBeVisible();
    await context.close();
  },
);

test('a comment from another member reaches the notifications live and opens the card', async ({
  page,
  request,
  appServer,
}) => {
  await login(page, appServer);
  const card = seed[0].cards[0];
  await expect(page.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible();
  // L’administratrice participe à la carte ; Bob, contributeur, y répond depuis l’API.
  await page.getByRole('heading', { name: card.title, exact: true }).click();
  await page.getByLabel('Votre commentaire', { exact: true }).fill('Qui peut regarder ?');
  await page.getByRole('button', { name: 'Publier', exact: true }).click();
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
  await page.getByRole('button', { name: 'Terminé', exact: true }).click();
  const { token } = (
    await (
      await page.request.post(`${appServer}/api/v1/users`, { data: { name: 'Bob', email: 'bob@example.test' } })
    ).json()
  ).data;
  expect(
    (
      await request.post(`${appServer}/api/v1/accounts/accept`, {
        data: { token, name: 'Bob', password: 'bob-browser-password-123' },
      })
    ).status(),
  ).toBe(200);
  const answered = await request.post(`${appServer}/api/v1/projects/${seed[0].id}/cards/${card.id}/comments`, {
    data: { text: 'Je m’en occupe.' },
  });
  expect(answered.status()).toBe(201);
  await page.getByRole('button', { name: 'Notifications (1 non lues)', exact: true }).click();
  const list = page.getByRole('list', { name: 'Notifications', exact: true });
  await expect(list).toContainText('Bob a ajouté un commentaire');
  await expect(list.locator('li.unread')).toHaveCount(1);
  await list.getByRole('button', { name: new RegExp(card.title) }).click();
  await expect(page.getByLabel('Titre de la carte', { exact: true })).toHaveValue(card.title);
  await expect(page.locator('.comments-section')).toContainText('Je m’en occupe.');
  await page.getByRole('button', { name: 'Terminé', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible();
});

test('personal password change and logout lead back to individual login', async ({ page, appServer }) => {
  await login(page, appServer);
  await page.getByRole('button', { name: 'Mon compte', exact: true }).click();
  await page.getByLabel('Mot de passe actuel', { exact: true }).fill(testPassword);
  await page.getByLabel('Nouveau mot de passe', { exact: true }).fill('changed-browser-password-123');
  await page.getByRole('button', { name: 'Modifier mon mot de passe', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Mot de passe modifié');
  await page.getByRole('button', { name: 'Se déconnecter', exact: true }).click();
  await expect(page.getByLabel('Adresse e-mail', { exact: true })).toBeVisible();
  await page.getByLabel('Adresse e-mail', { exact: true }).fill(testEmail);
  await page.getByLabel('Mot de passe', { exact: true }).fill('changed-browser-password-123');
  await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
  await expect(page.locator('.project-heading h1')).toHaveText('PlaniFiKateur');
});

test.describe('first account setup', () => {
  test.use({ initialAccounts: false });
  test('initializes the administrator and preserves existing projects', async ({ page, appServer }) => {
    await page.goto(appServer);
    await expect(page.getByRole('heading', { name: 'Créer le compte administrateur', exact: true })).toBeVisible();
    await page.getByLabel('Votre nom', { exact: true }).fill('Alice');
    await page.getByLabel('Adresse e-mail', { exact: true }).fill(testEmail);
    await page.getByLabel('Mot de passe', { exact: true }).fill(testPassword);
    await page.getByLabel('Clé d’initialisation', { exact: true }).fill(ownerToken);
    await page.getByRole('button', { name: 'Créer mon compte', exact: true }).click();
    await expect(page.getByRole('heading', { name: seed[0].name, exact: true })).toBeVisible();
    await page.getByRole('heading', { name: seed[0].cards[0].title, exact: true }).click();
    await expect(page.locator('.card-authorship')).toContainText('Auteur inconnu');
  });
});

test('follows an existing card without being its author and keeps the setting after reload', async ({
  page,
  appServer,
}) => {
  await login(page, appServer);
  const card = seed[0].cards[0];
  const preview = page.locator('.card').filter({ has: page.getByRole('heading', { name: card.title, exact: true }) });
  await expect(preview.locator('.card-avatar')).toHaveCount(0);
  await page.getByRole('heading', { name: card.title, exact: true }).click();
  await expect(page.getByRole('button', { name: 'Suivre la carte', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Suivre la carte', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Ne plus suivre', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'Terminé', exact: true }).click();
  await expect(preview.locator('.card-avatar')).toHaveAttribute('title', 'Alice');
  await page.reload();
  await expect(page.locator('.project-heading h1')).toHaveText('PlaniFiKateur');
  await expect(preview.locator('.card-avatar')).toHaveText('A');
  await page.getByRole('heading', { name: card.title, exact: true }).click();
  await expect(page.getByRole('button', { name: 'Ne plus suivre', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Ne plus suivre', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Suivre la carte', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await page.getByRole('button', { name: 'Actualiser l’historique', exact: true }).click();
  await expect(page.locator('.activity-list')).toContainText('Alice ne suit plus la carte');
  await page.getByRole('button', { name: 'Terminé', exact: true }).click();
  await expect(preview.locator('.card-avatar')).toHaveCount(0);
});

test.describe('project task execution', () => {
  test.use({ githubEnabled: true });
  test('board cards show what the agent is doing on them', async ({ page, request, appServer }) => {
    await login(page, appServer);
    const project = seed[0],
      card = project.cards[0];
    await page.request.put(`${appServer}/api/v1/projects/${project.id}/github`, {
      data: { repository: 'owner/badges' },
    });
    const preview = page.locator('.card', { has: page.getByRole('heading', { name: card.title, exact: true }) });
    await expect(preview).toBeVisible();
    await expect(preview.locator('.work-badge')).toHaveCount(0);
    const credentials = await page.request.post(`${appServer}/api/v1/agents`, {
      data: { name: 'Badge agent', projectIds: [project.id] },
    });
    const headers = { Authorization: `Bearer ${(await credentials.json()).data.token}` };
    const base = `${appServer}/api/v1/projects/${project.id}/cards/${card.id}/work`;
    let run = (await (await page.request.post(base, { data: { delivery: 'github' } })).json()).data;
    await expect(preview.locator('.work-badge')).toHaveText('En attente de l’agent');
    run = (await (await request.post(`${base}/${run.id}/claim`, { headers, data: { version: run.version } })).json())
      .data;
    await expect(preview.locator('.work-badge')).toHaveText('Agent au travail');
    await request.post(`${base}/${run.id}/question`, {
      headers,
      data: { version: run.version, leaseToken: run.leaseToken, message: 'Quelle couleur ?' },
    });
    await expect(preview.locator('.work-badge')).toHaveText('Question de l’agent');
  });
  test('project execution profiles survive reload and worker diagnostics appear without configuration files', async ({
    page,
    request,
    appServer,
  }) => {
    await login(page, appServer);
    const project = seed[0];
    await page.request.put(`${appServer}/api/v1/projects/${project.id}/github`, {
      data: { repository: 'flo91360/DefilOrdi' },
    });
    await page.getByRole('button', { name: 'Paramètres du projet', exact: true }).click();
    await page.getByRole('tab', { name: /^Agent IA/ }).click();
    await page.getByText('Exécution et connexion du projet', { exact: true }).click();
    await expect(page.getByLabel('Profil d’exécution', { exact: true })).toHaveValue('defilordi');
    await page.getByLabel('Profil d’exécution', { exact: true }).selectOption('funkart');
    await page.getByRole('button', { name: 'Enregistrer le profil', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('Profil enregistré pour les prochaines tâches.');
    await page.reload();
    await page.getByRole('button', { name: 'Paramètres du projet', exact: true }).click();
    await page.getByRole('tab', { name: /^Agent IA/ }).click();
    await page.getByText('Exécution et connexion du projet', { exact: true }).click();
    await expect(page.getByLabel('Profil d’exécution', { exact: true })).toHaveValue('funkart');
    await expect(
      page.getByText('Fusion automatique après réussite des contrôles : export.', { exact: true }),
    ).toBeVisible();
    const credentials = await page.request.post(`${appServer}/api/v1/agents`, {
      data: { name: 'Worker', projectIds: [project.id] },
    });
    const token = (await credentials.json()).data.token;
    const report = await request.post(`${appServer}/api/v1/agent/projects/${project.id}/diagnostic`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        state: 'blocked',
        checks: [{ name: 'Godot', state: 'blocked', message: 'Godot 4.4.1 doit être installé sur le worker.' }],
      },
    });
    expect(report.status()).toBe(200);
    await page.reload();
    await page.getByRole('button', { name: 'Paramètres du projet', exact: true }).click();
    await page.getByRole('tab', { name: /^Agent IA/ }).click();
    await page.getByText('Exécution et connexion du projet', { exact: true }).click();
    await expect(page.getByText('Godot 4.4.1 doit être installé sur le worker.', { exact: false })).toBeVisible();
  });
  test('engine and model are project settings while effort persists on each card and is locked during a conversation', async ({
    page,
    request,
    appServer,
  }) => {
    await login(page, appServer);
    const project = seed[0],
      card = project.cards[0];
    await page.getByRole('button', { name: 'Paramètres du projet', exact: true }).click();
    await page.getByRole('tab', { name: /^Agent IA/ }).click();
    await page.getByText('Moteur et modèle IA', { exact: true }).click();
    const models = page.getByLabel('Modèle IA', { exact: true });
    await expect(models).toHaveValue('');
    await expect(models.locator('option[value="gpt-6.1-sol"]')).toHaveText('GPT-6.1-Sol');
    await expect(models.locator('option[value="claude-sonnet-5-5"]')).toHaveCount(0);
    await models.selectOption('gpt-6.1-sol');
    await page.getByLabel('Moteur IA', { exact: true }).selectOption('claude-code');
    await expect(models).toHaveValue('');
    await expect(models.locator('option[value="gpt-6.1-sol"]')).toHaveCount(0);
    await expect(models.locator('option[value="claude-opus-5-5"]')).toHaveText('Claude Opus 5.5');
    await expect(models.locator('option[value="claude-haiku-5-5"]')).toHaveText('Claude Haiku 5.5');
    await models.selectOption('claude-sonnet-5-5');
    await page.getByRole('button', { name: 'Enregistrer les paramètres IA', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('Moteur et modèle enregistrés pour ce projet.');
    await page.getByRole('button', { name: 'Fermer', exact: true }).click();
    await page.getByRole('heading', { name: card.title, exact: true }).click();
    await expect(page.getByLabel('Effort IA', { exact: true })).toBeEnabled();
    await expect(page.getByLabel('Effort IA', { exact: true })).toHaveValue('medium');
    await expect(page.getByLabel('Effort IA', { exact: true }).locator('option[value=""]')).toHaveCount(0);
    await page.getByLabel('Effort IA', { exact: true }).selectOption('high');
    await page.getByRole('button', { name: 'Terminé', exact: true }).click();
    await expect
      .poll(
        async () =>
          (await (await page.request.get(`${appServer}/api/v1/projects/${project.id}/cards/${card.id}`)).json()).data
            .aiEffort,
      )
      .toBe('high');
    await page.reload();
    await page.getByRole('heading', { name: card.title, exact: true }).click();
    await expect(page.getByLabel('Effort IA', { exact: true })).toHaveValue('high');
    await page.getByRole('button', { name: 'Terminé', exact: true }).click();
    const second = seed[1];
    const unchanged = await page.request.get(`${appServer}/api/v1/projects/${second.id}/ai`);
    expect((await unchanged.json()).data).toEqual({ engine: 'codex', model: '' });
    await page.request.put(`${appServer}/api/v1/projects/${project.id}/github`, {
      data: { repository: 'owner/first' },
    });
    const credentials = await page.request.post(`${appServer}/api/v1/agents`, {
      data: { name: 'Model agent', projectIds: [project.id] },
    });
    const token = (await credentials.json()).data.token,
      headers = { Authorization: `Bearer ${token}` };
    const base = `${appServer}/api/v1/projects/${project.id}/cards/${card.id}/work`;
    let run = (await (await page.request.post(base, { data: {} })).json()).data;
    const claimed = await request.post(`${base}/${run.id}/claim`, {
      headers,
      data: { version: run.version, aiSettingsSupported: true, engines: ['codex', 'claude-code'] },
    });
    run = (await claimed.json()).data;
    expect(run.ai).toEqual({ engine: 'claude-code', model: 'claude-sonnet-5-5', effort: 'high' });
    await page.request.put(`${appServer}/api/v1/projects/${project.id}/ai`, {
      data: { engine: 'codex', model: 'another-model' },
    });
    const question = await request.post(`${base}/${run.id}/question`, {
      headers,
      data: {
        version: run.version,
        leaseToken: run.leaseToken,
        message: 'Quelle fenêtre ?',
        usage: { inputTokens: 1200, outputTokens: 80, costUsd: 0.25 },
      },
    });
    expect(question.status()).toBe(200);
    await page.reload();
    await page.getByRole('heading', { name: card.title, exact: true }).click();
    await expect(page.getByLabel('Effort IA', { exact: true })).toBeDisabled();
    await expect(page.locator('.execution-usage')).toHaveText(
      /^Consommation : 1 tentative · moins d’une minute · 1\s200 tokens en entrée · 80 en sortie · coût estimé 0,25\s/,
    );
    await expect(
      page.getByText('Exécution : Claude Code · modèle claude-sonnet-5-5 · effort Élevé.', { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Terminé', exact: true }).click();
    await page.getByRole('button', { name: 'Paramètres du projet', exact: true }).click();
    await page.getByRole('tab', { name: /^Agent IA/ }).click();
    await page.getByText('Moteur et modèle IA', { exact: true }).click();
    await expect(models).toHaveValue('another-model');
    await expect(models.locator('option[value="another-model"]')).toHaveText('another-model (modèle enregistré)');
    await page.getByRole('button', { name: 'Enregistrer les paramètres IA', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('Moteur et modèle enregistrés pour ce projet.');
    expect((await (await page.request.get(`${appServer}/api/v1/projects/${project.id}/ai`)).json()).data).toEqual({
      engine: 'codex',
      model: 'another-model',
    });
    await models.selectOption('');
    await page.getByRole('button', { name: 'Enregistrer les paramètres IA', exact: true }).click();
    await expect
      .poll(
        async () => (await (await page.request.get(`${appServer}/api/v1/projects/${project.id}/ai`)).json()).data.model,
      )
      .toBe('');
  });
  test('a question appears in the open card and its answer leads to a downloadable generated Qt file', async ({
    page,
    request,
    appServer,
  }) => {
    await login(page, appServer);
    const project = seed[0],
      card = project.cards[0];
    expect(
      (
        await page.request.put(`${appServer}/api/v1/projects/${project.id}/github`, {
          data: { repository: 'owner/forms' },
        })
      ).status(),
    ).toBe(200);
    const credentials = await page.request.post(`${appServer}/api/v1/agents`, {
      data: { name: 'Form agent', projectIds: [project.id] },
    });
    const token = (await credentials.json()).data.token;
    const base = `${appServer}/api/v1/projects/${project.id}/cards/${card.id}/work`;
    const prepared = await page.request.post(base, { data: { delivery: 'github' } });
    let run = (await prepared.json()).data,
      leaseToken;
    const headers = { Authorization: `Bearer ${token}` };
    const action = async (name, data = {}) => {
      const response = await request.post(`${base}/${run.id}/${name}`, {
        headers,
        data: { version: run.version, leaseToken, ...data },
      });
      expect(response.status()).toBe(200);
      run = (await response.json()).data;
      if (run.leaseToken) leaseToken = run.leaseToken;
    };
    await page.reload();
    await page.getByRole('heading', { name: card.title, exact: true }).click();
    await action('claim');
    await action('question', { message: 'Quels champs souhaitez-vous dans votre formulaire Qt ?' });
    await expect(page.locator('.comments-section')).toContainText(
      'Quels champs souhaitez-vous dans votre formulaire Qt ?',
      { timeout: 15000 },
    );
    await page.getByLabel('Votre commentaire', { exact: true }).fill('Un champ Nom suffit.');
    await page.getByRole('button', { name: 'Publier', exact: true }).click();
    await expect
      .poll(async () => {
        const history = (await (await request.get(base, { headers })).json()).data;
        run = history.find(item => item.id === run.id);
        return run.state;
      })
      .toBe('ready');
    expect(run.exchanges.at(-1).answer.text).toBe('Un champ Nom suffit.');
    await action('claim');
    const xml = '<ui version="4.0"><class>PersonForm</class><widget class="QWidget" name="PersonForm"/></ui>';
    await action('submit', {
      artifactOnly: true,
      summary: 'Votre formulaire Qt est prêt.',
      checks: 'Structure XML vérifiée.',
      links: [],
      files: [
        {
          id: `generated-${run.id}-ui`,
          name: 'personne.ui',
          type: 'application/xml',
          size: Buffer.byteLength(xml),
          data: Buffer.from(xml).toString('base64'),
        },
      ],
    });
    const link = page.getByRole('link', { name: 'personne.ui', exact: true });
    await expect(link).toBeVisible({ timeout: 15000 });
    await expect(page.getByLabel('Statut', { exact: true })).toHaveValue('done');
    const downloading = page.waitForEvent('download');
    await link.click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe('personne.ui');
    expect(readFileSync(await download.path(), 'utf8')).toBe(xml);
  });
  test('agent questions and human replies use the card discussion through automatic merge', async ({
    page,
    request,
    appServer,
  }) => {
    await login(page, appServer);
    const project = seed[0],
      card = project.cards[0];
    await expect(page.getByRole('button', { name: 'Tâches du projet', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Paramètres du projet', exact: true }).click();
    await page.getByRole('tab', { name: /^Dépôt/ }).click();
    await page.getByText('Dépôt GitHub et fusion automatique', { exact: true }).click();
    await page.getByLabel('Dépôt du projet', { exact: true }).fill('flo91360/PlaniFiKateur');
    await page.getByRole('button', { name: 'Enregistrer le dépôt', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Dépôt enregistré pour ce projet.');
    await page.getByText('Connexion de l’agent (administrateur)', { exact: true }).click();
    await page.getByRole('button', { name: 'Créer la clé de l’agent', exact: true }).click();
    await expect(page.getByLabel('Clé de l’agent', { exact: true })).toHaveValue(/^[a-f0-9]{64}$/);
    const token = await page.getByLabel('Clé de l’agent', { exact: true }).inputValue();
    await page.getByRole('button', { name: 'Fermer', exact: true }).click();
    await page.getByRole('heading', { name: card.title, exact: true }).click();
    await expect(page.locator('.work-panel')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: /^Critères d’acceptation/ })).toHaveCount(0);
    await page.getByLabel('Description', { exact: true }).fill('Améliorer le menu mobile');
    await page.getByLabel('Statut', { exact: true }).selectOption('ready');
    await page.getByRole('button', { name: 'Terminé', exact: true }).click();
    await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
    const queue = async () =>
      (
        await (
          await request.get(`${appServer}/api/v1/projects/${project.id}/work`, {
            headers: { Authorization: `Bearer ${token}` },
          })
        ).json()
      ).data[0];
    let run = await queue(),
      leaseToken;
    expect(run).toMatchObject({
      objective: 'Améliorer le menu mobile',
      delivery: 'github',
      repository: 'flo91360/PlaniFiKateur',
    });
    const base = `${appServer}/api/v1/projects/${project.id}/cards/${card.id}/work`;
    const action = async (name, data = {}) => {
      const response = await request.post(`${base}/${run.id}/${name}`, {
        headers: { Authorization: `Bearer ${token}` },
        data: { version: run.version, leaseToken, ...data },
      });
      expect(response.status()).toBe(200);
      run = (await response.json()).data;
      if (run.leaseToken) leaseToken = run.leaseToken;
    };
    await action('claim');
    await action('question', { message: 'Dois-je conserver les raccourcis ?' });
    await page.getByRole('heading', { name: card.title, exact: true }).click();
    const discussion = page.locator('.comments-section');
    await expect(discussion).toContainText('Dois-je conserver les raccourcis ?');
    await expect(discussion).toContainText('Agent principal');
    await expect(
      discussion.locator('.comment').filter({ hasText: 'Dois-je conserver les raccourcis ?' }).locator('.user-avatar'),
    ).toHaveText('IA');
    await expect(page.getByLabel('Statut', { exact: true })).toHaveValue('clarify');
    await page.getByLabel('Votre commentaire', { exact: true }).fill('Oui, conserver tous les raccourcis.');
    await page.getByRole('button', { name: 'Publier', exact: true }).click();
    await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
    await expect(page.getByLabel('Statut', { exact: true })).toHaveValue('ready');
    await expect(
      discussion.locator('.comment').filter({ hasText: 'Oui, conserver tous les raccourcis.' }).locator('.user-avatar'),
    ).toHaveText('A');
    run = await queue();
    expect(run.exchanges[0].answer.text).toBe('Oui, conserver tous les raccourcis.');
    await action('claim');
    const pullRequest = { url: 'https://github.com/flo91360/PlaniFiKateur/pull/7', headSha: 'a'.repeat(40) };
    await action('submit', { summary: 'Menu réalisé.', checks: 'Navigation mobile testée.', links: [], pullRequest });
    // L’activité de l’agent figure dans le bandeau ; la discussion garde seulement la question et la réponse.
    const executionPanel = page.getByRole('region', { name: 'Exécution IA', exact: true });
    await expect(executionPanel).toContainText('Menu réalisé.', { timeout: 10000 });
    await expect(executionPanel).toContainText('Navigation mobile testée.');
    await expect(executionPanel.getByRole('link', { name: 'PR #7' })).toBeVisible();
    await expect(discussion).not.toContainText('Menu réalisé.');
    await expect(discussion).not.toContainText('Navigation mobile testée.');
    const event = {
      action: 'closed',
      repository: { full_name: 'flo91360/PlaniFiKateur' },
      pull_request: {
        number: 7,
        merged: true,
        merged_at: new Date().toISOString(),
        merge_commit_sha: 'c'.repeat(40),
        head: { sha: pullRequest.headSha, repo: { full_name: 'flo91360/PlaniFiKateur' } },
        base: { ref: 'main' },
      },
    };
    const raw = JSON.stringify(event);
    const merged = await request.post(`${appServer}/api/v1/github/webhook`, {
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'pull_request',
        'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', 'browser-github-secret').update(raw).digest('hex'),
      },
      data: raw,
    });
    expect(merged.status()).toBe(200);
    await expect(page.getByLabel('Statut', { exact: true })).toHaveValue('done', { timeout: 10000 });
    await expect(executionPanel).toContainText('PR fusionnée : tâche terminée.');
    await expect(discussion).not.toContainText('PR a été fusionnée');
    await page.getByRole('button', { name: 'Terminé', exact: true }).click();
    await page.reload();
    await page.getByRole('heading', { name: card.title, exact: true }).click();
    await expect(page.getByLabel('Statut', { exact: true })).toHaveValue('done');
    await expect(page.locator('.comment').filter({ hasText: 'Oui, conserver tous les raccourcis.' })).toHaveCount(1);
  });

  test('a ready card is automatically queued and can be withdrawn from its status before claim', async ({
    page,
    request,
    appServer,
  }) => {
    await login(page, appServer);
    const project = seed[0],
      card = project.cards[0];
    expect(
      (
        await page.request.put(`${appServer}/api/v1/projects/${project.id}/github`, {
          data: { repository: 'flo91360/PlaniFiKateur' },
        })
      ).status(),
    ).toBe(200);
    const credentials = await page.request.post(`${appServer}/api/v1/agents`, {
      data: { name: 'Status agent', projectIds: [project.id] },
    });
    expect(credentials.status()).toBe(201);
    const token = (await credentials.json()).data.token;
    const queue = async () =>
      (
        await (
          await request.get(`${appServer}/api/v1/projects/${project.id}/work`, {
            headers: { Authorization: `Bearer ${token}` },
          })
        ).json()
      ).data;
    await page.getByRole('heading', { name: card.title, exact: true }).click();
    await page.getByLabel('Statut', { exact: true }).selectOption('ready');
    await page.getByRole('button', { name: 'Terminé', exact: true }).click();
    await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
    const first = await queue();
    expect(first).toHaveLength(1);
    await page.getByRole('heading', { name: card.title, exact: true }).click();
    await expect(page.getByLabel('Statut', { exact: true })).toBeEnabled();
    await page.getByLabel('Statut', { exact: true }).selectOption('draft');
    await page.getByRole('button', { name: 'Terminé', exact: true }).click();
    await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
    expect(await queue()).toHaveLength(0);
    await page.getByRole('heading', { name: card.title, exact: true }).click();
    await page.getByLabel('Statut', { exact: true }).selectOption('ready');
    await page.getByRole('button', { name: 'Terminé', exact: true }).click();
    await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
    const next = await queue();
    expect(next).toHaveLength(1);
    expect(next[0].id).not.toBe(first[0].id);
  });

  test('interruption and recovery remain visible without replacing a local title draft', async ({
    page,
    request,
    appServer,
  }) => {
    await login(page, appServer);
    const project = seed[0],
      card = project.cards[0];
    await page.request.put(`${appServer}/api/v1/projects/${project.id}/github`, {
      data: { repository: 'flo91360/PlaniFiKateur' },
    });
    const credentials = await page.request.post(`${appServer}/api/v1/agents`, {
      data: { name: 'Recovery agent', projectIds: [project.id] },
    });
    expect(credentials.status()).toBe(201);
    const token = (await credentials.json()).data.token;
    const base = `${appServer}/api/v1/projects/${project.id}/cards/${card.id}/work`;
    const prepared = await page.request.post(base, { data: {} });
    expect(prepared.status()).toBe(201);
    let run = (await prepared.json()).data;
    const action = async (name, data = {}) => {
      const response = await request.post(`${base}/${run.id}/${name}`, {
        headers: { Authorization: `Bearer ${token}` },
        data: { version: run.version, leaseToken: run.leaseToken, ...data },
      });
      expect(response.status()).toBe(200);
      run = (await response.json()).data;
    };
    await action('claim');
    await page.getByRole('heading', { name: card.title, exact: true }).click();
    await expect(page.getByLabel('Statut', { exact: true })).toHaveValue('progress', { timeout: 10000 });
    await expect(page.getByLabel('Statut', { exact: true })).toBeDisabled();
    await page.getByLabel('Titre de la carte', { exact: true }).fill('Brouillon local conservé');
    await action('interrupt', { message: 'Connexion à l’outil interrompue.' });
    await expect(page.getByLabel('Titre de la carte', { exact: true })).toBeFocused();
    await expect.poll(async () => (await (await page.request.get(base)).json()).data[0].state).toBe('interrupted');
    await expect(page.getByLabel('Titre de la carte', { exact: true })).toHaveValue('Brouillon local conservé');
    await page.getByLabel('Titre de la carte', { exact: true }).fill(card.title);
    await page.getByRole('button', { name: 'Terminé', exact: true }).click();
    await page.getByRole('heading', { name: card.title, exact: true }).click();
    await expect(page.getByRole('region', { name: 'Exécution IA', exact: true })).toContainText(
      'Connexion à l’outil interrompue.',
    );
    await expect(page.locator('.comments-section')).not.toContainText('Connexion à l’outil interrompue.');
    await expect(page.getByLabel('Statut', { exact: true })).toHaveValue('ready');
    await action('claim');
    await expect(page.getByLabel('Statut', { exact: true })).toHaveValue('progress', { timeout: 10000 });
  });

  // Prépare un dépôt et une clé d’agent pour un projet ; renvoie l’en-tête de l’agent.
  const agentFor = async (page, appServer, project, name) => {
    await page.request.put(`${appServer}/api/v1/projects/${project.id}/github`, {
      data: { repository: 'flo91360/PlaniFiKateur' },
    });
    const credentials = await page.request.post(`${appServer}/api/v1/agents`, {
      data: { name, projectIds: [project.id] },
    });
    expect(credentials.status()).toBe(201);
    return { Authorization: `Bearer ${(await credentials.json()).data.token}` };
  };

  test('the AI execution panel entrusts, follows, cancels and relaunches a card', async ({
    page,
    request,
    appServer,
  }) => {
    await login(page, appServer);
    const project = seed[0],
      card = project.cards[0];
    const headers = await agentFor(page, appServer, project, 'Agent du panneau');
    const base = `${appServer}/api/v1/projects/${project.id}/cards/${card.id}/work`;
    const history = async () => (await (await request.get(base, { headers })).json()).data;
    await page.getByRole('heading', { name: card.title, exact: true }).click();
    const panel = page.getByRole('region', { name: 'Exécution IA', exact: true });
    await expect(panel).toContainText('Aucune exécution pour cette carte.');
    // Bouton inactif sans description, actif dès la saisie : la carte est enregistrée avant d’être confiée.
    const entrust = panel.getByRole('button', { name: 'Confier à l’agent', exact: true });
    const description = page.getByLabel('Description', { exact: true });
    await description.fill('');
    await expect(entrust).toBeDisabled();
    await description.fill('Demande saisie puis confiée sans autre action.');
    await expect(entrust).toBeEnabled();
    await entrust.click();
    await expect(panel).toContainText('En attente du worker');
    await expect(page.getByLabel('Statut', { exact: true })).toHaveValue('ready');
    let [run] = await history();
    expect(run.objective).toBe('Demande saisie puis confiée sans autre action.');
    const claimed = await request.post(`${base}/${run.id}/claim`, { headers, data: { version: run.version } });
    expect(claimed.status()).toBe(200);
    await expect(panel).toContainText('Agent du panneau réalise la demande.', { timeout: 10000 });
    await expect(panel.locator('[aria-current="step"]')).toHaveText('Réalisation');
    await expect(page.getByLabel('Statut', { exact: true })).toHaveValue('progress');
    await panel.getByRole('button', { name: 'Annuler l’exécution', exact: true }).click();
    await panel.getByRole('button', { name: 'Garder l’exécution', exact: true }).click();
    expect((await history())[0].state).toBe('running');
    await panel.getByRole('button', { name: 'Annuler l’exécution', exact: true }).click();
    await panel.getByLabel('Motif de l’annulation', { exact: true }).fill('Demande reportée.');
    await panel.getByRole('button', { name: 'Confirmer l’annulation', exact: true }).click();
    await expect(panel).toContainText('Exécution annulée.');
    await expect(panel).toContainText('Demande reportée.');
    await expect(page.getByLabel('Statut', { exact: true })).toHaveValue('draft');
    [run] = await history();
    expect(run).toMatchObject({ state: 'cancelled', cancellation: 'Demande reportée.' });
    await panel.getByRole('button', { name: 'Relancer l’agent', exact: true }).click();
    await expect(panel).toContainText('En attente du worker');
    await expect(panel).toContainText('2 exécutions');
    expect((await history()).map(item => item.state)).toEqual(['ready', 'cancelled']);
  });

  test('changing the request of an active execution asks for confirmation before cancelling it', async ({
    page,
    request,
    appServer,
  }) => {
    // Les navigateurs récents (Chrome 156) renvoient une promesse depuis scrollIntoView : le bandeau
    // de confirmation ne doit pas la confondre avec une fonction de nettoyage React.
    await page.addInitScript(() => {
      const scroll = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function (...args) {
        scroll.apply(this, args);
        return Promise.resolve();
      };
    });
    await login(page, appServer);
    const project = seed[0],
      card = project.cards[0];
    const headers = await agentFor(page, appServer, project, 'Agent confirmé');
    const base = `${appServer}/api/v1/projects/${project.id}/cards/${card.id}/work`;
    const history = async () => (await (await request.get(base, { headers })).json()).data;
    expect((await page.request.post(base, { data: {} })).status()).toBe(201);
    await page.reload();
    await page.getByRole('heading', { name: card.title, exact: true }).click();
    const panel = page.getByRole('region', { name: 'Exécution IA', exact: true });
    await expect(panel).toContainText('En attente du worker');
    await page.getByRole('button', { name: 'Supprimer la carte', exact: true }).click();
    await expect(page.locator('.delete-confirm')).toContainText('Son exécution IA en cours sera annulée.');
    await page.locator('.delete-confirm').getByRole('button', { name: 'Annuler', exact: true }).click();
    const description = page.getByLabel('Description', { exact: true });
    await description.fill('Une autre demande');
    await page.getByRole('button', { name: 'Terminé', exact: true }).click();
    await page.getByRole('button', { name: 'Rétablir la demande', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Détail de la carte', exact: true })).toHaveCount(0);
    expect((await history())[0].state).toBe('ready');
    await page.getByRole('heading', { name: card.title, exact: true }).click();
    await expect(description).toHaveValue(card.description);
    await description.fill('Une autre demande');
    await page.getByLabel('Titre de la carte', { exact: true }).click();
    await expect(page.locator('.detail-footer')).toContainText('Demande modifiée : confirmation à la fermeture');
    await expect(page.locator('.execution-confirm')).toHaveCount(0);
    await page.getByRole('button', { name: 'Terminé', exact: true }).click();
    await expect(page.locator('.execution-confirm')).toContainText('l’exécution IA en cours sera annulée');
    await page.getByRole('button', { name: 'Annuler l’exécution et enregistrer', exact: true }).click();
    await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
    await page.getByRole('heading', { name: card.title, exact: true }).click();
    await expect(description).toHaveValue('Une autre demande');
    await expect(panel).toContainText('Exécution annulée.', { timeout: 10000 });
    await expect(page.getByLabel('Statut', { exact: true })).toHaveValue('draft');
    expect((await history())[0].state).toBe('cancelled');
  });

  test('the inbox lists agent questions from every project and opens the card in its project', async ({
    page,
    request,
    appServer,
  }) => {
    await login(page, appServer);
    const project = seed[1],
      card = project.cards[0];
    const headers = await agentFor(page, appServer, project, 'Agent du site');
    const base = `${appServer}/api/v1/projects/${project.id}/cards/${card.id}/work`;
    await expect(page.getByRole('button', { name: 'À traiter', exact: true })).toBeVisible();
    let run = (await (await page.request.post(base, { data: {} })).json()).data;
    run = (await (await request.post(`${base}/${run.id}/claim`, { headers, data: { version: run.version } })).json())
      .data;
    const asked = await request.post(`${base}/${run.id}/question`, {
      headers,
      data: { version: run.version, leaseToken: run.leaseToken, message: 'Quelle couleur pour le bandeau ?' },
    });
    expect(asked.status()).toBe(200);
    await page.reload();
    await page.getByRole('button', { name: 'À traiter (1)', exact: true }).click();
    const inbox = page.getByRole('list', { name: 'Cartes à traiter', exact: true });
    await expect(inbox).toContainText('Question de l’agent · Site vitrine');
    await expect(inbox).toContainText('Quelle couleur pour le bandeau ?');
    await inbox.getByRole('button', { name: new RegExp(card.title) }).click();
    await expect(page.locator('.project-heading h1')).toHaveText('Site vitrine');
    await expect(page.getByLabel('Titre de la carte', { exact: true })).toHaveValue(card.title);
    const panel = page.getByRole('region', { name: 'Exécution IA', exact: true });
    await expect(panel).toContainText('L’agent attend votre réponse');
    // La question appartient à la discussion, sans doublon dans le bandeau.
    await expect(page.locator('.comments-section')).toContainText('Quelle couleur pour le bandeau ?');
    await expect(panel).not.toContainText('Quelle couleur pour le bandeau ?');
    await page.getByLabel('Votre commentaire', { exact: true }).fill('Un vert sapin.');
    await page.getByRole('button', { name: 'Publier', exact: true }).click();
    await expect(panel).toContainText('En attente du worker', { timeout: 10000 });
    await page.getByRole('button', { name: 'Terminé', exact: true }).click();
    await expect(page.getByRole('button', { name: 'À traiter', exact: true })).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'À traiter', exact: true }).click();
    await expect(page.getByText('Rien à traiter', { exact: false })).toBeVisible();
  });

  test('a project that requires approval waits for a manager before merging the agent PR', async ({
    page,
    request,
    appServer,
  }) => {
    await login(page, appServer);
    const project = seed[0],
      card = project.cards[0];
    const headers = await agentFor(page, appServer, project, 'Agent relu');
    await page.getByRole('button', { name: 'Paramètres du projet', exact: true }).click();
    await page.getByRole('tab', { name: /^Accès/ }).click();
    await page.getByText('Validation avant fusion', { exact: true }).click();
    await page.getByLabel('Approuver chaque PR avant sa fusion', { exact: true }).check();
    await page.getByRole('button', { name: 'Enregistrer la validation', exact: true }).click();
    await expect(page.getByText('Chaque PR de l’agent attendra désormais', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Fermer', exact: true }).click();
    const base = `${appServer}/api/v1/projects/${project.id}/cards/${card.id}/work`;
    let run = (await (await page.request.post(base, { data: {} })).json()).data;
    run = (await (await request.post(`${base}/${run.id}/claim`, { headers, data: { version: run.version } })).json())
      .data;
    const headSha = 'b'.repeat(40);
    const submitted = await request.post(`${base}/${run.id}/submit`, {
      headers,
      data: {
        version: run.version,
        leaseToken: run.leaseToken,
        summary: 'PR à relire.',
        checks: 'Tests lancés.',
        links: [],
        pullRequest: { url: 'https://github.com/flo91360/PlaniFiKateur/pull/9', headSha },
      },
    });
    expect(submitted.status()).toBe(200);
    const eligible = async () =>
      (
        await (
          await request.get(
            `${appServer}/api/v1/github/merge-eligibility?repository=flo91360/PlaniFiKateur&number=9&sha=${headSha}`,
            { headers },
          )
        ).json()
      ).data.eligible;
    expect(await eligible()).toBe(false);
    await page.getByRole('button', { name: 'À traiter (1)', exact: true }).click();
    await expect(page.getByRole('list', { name: 'Cartes à traiter', exact: true })).toContainText('Fusion à approuver');
    await page.getByRole('list', { name: 'Cartes à traiter', exact: true }).getByRole('button').first().click();
    const panel = page.getByRole('region', { name: 'Exécution IA', exact: true });
    await expect(panel).toContainText('elle attend l’approbation d’un responsable avant la fusion');
    await panel.getByRole('button', { name: 'Approuver la fusion', exact: true }).click();
    await expect(panel).toContainText('PR approuvée par Alice : fusion après les tests GitHub.');
    expect(await eligible()).toBe(true);
  });

  test('the event stream delivers board and agent changes without waiting for a refresh', async ({
    page,
    browser,
    request,
    appServer,
  }) => {
    // Horloge figée : aucune actualisation périodique ne se déclenche, seul le flux peut prévenir la page.
    await page.clock.install();
    await login(page, appServer);
    const project = seed[0],
      card = project.cards[0];
    const headers = await agentFor(page, appServer, project, 'Agent en direct');
    const context = await browser.newContext();
    const other = await context.newPage();
    await login(other, appServer);
    await newProject(other, 'Projet annoncé en direct');
    await expect(other.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
    await expect(
      page.getByRole('navigation', { name: 'Projets' }).getByRole('button', { name: /Projet annoncé en direct/ }),
    ).toHaveCount(1);
    await context.close();
    await page.getByRole('heading', { name: card.title, exact: true }).click();
    const panel = page.getByRole('region', { name: 'Exécution IA', exact: true });
    await expect(panel).toContainText('Aucune exécution pour cette carte.');
    const base = `${appServer}/api/v1/projects/${project.id}/cards/${card.id}/work`;
    let run = (await (await page.request.post(base, { data: {} })).json()).data;
    await expect(panel).toContainText('En attente du worker');
    run = (await (await request.post(`${base}/${run.id}/claim`, { headers, data: { version: run.version } })).json())
      .data;
    await expect(panel).toContainText('Agent en direct réalise la demande.');
    await request.post(`${base}/${run.id}/question`, {
      headers,
      data: { version: run.version, leaseToken: run.leaseToken, message: 'Une question en direct ?' },
    });
    await expect(panel).toContainText('L’agent attend votre réponse');
    await expect(page.locator('.comments-section')).toContainText('Une question en direct ?');
    await expect(page.getByRole('button', { name: 'À traiter (1)', exact: true })).toBeVisible();
  });
});

test('administrator cancels then confirms account deletion and immediately revokes member access', async ({
  page,
  browser,
  appServer,
}) => {
  await login(page, appServer);
  await page.getByRole('button', { name: 'Mon compte', exact: true }).click();
  await page.getByLabel('Nom du membre', { exact: true }).fill('Bob');
  await page.getByLabel('E-mail du membre', { exact: true }).fill('bob@example.test');
  await page.getByRole('button', { name: 'Créer une invitation', exact: true }).click();
  await expect(page.getByLabel('Lien d’invitation')).toHaveValue(/#invitation=[a-f0-9]{64}$/);
  const context = await browser.newContext();
  const member = await context.newPage();
  try {
    await member.goto(await page.getByLabel('Lien d’invitation').inputValue());
    await member.getByLabel('Votre nom', { exact: true }).fill('Bob');
    await member.getByLabel('Mot de passe', { exact: true }).fill('bob-browser-password-123');
    await member.getByRole('button', { name: 'Activer mon compte', exact: true }).click();
    await expect(member.locator('.project-heading h1')).toHaveText('PlaniFiKateur');
    await member.getByRole('button', { name: 'Mon compte', exact: true }).click();
    await expect(member.getByRole('button', { name: 'Supprimer le compte', exact: true })).toHaveCount(0);
    const row = page.locator('.member-list li').filter({ hasText: 'bob@example.test' });
    await row.getByRole('button', { name: 'Supprimer le compte', exact: true }).click();
    await expect(row.locator('.account-delete-confirm')).toContainText('Supprimer définitivement le compte de Bob');
    await row.getByRole('button', { name: 'Annuler la suppression', exact: true }).click();
    await expect(row.locator('.account-delete-confirm')).toHaveCount(0);
    expect((await context.request.get(`${appServer}/api/v1/workspace`)).status()).toBe(200);
    await row.getByRole('button', { name: 'Supprimer le compte', exact: true }).click();
    await row.getByRole('button', { name: 'Confirmer la suppression du compte', exact: true }).click();
    await expect(row).toHaveCount(0);
    await expect(page.getByRole('dialog')).toContainText('Le compte de Bob a été supprimé.');
    await expect(
      page.locator('.member-list li').getByRole('button', { name: 'Supprimer le compte', exact: true }),
    ).toHaveCount(0);
    expect((await context.request.get(`${appServer}/api/v1/workspace`)).status()).toBe(401);
    await member.reload();
    await expect(member.getByLabel('Adresse e-mail', { exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});

test.describe('automatic GitHub delivery', () => {
  test.use({ githubEnabled: true });
  test('a signed tag push updates the project Infos card automatically and survives reload', async ({
    page,
    request,
    appServer,
  }) => {
    await login(page, appServer);
    const configured = await page.request.put(`${appServer}/api/v1/projects/planifikateur/github`, {
      data: { repository: 'owner/first' },
    });
    expect(configured.status()).toBe(200);
    await page.reload();
    const infos = page
      .locator('.list-column')
      .filter({ has: page.getByRole('heading', { name: 'Infos', exact: true }) });
    const raw = JSON.stringify({
      ref: 'refs/tags/v2.0.0',
      deleted: false,
      repository: { full_name: 'owner/first', pushed_at: Date.parse('2026-10-12T07:32:00Z') / 1000 },
    });
    const publish = () =>
      request.post(`${appServer}/api/v1/github/webhook`, {
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'push',
          'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', 'browser-github-secret').update(raw).digest('hex'),
        },
        data: raw,
      });
    expect((await publish()).status()).toBe(200);
    const version = infos.locator('.card').filter({ has: page.getByRole('heading', { name: 'v2.0.0', exact: true }) });
    await expect(version.locator('h3')).toHaveText('v2.0.0', { timeout: 15000 });
    await expect(version.locator('p')).toContainText('12 octobre 2026 à 09:32');
    expect((await publish()).status()).toBe(200);
    await expect(infos.locator('.card')).toHaveCount(3);
    await page.reload();
    await expect(version.locator('h3')).toHaveText('v2.0.0');
    await expect(infos.getByRole('link', { name: 'Lire le mode d’emploi (README)' })).toHaveAttribute(
      'href',
      'https://github.com/owner/first#readme',
    );
    await infos.locator('.card').filter({ hasText: 'Mode d’emploi du projet' }).click();
    await expect(page.getByRole('link', { name: 'Consulter le mode d’emploi (README)' })).toHaveAttribute(
      'href',
      'https://github.com/owner/first#readme',
    );
    await page.getByRole('button', { name: 'Terminé', exact: true }).click();
    const downloads = {
      repository: 'owner/first',
      version: 'v2.0.0',
      commit: 'a'.repeat(40),
      folderId: 'drive-version-folder',
      files: [{ id: 'drive-executable-id', name: 'Product.exe', size: 100, md5: 'b'.repeat(32) }],
    };
    const release = JSON.stringify({
      action: 'edited',
      repository: { full_name: 'owner/first' },
      release: {
        draft: false,
        tag_name: 'v2.0.0',
        published_at: '2026-10-12T07:32:00Z',
        body: driveReleaseBody('Nouvelle interface et corrections', downloads),
      },
    });
    expect(
      (
        await request.post(`${appServer}/api/v1/github/webhook`, {
          headers: {
            'Content-Type': 'application/json',
            'X-GitHub-Event': 'release',
            'X-Hub-Signature-256':
              'sha256=' + createHmac('sha256', 'browser-github-secret').update(release).digest('hex'),
          },
          data: release,
        })
      ).status(),
    ).toBe(200);
    await page.reload();
    const changelog = infos
      .locator('.card')
      .filter({ has: page.getByRole('heading', { name: 'Changelog', exact: true }) });
    await expect(changelog.locator('p')).toContainText('Nouvelle interface et corrections');
    await expect(infos.getByRole('link', { name: 'Lire le changelog (CHANGELOG.md)' })).toHaveAttribute(
      'href',
      'https://github.com/owner/first/blob/HEAD/CHANGELOG.md',
    );
    await changelog.click();
    await expect(page.getByLabel('Description', { exact: true })).toHaveValue(/Nouvelle interface et corrections/);
    await expect(page.getByRole('link', { name: 'Consulter le changelog (CHANGELOG.md)' })).toHaveAttribute(
      'href',
      'https://github.com/owner/first/blob/HEAD/CHANGELOG.md',
    );
    await page.getByRole('button', { name: 'Terminé', exact: true }).click();
    await version.click();
    await expect(page.getByRole('link', { name: 'Télécharger cette version sur Google Drive' })).toHaveAttribute(
      'href',
      'https://drive.google.com/drive/folders/drive-version-folder',
    );
    await expect(page.getByRole('link', { name: 'Product.exe', exact: true })).toHaveAttribute(
      'href',
      'https://drive.google.com/file/d/drive-executable-id/view',
    );
  });
  test(
    'repositories persist separately for each project and missing configuration blocks preparation',
    { tag: '@mobile' },
    async ({ page, appServer }) => {
      await login(page, appServer);
      const configure = async repository => {
        await page.getByRole('button', { name: 'Paramètres du projet', exact: true }).click();
        await page.getByRole('tab', { name: /^Dépôt/ }).click();
        await page.getByText('Dépôt GitHub et fusion automatique', { exact: true }).click();
        await page.getByLabel('Dépôt du projet', { exact: true }).fill(repository);
        await page.getByRole('button', { name: 'Enregistrer le dépôt', exact: true }).click();
        await expect(page.getByRole('dialog').getByRole('status')).toHaveText('Dépôt enregistré pour ce projet.');
        await page.getByRole('button', { name: 'Fermer', exact: true }).click();
      };
      await configure('flo91360/PlaniFiKateur');
      await newProject(page, 'Klaviflo');
      await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
      await page.getByRole('button', { name: 'Ajouter une carte dans Améliorations', exact: true }).click();
      await page.getByLabel('Titre de la carte', { exact: true }).fill(seed[0].cards[0].title);
      await page.getByLabel('Description', { exact: true }).fill('Améliorer le menu de Klaviflo');
      await page.getByRole('button', { name: 'Créer la carte', exact: true }).click();
      await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
      await page.getByRole('button', { name: 'Paramètres du projet', exact: true }).click();
      await page.getByRole('tab', { name: /^Dépôt/ }).click();
      await page.getByText('Dépôt GitHub et fusion automatique', { exact: true }).click();
      await expect(page.getByLabel('Dépôt du projet', { exact: true })).toHaveValue('');
      await page.getByRole('button', { name: 'Fermer', exact: true }).click();
      await configure('flo91360/Klaviflo');
      await page.reload();
      // isVisible n’attend pas : vérifier le menu mobile seulement une fois le tableau rechargé.
      await expect(page.locator('.topbar')).toBeVisible();
      const projectMenu = page.getByRole('button', { name: 'Ouvrir les projets', exact: true });
      if (await projectMenu.isVisible()) await projectMenu.click();
      await page
        .getByRole('navigation', { name: 'Projets' })
        .getByRole('button', { name: /Klaviflo/ })
        .click();
      await page.getByRole('button', { name: 'Paramètres du projet', exact: true }).click();
      await page.getByRole('tab', { name: /^Dépôt/ }).click();
      await page.getByText('Dépôt GitHub et fusion automatique', { exact: true }).click();
      await expect(page.getByLabel('Dépôt du projet', { exact: true })).toHaveValue('flo91360/Klaviflo');
      await page.getByRole('button', { name: 'Fermer', exact: true }).click();
      const menu = page.getByRole('button', { name: 'Ouvrir les projets', exact: true });
      if (await menu.isVisible()) await menu.click();
      await page
        .getByRole('navigation', { name: 'Projets' })
        .getByRole('button', { name: /PlaniFiKateur/ })
        .click();
      await page.getByRole('button', { name: 'Paramètres du projet', exact: true }).click();
      await page.getByRole('tab', { name: /^Dépôt/ }).click();
      await page.getByText('Dépôt GitHub et fusion automatique', { exact: true }).click();
      await expect(page.getByLabel('Dépôt du projet', { exact: true })).toHaveValue('flo91360/PlaniFiKateur');
    },
  );
  test('shows the linked PR and finishes only after a signed merge notification', async ({
    page,
    request,
    appServer,
  }) => {
    await login(page, appServer);
    const project = seed[0],
      card = project.cards[0];
    await page.getByRole('button', { name: 'Paramètres du projet', exact: true }).click();
    const settings = page.getByRole('dialog');
    const discussion = page.locator('.comments-section');
    await settings.getByRole('tab', { name: /^Dépôt/ }).click();
    await settings.getByText('Dépôt GitHub et fusion automatique', { exact: true }).click();
    await settings.getByLabel('Dépôt du projet', { exact: true }).fill('flo91360/PlaniFiKateur');
    await settings.getByRole('button', { name: 'Enregistrer le dépôt', exact: true }).click();
    await expect(settings.getByRole('status')).toHaveText('Dépôt enregistré pour ce projet.');
    await expect(settings.getByLabel('Livraison', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Fermer', exact: true }).click();
    await page.getByRole('heading', { name: card.title, exact: true }).click();
    await page.getByLabel('Description', { exact: true }).fill('Corriger le menu');
    await page.getByLabel('Statut', { exact: true }).selectOption('ready');
    await page.getByLabel('Description', { exact: true }).press('Tab');
    await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
    await page.getByRole('button', { name: 'Terminé', exact: true }).click();
    await page.getByRole('heading', { name: card.title, exact: true }).click();
    await expect(page.getByLabel('Statut', { exact: true })).toHaveValue('ready');
    const credentials = await page.request.post(`${appServer}/api/v1/agents`, {
      data: { name: 'GitHub agent', projectIds: [project.id] },
    });
    const token = (await credentials.json()).data.token;
    const queue = await request.get(`${appServer}/api/v1/projects/${project.id}/work`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    let run = (await queue.json()).data[0];
    const base = `${appServer}/api/v1/projects/${project.id}/cards/${card.id}/work/${run.id}`;
    const claimed = await request.post(`${base}/claim`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { version: run.version },
    });
    run = (await claimed.json()).data;
    const sha = 'a'.repeat(40);
    const submitted = await request.post(`${base}/submit`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        version: run.version,
        leaseToken: run.leaseToken,
        summary: 'Menu corrigé',
        checks: 'Contrôles GitHub attendus',
        links: [],
        pullRequest: { url: 'https://github.com/flo91360/PlaniFiKateur/pull/7', headSha: sha },
      },
    });
    expect(submitted.status()).toBe(200);
    await expect(page.getByLabel('Statut', { exact: true })).toHaveValue('review', { timeout: 10000 });
    await expect(page.getByRole('button', { name: 'Valider le résultat', exact: true })).toHaveCount(0);
    const executionPanel = page.getByRole('region', { name: 'Exécution IA', exact: true });
    await expect(executionPanel.getByRole('link', { name: 'PR #7' })).toHaveAttribute(
      'href',
      'https://github.com/flo91360/PlaniFiKateur/pull/7',
    );
    await expect(discussion).not.toContainText('Menu corrigé');
    const event = {
      action: 'closed',
      repository: { full_name: 'flo91360/PlaniFiKateur' },
      pull_request: {
        number: 7,
        merged: true,
        merged_at: new Date().toISOString(),
        merge_commit_sha: 'b'.repeat(40),
        head: { sha, repo: { full_name: 'flo91360/PlaniFiKateur' } },
        base: { ref: 'main' },
      },
    };
    const raw = JSON.stringify(event);
    const response = await request.post(`${appServer}/api/v1/github/webhook`, {
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'pull_request',
        'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', 'browser-github-secret').update(raw).digest('hex'),
      },
      data: raw,
    });
    expect(response.status()).toBe(200);
    await expect(page.getByLabel('Statut', { exact: true })).toHaveValue('done', { timeout: 10000 });
    await expect(executionPanel).toContainText('PR fusionnée : tâche terminée.');
    await expect(discussion).not.toContainText('PR a été fusionnée');
    await page.getByRole('button', { name: 'Terminé', exact: true }).click();
    await page.getByRole('heading', { name: card.title, exact: true }).click();
    await expect(page.getByLabel('Statut', { exact: true })).toHaveValue('done');
  });
});

test.describe('Google Drive archive', () => {
  const runs = [];
  test.use({
    driveArchive: {
      refresh: () => {
        runs.push(Date.now());
        return Promise.resolve();
      },
      status: repository => ({
        enabled: true,
        configurationError: '',
        error: '',
        lastRun: '2026-10-12T10:00:00Z',
        running: false,
        repository: repository || '',
        checkedAt: '',
        repositoryError: '',
        releases: repository
          ? [
              {
                tag: 'v0.7.2',
                state: 'conflict',
                message: 'Un fichier différent existe déjà dans cette version. Aucun exécutable n’a été remplacé.',
                date: '2026-10-12T10:00:00Z',
                files: [],
              },
              {
                tag: 'v0.7.1',
                state: 'archived',
                message: '',
                date: '2026-10-11T10:00:00Z',
                files: [{ name: 'DefilOrdi-Portable-0.7.1.exe', size: 10 }],
                folderUrl: 'https://drive.google.com/drive/folders/drive-version-folder',
              },
            ]
          : [],
      }),
    },
  });
  test('project settings show each archived version, its Drive folder and the reason a version was skipped', async ({
    page,
    appServer,
  }) => {
    await login(page, appServer);
    const project = seed[0];
    await page.getByRole('button', { name: 'Paramètres du projet', exact: true }).click();
    await page.getByRole('tab', { name: /^Dépôt/ }).click();
    await page.getByText('Archivage des .exe sur Google Drive', { exact: true }).click();
    await expect(page.getByText('Associez un dépôt GitHub au projet : ses Releases', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Fermer', exact: true }).click();
    await page.request.put(`${appServer}/api/v1/projects/${project.id}/github`, {
      data: { repository: 'flo91360/DefilOrdi' },
    });
    await page.getByRole('button', { name: 'Paramètres du projet', exact: true }).click();
    await page.getByRole('tab', { name: /^Dépôt/ }).click();
    await page.getByText('Archivage des .exe sur Google Drive', { exact: true }).click();
    await expect(page.getByText('DefilOrdi/<version>/', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Ouvrir le dossier', exact: true })).toHaveAttribute(
      'href',
      'https://drive.google.com/drive/folders/drive-version-folder',
    );
    await expect(
      page.getByText('Non archivée : fichiers différents pour une version existante', { exact: false }),
    ).toBeVisible();
    const before = runs.length;
    await page.getByRole('button', { name: 'Vérifier les Releases maintenant', exact: true }).click();
    await expect.poll(() => runs.length).toBeGreaterThan(before);
  });
});

// Reconnaissance vocale simulée : le test dicte les résultats que le navigateur produirait.
const fakeSpeech = () => {
  window.__speechStarts = 0;
  window.SpeechRecognition = window.webkitSpeechRecognition = class {
    start() {
      window.__speech = this;
      window.__speechStarts++;
      this.results = [];
    }
    stop() {
      setTimeout(() => this.onend?.(), 0);
    }
    abort() {
      setTimeout(() => this.onend?.(), 0);
    }
    say(transcript, isFinal) {
      this.results = [...this.results.filter(result => result.isFinal), Object.assign([{ transcript }], { isFinal })];
      this.onresult?.({ resultIndex: 0, results: this.results });
    }
  };
};

test('dictation is unavailable without browser support and the magic wand explains a missing server key', async ({
  page,
  appServer,
}) => {
  await page.addInitScript(() => {
    delete window.SpeechRecognition;
    delete window.webkitSpeechRecognition;
  });
  await login(page, appServer);
  await page.getByRole('button', { name: 'Ajouter une carte dans Améliorations', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Reformuler avec l’IA', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Dicter la description', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'La dictée n’est pas prise en charge par ce navigateur. Utilisez Chrome, Edge ou Safari.',
  );
  await page.getByLabel('Titre de la carte', { exact: true }).fill('Export');
  await page.getByLabel('Description', { exact: true }).fill('exporter les cartes');
  await page.getByRole('button', { name: 'Reformuler avec l’IA', exact: true }).click();
  await expect(
    page.getByText(
      'La reformulation IA n’est pas configurée : ajoutez CLAUDE_CODE_OAUTH_TOKEN (créé avec « claude setup-token ») aux variables du serveur du site.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByLabel('Description', { exact: true })).toHaveValue('exporter les cartes');
});

test.describe('description assistant', () => {
  const calls = [];
  // Faux SDK Claude Agent : la reformulation dépend des réponses déjà fournies.
  const query = ({ prompt }) => {
    calls.push(prompt);
    const answered = prompt.includes('Réponse : En CSV');
    const result = answered
      ? { prompt: 'Objectif\nAjouter un export CSV de la liste des cartes.', questions: [] }
      : {
          prompt: 'Objectif\nAjouter un export de la liste des cartes.\nÀ préciser : format.',
          questions: ['Quel format de fichier ?'],
        };
    return (async function* () {
      yield { type: 'system', subtype: 'init', model: 'claude-opus-5-5' };
      yield { type: 'result', subtype: 'success', is_error: false, structured_output: result };
    })();
  };
  const repositoryContext = {
    get: async repository =>
      repository === 'owner/planifikateur'
        ? [
            { name: 'README', content: 'Le tableau exporte déjà les projets en JSON.' },
            { name: 'CLAUDE.md', content: 'Interface en français.' },
          ]
        : [],
  };
  test.use({
    refiner: createRefiner({
      token: 'browser-subscription-secret',
      query,
      directory: join(tmpdir(), 'planifikateur-browser-refine'),
    }),
    repositoryContext,
  });

  test('a dictated description is saved, then clarified by the magic wand and can be restored', async ({
    page,
    appServer,
  }) => {
    calls.length = 0;
    await page.addInitScript(fakeSpeech);
    await login(page, appServer);
    const project = seed[0],
      card = project.cards[0];
    const cardUrl = `${appServer}/api/v1/projects/${project.id}/cards/${card.id}`;
    const savedDescription = async () => (await (await page.request.get(cardUrl)).json()).data.description;
    expect(
      (
        await page.request.put(`${appServer}/api/v1/projects/${project.id}/github`, {
          data: { repository: 'owner/planifikateur' },
        })
      ).status(),
    ).toBe(200);
    await page.getByRole('heading', { name: card.title, exact: true }).click();
    const description = page.getByLabel('Description', { exact: true });
    await description.fill('');
    await page.getByRole('button', { name: 'Dicter la description', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Arrêter la dictée', exact: true })).toContainText('0:0');
    await expect(page.getByRole('button', { name: 'Reformuler avec l’IA', exact: true })).toBeDisabled();
    await page.evaluate(() => window.__speech.say('ajouter un export', false));
    await expect(page.locator('.dictation-live')).toHaveText('ajouter un export');
    await page.evaluate(() => window.__speech.say('ajouter un export', true));
    // A silence ends the browser session: dictation resumes until the person stops it.
    await page.evaluate(() => window.__speech.onend());
    await expect.poll(() => page.evaluate(() => window.__speechStarts)).toBe(2);
    await page.evaluate(() => window.__speech.say('de la liste des cartes', true));
    await expect(page.locator('.dictation-live')).toHaveText('ajouter un export de la liste des cartes');
    await expect(description).toHaveValue('');
    await page.getByRole('button', { name: 'Arrêter la dictée', exact: true }).click();
    await expect(description).toHaveValue('Ajouter un export de la liste des cartes');
    await expect.poll(savedDescription).toBe('Ajouter un export de la liste des cartes');

    await page.getByRole('button', { name: 'Reformuler avec l’IA', exact: true }).click();
    const proposal = page.getByRole('region', { name: 'Proposition de l’IA', exact: true });
    await expect(proposal.getByLabel('Demande reformulée', { exact: true })).toHaveValue(
      'Objectif\nAjouter un export de la liste des cartes.\nÀ préciser : format.',
    );
    await expect(description).toHaveValue('Ajouter un export de la liste des cartes');
    await expect(
      proposal.getByText('Documentation du dépôt utilisée : README, CLAUDE.md', { exact: true }),
    ).toBeVisible();
    expect(calls[0]).toContain('<<<README\nLe tableau exporte déjà les projets en JSON.\n>>>');
    expect(calls[0]).toContain(`Titre de la carte : ${card.title}`);
    expect(calls[0]).toContain('Ajouter un export de la liste des cartes');
    await expect(proposal.getByRole('button', { name: 'Reformuler avec mes réponses', exact: true })).toBeDisabled();
    await proposal.getByLabel('Réponse : Quel format de fichier ?', { exact: true }).fill('En CSV');
    await proposal.getByRole('button', { name: 'Reformuler avec mes réponses', exact: true }).click();
    await expect(proposal.getByLabel('Demande reformulée', { exact: true })).toHaveValue(
      'Objectif\nAjouter un export CSV de la liste des cartes.',
    );
    await expect(proposal.getByText('Points à préciser', { exact: true })).toHaveCount(0);
    expect(calls[1]).toContain('Question : Quel format de fichier ?\nRéponse : En CSV');
    await proposal.getByRole('button', { name: 'Remplacer la description', exact: true }).click();
    await expect(proposal).toHaveCount(0);
    await expect(description).toHaveValue('Objectif\nAjouter un export CSV de la liste des cartes.');
    await expect.poll(savedDescription).toBe('Objectif\nAjouter un export CSV de la liste des cartes.');
    expect(await page.content()).not.toContain('browser-subscription-secret');
    await page.getByRole('button', { name: 'Rétablir le texte précédent', exact: true }).click();
    await expect(description).toHaveValue('Ajouter un export de la liste des cartes');
    await expect.poll(savedDescription).toBe('Ajouter un export de la liste des cartes');
    await expect(page.getByRole('button', { name: 'Rétablir le texte précédent', exact: true })).toHaveCount(0);
  });
});

test('adds another member to card followers and preserves their ability to unsubscribe', async ({
  page,
  request,
  browser,
  appServer,
}) => {
  await login(page, appServer);
  const adminResponse = await request.post(`${appServer}/api/v1/session`, {
    data: { email: testEmail, password: testPassword },
  });
  expect(adminResponse.ok()).toBeTruthy();
  const invitation = await (
    await request.post(`${appServer}/api/v1/users`, { data: { name: 'Bob', email: 'bob@example.test' } })
  ).json();
  const bobContext = await browser.newContext();
  try {
    const accepted = await bobContext.request.post(`${appServer}/api/v1/accounts/accept`, {
      data: { token: invitation.data.token, name: 'Bob', password: 'bob-personal-password-123' },
    });
    expect(accepted.ok()).toBeTruthy();
    const card = seed[0].cards[0];
    const preview = page.locator('.card').filter({ has: page.getByRole('heading', { name: card.title, exact: true }) });
    await page.getByRole('heading', { name: card.title, exact: true }).click();
    await page.getByLabel('Membre à abonner').selectOption(invitation.data.user.id);
    await page.getByRole('button', { name: 'Ajouter au suivi', exact: true }).click();
    await expect(page.getByRole('list', { name: 'Membres abonnés' })).toHaveText('Bob');
    await expect(page.getByRole('button', { name: 'Suivre la carte', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Ajouter au suivi', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Suivre la carte', exact: true }).click();
    await expect(page.getByRole('list', { name: 'Membres abonnés' })).toHaveText('AliceBob');
    await page.getByRole('button', { name: 'Terminé', exact: true }).click();
    await expect(preview.locator('.card-avatar')).toHaveText(['A', 'B']);
    await expect(preview.locator('.card-avatar').nth(0)).toHaveAttribute('aria-label', 'Alice');
    await expect(preview.locator('.card-avatar').nth(1)).toHaveAttribute('title', 'Bob');
    await page.getByRole('heading', { name: card.title, exact: true }).click();
    await page.getByRole('button', { name: 'Ne plus suivre', exact: true }).click();
    await expect(page.getByRole('list', { name: 'Membres abonnés' })).toHaveText('Bob');
    await page.getByRole('button', { name: 'Terminé', exact: true }).click();
    await expect(preview.locator('.card-avatar')).toHaveText(['B']);
    await page.reload();
    await expect(preview.locator('.card-avatar')).toHaveText(['B']);
    await page.getByRole('heading', { name: card.title, exact: true }).click();
    await expect(page.getByRole('list', { name: 'Membres abonnés' })).toHaveText('Bob');
    await expect(
      page.getByLabel('Membre à abonner').locator(`option[value="${invitation.data.user.id}"]`),
    ).toHaveAttribute('disabled', '');
    const bobPage = await bobContext.newPage();
    await bobPage.goto(appServer);
    await bobPage.getByRole('heading', { name: card.title, exact: true }).click();
    await expect(bobPage.getByRole('button', { name: 'Ne plus suivre', exact: true })).toBeEnabled();
    await bobPage.getByRole('button', { name: 'Ne plus suivre', exact: true }).click();
    await expect(bobPage.getByRole('button', { name: 'Suivre la carte', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Terminé', exact: true }).click();
    await expect(preview.locator('.card-avatar')).toHaveCount(0);
    await page.reload();
    await page.getByRole('heading', { name: card.title, exact: true }).click();
    await expect(page.getByText('Aucun membre ne suit cette carte.', { exact: true })).toBeVisible();
  } finally {
    await bobContext.close();
  }
});
