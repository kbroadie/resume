import { MODELS, buildRequest, validateResult, buildDoc, renderText, renderHtml, escapeHtml, groupLookup } from './lib.js?v=8';
import { emptyKnowledge, normalizeKnowledge, applyAnswer, removeEntry, filterQuestions, liveEntries, pendingItems, markMerged } from './knowledge.js?v=8';
import { syncKnowledge, updateLibrary, pullFile, PROFILE_PATH } from './sync.js?v=8';
import { buildLibrarianRequest, applyPatch, describeOp } from './library.js?v=8';

const API = 'https://api.anthropic.com/v1';
const KEY_STORE = 'resume-tailor-key';
const $ = (id) => document.getElementById(id);

let profile = null;
let lastText = '';
let knowledge = emptyKnowledge();
let groupOf = () => null;
let shownQuestions = [];
const KNOWLEDGE_STORE = 'resume-tailor-knowledge';
const TOKEN_STORE = 'resume-tailor-github-token';

const headers = (key) => ({
  'content-type': 'application/json',
  'x-api-key': key,
  'anthropic-version': '2023-06-01',
  // Required by Anthropic for calls made straight from a browser.
  'anthropic-dangerous-direct-browser-access': 'true'
});

const getKey = () => {
  try { return sessionStorage.getItem(KEY_STORE) || localStorage.getItem(KEY_STORE) || ''; } catch { return ''; }
};
const setKey = (key, remember) => {
  try {
    sessionStorage.setItem(KEY_STORE, key);
    if (remember) localStorage.setItem(KEY_STORE, key);
  } catch { /* storage blocked: the key lives only in memory for this page view */ memoryKey = key; }
};
let memoryKey = '';
const clearKey = () => {
  memoryKey = '';
  try { sessionStorage.removeItem(KEY_STORE); localStorage.removeItem(KEY_STORE); } catch { /* ignore */ }
};
const currentKey = () => getKey() || memoryKey;

async function checkKey(key) {
  // count_tokens is free and, unlike GET /v1/models, answers browser (CORS) requests.
  const res = await fetch(`${API}/messages/count_tokens`, {
    method: 'POST',
    headers: headers(key),
    body: JSON.stringify({ model: MODELS[0].id, messages: [{ role: 'user', content: 'hi' }] })
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const why = body.error?.message || 'no reason given';
    throw new Error(res.status === 401 || res.status === 403
      ? `Anthropic did not accept that key: ${why} (HTTP ${res.status}).`
      : `Could not verify the key: ${why} (HTTP ${res.status}).`);
  }
}

// Phones often add spaces, line breaks, invisible characters, or quotes when pasting.
export function cleanKey(raw) {
  return raw.replace(/[\s\u200B-\u200D\uFEFF]/g, '').replace(/^["'`]+|["'`]+$/g, '');
}

function show(signedIn) {
  $('login').hidden = signedIn;
  $('app').hidden = !signedIn;
  $('signout').hidden = !signedIn;
}

async function loadProfile() {
  profile = null;
  const token = readStore(TOKEN_STORE);
  if (token) {
    // GitHub Pages can lag a minute behind a merge, so read the latest straight from the repo.
    try { profile = (await pullFile(PROFILE_PATH, token)).data; } catch { profile = null; }
  }
  if (!profile) {
    const res = await fetch('data/profile.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('Could not load data/profile.json');
    profile = await res.json();
  }
  groupOf = groupLookup(profile);
  $('location').innerHTML = '<option value="" disabled>Choose a location</option>' +
    profile.contact.locations.map((l) => `<option value="${l.id}">${escapeHtml(l.label)}</option>`).join('');
  let saved = '';
  try { saved = localStorage.getItem('resume-tailor-location') || ''; } catch { /* ignore */ }
  $('location').value = profile.contact.locations.some((l) => l.id === saved) ? saved : '';
  $('open-questions').innerHTML = profile.open_questions.map((q) => `<li>${escapeHtml(q)}</li>`).join('');
}

const readStore = (name) => { try { return sessionStorage.getItem(name) || localStorage.getItem(name) || ''; } catch { return ''; } };

function loadLocalKnowledge() {
  try { return normalizeKnowledge(JSON.parse(localStorage.getItem(KNOWLEDGE_STORE) || 'null')); } catch { return emptyKnowledge(); }
}

function setSyncStatus(text) { $('sync-status').textContent = text; }

// Saves on this device, then to GitHub when a token is set.
async function persist() {
  try { localStorage.setItem(KNOWLEDGE_STORE, JSON.stringify(knowledge)); } catch { /* storage blocked */ }
  renderSaved();
  const token = readStore(TOKEN_STORE);
  if (!token) { setSyncStatus('Saved on this device only. Add a GitHub token below to sync across devices.'); return; }
  setSyncStatus('Saving to GitHub...');
  try {
    const out = await syncKnowledge(knowledge, token);
    knowledge = out.knowledge;
    try { localStorage.setItem(KNOWLEDGE_STORE, JSON.stringify(knowledge)); } catch { /* ignore */ }
    renderSaved();
    setSyncStatus(out.pushed ? 'Saved to GitHub.' : 'Up to date with GitHub.');
  } catch (err) {
    setSyncStatus(`${err.message} Kept on this device.`);
  }
}

// On load: merge what is on GitHub (readable without a token) into this device.
async function pullKnowledge() {
  knowledge = loadLocalKnowledge();
  try {
    const out = await syncKnowledge(knowledge, '');
    knowledge = out.knowledge;
    try { localStorage.setItem(KNOWLEDGE_STORE, JSON.stringify(knowledge)); } catch { /* ignore */ }
    setSyncStatus(readStore(TOKEN_STORE) ? 'Token set. Answers sync to GitHub.' : 'Saved on this device only. Add a GitHub token below to sync across devices.');
  } catch {
    setSyncStatus('Could not read saved answers from GitHub. Using this device only.');
  }
  renderSaved();
}

function describeEntry(collection, e) {
  if (collection === 'facts') return `Fact${e.role_id ? ` (${e.role_id})` : ''}: ${e.text}`;
  if (collection === 'preferences') return `Preference: ${e.text}`;
  if (collection === 'choices') return `Wording chosen: ${e.bullet_id}`;
  if (collection === 'notes') return `Note: ${e.text}`;
  return `Not asking again: ${e.topic || ''}`;
}

function renderSaved() {
  const rows = [];
  for (const collection of ['facts', 'preferences', 'choices', 'notes', 'dismissed']) {
    for (const [key, e] of liveEntries(knowledge, collection)) {
      const entry = collection === 'dismissed' ? { ...e, topic: key } : e;
      rows.push(`<li><span>${escapeHtml(describeEntry(collection, entry))}</span> <button type="button" class="link" data-collection="${collection}" data-key="${escapeHtml(key)}">Remove</button></li>`);
    }
  }
  $('saved').innerHTML = rows.join('') || '<li>Nothing saved yet. Answer a question and it will appear here.</li>';
  $('saved-count').textContent = rows.length ? `(${rows.length})` : '';
  renderPendingCounts();
}

function renderQuestions() {
  $('questions').innerHTML = shownQuestions.map((q, i) => {
    const options = q.kind === 'conflict' && q.options?.length
      ? `<div class="row">${q.options.map((o, j) => `<button type="button" data-act="choice" data-j="${j}">Use: ${escapeHtml(o.label)}</button>`).join('')}</div>`
      : `<textarea rows="3" aria-label="Your answer" placeholder="Your answer, in your own words"></textarea>
         <div class="row"><button type="button" data-act="fact">Save as a fact</button><button type="button" data-act="preference">Save as a preference</button></div>`;
    return `<li class="qcard" data-i="${i}"><span class="tag">${escapeHtml(q.kind)}</span><p>${escapeHtml(q.text)}</p>${options}
      <button type="button" class="link" data-act="dismiss">Don't ask again</button><p class="saved-msg" role="status"></p></li>`;
  }).join('') || '<li>No questions this time.</li>';
  $('qcount').textContent = shownQuestions.length ? `(${shownQuestions.length})` : '';
  $('retailor').hidden = !shownQuestions.length;
}

async function answerQuestion(event) {
  const btn = event.target.closest('button[data-act]');
  if (!btn) return;
  const card = btn.closest('.qcard');
  const q = shownQuestions[Number(card.dataset.i)];
  const act = btn.dataset.act;
  let answer;
  if (act === 'choice') {
    const o = q.options[Number(btn.dataset.j)];
    const group = groupOf(o.bullet_id);
    answer = group ? { action: 'choice', group, bullet_id: o.bullet_id, label: o.label } : { action: 'preference', text: `${q.text} Use: ${o.label}` };
  } else if (act === 'dismiss') {
    answer = { action: 'dismiss' };
  } else {
    const text = card.querySelector('textarea').value.trim();
    if (!text) { card.querySelector('.saved-msg').textContent = 'Type your answer first.'; return; }
    answer = { action: act, text };
  }
  knowledge = applyAnswer(knowledge, q, answer);
  for (const el of card.querySelectorAll('button, textarea')) el.disabled = true;
  card.querySelector('.saved-msg').textContent = 'Saved. It will not be asked again.';
  await persist();
}

// Library merge: Claude turns saved answers into edits, Kevin approves, then the profile is updated on GitHub.
let reviewing = null;

function renderPendingCounts() {
  const n = pendingItems(knowledge).length;
  $('pending-count').textContent = n ? `(${n} waiting)` : '';
  $('merge-banner').hidden = n === 0;
  $('merge-banner').textContent = `Merge ${n} saved answer${n === 1 ? '' : 's'} into my library`;
  $('merge').disabled = n === 0;
}

function refreshProfileViews() {
  groupOf = groupLookup(profile);
  $('open-questions').innerHTML = profile.open_questions.map((q) => `<li>${escapeHtml(q)}</li>`).join('') || '<li>Nothing waiting.</li>';
}

async function startMerge() {
  const pending = pendingItems(knowledge);
  const box = $('review');
  if (!pending.length) return;
  box.hidden = false;
  box.innerHTML = '<p role="status">Claude is drafting library changes...</p>';
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    const input = await askClaude(buildLibrarianRequest(profile, pending), 'propose_library_changes');
    const evidence = pending.map((p) => p.text || '').join('\n');
    const preview = applyPatch(profile, input.ops, evidence);
    reviewing = { pending, ops: input.ops, evidence, summary: input.summary, preview };
    const lines = preview.applied.map((a) => `<li>${escapeHtml(describeOp(a.op, profile))}</li>`).join('');
    const skipped = preview.skipped.map((x) => `<li class="skip">Skipped: ${escapeHtml(describeOp(x.op, profile))} (${escapeHtml(x.why)})</li>`).join('');
    const clarify = (input.clarify || []).map((c) => `<li class="skip">Needs your input: ${escapeHtml(c)}</li>`).join('');
    box.innerHTML = `<h3>Proposed library changes</h3><p>${escapeHtml(input.summary || '')}</p>
      <ul class="cards">${lines || '<li>No new entries. Everything is already in the library.</li>'}${skipped}${clarify}</ul>
      <div class="row"><button type="button" id="approve" class="primary">${preview.applied.length ? 'Approve and merge' : 'Mark as handled'}</button>
      <button type="button" id="cancel-merge">Cancel</button></div><p id="review-msg" class="hint" role="status"></p>`;
    $('approve').addEventListener('click', approveMerge);
    $('cancel-merge').addEventListener('click', () => { box.hidden = true; reviewing = null; });
  } catch (err) {
    box.innerHTML = `<p class="msg" role="alert">${escapeHtml(err.message)}</p>`;
  }
}

async function approveMerge() {
  const { pending, ops, evidence, preview } = reviewing;
  const msg = $('review-msg');
  $('approve').disabled = true;
  try {
    if (preview.applied.length) {
      const token = readStore(TOKEN_STORE);
      if (!token) {
        const text = preview.applied.map((a) => describeOp(a.op, profile)).join('\n');
        try { await navigator.clipboard.writeText(text); } catch { /* ignore */ }
        msg.textContent = 'No GitHub token, so nothing was saved. The changes were copied; paste them into the Claude Code chat, or add a token under Sync and try again.';
        $('approve').disabled = false;
        return;
      }
      msg.textContent = 'Saving to your library...';
      const done = await updateLibrary(token, (remote) => applyPatch(remote, ops, evidence), 'Merge answers into the library');
      profile = done.profile;
      refreshProfileViews();
    }
    knowledge = markMerged(knowledge, pending);
    await persist();
    $('review').innerHTML = `<p role="status">Merged. Your library is up to date, and those questions will not be asked again.</p>`;
    reviewing = null;
  } catch (err) {
    msg.textContent = err.message;
    $('approve').disabled = false;
  }
}

async function teach() {
  const text = $('teach').value.trim();
  if (!text) return;
  knowledge = applyAnswer(knowledge, { text }, { action: 'note', text });
  $('teach').value = '';
  await persist();
  await startMerge();
}

function setTab(name) {
  for (const [tab, panel] of [['t-resume', 'p-resume'], ['t-q', 'p-q'], ['t-checks', 'p-checks']]) {
    const on = tab === name;
    $(tab).setAttribute('aria-selected', String(on));
    $(panel).hidden = !on;
  }
}

function renderResult(result, issues, opts) {
  const doc = buildDoc(result, profile, { ...opts, knowledge });
  lastText = renderText(doc);
  $('resume').innerHTML = renderHtml(doc);

  shownQuestions = filterQuestions(result.questions, knowledge, groupOf);
  renderQuestions();
  $('fit').textContent = result.fit_notes || '';

  $('checks').innerHTML = issues.length
    ? issues.map((i) => `<li>${escapeHtml(i)}</li>`).join('')
    : '<li>No problems found. Every bullet cites verified profile entries and uses only numbers from them.</li>';
  $('ccount').textContent = issues.length ? `(${issues.length})` : '';

  $('out').hidden = false;
  setTab(issues.length ? 't-checks' : 't-resume');
  $('out').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Calls Claude with one tool and returns that tool's input. Newer models reject a forced tool call,
// so the model chooses to call it; if it replies in text instead, ask once more.
async function askClaude({ system, tools, tool_choice, user }, toolName) {
  const messages = [{ role: 'user', content: user }];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const res = await fetch(`${API}/messages`, {
      method: 'POST',
      headers: headers(currentKey()),
      body: JSON.stringify({ model: $('model').value, max_tokens: 8000, system, tools, tool_choice, messages })
    });
    if (res.status === 401) { clearKey(); show(false); throw new Error('Your key was rejected. Sign in again.'); }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error?.message || `Request failed (HTTP ${res.status}).`);
    }
    const data = await res.json();
    const block = (data.content || []).find((b) => b.type === 'tool_use' && b.name === toolName);
    if (block) return block.input;
    if (data.stop_reason === 'max_tokens') throw new Error('The response was cut off. Try again, or trim the posting.');
    messages.push({ role: 'assistant', content: data.content || [{ type: 'text', text: '(no content)' }] });
    messages.push({ role: 'user', content: `Call ${toolName} now.` });
  }
  throw new Error('The model did not respond with the expected result. Try again.');
}

async function generate(event) {
  event.preventDefault();
  const msg = $('gen-msg');
  const btn = $('go');
  const opts = { includePersonalLine: $('personal').checked, locationId: $('location').value, shortTitles: $('shorttitles').checked };
  try { localStorage.setItem('resume-tailor-location', opts.locationId); } catch { /* ignore */ }
  const req = buildRequest(profile, { posting: $('posting').value, notes: $('notes').value, knowledge, ...opts });
  btn.disabled = true;
  msg.textContent = 'Tailoring. This takes up to a minute.';
  try {
    const input = await askClaude(req, 'submit_resume');
    renderResult(input, validateResult(input, profile, { ...opts, knowledge }), opts);
    msg.textContent = '';
  } catch (err) {
    msg.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

async function copyText() {
  try {
    await navigator.clipboard.writeText(lastText);
    $('gen-msg').textContent = 'Copied.';
  } catch {
    $('gen-msg').textContent = 'Copy was blocked. Use Download instead.';
  }
}

function download() {
  const url = URL.createObjectURL(new Blob([lastText], { type: 'text/plain;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: 'Kevin-Broadie-Resume.txt' });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function init() {
  $('model').innerHTML = MODELS.map((m) => `<option value="${m.id}">${escapeHtml(m.label)}</option>`).join('');
  try { await loadProfile(); } catch (err) { $('login-msg').textContent = err.message; }
  if (profile) refreshProfileViews();
  await pullKnowledge();
  $('questions').addEventListener('click', answerQuestion);
  $('retailor').addEventListener('click', () => $('gen').requestSubmit());
  $('merge').addEventListener('click', startMerge);
  $('merge-banner').addEventListener('click', startMerge);
  $('teach-go').addEventListener('click', teach);
  $('saved').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-collection]');
    if (!b) return;
    knowledge = removeEntry(knowledge, b.dataset.collection, b.dataset.key);
    await persist();
  });
  $('token-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const token = $('token').value.replace(/\s/g, '');
    try {
      sessionStorage.setItem(TOKEN_STORE, token);
      if ($('token-remember').checked) localStorage.setItem(TOKEN_STORE, token);
    } catch { /* storage blocked */ }
    $('token').value = '';
    await persist();
  });
  $('token-clear').addEventListener('click', () => {
    try { sessionStorage.removeItem(TOKEN_STORE); localStorage.removeItem(TOKEN_STORE); } catch { /* ignore */ }
    setSyncStatus('Token removed. Answers stay on this device only.');
  });

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const key = cleanKey($('key').value);
    const msg = $('login-msg');
    if (!key.startsWith('sk-ant-')) {
      msg.textContent = `That does not look like an Anthropic API key. Keys start with "sk-ant-" (yours starts with "${key.slice(0, 7)}", ${key.length} characters). Copy the full key from the Anthropic Console; it is shown only once when created.`;
      return;
    }
    msg.textContent = 'Checking...';
    try {
      await checkKey(key);
      setKey(key, $('remember').checked);
      $('key').value = '';
      msg.textContent = '';
      show(true);
    } catch (err) {
      msg.textContent = err instanceof TypeError
        ? 'Could not reach Anthropic. Check your connection, VPN, or content blocker, then try again.'
        : err.message;
    }
  });
  $('showkey').addEventListener('click', () => {
    const show = $('key').type === 'password';
    $('key').type = show ? 'text' : 'password';
    $('showkey').textContent = show ? 'Hide key' : 'Show key';
  });
  $('signout').addEventListener('click', () => { clearKey(); show(false); $('out').hidden = true; });
  $('gen').addEventListener('submit', generate);
  $('copy').addEventListener('click', copyText);
  $('download').addEventListener('click', download);
  $('print').addEventListener('click', () => window.print());
  for (const t of ['t-resume', 't-q', 't-checks']) $(t).addEventListener('click', () => setTab(t));

  show(Boolean(currentKey()));
}

init();
