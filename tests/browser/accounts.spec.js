import { expect, seed, testEmail, testPassword, ownerToken, test, login, newProject, accentColor } from './support.js';

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
  await expect(
    member.getByRole('button', { name: 'Créer et télécharger une sauvegarde SQLite', exact: true }),
  ).toHaveCount(0);
  const memberRow = page.locator('.member-list li').filter({ hasText: 'bob@example.test' });
  await memberRow.getByRole('button', { name: 'Désactiver', exact: true }).click();
  await expect(memberRow).toContainText('Désactivé');
  expect((await context.request.get(`${appServer}/api/v1/workspace`)).status()).toBe(401);
  await context.close();
});

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

test('the dark theme follows the system, then the choice remembered on this device', async ({ page, appServer }) => {
  const pageColor = () =>
    page.locator('body').evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
  await page.emulateMedia({ colorScheme: 'dark' });
  await login(page, appServer);
  await expect.poll(pageColor).toBe('rgb(17, 24, 22)');
  await page.getByRole('button', { name: 'Passer au thème clair', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'clair');
  await expect.poll(pageColor).toBe('rgb(247, 250, 249)');

  await page.reload();
  await expect(page.getByRole('button', { name: 'Passer au thème sombre', exact: true })).toBeVisible();
  await expect.poll(pageColor).toBe('rgb(247, 250, 249)');

  await page.getByRole('button', { name: 'Mon compte', exact: true }).click();
  const themes = page.getByRole('group', { name: 'Thème', exact: true });
  await themes.getByRole('button', { name: 'Sombre', exact: true }).click();
  await expect(themes.getByRole('button', { name: 'Sombre', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(pageColor).toBe('rgb(17, 24, 22)');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(pageColor).toBe('rgb(17, 24, 22)');
  await themes.getByRole('button', { name: 'Comme le système', exact: true }).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme');
  await expect.poll(pageColor).toBe('rgb(247, 250, 249)');
  expect(await page.evaluate(() => localStorage.getItem('planifikateur.theme'))).toBeNull();
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
