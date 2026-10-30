import {
  MODELS, buildRequest, validateResult, buildDoc, renderText, renderHtml, escapeHtml, groupLookup,
  sectionTexts, typo, markTerms, yearsSince, normalizeUrl, keywordCoverage, resumeStats, resumeFilename, buildFetchRequest, readFetchedPosting, sourceTextLookup
} from './lib.js?v=28';
import { buildPdf, docFromText } from './pdf.js?v=28';
import {
  atsLint, checkSuggestions, applySuggestion, buildSuggestRequest,
  buildSummaryRequest, checkSummaries
} from './ats.js?v=28';
import { icon, hydrateIcons } from './icons.js?v=28';
import {
  emptyKnowledge, normalizeKnowledge, answersSince, applyAnswer, removeEntry, filterQuestions, liveEntries, pendingItems, markMerged
} from './knowledge.js?v=28';
import { syncKnowledge, updateLibrary, pullFile, PROFILE_PATH } from './sync.js?v=28';
import { buildFitRequest, checkFit, fitScores, citedIdsOf, fingerprint } from './fit.js?v=28';
import { buildLibrarianRequest, applyPatch, describeOp } from './library.js?v=28';
import { STATUSES, addEntry, updateEntry, removeEntry as removeHistory, label as historyLabel } from './history.js?v=28';

const API = 'https://api.anthropic.com/v1';
// Storage names from earlier versions are kept so existing sign-ins and saved answers keep working.
const KEY_STORE = 'resume-tailor-key';
const KNOWLEDGE_STORE = 'resume-tailor-knowledge';
const TOKEN_STORE = 'resume-tailor-github-token';
const LOCATION_STORE = 'resume-tailor-location';
const HISTORY_STORE = 'resume-advisor-history';
const DRAFT_STORE = 'resume-advisor-draft';
const THEME_STORE = 'resume-advisor-theme';
const AUTOSUGGEST_STORE = 'resume-advisor-autosuggest';

const $ = (id) => document.getElementById(id);
const esc = escapeHtml;

/* ---------- storage ---------- */

const store = {
  get(name) { try { return localStorage.getItem(name) || ''; } catch { return ''; } },
  set(name, value) { try { localStorage.setItem(name, value); return true; } catch { return false; } },
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

// Posting texts are the bulk of the saved history. If the browser's storage fills up, drop the oldest ones first.
function persistHistory() {
  for (let strip = history.length; strip >= 0; strip -= 1) {
    const trial = history.map((e, k) => (k >= strip && e.postingText ? { ...e, postingText: '' } : e));
    if (store.set(HISTORY_STORE, JSON.stringify(trial))) { if (strip < history.length) history = trial; return; }
  }
  toast('This device is out of room for history. Older resumes may not be kept.');
}

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
  if (busy) { button.dataset.html = button.innerHTML; button.textContent = text; button.setAttribute('aria-busy', 'true'); }
  else { if (button.dataset.html) button.innerHTML = button.dataset.html; button.removeAttribute('aria-busy'); }
}

/* ---------- theme ---------- */

const THEME_ICONS = { auto: icon('auto'), light: icon('sun'), dark: icon('moon') };
const THEME_NAMES = { auto: 'Automatic', light: 'Light', dark: 'Dark' };
const themeMode = () => { const t = document.documentElement.dataset.theme; return t === 'light' || t === 'dark' ? t : 'auto'; };

function applyTheme(mode) {
  if (mode === 'auto') { delete document.documentElement.dataset.theme; store.del(THEME_STORE); }
  else { document.documentElement.dataset.theme = mode; store.set(THEME_STORE, mode); }
  $('theme').innerHTML = THEME_ICONS[mode];
  $('theme').setAttribute('aria-label', `Theme: ${THEME_NAMES[mode].toLowerCase()}. Click or tap to change.`);
  $('theme').title = $('theme').getAttribute('aria-label');
  requestAnimationFrame(() => $('theme-color').setAttribute('content', getComputedStyle(document.body).backgroundColor));
}

function cycleTheme() {
  const order = ['auto', 'light', 'dark'];
  const next = order[(order.indexOf(themeMode()) + 1) % order.length];
  applyTheme(next);
  toast(`Theme: ${THEME_NAMES[next]}`);
}

/* ---------- navigation ---------- */

let lastView = 'tailor';

function showView(name) {
  if (name !== 'compare') lastView = name;
  for (const v of document.querySelectorAll('.view')) v.hidden = v.dataset.view !== name;
  for (const t of document.querySelectorAll('.tabbar button')) {
    if (t.dataset.view === name) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
  }
  $('main').scrollTop = 0;
  $('toast').hidden = true;
  updateTitle();
}

function show(signedIn) {
  $('login').hidden = signedIn;
  $('app').hidden = !signedIn;
  $('tabbar').hidden = !signedIn;
  $('open-settings').hidden = !signedIn;
  $('open-history').hidden = !signedIn;
  $('open-palette').hidden = !signedIn;
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
  renderRegenBanner();
}

/* ---------- the posting: pasted from the clipboard (reading from a link is switched off for now) ---------- */

// Reading a posting from its link has not worked reliably, so the link field is hidden. The code stays; set this
// to true to bring the field back.
const LINK_READING = false;

// The posting is never edited on this page. It is accepted from the clipboard (or read from a link, when that is on),
// and the page only shows that it arrived. View shows the text read-only.
let posting = { text: '', source: '', link: '', title: '', company: '' };   // source: 'link' | 'pasted' | ''

function saveDraft() {
  store.set(DRAFT_STORE, JSON.stringify({
    applink: $('applink').value, posting, notes: $('notes').value,
    shorttitles: $('shorttitles').checked, personal: $('personal').checked
  }));
}

function restoreDraft() {
  const d = store.json(DRAFT_STORE, null);
  if (d) {
    $('applink').value = LINK_READING ? d.applink || '' : '';
    if (d.posting?.text) posting = { text: '', source: '', link: '', title: '', company: '', ...d.posting };
    $('notes').value = d.notes || '';
    $('shorttitles').checked = Boolean(d.shorttitles);
    $('personal').checked = d.personal !== false;
    if (d.notes) setNotesOpen(true);
  }
  renderPosting();
}

function renderPosting() {
  const has = Boolean(posting.text);
  $('paste-empty').hidden = has;
  $('paste-done').hidden = !has;
  if (has) {
    const n = wordCount(posting.text);
    $('posting-summary').textContent = `${n.toLocaleString('en-US')} words, ${posting.text.length.toLocaleString('en-US')} characters${posting.source === 'link' ? ', read from the link' : ''}`;
    $('posting-preview').textContent = posting.text.split('\n').map((l) => l.trim()).find((l) => l.length > 3)?.slice(0, 140) || '';
  }
  updateLinkUi();
}

function updateLinkUi() {
  const linkOk = Boolean(normalizeUrl($('applink').value));
  $('fetch').hidden = !linkOk || Boolean(posting.text);
  $('link-hint').textContent = !posting.text
    ? 'Claude reads the posting from this link and shows you what it found.'
    : posting.source === 'link' ? 'Read from this link. Clear it to read the page again.' : 'The pasted text will be used. The link is kept with your resume.';
}

function setPosting(text, source, extra = {}) {
  posting = { text: String(text).trim(), source: text ? source : '', link: extra.link || '', title: extra.title || '', company: extra.company || '' };
  if (text) $('gen-msg').textContent = '';
  renderPosting();
  saveDraft();
}

// Accepts text from the clipboard. Returns true when it looks like a posting and was taken.
function acceptPasted(raw) {
  const text = String(raw || '').trim();
  $('paste-catch').value = '';
  if (text.length < 40) { toast('That did not look like a posting. Copy the whole posting and try again.'); return false; }
  setPosting(text, 'pasted');
  toast(`Posting accepted. ${wordCount(text)} words.`);
  return true;
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

// Reads the posting from the link and stores it. Returns true when the posting text is now held.
async function fillPostingFromLink(link, msg) {
  msg.textContent = 'Reading the posting from your link...';
  try {
    const got = await readPostingFromLink(link);
    if (!got.ok) { msg.textContent = fetchHint(`Could not read that page: ${got.problem}`); $('paste-catch').focus(); return false; }
    setPosting(got.text, 'link', { link, title: got.title, company: got.company });
    toast(`Read the posting${got.title ? `: ${got.title}` : ''}. Tap View to check it.`);
    return true;
  } catch (err) {
    msg.textContent = fetchHint(`Could not read that page: ${err.message}`);
    $('paste-catch').focus();
    return false;
  }
}

/* ---------- tailoring ---------- */

async function generate(event) {
  event.preventDefault();
  const msg = $('gen-msg');
  msg.textContent = '';
  const rawLink = LINK_READING ? $('applink').value.trim() : '';
  const link = normalizeUrl(rawLink);
  if (rawLink && !link) { msg.textContent = 'That application link does not look right. Use a full web address.'; $('applink').focus(); return; }
  if (link) $('applink').value = link;
  if (!posting.text && !link) { msg.textContent = 'Paste the job posting first.'; $('paste').focus(); return; }
  if (!$('location').value) { msg.textContent = 'Choose a location for this resume.'; $('location').focus(); return; }

  const opts = { includePersonalLine: $('personal').checked, locationId: $('location').value, shortTitles: $('shorttitles').checked };
  store.set(LOCATION_STORE, opts.locationId);
  setBusy($('go'), true, 'Working...');
  try {
    // No pasted text: read the posting from the link first.
    if (!posting.text && !(await fillPostingFromLink(link, msg))) return;
    saveDraft();
    const req = buildRequest(profile, { posting: posting.text, notes: $('notes').value, knowledge, ...opts });
    msg.textContent = 'Tailoring. This usually takes 20 to 60 seconds.';
    const input = await askClaude(req, 'submit_resume');
    const issues = validateResult(input, profile, { ...opts, knowledge });
    acceptResult(input, issues, opts, link, { notes: $('notes').value });
    msg.textContent = '';
  } catch (err) {
    msg.textContent = err.message;
  } finally {
    setBusy($('go'), false);
  }
}

// replaceId: regenerate this history entry in place instead of adding a new one. source: where the posting came from.
function acceptResult(result, issues, opts, link, { replaceId = '', source = posting, notes = '' } = {}) {
  const doc = buildDoc(result, profile, { ...opts, knowledge });
  const text = renderText(doc);
  const locationLabel = profile.contact.locations.find((l) => l.id === opts.locationId)?.label || '';
  const known = sourceTextLookup(profile, { includePersonalLine: opts.includePersonalLine, knowledge });
  const entryData = {
    title: result.posting_title || '', company: result.company || '', link: link || '', location: locationLabel,
    text, originalText: text, doc, issues, keywords: keywordCoverage(result.posting_keywords, text), fit: replaceId ? current.fit : null, citedIds: citedIdsOf(result),
    postingKeywords: result.posting_keywords || [], suggestions: checkSuggestions(result.suggestions, { doc, knownText: known, libraryText: known.all() }),
    postingText: (source.text || '').slice(0, 15000), summaryOptions: [], summaryOriginal: '',
    generatedAt: new Date().toISOString(),
    opts: { locationId: opts.locationId, shortTitles: Boolean(opts.shortTitles), includePersonalLine: opts.includePersonalLine !== false }, notes
  };
  let entry;
  if (replaceId) {
    history = updateEntry(history, replaceId, entryData);
    entry = history.find((e) => e.id === replaceId);
  } else {
    const added = addEntry(history, entryData);
    history = added.list;
    entry = added.entry;
  }
  persistHistory();
  loadEntry(entry);

  setQuestions(filterQuestions(result.questions, knowledge, groupOf));
  renderHistory();
  showView('resume');
  const n = questions.length;
  if (!replaceId) toast(n ? `Resume ready. ${n} question${n === 1 ? '' : 's'} for you.` : 'Resume ready.', n ? { label: 'Answer', run: () => showView('questions') } : null);
  if (!current.fit || current.fit.hash !== fingerprint(profile)) assessFit();
  if (store.get(AUTOSUGGEST_STORE) !== '0' && current.keywords.missing.length) autoSuggest();
}

/* ---------- posting fit: the library against the posting, and the draft against the posting ---------- */

let assessingId = '';

const scoreBar = (label, value, kind) => `<span class="fit-row"><b>${label}</b><span class="meter ${kind}" role="img" aria-label="${label}: ${value} out of 100"><i style="width:${value}%"></i></span><em>${value}</em></span>`;

function currentScores() {
  const c = current;
  if (!c?.fit?.requirements?.length) return null;
  return fitScores(c.fit.requirements, c.text, c.edited ? null : new Set(c.citedIds || []));
}

function renderFit() {
  const c = current;
  const strip = $('fit-strip');
  const detail = $('fit-detail');
  if (!c) return;
  const busy = assessingId === c.id;
  const scores = currentScores();
  const stale = Boolean(c.fit && c.fit.hash !== fingerprint(profile));

  // The strip on the Resume tab.
  strip.hidden = !(busy || scores || c.fitError || c.postingText);
  if (busy && !scores) strip.innerHTML = `<div class="fit-head"><span class="fit-title">${icon('gauge')}Fit with the posting</span></div><p class="fit-wait" role="status">Scoring the posting against your library...</p>`;
  else if (!scores) strip.innerHTML = `<div class="fit-head"><span class="fit-title">${icon('gauge')}Fit with the posting</span></div><p class="fit-wait">${esc(c.fitError || 'Not scored yet.')}</p><button type="button" class="chip-btn" data-fit="again">${c.fitError ? 'Try again' : 'Score it'}</button>`;
  else strip.innerHTML = `<button type="button" class="fit-open" data-go="improve" aria-label="Fit with the posting. Open the details.">
      <span class="fit-head"><span class="fit-title">${icon('gauge')}Fit with the posting</span><span class="fit-more">Details${icon('chevron')}</span></span>
      <span class="fit-rows">${scoreBar('Library', scores.library, 'lib')}${scoreBar('This draft', scores.draft, 'draft')}</span></button>`;
  hydrateIcons(strip);

  // The detail on the Improve tab.
  if (!scores) {
    detail.innerHTML = `<div class="sec-head"><i data-icon="gauge"></i><h3 id="fit-h">Posting fit</h3></div><p class="hint" role="status">${busy ? 'Scoring the posting against your library...' : esc(c.fitError || 'Not scored yet.')}</p>${busy ? '' : '<button type="button" class="btn tonal block" data-fit="again"><i data-icon="refresh"></i><span>Score the fit</span></button>'}`;
    hydrateIcons(detail);
    return;
  }
  const gap = scores.library - scores.draft;
  const by = (state) => scores.rows.filter((r) => r.state === state);
  const row = (r, i) => `<li class="req ${r.state}"><div class="req-top"><span class="req-text">${esc(r.text)}</span><span class="tag ${r.weight === 'must' ? '' : 'role'}">${r.weight === 'must' ? 'Required' : 'Preferred'}</span></div>
      <p class="req-note">${esc(r.note)}${r.support === 'partial' ? ' <em>Related, not exact.</em>' : ''}</p>
      ${r.state === 'unused' ? `<button type="button" class="chip-btn" data-ask="${i}">${icon('send')}Ask for it</button>` : ''}</li>`;
  const group = (state, title, hint, open) => {
    const rows = scores.rows.map((r, i) => [r, i]).filter(([r]) => r.state === state);
    return rows.length ? `<details class="fold req-group"${open ? ' open' : ''}><summary><span>${title}</span><span class="fold-meta">${rows.length}</span></summary><p class="hint">${hint}</p><ul class="cards">${rows.map(([r, i]) => row(r, i)).join('')}</ul></details>` : '';
  };
  detail.innerHTML = `<div class="sec-head"><i data-icon="gauge"></i><h3 id="fit-h">Posting fit</h3><span class="sec-meta">${scores.rows.length} requirements</span></div>
    <div class="scores">
      <div class="score lib"><span class="label">Library</span><strong>${scores.library}</strong><span class="meter lib" role="img" aria-label="Library fit: ${scores.library} out of 100"><i style="width:${scores.library}%"></i></span><small>What your library can honestly say about this posting.</small></div>
      <div class="score draft"><span class="label">This draft</span><strong>${scores.draft}</strong><span class="meter draft" role="img" aria-label="Draft fit: ${scores.draft} out of 100"><i style="width:${scores.draft}%"></i></span><small>How much of that this resume shows.</small></div>
    </div>
    <p class="fit-gap">${gap > 0 ? `Your library supports ${gap} more point${gap === 1 ? '' : 's'} than this draft shows. Ask for the items below to close the gap.` : 'This draft shows everything your library can support for this posting.'}</p>
    ${group('unused', 'In your library, not in this draft', 'Your library backs these, but the resume does not say them yet.', true)}
    ${group('shown', 'Shown in this draft', 'The draft already says these.', false)}
    ${group('missing', 'Not in your library', 'Nothing in your library shows these. If one is true, teach it on the Library tab, then re-check.', true)}
    <p class="hint">Required items count three times as much as preferred ones. A related match earns half credit. Scores are estimates, rounded down.</p>
    ${stale ? '<p class="fit-stale" role="status">Your library changed since this was scored.</p>' : ''}
    <button type="button" class="btn block" data-fit="again"><i data-icon="refresh"></i><span>Re-check against my library</span></button>`;
  hydrateIcons(detail);
}

async function assessFit() {
  if (!current?.postingText) { if (current) { current.fitError = 'This resume was made before the posting was kept, so it cannot be scored.'; renderFit(); } return; }
  const id = current.id;
  const text = current.postingText;
  assessingId = id;
  current.fitError = '';
  renderFit();
  try {
    const opts = { includePersonalLine: $('personal').checked, knowledge };
    const input = await askClaude(buildFitRequest(profile, { posting: text, ...opts }), 'report_fit');
    const requirements = checkFit(input, sourceTextLookup(profile, opts));
    if (!requirements.length) throw new Error('No requirements came back. Try again.');
    const fit = { requirements, hash: fingerprint(profile), at: new Date().toISOString() };
    history = updateEntry(history, id, { fit });
    persistHistory();
    if (current?.id === id) current.fit = fit;
  } catch (err) {
    if (current?.id === id) current.fitError = `Could not score the fit: ${err.message}`;
  } finally {
    assessingId = '';
    if (current?.id === id) renderFit();
  }
}

// Fills the comment box on the Resume tab, so a requirement can be asked for in one tap.
function askFor(text) {
  showView('resume');
  const box = $('composer-text');
  box.value = text;
  growComposer();
  box.focus({ preventScroll: false });
  box.setSelectionRange(box.value.length, box.value.length);
}

/* ---------- the comment box on the Resume tab ---------- */

function growComposer() {
  const box = $('composer-text');
  box.style.height = 'auto';
  box.style.height = `${Math.min(box.scrollHeight, 140)}px`;
  $('composer-send').disabled = regenerating || !box.value.trim();
}

async function sendComposer(event) {
  event.preventDefault();
  const comment = $('composer-text').value.trim();
  if (!comment || regenerating || !current) return;
  const ok = await regenerate({ comment });
  if (ok) { $('composer-text').value = ''; growComposer(); }
}

/* ---------- regenerate: a fresh draft from the same posting ---------- */

let regenerating = false;

// Answers saved after this draft was written. They are used the next time it is regenerated.
function newAnswers() {
  const entry = current && history.find((e) => e.id === current.id);
  return entry ? answersSince(knowledge, entry.generatedAt || entry.at) : 0;
}

function renderRegenBanner() {
  const n = current && current.postingText ? newAnswers() : 0;
  $('regen-banner').hidden = n === 0;
  if (n) $('regen-banner-title').textContent = `${n} new answer${n === 1 ? '' : 's'} since this draft`;
}

function openRegenerate() {
  if (!current || regenerating) return;
  const prior = history.find((e) => e.id === current.id);
  $('regen-notes').value = prior?.notes || '';
  $('regen-short').checked = prior?.opts ? prior.opts.shortTitles : $('shorttitles').checked;
  $('regen-personal').checked = prior?.opts ? prior.opts.includePersonalLine : $('personal').checked;
  const n = newAnswers();
  $('regen-answers').hidden = n === 0;
  $('regen-answers').textContent = n ? `Includes ${n} answer${n === 1 ? '' : 's'} you saved since this draft.` : '';
  $('regen-msg').textContent = current.postingText ? '' : 'This resume was made before the posting was kept. Paste the posting on the Tailor tab to tailor it again.';
  $('regen-go').disabled = !current.postingText;
  showDialog('regen-dialog');
}

// Regenerates the resume on screen from its saved posting, using everything saved since. With the sheet open it
// takes the sheet's settings; otherwise (the banner, or the Questions tab) it repeats the draft's own settings.
// A comment from the Resume tab's box is added to the draft's notes, and the draft on screen is the starting point,
// so the rest of the resume stays as it is. Returns true when a new draft was made.
async function regenerate({ comment = '' } = {}) {
  const sheet = !comment && $('regen-dialog').open;
  const msg = comment ? $('composer-msg') : $('regen-msg');
  const say = (text) => {
    if (comment) { msg.textContent = text; msg.hidden = !text; }
    else if (sheet) msg.textContent = text;
    else if (text) toast(text);
  };
  const prior = history.find((e) => e.id === current.id);
  if (!current.postingText) { say('This resume was made before the posting was kept. Paste the posting on the Tailor tab to tailor it again.'); return false; }
  const locationId = prior?.opts?.locationId || profile.contact.locations.find((l) => l.label === current.location)?.id || $('location').value;
  if (!locationId) { say('Choose a location on the Tailor tab first.'); return false; }
  const opts = sheet
    ? { includePersonalLine: $('regen-personal').checked, locationId, shortTitles: $('regen-short').checked }
    : { includePersonalLine: prior?.opts ? prior.opts.includePersonalLine : $('personal').checked, locationId, shortTitles: prior?.opts ? prior.opts.shortTitles : $('shorttitles').checked };
  const baseNotes = sheet ? $('regen-notes').value.trim() : prior?.notes || '';
  const notes = comment ? `${baseNotes}\n${comment}`.trim() : baseNotes;
  const snapshot = prior ? { ...prior } : null;
  const source = { text: current.postingText };
  regenerating = true;
  if (sheet) setBusy($('regen-go'), true, 'Writing a new draft...');
  $('regen').setAttribute('aria-busy', 'true');
  $('composer').setAttribute('aria-busy', 'true');
  $('regen-banner-go').disabled = true;
  growComposer();
  say(comment ? 'Working on your request. This takes 20 to 60 seconds.' : sheet ? 'This usually takes 20 to 60 seconds. You can close this and keep reading.' : 'Writing a new draft with your answers. This takes 20 to 60 seconds.');
  try {
    const req = buildRequest(profile, { posting: source.text, notes, draft: comment ? current.text : '', knowledge, ...opts });
    const input = await askClaude(req, 'submit_resume');
    const issues = validateResult(input, profile, { ...opts, knowledge });
    acceptResult(input, issues, opts, current.link, { replaceId: current.id, source, notes });
    say('');
    if ($('regen-dialog').open) $('regen-dialog').close();
    const paper = $('resume');
    paper.classList.remove('fresh');
    void paper.offsetWidth;
    paper.classList.add('fresh');
    navigator.vibrate?.(12);
    const n = questions.length;
    toast(`${comment ? 'Changes made.' : 'New draft ready.'}${n ? ` ${n} question${n === 1 ? '' : 's'} for you.` : ''}`, snapshot ? { label: 'Undo', run: () => undoRegenerate(snapshot) } : null);
    return true;
  } catch (err) {
    say(err.message);
    return false;
  } finally {
    regenerating = false;
    $('regen').removeAttribute('aria-busy');
    $('composer').removeAttribute('aria-busy');
    $('regen-banner-go').disabled = false;
    if (sheet) setBusy($('regen-go'), false);
    growComposer();
  }
}

// From outside the sheet. A hand-edited draft goes through the sheet first, since regenerating replaces the edits.
function regenerateWithAnswers() {
  if (!current || regenerating) return;
  showView('resume');
  if (current.edited) openRegenerate(); else regenerate();
}

function undoRegenerate(snapshot) {
  history = history.map((e) => (e.id === snapshot.id ? snapshot : e));
  persistHistory();
  loadEntry(snapshot);
  renderHistory();
  toast('Restored the previous draft.');
}

function loadEntry(entry) {
  editing = false;
  const generated = entry.originalText || entry.text;
  current = {
    id: entry.id, doc: entry.doc, generated, text: entry.text, edited: entry.text !== generated,
    title: entry.title, company: entry.company, link: entry.link, location: entry.location,
    issues: entry.issues || [], keywords: entry.keywords || { covered: [], missing: [] }, fit: entry.fit && typeof entry.fit === 'object' ? entry.fit : null, fitError: '',
    postingKeywords: entry.postingKeywords || [], citedIds: entry.citedIds || [], suggestions: entry.suggestions || [],
    unsupported: entry.unsupported || [],
    postingText: entry.postingText || '', summaryOptions: entry.summaryOptions || [], summaryOriginal: entry.summaryOriginal || ''
  };
  renderCurrent();
}

const kwList = () => (current.postingKeywords.length ? current.postingKeywords : [...current.keywords.covered, ...current.keywords.missing]);

function renderCurrent() {
  const c = current;
  const terms = kwList();
  if (terms.length) c.keywords = keywordCoverage(terms, c.text);
  $('resume-empty').hidden = true;
  $('resume-body').hidden = false;
  $('res-title').textContent = c.title || 'Tailored resume';
  $('res-sub').textContent = [c.company, c.location].filter(Boolean).join(' · ');
  const linkEl = $('res-link');
  linkEl.hidden = !c.link;
  if (c.link) linkEl.href = c.link;

  const paper = $('resume');
  paper.classList.toggle('plain', c.edited);
  if (c.edited) paper.textContent = c.text; else { paper.innerHTML = renderHtml(c.doc); addCopyButtons(); }
  $('resume-edit').hidden = !editing;
  paper.hidden = editing;
  $('edit').querySelector('span').textContent = editing ? 'Done' : 'Edit';

  const stats = resumeStats(c.text);
  $('stat-words').textContent = `${stats.words} words, about ${stats.pages} page${stats.pages === 1 ? '' : 's'}`;
  $('stat-edited').hidden = !c.edited;
  const checks = $('stat-checks');
  checks.innerHTML = `${icon(c.issues.length ? 'alert' : 'check')}${c.issues.length ? `${c.issues.length} check${c.issues.length === 1 ? '' : 's'} to review` : 'Checks passed'}`;
  checks.className = `pill pill-btn ${c.issues.length ? 'warn' : 'ok'}`;
  $('checks').innerHTML = c.issues.length
    ? c.issues.map((i) => `<li>${esc(i)}</li>`).join('')
    : '<li>No problems found. Every bullet cites verified library entries and uses only numbers from them.</li>';
  renderFit();
  renderRegenBanner();
  updateTitle();

  renderImprove();
}

/* ---------- Improve: keyword rewrites, summary, checks ---------- */

const openSuggestions = () => (current?.suggestions || []).filter((s) => s.kind === 'rephrase' && !s.applied && !s.dismissed);

function renderImprove() {
  const c = current;
  $('improve-empty').hidden = true;
  $('improve-body').hidden = false;
  $('improve-sub').textContent = [c.title, c.company].filter(Boolean).join(' at ') || 'This resume';

  // Coverage: every posting term, marked by whether the resume says it.
  const terms = kwList();
  const total = terms.length;
  const covered = c.keywords.covered.length;
  $('cov-text').textContent = total ? `${covered} of ${total}` : '';
  $('cov-fill').style.width = total ? `${Math.round((covered / total) * 100)}%` : '0%';
  const resumeCounts = markTerms(c.text, terms).counts;
  $('kw-chips').innerHTML = terms.map((t, i) => `<button type="button" class="${resumeCounts[i] ? 'hit' : 'miss'}" data-k="${i}">${esc(t)}<small>${resumeCounts[i]}</small></button>`).join('')
    || '<span class="hint">No posting terms were recorded for this resume.</span>';

  renderSuggestions();
  renderSummary();
  renderAts();
  const open = openSuggestions().length;
  $('badge-i').hidden = open === 0;
  $('badge-i').textContent = String(open);
  $('improve-count').hidden = open === 0;
  $('improve-count').textContent = String(open);
}

function renderSuggestions() {
  const c = current;
  const items = c.suggestions || [];
  const missing = c.keywords.missing.length;
  const open = openSuggestions().length;
  $('sug-count').textContent = open ? `${open} open` : missing ? `${missing} missing` : '';
  $('sug-more').hidden = missing === 0;
  $('sug-all').hidden = open < 2;
  $('suggestions').innerHTML = items.map((s, i) => {
    if (s.dismissed) return '';
    if (s.kind === 'ats') return `<li class="sug"><span class="tag">Tip</span><p class="now">${esc(typo(s.text))}</p></li>`;
    const stale = !s.applied && !suggestionTarget(s);
    return `<li class="sug" data-i="${i}"><span class="tag">${esc(s.keyword)}</span>
      <p class="was">${esc(typo(s.replaces))}</p><p class="now">${esc(typo(s.text))}</p>
      ${s.why ? `<p class="why">${esc(typo(s.why))}</p>` : ''}
      ${s.applied ? `<p class="applied">${icon('check')} Applied</p>` : stale ? '<p class="why">This line has changed, so the rewrite no longer fits.</p>'
        : `<div class="sug-actions"><button type="button" class="btn primary" data-sug="apply">${icon('check')}Apply</button><button type="button" class="btn" data-sug="dismiss">Dismiss</button></div>`}</li>`;
  }).join('') || `<li>${missing ? 'No rewrites yet. Tap Find more.' : 'Every posting term is already in the resume.'}</li>`;
  $('sug-unsupported').innerHTML = (c.unsupported || []).length
    ? `<h3>Not in your library</h3><ul class="tips">${c.unsupported.map((u) => `<li><strong>${esc(u.keyword)}.</strong> ${esc(u.why)}</li>`).join('')}</ul><p>If one is true for you, add it under Teach on the Library tab and tailor again.</p>`
    : '';
}

// The line a suggestion would replace, if it is still in the resume as written.
function suggestionTarget(s) {
  if (s.where?.summary) return current.doc.summary === s.replaces;
  return s.where && current.doc.experience[s.where.ri]?.bullets[s.where.bi] === s.replaces;
}

function renderAts() {
  const c = current;
  const checks = atsLint({ text: c.text, doc: c.doc, keywords: kwList(), postingTitle: c.title });
  const review = checks.filter((x) => !x.ok).length;
  $('ats-count').textContent = review ? `${review} to review` : 'All clear';
  $('ats-list').innerHTML = checks.map((x) => `<li class="ats-row ${x.ok ? 'ok' : 'warn'}"><i>${x.ok ? '✓' : '!'}</i><div>${esc(x.label)}<small>${esc(x.detail)}</small></div></li>`).join('');
}

function saveEntry(patch) {
  history = updateEntry(history, current.id, patch);
  persistHistory();
}

// Recomputes everything that depends on the resume's wording after a change, and saves it.
function finishChange(extra = {}) {
  current.text = renderText(current.doc);
  current.generated = current.text;
  current.keywords = keywordCoverage(kwList(), current.text);
  saveEntry({ doc: current.doc, text: current.text, originalText: current.text, keywords: current.keywords, suggestions: current.suggestions, ...extra });
  renderCurrent();
}

function applyOne(s) {
  if (!suggestionTarget(s)) return false;
  current.doc = applySuggestion(current.doc, s);
  s.applied = true;
  return true;
}

function onSuggestion(event) {
  const btn = event.target.closest('button[data-sug]');
  const li = event.target.closest('li[data-i]');
  if (!btn || !li) return;
  const s = current.suggestions[Number(li.dataset.i)];
  if (btn.dataset.sug === 'dismiss') { s.dismissed = true; saveEntry({ suggestions: current.suggestions }); renderImprove(); return; }
  if (current.edited) { toast('Revert your edits first, then apply rewrites.'); return; }
  if (!applyOne(s)) { renderSuggestions(); return; }
  finishChange();
  toast('Applied.');
}

function applyAll() {
  if (current.edited) { toast('Revert your edits first, then apply rewrites.'); return; }
  let done = 0;
  for (const s of openSuggestions()) if (applyOne(s)) done += 1;
  if (!done) { toast('Nothing could be applied. The lines have changed.'); return; }
  finishChange();
  toast(`Applied ${done} rewrite${done === 1 ? '' : 's'}.`);
}

// Asks for natural rewordings that cover the keywords the resume still lacks, then keeps only the safe ones.
async function suggestMore(only = null, { quiet = false } = {}) {
  const missing = only || current.keywords.missing;
  if (!missing.length) return;
  const status = $('sug-status');
  const button = $('sug-more');
  if (!quiet) setBusy(button, true, 'Finding wording...');
  status.textContent = `Finding natural wording for ${missing.length} keyword${missing.length === 1 ? '' : 's'}...`;
  const entryId = current.id;
  try {
    const opts = { includePersonalLine: $('personal').checked, knowledge };
    const req = buildSuggestRequest(profile, { doc: current.doc, missing, offered: current.suggestions.filter((s) => s.kind === 'rephrase'), ...opts });
    const input = await askClaude(req, 'submit_suggestions');
    if (!current || current.id !== entryId) return;
    const known = sourceTextLookup(profile, opts);
    const fresh = checkSuggestions(input.suggestions, { doc: current.doc, knownText: known, libraryText: known.all() })
      .filter((s) => s.kind === 'rephrase' && !current.suggestions.some((o) => o.kind === 'rephrase' && (o.keyword || '').toLowerCase() === s.keyword.toLowerCase() && o.replaces === s.replaces && !o.dismissed));
    current.suggestions = [...current.suggestions, ...fresh];
    current.unsupported = (input.unsupported || []).filter((u) => u?.keyword && u?.why).map((u) => ({ keyword: String(u.keyword), why: String(u.why) }));
    saveEntry({ suggestions: current.suggestions, unsupported: current.unsupported });
    renderImprove();
    status.textContent = fresh.length
      ? `${fresh.length} new rewrite${fresh.length === 1 ? '' : 's'}.`
      : 'Nothing safe to add. Every other missing term needs something your library does not yet say.';
    if (quiet && fresh.length) toast(`${fresh.length} keyword rewrite${fresh.length === 1 ? '' : 's'} ready.`, { label: 'Review', run: () => showView('improve') });
  } catch (err) {
    status.textContent = err.message;
  } finally {
    if (!quiet) setBusy(button, false);
  }
}

// After tailoring: look for rewrites in the background so the Improve tab is already filled in.
function autoSuggest() {
  suggestMore(null, { quiet: true });
}

/* ---------- Improve: the summary ---------- */

function renderSummary() {
  const c = current;
  $('sum-current').textContent = typo(c.doc.summary || 'This resume has no summary.');
  $('sum-restore').hidden = !c.summaryOriginal || c.summaryOriginal === c.doc.summary;
  $('sum-options').innerHTML = (c.summaryOptions || []).map((o, i) => `<li class="sug" data-i="${i}"><span class="tag">${esc(o.label)}</span>
    <p class="now">${esc(typo(o.text))}</p>
    <div class="sug-actions"><button type="button" class="btn primary" data-sum="use">${icon('check')}Use this</button></div></li>`).join('');
}

async function writeSummaries() {
  const button = $('sum-gen');
  const status = $('sum-status');
  setBusy(button, true, 'Writing options...');
  status.textContent = '';
  try {
    const opts = { includePersonalLine: $('personal').checked, knowledge };
    const req = buildSummaryRequest(profile, { doc: current.doc, keywords: kwList(), missing: current.keywords.missing, postingTitle: current.title, ...opts });
    const input = await askClaude(req, 'submit_summaries');
    const known = sourceTextLookup(profile, opts);
    current.summaryOptions = checkSummaries(input.options, { knownText: known, years: yearsSince(profile.meta.career_start), startYear: Number(profile.meta.career_start.slice(0, 4)) });
    saveEntry({ summaryOptions: current.summaryOptions });
    status.textContent = current.summaryOptions.length ? '' : 'No safe options this time. Try again.';
    renderSummary();
  } catch (err) {
    status.textContent = err.message;
  } finally {
    setBusy(button, false);
  }
}

function useSummary(i) {
  if (current.edited) { toast('Revert your edits first, then change the summary.'); return; }
  const option = current.summaryOptions[i];
  if (!option) return;
  if (!current.summaryOriginal) current.summaryOriginal = current.doc.summary;
  current.doc = { ...current.doc, summary: option.text };
  finishChange({ summaryOriginal: current.summaryOriginal });
  toast(`Summary changed to ${option.label}.`);
}

function restoreSummary() {
  if (!current.summaryOriginal) return;
  current.doc = { ...current.doc, summary: current.summaryOriginal };
  finishChange();
  toast('Original summary restored.');
}

/* ---------- Compare: the posting and the draft, side by side ---------- */

const cmp = { mode: 'both', active: -1 };

function renderCompare() {
  const c = current;
  const terms = kwList();
  const resumeSide = markTerms(c.text, terms, () => 'hit');
  const postingSide = c.postingText ? markTerms(c.postingText, terms, (i) => (resumeSide.counts[i] ? 'hit' : 'miss')) : null;
  $('cmp-chips').innerHTML = terms.map((t, i) => `<button type="button" class="${resumeSide.counts[i] ? 'hit' : 'miss'}" data-k="${i}" aria-pressed="${cmp.active === i}">${esc(t)}<small>${postingSide ? postingSide.counts[i] : '?'} · ${resumeSide.counts[i]}</small></button>`).join('');
  $('cmp-posting-body').innerHTML = postingSide
    ? postingSide.html
    : `<p class="none">The posting text was not saved for this older resume. Copy the posting and tap below to add it.<br><button type="button" id="cmp-paste" class="chip-btn">${icon('clipboard')}Paste the posting</button></p>`;
  $('cmp-resume-body').innerHTML = resumeSide.html;
  for (const b of document.querySelectorAll('.seg button')) b.setAttribute('aria-pressed', String(b.dataset.pane === cmp.mode));
  $('cmp-panes').dataset.mode = cmp.mode;
  $('cmp-detail').innerHTML = '';
  if (cmp.active >= 0) focusTerm(cmp.active, { scroll: false });
}

function focusTerm(k, { scroll = true } = {}) {
  cmp.active = k;
  const terms = kwList();
  for (const b of document.querySelectorAll('#cmp-chips button')) b.setAttribute('aria-pressed', String(Number(b.dataset.k) === k));
  for (const m of document.querySelectorAll('#v-compare mark')) m.classList.toggle('k-active', Number(m.dataset.k) === k);
  const inPosting = document.querySelectorAll(`#cmp-posting-body mark[data-k="${k}"]`);
  const inResume = document.querySelectorAll(`#cmp-resume-body mark[data-k="${k}"]`);
  if (scroll) {
    for (const [pane, list] of [['cmp-posting-body', inPosting], ['cmp-resume-body', inResume]]) {
      const body = $(pane);
      if (list[0]) body.scrollTo({ top: Math.max(0, list[0].offsetTop - body.clientHeight / 3), behavior: 'smooth' });
    }
  }
  const missing = inResume.length === 0;
  $('cmp-detail').innerHTML = `${esc(terms[k])}: ${current.postingText ? `${inPosting.length} in the posting, ` : ''}${inResume.length} in your resume.${missing ? ` <button type="button" class="chip-btn" id="cmp-find">${icon('sparkle')}Find wording</button>` : ''}`;
}

function openCompare(k = -1) {
  if (!current) return;
  cmp.active = k;
  renderCompare();
  showView('compare');
  if (k >= 0) focusTerm(k);
}

async function pastePostingIntoEntry() {
  try {
    const text = (await navigator.clipboard.readText()).trim();
    if (text.length < 40) { toast('That did not look like a posting.'); return; }
    current.postingText = text.slice(0, 15000);
    saveEntry({ postingText: current.postingText });
    renderCompare();
    toast('Posting added.');
  } catch { toast('Paste was blocked by the browser.'); }
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

async function makePdf() {
  const button = $('pdf');
  setBusy(button, true, 'Typesetting...');
  try {
    let doc = current.doc;
    if (current.edited) {
      doc = docFromText(current.text);
      if (!doc) { doc = current.doc; toast('Your edited text could not be laid out, so the generated resume was used.'); }
    }
    const out = await buildPdf(doc, { title: [current.title, current.company].filter(Boolean).join(' at ') || undefined });
    const url = URL.createObjectURL(new Blob([out.bytes], { type: 'application/pdf' }));
    const link = Object.assign(document.createElement('a'), { href: url, download: resumeFilename(current.company, current.title, 'pdf') });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast(`PDF ready: ${out.pages} page${out.pages === 1 ? '' : 's'}.`);
  } catch (err) {
    toast(`Could not make the PDF: ${err.message}`);
  } finally {
    setBusy(button, false);
  }
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
  persistHistory();
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
    ${current?.postingText ? `<button type="button" class="btn tonal block" data-done="regen">${icon('refresh')}Regenerate the resume with my answers</button>` : `<button type="button" class="btn tonal block" data-done="again">Tailor again with my answers</button>`}`;
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
    const questions = input.clarify || [];
    const clarify = questions.map((c, i) => `<li class="clarify"><label for="clar-${i}">Needs your input</label><p>${esc(c)}</p>
      <textarea id="clar-${i}" rows="2" data-q="${esc(c)}" placeholder="Type your answer" aria-label="Your answer"></textarea>
      <div class="chips"><button type="button" class="chip-btn" data-fill="clar-${i}" data-text="Yes">Yes</button><button type="button" class="chip-btn" data-fill="clar-${i}" data-text="No">No</button></div></li>`).join('');
    box.innerHTML = `<p>${esc(input.summary || '')}</p>
      <ul class="cards">${lines || '<li>No new entries. Everything is already in the library.</li>'}${skipped}${clarify}</ul>
      ${questions.length ? '<button type="button" id="revise" class="btn tonal block" disabled>Answer, then update the changes</button>' : ''}
      <div class="row2"><button type="button" id="approve" class="btn primary">${preview.applied.length ? 'Approve and merge' : 'Mark as handled'}</button>
      <button type="button" id="cancel-merge" class="btn">Cancel</button></div><p id="review-msg" class="hint" role="status"></p>`;
    if (questions.length) {
      const refresh = () => { $('revise').disabled = !box.querySelector('textarea[data-q]:not(:placeholder-shown)'); };
      box.addEventListener('input', refresh);
      box.addEventListener('click', (e) => {
        const b = e.target.closest('[data-fill]');
        if (b) { $(b.dataset.fill).value = b.dataset.text; refresh(); }
      });
      $('revise').addEventListener('click', reviseMerge);
    }
    $('approve').addEventListener('click', approveMerge);
    $('cancel-merge').addEventListener('click', () => { $('review-dialog').close(); reviewing = null; });
  } catch (err) {
    box.innerHTML = `<p class="msg" role="alert">${esc(err.message)}</p>`;
  }
}

// Saves the answers to the librarian's questions as notes, then drafts the changes again with them included.
async function reviseMerge() {
  const answers = [...$('review').querySelectorAll('textarea[data-q]')].map((t) => ({ q: t.dataset.q, a: t.value.trim() })).filter((x) => x.a);
  if (!answers.length) return;
  const now = Date.now();
  answers.forEach((x, i) => {
    const text = `Question: ${x.q} Answer: ${x.a}`;
    knowledge = applyAnswer(knowledge, { text }, { action: 'note', text }, new Date(now + i));
  });
  await persist();
  await startMerge();
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

/* ---------- desktop: window title, quick actions, shortcuts, drag and drop ---------- */

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = IS_MAC ? '⌘' : 'Ctrl';
const ALT = IS_MAC ? '⌥' : 'Alt';
const VIEW_NAMES = { tailor: 'Tailor', resume: 'Resume', improve: 'Improve', compare: 'Compare', questions: 'Questions', library: 'Library', history: 'History' };
const VIEW_KEYS = ['tailor', 'resume', 'improve', 'questions', 'library', 'history'];

// The window title shows where you are, and on the Resume and Improve tabs, which resume.
function updateTitle() {
  const view = document.querySelector('.view:not([hidden])')?.dataset.view;
  if (!view || $('app').hidden) { document.title = 'Resume Advisor'; $('toolbar-title').textContent = ''; return; }
  const name = VIEW_NAMES[view] || '';
  const about = current && ['resume', 'improve', 'compare'].includes(view) ? [current.title, current.company].filter(Boolean).join(' at ') : '';
  document.title = `${about ? `${about} – ` : ''}${name} · Resume Advisor`;
  $('toolbar-title').textContent = about ? `${name}  ·  ${about}` : name;
}

const SHORTCUTS = [
  ['Quick actions', `${MOD} K`],
  ['Go to Tailor, Resume, Improve, Questions, Library, History', `${ALT} 1 to 6`],
  ['Ask for a change to the resume', '/'],
  ['Send the change request, or tailor the resume', `${MOD} Enter`],
  ['Copy the whole resume', `${MOD} Shift C`],
  ['Download the PDF', `${MOD} S`],
  ['Show these shortcuts', '?'],
  ['Close a window or the quick actions', 'Esc']
];

function showKeys() {
  $('keys-list').innerHTML = SHORTCUTS.map(([what, keys]) => `<div><dt>${esc(what)}</dt><dd>${keys.split(' ').map((k) => (k === 'to' ? '<span>to</span>' : `<kbd>${esc(k)}</kbd>`)).join('')}</dd></div>`).join('');
  showDialog('keys-dialog');
}

let paletteItems = [];
let paletteActive = 0;

function paletteCommands() {
  const go = (view, key) => ({ group: 'Go to', label: VIEW_NAMES[view], hint: `${ALT} ${key}`, run: () => showView(view) });
  const list = VIEW_KEYS.map((v, i) => go(v, i + 1));
  if (current) {
    list.push(
      { group: 'This resume', label: 'Ask for a change', hint: '/', run: () => askFor('') },
      { group: 'This resume', label: 'Regenerate', run: openRegenerate },
      { group: 'This resume', label: 'Copy the whole resume', hint: `${MOD} Shift C`, run: () => writeClipboard(current.text, 'Copied the full resume.') },
      { group: 'This resume', label: 'Download as PDF', hint: `${MOD} S`, run: () => $('pdf').click() },
      { group: 'This resume', label: 'Download as text', run: download },
      { group: 'This resume', label: 'Compare posting and resume', run: () => openCompare() },
      { group: 'This resume', label: 'Re-check the fit against my library', run: () => { showView('improve'); assessFit(); } }
    );
  }
  list.push(
    { group: 'App', label: 'Change theme', run: cycleTheme },
    { group: 'App', label: 'Settings', run: () => showDialog('settings-dialog') },
    { group: 'App', label: 'Keyboard shortcuts', hint: '?', run: showKeys }
  );
  for (const e of history.slice(0, 15)) list.push({ group: 'Open resume', label: historyLabel(e), hint: shortDate(e.at), run: () => { loadEntry(e); setQuestions([]); showView('resume'); } });
  return list;
}

function renderPalette() {
  const q = $('palette-q').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  paletteItems = paletteCommands().filter((c) => q.every((w) => `${c.group} ${c.label}`.toLowerCase().includes(w)));
  paletteActive = Math.min(paletteActive, Math.max(0, paletteItems.length - 1));
  let last = '';
  $('palette-list').innerHTML = paletteItems.map((c, i) => {
    const head = c.group !== last ? `<li class="palette-group" role="presentation">${esc(c.group)}</li>` : '';
    last = c.group;
    return `${head}<li role="option" id="pal-${i}" data-i="${i}" aria-selected="${i === paletteActive}">${esc(c.label)}${c.hint ? `<kbd>${esc(c.hint)}</kbd>` : ''}</li>`;
  }).join('') || '<li class="palette-none" role="presentation">Nothing matches.</li>';
  $('palette-q').setAttribute('aria-activedescendant', paletteItems.length ? `pal-${paletteActive}` : '');
  $('palette-list').querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
}

function openPalette() {
  if ($('app').hidden) return;
  $('palette-q').value = '';
  paletteActive = 0;
  renderPalette();
  showDialog('palette');
  $('palette-q').focus();
}

function runPalette(i) {
  const item = paletteItems[i];
  if (!item) return;
  $('palette').close();
  setTimeout(item.run, 0);
}

function wireDesktop() {
  for (const k of document.querySelectorAll('kbd[data-key]')) {
    const key = k.dataset.key;
    k.textContent = /^\d$/.test(key) ? `${ALT} ${key}` : `${MOD} ${key}`;
  }
  for (const b of document.querySelectorAll('.icon-btn[aria-label]')) b.title = b.getAttribute('aria-label');
  $('open-palette').addEventListener('click', openPalette);
  $('side-palette').addEventListener('click', openPalette);
  $('side-keys').addEventListener('click', showKeys);
  $('palette-q').addEventListener('input', () => { paletteActive = 0; renderPalette(); });
  $('palette-q').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      paletteActive = (paletteActive + (e.key === 'ArrowDown' ? 1 : -1) + paletteItems.length) % Math.max(1, paletteItems.length);
      renderPalette();
    } else if (e.key === 'Enter') { e.preventDefault(); runPalette(paletteActive); }
  });
  $('palette-list').addEventListener('click', (e) => { const li = e.target.closest('[data-i]'); if (li) runPalette(Number(li.dataset.i)); });
  $('palette-list').addEventListener('mousemove', (e) => {
    const li = e.target.closest('[data-i]');
    if (li && Number(li.dataset.i) !== paletteActive) { paletteActive = Number(li.dataset.i); for (const o of $('palette-list').querySelectorAll('[data-i]')) o.setAttribute('aria-selected', String(o === li)); }
  });
  $('palette').addEventListener('click', (e) => { if (e.target === $('palette')) $('palette').close(); });

  document.addEventListener('keydown', (e) => {
    if ($('app').hidden) return;
    const mod = IS_MAC ? e.metaKey : e.ctrlKey;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    const open = document.querySelector('dialog[open]');
    if (mod && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); if ($('palette').open) $('palette').close(); else openPalette(); return; }
    if (open) return;
    if (e.altKey && !mod && /^Digit[1-6]$/.test(e.code)) { e.preventDefault(); showView(VIEW_KEYS[Number(e.code.slice(5)) - 1]); return; }
    if (mod && !e.altKey && current) {
      const k = e.key.toLowerCase();
      if (k === 's' && !e.shiftKey) { e.preventDefault(); $('pdf').click(); return; }
      if (k === 'c' && e.shiftKey) { e.preventDefault(); writeClipboard(current.text, 'Copied the full resume.'); return; }
    }
    if (mod && e.key === '/') { e.preventDefault(); showKeys(); return; }
    if (typing || mod || e.altKey) return;
    if (e.key === '/' && current) { e.preventDefault(); askFor(''); }
    else if (e.key === '?') { e.preventDefault(); showKeys(); }
  });

  // Drop a posting onto the Tailor page: text from a browser, or a plain text file.
  const zone = $('v-tailor');
  const hasPayload = (e) => [...(e.dataTransfer?.types || [])].some((t) => t === 'Files' || t === 'text/plain');
  zone.addEventListener('dragover', (e) => { if (!hasPayload(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; zone.classList.add('dragging'); });
  zone.addEventListener('dragleave', (e) => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('dragging'); });
  zone.addEventListener('drop', async (e) => {
    zone.classList.remove('dragging');
    if (!hasPayload(e)) return;
    e.preventDefault();
    const file = [...(e.dataTransfer.files || [])].find((f) => /^text\/|\.(txt|md|text)$/i.test(f.type + f.name));
    if (file) acceptPasted(await file.text());
    else if (e.dataTransfer.files?.length) toast('Drop a text file, or text copied from the posting.');
    else acceptPasted(e.dataTransfer.getData('text/plain'));
  });
}

/* ---------- history ---------- */

function renderHistory() {
  renderRecent();
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

// The last few resumes, on the Tailor screen, so picking one back up is a single tap.
function renderRecent() {
  const recent = history.slice(0, 3);
  $('recent').hidden = recent.length === 0;
  $('recent-list').innerHTML = recent.map((e) => `<li data-id="${esc(e.id)}"><span>${esc(historyLabel(e))}</span><span>${esc(shortDate(e.at))}</span></li>`).join('');
}

function onHistoryClick(event) {
  const card = event.target.closest('.hcard');
  if (!card) return;
  const entry = history.find((e) => e.id === card.dataset.id);
  if (!entry) return;
  if (event.target.closest('[data-open]')) { loadEntry(entry); setQuestions([]); showView('resume'); }
  if (event.target.closest('[data-delete]')) {
    history = removeHistory(history, entry.id);
    persistHistory();
    renderHistory();
    toast('Deleted.');
  }
}

function onHistoryChange(event) {
  const select = event.target.closest('[data-status]');
  const card = event.target.closest('.hcard');
  if (!select || !card) return;
  history = updateEntry(history, card.dataset.id, { status: select.value });
  persistHistory();
}

/* ---------- start-up ---------- */

async function init() {
  hydrateIcons();
  applyTheme(themeMode());
  $('auto-suggest').checked = store.get(AUTOSUGGEST_STORE) !== '0';
  $('model').innerHTML = MODELS.map((m) => `<option value="${m.id}">${esc(m.label)}</option>`).join('');
  const savedModel = store.get('resume-advisor-model');
  if (MODELS.some((m) => m.id === savedModel)) $('model').value = savedModel;
  history = store.json(HISTORY_STORE, []);
  renderHistory();

  try { await loadProfile(); } catch (err) { $('login-msg').textContent = err.message; }
  $('link-field').hidden = !LINK_READING;
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
  for (const id of ['applink', 'notes', 'shorttitles', 'personal']) {
    $(id).addEventListener('input', () => {
      // A posting read from one link is stale once the link changes.
      if (id === 'applink' && posting.source === 'link' && normalizeUrl($('applink').value) !== posting.link) setPosting('', '');
      saveDraft();
      updateLinkUi();
    });
  }
  $('applink').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('gen').requestSubmit(); } });
  $('fetch').addEventListener('click', async () => {
    const link = normalizeUrl($('applink').value);
    if (!link) return;
    $('applink').value = link;
    setBusy($('fetch'), true, 'Reading...');
    try { await fillPostingFromLink(link, $('gen-msg')); } finally { setBusy($('fetch'), false); }
  });
  $('paste-catch').addEventListener('paste', (e) => { e.preventDefault(); acceptPasted(e.clipboardData?.getData('text/plain')); });
  $('paste-catch').addEventListener('input', (e) => { if (/^insertFrom(Paste|Drop)/.test(e.inputType || '')) acceptPasted($('paste-catch').value); });
  $('paste').addEventListener('click', async () => {
    try { acceptPasted(await navigator.clipboard.readText()); }
    catch { $('paste-catch').focus(); toast('Press and hold in the box, then choose Paste.'); }
  });
  $('clear-posting').addEventListener('click', () => setPosting('', ''));
  $('view-posting').addEventListener('click', () => {
    $('posting-view').textContent = posting.text;
    $('posting-source-note').textContent = posting.source === 'link' ? `Read from ${posting.link}` : 'Pasted from your clipboard. This text is used as it is.';
    showDialog('posting-dialog');
  });
  $('toggle-notes').addEventListener('click', () => setNotesOpen($('notes-field').hidden));
  // resume
  $('regen').addEventListener('click', openRegenerate);
  $('composer').addEventListener('submit', sendComposer);
  $('composer-text').addEventListener('input', growComposer);
  $('composer-text').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('composer').requestSubmit(); } });
  for (const id of ['fit-strip', 'fit-detail']) {
    $(id).addEventListener('click', (e) => {
      if (e.target.closest('[data-fit="again"]')) { assessFit(); return; }
      const ask = e.target.closest('[data-ask]');
      if (ask) { const r = currentScores()?.rows[Number(ask.dataset.ask)]; if (r) askFor(`Show my experience with ${r.text.replace(/[.\s]+$/, '')}.`); return; }
    });
  }
  $('regen-banner-go').addEventListener('click', regenerateWithAnswers);
  $('regen-go').addEventListener('click', regenerate);
  $('regen-ideas').addEventListener('click', (e) => {
    const b = e.target.closest('[data-idea]');
    if (!b) return;
    const t = $('regen-notes');
    if (!t.value.includes(b.dataset.idea)) t.value = `${t.value.trim()} ${b.dataset.idea}`.trim();
    navigator.vibrate?.(6);
  });
  $('copy').addEventListener('click', () => writeClipboard(current.text, 'Copied the full resume.'));
  $('download').addEventListener('click', download);
  $('pdf').addEventListener('click', () => { if (editing) toggleEdit(); makePdf(); });
  $('suggestions').addEventListener('click', onSuggestion);
  $('sug-more').addEventListener('click', () => suggestMore());
  $('sug-all').addEventListener('click', applyAll);
  $('sum-gen').addEventListener('click', writeSummaries);
  $('sum-restore').addEventListener('click', restoreSummary);
  $('sum-options').addEventListener('click', (e) => { const li = e.target.closest('li[data-i]'); if (li && e.target.closest('[data-sum]')) useSummary(Number(li.dataset.i)); });
  $('open-improve').addEventListener('click', () => showView('improve'));
  $('open-history').addEventListener('click', () => showView('history'));
  wireDesktop();
  $('open-compare-top').addEventListener('click', () => openCompare());
  $('open-compare').addEventListener('click', () => openCompare());
  $('kw-chips').addEventListener('click', (e) => { const b = e.target.closest('button[data-k]'); if (b) openCompare(Number(b.dataset.k)); });
  $('cmp-chips').addEventListener('click', (e) => { const b = e.target.closest('button[data-k]'); if (b) focusTerm(Number(b.dataset.k)); });
  $('compare-back').addEventListener('click', () => showView(lastView === 'compare' ? 'resume' : lastView));
  for (const b of document.querySelectorAll('.seg button')) b.addEventListener('click', () => { cmp.mode = b.dataset.pane; renderCompare(); });
  $('cmp-detail').addEventListener('click', async (e) => {
    if (!e.target.closest('#cmp-find')) return;
    const term = kwList()[cmp.active];
    await suggestMore([term]);
    showView('improve');
  });
  $('cmp-posting-body').addEventListener('click', (e) => { if (e.target.closest('#cmp-paste')) pastePostingIntoEntry(); });
  $('auto-suggest').addEventListener('change', () => store.set(AUTOSUGGEST_STORE, $('auto-suggest').checked ? '1' : '0'));
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
    else if (b.dataset.done === 'regen') regenerateWithAnswers();
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
  $('recent-list').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-id]');
    const entry = li && history.find((h) => h.id === li.dataset.id);
    if (entry) { loadEntry(entry); setQuestions([]); showView('resume'); }
  });
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
