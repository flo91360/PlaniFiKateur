import { createHmac, expect, seed, readFileSync, test, login, newProject } from './support.js';

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
    await expect(executionPanel.getByRole('button', { name: 'Relancer l’agent', exact: true })).toHaveCount(0);
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

  test('a PR that changes its own checks waits for a manager even without project approval', async ({
    page,
    request,
    appServer,
  }) => {
    await login(page, appServer);
    const project = seed[0],
      card = project.cards[0];
    const headers = await agentFor(page, appServer, project, 'Agent contrôlé');
    const base = `${appServer}/api/v1/projects/${project.id}/cards/${card.id}/work`;
    let run = (await (await page.request.post(base, { data: {} })).json()).data;
    run = (await (await request.post(`${base}/${run.id}/claim`, { headers, data: { version: run.version } })).json())
      .data;
    const submitted = await request.post(`${base}/${run.id}/submit`, {
      headers,
      data: {
        version: run.version,
        leaseToken: run.leaseToken,
        summary: 'Tests réorganisés.',
        checks: 'Tests lancés.',
        links: [],
        pullRequest: { url: 'https://github.com/flo91360/PlaniFiKateur/pull/11', headSha: 'c'.repeat(40) },
        reviewRequired: ['.github/workflows/ci.yml', 'package.json (scripts)'],
      },
    });
    expect(submitted.status()).toBe(200);
    await page.getByRole('heading', { name: card.title, exact: true }).click();
    const panel = page.getByRole('region', { name: 'Exécution IA', exact: true });
    await expect(panel).toContainText('elle attend l’approbation d’un responsable avant la fusion');
    await expect(panel.getByRole('list', { name: 'Contrôles modifiés', exact: true })).toHaveText(
      '.github/workflows/ci.ymlpackage.json (scripts)',
    );
    await panel.getByRole('button', { name: 'Approuver la fusion', exact: true }).click();
    await expect(panel).toContainText('PR approuvée par Alice : fusion après les tests GitHub.');
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
