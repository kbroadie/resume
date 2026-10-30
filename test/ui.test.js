import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const html = read('index.html');
const app = read('app.js');

// Ids that app.js creates at run time, so they are not in index.html.
const DYNAMIC = new Set(['q-answer', 'approve', 'cancel-merge', 'review-msg', 'check-form', 'system-select', 'form-details', 'form-status', 'cmp-find', 'cmp-paste', 'revise']);

test('every element id the app looks up exists in the page', () => {
  const used = new Set([...app.matchAll(/\$\('([a-z0-9-]+)'\)/g)].map((m) => m[1]));
  const missing = [...used].filter((id) => !DYNAMIC.has(id) && !html.includes(`id="${id}"`));
  assert.deepEqual(missing, []);
});

test('element ids in the page are unique', () => {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), []);
});

test('the app is named Resume Advisor everywhere users see it', () => {
  for (const f of ['index.html', 'manifest.webmanifest', 'README.md']) {
    assert.ok(read(f).includes('Resume Advisor'), f);
    assert.ok(!/Resume Tailor/.test(read(f)), `${f} still says Resume Tailor`);
  }
});

test('every module the app imports carries the same cache-busting version', () => {
  const versions = new Set();
  for (const f of ['index.html', 'app.js', 'lib.js', 'sync.js', 'library.js', 'knowledge.js', 'history.js']) {
    for (const m of read(f).matchAll(/\.(?:js|css)\?v=(\d+)/g)) versions.add(m[1]);
  }
  assert.equal(versions.size, 1, `found versions ${[...versions]}`);
});

test('mobile first: the page is fixed to the screen with a bottom tab bar and a theme toggle', () => {
  const css = read('styles.css');
  assert.match(css, /height: 100dvh/);
  assert.match(html, /id="tabbar"/);
  assert.match(html, /id="theme"/);
  assert.match(css, /:root\[data-theme="dark"\]/);
  assert.match(css, /prefers-color-scheme: dark/);
  assert.match(css, /\[data-theme="light"\]/);
});

test('the application link field and per-question flow exist', () => {
  assert.match(html, /id="applink"/);
  assert.match(html, /id="q-card"/);
  assert.ok(!html.includes('id="notes"') || html.includes('Instructions for this run'));
});
