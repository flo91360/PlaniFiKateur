import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const html = readFileSync(new URL(`../../dist/PlaniFiKateur-apercu-v${version}.html`, import.meta.url), 'utf8');

async function openNewProject(page) {
  await page.route('http://planifikateur.test/**', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('http://planifikateur.test/app');
  const menu = page.getByRole('button', { name: 'Ouvrir les projets', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('button', { name: 'Nouveau projet', exact: true }).click();
  await page.getByLabel('Nom du projet', { exact: true }).fill('Défilement');
  await page.getByRole('button', { name: 'Créer le projet', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test('la barre de défilement horizontale du tableau reste visible', { tag: '@mobile' }, async ({ page }) => {
  await openNewProject(page);

  const board = page.locator('.board');
  const bar = page.locator('.board-scrollbar');
  await expect(bar).toBeVisible();
  // En haut de la page, le bas du tableau est hors de l’écran mais la barre reste dans la fenêtre.
  await page.evaluate(() => window.scrollTo(0, 0));
  const viewport = page.viewportSize();
  expect(await board.evaluate(el => el.getBoundingClientRect().bottom)).toBeGreaterThan(viewport.height);
  const box = await bar.boundingBox();
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
  expect(box.y).toBeGreaterThanOrEqual(0);

  // Les deux barres défilent ensemble (sur mobile, le tableau s’aligne ensuite sur une liste).
  const positions = () => Promise.all([board, bar].map(el => el.evaluate(node => Math.round(node.scrollLeft))));
  // Position stabilisée : sur mobile, le calage sur une liste (scroll-snap) poursuit le défilement
  // après l’affectation ; une nouvelle affectation pendant ce calage serait annulée par lui.
  const settled = async () => {
    const before = await positions();
    await page.waitForTimeout(250);
    const after = await positions();
    return JSON.stringify(before) === JSON.stringify(after) && after[0] === after[1] ? after[0] : null;
  };
  await bar.evaluate(el => (el.scrollLeft = 200));
  await expect.poll(settled, { timeout: 10000 }).toBeGreaterThan(0);
  await board.evaluate(el => (el.scrollLeft = 0));
  await expect.poll(settled, { timeout: 10000 }).toBe(0);
});

test(
  'la barre recopiée ne ramène pas le tableau en arrière pendant un défilement',
  { tag: '@mobile' },
  async ({ page }) => {
    await openNewProject(page);
    await expect(page.locator('.board-scrollbar')).toBeVisible();
    const position = await page.locator('.board').evaluate(
      board =>
        new Promise(resolve => {
          board.style.scrollSnapType = 'none';
          // Sur téléphone, l’élan du doigt continue de déplacer le tableau avant que la barre recopiée
          // signale à son tour son défilement : cet écho, en retard, ne doit pas faire reculer le tableau.
          board.addEventListener('scroll', () => (board.scrollLeft = 200), { once: true });
          board.scrollLeft = 100;
          setTimeout(() => resolve(Math.round(board.scrollLeft)), 500);
        }),
    );
    expect(position).toBe(200);
    await expect.poll(() => page.locator('.board-scrollbar').evaluate(bar => Math.round(bar.scrollLeft))).toBe(200);
  },
);
