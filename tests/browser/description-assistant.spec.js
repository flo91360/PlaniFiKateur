import { expect, seed, tmpdir, join, createRefiner, test, login, fakeSpeech } from './support.js';

test('dictation is unavailable without browser support and the magic wand explains a missing server key', async ({
  page,
  appServer,
}) => {
  await page.addInitScript(() => {
    delete window.SpeechRecognition;
    delete window.webkitSpeechRecognition;
  });
  await login(page, appServer);
  await page.getByRole('button', { name: 'Ajouter une carte dans Améliorations', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Reformuler avec l’IA', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Dicter la description', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'La dictée n’est pas prise en charge par ce navigateur. Utilisez Chrome, Edge ou Safari.',
  );
  await page.getByLabel('Titre de la carte', { exact: true }).fill('Export');
  await page.getByLabel('Description', { exact: true }).fill('exporter les cartes');
  await page.getByRole('button', { name: 'Reformuler avec l’IA', exact: true }).click();
  await expect(
    page.getByText(
      'La reformulation IA n’est pas configurée : ajoutez CLAUDE_CODE_OAUTH_TOKEN (créé avec « claude setup-token ») aux variables du serveur du site.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByLabel('Description', { exact: true })).toHaveValue('exporter les cartes');
});

test.describe('description assistant', () => {
  const calls = [];
  // Faux SDK Claude Agent : la reformulation dépend des réponses déjà fournies.
  const query = ({ prompt }) => {
    calls.push(prompt);
    const answered = prompt.includes('Réponse : En CSV');
    const result = answered
      ? { prompt: 'Objectif\nAjouter un export CSV de la liste des cartes.', questions: [] }
      : {
          prompt: 'Objectif\nAjouter un export de la liste des cartes.\nÀ préciser : format.',
          questions: ['Quel format de fichier ?'],
        };
    return (async function* () {
      yield { type: 'system', subtype: 'init', model: 'claude-opus-5-5' };
      yield { type: 'result', subtype: 'success', is_error: false, structured_output: result };
    })();
  };
  const repositoryContext = {
    get: async repository =>
      repository === 'owner/planifikateur'
        ? [
            { name: 'README', content: 'Le tableau exporte déjà les projets en JSON.' },
            { name: 'CLAUDE.md', content: 'Interface en français.' },
          ]
        : [],
  };
  test.use({
    refiner: createRefiner({
      token: 'browser-subscription-secret',
      query,
      directory: join(tmpdir(), 'planifikateur-browser-refine'),
    }),
    repositoryContext,
  });

  test('a dictated description is saved, then clarified by the magic wand and can be restored', async ({
    page,
    appServer,
  }) => {
    calls.length = 0;
    await page.addInitScript(fakeSpeech);
    await login(page, appServer);
    const project = seed[0],
      card = project.cards[0];
    const cardUrl = `${appServer}/api/v1/projects/${project.id}/cards/${card.id}`;
    const savedDescription = async () => (await (await page.request.get(cardUrl)).json()).data.description;
    expect(
      (
        await page.request.put(`${appServer}/api/v1/projects/${project.id}/github`, {
          data: { repository: 'owner/planifikateur' },
        })
      ).status(),
    ).toBe(200);
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
    await expect(proposal.getByLabel('Demande reformulée', { exact: true })).toHaveValue(
      'Objectif\nAjouter un export de la liste des cartes.\nÀ préciser : format.',
    );
    await expect(description).toHaveValue('Ajouter un export de la liste des cartes');
    await expect(
      proposal.getByText('Documentation du dépôt utilisée : README, CLAUDE.md', { exact: true }),
    ).toBeVisible();
    expect(calls[0]).toContain('<<<README\nLe tableau exporte déjà les projets en JSON.\n>>>');
    expect(calls[0]).toContain(`Titre de la carte : ${card.title}`);
    expect(calls[0]).toContain('Ajouter un export de la liste des cartes');
    await expect(proposal.getByRole('button', { name: 'Reformuler avec mes réponses', exact: true })).toBeDisabled();
    await proposal.getByLabel('Réponse : Quel format de fichier ?', { exact: true }).fill('En CSV');
    await proposal.getByRole('button', { name: 'Reformuler avec mes réponses', exact: true }).click();
    await expect(proposal.getByLabel('Demande reformulée', { exact: true })).toHaveValue(
      'Objectif\nAjouter un export CSV de la liste des cartes.',
    );
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
