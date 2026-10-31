import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildDraftRequest, checkDrafts, DRAFT_TOOL } from '../bullets.js';
import { addBulletToDoc, buildDoc, ROLE_BULLET_CAP } from '../lib.js';

const profile = JSON.parse(readFileSync(new URL('../data/profile.json', import.meta.url)));
const ids = profile.roles.map((r) => r.id);
const reqs = [{ index: 0, text: 'Stakeholder engagement', keywords: ['stakeholder engagement'] }, { index: 1, text: 'Five years of WordPress', keywords: ['WordPress'] }];

test('the draft request carries the requirements, the jobs with their ids, and the drafting tool', () => {
  const r = buildDraftRequest(profile, reqs);
  assert.equal(r.tools[0], DRAFT_TOOL);
  assert.match(r.user, /"requirement":"Stakeholder engagement"/);
  assert.match(r.user, /"id":"konsist"/);
  assert.match(r.system, /does not yet mention/);
});

test('drafts are kept only as plain sentences with no new numbers and no first person, and the job must be a real one', () => {
  const out = checkDrafts({ drafts: [
    { index: 0, bullet: '- engaged stakeholders across departments', role_id: 'konsist' },
    { index: 1, bullet: 'Maintained WordPress sites for 12 years.', role_id: 'nope' },
    { index: 1, bullet: 'Maintained WordPress sites for five years.', role_id: 'gw' },
    { index: 7, bullet: 'Unrequested.', role_id: 'konsist' },
    { index: 0, bullet: 'I engaged stakeholders.', role_id: 'konsist' }
  ] }, reqs, ids);
  assert.deepEqual(out[0], { text: 'Engaged stakeholders across departments.', role_id: 'konsist' });
  assert.deepEqual(out[1], { text: 'Maintained WordPress sites for five years.', role_id: 'gw' });
  assert.equal(out[7], undefined);
  assert.equal(Object.keys(out).length, 2);
  assert.equal(checkDrafts({ drafts: [{ index: 1, bullet: 'Maintained WordPress sites for 12 years.', role_id: '' }] }, reqs, ids)[1], undefined, 'a number the requirement does not have is refused');
  assert.equal(checkDrafts(null, reqs, ids)[0], undefined);
});

const base = () => buildDoc({ headline: 'H', summary: { text: 's', source_ids: [] }, skills: [], experience: [{ role_id: 'cvag', bullets: [{ text: 'Did grant work.', source_ids: [] }] }], education_ids: [], certification_ids: [], affiliation_ids: [] }, profile, { locationId: 'ps' });

test('a bullet is added under the chosen employer, a missing employer is added in date order, and the original is untouched', () => {
  const doc = base();
  const a = addBulletToDoc(doc, profile, 'cvag', 'Engaged stakeholders across departments.');
  assert.ok(a.ok);
  assert.equal(a.doc.experience.find((x) => /CVAG/.test(x.org)).bullets.at(-1), 'Engaged stakeholders across departments.');
  assert.equal(doc.experience.find((x) => /CVAG/.test(x.org)).bullets.length, 1, 'the input is not changed');
  const b = addBulletToDoc(a.doc, profile, 'konsist', 'Led brand work for agency clients.');
  assert.ok(b.ok);
  const orgs = b.doc.experience.map((x) => x.org);
  assert.ok(orgs.indexOf('Konsist') > orgs.findIndex((o) => /CVAG/.test(o)), 'Konsist comes after the newer CVAG job');
  assert.equal(b.doc.experience.find((x) => x.org === 'Konsist').bullets.length, 1);
});

test('refusals: no employer, no text, a repeat, or the Grant Review Panelist limit', () => {
  const doc = base();
  assert.equal(addBulletToDoc(doc, profile, '', 'x').reason, 'Choose an employer');
  assert.equal(addBulletToDoc(doc, profile, 'cvag', '  ').reason, 'Write the bullet');
  assert.equal(addBulletToDoc(doc, profile, 'cvag', 'did grant work').reason, 'Already in the resume');
  const one = addBulletToDoc(doc, profile, 'cac', 'Reviewed grant applications.');
  assert.ok(one.ok);
  assert.equal(ROLE_BULLET_CAP.cac, 1);
  assert.match(addBulletToDoc(one.doc, profile, 'cac', 'Scored proposals fairly.').reason, /keeps 1 bullet/);
});
