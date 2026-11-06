import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMobileViewport, MOBILE_SCALE, viewportContent } from '../src/lib/mobile-viewport.js';

test('le téléphone s’ouvre dézoomé, la tablette et l’ordinateur à l’échelle normale', () => {
  assert.equal(viewportContent(390, 844), `width=device-width, initial-scale=${MOBILE_SCALE}`);
  assert.equal(viewportContent(844, 390), `width=device-width, initial-scale=${MOBILE_SCALE}`);
  assert.equal(viewportContent(820, 1180), 'width=device-width, initial-scale=1');
  assert.equal(viewportContent(1920, 1080), 'width=device-width, initial-scale=1');
  assert.equal(viewportContent(undefined, undefined), 'width=device-width, initial-scale=1');
});

test('l’échelle du téléphone remplace la balise viewport sans bloquer le zoom manuel', () => {
  const attributes = { content: 'width=device-width, initial-scale=1.0' };
  const meta = { getAttribute: name => attributes[name], setAttribute: (name, value) => (attributes[name] = value) };
  const doc = { querySelector: selector => (selector === 'meta[name="viewport"]' ? meta : null) };
  applyMobileViewport(doc, { width: 390, height: 844 });
  assert.equal(attributes.content, 'width=device-width, initial-scale=0.8');
  assert.doesNotMatch(attributes.content, /maximum-scale|user-scalable/);
  applyMobileViewport({ querySelector: () => null }, { width: 390, height: 844 });
});
