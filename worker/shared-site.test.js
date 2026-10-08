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

test('React Nav and Footer render from the shared module, not their own copies', () => {
  const nav = src('src/components/Nav.jsx');
  const foot = src('src/components/Footer.jsx');
  for (const s of [nav, foot]) assert.match(s, /from '\.\.\/\.\.\/shared\/site\.js'/);
  for (const href of ['/odds', '/tools', '/record', '/terms', '/privacy']) {
    assert.ok(!nav.includes(`"${href}"`) && !foot.includes(`"${href}"`), `hardcoded ${href}`);
  }
  assert.doesNotMatch(foot, /informational purposes/);
  assert.doesNotMatch(nav, /session/);
  // Tailwind can't take colors from JS at runtime, so the button's gradient is literal; keep it equal.
  for (const hex of [...COLORS.gradient, ...COLORS.gradientHover]) assert.ok(nav.includes(hex), hex);
});

test('the SPA no longer owns the home page', () => {
  assert.equal(existsSync(new URL('../src/pages/Landing.jsx', import.meta.url)), false);
  assert.equal(existsSync(new URL('../src/components/EmailCapture.jsx', import.meta.url)), false);
  assert.doesNotMatch(src('src/App.jsx'), /path="\/"/);
  // The Worker serves /, so any link to it must be a full page load, not a client-side <Link>.
  const files = readdirSync(new URL('../src', import.meta.url), { recursive: true }).filter((f) => f.endsWith('.jsx'));
  for (const f of files) assert.doesNotMatch(src(`src/${f.replaceAll('\\', '/')}`), /to="\/"/, f);
});
