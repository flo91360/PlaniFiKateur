// Serveur de test, connexion et aides partagés par les tests navigateur (un fichier par domaine).
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

export const ownerToken = 'owner-browser-test-key';
export const readToken = 'agent-browser-test-key';
export const test = base.extend({
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
export const login = async (page, url) => {
  await page.goto(url);
  await page.getByLabel('Adresse e-mail', { exact: true }).fill(testEmail);
  await page.getByLabel('Mot de passe', { exact: true }).fill(testPassword);
  await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
  await expect(page.locator('.project-heading h1')).toHaveText('PlaniFiKateur');
};
// Sans flux d’événements, l’interface revient à l’actualisation périodique (filet de sécurité).
export const blockServerEvents = page => page.route('**/api/v1/events', route => route.abort());
export const newProject = async (page, name) => {
  const menu = page.getByRole('button', { name: 'Ouvrir les projets', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('button', { name: 'Nouveau projet', exact: true }).click();
  await page.getByLabel('Nom du projet', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'Créer le projet', exact: true }).click();
};
// Les sauvegardes serveur sont dans « Mon compte », avec la gestion des membres (administrateur).
export const openAccount = async page => {
  await page.getByRole('button', { name: 'Mon compte', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Mon compte', exact: true })).toBeVisible();
};
export const accentColor = page =>
  page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--primary').trim());
// Reconnaissance vocale simulée : le test dicte les résultats que le navigateur produirait.
export const fakeSpeech = () => {
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

export {
  createHmac,
  driveReleaseBody,
  expect,
  createAppServer,
  createStore,
  seed,
  isSystemCard,
  createBackups,
  mkdtempSync,
  rmSync,
  readFileSync,
  tmpdir,
  join,
  seedAccount,
  testEmail,
  testPassword,
  createRefiner,
  readWorkspace,
};
