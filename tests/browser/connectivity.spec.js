import { test as base, expect } from '@playwright/test';
import { createAppServer } from '../../server/index.js';
import { createStore } from '../../server/store.js';
import { seed } from '../../src/data/demo.js';
import { createBackups } from '../../server/backups.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedAccount, testEmail, testPassword } from '../helpers/accounts.mjs';

const ownerToken = 'owner-browser-test-key';
const readToken = 'agent-browser-test-key';
const test = base.extend({
  initialAccounts: [true, { option: true }],
  appServer: async ({ initialAccounts }, use) => {
    const store = createStore(':memory:');
    if (initialAccounts) seedAccount(store);
    const dir = mkdtempSync(join(tmpdir(), 'planifikateur-browser-backups-'));
    const backups = createBackups(store, { directory: dir });
    const server = createAppServer({ store, config: { ownerToken, readToken, backups } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await use(`http://127.0.0.1:${server.address().port}`);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); backups.close(); store.close(); rmSync(dir, { recursive: true, force: true });
  },
});
const login = async (page, url) => {
  await page.goto(url);
  await page.getByLabel('Adresse e-mail', { exact: true }).fill(testEmail);
  await page.getByLabel('Mot de passe', { exact: true }).fill(testPassword);
  await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
  await expect(page.locator('.project-heading h1')).toHaveText('PlaniFiKateur');
};
const newProject = async (page, name) => {
  const menu = page.getByRole('button', { name: 'Ouvrir les projets', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('button', { name: 'Nouveau projet', exact: true }).click();
  await page.getByLabel('Nom du projet', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'Créer le projet', exact: true }).click();
};

test('a UI-created card is readable by an agent and another browser', async ({ page, request, browser, appServer }) => {
  await page.goto(appServer);
  await page.getByLabel('Adresse e-mail', { exact: true }).fill(testEmail);
  await page.getByLabel('Mot de passe', { exact: true }).fill('wrong');
  await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Adresse e-mail ou mot de passe incorrect.');
  await login(page, appServer);
  await newProject(page, 'Projet connecté');
  await page.getByRole('button', { name: 'Ajouter une carte dans Bugs', exact: true }).click();
  await page.getByLabel('Titre de la carte', { exact: true }).fill('Bug visible par les agents');
  await page.getByLabel('Description', { exact: true }).fill('Le contexte de la demande.');
  await page.getByLabel('Statut', { exact: true }).selectOption('ready');
  await page.getByLabel('Votre commentaire').fill('Une précision');
  await page.getByRole('button', { name: 'Créer la carte', exact: true }).click();
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
  const projectData = await (await request.get(`${appServer}/api/v1/projects`, { headers: { Authorization: `Bearer ${readToken}` } })).json();
  const projectId = projectData.data.find(p => p.name === 'Projet connecté').id;
  const response = await request.get(`${appServer}/api/v1/projects/${projectId}/cards?status=ready&q=Bug%20visible`, { headers: { Authorization: `Bearer ${readToken}` } });
  expect(response.status()).toBe(200);
  const { data } = await response.json();
  expect(data).toHaveLength(1);
  expect(data[0]).toMatchObject({ title: 'Bug visible par les agents', projectName: 'Projet connecté', listName: 'Bugs', description: 'Le contexte de la demande.' });
  expect(data[0].comments[0].text).toBe('Une précision');
  expect((await request.put(`${appServer}/api/v1/workspace`, { headers: { Authorization: `Bearer ${readToken}` }, data: {} })).status()).toBe(401);
  const context = await browser.newContext();
  const other = await context.newPage(); await login(other, appServer);
  const menu = other.getByRole('button', { name: 'Ouvrir les projets', exact: true });
  if (await menu.isVisible()) await menu.click();
  await other.getByRole('navigation', { name: 'Projets' }).getByRole('button', { name: /Projet connecté/ }).click();
  await expect(other.getByRole('heading', { name: 'Bug visible par les agents', exact: true })).toBeVisible();
  await context.close();
});

test('a stale browser cannot overwrite another browser; reload is explicit', async ({ page, browser, request, appServer }) => {
  await login(page, appServer);
  const context = await browser.newContext(); const other = await context.newPage(); await login(other, appServer);
  await other.route('**/api/v1/workspace', route => route.request().method() === 'GET' ? route.abort() : route.continue());
  await newProject(page, 'Premier éditeur');
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
  await newProject(other, 'Second éditeur');
  await expect(other.getByRole('alert')).toContainText('Le tableau a changé');
  await expect(other.getByRole('heading', { name: 'Second éditeur', exact: true })).toBeVisible();
  const response = await request.get(`${appServer}/api/v1/projects`, { headers: { Authorization: `Bearer ${readToken}` } });
  const { data } = await response.json();
  expect(data.some(p => p.name === 'Premier éditeur')).toBe(true);
  expect(data.some(p => p.name === 'Second éditeur')).toBe(false);
  await other.getByRole('button', { name: 'Recharger le tableau', exact: true }).click();
  await expect(other.getByRole('dialog')).toContainText('seront abandonnées');
  await other.unroute('**/api/v1/workspace');
  await other.getByRole('button', { name: 'Recharger depuis le serveur', exact: true }).click();
  await expect(other.getByRole('heading', { name: 'PlaniFiKateur', exact: true })).toBeVisible();
  await expect(other.getByRole('alert')).toHaveCount(0);
  await context.close();
});

test('a failed save preserves edits and can be retried', async ({ page, request, appServer }) => {
  await login(page, appServer);
  await page.route('**/api/v1/workspace', async route => {
    if (route.request().method() === 'PUT') await route.abort(); else await route.continue();
  });
  await newProject(page, 'Projet conservé');
  await expect(page.getByRole('alert')).toContainText('Vos modifications restent');
  await expect(page.getByRole('heading', { name: 'Projet conservé', exact: true })).toBeVisible();
  await page.unroute('**/api/v1/workspace');
  await page.getByRole('button', { name: 'Réessayer la sauvegarde', exact: true }).click();
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
  const { data } = await (await request.get(`${appServer}/api/v1/projects`, { headers: { Authorization: `Bearer ${readToken}` } })).json();
  expect(data.some(p => p.name === 'Projet conservé')).toBe(true);
});

test('JSON import adds local cards to the API without replacing existing projects', async ({ page, request, appServer }) => {
  await login(page, appServer);
  await page.getByRole('button', { name: 'Informations sur le prototype', exact: true }).click();
  const imported = structuredClone(seed[0]); imported.name = 'Projet importé'; imported.cards[0].title = 'Une idée importée';
  await page.getByLabel('Importer des projets JSON').setInputFiles({ name: 'projects.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ projects: [imported] })) });
  await page.getByRole('button', { name: 'C’est compris', exact: true }).click();
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
  const { data } = await (await request.get(`${appServer}/api/v1/projects`, { headers: { Authorization: `Bearer ${readToken}` } })).json();
  expect(data).toHaveLength(3);
  const cards = await (await request.get(`${appServer}/api/v1/projects/${data.find(p => p.name === 'Projet importé').id}/cards?q=importée`, { headers: { Authorization: `Bearer ${readToken}` } })).json();
  expect(cards.data).toHaveLength(1);
  expect(cards.data[0].projectName).toBe('Projet importé');
});

test('project deletion requires confirmation, removes cards and permits an empty workspace', async ({ page, request, appServer }) => {
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
  expect((await request.get(`${appServer}/api/v1/projects/${seed[0].id}/cards/${seed[0].cards[0].id}`, { headers })).status()).toBe(404);
  expect((await (await request.get(`${appServer}/api/v1/projects/${seed[1].id}/cards`, { headers })).json()).data).toHaveLength(seed[1].cards.length);
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
});

test('another browser receives changes automatically and unchanged polls do not save', async ({ page, browser, appServer }) => {
  await page.clock.install();
  await login(page, appServer);
  const context = await browser.newContext(); const other = await context.newPage(); await login(other, appServer);
  let writes = 0;
  page.on('request', req => { if (req.url().endsWith('/api/v1/workspace') && req.method() === 'PUT') writes++; });
  await newProject(other, 'Projet partagé en direct');
  await expect(other.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
  await page.clock.runFor(5100);
  await expect(page.getByRole('navigation', { name: 'Projets' }).getByRole('button', { name: /Projet partagé en direct/ })).toHaveCount(1);
  await other.getByRole('button', { name: 'Supprimer le projet', exact: true }).click();
  await other.getByRole('button', { name: 'Confirmer la suppression', exact: true }).click();
  await expect(other.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
  await page.clock.runFor(5100);
  await expect(page.getByRole('navigation', { name: 'Projets' }).getByRole('button', { name: /Projet partagé en direct/ })).toHaveCount(0);
  await page.clock.runFor(5100);
  expect(writes).toBe(0);
  await context.close();
});

test('automatic refresh pauses while editing and preserves a draft during a concurrent change', async ({ page, browser, appServer }) => {
  await page.clock.install(); await login(page, appServer);
  const context = await browser.newContext(); const other = await context.newPage(); await login(other, appServer);
  await page.getByRole('heading', { name: seed[0].cards[0].title, exact: true }).click();
  await page.getByLabel('Description', { exact: true }).fill('Mon texte en cours de rédaction');
  await newProject(other, 'Changement pendant la saisie');
  await expect(other.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
  await page.clock.runFor(10100);
  await expect(page.getByLabel('Description', { exact: true })).toHaveValue('Mon texte en cours de rédaction');
  await expect(page.getByRole('navigation', { name: 'Projets' }).getByRole('button', { name: /Changement pendant la saisie/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Terminé', exact: true }).click();
  await page.clock.runFor(500);
  await expect(page.getByRole('alert')).toContainText('Le tableau a changé');
  await page.clock.runFor(5100);
  await page.getByRole('heading', { name: seed[0].cards[0].title, exact: true }).click();
  await expect(page.getByLabel('Description', { exact: true })).toHaveValue('Mon texte en cours de rédaction');
  await context.close();
});

test('refresh recovers after a network error without losing the current board', async ({ page, browser, appServer }) => {
  await page.clock.install(); await login(page, appServer);
  await page.route('**/api/v1/workspace', route => route.request().method() === 'GET' ? route.abort() : route.continue());
  await page.clock.runFor(5100);
  await expect(page.getByText('Actualisation indisponible.', { exact: false })).toBeVisible();
  await expect(page.getByRole('heading', { name: seed[0].name, exact: true })).toBeVisible();
  const context = await browser.newContext(); const other = await context.newPage(); await login(other, appServer);
  await newProject(other, 'Après reconnexion');
  await expect(other.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
  await page.unroute('**/api/v1/workspace');
  await page.clock.runFor(5100);
  await expect(page.getByRole('navigation', { name: 'Projets' }).getByRole('button', { name: /Après reconnexion/ })).toHaveCount(1);
  await expect(page.getByText('Actualisation indisponible.', { exact: false })).toHaveCount(0);
  await context.close();
});

test('owner can create and download a SQLite backup from the interface', async ({ page, appServer }) => {
  await login(page, appServer);
  await newProject(page, 'Projet dans ma sauvegarde');
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
  await page.getByRole('button', { name: 'Informations sur le prototype', exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Créer et télécharger une sauvegarde SQLite', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^planifikateur-.*\.sqlite$/);
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const db = new DatabaseSync(await download.path(), { readOnly: true });
  const projects = JSON.parse(db.prepare('SELECT projects FROM workspace WHERE id = 1').get().projects);
  db.close();
  expect(projects.some(p => p.name === 'Projet dans ma sauvegarde')).toBe(true);
});

test('a delayed refresh cannot replace a form opened while the read was in flight', async ({ page, browser, appServer }) => {
  await page.clock.install(); await login(page, appServer);
  const context = await browser.newContext(); const other = await context.newPage(); await login(other, appServer);
  await newProject(other, 'Réponse retardée');
  await expect(other.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
  let held, captured;
  const pending = new Promise(resolve => { captured = resolve; });
  await page.route('**/api/v1/workspace', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch(); held = () => route.fulfill({ response }); captured();
  });
  await page.clock.runFor(5100); await pending;
  await page.getByRole('button', { name: 'Ajouter une carte dans Bugs', exact: true }).click();
  await page.getByLabel('Titre de la carte', { exact: true }).fill('Mon brouillon intact');
  await held();
  await expect(page.getByLabel('Titre de la carte', { exact: true })).toHaveValue('Mon brouillon intact');
  await expect(page.getByRole('navigation', { name: 'Projets' }).getByRole('button', { name: /Réponse retardée/ })).toHaveCount(0);
  await page.unroute('**/api/v1/workspace');
  await page.getByRole('button', { name: 'Annuler', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Projets' }).getByRole('button', { name: /Réponse retardée/ })).toHaveCount(1);
  await context.close();
});

test('closing an unchanged card does not save stale data and resumes refresh', async ({ page, browser, appServer }) => {
  await page.clock.install(); await login(page, appServer);
  const context = await browser.newContext(); const other = await context.newPage(); await login(other, appServer);
  let writes = 0;
  page.on('request', req => { if (req.url().endsWith('/api/v1/workspace') && req.method() === 'PUT') writes++; });
  await page.getByRole('heading', { name: seed[0].cards[0].title, exact: true }).click();
  await newProject(other, 'Pendant la consultation');
  await expect(other.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
  await page.getByRole('button', { name: 'Terminé', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Projets' }).getByRole('button', { name: /Pendant la consultation/ })).toHaveCount(1);
  expect(writes).toBe(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await context.close();
});

test('administrator invites a member whose cards, comments and actions carry their own identity', async ({ page, browser, appServer }) => {
  await login(page, appServer);
  await page.getByRole('button', { name: 'Mon compte', exact: true }).click();
  await page.getByLabel('Nom du membre', { exact: true }).fill('Bob');
  await page.getByLabel('E-mail du membre', { exact: true }).fill('bob@example.test');
  await page.getByRole('button', { name: 'Créer une invitation', exact: true }).click();
  await expect(page.getByLabel('Lien d’invitation')).toHaveValue(/#invitation=[a-f0-9]{64}$/);
  const invitation = await page.getByLabel('Lien d’invitation').inputValue();
  const context = await browser.newContext(); const member = await context.newPage();
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
  await member.getByRole('heading', { name: 'Carte créée par Bob', exact: true }).click();
  await expect(member.locator('.card-authorship')).toContainText('Créée par Bob');
  await expect(member.locator('.comment strong')).toContainText('Bob');
  await expect(member.locator('.activity-list')).toContainText('Bob a créé la carte');
  await member.getByRole('button', { name: 'Terminé', exact: true }).click();
  await member.getByRole('button', { name: 'Mon compte', exact: true }).click();
  await expect(member.getByRole('heading', { name: 'Membres de l’espace', exact: true })).toHaveCount(0);
  await member.getByRole('button', { name: 'Fermer', exact: true }).click();
  await member.getByRole('button', { name: 'Informations sur le prototype', exact: true }).click();
  await expect(member.getByRole('button', { name: 'Créer et télécharger une sauvegarde SQLite', exact: true })).toHaveCount(0);
  const memberRow = page.locator('.member-list li').filter({ hasText: 'bob@example.test' });
  await memberRow.getByRole('button', { name: 'Désactiver', exact: true }).click();
  await expect(memberRow).toContainText('Désactivé');
  expect((await context.request.get(`${appServer}/api/v1/workspace`)).status()).toBe(401);
  await context.close();
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
