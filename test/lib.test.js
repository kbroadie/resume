import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { yearsSince, monthYear, dateRange, splitProfile, buildRequest, validateResult, buildDoc, renderText, renderHtml } from '../lib.js';

const profile = JSON.parse(readFileSync(new URL('../data/profile.json', import.meta.url)));
const now = new Date('2026-10-29');

test('profile ids are unique and statuses valid', () => {
  const ids = [];
  for (const r of profile.roles) { ids.push(r.id); for (const b of r.bullets) { ids.push(b.id); assert.ok(['verified', 'needs_confirm'].includes(b.status), b.id); } }
  for (const s of profile.skills) ids.push(s.id);
  for (const e of profile.education) ids.push(e.id);
  for (const c of profile.certifications) ids.push(c.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('profile holds no private identifiers', () => {
  const raw = JSON.stringify(profile);
  for (const secret of ['D4809771', 'Antelope', '760-409', '(760) 409', '7604096303']) assert.ok(!raw.includes(secret), secret);
  assert.equal(profile.contact.phone, '(555) 555-5555');
});

test('every group has at least two members', () => {
  const groups = {};
  for (const r of profile.roles) for (const b of r.bullets) if (b.group) (groups[b.group] ||= []).push(b.id);
  for (const [g, m] of Object.entries(groups)) assert.ok(m.length >= 2, g);
});

test('dates and years', () => {
  assert.equal(monthYear('1999-09'), 'Sep 1999');
  assert.equal(dateRange('2025', null), '2025 - Present');
  assert.equal(yearsSince('1999-09', now), 27);
  assert.equal(yearsSince('1999-09', new Date('2026-08-01')), 26);
});

test('held-back roles never reach the model as usable', () => {
  const { usable, heldBack } = splitProfile(profile);
  assert.ok(!usable.roles.some((r) => r.id === 'kbcs'));
  assert.ok(heldBack.some((h) => h.id === 'kbcs'));
  const req = buildRequest(profile, { posting: 'Designer wanted', now });
  const profileBlock = req.user.split('<PROFILE>')[1];
  assert.ok(!profileBlock.includes('kbcs'));
});

const good = () => ({
  headline: 'Presentation Designer',
  summary: { text: 'Designer with 27+ years of experience.', source_ids: ['cvag'] },
  skills: [{ category: 'Design', skill_ids: ['sk.ps', 'sk.id'] }],
  experience: [
    { role_id: 'cvag', bullets: [{ text: 'Co-facilitated grant writing that earned a $50 million LTCAP grant.', source_ids: ['cvag.grant'] }] },
    { role_id: 'cac', bullets: [{ text: 'Reviewed non-profit grant applications for the 2026 cycle.', source_ids: ['cac.1'] }] }
  ],
  education_ids: ['ed.csusb'], certification_ids: [], questions: [], fit_notes: ''
});

test('clean output validates', () => {
  assert.deepEqual(validateResult(good(), profile, { now }), []);
});

test('validator catches invented numbers, held-back sources, cross-role cites, and group reuse', () => {
  const bad = good();
  bad.experience[0].bullets = [
    { text: 'Won a $60 million grant.', source_ids: ['cvag.grant'] },
    { text: 'Consulted for small businesses.', source_ids: ['kbcs.1'] },
    { text: 'Reviewed grants.', source_ids: ['cac.1'] },
    { text: 'Saved $9,500.', source_ids: ['cvag.survey'] },
    { text: 'Saved over $9,000.', source_ids: ['cvag.survey.alt'] },
    { text: 'No source.', source_ids: [] }
  ];
  const issues = validateResult(bad, profile, { now }).join('\n');
  assert.match(issues, /number "60"/);
  assert.match(issues, /held-back source "kbcs.1"/);
  assert.match(issues, /different role/);
  assert.match(issues, /Group "survey-savings"/);
  assert.match(issues, /no source cited/);
});

test('document renders in order with the personal line and no education years', () => {
  const doc = buildDoc(good(), profile, { includePersonalLine: true });
  assert.deepEqual(doc.experience.map((e) => e.title), ['Grant Review Panelist (contract)', 'Family caregiver and estate executor', 'Branding & Visual Communications Specialist']);
  const text = renderText(doc);
  assert.match(text, /^KEVIN BROADIE/);
  assert.match(text, /\(555\) 555-5555/);
  assert.match(text, /Jun 2026 - Sep 2026/);
  assert.match(text, /2025 - Present/);
  assert.ok(!/Bachelor[^\n]*\d{4}/.test(text));
  assert.ok(!text.includes('kevinbroadie.com'));
  assert.match(renderText(buildDoc(good(), profile, { includePortfolio: true })), /kevinbroadie\.com/);
  assert.ok(!renderText(buildDoc(good(), profile, { includePersonalLine: false })).includes('caregiver'));
});

test('html output escapes markup', () => {
  const r = good();
  r.experience[0].bullets[0].text = '<script>alert(1)</script>';
  assert.ok(!renderHtml(buildDoc(r, profile)).includes('<script>'));
});
