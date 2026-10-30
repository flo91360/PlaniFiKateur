import {
  expect,
  seed,
  isSystemCard,
  readFileSync,
  testEmail,
  readWorkspace,
  readToken,
  test,
  login,
  blockServerEvents,
  newProject,
  openAccount,
} from './support.js';

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
  const drafts = seed[0].cards.filter(item => !isSystemCard(seed[0].id, item.id) && item.status === 'draft').length;
  await expect(page.locator('.stats')).toContainText(`${drafts}à explorer`);
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

test('a list is dragged before another and its place is saved', async ({ page, appServer }) => {
  await login(page, appServer);
  const [first, second] = seed[0].lists;
  const columns = page.locator('.list-column');
  await expect(columns.nth(1).locator('.list-header h2')).toHaveText(second.name);
  // Glisser l’en-tête de la deuxième liste sur la moitié gauche de la première.
  const target = columns.nth(0);
  const box = await target.boundingBox();
  await columns
    .nth(1)
    .locator('.list-header')
    .dragTo(target, { targetPosition: { x: 20, y: box.height / 2 } });
  await expect(page.locator('.list-header h2').first()).toHaveText(second.name);
  await expect(columns.nth(1).locator('.list-header h2')).toHaveText(first.name);
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé sur le serveur');
  const board = await (await page.request.get(`${appServer}/api/v1/workspace`)).json();
  const names = board.projects.find(item => item.id === seed[0].id).lists.map(list => list.name);
  expect(names.slice(0, 2)).toEqual([second.name, first.name]);
  await page.reload();
  await expect(page.locator('.list-header h2').first()).toHaveText(second.name);
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

test('an open card keeps refreshing and preserves a draft during a concurrent change', async ({
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
  // Le tableau reste actualisé derrière la carte ouverte, sans toucher au champ en cours de saisie.
  await expect(
    page.getByRole('navigation', { name: 'Projets' }).getByRole('button', { name: /Changement pendant la saisie/ }),
  ).toHaveCount(1);
  await expect(page.getByLabel('Description', { exact: true })).toHaveValue('Mon texte en cours de rédaction');
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
  await openAccount(page);
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
