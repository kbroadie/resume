// Everything Kevin has told the app: answers, chosen wordings, new facts, and preferences.
// Pure functions, no DOM or network, so the browser app and the tests share them.
//
// Every entry carries an `at` timestamp. Removing an entry marks it `removed: true` instead of deleting it,
// so a removal made on one device is not undone when another device syncs.

const COLLECTIONS = ['answered', 'choices', 'facts', 'preferences', 'dismissed', 'notes'];
// Entries that, once merged into the master library, stop acting on their own.
const PENDING = ['choices', 'facts', 'preferences', 'notes'];

export const emptyKnowledge = () => ({ version: 1, answered: {}, choices: {}, facts: {}, preferences: {}, dismissed: {}, notes: {} });

export function normalizeKnowledge(raw) {
  const k = emptyKnowledge();
  if (!raw || typeof raw !== 'object') return k;
  for (const name of COLLECTIONS) {
    if (raw[name] && typeof raw[name] === 'object' && !Array.isArray(raw[name])) k[name] = { ...raw[name] };
  }
  return k;
}

export const slug = (text) =>
  String(text || 'question').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'question';

const live = (entries) => Object.entries(entries).filter(([, v]) => v && !v.removed);
const active = (entries) => live(entries).filter(([, v]) => !v.merged);

// Applies one of Kevin's answers and returns a new knowledge object.
// question: { topic, kind, text, role_id? }
// answer: { action: 'choice', group, bullet_id, label } | { action: 'fact', text } | { action: 'preference', text } | { action: 'dismiss' }
export function applyAnswer(knowledge, question, answer, now = new Date()) {
  const k = normalizeKnowledge(structuredClone(knowledge));
  const at = now.toISOString();
  const topic = slug(question.topic || question.text);
  const stamp = now.getTime().toString(36);

  if (answer.action === 'choice') {
    k.choices[answer.group] = { bullet_id: answer.bullet_id, topic, at };
    k.answered[topic] = { question: question.text, answer: `Use: ${answer.label || answer.bullet_id}`, at };
  } else if (answer.action === 'fact') {
    const id = `k.${topic}.${stamp}`;
    k.facts[id] = { id, topic, role_id: question.role_id || null, text: answer.text.trim(), at };
    k.answered[topic] = { question: question.text, answer: answer.text.trim(), at };
  } else if (answer.action === 'preference') {
    const id = `p.${topic}.${stamp}`;
    k.preferences[id] = { id, topic, text: answer.text.trim(), at };
    k.answered[topic] = { question: question.text, answer: answer.text.trim(), at };
  } else if (answer.action === 'note') {
    const id = `n.${stamp}`;
    k.notes[id] = { id, text: answer.text.trim(), at };
  } else if (answer.action === 'dismiss') {
    k.dismissed[topic] = { at };
  } else {
    throw new Error(`Unknown answer action "${answer.action}"`);
  }
  return k;
}

// Marks one entry removed. collection is one of the COLLECTIONS names.
export function removeEntry(knowledge, collection, key, now = new Date()) {
  const k = normalizeKnowledge(structuredClone(knowledge));
  const at = now.toISOString();
  const entry = k[collection]?.[key];
  if (entry) {
    k[collection][key] = { ...entry, removed: true, at };
    // Removing what an answer produced also frees its question to be asked again.
    if (entry.topic && k.answered[entry.topic]) k.answered[entry.topic] = { ...k.answered[entry.topic], removed: true, at };
  }
  return k;
}

// Union of two knowledge objects; for a key present in both, the later `at` wins.
export function mergeKnowledge(a, b) {
  const x = normalizeKnowledge(a);
  const y = normalizeKnowledge(b);
  const out = emptyKnowledge();
  for (const name of COLLECTIONS) {
    for (const key of new Set([...Object.keys(x[name]), ...Object.keys(y[name])])) {
      const left = x[name][key];
      const right = y[name][key];
      out[name][key] = !left ? right : !right ? left : (left.at || '') >= (right.at || '') ? left : right;
    }
  }
  return out;
}

// Drops questions Kevin already settled: the topic was answered or dismissed, or it is a conflict
// whose group already has a chosen wording.
export function filterQuestions(questions, knowledge, groupOf = () => null) {
  const k = normalizeKnowledge(knowledge);
  const done = new Set([...live(k.answered), ...live(k.dismissed)].map(([topic]) => topic));
  const chosen = new Set(live(k.choices).map(([group]) => group));
  return (questions || []).filter((q) => {
    if (done.has(slug(q.topic || q.text))) return false;
    if (q.kind === 'conflict' && (q.options || []).some((o) => chosen.has(groupOf(o.bullet_id)))) return false;
    return true;
  });
}

// Chosen wording per bullet group: { group: bullet_id }.
export const chosenWordings = (knowledge) =>
  Object.fromEntries(active(normalizeKnowledge(knowledge).choices).map(([group, v]) => [group, v.bullet_id]));

// Facts Kevin supplied, as profile-style bullets. Facts tied to a role attach to it; the rest are general.
export function learnedFacts(knowledge, roleIds) {
  const byRole = {};
  const general = [];
  for (const [, f] of active(normalizeKnowledge(knowledge).facts)) {
    const bullet = { id: f.id, status: 'verified', tags: ['learned'], text: f.text };
    if (f.role_id && roleIds.has(f.role_id)) (byRole[f.role_id] ||= []).push(bullet);
    else general.push(bullet);
  }
  return { byRole, general };
}

// What the model is told about earlier answers, so it never asks them again.
export function knowledgeForPrompt(knowledge) {
  const k = normalizeKnowledge(knowledge);
  return {
    answered: live(k.answered).map(([topic, v]) => ({ topic, question: v.question, answer: v.answer })),
    dismissed_topics: live(k.dismissed).map(([topic]) => topic),
    preferences: [...active(k.preferences), ...active(k.notes)].map(([, v]) => v.text)
  };
}

export const hasEntries = (knowledge) => COLLECTIONS.some((n) => live(normalizeKnowledge(knowledge)[n]).length > 0);
export const liveEntries = (knowledge, collection) => active(normalizeKnowledge(knowledge)[collection]);

// Answers waiting to be merged into the master library.
export function pendingItems(knowledge) {
  const k = normalizeKnowledge(knowledge);
  const items = [];
  for (const collection of PENDING) {
    for (const [key, v] of active(k[collection])) {
      const base = { ref: `${collection}:${key}`, collection, key };
      if (collection === 'choices') {
        items.push({ ...base, kind: 'choice', group: key, keep_id: v.bullet_id, question: k.answered[v.topic]?.question || '' });
      } else {
        items.push({ ...base, kind: collection === 'facts' ? 'fact' : collection === 'preferences' ? 'preference' : 'note', role_id: v.role_id || null, text: v.text, question: k.answered[v.topic]?.question || '' });
      }
    }
  }
  return items;
}

// Marks items as merged into the library. They stop acting on their own and drop out of the pending list,
// but the answered topics stay, so the questions are still never asked again.
export function markMerged(knowledge, items, now = new Date()) {
  const k = normalizeKnowledge(structuredClone(knowledge));
  const at = now.toISOString();
  for (const { collection, key } of items) if (k[collection]?.[key]) k[collection][key] = { ...k[collection][key], merged: true, at };
  return k;
}

// How many answers and notes Kevin saved after `since` (an ISO time), such as when a draft was written.
export function answersSince(knowledge, since) {
  const k = normalizeKnowledge(knowledge);
  const later = ([, v]) => (v.at || '') > (since || '');
  return live(k.answered).filter(later).length + live(k.notes).filter(later).length;
}
