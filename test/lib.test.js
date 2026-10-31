import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { yearsSince, monthYear, dateRange, splitProfile, buildRequest, validateResult, buildDoc, renderText, renderHtml } from '../lib.js';

const profile = JSON.parse(readFileSync(new URL('../data/profile.json', import.meta.url)));
const now = new Date('2026-10-29');

test('profile ids are unique and statuses valid', () => {
  const ids = [];
  for (const r of profile.roles) { ids.push(r.id); for (const b of r.bullets) { ids.push(b.id); assert.ok(['verified', 'needs_confirm', 'excluded'].includes(b.status), b.id); } }
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

test('held-back roles and bullets never reach the model as usable', () => {
  const p = structuredClone(profile);
  p.roles.find((r) => r.id === 'cod').status = 'needs_confirm';
  p.roles.find((r) => r.id === 'ds').bullets.find((b) => b.id === 'ds.web').status = 'needs_confirm';
  const { usable, heldBack } = splitProfile(p);
  assert.ok(!usable.roles.some((r) => r.id === 'cod'));
  assert.ok(!usable.roles.find((r) => r.id === 'ds').bullets.some((b) => b.id === 'ds.web'));
  assert.ok(heldBack.some((h) => h.id === 'cod') && heldBack.some((h) => h.id === 'ds.web'));
  const req = buildRequest(p, { posting: 'Designer wanted', now });
  assert.ok(!req.user.split('<PROFILE>')[1].includes('"cod"'));
});

test('resume content never names the unsuccessful applications and keeps corrected facts', () => {
  const raw = JSON.stringify({ roles: profile.roles, skills: profile.skills, education: profile.education, certifications: profile.certifications });
  for (const banned of ['Dodger', 'Hemet', 'SB Museum', 'Expert', 'over $9,000', 'Graphic Design with']) assert.ok(!raw.includes(banned), banned);
  assert.equal(profile.roles.find((r) => r.id === 'ds').end, '2009-07');
  assert.equal(profile.roles.find((r) => r.id === 'kbcs').status, 'excluded');
  assert.ok(!splitProfile(profile).usable.roles.some((r) => r.id === 'kbcs') && !splitProfile(profile).heldBack.some((h) => h.id === 'kbcs'));
  assert.equal(profile.education[0].degree, 'Bachelor of Arts, Graphic Design & Marketing');
  assert.ok(profile.certifications.every((c) => c.status === 'expired'));
  assert.ok(JSON.stringify(profile.skills.map((x) => x.name)).match(/Hyper-V/) && !profile.skills.some((x) => 'level' in x));
});

test('only CAC and CVAG are government roles; the CVAG government title is an option', () => {
  assert.deepEqual(profile.roles.filter((r) => r.government).map((r) => r.id).sort(), ['cac', 'cvag']);
  assert.equal(profile.roles.find((r) => r.id === 'cvag').title_options[0].title, 'Program Specialist II, Visual Branding & Communications Specialist');
  assert.equal(profile.roles.find((r) => r.id === 'konsist').title, 'Art Director');
});

test('affiliations render only when chosen', () => {
  const r = good();
  assert.ok(!renderText(buildDoc(r, profile)).includes('MESA'));
  r.affiliation_ids = ['aff.mesa'];
  assert.match(renderText(buildDoc(r, profile)), /AFFILIATIONS\nMember, MESA/);
  r.affiliation_ids = ['nope'];
  assert.match(validateResult(r, profile, { now }).join(), /Affiliations: unknown/);
});

test('expired certifications are never offered', () => {
  const { usable } = splitProfile(profile);
  assert.deepEqual(usable.certifications, []);
});

const good = () => ({
  headline: 'Presentation Designer',
  summary: { text: 'Designer with 27+ years of experience.', source_ids: ['cvag'] },
  skills: [{ category: 'Design', skill_ids: ['sk.ps', 'sk.id'] }],
  experience: [
    { role_id: 'cvag', bullets: [{ text: 'Co-facilitated grant writing that earned a $50 million LTCAP grant.', source_ids: ['cvag.grant'] }] },
    { role_id: 'cac', bullets: [{ text: 'Reviewed non-profit grant applications for the 2026 cycle.', source_ids: ['cac.1'] }] }
  ],
  education_ids: ["ed.csusb"], certification_ids: [], affiliation_ids: [], questions: [], fit_notes: ''
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
    { text: 'Built the TPPS survey.', source_ids: ['cvag.survey2'] },
    { text: 'No source.', source_ids: [] }
  ];
  const grouped = structuredClone(profile);
  const cvag = grouped.roles.find((r) => r.id === 'cvag');
  cvag.bullets.find((b) => b.id === 'cvag.survey').group = 'survey';
  cvag.bullets.find((b) => b.id === 'cvag.survey2').group = 'survey';
  const issues = validateResult(bad, grouped, { now }).join('\n');
  assert.match(issues, /number "60"/);
  assert.match(issues, /held-back source "kbcs.1"/);
  assert.match(issues, /different role/);
  assert.match(issues, /Group "survey"/);
  assert.match(issues, /no source cited/);
});

test('title options and location are applied; bad title ids are flagged', () => {
  const r = good();
  r.experience[0].title_id = 'gov';
  const doc = buildDoc(r, profile, { locationId: 'yv' });
  assert.ok(doc.experience.some((e) => e.title === 'Program Specialist II, Visual Branding & Communications Specialist'));
  assert.match(renderText(doc), /Yucca Valley, CA \| kbroadie@gmail.com/);
  assert.ok(!renderText(buildDoc(good(), profile)).includes('Yucca'));
  r.experience[0].title_id = 'nope';
  assert.match(validateResult(r, profile, { now }).join(), /unknown title option/);
});

test('document renders in order with the personal line and no education years', () => {
  const doc = buildDoc(good(), profile, { includePersonalLine: true });
  assert.deepEqual(doc.experience.map((e) => e.title), ['Grant Review Panelist (contract)', 'Family caregiver and estate executor', 'Branding & Visual Communications Specialist', 'Family caregiver']);
  const text = renderText(doc);
  assert.match(text, /^KEVIN BROADIE/);
  assert.match(text, /\(555\) 555-5555/);
  assert.match(text, /Jun 2026 - Sep 2026/);
  assert.match(text, /2025 - Present/);
  assert.ok(!/Bachelor[^\n]*\d{4}/.test(text));
  assert.ok(!text.includes('kevinbroadie.com'));
  assert.ok(!renderText(buildDoc(good(), profile, { includePersonalLine: false })).includes('caregiver'));
});

test('html output escapes markup', () => {
  const r = good();
  r.experience[0].bullets[0].text = '<script>alert(1)</script>';
  assert.ok(!renderHtml(buildDoc(r, profile)).includes('<script>'));
});

test('sign-in check uses a CORS-enabled endpoint', () => {
  const src = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  assert.ok(src.includes('/messages/count_tokens'));
  assert.ok(!src.includes('${API}/models'));
  assert.ok(src.includes('Anthropic did not accept that key'));
});

test('Desert Sun uses the full title, with the short form available for character limits', () => {
  const ds = profile.roles.find((r) => r.id === 'ds');
  assert.equal(ds.title, 'Online Production Coordinator');
  assert.equal(ds.title_options[0].title, 'Online Producer');
  assert.match(buildRequest(profile, { posting: 'x', shortTitles: true, now }).user, /"short_titles":true/);
  assert.match(buildRequest(profile, { posting: 'x', now }).user, /"short_titles":false/);
  const r = good();
  r.experience.push({ role_id: 'ds', title_id: 'short', bullets: [{ text: 'Maintained classified and real estate databases.', source_ids: ['ds.db'] }] });
  assert.ok(buildDoc(r, profile).experience.some((e) => e.title === 'Online Producer'));
});

test('requests never force a tool call, which newer models reject', () => {
  const req = buildRequest(profile, { posting: 'x', now });
  assert.deepEqual(req.tool_choice, { type: 'auto' });
  assert.match(req.system, /calling submit_resume/);
});

test("meet-the-museum, Raisers Edge, portfolio, caregiving and team-lead answers are in the profile", () => {
  const raw = JSON.stringify(profile.roles);
  assert.ok(!raw.includes('White Party'));
  assert.ok(profile.never_include.some((x) => x.includes('White Party')));
  assert.match(profile.roles.find((r) => r.id === 'psam').bullets.find((b) => b.id === 'ps.crm').text, /Raiser's Edge, the CRM/);
  assert.deepEqual(profile.contact.links, []);
  assert.ok(profile.preferences.some((x) => x.includes('no portfolio yet')));
  assert.ok(!JSON.stringify({ links: profile.contact.links, roles: profile.roles }).includes('kevinbroadie.com'));
  const care = profile.personal_lines.find((l) => l.id === 'care2');
  assert.deepEqual([care.title, care.start, care.end], ['Family caregiver', '2021-10', '2022-04']);
  assert.match(profile.roles.find((r) => r.id === 'konsist').bullets.find((b) => b.id === 'ko.team').text, /^Led designers and programmers/);
  assert.match(buildRequest(profile, { posting: 'x', now }).user, /no portfolio yet/);
});

test('a revision request sends the current draft, and the prompt tells Claude to start from it', async () => {
  const { buildRequest, SYSTEM_PROMPT } = await import('../lib.js');
  const withDraft = buildRequest(profile, { posting: 'Posting text.', notes: 'Lead with grants.', draft: 'KEVIN BROADIE\nDraft line.' });
  assert.match(withDraft.user, /<CURRENT_DRAFT>\nKEVIN BROADIE\nDraft line\.\n<\/CURRENT_DRAFT>/);
  assert.doesNotMatch(buildRequest(profile, { posting: 'Posting text.' }).user, /CURRENT_DRAFT/);
  assert.match(SYSTEM_PROMPT, /CURRENT_DRAFT/);
  assert.doesNotMatch(SYSTEM_PROMPT, /fit_notes/);
});

test('the Grant Review Panelist role never has more than one bullet, however many the model sends', async () => {
  const { buildDoc, ROLE_BULLET_CAP, RESUME_TOOL, SYSTEM_PROMPT } = await import('../lib.js');
  const cac = profile.roles.find((r) => r.id === 'cac');
  const bullets = cac.bullets.filter((b) => b.status === 'verified').map((b) => ({ text: b.text, source_ids: [b.id] }));
  assert.ok(bullets.length >= 1);
  const many = [...bullets, ...bullets, ...bullets];
  const doc = buildDoc({ headline: 'H', summary: { text: 's', source_ids: [] }, skills: [], experience: [{ role_id: 'cac', bullets: many }, { role_id: 'cvag', bullets: [{ text: 'a', source_ids: [] }, { text: 'b', source_ids: [] }] }], education_ids: [], certification_ids: [], affiliation_ids: [] }, profile, { locationId: 'ps' });
  assert.equal(ROLE_BULLET_CAP.cac, 1);
  assert.equal(doc.experience.find((x) => /Grant Review/.test(x.title)).bullets.length, 1);
  assert.equal(doc.experience.find((x) => /Branding/.test(x.title)).bullets.length, 2);
  assert.match(SYSTEM_PROMPT, /"cac".*at most one bullet/);
});

test('the prompt asks for one page, no redundancy, and a quoted deadline, and the tool carries both deadline fields', async () => {
  const { RESUME_TOOL, SYSTEM_PROMPT, buildRequest } = await import('../lib.js');
  assert.match(SYSTEM_PROMPT, /one printed page/);
  assert.match(SYSTEM_PROMPT, /No redundancy/);
  assert.match(SYSTEM_PROMPT, /deadline_quote/);
  for (const f of ['deadline_date', 'deadline_quote']) assert.ok(RESUME_TOOL.input_schema.required.includes(f), f);
  assert.match(buildRequest(profile, { posting: 'P', now: new Date('2026-10-31T10:00:00Z') }).user, /"today":"2026-10-31"/);
});
