import { expect, seed, test, login } from './support.js';

// Retours simulés : la réception par le logiciel et le stockage sont couverts par tests/bug-reports.test.js.
const reports = () => [
  {
    id: 'bug-1',
    kind: 'bug',
    crash: true,
    licenseName: 'Cabinet Dupont',
    version: '0.8.66',
    screen: 'Dactylo',
    system: 'Windows 10.0.22631',
    description: 'Le jeu se fige après la troisième phrase.\nIl faut relancer le logiciel.',
    journal: 'TypeError: x is undefined',
    hasScreenshot: true,
    handled: false,
    reportedAt: '2026-11-27T10:00:00.000Z',
  },
  {
    id: 'bug-2',
    kind: 'idea',
    crash: false,
    licenseName: 'Cabinet Martin',
    version: '0.8.65',
    description: 'Ajouter un mode nuit.',
    hasScreenshot: false,
    handled: false,
    reportedAt: '2026-11-26T10:00:00.000Z',
  },
  {
    id: 'bug-3',
    kind: 'opinion',
    crash: false,
    licenseName: 'Cabinet Martin',
    description: 'Très pratique au quotidien.',
    hasScreenshot: false,
    handled: true,
    reportedAt: '2026-11-25T10:00:00.000Z',
  },
];

test('the software feedback opens in its own page, listed then read one by one @mobile', async ({
  page,
  appServer,
}) => {
  const project = seed[0];
  const items = reports();
  await page.route(`**/api/v1/projects/${project.id}/bug-reports**`, async route => {
    const url = new URL(route.request().url());
    const [, id, screenshot] = /bug-reports(?:\/([^/]+))?(\/screenshot)?$/.exec(url.pathname);
    if (screenshot) return route.fulfill({ json: { data: { screenshot: 'data:image/png;base64,iVBORw0KGgo=' } } });
    if (route.request().method() === 'PATCH') {
      const item = items.find(report => report.id === id);
      item.handled = route.request().postDataJSON().handled;
      return route.fulfill({ json: { data: item } });
    }
    return route.fulfill({ json: { data: items } });
  });
  await login(page, appServer);

  // Le bouton du tableau indique les retours à traiter ; les paramètres n’ont plus d’onglet dédié.
  const open = page.getByRole('button', { name: 'Retours du logiciel (2 à traiter)', exact: true });
  await expect(open).toBeVisible();
  await open.click();
  await expect(page).toHaveURL(new RegExp(`#/projets/${project.id}/retours$`));
  await expect(page.getByRole('heading', { name: 'Retours du logiciel', level: 1 })).toBeVisible();
  const list = page.getByRole('list', { name: 'Retours du logiciel' }),
    states = page.getByRole('group', { name: 'État des retours' });
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await expect(list.getByRole('listitem').first()).toContainText('Plantage');
  await expect(list.getByRole('listitem').first()).toContainText('Le jeu se fige après la troisième phrase.');

  // Filtres : tous les retours, puis par type et par texte.
  await states.getByRole('button', { name: /^Tous/ }).click();
  await expect(list.getByRole('listitem')).toHaveCount(3);
  await page.getByLabel('Type de retour').selectOption('idea');
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await page.getByLabel('Type de retour').selectOption('all');
  await page.getByLabel('Chercher dans les retours').fill('martin');
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await page.getByLabel('Chercher dans les retours').fill('');
  await states.getByRole('button', { name: /^À traiter/ }).click();

  // Détail : texte entier, capture chargée d’emblée, journal, puis retour suivant.
  await list.getByRole('button', { name: /Le jeu se fige/ }).click();
  await expect(page).toHaveURL(/\/retours\/bug-1$/);
  const detail = page.getByRole('article', { name: 'Détail du retour' });
  await expect(detail).toContainText('Il faut relancer le logiciel.');
  await expect(detail).toContainText('Cabinet Dupont');
  await expect(detail.getByRole('img', { name: 'Capture d’écran jointe' })).toBeVisible();
  // Ouverte en grand depuis une copie locale : un onglet refuse d’afficher une URL data:.
  await expect(detail.getByRole('link', { name: 'Capture d’écran jointe' })).toHaveAttribute('href', /^blob:/);
  await expect(detail.locator('.bug-page-journal')).toContainText('TypeError: x is undefined');
  await detail.getByRole('button', { name: 'Marquer comme traité', exact: true }).click();
  await expect(detail.getByRole('button', { name: 'Rouvrir', exact: true })).toBeVisible();
  await detail.getByRole('button', { name: 'Retour suivant', exact: true }).click();
  await expect(page).toHaveURL(/\/retours\/bug-2$/);
  await expect(detail).toContainText('Ajouter un mode nuit.');

  // L’adresse se recharge, « Précédent » revient en arrière, puis le tableau réapparaît.
  await page.reload();
  await expect(page.getByRole('article', { name: 'Détail du retour' })).toContainText('Ajouter un mode nuit.');
  await page.goBack();
  await expect(page).toHaveURL(/\/retours\/bug-1$/);
  await page.getByRole('button', { name: 'Tous les retours', exact: true }).click();
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await page.getByRole('button', { name: 'Retour au tableau', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/projets/${project.id}$`));
  await expect(page.getByRole('button', { name: 'Retours du logiciel (1 à traiter)', exact: true })).toBeVisible();
});
