import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { atsLint, checkSuggestions, applySuggestion } from '../ats.js';
import { buildDoc, renderText, sourceTextLookup, readFetchedPosting, RESUME_TOOL } from '../lib.js';

const profile = JSON.parse(readFileSync(new URL('../data/profile.json', import.meta.url)));

const doc = () => buildDoc({
  headline: 'Brand and Presentation Designer', summary: { text: 'Designer with 27+ years of experience in presentation design and grant support. '.repeat(2), source_ids: ['cvag'] },
  skills: [{ category: 'Design', skill_ids: ['sk.id', 'sk.ppt'] }], education_ids: ['ed.csusb'], certification_ids: [], affiliation_ids: [],
  experience: [{ role_id: 'cvag', bullets: [{ text: 'Co-facilitated grant writing for the ACCESS Indian Canyon project, which earned a $50 million LTCAP grant.', source_ids: ['cvag.grant'] }, { text: 'Designed and produced hundreds of branded PowerPoint presentations for public board and committee meetings.', source_ids: ['cvag.pres'] }] },
    { role_id: 'ds', bullets: [{ text: 'Maintained classified and real estate databases.', source_ids: ['ds.db'] }] }]
}, profile, { locationId: 'ps', includePersonalLine: false });

test('the applicant tracking check reads like an ATS would', () => {
  const d = doc();
  const text = renderText(d).repeat(2).replace(/KEVIN BROADIE\n[\s\S]*?\n\n/, (m) => m); // long enough
  const checks = atsLint({ text: renderText(d) + '\n' + 'word '.repeat(260), doc: d, keywords: ['InDesign', 'PowerPoint', 'grant writing', 'Figma'], postingTitle: 'Brand and Presentation Designer' });
  const by = (label) => checks.find((c) => c.label.startsWith(label));
  assert.ok(by('Contact details').ok);
  assert.ok(by('Standard section headings').ok);
  assert.ok(by('Dates').ok);
  assert.ok(by('Plain characters').ok);
  assert.ok(by('The posting').ok);
  assert.match(by('Posting terms covered').detail, /Not in the resume: Figma/);
  assert.ok(text.length > 0);
});

test('the check flags missing contact details, odd headings and dates, tiny length, and special characters', () => {
  const d = doc();
  d.experience[0].dates = 'Spring of 2022 to last fall';
  const checks = atsLint({ text: 'Kevin\nEXPERIENCE\nDid things “well” – yes', doc: d, keywords: [], postingTitle: '' });
  const bad = checks.filter((c) => !c.ok).map((c) => c.label);
  for (const l of ['Contact details are in plain text', 'Standard section headings', 'Dates are in one readable format', 'Length', 'Plain characters in the text version']) assert.ok(bad.includes(l), l);
});

test('keywords that sit only in the skills list are called out', () => {
  const d = doc();
  const checks = atsLint({ text: renderText(d) + ' word'.repeat(250), doc: d, keywords: ['InDesign', 'Adobe InDesign'.split(' ')[0]], postingTitle: '' });
  assert.match(checks.find((c) => c.label === 'Keywords appear in context').detail, /only in the skills list/);
});

const known = sourceTextLookup(profile, { includePersonalLine: false });
const libraryText = known.all();
const good = (over = {}) => ({ kind: 'rephrase', keyword: 'grant applications', replaces: 'Co-facilitated grant writing for the ACCESS Indian Canyon project, which earned a $50 million LTCAP grant.', text: 'Co-facilitated grant applications for the ACCESS Indian Canyon project, which earned a $50 million LTCAP grant.', source_ids: ['cvag.grant'], why: 'The posting says grant applications.', ...over });

test('only safe suggestions survive: real line, posting keyword, cited sources, no new numbers', () => {
  const d = doc();
  const kept = checkSuggestions([
    good(),
    good({ replaces: 'A line that is not in the resume.' }),
    good({ keyword: 'budget books' }),
    good({ text: 'Co-facilitated grant applications that earned a $60 million LTCAP grant.' }),
    good({ source_ids: [] }),
    good({ keyword: '' }),
    { kind: 'ats', text: 'Spell out LTCAP once.' },
    { kind: 'ats', text: '   ' },
    { kind: 'rephrase', keyword: 'grant', replaces: d.summary, text: 'Designer with 27+ years of experience in grant presentation design.', source_ids: ['cvag'] }
    , good({ keyword: 'Axure', text: 'Co-facilitated grant work using Axure for the ACCESS Indian Canyon project, which earned a $50 million LTCAP grant.' }),
    good({ text: 'Co-facilitated grant applications for the ACCESS Indian Canyon project, using agile stakeholder roadmaps, which earned a $50 million LTCAP grant.' })
  ], { doc: d, knownText: known, libraryText });
  assert.deepEqual(kept.map((s) => s.kind + ':' + (s.keyword || s.text.slice(0, 10))), ['rephrase:grant applications', 'ats:Spell out ', 'rephrase:grant']);
  assert.deepEqual(kept[0].where, { ri: 0, bi: 0 });
  assert.deepEqual(kept[2].where, { summary: true });
});

test('applying a suggestion changes only that line and leaves the original intact', () => {
  const d = doc();
  const [s] = checkSuggestions([good()], { doc: d, knownText: known, libraryText });
  const next = applySuggestion(d, s);
  assert.equal(next.experience[0].bullets[0], s.text);
  assert.equal(next.experience[0].bullets[1], d.experience[0].bullets[1]);
  assert.match(d.experience[0].bullets[0], /grant writing/);
  assert.match(renderText(next), /grant applications for the ACCESS/);
});

test('the resume tool asks for suggestions with sources', () => {
  assert.ok(RESUME_TOOL.input_schema.required.includes('suggestions'));
  const s = RESUME_TOOL.input_schema.properties.suggestions.items.properties;
  for (const f of ['kind', 'keyword', 'replaces', 'text', 'source_ids', 'why']) assert.ok(s[f], f);
});

import { buildSuggestRequest, SUGGEST_TOOL, SUGGEST_SYSTEM } from '../ats.js';

test('asking for more rephrasings sends the resume as it stands, the missing terms, and the library', () => {
  const d = doc();
  const req = buildSuggestRequest(profile, { doc: d, missing: ['grant applications', 'stakeholder engagement'], offered: [{ kind: 'rephrase', keyword: 'WordPress', text: 'x' }], includePersonalLine: false });
  assert.deepEqual(req.tool_choice, { type: 'auto' });
  assert.equal(req.tools[0], SUGGEST_TOOL);
  assert.match(req.user, /<MISSING_TERMS>\s*\["grant applications","stakeholder engagement"\]/);
  assert.match(req.user, /Co-facilitated grant writing for the ACCESS Indian Canyon/);
  assert.match(req.user, /<LIBRARY>/);
  assert.match(req.user, /"keyword":"WordPress"/);
  assert.match(SUGGEST_SYSTEM, /natural sentence/);
  assert.match(SUGGEST_SYSTEM, /Never add a tool, result, number, duty, or claim/);
  assert.ok(SUGGEST_TOOL.input_schema.required.includes('unsupported'));
});

test('related word forms count as the same library term, so natural rewordings are not refused', () => {
  const d = doc();
  const lib = 'Engaged stakeholders and prioritized regional transportation projects. Wrote grant applications.';
  const ok = checkSuggestions([{ kind: 'rephrase', keyword: 'stakeholder engagement', replaces: d.experience[1].bullets[0], text: 'Maintained classified and real estate databases for stakeholder engagement.', source_ids: ['ds.db'], why: 'x' }],
    { doc: d, knownText: () => 'Maintained classified and real estate databases.', libraryText: lib });
  assert.equal(ok.length, 1);
  const bad = checkSuggestions([{ kind: 'rephrase', keyword: 'Kubernetes', replaces: d.experience[1].bullets[0], text: 'Maintained classified and real estate databases on Kubernetes.', source_ids: ['ds.db'], why: 'x' }],
    { doc: d, knownText: () => 'Maintained classified and real estate databases.', libraryText: lib });
  assert.equal(bad.length, 0);
});
