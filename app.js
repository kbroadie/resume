import {
  MODELS, buildRequest, validateResult, buildDoc, renderText, renderHtml, escapeHtml, groupLookup,
  sectionTexts, normalizeUrl, keywordCoverage, resumeStats, resumeFilename, buildFetchRequest, readFetchedPosting
} from './lib.js?v=13';
import {
  emptyKnowledge, normalizeKnowledge, applyAnswer, removeEntry, filterQuestions, liveEntries, pendingItems, markMerged
} from './knowledge.js?v=13';
import { syncKnowledge, updateLibrary, pullFile, PROFILE_PATH } from './sync.js?v=13';
import { buildLibrarianRequest, applyPatch, describeOp } from './library.js?v=13';
import { STATUSES, addEntry, updateEntry, removeEntry as removeHistory, label as historyLabel } from './history.js?v=13';

const API = 'https://api.anthropic.com/v1';
// Storage names from earlier versions are kept so existing sign-ins and saved answers keep working.
const KEY_STORE = 'resume-tailor-key';
const KNOWLEDGE_STORE = 'resume-tailor-knowledge';
const TOKEN_STORE = 'resume-tailor-github-token';
const LOCATION_STORE = 'resume-tailor-location';
const HISTORY_STORE = 'resume-advisor-history';
const DRAFT_STORE = 'resume-advisor-draft';
const THEME_STORE = 'resume-advisor-theme';

const $ = (id) => document.getElementById(id);
const esc = escapeHtml;

/* ---------- storage ---------- */

const store = {
  get(name) { try { return localStorage.getItem(name) || ''; } catch { return ''; } },
  set(name, value) { try { localStorage.setItem(name, value); } catch { /* storage blocked */ } },
  del(name) { try { localStorage.removeItem(name); } catch { /* ignore */ } },
  json(name, fallback) { try { return JSON.parse(localStorage.getItem(name) || 'null') ?? fallback; } catch { return fallback; } }
};
const readSecret = (name) => { try { return sessionStorage.getItem(name) || localStorage.getItem(name) || ''; } catch { return ''; } };
let memoryKey = '';

/* ---------- state ---------- */

let profile = null;
let knowledge = emptyKnowledge();
let groupOf = () => null;
let current = null;          // the resume on screen
let history = [];
let questions = [];
let qState = [];             // 'open' | 'saved' | 'skipped' | 'dismissed' per question
let qIndex = 0;
let editing = false;
let reviewing = null;

/* ---------- small helpers ---------- */

let toastTimer = 0;
function toast(message, action) {
  const el = $('toast');
  el.replaceChildren(Object.assign(document.createElement('span'), { textContent: message }));
  if (action) {
    const b = Object.assign(document.createElement('button'), { type: 'button', textContent: action.label });
    b.addEventListener('click', () => { el.hidden = true; action.run(); });
    el.append(b);
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, action ? 7000 : 2400);
}

const showDialog = (id) => { const d = $(id); if (!d.open) d.showModal(); };
const wordCount = (s) => (String(s).match(/\S+/g) || []).length;
const shortDate = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function setBusy(button, busy, text) {
  button.disabled = busy;
  if (busy) { button.dataset.label = button.textContent; button.textContent = text; button.setAttribute('aria-busy', 'true'); }
  else { button.textContent = button.dataset.label || button.textContent; button.removeAttribute('aria-busy'); }
}

/* ---------- theme ---------- */

const THEME_ICONS = {
  auto: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/></svg>',
  light: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  dark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>'
};
const THEME_NAMES = { auto: 'Automatic', light: 'Light', dark: 'Dark' };
const themeMode = () => { const t = document.documentElement.dataset.theme; return t === 'light' || t === 'dark' ? t : 'auto'; };

function applyTheme(mode) {
  if (mode === 'auto') { delete document.documentElement.dataset.theme; store.del(THEME_STORE); }
  else { document.documentElement.dataset.theme = mode; store.set(THEME_STORE, mode); }
  $('theme').innerHTML = THEME_ICONS[mode];
  $('theme').setAttribute('aria-label', `Theme: ${THEME_NAMES[mode].toLowerCase()}. Tap to change.`);
  requestAnimationFrame(() => $('theme-color').setAttribute('content', getComputedStyle(document.body).backgroundColor));
}

function cycleTheme() {
  const order = ['auto', 'light', 'dark'];
  const next = order[(order.indexOf(themeMode()) + 1) % order.length];
  applyTheme(next);
  toast(`Theme: ${THEME_NAMES[next]}`);
}

/* ---------- navigation ---------- */

function showView(name) {
  for (const v of document.querySelectorAll('.view')) v.hidden = v.dataset.view !== name;
  for (const t of document.querySelectorAll('.tabbar button')) {
    if (t.dataset.view === name) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
  }
  $('main').scrollTop = 0;
  $('toast').hidden = true;
}

function show(signedIn) {
  $('login').hidden = signedIn;
  $('app').hidden = !signedIn;
  $('tabbar').hidden = !signedIn;
  $('open-settings').hidden = !signedIn;
  if (signedIn) showView(document.querySelector('.view:not([hidden])')?.dataset.view || 'tailor');
}

/* ---------- API key ---------- */

const getKey = () => readSecret(KEY_STORE) || memoryKey;
function setKey(key, remember) {
  try {
    sessionStorage.setItem(KEY_STORE, key);
    if (remember) localStorage.setItem(KEY_STORE, key);
  } catch { memoryKey = key; }
}
function clearKey() {
  memoryKey = '';
  try { sessionStorage.removeItem(KEY_STORE); localStorage.removeItem(KEY_STORE); } catch { /* ignore */ }
}

const headers = (key) => ({
  'content-type': 'application/json',
  'x-api-key': key,
  'anthropic-version': '2023-06-01',
  // Required by Anthropic for calls made straight from a browser.
  'anthropic-dangerous-direct-browser-access': 'true'
});

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
  return raw.replace(/[\s​-‍﻿]/g, '').replace(/^["'`]+|["'`]+$/g, '');
}

// Calls Claude with one tool and returns that tool's input. Newer models reject a forced tool call,
// so the model chooses to call it; if it replies in text instead, ask once more.
async function askClaude({ system, tools, tool_choice, user }, toolName) {
  const messages = [{ role: 'user', content: user }];
  let nudges = 0;
  for (let turn = 0; turn < 6; turn += 1) {
    const res = await fetch(`${API}/messages`, {
      method: 'POST',
      headers: headers(getKey()),
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
    // A server tool (web fetch) may pause a long turn; resume it by sending the turn back as it was.
    if (data.stop_reason === 'pause_turn') continue;
    if (nudges++ >= 1) break;
    messages.push({ role: 'user', content: `Call ${toolName} now.` });
  }
  throw new Error('The model did not respond with the expected result. Try again.');
}

/* ---------- profile and knowledge ---------- */

async function loadProfile() {
  profile = null;
  const token = readSecret(TOKEN_STORE);
  if (token) {
    // GitHub Pages can lag a minute behind a merge, so read the latest straight from the repo.
    try { profile = (await pullFile(PROFILE_PATH, token)).data; } catch { profile = null; }
  }
  if (!profile) {
    const res = await fetch('data/profile.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('Could not load data/profile.json');
    profile = await res.json();
  }
  refreshProfileViews();
}

function refreshProfileViews() {
  groupOf = groupLookup(profile);
  const chosen = $('location').value || store.get(LOCATION_STORE);
  $('location').innerHTML = '<option value="" disabled>Choose</option>' +
    profile.contact.locations.map((l) => `<option value="${l.id}">${esc(l.label)}</option>`).join('');
  $('location').value = profile.contact.locations.some((l) => l.id === chosen) ? chosen : '';
  const open = profile.open_questions || [];
  $('open-questions').innerHTML = open.map((q) => `<li>${esc(q)}</li>`).join('') || '<li>Nothing waiting.</li>';
  $('oq-count').textContent = open.length ? String(open.length) : '';
}

const saveLocalKnowledge = () => store.set(KNOWLEDGE_STORE, JSON.stringify(knowledge));
const setSyncStatus = (text) => { $('sync-status').textContent = text; };

// Saves on this device, then to GitHub when a token is set.
async function persist() {
  saveLocalKnowledge();
  renderSaved();
  const token = readSecret(TOKEN_STORE);
  if (!token) { setSyncStatus('Saved on this device only. Add a GitHub token to sync across devices.'); return; }
  setSyncStatus('Saving to GitHub...');
  try {
    const out = await syncKnowledge(knowledge, token);
    knowledge = out.knowledge;
    saveLocalKnowledge();
    renderSaved();
    setSyncStatus(out.pushed ? 'Saved to GitHub.' : 'Up to date with GitHub.');
  } catch (err) {
    setSyncStatus(`${err.message} Kept on this device.`);
  }
}

// On load: merge what is on GitHub (readable without a token) into this device.
async function pullKnowledge() {
  knowledge = normalizeKnowledge(store.json(KNOWLEDGE_STORE, null));
  try {
    const out = await syncKnowledge(knowledge, '');
    knowledge = out.knowledge;
    saveLocalKnowledge();
    setSyncStatus(readSecret(TOKEN_STORE) ? 'Token set. Answers sync to GitHub.' : 'Saved on this device only. Add a GitHub token to sync across devices.');
  } catch {
    setSyncStatus('Could not read saved answers from GitHub. Using this device only.');
  }
  renderSaved();
}

function describeEntry(collection, key, e) {
  if (collection === 'facts') return `Fact${e.role_id ? ` (${e.role_id})` : ''}: ${e.text}`;
  if (collection === 'preferences') return `Preference: ${e.text}`;
  if (collection === 'choices') return `Wording chosen: ${e.bullet_id}`;
  if (collection === 'notes') return `Note: ${e.text}`;
  return `Not asking again: ${key}`;
}

function renderSaved() {
  const rows = [];
  for (const collection of ['facts', 'preferences', 'choices', 'notes', 'dismissed']) {
    for (const [key, e] of liveEntries(knowledge, collection)) {
      rows.push(`<li>${esc(describeEntry(collection, key, e))} <button type="button" class="link" data-collection="${collection}" data-key="${esc(key)}">Remove</button></li>`);
    }
  }
  $('saved').innerHTML = rows.join('') || '<li>Nothing saved yet. Answer a question and it will appear here.</li>';
  $('saved-count').textContent = rows.length ? String(rows.length) : '';
  renderBadges();
}

function renderBadges() {
  const pending = pendingItems(knowledge).length;
  $('merge-card').hidden = pending === 0;
  $('merge-title').textContent = `${pending} saved answer${pending === 1 ? '' : 's'} ready to merge`;
  const lib = $('badge-l');
  lib.hidden = pending === 0;
  lib.textContent = String(pending);
  const open = qState.filter((s) => s === 'open' || s === 'skipped').length;
  const qb = $('badge-q');
  qb.hidden = open === 0;
  qb.textContent = String(open);
}

/* ---------- draft (so a reload never loses the posting) ---------- */

function saveDraft() {
  store.set(DRAFT_STORE, JSON.stringify({
    posting: $('posting').value, applink: $('applink').value, notes: $('notes').value,
    shorttitles: $('shorttitles').checked, personal: $('personal').checked
  }));
}

function restoreDraft() {
  const d = store.json(DRAFT_STORE, null);
  if (d) {
    $('posting').value = d.posting || '';
    $('applink').value = d.applink || '';
    $('notes').value = d.notes || '';
    $('shorttitles').checked = Boolean(d.shorttitles);
    $('personal').checked = d.personal !== false;
    if (d.notes) setNotesOpen(true);
  }
  updatePostingCount();
}

const POSTING_PLACEHOLDER = 'Paste the full posting: title, duties, requirements.';
const POSTING_PLACEHOLDER_LINK = 'Optional. Leave this empty and Claude will read the posting from your application link.';

// With a valid link the pasted posting becomes optional, and the box says so.
function updatePostingCount() {
  const n = wordCount($('posting').value);
  const linkOk = Boolean(normalizeUrl($('applink').value));
  $('posting-count').textContent = n ? `${n} words` : linkOk ? 'Optional with a link' : '';
  $('posting').placeholder = linkOk ? POSTING_PLACEHOLDER_LINK : POSTING_PLACEHOLDER;
  $('fetch').hidden = !linkOk;
}

function setNotesOpen(open) {
  $('notes-field').hidden = !open;
  $('toggle-notes').setAttribute('aria-expanded', String(open));
  $('toggle-notes').textContent = open ? '- Instructions' : '+ Instructions';
}

/* ---------- reading a posting from its link ---------- */

async function readPostingFromLink(link) {
  const model = $('model').value;
  let input;
  try {
    input = await askClaude(buildFetchRequest(link, model), 'report_posting');
  } catch (err) {
    // If this model rejects the newer web fetch variant, try the basic one once.
    if (!/web_fetch|tool/i.test(err.message)) throw err;
    input = await askClaude(buildFetchRequest(link, model, { basic: true }), 'report_posting');
  }
  return readFetchedPosting(input);
}

const sentence = (s) => (/[.!?]$/.test(s) ? s : `${s}.`);
const fetchHint = (message) => (/web.?fetch|not enabled|permission/i.test(message)
  ? `${sentence(message)} Reading links needs web fetch to be allowed for your Anthropic organization. Paste the posting text instead.`
  : `${sentence(message)} Paste the posting text instead.`);

// Fills the posting box from the link. Returns true when the posting text is now in the box.
async function fillPostingFromLink(link, msg) {
  msg.textContent = 'Reading the posting from your link...';
  try {
    const got = await readPostingFromLink(link);
    if (!got.ok) { msg.textContent = fetchHint(`Could not read that page: ${got.problem}`); $('posting').focus(); return false; }
    $('posting').value = got.text;
    updatePostingCount();
    saveDraft();
    toast(`Read the posting${got.title ? `: ${got.title}` : ''}. Review it below.`);
    return true;
  } catch (err) {
    msg.textContent = fetchHint(`Could not read that page: ${err.message}`);
    $('posting').focus();
    return false;
  }
}

/* ---------- tailoring ---------- */

async function generate(event) {
  event.preventDefault();
  const msg = $('gen-msg');
  msg.textContent = '';
  const rawLink = $('applink').value.trim();
  const link = normalizeUrl(rawLink);
  if (rawLink && !link) { msg.textContent = 'That application link does not look right. Use a full web address.'; $('applink').focus(); return; }
  if (link) $('applink').value = link;
  if (!$('posting').value.trim() && !link) { msg.textContent = 'Paste the posting, or add its application link and leave the box empty.'; $('posting').focus(); return; }
  if (!$('location').value) { msg.textContent = 'Choose a location for this resume.'; $('location').focus(); return; }

  const opts = { includePersonalLine: $('personal').checked, locationId: $('location').value, shortTitles: $('shorttitles').checked };
  store.set(LOCATION_STORE, opts.locationId);
  setBusy($('go'), true, 'Working...');
  try {
    // No pasted posting: read it from the link first, then show it so it can be checked.
    if (!$('posting').value.trim() && !(await fillPostingFromLink(link, msg))) return;
    saveDraft();
    const req = buildRequest(profile, { posting: $('posting').value.trim(), notes: $('notes').value, knowledge, ...opts });
    msg.textContent = 'Tailoring. This usually takes 20 to 60 seconds.';
    const input = await askClaude(req, 'submit_resume');
    const issues = validateResult(input, profile, { ...opts, knowledge });
    acceptResult(input, issues, opts, link);
    msg.textContent = '';
  } catch (err) {
    msg.textContent = err.message;
  } finally {
    setBusy($('go'), false);
  }
}

function acceptResult(result, issues, opts, link) {
  const doc = buildDoc(result, profile, { ...opts, knowledge });
  const text = renderText(doc);
  const locationLabel = profile.contact.locations.find((l) => l.id === opts.locationId)?.label || '';
  const entryData = {
    title: result.posting_title || '', company: result.company || '', link: link || '', location: locationLabel,
    text, originalText: text, doc, issues, keywords: keywordCoverage(result.posting_keywords, text), fit: result.fit_notes || ''
  };
  const added = addEntry(history, entryData);
  history = added.list;
  store.set(HISTORY_STORE, JSON.stringify(history));
  loadEntry(added.entry);

  setQuestions(filterQuestions(result.questions, knowledge, groupOf));
  renderHistory();
  showView('resume');
  const n = questions.length;
  toast(n ? `Resume ready. ${n} question${n === 1 ? '' : 's'} for you.` : 'Resume ready.', n ? { label: 'Answer', run: () => showView('questions') } : null);
}

function loadEntry(entry) {
  editing = false;
  const generated = entry.originalText || entry.text;
  current = {
    id: entry.id, doc: entry.doc, generated, text: entry.text, edited: entry.text !== generated,
    title: entry.title, company: entry.company, link: entry.link, location: entry.location,
    issues: entry.issues || [], keywords: entry.keywords || { covered: [], missing: [] }, fit: entry.fit || ''
  };
  renderCurrent();
}

function renderCurrent() {
  const c = current;
  $('resume-empty').hidden = true;
  $('resume-body').hidden = false;
  $('res-title').textContent = c.title || 'Tailored resume';
  $('res-sub').textContent = [c.company, c.location].filter(Boolean).join(' | ');
  const linkEl = $('res-link');
  linkEl.hidden = !c.link;
  if (c.link) linkEl.href = c.link;

  const paper = $('resume');
  paper.classList.toggle('plain', c.edited);
  if (c.edited) paper.textContent = c.text; else { paper.innerHTML = renderHtml(c.doc); addCopyButtons(); }
  $('resume-edit').hidden = !editing;
  paper.hidden = editing;
  $('edit').textContent = editing ? 'Done' : 'Edit';

  const stats = resumeStats(c.text);
  $('stat-words').textContent = `${stats.words} words, about ${stats.pages} page${stats.pages === 1 ? '' : 's'}`;
  $('stat-edited').hidden = !c.edited;
  const checks = $('stat-checks');
  checks.textContent = c.issues.length ? `${c.issues.length} check${c.issues.length === 1 ? '' : 's'} to review` : 'Checks passed';
  checks.className = `pill pill-btn ${c.issues.length ? 'warn' : 'ok'}`;
  $('checks').innerHTML = c.issues.length
    ? c.issues.map((i) => `<li>${esc(i)}</li>`).join('')
    : '<li>No problems found. Every bullet cites verified library entries and uses only numbers from them.</li>';

  const kw = c.keywords;
  const total = kw.covered.length + kw.missing.length;
  $('kw-summary').textContent = total ? `${kw.covered.length} of ${total}` : '';
  $('kw-fold').hidden = total === 0;
  $('kw-chips').innerHTML = [...kw.covered.map((k) => `<span class="hit">${esc(k)}</span>`), ...kw.missing.map((k) => `<span class="miss">${esc(k)}</span>`)].join('');
  $('fit').textContent = c.fit;
}

// One Copy button per section and per job, so a single application field can be filled with one tap.
function addCopyButtons() {
  for (const section of $('resume').querySelectorAll('section[data-section]')) {
    const name = section.dataset.section;
    if (name === 'experience') {
      for (const role of section.querySelectorAll('.role')) role.append(copyButton(`job ${Number(role.dataset.role) + 1}`, `role:${role.dataset.role}`));
    }
    section.append(copyButton(name, name));
  }
}

function copyButton(what, target) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'copy-sec';
  b.textContent = 'Copy';
  b.title = `Copy ${what}`;
  b.setAttribute('aria-label', `Copy ${what}`);
  b.dataset.copy = target;
  return b;
}

async function writeClipboard(text, done) {
  try { await navigator.clipboard.writeText(text); toast(done); } catch { toast('Copy was blocked. Use Download instead.'); }
}

function copySection(target) {
  const texts = sectionTexts(current.doc);
  const text = target.startsWith('role:') ? texts.roles[Number(target.slice(5))] : texts[target];
  if (text) writeClipboard(text, 'Copied.');
}

function download() {
  const url = URL.createObjectURL(new Blob([current.text], { type: 'text/plain;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: resumeFilename(current.company, current.title) });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast('Downloaded.');
}

function toggleEdit() {
  if (!current) return;
  if (!editing) {
    editing = true;
    $('resume-edit').value = current.text;
    renderCurrent();
    $('resume-edit').focus();
    return;
  }
  const value = $('resume-edit').value.replace(/\s+$/, '') + '\n';
  editing = false;
  if (value !== current.text) {
    current.text = value;
    current.edited = value !== current.generated;
    saveCurrentToHistory();
  }
  renderCurrent();
}

function revertEdit() {
  current.text = current.generated;
  current.edited = false;
  saveCurrentToHistory();
  renderCurrent();
  toast('Reverted to the generated resume.');
}

function saveCurrentToHistory() {
  history = updateEntry(history, current.id, { text: current.text, originalText: current.generated });
  store.set(HISTORY_STORE, JSON.stringify(history));
}

/* ---------- questions, one at a time ---------- */

const KIND_LABELS = { conflict: 'Pick a wording', gap: 'Not in your library', clarify: 'Quick check', strengthen: 'Add detail' };

function setQuestions(list) {
  questions = list;
  qState = list.map(() => 'open');
  qIndex = 0;
  renderQuestions();
}

const openIndexes = () => qState.map((s, i) => (s === 'open' || s === 'skipped' ? i : -1)).filter((i) => i >= 0);

function nextOpenAfter(i) {
  const open = openIndexes();
  return open.find((k) => k > i) ?? open[0] ?? -1;
}

function renderQuestions() {
  renderBadges();
  const empty = !questions.length;
  const open = openIndexes();
  $('q-empty').hidden = !empty;
  $('q-flow').hidden = empty || open.length === 0;
  $('q-done').hidden = empty || open.length > 0;
  if (empty) return;
  if (open.length === 0) { renderQuestionsDone(); return; }

  const q = questions[qIndex];
  const state = qState[qIndex];
  $('q-step').textContent = `Question ${qIndex + 1} of ${questions.length}`;
  $('q-dots').innerHTML = qState.map((s, i) => `<i class="${i === qIndex ? 'cur' : s === 'saved' || s === 'dismissed' ? 'done' : s === 'skipped' ? 'skip' : ''}"></i>`).join('');
  $('q-prev').disabled = qIndex === 0;
  $('q-next').disabled = qIndex === questions.length - 1;

  const role = q.role_id && profile.roles.find((r) => r.id === q.role_id);
  const tags = `<div class="q-tags"><span class="tag">${esc(KIND_LABELS[q.kind] || 'Question')}</span>${role ? `<span class="tag role">${esc(role.org)}</span>` : ''}${state === 'skipped' ? '<span class="tag role">Skipped earlier</span>' : ''}</div>`;
  const text = `<p class="q-text">${esc(q.text)}</p>`;
  if (state === 'saved' || state === 'dismissed') {
    $('q-card').innerHTML = `${tags}${text}<p class="q-status">${state === 'saved' ? 'Saved. It will not be asked again.' : 'Got it. It will not be asked again.'}</p>`;
    return;
  }
  const body = q.kind === 'conflict' && q.options?.length
    ? `<div class="q-options">${q.options.map((o, j) => `<button type="button" class="btn" data-act="choice" data-j="${j}">${esc(o.label)}</button>`).join('')}</div>`
    : `<textarea id="q-answer" rows="4" aria-label="Your answer" placeholder="Your answer, in your own words"></textarea>
       <div class="q-actions"><button type="button" class="btn primary" data-act="fact">Save as fact</button><button type="button" class="btn" data-act="preference">Save as preference</button></div>`;
  $('q-card').innerHTML = `${tags}${text}${body}<div class="q-more"><button type="button" class="btn ghost" data-act="skip">Skip for now</button><button type="button" class="btn ghost" data-act="dismiss">Don't ask again</button></div>`;
}

function renderQuestionsDone() {
  const saved = qState.filter((s) => s === 'saved' || s === 'dismissed').length;
  const pending = pendingItems(knowledge).length;
  $('q-done').innerHTML = `<h2>All answered</h2><p>${saved} saved. Those questions will not be asked again.</p>
    ${pending ? `<button type="button" class="btn primary block" data-done="merge">Merge ${pending} into my library</button>` : ''}
    <button type="button" class="btn tonal block" data-done="again">Tailor again with my answers</button>`;
}

async function answerQuestion(event) {
  const btn = event.target.closest('button[data-act]');
  if (!btn) return;
  const q = questions[qIndex];
  const act = btn.dataset.act;
  let answer;
  if (act === 'skip') {
    qState[qIndex] = 'skipped';
    goNext();
    return;
  }
  if (act === 'choice') {
    const o = q.options[Number(btn.dataset.j)];
    const group = groupOf(o.bullet_id);
    answer = group ? { action: 'choice', group, bullet_id: o.bullet_id, label: o.label } : { action: 'preference', text: `${q.text} Use: ${o.label}` };
  } else if (act === 'dismiss') {
    answer = { action: 'dismiss' };
  } else {
    const text = $('q-answer').value.trim();
    if (!text) { toast('Type your answer first.'); $('q-answer').focus(); return; }
    answer = { action: act, text };
  }
  knowledge = applyAnswer(knowledge, q, answer);
  qState[qIndex] = act === 'dismiss' ? 'dismissed' : 'saved';
  goNext();
  await persist();
}

function goNext() {
  const next = nextOpenAfter(qIndex);
  if (next >= 0) qIndex = next;
  renderQuestions();
  $('main').scrollTop = 0;
}

/* ---------- library merge ---------- */

async function startMerge() {
  const pending = pendingItems(knowledge);
  if (!pending.length) { toast('Nothing waiting to merge.'); return; }
  const box = $('review');
  box.innerHTML = '<p role="status">Claude is drafting library changes...</p>';
  showDialog('review-dialog');
  try {
    const input = await askClaude(buildLibrarianRequest(profile, pending), 'propose_library_changes');
    const evidence = pending.map((p) => p.text || '').join('\n');
    const preview = applyPatch(profile, input.ops, evidence);
    reviewing = { pending, ops: input.ops, evidence, preview };
    const lines = preview.applied.map((a) => `<li>${esc(describeOp(a.op, profile))}</li>`).join('');
    const skipped = preview.skipped.map((x) => `<li class="skip">Skipped: ${esc(describeOp(x.op, profile))} (${esc(x.why)})</li>`).join('');
    const clarify = (input.clarify || []).map((c) => `<li class="skip">Needs your input: ${esc(c)}</li>`).join('');
    box.innerHTML = `<p>${esc(input.summary || '')}</p>
      <ul class="cards">${lines || '<li>No new entries. Everything is already in the library.</li>'}${skipped}${clarify}</ul>
      <div class="row2"><button type="button" id="approve" class="btn primary">${preview.applied.length ? 'Approve and merge' : 'Mark as handled'}</button>
      <button type="button" id="cancel-merge" class="btn">Cancel</button></div><p id="review-msg" class="hint" role="status"></p>`;
    $('approve').addEventListener('click', approveMerge);
    $('cancel-merge').addEventListener('click', () => { $('review-dialog').close(); reviewing = null; });
  } catch (err) {
    box.innerHTML = `<p class="msg" role="alert">${esc(err.message)}</p>`;
  }
}

async function approveMerge() {
  const { pending, ops, evidence, preview } = reviewing;
  const msg = $('review-msg');
  $('approve').disabled = true;
  try {
    if (preview.applied.length) {
      const token = readSecret(TOKEN_STORE);
      if (!token) {
        const text = preview.applied.map((a) => describeOp(a.op, profile)).join('\n');
        try { await navigator.clipboard.writeText(text); } catch { /* ignore */ }
        msg.textContent = 'No GitHub token, so nothing was saved. The changes were copied; paste them into the Claude Code chat, or add a token in Settings and try again.';
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
    $('review').innerHTML = '<p role="status">Merged. Your library is up to date, and those questions will not be asked again.</p><button type="button" class="btn block" data-close>Done</button>';
    reviewing = null;
    renderQuestions();
  } catch (err) {
    msg.textContent = err.message;
    $('approve').disabled = false;
  }
}

async function teach() {
  const text = $('teach').value.trim();
  if (!text) { toast('Type something to teach first.'); return; }
  knowledge = applyAnswer(knowledge, { text }, { action: 'note', text });
  $('teach').value = '';
  await persist();
  await startMerge();
}

/* ---------- history ---------- */

function renderHistory() {
  $('history-empty').hidden = history.length > 0;
  $('history').hidden = history.length === 0;
  $('history').innerHTML = history.map((e) => {
    const total = e.keywords ? e.keywords.covered.length + e.keywords.missing.length : 0;
    const meta = [e.location, total ? `${e.keywords.covered.length} of ${total} keywords` : ''].filter(Boolean).join(' | ');
    return `<li class="hcard" data-id="${esc(e.id)}">
    <div class="hcard-top"><strong>${esc(historyLabel(e))}</strong><span class="meta">${esc(shortDate(e.at))}</span></div>
    ${meta ? `<div class="meta">${esc(meta)}</div>` : ''}
    <div class="hcard-actions">
      <select aria-label="Status" data-status>${STATUSES.map((s) => `<option${s === e.status ? ' selected' : ''}>${s}</option>`).join('')}</select>
      <button type="button" class="chip-btn" data-open>Open resume</button>
      ${e.link ? `<a class="chip-btn" href="${esc(e.link)}" target="_blank" rel="noopener noreferrer">Application</a>` : ''}
      <button type="button" class="chip-btn" data-delete>Delete</button>
    </div></li>`;
  }).join('');
}

function onHistoryClick(event) {
  const card = event.target.closest('.hcard');
  if (!card) return;
  const entry = history.find((e) => e.id === card.dataset.id);
  if (!entry) return;
  if (event.target.closest('[data-open]')) { loadEntry(entry); setQuestions([]); showView('resume'); }
  if (event.target.closest('[data-delete]')) {
    history = removeHistory(history, entry.id);
    store.set(HISTORY_STORE, JSON.stringify(history));
    renderHistory();
    toast('Deleted.');
  }
}

function onHistoryChange(event) {
  const select = event.target.closest('[data-status]');
  const card = event.target.closest('.hcard');
  if (!select || !card) return;
  history = updateEntry(history, card.dataset.id, { status: select.value });
  store.set(HISTORY_STORE, JSON.stringify(history));
}

/* ---------- start-up ---------- */

async function init() {
  applyTheme(themeMode());
  $('model').innerHTML = MODELS.map((m) => `<option value="${m.id}">${esc(m.label)}</option>`).join('');
  const savedModel = store.get('resume-advisor-model');
  if (MODELS.some((m) => m.id === savedModel)) $('model').value = savedModel;
  history = store.json(HISTORY_STORE, []);
  renderHistory();

  try { await loadProfile(); } catch (err) { $('login-msg').textContent = err.message; }
  restoreDraft();
  await pullKnowledge();

  // sign in
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
    const reveal = $('key').type === 'password';
    $('key').type = reveal ? 'text' : 'password';
    $('showkey').textContent = reveal ? 'Hide' : 'Show';
  });

  // chrome
  $('theme').addEventListener('click', cycleTheme);
  $('open-settings').addEventListener('click', () => showDialog('settings-dialog'));
  $('tabbar').addEventListener('click', (e) => { const b = e.target.closest('button[data-view]'); if (b) showView(b.dataset.view); });
  document.addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]');
    if (go) showView(go.dataset.go);
    const close = e.target.closest('[data-close]');
    if (close) close.closest('dialog').close();
    if (e.target instanceof HTMLDialogElement) e.target.close();
  });
  $('signout').addEventListener('click', () => { clearKey(); $('settings-dialog').close(); show(false); toast('Signed out.'); });
  $('clear-history').addEventListener('click', () => {
    if (!confirm('Remove all saved applications from this device?')) return;
    history = [];
    store.del(HISTORY_STORE);
    renderHistory();
    toast('History cleared.');
  });
  $('model').addEventListener('change', () => store.set('resume-advisor-model', $('model').value));

  // tailor form
  $('gen').addEventListener('submit', generate);
  for (const id of ['posting', 'applink', 'notes', 'shorttitles', 'personal']) $(id).addEventListener('input', () => { saveDraft(); if (id === 'posting' || id === 'applink') updatePostingCount(); });
  $('fetch').addEventListener('click', async () => {
    const link = normalizeUrl($('applink').value);
    if (!link) return;
    $('applink').value = link;
    setBusy($('fetch'), true, 'Reading...');
    try { await fillPostingFromLink(link, $('gen-msg')); } finally { setBusy($('fetch'), false); }
  });
  $('posting').addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') $('gen').requestSubmit(); });
  $('toggle-notes').addEventListener('click', () => setNotesOpen($('notes-field').hidden));
  $('clear-posting').addEventListener('click', () => { $('posting').value = ''; updatePostingCount(); saveDraft(); $('posting').focus(); });
  $('paste').addEventListener('click', async () => {
    try {
      $('posting').value = await navigator.clipboard.readText();
      updatePostingCount();
      saveDraft();
      toast('Pasted.');
    } catch { toast('Paste was blocked. Press and hold in the box to paste.'); }
  });

  // resume
  $('copy').addEventListener('click', () => writeClipboard(current.text, 'Copied the full resume.'));
  $('download').addEventListener('click', download);
  $('print').addEventListener('click', () => { if (editing) toggleEdit(); showView('resume'); window.print(); });
  $('edit').addEventListener('click', toggleEdit);
  $('stat-edited').addEventListener('click', revertEdit);
  $('stat-checks').addEventListener('click', () => showDialog('checks-dialog'));
  $('resume').addEventListener('click', (e) => { const b = e.target.closest('button[data-copy]'); if (b) copySection(b.dataset.copy); });

  // questions
  $('q-card').addEventListener('click', answerQuestion);
  $('q-prev').addEventListener('click', () => { qIndex = Math.max(0, qIndex - 1); renderQuestions(); });
  $('q-next').addEventListener('click', () => { qIndex = Math.min(questions.length - 1, qIndex + 1); renderQuestions(); });
  $('q-done').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-done]');
    if (!b) return;
    if (b.dataset.done === 'merge') startMerge();
    else { showView('tailor'); $('gen').requestSubmit(); }
  });

  // library
  $('merge').addEventListener('click', startMerge);
  $('teach-go').addEventListener('click', teach);
  $('saved').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-collection]');
    if (!b) return;
    knowledge = removeEntry(knowledge, b.dataset.collection, b.dataset.key);
    await persist();
  });

  // history
  $('history').addEventListener('click', onHistoryClick);
  $('history').addEventListener('change', onHistoryChange);

  // sync token
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

  renderBadges();
  show(Boolean(getKey()));
}

init();
