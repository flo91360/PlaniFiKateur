import { createHmac } from 'node:crypto';
import { driveReleaseBody } from '../../src/lib/drive-release.js';
import { test as base, expect } from '@playwright/test';
import { createAppServer } from '../../server/index.js';
import { createStore } from '../../server/store.js';
import { seed } from '../../src/data/demo.js';
import { createBackups } from '../../server/backups.js';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedAccount, testEmail, testPassword } from '../helpers/accounts.mjs';
import { createRefiner } from '../../server/refine.js';

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
    if (githubEnabled) { const initial = store.read(); initial.projects.forEach(p => p.cards.forEach(c => { c.status = 'draft'; })); store.write(initial.projects, initial.revision, user); }
    const dir = mkdtempSync(join(tmpdir(), 'planifikateur-browser-backups-'));
    const backups = createBackups(store, { directory: dir });
    const server = createAppServer({ store, config: { ownerToken, readToken, backups, githubWebhookSecret: githubEnabled ? 'browser-github-secret' : '', ...(driveArchive ? { driveArchive } : {}), ...(refiner ? { refiner } : {}), ...(repositoryContext ? { repositoryContext } : {}) } });
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
  await expect(page.getByLabel('Effort IA', { exact: true })).toHaveValue('medium');
  await expect(page.getByLabel('Effort IA', { exact: true }).locator('option[value=""]')).toHaveCount(0);
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
  expect(data[0]).toMatchObject({ title: 'Bug visible par les agents', projectName: 'Projet connecté', listName: 'Bugs', description: 'Le contexte de la demande.', aiEffort: 'medium' });
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
  await expect(member.locator('.card').filter({ has: member.getByRole('heading', { name: 'Carte créée par Bob', exact: true }) }).locator('.card-avatar')).toHaveText('B');
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

test('follows an existing card without being its author and keeps the setting after reload', async ({ page, appServer }) => {
  await login(page, appServer);
  const card = seed[0].cards[0];
  await page.getByRole('heading', { name: card.title, exact: true }).click();
  await expect(page.getByRole('button', { name: 'Suivre la carte', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Suivre la carte', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Ne plus suivre', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await expect(page.locator('.project-heading h1')).toHaveText('PlaniFiKateur');
  await page.getByRole('heading', { name: card.title, exact: true }).click();
  await expect(page.getByRole('button', { name: 'Ne plus suivre', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Ne plus suivre', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Suivre la carte', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Actualiser l’historique', exact: true }).click();
  await expect(page.locator('.activity-list')).toContainText('Alice ne suit plus la carte');
});

test.describe('project task execution', () => {
  test.use({ githubEnabled: true });
  test('project execution profiles survive reload and worker diagnostics appear without configuration files', async ({ page, request, appServer }) => {
    await login(page, appServer);
    const project = seed[0];
    await page.request.put(`${appServer}/api/v1/projects/${project.id}/github`, { data: { repository: 'flo91360/DefilOrdi' } });
    await page.getByRole('button', { name: 'Paramètres du projet', exact: true }).click();
    await page.getByText('Exécution et connexion du projet', { exact: true }).click();
    await expect(page.getByLabel('Profil d’exécution', { exact: true })).toHaveValue('defilordi');
    await page.getByLabel('Profil d’exécution', { exact: true }).selectOption('funkart');
    await page.getByRole('button', { name: 'Enregistrer le profil', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('Profil enregistré pour les prochaines tâches.');
    await page.reload();
    await page.getByRole('button', { name: 'Paramètres du projet', exact: true }).click();
    await page.getByText('Exécution et connexion du projet', { exact: true }).click();
    await expect(page.getByLabel('Profil d’exécution', { exact: true })).toHaveValue('funkart');
    await expect(page.getByText('Fusion automatique après réussite des contrôles : export.', { exact: true })).toBeVisible();
    const credentials = await page.request.post(`${appServer}/api/v1/agents`, { data: { name: 'Worker', projectIds: [project.id] } });
    const token = (await credentials.json()).data.token;
    const report = await request.post(`${appServer}/api/v1/agent/projects/${project.id}/diagnostic`, { headers: { Authorization: `Bearer ${token}` }, data: { state: 'blocked', checks: [{ name: 'Godot', state: 'blocked', message: 'Godot 4.4.1 doit être installé sur le worker.' }] } });
    expect(report.status()).toBe(200);
    await page.reload();
    await page.getByRole('button', { name: 'Paramètres du projet', exact: true }).click();
    await page.getByText('Exécution et connexion du projet', { exact: true }).click();
    await expect(page.getByText('Godot 4.4.1 doit être installé sur le worker.', { exact: false })).toBeVisible();
  });
  test('engine and model are project settings while effort persists on each card and is locked during a conversation', async ({ page, request, appServer }) => {
    await login(page, appServer);
    const project = seed[0], card = project.cards[0];
    await page.getByRole('button', { name: 'Paramètres du projet', exact: true }).click();
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
    await expect.poll(async () => (await (await page.request.get(`${appServer}/api/v1/projects/${project.id}/cards/${card.id}`)).json()).data.aiEffort).toBe('high');
    await page.reload();
    await page.getByRole('heading', { name: card.title, exact: true }).click();
    await expect(page.getByLabel('Effort IA', { exact: true })).toHaveValue('high');
    await page.getByRole('button', { name: 'Terminé', exact: true }).click();
    const second = seed[1];
    const unchanged = await page.request.get(`${appServer}/api/v1/projects/${second.id}/ai`);
    expect((await unchanged.json()).data).toEqual({ engine: 'codex', model: '' });
    await page.request.put(`${appServer}/api/v1/projects/${project.id}/github`, { data: { repository: 'owner/first' } });
    const credentials = await page.request.post(`${appServer}/api/v1/agents`, { data: { name: 'Model agent', projectIds: [project.id] } });
    const token = (await credentials.json()).data.token, headers = { Authorization: `Bearer ${token}` };
    const base = `${appServer}/api/v1/projects/${project.id}/cards/${card.id}/work`;
    let run = (await (await page.request.post(base, { data: {} })).json()).data;
    const claimed = await request.post(`${base}/${run.id}/claim`, { headers, data: { version: run.version, aiSettingsSupported: true, engines: ['codex', 'claude-code'] } });
    run = (await claimed.json()).data;
    expect(run.ai).toEqual({ engine: 'claude-code', model: 'claude-sonnet-5-5', effort: 'high' });
    await page.request.put(`${appServer}/api/v1/projects/${project.id}/ai`, { data: { engine: 'codex', model: 'another-model' } });
    const question = await request.post(`${base}/${run.id}/question`, { headers, data: { version: run.version, leaseToken: run.leaseToken, message: 'Quelle fenêtre ?' } });
    expect(question.status()).toBe(200);
    await page.reload(); await page.getByRole('heading', { name: card.title, exact: true }).click();
    await expect(page.getByLabel('Effort IA', { exact: true })).toBeDisabled();
    await expect(page.getByText('Exécution : Claude Code · modèle claude-sonnet-5-5 · effort Élevé.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Terminé', exact: true }).click();
    await page.getByRole('button', { name: 'Paramètres du projet', exact: true }).click();
    await page.getByText('Moteur et modèle IA', { exact: true }).click();
    await expect(models).toHaveValue('another-model');
    await expect(models.locator('option[value="another-model"]')).toHaveText('another-model (modèle enregistré)');
    await page.getByRole('button', { name: 'Enregistrer les paramètres IA', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('Moteur et modèle enregistrés pour ce projet.');
    expect((await (await page.request.get(`${appServer}/api/v1/projects/${project.id}/ai`)).json()).data).toEqual({ engine: 'codex', model: 'another-model' });
    await models.selectOption('');
    await page.getByRole('button', { name: 'Enregistrer les paramètres IA', exact: true }).click();
    await expect.poll(async () => (await (await page.request.get(`${appServer}/api/v1/projects/${project.id}/ai`)).json()).data.model).toBe('');
  });
  test('a question appears in the open card and its answer leads to a downloadable generated Qt file', async ({ page, request, appServer }) => {
    await login(page, appServer);
    const project = seed[0], card = project.cards[0];
    expect((await page.request.put(`${appServer}/api/v1/projects/${project.id}/github`, { data: { repository: 'owner/forms' } })).status()).toBe(200);
    const credentials = await page.request.post(`${appServer}/api/v1/agents`, { data: { name: 'Form agent', projectIds: [project.id] } });
    const token = (await credentials.json()).data.token;
    const base = `${appServer}/api/v1/projects/${project.id}/cards/${card.id}/work`;
    const prepared = await page.request.post(base, { data: { delivery: 'github' } });
    let run = (await prepared.json()).data, leaseToken;
    const headers = { Authorization: `Bearer ${token}` };
    const action = async (name, data = {}) => {
      const response = await request.post(`${base}/${run.id}/${name}`, { headers, data: { version: run.version, leaseToken, ...data } });
      expect(response.status()).toBe(200);
      run = (await response.json()).data;
      if (run.leaseToken) leaseToken = run.leaseToken;
    };
    await page.reload();
    await page.getByRole('heading', { name: card.title, exact: true }).click();
    await action('claim');
    await action('question', { message: 'Quels champs souhaitez-vous dans votre formulaire Qt ?' });
    await expect(page.locator('.comments-section')).toContainText('Quels champs souhaitez-vous dans votre formulaire Qt ?', { timeout: 15000 });
    await page.getByLabel('Votre commentaire', { exact: true }).fill('Un champ Nom suffit.');
    await page.getByRole('button', { name: 'Publier', exact: true }).click();
    await expect.poll(async () => {
      const history = (await (await request.get(base, { headers })).json()).data;
      run = history.find(item => item.id === run.id);
      return run.state;
    }).toBe('ready');
    expect(run.exchanges.at(-1).answer.text).toBe('Un champ Nom suffit.');
    await action('claim');
    const xml = '<ui version="4.0"><class>PersonForm</class><widget class="QWidget" name="PersonForm"/></ui>';
    await action('submit', { artifactOnly: true, summary: 'Votre formulaire Qt est prêt.', checks: 'Structure XML vérifiée.', links: [], files: [{ id: `generated-${run.id}-ui`, name: 'personne.ui', type: 'application/xml', size: Buffer.byteLength(xml), data: Buffer.from(xml).toString('base64') }] });
    const link = page.getByRole('link', { name: 'personne.ui', exact: true });
    await expect(link).toBeVisible({ timeout: 15000 });
    await expect(page.getByLabel('Statut', { exact: true })).toHaveValue('done');
    const downloading = page.waitForEvent('download'); await link.click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe('personne.ui');
    expect(readFileSync(await download.path(), 'utf8')).toBe(xml);
  });
  test('agent questions and human replies use the card discussion through automatic merge', async ({ page, request, appServer }) => {
    await login(page, appServer);
    const project = seed[0], card = project.cards[0];
    await expect(page.getByRole('button', { name: 'Tâches du projet', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Paramètres du projet', exact: true }).click();
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
    const queue = async () => (await (await request.get(`${appServer}/api/v1/projects/${project.id}/work`, { headers: { Authorization: `Bearer ${token}` } })).json()).data[0];
    let run = await queue(), leaseToken;
    expect(run).toMatchObject({ objective: 'Améliorer le menu mobile', delivery: 'github', repository: 'flo91360/PlaniFiKateur' });
    const base = `${appServer}/api/v1/projects/${project.id}/cards/${card.id}/work`;
    const action = async (name, data = {}) => {
      const response = await request.post(`${base}/${run.id}/${name}`, { headers: { Authorization: `Bearer ${token}` }, data: { version: run.version, leaseToken, ...data } });
      expect(response.status()).toBe(200); run = (await response.json()).data; if (run.leaseToken) leaseToken = run.leaseToken;
    };
    await action('claim'); await action('question', { message: 'Dois-je conserver les raccourcis ?' });
    await page.getByRole('heading', { name: card.title, exact: true }).click();
    const discussion = page.locator('.comments-section');
    await expect(discussion).toContainText('Dois-je conserver les raccourcis ?');
    await expect(discussion).toContainText('Agent principal');
    await expect(discussion.locator('.comment').filter({ hasText: 'Dois-je conserver les raccourcis ?' }).locator('.user-avatar')).toHaveText('IA');
    await expect(page.getByLabel('Statut', { exact: true })).toHaveValue('clarify');
    await page.getByLabel('Votre commentaire', { exact: true }).fill('Oui, conserver tous les raccourcis.');
    await page.getByRole('button', { name: 'Publier', exact: true }).click();
    await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
    await expect(page.getByLabel('Statut', { exact: true })).toHaveValue('ready');
    await expect(discussion.locator('.comment').filter({ hasText: 'Oui, conserver tous les raccourcis.' }).locator('.user-avatar')).toHaveText('A');
    run = await queue(); expect(run.exchanges[0].answer.text).toBe('Oui, conserver tous les raccourcis.');
    await action('claim');
    const pullRequest = { url: 'https://github.com/flo91360/PlaniFiKateur/pull/7', headSha: 'a'.repeat(40) };
    await action('submit', { summary: 'Menu réalisé.', checks: 'Navigation mobile testée.', links: [], pullRequest });
    await expect(discussion).toContainText('Menu réalisé.', { timeout: 10000 });
    await expect(discussion.getByRole('link', { name: pullRequest.url, exact: true })).toBeVisible();
    const event = { action: 'closed', repository: { full_name: 'flo91360/PlaniFiKateur' }, pull_request: { number: 7, merged: true, merged_at: new Date().toISOString(), merge_commit_sha: 'c'.repeat(40), head: { sha: pullRequest.headSha, repo: { full_name: 'flo91360/PlaniFiKateur' } }, base: { ref: 'main' } } };
    const raw = JSON.stringify(event);
    const merged = await request.post(`${appServer}/api/v1/github/webhook`, { headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'pull_request', 'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', 'browser-github-secret').update(raw).digest('hex') }, data: raw });
    expect(merged.status()).toBe(200);
    await expect(page.getByLabel('Statut', { exact: true })).toHaveValue('done', { timeout: 10000 });
    await expect(discussion).toContainText('La PR a été fusionnée. La tâche est terminée.');
    await page.getByRole('button', { name: 'Terminé', exact: true }).click();
    await page.reload(); await page.getByRole('heading', { name: card.title, exact: true }).click();
    await expect(page.getByLabel('Statut', { exact: true })).toHaveValue('done');
    await expect(page.locator('.comment').filter({ hasText: 'Oui, conserver tous les raccourcis.' })).toHaveCount(1);
  });

  test('a ready card is automatically queued and can be withdrawn from its status before claim', async ({ page, request, appServer }) => {
    await login(page, appServer); const project = seed[0], card = project.cards[0];
    expect((await page.request.put(`${appServer}/api/v1/projects/${project.id}/github`, { data: { repository: 'flo91360/PlaniFiKateur' } })).status()).toBe(200);
    const credentials = await page.request.post(`${appServer}/api/v1/agents`, { data: { name: 'Status agent', projectIds: [project.id] } });
    expect(credentials.status()).toBe(201); const token = (await credentials.json()).data.token;
    const queue = async () => (await (await request.get(`${appServer}/api/v1/projects/${project.id}/work`, { headers: { Authorization: `Bearer ${token}` } })).json()).data;
    await page.getByRole('heading', { name: card.title, exact: true }).click();
    await page.getByLabel('Statut', { exact: true }).selectOption('ready');
    await page.getByRole('button', { name: 'Terminé', exact: true }).click();
    await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
    const first = await queue(); expect(first).toHaveLength(1);
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
    const next = await queue(); expect(next).toHaveLength(1); expect(next[0].id).not.toBe(first[0].id);
  });

test('interruption and recovery remain visible without replacing a local title draft', async ({ page, request, appServer }) => {
  await login(page, appServer);
  const project = seed[0], card = project.cards[0];
  await page.request.put(`${appServer}/api/v1/projects/${project.id}/github`, { data: { repository: 'flo91360/PlaniFiKateur' } });
  const credentials = await page.request.post(`${appServer}/api/v1/agents`, { data: { name: 'Recovery agent', projectIds: [project.id] } });
  expect(credentials.status()).toBe(201); const token = (await credentials.json()).data.token;
  const base = `${appServer}/api/v1/projects/${project.id}/cards/${card.id}/work`;
  const prepared = await page.request.post(base, { data: {} });
  expect(prepared.status()).toBe(201); let run = (await prepared.json()).data;
  const action = async (name, data = {}) => {
    const response = await request.post(`${base}/${run.id}/${name}`, { headers: { Authorization: `Bearer ${token}` }, data: { version: run.version, leaseToken: run.leaseToken, ...data } });
    expect(response.status()).toBe(200); run = (await response.json()).data;
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
  await expect(page.locator('.comments-section')).toContainText('Connexion à l’outil interrompue.');
  await expect(page.getByLabel('Statut', { exact: true })).toHaveValue('ready');
  await action('claim');
  await expect(page.getByLabel('Statut', { exact: true })).toHaveValue('progress', { timeout: 10000 });
});

});

test('administrator cancels then confirms account deletion and immediately revokes member access', async ({ page, browser, appServer }) => {
  await login(page, appServer);
  await page.getByRole('button', { name: 'Mon compte', exact: true }).click();
  await page.getByLabel('Nom du membre', { exact: true }).fill('Bob');
  await page.getByLabel('E-mail du membre', { exact: true }).fill('bob@example.test');
  await page.getByRole('button', { name: 'Créer une invitation', exact: true }).click();
  await expect(page.getByLabel('Lien d’invitation')).toHaveValue(/#invitation=[a-f0-9]{64}$/);
  const context = await browser.newContext(); const member = await context.newPage();
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
    await expect(page.locator('.member-list li').getByRole('button', { name: 'Supprimer le compte', exact: true })).toHaveCount(0);
    expect((await context.request.get(`${appServer}/api/v1/workspace`)).status()).toBe(401);
    await member.reload(); await expect(member.getByLabel('Adresse e-mail', { exact: true })).toBeVisible();
  } finally { await context.close(); }
});


test.describe('automatic GitHub delivery', () => {
  test.use({ githubEnabled: true });
  test('a signed tag push updates the project Infos card automatically and survives reload', async ({ page, request, appServer }) => {
    await login(page, appServer);
    const configured = await page.request.put(`${appServer}/api/v1/projects/planifikateur/github`, { data: { repository: 'owner/first' } });
    expect(configured.status()).toBe(200);
    await page.reload();
    const infos = page.locator('.list-column').filter({ has: page.getByRole('heading', { name: 'Infos', exact: true }) });
    const raw = JSON.stringify({ ref: 'refs/tags/v2.0.0', deleted: false, repository: { full_name: 'owner/first', pushed_at: Date.parse('2026-10-12T07:32:00Z') / 1000 } });
    const publish = () => request.post(`${appServer}/api/v1/github/webhook`, { headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'push', 'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', 'browser-github-secret').update(raw).digest('hex') }, data: raw });
    expect((await publish()).status()).toBe(200);
    const version = infos.locator('.card').filter({ has: page.getByRole('heading', { name: 'v2.0.0', exact: true }) });
    await expect(version.locator('h3')).toHaveText('v2.0.0', { timeout: 15000 });
    await expect(version.locator('p')).toContainText('12 octobre 2026 à 09:32');
    expect((await publish()).status()).toBe(200);
    await expect(infos.locator('.card')).toHaveCount(3);
    await page.reload();
    await expect(version.locator('h3')).toHaveText('v2.0.0');
    await expect(infos.getByRole('link', { name: 'Lire le mode d’emploi (README)' })).toHaveAttribute('href', 'https://github.com/owner/first#readme');
    await infos.locator('.card').filter({ hasText: 'Mode d’emploi du projet' }).click();
    await expect(page.getByRole('link', { name: 'Consulter le mode d’emploi (README)' })).toHaveAttribute('href', 'https://github.com/owner/first#readme');
    await page.getByRole('button', { name: 'Terminé', exact: true }).click();
    const downloads = { repository: 'owner/first', version: 'v2.0.0', commit: 'a'.repeat(40), folderId: 'drive-version-folder', files: [{ id: 'drive-executable-id', name: 'Product.exe', size: 100, md5: 'b'.repeat(32) }] };
    const release = JSON.stringify({ action: 'edited', repository: { full_name: 'owner/first' }, release: { draft: false, tag_name: 'v2.0.0', published_at: '2026-10-12T07:32:00Z', body: driveReleaseBody('Nouvelle interface et corrections', downloads) } });
    expect((await request.post(`${appServer}/api/v1/github/webhook`, { headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'release', 'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', 'browser-github-secret').update(release).digest('hex') }, data: release })).status()).toBe(200);
    await page.reload();
    const changelog = infos.locator('.card').filter({ has: page.getByRole('heading', { name: 'Changelog', exact: true }) });
    await expect(changelog.locator('p')).toContainText('Nouvelle interface et corrections');
    await expect(infos.getByRole('link', { name: 'Lire le changelog (CHANGELOG.md)' })).toHaveAttribute('href', 'https://github.com/owner/first/blob/HEAD/CHANGELOG.md');
    await changelog.click();
    await expect(page.getByLabel('Description', { exact: true })).toHaveValue(/Nouvelle interface et corrections/);
    await expect(page.getByRole('link', { name: 'Consulter le changelog (CHANGELOG.md)' })).toHaveAttribute('href', 'https://github.com/owner/first/blob/HEAD/CHANGELOG.md');
    await page.getByRole('button', { name: 'Terminé', exact: true }).click();
    await version.click();
    await expect(page.getByRole('link', { name: 'Télécharger cette version sur Google Drive' })).toHaveAttribute('href', 'https://drive.google.com/drive/folders/drive-version-folder');
    await expect(page.getByRole('link', { name: 'Product.exe', exact: true })).toHaveAttribute('href', 'https://drive.google.com/file/d/drive-executable-id/view');
  });
  test('repositories persist separately for each project and missing configuration blocks preparation', async ({ page, appServer }) => {
    await login(page, appServer);
    const configure = async repository => {
      await page.getByRole('button', { name: 'Paramètres du projet', exact: true }).click();
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
    await page.getByText('Dépôt GitHub et fusion automatique', { exact: true }).click();
    await expect(page.getByLabel('Dépôt du projet', { exact: true })).toHaveValue('');
    await page.getByRole('button', { name: 'Fermer', exact: true }).click();
    await configure('flo91360/Klaviflo');
    await page.reload();
    const projectMenu = page.getByRole('button', { name: 'Ouvrir les projets', exact: true });
    if (await projectMenu.isVisible()) await projectMenu.click();
    await page.getByRole('navigation', { name: 'Projets' }).getByRole('button', { name: /Klaviflo/ }).click();
    await page.getByRole('button', { name: 'Paramètres du projet', exact: true }).click();
    await page.getByText('Dépôt GitHub et fusion automatique', { exact: true }).click();
    await expect(page.getByLabel('Dépôt du projet', { exact: true })).toHaveValue('flo91360/Klaviflo');
    await page.getByRole('button', { name: 'Fermer', exact: true }).click();
    const menu = page.getByRole('button', { name: 'Ouvrir les projets', exact: true });
    if (await menu.isVisible()) await menu.click();
    await page.getByRole('navigation', { name: 'Projets' }).getByRole('button', { name: /PlaniFiKateur/ }).click();
    await page.getByRole('button', { name: 'Paramètres du projet', exact: true }).click();
    await page.getByText('Dépôt GitHub et fusion automatique', { exact: true }).click();
    await expect(page.getByLabel('Dépôt du projet', { exact: true })).toHaveValue('flo91360/PlaniFiKateur');
  });
  test('shows the linked PR and finishes only after a signed merge notification', async ({ page, request, appServer }) => {
    await login(page, appServer); const project = seed[0], card = project.cards[0];
    await page.getByRole('button', { name: 'Paramètres du projet', exact: true }).click();
    const settings = page.getByRole('dialog');
    const discussion = page.locator('.comments-section');
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
    const credentials = await page.request.post(`${appServer}/api/v1/agents`, { data: { name: 'GitHub agent', projectIds: [project.id] } });
    const token = (await credentials.json()).data.token;
    const queue = await request.get(`${appServer}/api/v1/projects/${project.id}/work`, { headers: { Authorization: `Bearer ${token}` } });
    let run = (await queue.json()).data[0]; const base = `${appServer}/api/v1/projects/${project.id}/cards/${card.id}/work/${run.id}`;
    const claimed = await request.post(`${base}/claim`, { headers: { Authorization: `Bearer ${token}` }, data: { version: run.version } });
    run = (await claimed.json()).data; const sha = 'a'.repeat(40);
    const submitted = await request.post(`${base}/submit`, { headers: { Authorization: `Bearer ${token}` }, data: { version: run.version, leaseToken: run.leaseToken, summary: 'Menu corrigé', checks: 'Contrôles GitHub attendus', links: [], pullRequest: { url: 'https://github.com/flo91360/PlaniFiKateur/pull/7', headSha: sha } } });
    expect(submitted.status()).toBe(200);
    await expect(page.getByLabel('Statut', { exact: true })).toHaveValue('review', { timeout: 10000 });
    await expect(page.getByRole('button', { name: 'Valider le résultat', exact: true })).toHaveCount(0);
    await expect(discussion.getByRole('link', { name: 'https://github.com/flo91360/PlaniFiKateur/pull/7', exact: true })).toBeVisible();
    const event = { action: 'closed', repository: { full_name: 'flo91360/PlaniFiKateur' }, pull_request: { number: 7, merged: true, merged_at: new Date().toISOString(), merge_commit_sha: 'b'.repeat(40), head: { sha, repo: { full_name: 'flo91360/PlaniFiKateur' } }, base: { ref: 'main' } } };
    const raw = JSON.stringify(event);
    const response = await request.post(`${appServer}/api/v1/github/webhook`, { headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'pull_request', 'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', 'browser-github-secret').update(raw).digest('hex') }, data: raw });
    expect(response.status()).toBe(200);
    await expect(page.getByLabel('Statut', { exact: true })).toHaveValue('done', { timeout: 10000 });
    await expect(discussion).toContainText('La PR a été fusionnée. La tâche est terminée.');
    await page.getByRole('button', { name: 'Terminé', exact: true }).click();
    await page.getByRole('heading', { name: card.title, exact: true }).click();
    await expect(page.getByLabel('Statut', { exact: true })).toHaveValue('done');
  });
});

test.describe('Google Drive archive', () => {
  const runs = [];
  test.use({ driveArchive: {
    refresh: () => { runs.push(Date.now()); return Promise.resolve(); },
    status: repository => ({ enabled: true, configurationError: '', error: '', lastRun: '2026-10-12T10:00:00Z', running: false, repository: repository || '', checkedAt: '', repositoryError: '', releases: repository ? [
      { tag: 'v0.7.2', state: 'conflict', message: 'Un fichier différent existe déjà dans cette version. Aucun exécutable n’a été remplacé.', date: '2026-10-12T10:00:00Z', files: [] },
      { tag: 'v0.7.1', state: 'archived', message: '', date: '2026-10-11T10:00:00Z', files: [{ name: 'DefilOrdi-Portable-0.7.1.exe', size: 10 }], folderUrl: 'https://drive.google.com/drive/folders/drive-version-folder' },
    ] : [] }),
  } });
  test('project settings show each archived version, its Drive folder and the reason a version was skipped', async ({ page, appServer }) => {
    await login(page, appServer);
    const project = seed[0];
    await page.getByRole('button', { name: 'Paramètres du projet', exact: true }).click();
    await page.getByText('Archivage des .exe sur Google Drive', { exact: true }).click();
    await expect(page.getByText('Associez un dépôt GitHub au projet : ses Releases', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Fermer', exact: true }).click();
    await page.request.put(`${appServer}/api/v1/projects/${project.id}/github`, { data: { repository: 'flo91360/DefilOrdi' } });
    await page.getByRole('button', { name: 'Paramètres du projet', exact: true }).click();
    await page.getByText('Archivage des .exe sur Google Drive', { exact: true }).click();
    await expect(page.getByText('DefilOrdi/<version>/', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Ouvrir le dossier', exact: true })).toHaveAttribute('href', 'https://drive.google.com/drive/folders/drive-version-folder');
    await expect(page.getByText('Non archivée : fichiers différents pour une version existante', { exact: false })).toBeVisible();
    const before = runs.length;
    await page.getByRole('button', { name: 'Vérifier les Releases maintenant', exact: true }).click();
    await expect.poll(() => runs.length).toBeGreaterThan(before);
  });
});

// Reconnaissance vocale simulée : le test dicte les résultats que le navigateur produirait.
const fakeSpeech = () => {
  window.__speechStarts = 0;
  window.SpeechRecognition = window.webkitSpeechRecognition = class {
    start() { window.__speech = this; window.__speechStarts++; this.results = []; }
    stop() { setTimeout(() => this.onend?.(), 0); }
    abort() { setTimeout(() => this.onend?.(), 0); }
    say(transcript, isFinal) { this.results = [...this.results.filter(result => result.isFinal), Object.assign([{ transcript }], { isFinal })]; this.onresult?.({ resultIndex: 0, results: this.results }); }
  };
};

test('dictation is unavailable without browser support and the magic wand explains a missing server key', async ({ page, appServer }) => {
  await page.addInitScript(() => { delete window.SpeechRecognition; delete window.webkitSpeechRecognition; });
  await login(page, appServer);
  await page.getByRole('button', { name: 'Ajouter une carte dans Améliorations', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Reformuler avec l’IA', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Dicter la description', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('La dictée n’est pas prise en charge par ce navigateur. Utilisez Chrome, Edge ou Safari.');
  await page.getByLabel('Titre de la carte', { exact: true }).fill('Export');
  await page.getByLabel('Description', { exact: true }).fill('exporter les cartes');
  await page.getByRole('button', { name: 'Reformuler avec l’IA', exact: true }).click();
  await expect(page.getByText('La reformulation IA n’est pas configurée : ajoutez CLAUDE_CODE_OAUTH_TOKEN (créé avec « claude setup-token ») aux variables du serveur du site.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Description', { exact: true })).toHaveValue('exporter les cartes');
});

test.describe('description assistant', () => {
  const calls = [];
  // Faux SDK Claude Agent : la reformulation dépend des réponses déjà fournies.
  const query = ({ prompt }) => {
    calls.push(prompt);
    const answered = prompt.includes('Réponse : En CSV');
    const result = answered ? { prompt: 'Objectif\nAjouter un export CSV de la liste des cartes.', questions: [] } : { prompt: 'Objectif\nAjouter un export de la liste des cartes.\nÀ préciser : format.', questions: ['Quel format de fichier ?'] };
    return (async function* () {
      yield { type: 'system', subtype: 'init', model: 'claude-opus-5-5' };
      yield { type: 'result', subtype: 'success', is_error: false, structured_output: result };
    })();
  };
  const repositoryContext = { get: async repository => repository === 'owner/planifikateur' ? [{ name: 'README', content: 'Le tableau exporte déjà les projets en JSON.' }, { name: 'CLAUDE.md', content: 'Interface en français.' }] : [] };
  test.use({ refiner: createRefiner({ token: 'browser-subscription-secret', query, directory: join(tmpdir(), 'planifikateur-browser-refine') }), repositoryContext });

  test('a dictated description is saved, then clarified by the magic wand and can be restored', async ({ page, appServer }) => {
    calls.length = 0;
    await page.addInitScript(fakeSpeech);
    await login(page, appServer);
    const project = seed[0], card = project.cards[0];
    const cardUrl = `${appServer}/api/v1/projects/${project.id}/cards/${card.id}`;
    const savedDescription = async () => (await (await page.request.get(cardUrl)).json()).data.description;
    expect((await page.request.put(`${appServer}/api/v1/projects/${project.id}/github`, { data: { repository: 'owner/planifikateur' } })).status()).toBe(200);
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
    await expect(proposal.getByLabel('Demande reformulée', { exact: true })).toHaveValue('Objectif\nAjouter un export de la liste des cartes.\nÀ préciser : format.');
    await expect(description).toHaveValue('Ajouter un export de la liste des cartes');
    await expect(proposal.getByText('Documentation du dépôt utilisée : README, CLAUDE.md', { exact: true })).toBeVisible();
    expect(calls[0]).toContain('<<<README\nLe tableau exporte déjà les projets en JSON.\n>>>');
    expect(calls[0]).toContain(`Titre de la carte : ${card.title}`);
    expect(calls[0]).toContain('Ajouter un export de la liste des cartes');
    await expect(proposal.getByRole('button', { name: 'Reformuler avec mes réponses', exact: true })).toBeDisabled();
    await proposal.getByLabel('Réponse : Quel format de fichier ?', { exact: true }).fill('En CSV');
    await proposal.getByRole('button', { name: 'Reformuler avec mes réponses', exact: true }).click();
    await expect(proposal.getByLabel('Demande reformulée', { exact: true })).toHaveValue('Objectif\nAjouter un export CSV de la liste des cartes.');
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
