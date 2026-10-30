import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { typo, buildDoc, renderText, renderHtml } from '../lib.js';
import { layoutResume, wrapRuns, docFromText, FONT_VARIANTS, PAGE } from '../pdf.js';

const profile = JSON.parse(readFileSync(new URL('../data/profile.json', import.meta.url)));
const pick = (id, n) => ({ role_id: id, bullets: profile.roles.find((r) => r.id === id).bullets.slice(0, n).map((b) => ({ text: b.text, source_ids: [b.id] })) });
const sample = (n = 5) => buildDoc({
  headline: 'Brand and Presentation Designer', summary: { text: 'Designer with 27+ years of experience. '.repeat(3), source_ids: ['cvag'] },
  skills: [{ category: 'Design', skill_ids: ['sk.id', 'sk.ps'] }], education_ids: ['ed.csusb', 'ed.cod'], certification_ids: [], affiliation_ids: ['aff.mesa'],
  experience: [pick('cac', 2), pick('cvag', n + 2), pick('konsist', n + 1), pick('psam', 4), pick('ds', n)]
}, profile, { locationId: 'ps' });

// Widths that behave like a serif face: wider capitals, narrower punctuation.
const measure = (text, font, size, track = 0) => [...String(text)].reduce((w, ch) => w + size * (/[A-Z]/.test(ch) ? 0.68 : /[ ,.;:'!|]/.test(ch) ? 0.26 : 0.46) + (track || 0), 0) * (font === 's' ? 1.05 : 1);

test('typographic punctuation: curly quotes, en dash ranges, ellipses, and no damage to phone numbers', () => {
  assert.equal(typo('He said "yes" and it\'s done...'), 'He said “yes” and it’s done…');
  assert.equal(typo("'quoted' and rock 'n' roll"), '‘quoted’ and rock ‘n’ roll');
  assert.equal(typo('Jul 1999 - Jul 2009'), 'Jul 1999 – Jul 2009');
  assert.equal(typo('2024-25 budget'), '2024–25 budget');
  assert.equal(typo('(555) 555-5555'), '(555) 555-5555');
  assert.equal(typo('e-mail and well-known'), 'e-mail and well-known');
});

test('the on-screen resume uses typographic punctuation while the text export stays ASCII', () => {
  const doc = sample();
  doc.summary = 'Led the "ACCESS" project\'s grant work - on time.';
  assert.match(renderHtml(doc), /“ACCESS” project’s grant work – on time/);
  assert.ok(!/[^\x00-\x7F]/.test(renderText(doc)));
});

test('roles are set with the title and dates on one line and the employer beneath', () => {
  const html = renderHtml(sample());
  assert.match(html, /<div class="role-head"><h3>[^<]+<\/h3><span class="dates">[^<]+<\/span><\/div>\s*<p class="org"><em>/);
});

test('line breaking never exceeds the measure and avoids a one-word last line', () => {
  const runs = [{ text: 'Introduced an AI-enhanced grant alignment workflow that increased efficiency and compliance with federal and state funding criteria.', font: 'r' }];
  for (const width of [200, 300, 400]) {
    const lines = wrapRuns(runs, width, 10.5, measure);
    for (const l of lines) assert.ok(l.reduce((w, r) => w + measure(r.text, r.font, 10.5), 0) <= width + 0.01, `line too wide at ${width}`);
    if (lines.length > 1) assert.ok(lines.at(-1).map((r) => r.text).join('').trim().split(/\s+/).length > 1 || width >= 400, 'one-word last line');
  }
});

test('numbers and ampersands stay with the word they belong to', () => {
  const lines = wrapRuns([{ text: 'a b c d e f g h $50 million LTCAP grant', font: 'r' }], 70, 10, (t) => t.length * 5);
  for (const l of lines) {
    const t = l.map((r) => r.text).join('');
    assert.ok(!/\$50\s*$/.test(t), `"$50" was left at the end of a line: ${t}`);
  }
});

test('the layout fits a full resume on two pages, keeps every line inside the margins, and never strands a heading', () => {
  const { pages, size } = layoutResume(sample(), measure);
  assert.ok(pages.length <= 2, `${pages.length} pages`);
  assert.ok(size >= 9.75 && size <= 10.5);
  for (const lines of pages) {
    const last = lines.at(-1);
    assert.ok(!['heading', 'role', 'org'].includes(last.kind) || lines.length === 1, `page ends on a ${last.kind}`);
    for (const l of lines) {
      const w = l.runs.reduce((s, r) => s + measure(r.text, r.font, l.size, l.tracking || 0), 0);
      assert.ok((l.x || 0) + w <= PAGE.width - PAGE.left - PAGE.right + 0.5, `a line overflows: ${l.runs.map((r) => r.text).join('').slice(0, 40)}`);
      assert.ok(l.top + l.lead <= PAGE.height - PAGE.top - PAGE.bottom + 0.01, 'a line runs into the bottom margin');
    }
  }
});

test('a short resume stays on one page at the largest size', () => {
  const doc = sample(1);
  doc.experience = doc.experience.slice(0, 2);
  const out = layoutResume(doc, measure);
  assert.equal(out.pages.length, 1);
  assert.equal(out.size, 10.5);
});

test('a bullet that splits across pages leaves at least two lines on each side', () => {
  for (const n of [3, 4, 5, 6, 7]) {
    const { pages } = layoutResume(sample(n), measure);
    pages.forEach((lines, pi) => {
      if (pi === 0) return;
      const first = lines[0];
      if (first.kind === 'bullet' && !first.bullet) assert.ok(lines.filter((l) => l.kind === 'bullet').length >= 2);
    });
  }
});

test('headings are real capitals so every reader extracts them intact', () => {
  const { pages } = layoutResume(sample(), measure);
  const headings = pages.flat().filter((l) => l.kind === 'heading').map((l) => l.runs[0].text);
  assert.deepEqual(headings.filter((h) => h !== h.toUpperCase()), []);
  assert.ok(headings.includes('EXPERIENCE') && headings.includes('EDUCATION'));
});

test('the plain-text resume reads back into the same document', () => {
  const doc = sample();
  const back = docFromText(renderText(doc));
  assert.equal(back.name, 'Kevin Broadie');
  assert.equal(back.headline, doc.headline);
  assert.deepEqual(back.contact, doc.contact);
  assert.deepEqual(back.experience.map((e) => [e.title, e.org, e.dates]), doc.experience.map((e) => [e.title, e.org || '', e.dates]));
  assert.deepEqual(back.experience.map((e) => e.bullets), doc.experience.map((e) => e.bullets));
  assert.deepEqual(back.education, doc.education);
  assert.equal(docFromText(''), null);
});

test('PDF fonts exist and keep the short glyph index format the PDF library can subset', () => {
  const files = new Set(Object.values(FONT_VARIANTS).map((v) => v.file));
  assert.ok(files.size >= 4);
  for (const f of files) {
    const path = new URL(`../fonts/pdf/${f}`, import.meta.url);
    assert.ok(existsSync(path), f);
    const buf = readFileSync(path);
    const numTables = buf.readUInt16BE(4);
    let head = -1;
    for (let i = 0; i < numTables; i += 1) if (buf.toString('latin1', 12 + i * 16, 16 + i * 16) === 'head') head = buf.readUInt32BE(20 + i * 16);
    assert.ok(head > 0, `${f} has no head table`);
    assert.equal(buf.readInt16BE(head + 50), 0, `${f} uses the long loca format, which breaks PDF subsetting`);
    assert.ok(buf.length < 131072 * 1.2, `${f} is unexpectedly large`);
  }
  for (const w of ['LibertinusSerif-Regular', 'LibertinusSerif-Italic', 'LibertinusSerif-Semibold', 'LibertinusSerifDisplay-Regular']) assert.ok(existsSync(new URL(`../fonts/${w}.woff2`, import.meta.url)), w);
  assert.ok(existsSync(new URL('../fonts/OFL.txt', import.meta.url)));
});
