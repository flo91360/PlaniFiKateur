import { test as base, expect } from '@playwright/test';
import { createAppServer } from '../../server/index.js';
import { createStore } from '../../server/store.js';
import { seed } from '../../src/data/demo.js';

const ownerToken = 'owner-browser-test-key';
const readToken = 'agent-browser-test-key';
const test = base.extend({
  appServer: async ({}, use) => {
    const store = createStore(':memory:');
    const server = createAppServer({ store, config: { ownerToken, readToken } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await use(`http://127.0.0.1:${server.address().port}`);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close();
  },
});
const login = async (page, url) => {
  await page.goto(url);
  await page.getByLabel('Clé d’accès propriétaire').fill(ownerToken);
  await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'PlaniFiKateur', exact: true })).toBeVisible();
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
  await page.getByLabel('Clé d’accès propriétaire').fill('wrong');
  await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Clé d’accès incorrecte.');
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
