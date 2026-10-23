import { createHmac, driveReleaseBody, expect, seed, test, login, newProject } from './support.js';

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
    await expect(infos.getByRole('link', { name: 'Télécharger sur Google Drive' })).toHaveAttribute(
      'href',
      'https://drive.google.com/drive/folders/drive-version-folder',
    );
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
