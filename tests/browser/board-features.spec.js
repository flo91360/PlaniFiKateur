import { expect, seed, isSystemCard, test, login } from './support.js';

test.describe('reliable and accessible interface', () => {
  test('closing a form with unsaved input asks before discarding it', async ({ page, appServer }) => {
    await login(page, appServer);
    await page.getByRole('button', { name: 'Ajouter une carte dans Bugs', exact: true }).click();
    const form = page.getByRole('dialog', { name: 'Une nouvelle idée' });
    // Sans saisie, Échap ferme directement.
    await page.keyboard.press('Escape');
    await expect(form).toHaveCount(0);
    await page.getByRole('button', { name: 'Ajouter une carte dans Bugs', exact: true }).click();
    await page.getByLabel('Titre de la carte', { exact: true }).fill('Idée à ne pas perdre');
    await page.keyboard.press('Escape');
    await expect(form.getByRole('alert')).toContainText('Votre saisie n’est pas enregistrée');
    await expect(form.getByRole('button', { name: 'Continuer la saisie', exact: true })).toBeFocused();
    await form.getByRole('button', { name: 'Continuer la saisie', exact: true }).click();
    await expect(page.getByLabel('Titre de la carte', { exact: true })).toHaveValue('Idée à ne pas perdre');
    await form.getByRole('button', { name: 'Fermer', exact: true }).click();
    await form.getByRole('button', { name: 'Abandonner la saisie', exact: true }).click();
    await expect(form).toHaveCount(0);
  });

  test('an unreadable execution history is reported with a retry instead of locking the card', async ({
    page,
    appServer,
  }) => {
    await login(page, appServer);
    const card = seed[0].cards.find(item => !isSystemCard(seed[0].id, item.id));
    await page.route('**/api/v1/projects/*/cards/*/work', route =>
      route.fulfill({ status: 500, json: { error: { code: 'server_error', message: 'Erreur interne.' } } }),
    );
    await page.getByRole('heading', { name: card.title, exact: true }).click();
    const panel = page.getByRole('region', { name: 'Exécution IA', exact: true });
    await expect(panel.getByRole('alert')).toContainText('Exécutions IA de cette carte indisponibles');
    await expect(panel.getByRole('button', { name: 'Confier à l’agent', exact: true })).toHaveCount(0);
    await page.unroute('**/api/v1/projects/*/cards/*/work');
    await panel.getByRole('button', { name: 'Réessayer', exact: true }).click();
    await expect(panel.getByRole('alert')).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Confier à l’agent', exact: true })).toBeVisible();
  });

  test('an open card shows the comments of another session without being closed', async ({
    page,
    browser,
    appServer,
  }) => {
    await login(page, appServer);
    const card = seed[0].cards.find(item => !isSystemCard(seed[0].id, item.id));
    const context = await browser.newContext();
    const other = await context.newPage();
    await login(other, appServer);
    await page.getByRole('heading', { name: card.title, exact: true }).click();
    await other.getByRole('heading', { name: card.title, exact: true }).click();
    await other.getByLabel('Votre commentaire', { exact: true }).fill('Ajouté depuis un autre navigateur');
    await other.getByRole('button', { name: 'Publier', exact: true }).click();
    await expect(other.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
    await expect(page.getByRole('dialog', { name: 'Détail de la carte' })).toContainText(
      'Ajouté depuis un autre navigateur',
    );
    await context.close();
  });

  test('board cards are articles opened by their title button', async ({ page, appServer }) => {
    await login(page, appServer);
    const card = seed[0].cards.find(item => !isSystemCard(seed[0].id, item.id));
    const preview = page.getByRole('article').filter({ has: page.getByRole('heading', { name: card.title }) });
    await expect(preview).toHaveCount(1);
    await preview.getByRole('button', { name: card.title, exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Détail de la carte' })).toBeVisible();
  });

  test('the closed mobile menu is inert and Escape closes it', async ({ page, appServer }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, appServer);
    const menu = page.locator('aside.sidebar');
    await expect(menu).toHaveAttribute('inert', '');
    await page.getByRole('button', { name: 'Ouvrir les projets', exact: true }).click();
    await expect(menu).not.toHaveAttribute('inert', '');
    await expect(menu.locator('a, button').first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveAttribute('inert', '');
  });
});

test.describe('board features', () => {
  test('a dragged card is dropped where it is released in the target list', async ({ page, appServer }) => {
    await login(page, appServer);
    const project = seed[0];
    const [first, second] = project.cards.filter(
      card => card.listId === project.lists[0].id && !isSystemCard(project.id, card.id),
    );
    const moved = project.cards.find(card => card.listId !== project.lists[0].id && !isSystemCard(project.id, card.id));
    const preview = card =>
      page.getByRole('article').filter({ has: page.getByRole('heading', { name: card.title, exact: true }) });
    // Relâchée sur la moitié haute de la deuxième carte : elle s’insère juste avant elle.
    await preview(moved).dragTo(preview(second), { targetPosition: { x: 20, y: 4 } });
    await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
    const titles = await page
      .locator('.list-column')
      .first()
      .getByRole('article')
      .getByRole('heading')
      .allTextContents();
    expect(titles.indexOf(moved.title)).toBe(titles.indexOf(second.title) - 1);
    expect(titles.indexOf(first.title)).toBeLessThan(titles.indexOf(moved.title));
  });

  test('checklist items are added, checked, renamed and removed from the card', async ({ page, appServer }) => {
    await login(page, appServer);
    const card = seed[0].cards.find(item => !isSystemCard(seed[0].id, item.id));
    await page.getByRole('heading', { name: card.title, exact: true }).click();
    const checklist = page.getByRole('region', { name: 'Liste de contrôle' });
    for (const text of ['Écrire le test', 'Relire le texte']) {
      await checklist.getByLabel('Nouveau critère', { exact: true }).fill(text);
      await checklist.getByRole('button', { name: 'Ajouter', exact: true }).click();
    }
    const done = card.checklist.filter(item => item.done).length,
      total = card.checklist.length;
    await checklist.getByRole('checkbox', { name: 'Écrire le test' }).check();
    await expect(checklist.locator('h3')).toContainText(`${done + 1}/${total + 2}`);
    const rename = checklist.getByLabel('Texte du critère « Relire le texte »');
    await rename.fill('Relire tout le texte');
    await rename.blur();
    await expect(checklist.getByRole('checkbox', { name: 'Relire tout le texte' })).toBeVisible();
    await checklist.getByRole('button', { name: 'Retirer « Écrire le test »' }).click();
    await expect(checklist.getByRole('checkbox')).toHaveCount(total + 1);
    await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
    await page.getByRole('button', { name: 'Terminé', exact: true }).click();
    await expect(
      page.getByRole('article').filter({ has: page.getByRole('heading', { name: card.title, exact: true }) }),
    ).toContainText(`${done}/${total + 1}`);
    await page.reload();
    await page.getByRole('heading', { name: card.title, exact: true }).click();
    await expect(
      page.getByRole('region', { name: 'Liste de contrôle' }).getByRole('checkbox', { name: 'Relire tout le texte' }),
    ).not.toBeChecked();
  });

  test('a card gets a due date and an assignee, then is archived and restored', async ({ page, appServer }) => {
    await login(page, appServer);
    const card = seed[0].cards.find(item => !isSystemCard(seed[0].id, item.id));
    const preview = () =>
      page.getByRole('article').filter({ has: page.getByRole('heading', { name: card.title, exact: true }) });
    await page.getByRole('heading', { name: card.title, exact: true }).click();
    await page.getByLabel('Échéance', { exact: true }).fill('2020-01-15');
    await page.getByLabel('Responsable', { exact: true }).selectOption({ label: 'Alice (vous)' });
    await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
    await page.getByRole('button', { name: 'Terminé', exact: true }).click();
    // Échéance passée sur une carte non livrée : signalée en retard.
    await expect(preview().locator('.card-due.late')).toHaveText('15 janv.');
    await expect(preview().locator('.card-assignee')).toHaveAttribute('title', 'Responsable : Alice');
    await page.getByRole('heading', { name: card.title, exact: true }).click();
    await page.getByRole('button', { name: 'Archiver la carte', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Détail de la carte' })).toHaveCount(0);
    await expect(preview()).toHaveCount(0);
    await page.getByRole('button', { name: 'Archivées (1)', exact: true }).click();
    await expect(preview()).toHaveCount(1);
    await page.getByRole('heading', { name: card.title, exact: true }).click();
    await expect(page.locator('.archived-badge')).toHaveText('Archivée');
    await page.getByRole('button', { name: 'Restaurer la carte', exact: true }).click();
    await page.getByRole('button', { name: 'Terminé', exact: true }).click();
    await page.getByRole('button', { name: 'Revenir au tableau', exact: true }).click();
    await expect(preview()).toHaveCount(1);
    await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
  });
});
