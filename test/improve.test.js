import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { markTerms, SYSTEM_PROMPT, sourceTextLookup, keywordCoverage } from '../lib.js';
import { buildSummaryRequest, checkSummaries, SUMMARY_TOOL, SUMMARY_SYSTEM } from '../ats.js';
import { icon, iconNames, flourish } from '../icons.js';

const profile = JSON.parse(readFileSync(new URL('../data/profile.json', import.meta.url)));
const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('terms are marked whole-word and case-insensitive, with counts, and the text stays escaped', () => {
  const out = markTerms('Used InDesign and indesign, not InDesigner. <b>PowerPoint</b> & "Power Point".', ['InDesign', 'PowerPoint', 'Figma'], (i) => (i === 0 ? 'hit' : 'miss'));
  assert.deepEqual(out.counts, [2, 1, 0]);
  assert.match(out.html, /<mark class="k-hit" data-k="0">InDesign<\/mark> and <mark class="k-hit" data-k="0">indesign<\/mark>, not InDesigner\./);
  assert.match(out.html, /&lt;b&gt;<mark class="k-miss" data-k="1">PowerPoint<\/mark>&lt;\/b&gt; &amp; &quot;Power Point&quot;/);
  assert.ok(!out.html.includes('<b>'));
});

test('longer terms win over shorter ones that overlap them, and phrases tolerate line breaks', () => {
  const out = markTerms('Wrote grant\napplications and a grant.', ['grant', 'grant applications']);
  assert.deepEqual(out.counts, [1, 1]);
  assert.match(out.html, /<mark class="k-hit" data-k="1">grant\napplications<\/mark> and a <mark class="k-hit" data-k="0">grant<\/mark>/);
  assert.equal(markTerms('nothing here', []).html, 'nothing here');
});

test('terms with regular-expression characters are matched literally', () => {
  const out = markTerms('Knows C++ and (WCAG 2.0) rules; also A/V.', ['C++', 'WCAG 2.0', 'A/V']);
  assert.deepEqual(out.counts, [1, 1, 1]);
});

test('the tailoring prompt asks for every supported keyword to be covered, naturally', () => {
  assert.match(SYSTEM_PROMPT, /Keyword coverage matters/);
  assert.match(SYSTEM_PROMPT, /every supported keyword without stacking/);
});

const known = sourceTextLookup(profile, { includePersonalLine: false });
const doc = { summary: 'Old summary.', experience: [] };

test('summary requests carry the library, the terms, and the years figure', () => {
  const req = buildSummaryRequest(profile, { doc, keywords: ['InDesign', 'grant applications'], missing: ['grant applications'], postingTitle: 'Brand Designer', includePersonalLine: false, now: new Date('2026-10-30') });
  assert.deepEqual(req.tool_choice, { type: 'auto' });
  assert.equal(req.tools[0], SUMMARY_TOOL);
  assert.match(req.user, /"years_of_experience":27/);
  assert.match(req.user, /<POSTING_TITLE>\s*Brand Designer/);
  assert.match(req.user, /"not_yet_in_resume":\["grant applications"\]/);
  assert.match(SUMMARY_SYSTEM, /exactly three options/);
});

test('only safe summaries survive: cited, short, no first person, no invented numbers, one per label', () => {
  const ok = { label: 'Impact', text: 'Co-facilitated grant writing that earned a $50 million LTCAP grant, with 27+ years of design experience.', source_ids: ['cvag.grant'] };
  const out = checkSummaries([
    ok,
    { ...ok, label: 'Impact', text: 'A second Impact option.' },
    { label: 'Skills', text: 'Led $60 million of grant work.', source_ids: ['cvag.grant'] },
    { label: 'Skills', text: 'I led grant writing for the agency.', source_ids: ['cvag.grant'] },
    { label: 'Brief', text: 'Designer.', source_ids: [] },
    { label: 'Brief', text: 'Designer and grant writer with 27+ years of experience.', source_ids: ['cvag.grant'] },
    { label: 'Wild', text: 'Nope.', source_ids: ['cvag.grant'] },
    { label: 'Skills', text: 'word '.repeat(95), source_ids: ['cvag.grant'] }
  ], { knownText: known, years: 27, startYear: 1999 });
  assert.deepEqual(out.map((o) => o.label), ['Impact', 'Brief']);
  assert.equal(out[0].text, ok.text);
});

test('every icon is a closed set of drawing commands, and the ornament renders', () => {
  assert.ok(iconNames.length >= 25);
  for (const name of ['copy', 'download', 'compare', 'sparkle', 'target', 'shield', 'link', 'history', 'building']) assert.ok(iconNames.includes(name), name);
  for (const name of iconNames) assert.match(icon(name), /^<svg class="ico " viewBox="0 0 24 24"[^>]*>.+<\/svg>$/s, name);
  assert.equal(icon('nope'), '');
  assert.match(flourish(), /class="flourish"/);
});

test('every data-icon in the page names a real icon', () => {
  const used = new Set([...read('index.html').matchAll(/data-icon="([a-z]+)"/g)].map((m) => m[1]));
  assert.deepEqual([...used].filter((n) => !iconNames.includes(n)), []);
});

test('the favicon set exists and the page and manifest point at real files', () => {
  for (const f of ['favicon.svg', 'favicon.ico', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png']) assert.ok(existsSync(new URL(`../${f}`, import.meta.url)), f);
  const html = read('index.html');
  for (const href of ['favicon.svg', 'favicon.ico', 'apple-touch-icon.png', 'manifest.webmanifest']) assert.ok(html.includes(`href="${href}"`), href);
  const manifest = JSON.parse(read('manifest.webmanifest'));
  assert.equal(manifest.name, 'Resume Advisor');
  for (const i of manifest.icons) assert.ok(existsSync(new URL(`../${i.src}`, import.meta.url)), i.src);
  assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'));
  const ico = readFileSync(new URL('../favicon.ico', import.meta.url));
  assert.equal(ico.readUInt16LE(2), 1, 'an ICO file');
  assert.ok(ico.readUInt16LE(4) >= 3, 'with 16, 32, and 48 pixel images');
  const png = readFileSync(new URL('../apple-touch-icon.png', import.meta.url));
  assert.equal([png.readUInt32BE(16), png.readUInt32BE(20)].join('x'), '180x180');
});

test('the download buttons say they download, and the page has the Improve and Compare views', () => {
  const html = read('index.html');
  assert.match(html, /id="download"[^>]*aria-label="Download as a text file"/);
  assert.match(html, /id="pdf"[^>]*aria-label="Download as a PDF"/);
  assert.match(html, /<span class="dl-label"><i data-icon="download"><\/i>Download<\/span>/);
  for (const id of ['v-improve', 'v-compare', 'cmp-posting-body', 'cmp-resume-body', 'sum-gen', 'sug-all', 'cov-fill']) assert.ok(html.includes(`id="${id}"`), id);
});

test('keyword matching stays consistent between the checker and the highlighter', () => {
  const terms = ['grant applications', 'InDesign', 'Figma'];
  const text = 'Wrote grant applications. Built InDesign templates.';
  const cov = keywordCoverage(terms, text);
  const marked = markTerms(text, terms);
  assert.deepEqual(cov.covered.sort(), terms.filter((_, i) => marked.counts[i] > 0).sort());
});
