import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { emptyKnowledge, applyAnswer, removeEntry, mergeKnowledge, filterQuestions, learnedFacts, knowledgeForPrompt, answersSince, slug } from '../knowledge.js';
import { splitProfile, buildRequest, validateResult, buildDoc, groupLookup } from '../lib.js';
import { encodeContent, decodeContent, syncKnowledge } from '../sync.js';

const profile = JSON.parse(readFileSync(new URL('../data/profile.json', import.meta.url)));
const now = new Date('2026-10-29T12:00:00Z');
const later = new Date('2026-10-30T12:00:00Z');
const groupOf = groupLookup(profile);

test('a chosen wording removes its alternates and stops the conflict question', () => {
  const q = { kind: 'conflict', topic: 'deliverables-wording', text: 'Which wording?', options: [{ label: 'A', bullet_id: 'cvag.docs' }, { label: 'B', bullet_id: 'cvag.docs2' }] };
  const k = applyAnswer(emptyKnowledge(), q, { action: 'choice', group: 'cvag-deliverables', bullet_id: 'cvag.docs', label: 'A' }, now);
  const cvag = splitProfile(profile, { knowledge: k }).usable.roles.find((r) => r.id === 'cvag');
  assert.ok(cvag.bullets.some((b) => b.id === 'cvag.docs') && !cvag.bullets.some((b) => b.id === 'cvag.docs2'));
  assert.deepEqual(filterQuestions([q], k, groupOf), []);
  // without the answer both wordings are offered
  assert.ok(splitProfile(profile).usable.roles.find((r) => r.id === 'cvag').bullets.some((b) => b.id === 'cvag.docs2'));
});

test('answered and dismissed topics are never asked again', () => {
  let k = applyAnswer(emptyKnowledge(), { topic: 'Desert Sun webmaster detail', text: 'q' }, { action: 'preference', text: 'Always lead with grants.' }, now);
  k = applyAnswer(k, { topic: 'mesa', text: 'q' }, { action: 'dismiss' }, now);
  const asked = [{ kind: 'clarify', topic: 'desert-sun-webmaster-detail', text: 'a' }, { kind: 'gap', topic: 'mesa', text: 'b' }, { kind: 'gap', topic: 'new-thing', text: 'c' }];
  assert.deepEqual(filterQuestions(asked, k, groupOf).map((q) => q.topic), ['new-thing']);
  const p = knowledgeForPrompt(k);
  assert.deepEqual(p.preferences, ['Always lead with grants.']);
  assert.deepEqual(p.dismissed_topics, ['mesa']);
  assert.equal(p.answered[0].topic, 'desert-sun-webmaster-detail');
});

test('a learned fact becomes a citable bullet on its role and passes validation', () => {
  const k = applyAnswer(emptyKnowledge(), { topic: 'ds-metrics', role_id: 'ds', text: 'q' }, { action: 'fact', text: 'Trained 12 coworkers on the new CMS.' }, now);
  const id = Object.keys(k.facts)[0];
  const ds = splitProfile(profile, { knowledge: k }).usable.roles.find((r) => r.id === 'ds');
  assert.ok(ds.bullets.some((b) => b.id === id && b.tags.includes('learned')));
  const result = {
    summary: { text: 'Designer.', source_ids: ['ds'] }, skills: [], education_ids: [], certification_ids: [],
    experience: [{ role_id: 'ds', bullets: [{ text: 'Trained 12 coworkers on the new CMS.', source_ids: [id] }] }]
  };
  assert.deepEqual(validateResult(result, profile, { knowledge: k, now }), []);
  assert.match(validateResult(result, profile, { now }).join(), /unknown or held-back source/);
  assert.ok(buildDoc(result, profile, { knowledge: k }).experience.some((e) => e.bullets[0]?.startsWith('Trained 12')));
});

test('facts without a role are general facts the model can cite', () => {
  const k = applyAnswer(emptyKnowledge(), { topic: 'volunteer', text: 'q' }, { action: 'fact', text: 'Volunteers weekly with 5 youth groups.' }, now);
  const general = splitProfile(profile, { knowledge: k }).usable.general_facts;
  assert.equal(general.length, 1);
  const result = { summary: { text: 'Volunteers weekly with 5 youth groups.', source_ids: [general[0].id] }, skills: [], experience: [], education_ids: [], certification_ids: [] };
  assert.deepEqual(validateResult(result, profile, { knowledge: k, now }), []);
  assert.match(buildRequest(profile, { posting: 'x', knowledge: k, now }).user, /general_facts/);
});

test('removing an answer frees its question; merges keep the newest entry and removals', () => {
  let k = applyAnswer(emptyKnowledge(), { topic: 'topic-a', text: 'q' }, { action: 'preference', text: 'Old.' }, now);
  const id = Object.keys(k.preferences)[0];
  const other = removeEntry(k, 'preferences', id, later);
  assert.equal(filterQuestions([{ kind: 'gap', topic: 'topic-a', text: 'q' }], other, groupOf).length, 1);
  const merged = mergeKnowledge(k, other);
  assert.equal(merged.preferences[id].removed, true);
  assert.deepEqual(knowledgeForPrompt(merged).preferences, []);
  assert.deepEqual(mergeKnowledge(merged, k), merged);
});

test('slug keeps topics stable', () => {
  assert.equal(slug('Desert Sun: Webmaster detail!'), 'desert-sun-webmaster-detail');
});

test('GitHub content round-trips non-ASCII text', () => {
  const k = applyAnswer(emptyKnowledge(), { topic: 't', text: 'q' }, { action: 'fact', text: 'Café “Mado” – 5 clients ✓' }, now);
  assert.deepEqual(decodeContent(encodeContent(k)), k);
});

function fakeGitHub(initial) {
  const store = { knowledge: initial, sha: initial ? 'sha1' : null, puts: [] };
  const fetchImpl = async (url, opts = {}) => {
    if (!opts.method) {
      if (!store.knowledge) return { status: 404, ok: false };
      return { status: 200, ok: true, json: async () => ({ content: encodeContent(store.knowledge), sha: store.sha }) };
    }
    const body = JSON.parse(opts.body);
    if (store.sha && body.sha !== store.sha) return { status: 409, ok: false };
    store.knowledge = decodeContent(body.content);
    store.sha = `sha${store.puts.length + 2}`;
    store.puts.push(body);
    return { status: 200, ok: true, json: async () => ({}) };
  };
  return { store, fetchImpl };
}

test('sync merges with GitHub and writes only when something changed', async () => {
  const remote = applyAnswer(emptyKnowledge(), { topic: 'from-phone', text: 'q' }, { action: 'dismiss' }, now);
  const gh = fakeGitHub(remote);
  const local = applyAnswer(emptyKnowledge(), { topic: 'from-laptop', text: 'q' }, { action: 'dismiss' }, later);
  const out = await syncKnowledge(local, 'tok', gh.fetchImpl);
  assert.equal(out.pushed, true);
  assert.deepEqual(Object.keys(gh.store.knowledge.dismissed).sort(), ['from-laptop', 'from-phone']);
  const again = await syncKnowledge(out.knowledge, 'tok', gh.fetchImpl);
  assert.equal(again.pushed, false);
  assert.equal(gh.store.puts.length, 1);
});

test('sync without a token reads but never writes, and creates the file if missing', async () => {
  const gh = fakeGitHub(null);
  const local = applyAnswer(emptyKnowledge(), { topic: 'x', text: 'q' }, { action: 'dismiss' }, now);
  assert.equal((await syncKnowledge(local, '', gh.fetchImpl)).pushed, false);
  assert.equal((await syncKnowledge(local, 'tok', gh.fetchImpl)).pushed, true);
  assert.equal(gh.store.puts[0].sha, undefined);
});

test('sync retries once after a conflicting save', async () => {
  const gh = fakeGitHub(emptyKnowledge());
  let first = true;
  const racing = async (url, opts = {}) => {
    if (opts.method && first) { first = false; gh.store.sha = 'moved'; }
    return gh.fetchImpl(url, opts);
  };
  const local = applyAnswer(emptyKnowledge(), { topic: 'y', text: 'q' }, { action: 'dismiss' }, now);
  assert.equal((await syncKnowledge(local, 'tok', racing)).pushed, true);
});

test('bad token gives a clear message', async () => {
  const fetchImpl = async (url, opts = {}) => (opts.method ? { status: 403, ok: false } : { status: 200, ok: true, json: async () => ({ content: encodeContent(emptyKnowledge()), sha: 's' }) });
  const local = applyAnswer(emptyKnowledge(), { topic: 'z', text: 'q' }, { action: 'dismiss' }, now);
  await assert.rejects(syncKnowledge(local, 'bad', fetchImpl), /did not accept the token/);
});

test('answersSince counts answers and notes saved after a draft, and skips removed ones', () => {
  const since = '2026-01-01T00:00:00.000Z';
  let k = applyAnswer(emptyKnowledge(), { topic: 'a', text: 'A?' }, { action: 'fact', text: 'One.' }, new Date('2025-12-31T00:00:00Z'));
  k = applyAnswer(k, { topic: 'b', text: 'B?' }, { action: 'preference', text: 'Two.' }, new Date('2026-01-02T00:00:00Z'));
  k = applyAnswer(k, { text: 'C' }, { action: 'note', text: 'Three.' }, new Date('2026-01-03T00:00:00Z'));
  assert.equal(answersSince(k, since), 2);
  const pref = Object.keys(k.preferences)[0];
  assert.equal(answersSince(removeEntry(k, 'preferences', pref, new Date('2026-01-04T00:00:00Z')), since), 1);
  assert.equal(answersSince(emptyKnowledge(), since), 0);
});
