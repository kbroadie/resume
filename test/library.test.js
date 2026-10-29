import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyPatch, validateProfile, buildLibrarianRequest, describeOp, LIBRARIAN_TOOL } from '../library.js';
import { emptyKnowledge, applyAnswer, pendingItems, markMerged, filterQuestions } from '../knowledge.js';
import { splitProfile, groupLookup } from '../lib.js';

const profile = JSON.parse(readFileSync(new URL('../data/profile.json', import.meta.url)));
const now = new Date('2026-10-29T12:00:00Z');
const roleBullets = (p, id) => p.roles.find((r) => r.id === id).bullets;

test('the shipped profile is structurally sound', () => assert.deepEqual(validateProfile(profile), []));

test('add_bullet puts a reworded fact on its role with a fresh id, and skips duplicates', () => {
  const ops = [{ op: 'add_bullet', role_id: 'ds', text: 'Maintained an archive of about 40,000 local stories.', tags: ['Archive', 'Database'] }];
  const out = applyPatch(profile, ops, 'The archive held about 40,000 stories.');
  const added = roleBullets(out.profile, 'ds').at(-1);
  assert.equal(added.status, 'verified');
  assert.match(added.id, /^ds\./);
  assert.deepEqual(added.tags, ['archive', 'database']);
  assert.equal(roleBullets(profile, 'ds').length + 1, roleBullets(out.profile, 'ds').length, 'original untouched');
  const again = applyPatch(out.profile, ops, '40,000');
  assert.equal(again.skipped[0].why, 'already in the library');
});

test('numbers Kevin did not say are refused', () => {
  const out = applyPatch(profile, [{ op: 'add_bullet', role_id: 'ds', text: 'Archived 50,000 stories.' }], 'About 40,000 stories.');
  assert.equal(out.applied.length, 0);
  assert.match(out.skipped[0].why, /number 50000/);
});

test('update_bullet may reuse numbers already in the bullet', () => {
  const out = applyPatch(profile, [{ op: 'update_bullet', id: 'ds.ads', text: 'Designed and managed over 1,000 ads across more than 600 campaigns, including rich media.' }], 'It included rich media.');
  assert.equal(out.applied.length, 1);
});

test('resolve_group keeps the chosen wording, drops alternates, clears the group', () => {
  const out = applyPatch(profile, [{ op: 'resolve_group', keep_id: 'cvag.docs' }]);
  const ids = roleBullets(out.profile, 'cvag').map((b) => b.id);
  assert.ok(ids.includes('cvag.docs') && !ids.includes('cvag.docs2'));
  assert.equal(roleBullets(out.profile, 'cvag').find((b) => b.id === 'cvag.docs').group, undefined);
  assert.deepEqual(validateProfile(out.profile), []);
});

test('role fields, dates, title options, skills, preferences and open questions', () => {
  const ops = [
    { op: 'set_role_field', role_id: 'konsist', field: 'end', value: '2021-10' },
    { op: 'set_role_field', role_id: 'cvag', field: 'start', value: 'April' },
    { op: 'set_role_field', role_id: 'gw', field: 'end', value: '' },
    { op: 'add_title_option', role_id: 'psam', id: 'it', title: 'IT Systems Administrator', use_when: 'IT postings.' },
    { op: 'add_skill', text: 'Figma', category: 'Design' },
    { op: 'add_skill', text: 'adobe photoshop' },
    { op: 'add_preference', text: 'Lead with grant writing for public-sector postings.' },
    { op: 'add_never_include', text: 'Salary history' },
    { op: 'remove_open_question', match: 'Is the SB Museum tab' }
  ];
  const out = applyPatch({ ...profile, open_questions: ['Is the SB Museum tab one of the application tabs?', 'Other'] }, ops, 'Konsist ended 2021-10.');
  assert.equal(out.profile.roles.find((r) => r.id === 'konsist').end, '2021-10');
  assert.equal(out.profile.roles.find((r) => r.id === 'gw').end, null);
  assert.equal(out.profile.roles.find((r) => r.id === 'psam').title_options[0].id, 'it');
  assert.ok(out.profile.skills.some((s) => s.name === 'Figma'));
  assert.ok(out.profile.preferences.includes('Lead with grant writing for public-sector postings.'));
  assert.ok(out.profile.never_include.includes('Salary history'));
  assert.deepEqual(out.profile.open_questions, ['Other']);
  const why = out.skipped.map((s) => s.why).join('|');
  assert.match(why, /not a date/);
  assert.match(why, /already in the library/);
});

test('unknown roles, ids, and edits are skipped, never thrown or half-applied', () => {
  const out = applyPatch(profile, [
    { op: 'add_bullet', role_id: 'nope', text: 'x' },
    { op: 'update_bullet', id: 'nope', text: 'x' },
    { op: 'delete_everything' },
    { op: 'set_role_field', role_id: 'ds', field: 'status', value: 'verified' }
  ]);
  assert.equal(out.applied.length, 0);
  assert.equal(out.skipped.length, 4);
  assert.deepEqual(out.profile, profile);
});

test('add_role needs a valid start date and a unique id', () => {
  const ok = applyPatch(profile, [{ op: 'add_role', title: 'Volunteer', org: 'Desert Sun Foundation', start: '2010-01', end: '2010-06' }], '2010-01 to 2010-06');
  assert.equal(ok.profile.roles.at(-1).org, 'Desert Sun Foundation');
  assert.equal(applyPatch(profile, [{ op: 'add_role', title: 'x', org: 'y', start: 'soon' }]).applied.length, 0);
});

test('merged answers stop acting on their own but their questions stay answered', () => {
  const q = { kind: 'conflict', topic: 'docs-wording', text: 'Which wording?' };
  let k = applyAnswer(emptyKnowledge(), q, { action: 'choice', group: 'cvag-deliverables', bullet_id: 'cvag.docs', label: 'A' }, now);
  k = applyAnswer(k, { topic: 'ds-archive', role_id: 'ds', text: 'How big?' }, { action: 'fact', text: 'About 40,000 stories.' }, now);
  k = applyAnswer(k, { text: 'x' }, { action: 'note', text: 'Konsist ended October 2021.' }, now);
  const pending = pendingItems(k);
  assert.deepEqual(pending.map((p) => p.kind).sort(), ['choice', 'fact', 'note']);
  const req = buildLibrarianRequest(profile, pending);
  assert.match(req.user, /About 40,000 stories/);
  assert.equal(req.tools[0], LIBRARIAN_TOOL);
  assert.deepEqual(req.tool_choice, { type: 'auto' });

  const merged = markMerged(k, pending, now);
  assert.deepEqual(pendingItems(merged), []);
  const split = splitProfile(profile, { knowledge: merged }).usable;
  assert.ok(split.roles.find((r) => r.id === 'cvag').bullets.some((b) => b.id === 'cvag.docs2'), 'choice no longer enforced once the library holds it');
  assert.equal(split.general_facts.length, 0);
  assert.equal(filterQuestions([q], merged, groupLookup(profile)).length, 0, 'still never asked again');
});

test('descriptions are readable', () => {
  assert.match(describeOp({ op: 'add_bullet', role_id: 'ds', text: 'T.' }, profile), /^Add to The Desert Sun/);
  assert.match(describeOp({ op: 'set_role_field', role_id: 'gw', field: 'end', value: '' }, profile), /Present/);
});
