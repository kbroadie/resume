import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeUrl, keywordCoverage, resumeStats, resumeFilename, sectionTexts, buildDoc, renderHtml, renderText, RESUME_TOOL } from '../lib.js';
import { addEntry, updateEntry, removeEntry, label, STATUSES } from '../history.js';

const profile = JSON.parse(readFileSync(new URL('../data/profile.json', import.meta.url)));

test('application links are normalized and unsafe schemes refused', () => {
  assert.equal(normalizeUrl('example.com/jobs/12?id=3'), 'https://example.com/jobs/12?id=3');
  assert.equal(normalizeUrl('  http://jobs.example.org/a '), 'http://jobs.example.org/a');
  assert.equal(normalizeUrl('javascript:alert(1)'), null);
  assert.equal(normalizeUrl('ftp://example.com/x'), null);
  assert.equal(normalizeUrl('not a url'), null);
  assert.equal(normalizeUrl(''), null);
  assert.equal(normalizeUrl('localhost'), null);
});

test('keyword coverage matches whole words, ignores case, and handles symbols', () => {
  const text = 'Managed WordPress sites. Built InDesign templates and C++ tools; used Microsoft Excel, A/V gear.';
  const out = keywordCoverage(['wordpress', 'InDesign', 'C++', 'Excel', 'A/V', 'Word', 'Python', 'indesign', ''], text);
  assert.deepEqual(out.covered, ['wordpress', 'InDesign', 'C++', 'Excel', 'A/V']);
  assert.deepEqual(out.missing, ['Word', 'Python']);
});

test('stats and filenames', () => {
  assert.deepEqual(resumeStats('one two three'), { words: 3, pages: 1 });
  assert.equal(resumeStats('word '.repeat(960)).pages, 2);
  assert.equal(resumeFilename('Acme, Inc.', 'Brand Designer / Lead'), 'Kevin-Broadie-Resume-Acme-Inc-Brand-Designer-Lead.txt');
  assert.equal(resumeFilename('', ''), 'Kevin-Broadie-Resume.txt');
});

const result = () => ({
  posting_title: 'Designer', company: 'Acme', posting_keywords: ['InDesign'], headline: 'Designer',
  summary: { text: 'A summary.', source_ids: ['cvag'] },
  skills: [{ category: 'Design', skill_ids: ['sk.id', 'sk.ps'] }],
  experience: [
    { role_id: 'cvag', bullets: [{ text: 'Did A.', source_ids: ['cvag.grant'] }] },
    { role_id: 'ds', bullets: [{ text: 'Did B.', source_ids: ['ds.db'] }] }
  ],
  education_ids: ['ed.csusb'], certification_ids: [], affiliation_ids: [], questions: [], fit_notes: ''
});

test('per-section and per-role text for single form fields', () => {
  const doc = buildDoc(result(), profile, { includePersonalLine: false });
  const s = sectionTexts(doc);
  assert.equal(s.summary, 'A summary.');
  assert.equal(s.skills, 'Design: Adobe InDesign, Adobe Photoshop');
  assert.equal(s.roles.length, 2);
  assert.match(s.roles[0], /^Branding & Visual Communications Specialist \| Coachella Valley Association of Governments \(CVAG\) \| Palm Desert, CA\nApr 2022 - Sep 2025\n- Did A\.$/);
  assert.match(s.experience, /Did A\.[\s\S]*\n\n[\s\S]*Did B\./);
  assert.equal(s.education, 'Bachelor of Arts, Graphic Design & Marketing | California State University, San Bernardino | San Bernardino, CA');
});

test('html keeps sections and roles addressable and plain text stays unchanged', () => {
  const doc = buildDoc(result(), profile, { includePersonalLine: false });
  const html = renderHtml(doc);
  for (const name of ['summary', 'skills', 'experience', 'education']) assert.ok(html.includes(`data-section="${name}"`), name);
  assert.equal((html.match(/class="role"/g) || []).length, 2);
  assert.ok(renderText(doc).startsWith('KEVIN BROADIE'));
});

test('the model must report the posting title, company, and keywords', () => {
  for (const f of ['posting_title', 'company', 'posting_keywords']) assert.ok(RESUME_TOOL.input_schema.required.includes(f), f);
});

test('history adds newest first, caps its size, updates, and removes', () => {
  let list = [];
  const t = (n) => new Date(2026, 9, n);
  ({ list } = addEntry(list, { title: 'A', company: 'X' }, t(1)));
  const second = addEntry(list, { title: 'B', company: '' }, t(2));
  list = second.list;
  assert.deepEqual(list.map((e) => e.title), ['B', 'A']);
  assert.equal(list[0].status, 'Drafted');
  assert.ok(STATUSES.includes('Applied'));
  list = updateEntry(list, second.entry.id, { status: 'Applied' });
  assert.equal(list[0].status, 'Applied');
  assert.equal(label(list[1]), 'A at X');
  assert.equal(label({}), 'Untitled posting');
  for (let i = 0; i < 80; i += 1) ({ list } = addEntry(list, { title: `T${i}` }, t(3)));
  assert.equal(list.length, 60);
  assert.equal(removeEntry(list, list[0].id).length, 59);
});
