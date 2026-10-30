import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildFitRequest, checkFit, fitScores, shownIn, citedIdsOf, fingerprint, FIT_TOOL } from '../fit.js';
import { sourceTextLookup } from '../lib.js';

const profile = JSON.parse(readFileSync(new URL('../data/profile.json', import.meta.url)));
const known = sourceTextLookup(profile);
const grant = profile.roles.find((r) => r.id === 'cvag').bullets.find((b) => b.id === 'cvag.grant');

const req = (o) => ({ text: 'Requirement', weight: 'must', keywords: [], support: 'strong', source_ids: ['cvag.grant'], note: 'n', ...o });

test('the fit request carries the posting, the library, and a forced report tool', () => {
  const r = buildFitRequest(profile, { posting: 'Wanted: a grant writer.' });
  assert.equal(r.tools[0], FIT_TOOL);
  assert.match(r.user, /<POSTING>\nWanted: a grant writer\.\n<\/POSTING>/);
  assert.match(r.user, /<PROFILE>/);
  assert.match(r.user, /"cvag\.grant"/);
  assert.ok(FIT_TOOL.input_schema.properties.requirements.items.required.includes('source_ids'));
});

test('a claim needs a real source, and a strong claim needs its own words in that source', () => {
  const out = checkFit({ requirements: [
    req({ text: 'Grant writing', keywords: ['grant'], source_ids: ['cvag.grant', 'made.up'] }),
    req({ text: 'Invented', source_ids: ['made.up'] }),
    req({ text: 'Rocket science', keywords: ['rocket'], support: 'strong', source_ids: ['cvag.grant'] }),
    req({ text: 'No source needed', support: 'none', source_ids: ['cvag.grant'] }),
    req({ text: 'grant writing' })
  ] }, known);
  assert.deepEqual(out.map((r) => r.text), ['Grant writing', 'Invented', 'Rocket science', 'No source needed']);
  assert.deepEqual(out[0].source_ids, ['cvag.grant']);
  assert.equal(out[0].support, 'strong');
  assert.equal(out[1].support, 'none');
  assert.equal(out[2].support, 'partial');
  assert.ok(out[2].adjusted);
  assert.deepEqual(out[3].source_ids, []);
});

test('degree and skill entries count as library sources', () => {
  assert.ok(known.has('ed.csusb'));
  assert.match(known(['ed.csusb']), /Bachelor of Arts/);
  assert.ok(known.has('sk.html'));
  assert.equal(known.has('nope'), false);
});

test('scores weight required items three to one, give half credit for partial, and never let the draft beat the library', () => {
  const reqs = [
    req({ text: 'A', weight: 'must', support: 'strong', keywords: ['grant'] }),
    req({ text: 'B', weight: 'must', support: 'partial', keywords: ['wordpress'] }),
    req({ text: 'C', weight: 'preferred', support: 'strong', keywords: ['figma'] }),
    req({ text: 'D', weight: 'preferred', support: 'none', keywords: ['rocket'] })
  ];
  // total weight 3 + 3 + 1 + 1 = 8; library credit 3 + 1.5 + 1 = 5.5
  const s = fitScores(reqs, 'Wrote grant applications and used Figma.');
  assert.equal(s.library, Math.floor(100 * 5.5 / 8));
  assert.equal(s.draft, Math.floor(100 * 4 / 8));
  assert.deepEqual(s.rows.map((r) => r.state), ['shown', 'unused', 'shown', 'missing']);
  assert.ok(s.draft <= s.library);
  assert.equal(fitScores([], 'x'), null);
  assert.equal(fitScores(reqs, '').draft, 0);
});

test('a requirement is also shown when the untouched draft cites a supporting entry', () => {
  const r = req({ keywords: ['nothing here'], source_ids: ['cvag.grant'] });
  assert.equal(shownIn(r, 'unrelated text'), false);
  assert.equal(shownIn(r, 'unrelated text', new Set(['cvag.grant'])), true);
  assert.equal(shownIn(req({ support: 'none', source_ids: [] }), 'x', new Set(['cvag.grant'])), false);
});

test('cited ids are collected from anywhere in a result, and the library fingerprint changes with the library', () => {
  const ids = citedIdsOf({ summary: { text: 's', source_ids: ['a', 'b'] }, experience: [{ bullets: [{ text: 't', source_ids: ['b', 'c'] }] }], skills: [{ source_ids: ['d'] }] });
  assert.deepEqual(ids.sort(), ['a', 'b', 'c', 'd']);
  const copy = structuredClone(profile);
  assert.equal(fingerprint(copy), fingerprint(profile));
  copy.skills.push({ id: 'sk.x', name: 'X', category: 'Design' });
  assert.notEqual(fingerprint(copy), fingerprint(profile));
  assert.ok(grant);
});
