import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createStore } from '../server/store.js';
import { createAppServer } from '../server/index.js';
import { seedAccount, testEmail, testPassword } from './helpers/accounts.mjs';
import * as accents from '../src/lib/accents.js';

const { ACCENTS, DEFAULT_ACCENT } = accents;
const spec = JSON.parse(readFileSync(new URL('../public/openapi.json', import.meta.url), 'utf8'));

test('the default accent keeps the current colour of the site', () => {
  assert.equal(DEFAULT_ACCENT, 'foret');
  assert.equal(accents.accentById(DEFAULT_ACCENT).primary, '#28734b');
  assert.equal(accents.accentById('inconnue').id, DEFAULT_ACCENT);
  assert.equal(accents.isAccent('ocean'), true);
  assert.equal(accents.isAccent('#123456'), false);
  const ids = ACCENTS.map(accent => accent.id);
  assert.deepEqual(spec.components.schemas.Accent.enum, ids);
});

function readable(foreground, background, label, minimum = 4.5) {
  const ratio = accents.contrastRatio(foreground, background);
  assert.ok(ratio >= minimum, `${label} : contraste ${ratio.toFixed(2)} insuffisant`);
}

test('every accent of the palette keeps text and controls readable', () => {
  assert.ok(ACCENTS.length >= 5);
  assert.equal(new Set(ACCENTS.map(accent => accent.id)).size, ACCENTS.length);
  for (const accent of ACCENTS) {
    const name = accent.id;
    for (const key of Object.keys(accents.ACCENT_VARIABLES)) {
      assert.match(accent[key], /^#[0-9a-f]{6}$/);
    }
    readable('#ffffff', accent.primary, `${name} : bouton principal`);
    readable('#ffffff', accent.hover, `${name} : bouton principal survolé`);
    readable(accent.hover, accent.soft, `${name} : avatar de l’en-tête`);
    readable(accent.primary, '#f7faf9', `${name} : contour de focus`, 3);
    for (const background of ['#ffffff', '#f7faf9', '#fafdfc', accent.soft]) {
      readable(accent.primary, background, `${name} : lien ou état actif sur ${background}`);
    }
    const navigation = [accent.sidebar, accent.sidebarRaised, accent.sidebarHover, accent.sidebarActive];
    for (const background of navigation) {
      readable(accent.sidebarText, background, `${name} : navigation sur ${background}`);
    }
    for (const background of [accent.sidebar, accent.sidebarHover, accent.sidebarActive]) {
      readable(accent.sidebarSoft, background, `${name} : texte secondaire sur ${background}`);
    }
    readable(accent.sidebarMuted, accent.sidebar, `${name} : titres de la navigation`);
    readable(accent.sidebar, accent.sidebarAccent, `${name} : pastille de l’espace`);
  }
});

async function fixture(t) {
  const store = createStore(':memory:');
  seedAccount(store);
  const server = createAppServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  function request(path, { method = 'GET', data, cookie } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (cookie) headers.Cookie = cookie;
    const body = method === 'GET' ? undefined : JSON.stringify(data ?? {});
    return fetch(base + path, { method, headers, body });
  }
  const cookieOf = response => response.headers.get('set-cookie').split(';')[0];
  async function login() {
    const data = { email: testEmail, password: testPassword };
    const response = await request('/session', { method: 'POST', data });
    assert.equal(response.status, 200);
    return cookieOf(response);
  }
  function choose(cookie, accent) {
    return request('/accounts/preferences', { method: 'PUT', cookie, data: { accent } });
  }
  async function accentOf(cookie) {
    const response = await request('/accounts/preferences', { cookie });
    assert.equal(response.status, 200);
    return (await response.json()).data.accent;
  }
  async function json(response) {
    return (await response).json();
  }
  return { store, request, cookieOf, login, choose, accentOf, json };
}

test('the accent is stored with the account, follows it on every session and stays private', async t => {
  const f = await fixture(t);
  const admin = await f.login();
  const invitation = { name: 'Bob', email: 'bob@example.test' };
  const invited = await f.json(f.request('/users', { method: 'POST', cookie: admin, data: invitation }));
  const activation = { token: invited.data.token, name: 'Bob', password: 'bob-personal-password-123' };
  const accepted = await f.request('/accounts/accept', { method: 'POST', data: activation });
  assert.equal(accepted.status, 200);
  const member = f.cookieOf(accepted);

  assert.equal((await f.request('/accounts/preferences')).status, 401);
  assert.equal(await f.accentOf(admin), DEFAULT_ACCENT);
  for (const accent of ['#ff0000', 'inconnue', 42, undefined]) {
    const response = await f.choose(admin, accent);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'invalid_preferences');
  }

  const saved = await f.choose(admin, 'prune');
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json()).data, { accent: 'prune' });

  // Une nouvelle session (autre appareil ou navigateur) retrouve la couleur du compte.
  const elsewhere = await f.login();
  const session = await f.json(f.request('/session', { cookie: elsewhere }));
  assert.deepEqual(session.preferences, { accent: 'prune' });
  assert.equal(session.user.accent, undefined);

  // L’autre compte garde la couleur par défaut, puis la sienne, sans voir celle de l’administrateur.
  const memberSession = await f.json(f.request('/session', { cookie: member }));
  assert.deepEqual(memberSession.preferences, { accent: DEFAULT_ACCENT });
  assert.equal((await f.choose(member, 'ocean')).status, 200);
  assert.equal(await f.accentOf(member), 'ocean');
  assert.equal(await f.accentOf(admin), 'prune');
  const users = await f.json(f.request('/users', { cookie: admin }));
  assert.ok(!JSON.stringify(users).includes('ocean'));
  const anonymous = await f.json(f.request('/session'));
  assert.equal(anonymous.preferences, undefined);

  // Rétablir la couleur par défaut, avec null ou l’identifiant par défaut.
  const cleared = await f.json(f.choose(admin, null));
  assert.deepEqual(cleared.data, { accent: DEFAULT_ACCENT });
  assert.equal((await f.choose(admin, 'cuivre')).status, 200);
  const restored = await f.json(f.choose(admin, DEFAULT_ACCENT));
  assert.deepEqual(restored.data, { accent: DEFAULT_ACCENT });
  assert.equal(await f.accentOf(member), 'ocean');

  // La suppression du compte efface aussi ses préférences.
  const bobId = f.store.userByEmail('bob@example.test').id;
  const deleted = await f.request(`/users/${bobId}`, { method: 'DELETE', cookie: admin });
  assert.equal(deleted.status, 200);
  assert.deepEqual(f.store.preferences(bobId), { accent: DEFAULT_ACCENT });
});

test('secondary texts stay readable on the light and dark surfaces and no text is smaller than 10 px', () => {
  const styles = new URL('../src/styles/', import.meta.url);
  const base = readFileSync(new URL('base.css', styles), 'utf8');
  // Chaque couleur commune donne sa valeur claire puis sombre : light-dark(#clair, #sombre).
  const variable = name => {
    const [, light, dark] = new RegExp(`--${name}: light-dark\\((#[0-9a-f]{3,6}), (#[0-9a-f]{6})\\)`).exec(base);
    return { light: light === '#fff' ? '#ffffff' : light, dark };
  };
  for (const name of ['muted', 'text-muted', 'text-faint', 'text-soft', 'text']) {
    for (const background of ['#ffffff', variable('page').light])
      readable(variable(name).light, background, `--${name} sur ${background}`);
    for (const background of ['surface', 'page', 'surface-tint', 'surface-hover'].map(key => variable(key).dark))
      readable(variable(name).dark, background, `--${name} sombre sur ${background}`);
  }
  // En thème sombre, les liens et états actifs prennent la teinte claire de la navigation.
  for (const accent of ACCENTS)
    for (const background of ['surface', 'page', 'surface-hover'].map(key => variable(key).dark))
      readable(accent.sidebarAccent, background, `${accent.id} : lien sombre sur ${background}`);
  for (const file of readdirSync(styles))
    for (const [, size] of readFileSync(new URL(file, styles), 'utf8').matchAll(/font-size: ([\d.]+)px/g))
      assert.ok(Number(size) >= 10, `${file} : police de ${size} px`);
});
