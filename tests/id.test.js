import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createId } from '../src/lib/id.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('creates a UUID with the native browser API', () => {
  assert.match(createId(webcrypto), uuid);
});

test('creates distinct UUIDs when randomUUID is unavailable on HTTP', () => {
  const httpCrypto = { getRandomValues: values => webcrypto.getRandomValues(values) };
  const ids = Array.from({ length: 1000 }, () => createId(httpCrypto));
  for (const id of ids) assert.match(id, uuid);
  assert.equal(new Set(ids).size, ids.length);
});

test('fallback preserves leading zeroes and sets UUID version and variant', () => {
  assert.equal(createId({ getRandomValues: values => values.fill(0) }), '00000000-0000-4000-8000-000000000000');
  assert.equal(createId({ getRandomValues: values => values.fill(255) }), 'ffffffff-ffff-4fff-bfff-ffffffffffff');
});

test('creates distinct local record IDs when a downloaded HTML viewer omits crypto', () => {
  for (const cryptoApi of [null, {}]) {
    const ids = Array.from({ length: 1000 }, () => createId(cryptoApi));
    for (const id of ids) assert.match(id, uuid);
    assert.equal(new Set(ids).size, ids.length);
  }
});
