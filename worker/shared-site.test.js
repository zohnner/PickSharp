import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { NAV, CTA_LABEL, FOOTER, COLORS } from '../shared/site.js';

const src = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

test('shared site data is well formed', () => {
  assert.deepEqual(NAV.map((n) => n.key), ['odds', 'tools', 'record']);
  for (const n of NAV) assert.match(n.href, /^\/[a-z]+$/, n.key);
  assert.equal(CTA_LABEL, 'Get edges free');
  assert.match(FOOTER.disclaimer, /informational purposes only/);
  assert.equal(FOOTER.helpline.tel, '1-800-522-4700');
  assert.deepEqual(FOOTER.links.map((l) => l.href), ['/terms', '/privacy']);
  assert.equal(COLORS.sharp[500], '#d4a72e');
  assert.equal(COLORS.gradient.length, 3);
  assert.equal(COLORS.gradientHover.length, 3);
});

test('tailwind reads the shared palette instead of its own copy', () => {
  const tw = src('tailwind.config.js');
  assert.match(tw, /from '\.\/shared\/site\.js'/);
  assert.doesNotMatch(tw, /#d4a72e/);
});
