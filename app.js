import {
  MODELS, buildRequest, validateResult, buildDoc, renderText, renderHtml, escapeHtml, groupLookup,
  sectionTexts, typo, markTerms, yearsSince, normalizeUrl, keywordCoverage, resumeStats, resumeFilename, buildFetchRequest, readFetchedPosting, sourceTextLookup, addBulletToDoc
} from './lib.js?v=33';
import { buildPdf, docFromText, estimateLayout } from './pdf.js?v=33';
import {
  atsLint, checkSuggestions, applySuggestion, buildSuggestRequest,
  buildSummaryRequest, checkSummaries
} from './ats.js?v=33';
import { icon, hydrateIcons } from './icons.js?v=33';
import {
  emptyKnowledge, normalizeKnowledge, answersSince, applyAnswer, removeEntry, filterQuestions, liveEntries, pendingItems, markMerged
} from './knowledge.js?v=33';
import { syncKnowledge, updateLibrary, pullFile, PROFILE_PATH } from './sync.js?v=33';
import { cleanPosting, postingUrl, siteOf } from './posting.js?v=33';
import { checkDeadline, findDeadline, deadlineState, icsFor } from './deadline.js?v=33';
import { KINDS, buildFormatRequest, checkStructure, structureLocal, renderPostingText } from './postingdoc.js?v=33';
import { buildDraftRequest, checkDrafts } from './bullets.js?v=33';
import { buildFitRequest, buildJudgeRequest, checkVerdicts, checkFit, fitScores, citedIdsOf, fingerprint } from './fit.js?v=33';
import { buildLibrarianRequest, applyPatch, describeOp } from './library.js?v=33';
import { STATUSES, addEntry, updateEntry, removeEntry as removeHistory, label as historyLabel } from './history.js?v=33';

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
  toast('Storage full');
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
  toast(THEME_NAMES[next]);
}

/* ---------- navigation ---------- */

let lastView = 'tailor';
let inspectorTab = 'fit';
const TABS = ['fit', 'terms', 'edits', 'checks', 'questions'];

// One stage (tailor, resume, compare, library) and, beside a resume, the inspector with its tabs.
// Older names still work: "improve" opens the inspector on Fit, "questions" on Ask, "history" is the rail.
function showView(name, tab) {
  if (name === 'history') name = 'tailor';
  if (name === 'improve') { name = 'resume'; tab = tab || 'fit'; }
  if (name === 'questions') { name = 'resume'; tab = tab || 'questions'; }
  if (!current && (name === 'resume' || name === 'compare')) name = 'tailor';
  if (name === 'posting' && !postingById(postingId)) name = 'tailor';
  if (name !== 'compare') lastView = name;
  for (const v of document.querySelectorAll('.view')) v.hidden = v.dataset.view !== name;
  for (const t of document.querySelectorAll('#tabbar [data-view]')) {
    const on = t.dataset.view === name;
    if (on) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
  }
  document.body.dataset.view = name;
  renderRailMarks();
  $('inspector').hidden = !current || !['resume', 'compare'].includes(name);
  if (tab && TABS.includes(tab)) { inspectorTab = tab; if (!panels.insOpen) setPanel('ins', true); }
  if (name === 'compare' && !panels.insOpen) { /* compare keeps the panel as the user left it */ }
  showTab(inspectorTab);
  $('main').scrollTop = 0;
  $('toast').hidden = true;
  updateTitle();
}

function showTab(name) {
  inspectorTab = TABS.includes(name) ? name : 'fit';
  for (const t of document.querySelectorAll('#inspector [data-tab]')) t.setAttribute('aria-selected', String(t.dataset.tab === inspectorTab));
  for (const p of document.querySelectorAll('#inspector [data-panel]')) p.hidden = p.dataset.panel !== inspectorTab;
}

function show(signedIn) {
  $('login').hidden = signedIn;
  $('app').hidden = !signedIn;
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
  $('open-questions').innerHTML = open.map((q) => `<li>${esc(q)}</li>`).join('') || '<li class="none-yet">None</li>';
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
      rows.push(`<li>${esc(describeEntry(collection, key, e))} <button type="button" class="link-btn" data-collection="${collection}" data-key="${esc(key)}">Remove</button></li>`);
    }
  }
  $('saved').innerHTML = rows.join('') || '<li class="none-yet">None</li>';
  $('saved-count').textContent = rows.length ? String(rows.length) : '';
  renderBadges();
}

function renderBadges() {
  const pending = pendingItems(knowledge).length;
  $('merge-card').hidden = pending === 0;
  $('merge-title').textContent = `${pending} to merge`;
  const lib = $('badge-l');
  lib.hidden = pending === 0;
  lib.textContent = String(pending);
  const open = qState.filter((s) => s === 'open' || s === 'skipped').length;
  const qb = $('badge-q');
  qb.hidden = open === 0;
  qb.textContent = String(open);
  renderRegenBanner();
}

/* ---------- postings: import, clean, format, keep ---------- */

// A posting can be read from its link (Anthropic's web fetch) when the page carries its text; pages built with
// scripts cannot be read, and pasting the text is the fallback. Set this to false to hide the link field.
const LINK_READING = true;
const POSTINGS_STORE = 'resume-advisor-postings';
const POSTINGS_CAP = 60;

let postings = [];          // newest first
let postingId = '';         // the posting on screen
let importing = false;

const postingById = (id) => postings.find((p) => p.id === id);
const postingResumes = (id) => history.filter((e) => e.postingId === id);

function persistPostings() {
  while (!store.set(POSTINGS_STORE, JSON.stringify(postings))) {
    // Out of room: the cleaned copy is only for formatting again, so drop it from the oldest posting first.
    const old = [...postings].reverse().find((p) => p.cleaned);
    if (!old) { toast('Storage full'); return; }
    delete old.cleaned;
  }
}

function saveDraft() {
  store.set(DRAFT_STORE, JSON.stringify({ applink: $('applink').value, shorttitles: $('shorttitles').checked, personal: $('personal').checked }));
}

function restoreDraft() {
  const d = store.json(DRAFT_STORE, null);
  if (d) {
    $('applink').value = LINK_READING ? d.applink || '' : '';
    $('shorttitles').checked = Boolean(d.shorttitles);
    $('personal').checked = d.personal !== false;
  }
  updateLinkUi();
}

function updateLinkUi() {
  $('fetch').hidden = !normalizeUrl($('applink').value);
}

const importMsg = (text) => { $('gen-msg').textContent = text; };

function setImporting(on) {
  importing = on;
  $('paste-empty').classList.toggle('busy', on);
  $('paste').disabled = on;
  $('paste-catch').disabled = on;
}

const newId = (prefix) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

function makePosting(s, cleaned, { link, source, by }) {
  const p = {
    id: newId('p'), at: new Date().toISOString(), title: s.title || 'Job posting', company: s.company, location: s.location, jobType: s.jobType, pay: s.pay,
    reference: s.reference, deadline: s.deadline || null, link: link || '', source, by, sections: s.sections, cleaned
  };
  p.text = renderPostingText(p);
  return p;
}

// Sorts the cleaned posting into the fixed structure: Claude files it (copying only), and if that fails the plain
// sorter does it, so an import always succeeds.
async function structurePosting(cleaned) {
  try {
    const out = checkStructure(await askClaude(buildFormatRequest(cleaned), 'file_posting'), cleaned);
    if (out.sections.length) return { s: out, by: 'claude' };
  } catch { /* fall back */ }
  return { s: structureLocal(cleaned), by: 'local' };
}

// The whole import: clean, file, keep, and open it.
async function importPosting(raw, { link = '', source = 'pasted' } = {}) {
  if (importing) return false;
  const cleaned = cleanPosting(raw);
  if (cleaned.length < 40) { toast('Too short'); return false; }
  const twin = postings.find((p) => (link && p.link === link) || p.cleaned === cleaned);
  if (twin) { openPosting(twin.id); toast('Already imported'); return true; }
  setImporting(true);
  try {
    importMsg('Formatting…');
    const { s: structured, by } = await structurePosting(cleaned);
    const p = makePosting(structured, cleaned, { link: link || normalizeUrl($('applink').value) || '', source, by });
    postings = [p, ...postings].slice(0, POSTINGS_CAP);
    persistPostings();
    importMsg('');
    $('applink').value = '';
    saveDraft();
    updateLinkUi();
    renderRail();
    openPosting(p.id);
    toast(by === 'claude' ? 'Imported' : 'Imported, basic format');
    return true;
  } finally {
    setImporting(false);
  }
}

// Accepts text or a web address from the clipboard, a drop, or the box.
function acceptPasted(raw) {
  $('paste-catch').value = '';
  const url = postingUrl(raw);
  if (url) { $('applink').value = url; saveDraft(); updateLinkUi(); readLinkNow(); return true; }
  importPosting(raw, { source: 'pasted' });
  return true;
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
  ? `${sentence(message)} Web fetch must be allowed for your Anthropic organization. Paste the text instead.`
  : `${sentence(message)} Paste the text instead.`);

async function readLinkNow() {
  const link = normalizeUrl($('applink').value);
  if (!link || importing) return;
  $('applink').value = link;
  saveDraft();
  setBusy($('fetch'), true, 'Reading…');
  $('fetch').hidden = false;
  importMsg('Reading…');
  try {
    const got = await readPostingFromLink(link);
    if (!got.ok) { importMsg(fetchHint(`Could not read the page: ${got.problem}`)); $('paste-catch').focus(); return; }
    await importPosting(got.text, { link, source: 'link' });
  } catch (err) {
    importMsg(fetchHint(`Could not read the page: ${err.message}`));
    $('paste-catch').focus();
  } finally {
    setBusy($('fetch'), false);
    updateLinkUi();
  }
}

/* ---------- the posting on screen ---------- */

function openPosting(id) {
  if (!postingById(id)) return;
  postingId = id;
  renderPostingView();
  showView('posting');
}

function renderPostingView() {
  const p = postingById(postingId);
  if (!p) return;
  $('pst-title').textContent = p.title;
  $('pst-sub').textContent = [p.company, p.location].filter(Boolean).join(' · ');
  const site = p.link ? siteOf(p.link) : null;
  $('pst-link').hidden = !site;
  if (site) { $('pst-link').href = p.link; $('pst-host').textContent = site.host; $('pst-logo').innerHTML = siteLogo(site, 18); }
  const resumes = postingResumes(p.id);
  const open = resumes.every((r) => isOpen(r.status));
  const chip = $('pst-deadline');
  if (p.deadline && open) {
    const st = deadlineState(p.deadline.date);
    chip.hidden = false;
    chip.className = `stat stat-btn due ${st.tone}`;
    chip.innerHTML = `${icon('calendar')}${esc(st.text)}`;
    chip.title = `${p.deadline.quote}\nClick to add it to your calendar.`;
  } else chip.hidden = true;

  const facts = [p.jobType, p.pay, p.reference && `Ref ${p.reference}`].filter(Boolean);
  const specs = KINDS.reduce((m, k) => m.set(k.kind, k), new Map());
  $('pst-body').innerHTML = `${facts.length ? `<p class="pst-facts">${facts.map((f) => `<span>${esc(f)}</span>`).join('')}</p>` : ''}
    ${p.sections.map((sec) => {
      const spec = specs.get(sec.kind);
      return `<section class="pst-sec"><h3>${esc(spec.heading)}</h3>${spec.bullets
        ? `<ul>${sec.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`
        : sec.items.map((i) => `<p>${esc(i)}</p>`).join('')}</section>`;
    }).join('')}
    <p class="pst-foot">${wordCount(p.text).toLocaleString('en-US')} words · ${p.by === 'claude' ? 'Filed by Claude' : 'Basic format'}</p>`;

  const box = $('pst-resumes');
  box.hidden = resumes.length === 0;
  box.innerHTML = resumes.length ? `<h3>Resumes</h3><ul class="pst-cards">${resumes.map((r) => {
    const sc = r.fit?.requirements?.length ? fitScores(r.fit.requirements, r.text, r.text === (r.originalText || r.text) ? new Set(r.citedIds || []) : null) : null;
    return `<li data-id="${esc(r.id)}"><button type="button" class="pst-card" data-open-resume><span class="dot ${statusDot(r.status)}"></span>
      <span class="pst-card-text"><strong>${esc(r.location || 'Resume')}</strong><span>${esc(shortDate(r.at))} · ${esc(r.status || 'Drafted')}</span></span>
      ${sc ? `<span class="pst-scores"><b>${sc.library}</b><b>${sc.draft}</b></span>` : ''}</button></li>`;
  }).join('')}</ul>` : '';
}

function downloadDeadlineFor(deadline, title) {
  if (!deadline) return;
  const url = URL.createObjectURL(new Blob([icsFor({ date: deadline.date, title })], { type: 'text/calendar;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `deadline-${deadline.date}.ics` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  toast('Calendar file saved');
}

async function reformatPosting() {
  const p = postingById(postingId);
  if (!p?.cleaned) { toast('Nothing to format again'); return; }
  setBusy($('pst-reformat'), true, '…');
  try {
    const { s, by } = await structurePosting(p.cleaned);
    Object.assign(p, { title: s.title || p.title, company: s.company, location: s.location, jobType: s.jobType, pay: s.pay, reference: s.reference, deadline: s.deadline || null, sections: s.sections, by });
    p.text = renderPostingText(p);
    persistPostings();
    renderRail();
    renderPostingView();
    toast(by === 'claude' ? 'Formatted' : 'Basic format');
  } finally {
    setBusy($('pst-reformat'), false);
  }
}

function deletePosting() {
  const p = postingById(postingId);
  if (!p) return;
  const before = { postings, history, current };
  postings = postings.filter((x) => x.id !== p.id);
  history = history.filter((e) => e.postingId !== p.id);
  persistPostings();
  persistHistory();
  if (current?.postingId === p.id) current = null;
  postingId = '';
  renderRail();
  showView('tailor');
  toast('Deleted', { label: 'Undo', run: () => { ({ postings, history } = before); current = before.current; persistPostings(); persistHistory(); renderRail(); openPosting(p.id); } });
}

// Resumes made before postings were kept as their own records each get a posting of their own.
function migratePostings() {
  let changed = false;
  const byText = new Map();
  for (const e of history) {
    if (e.postingId && postingById(e.postingId)) continue;
    const raw = e.postingText || '';
    if (!raw) continue;
    const cleaned = cleanPosting(raw);
    let p = byText.get(cleaned);
    if (!p) {
      const s = structureLocal(cleaned);
      p = makePosting({ ...s, title: e.title || s.title, company: e.company || s.company, location: s.location || '', deadline: e.deadline ?? s.deadline }, cleaned, { link: e.link || '', source: 'pasted', by: 'local' });
      p.at = e.at;
      postings.push(p);
      byText.set(cleaned, p);
    }
    e.postingId = p.id;
    delete e.postingText;
    changed = true;
  }
  if (changed) {
    postings.sort((a, b) => (a.at < b.at ? 1 : -1));
    persistPostings();
    persistHistory();
  }
}

/* ---------- building a resume from the posting on screen ---------- */

function setNotesOpen(open) {
  $('notes-field').hidden = !open;
  $('toggle-notes').setAttribute('aria-expanded', String(open));
  $('toggle-notes').classList.toggle('on', open);
}

async function generate(event) {
  event.preventDefault();
  const msg = $('pst-msg');
  msg.textContent = '';
  const p = postingById(postingId);
  if (!p) return;
  if (!$('location').value) { msg.textContent = 'Choose a location'; $('location').focus(); return; }

  const opts = { includePersonalLine: $('personal').checked, locationId: $('location').value, shortTitles: $('shorttitles').checked };
  store.set(LOCATION_STORE, opts.locationId);
  saveDraft();
  setBusy($('go'), true, 'Working…');
  try {
    const req = buildRequest(profile, { posting: p.text, notes: $('notes').value, knowledge, ...opts });
    msg.textContent = 'Building… about 40 seconds';
    const input = await askClaude(req, 'submit_resume');
    const issues = validateResult(input, profile, { ...opts, knowledge });
    acceptResult(input, issues, opts, p.link, { notes: $('notes').value, source: { text: p.text, deadline: p.deadline, postingId: p.id, title: p.title, company: p.company } });
    msg.textContent = '';
    $('notes').value = '';
    setNotesOpen(false);
  } catch (err) {
    msg.textContent = err.message;
  } finally {
    setBusy($('go'), false);
  }
}

// replaceId: regenerate this history entry in place instead of adding a new one. source: where the posting came from.
function acceptResult(result, issues, opts, link, { replaceId = '', source, notes = '' } = {}) {
  let doc = buildDoc(result, profile, { ...opts, knowledge });
  // Bullets Kevin wrote into this resume stay when it is rebuilt.
  const extras = replaceId ? current.extras || [] : [];
  for (const x of extras) doc = addBulletToDoc(doc, profile, x.role_id, x.text, { knowledge }).doc;
  const text = renderText(doc);
  const locationLabel = profile.contact.locations.find((l) => l.id === opts.locationId)?.label || '';
  const known = sourceTextLookup(profile, { includePersonalLine: opts.includePersonalLine, knowledge });
  const entryData = {
    title: source.title || result.posting_title || '', company: source.company || result.company || '', link: link || '', postingId: replaceId ? current.postingId : source.postingId, location: locationLabel,
    text, originalText: text, doc, issues, keywords: keywordCoverage(result.posting_keywords, text), fit: replaceId ? current.fit : null, citedIds: citedIdsOf(result), deadline: replaceId ? current.deadline : source.deadline !== undefined ? source.deadline : checkDeadline(result, source.text) || findDeadline(source.text),
    postingKeywords: result.posting_keywords || [], suggestions: checkSuggestions(result.suggestions, { doc, knownText: known, libraryText: known.all() }),
    postingText: (replaceId ? current.postingId : source.postingId) ? '' : (source.text || '').slice(0, 15000), summaryOptions: [], summaryOriginal: '',
    generatedAt: new Date().toISOString(), extras,
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
  if (!replaceId) toast(n ? `Ready · ${n} question${n === 1 ? '' : 's'}` : 'Ready', n ? { label: 'Answer', run: () => showView('resume', 'questions') } : null);
  if (!current.fit || current.fit.hash !== fingerprint(profile)) assessFit();
  if (store.get(AUTOSUGGEST_STORE) !== '0' && current.keywords.missing.length) autoSuggest();
}

/* ---------- posting fit: the library against the posting, and the draft against the posting ---------- */

let assessingId = '';

const SCORE_HELP = 'Library: how much of the posting your library supports. Draft: how much of that this resume shows. Required counts 3 times, related counts half. Rounded down.';

function currentScores() {
  const c = current;
  if (!c?.fit?.requirements?.length) return null;
  return fitScores(c.fit.requirements, c.text, c.edited ? null : new Set(c.citedIds || []));
}

// Requirements the library does not support: a draft bullet to edit, the employer to put it under, and whether to
// keep it in the library. Nothing is added until Kevin presses Add.
function roleOptions(selected) {
  const roles = profile.roles.filter((r) => r.status === 'verified');
  const years = (r) => `${String(r.start).slice(0, 4)}\u2013${r.end ? String(r.end).slice(0, 4) : 'now'}`;
  return `<option value="">Employer</option>${roles.map((r) => `<option value="${esc(r.id)}"${r.id === selected ? ' selected' : ''}>${esc(r.org)} \u00b7 ${esc(r.title)} (${years(r)})</option>`).join('')}`;
}

function missingGroup(scores) {
  const rows = scores.rows.map((r, i) => [r, i]).filter(([r]) => r.state === 'missing');
  if (!rows.length) return '';
  const reqs = current.fit.requirements;
  const undrafted = rows.filter(([, i]) => !reqs[i].draft).map(([, i]) => i);
  const card = ([r, i]) => {
    const d = reqs[i].draft;
    return `<li class="req missing" data-req="${i}"><div class="req-top"><span class="req-text">${esc(r.text)}</span><span class="tag ${r.weight === 'must' ? '' : 'role'}" title="${r.weight === 'must' ? 'Required' : 'Preferred'}">${r.weight === 'must' ? 'Req' : 'Pref'}</span></div>
      <p class="req-note">${esc(r.note)}</p>
      ${d ? `<div class="bullet-ed"><textarea data-draft-text rows="3" aria-label="Bullet">${esc(d.text)}</textarea>
        <select data-draft-role aria-label="Employer">${roleOptions(d.role_id)}</select>
        <div class="bullet-row"><label class="toggle"><input type="checkbox" data-draft-lib${d.library === false ? '' : ' checked'}><span>Library</span></label>
          <button type="button" class="btn small primary" data-draft-add="${i}"><span>Add</span></button></div>
        <p class="msg" data-draft-msg role="status"></p></div>`
        : `<button type="button" class="btn small" data-draft="${i}">${icon('sparkle')}<span>Write</span></button>`}</li>`;
  };
  return `<details class="fold req-group" open><summary><span>Missing</span><span class="count">${rows.length}</span></summary>
    ${undrafted.length > 1 ? `<div class="btn-row"><button type="button" class="btn small" data-draft="${undrafted.join(',')}">${icon('sparkle')}<span>${drafting ? 'Writing\u2026' : 'Write all'}</span></button></div>` : ''}
    <ul class="cards">${rows.map(card).join('')}</ul></details>`;
}

let drafting = false;
let recalculating = false;

// Recalculates the draft score on request. Matching on the posting's terms can miss a bullet that says the same
// thing in other words, so Claude reads the resume against each supported requirement and must quote the passage
// that shows it; the quote has to be in the resume, or it does not count.
async function recalculateDraft() {
  if (recalculating || !current?.fit) return;
  const reqs = current.fit.requirements;
  const targets = reqs.map((r, i) => ({ index: i, text: r.text, keywords: r.keywords, ok: r.support !== 'none' && !r.addedOnly })).filter((t) => t.ok).map(({ ok, ...t }) => t);
  const id = current.id;
  const before = currentScores()?.draft;
  recalculating = true;
  renderFit();
  try {
    if (targets.length) {
      const quotes = checkVerdicts(await askClaude(buildJudgeRequest(targets, current.text), 'judge_draft'), targets, current.text);
      if (current?.id !== id) return;
      for (const t of targets) { if (quotes[t.index]) reqs[t.index].shownQuote = quotes[t.index]; else delete reqs[t.index].shownQuote; }
      current.fit.judgedAt = new Date().toISOString();
      saveEntry({ fit: current.fit });
    }
    const after = currentScores()?.draft;
    toast(before === after ? `Draft ${after}, unchanged` : `Draft ${before} \u2192 ${after}`);
  } catch (err) {
    toast(err.message);
  } finally {
    recalculating = false;
    if (current?.id === id) renderFit();
  }
}

async function draftBullets(indexes) {
  if (drafting || !current?.fit) return;
  const reqs = current.fit.requirements;
  const targets = indexes.filter((i) => reqs[i] && !reqs[i].draft).map((i) => ({ index: i, text: reqs[i].text, keywords: reqs[i].keywords }));
  if (!targets.length) return;
  const id = current.id;
  drafting = true;
  toast('Writing\u2026');
  try {
    const opts = { includePersonalLine: $('personal').checked, knowledge };
    const input = await askClaude(buildDraftRequest(profile, targets, opts), 'draft_bullets');
    const drafts = checkDrafts(input, targets, profile.roles.filter((r) => r.status === 'verified').map((r) => r.id));
    if (current?.id !== id) return;
    for (const [i, d] of Object.entries(drafts)) reqs[Number(i)].draft = { ...d, library: true };
    if (!Object.keys(drafts).length) toast('Nothing to write'); else toast('Edit, choose an employer, then Add');
    saveEntry({ fit: current.fit });
  } catch (err) {
    toast(err.message);
  } finally {
    drafting = false;
    if (current?.id === id) renderFit();
  }
}

// Puts the edited bullet under the chosen employer in this resume and, if Library is on, saves it as a fact that
// belongs to that employer (it joins the library for every resume, and can be merged into the profile file).
async function addRequirementBullet(i) {
  const req = current?.fit?.requirements[i];
  const d = req?.draft;
  if (!d) return;
  const say = (text) => { const el = document.querySelector(`#fit-detail [data-req="${i}"] [data-draft-msg]`); if (el) el.textContent = text; };
  if (current.edited) { say('Revert edits first'); return; }
  const text = d.text.replace(/\s+/g, ' ').trim();
  const res = addBulletToDoc(current.doc, profile, d.role_id, text, { knowledge });
  if (!res.ok) { say(res.reason); return; }
  const toLibrary = d.library !== false;
  if (toLibrary) {
    knowledge = applyAnswer(knowledge, { topic: `requirement ${req.text}`, text: `Added from a posting requirement: ${req.text}`, role_id: d.role_id }, { action: 'fact', text });
    await persist();
  }
  current.doc = res.doc;
  current.extras = [...(current.extras || []), { role_id: d.role_id, text }];
  Object.assign(req, toLibrary
    ? { support: 'strong', source_ids: [], note: 'Added by you, and saved to your library.', addedBy: 'you', addedText: text }
    : { addedOnly: true, note: 'Added to this resume only.', addedBy: 'you', addedText: text });
  delete req.draft;
  finishChange({ extras: current.extras, fit: current.fit });
  toast(toLibrary ? 'Added' : 'Added here', toLibrary ? { label: 'Merge', run: startMerge } : null);
}

function renderFit() {
  const c = current;
  const strip = $('fit-strip');
  const detail = $('fit-detail');
  if (!c) return;
  const busy = assessingId === c.id;
  const scores = currentScores();
  const stale = Boolean(c.fit && c.fit.hash !== fingerprint(profile));

  // Compact scores beside the resume.
  strip.hidden = !(busy || scores || c.fitError || c.postingText);
  if (scores) strip.innerHTML = `<button type="button" class="fit-chip" data-tab="fit" title="${esc(SCORE_HELP)}"><span>Library</span><b>${scores.library}</b><span>Draft</span><b>${scores.draft}</b></button>`;
  else strip.innerHTML = `<button type="button" class="fit-chip" data-tab="fit"><span>Fit</span><b>${busy ? '…' : '—'}</b></button>`;

  // The Fit tab.
  const again = (label) => `<button type="button" class="btn block" data-fit="again"><i data-icon="refresh"></i><span>${label}</span></button>`;
  if (!scores) {
    detail.innerHTML = busy ? '<p class="none-yet" role="status">Scoring…</p>' : `${c.fitError ? `<p class="msg">${esc(c.fitError)}</p>` : ''}${again('Score')}`;
    hydrateIcons(detail);
    return;
  }
  const gap = scores.library - scores.draft;
  const row = (r, i) => `<li class="req ${r.state}"><div class="req-top"><span class="req-text">${esc(r.text)}</span><span class="tag ${r.weight === 'must' ? '' : 'role'}" title="${r.weight === 'must' ? 'Required' : 'Preferred'}">${r.weight === 'must' ? 'Req' : 'Pref'}</span></div>
      <p class="req-note">${esc(r.note)}${r.support === 'partial' ? ' <em>Related.</em>' : ''}</p>
      ${r.state === 'shown' && r.shownQuote ? `<p class="req-quote">\u201c${esc(r.shownQuote.slice(0, 140))}\u201d</p>` : ''}
      ${r.state === 'unused' ? `<button type="button" class="btn small" data-ask="${i}">${icon('send')}<span>Ask</span></button>` : ''}</li>`;
  const group = (state, title, open) => {
    const rows = scores.rows.map((r, i) => [r, i]).filter(([r]) => r.state === state);
    return rows.length ? `<details class="fold req-group"${open ? ' open' : ''}><summary><span>${title}</span><span class="count">${rows.length}</span></summary><ul class="cards">${rows.map(([r, i]) => row(r, i)).join('')}</ul></details>` : '';
  };
  detail.innerHTML = `<div class="scores" title="${esc(SCORE_HELP)}">
      <div class="score lib"><span class="label">Library</span><strong>${scores.library}</strong><span class="meter lib" role="img" aria-label="Library ${scores.library} of 100"><i style="width:${scores.library}%"></i></span></div>
      <div class="score draft"><span class="label">Draft<button type="button" class="icon-btn mini" data-recalc aria-label="Recalculate the draft score" title="Recalculate the draft score"${recalculating ? ' aria-busy="true"' : ''}>${icon('refresh')}</button></span><strong>${scores.draft}</strong><span class="meter draft" role="img" aria-label="Draft ${scores.draft} of 100"><i style="width:${scores.draft}%"></i></span></div>
    </div>
    ${gap > 0 ? `<p class="fit-gap">${gap} points unused</p>` : ''}
    ${group('unused', 'Unused', true)}${group('shown', 'Shown', false)}${missingGroup(scores)}
    ${stale ? '<p class="fit-stale" role="status">Library changed</p>' : ''}
    ${again('Rescore')}`;
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
  if (n) $('regen-banner-title').textContent = `${n} new answer${n === 1 ? '' : 's'}`;
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
  if (!current.postingText) { say('No saved posting'); return false; }
  const locationId = prior?.opts?.locationId || profile.contact.locations.find((l) => l.label === current.location)?.id || $('location').value;
  if (!locationId) { say('Choose a location'); return false; }
  const opts = sheet
    ? { includePersonalLine: $('regen-personal').checked, locationId, shortTitles: $('regen-short').checked }
    : { includePersonalLine: prior?.opts ? prior.opts.includePersonalLine : $('personal').checked, locationId, shortTitles: prior?.opts ? prior.opts.shortTitles : $('shorttitles').checked };
  const baseNotes = sheet ? $('regen-notes').value.trim() : prior?.notes || '';
  const notes = comment ? `${baseNotes}\n${comment}`.trim() : baseNotes;
  const snapshot = prior ? { ...prior } : null;
  const source = { text: current.postingText, title: current.title, company: current.company, postingId: current.postingId };
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
    toast(`${comment ? 'Changed' : 'Redone'}${n ? ` · ${n} question${n === 1 ? '' : 's'}` : ''}`, snapshot ? { label: 'Undo', run: () => undoRegenerate(snapshot) } : null);
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
  toast('Undone');
}

function loadEntry(entry) {
  editing = false;
  const generated = entry.originalText || entry.text;
  current = {
    id: entry.id, doc: entry.doc, generated, text: entry.text, edited: entry.text !== generated,
    title: entry.title, company: entry.company, link: entry.link, location: entry.location,
    issues: entry.issues || [], keywords: entry.keywords || { covered: [], missing: [] }, fit: entry.fit && typeof entry.fit === 'object' ? entry.fit : null, fitError: '',
    postingKeywords: entry.postingKeywords || [], citedIds: entry.citedIds || [], deadline: entry.deadline === undefined ? findDeadline(entry.postingText || '') : entry.deadline, suggestions: entry.suggestions || [],
    unsupported: entry.unsupported || [],
    extras: entry.extras || [], postingId: entry.postingId || '', postingText: postingById(entry.postingId)?.text || entry.postingText || '', summaryOptions: entry.summaryOptions || [], summaryOriginal: entry.summaryOriginal || ''
  };
  if (entry.deadline === undefined) saveEntry({ deadline: current.deadline });
  renderCurrent();
}

const kwList = () => (current.postingKeywords.length ? current.postingKeywords : [...current.keywords.covered, ...current.keywords.missing]);

// The deadline matters while the resume is still a draft. Once you have applied, or the posting is out of the
// running, there is nothing left to do by that date, so it is not shown.
const isOpen = (status) => !status || status === 'Drafted';

function renderDeadline() {
  const c = current;
  const btn = $('deadline');
  const status = history.find((e) => e.id === c.id)?.status;
  if (!c.deadline || !isOpen(status)) { btn.hidden = true; return; }
  const st = deadlineState(c.deadline.date);
  btn.hidden = false;
  btn.className = `stat stat-btn due ${st.tone}`;
  btn.innerHTML = `${icon('calendar')}${esc(st.text)}`;
  btn.title = `${c.deadline.quote}\nClick to add it to your calendar.`;
}

function downloadDeadline() {
  const c = current;
  if (!c?.deadline) return;
  const title = `Apply: ${[c.title, c.company].filter(Boolean).join(', ') || 'job'}`;
  const url = URL.createObjectURL(new Blob([icsFor({ date: c.deadline.date, title })], { type: 'text/calendar;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `deadline-${c.deadline.date}.ics` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  toast('Calendar file saved');
}

function renderCurrent() {
  const c = current;
  const terms = kwList();
  if (terms.length) c.keywords = keywordCoverage(terms, c.text);
  $('res-status').value = history.find((e) => e.id === c.id)?.status || STATUSES[0];
  $('res-title').textContent = c.title || 'Resume';
  $('res-sub').textContent = [c.company, c.location].filter(Boolean).join(' \u00b7 ');
  const site = c.link ? siteOf(c.link) : null;
  $('res-link').hidden = !site;
  if (site) {
    $('res-link').href = c.link;
    $('res-host').textContent = site.host;
    $('res-logo').innerHTML = siteLogo(site, 18);
  }

  const paper = $('resume');
  paper.classList.toggle('plain', c.edited);
  if (c.edited) paper.textContent = c.text; else { paper.innerHTML = renderHtml(c.doc); addCopyButtons(); }
  $('resume-edit').hidden = !editing;
  paper.hidden = editing;
  $('edit').querySelector('span').textContent = editing ? 'Done' : 'Edit';
  renderRail();

  const stats = resumeStats(c.text);
  let est = null;
  try { est = estimateLayout(c.edited ? docFromText(c.text) || c.doc : c.doc); } catch { /* the estimate is only a guide */ }
  $('stat-words').textContent = est ? `${stats.words} words \u00b7 ${est.fits ? `1 page, ${est.size} pt` : `${est.pages} pages`}` : `${stats.words} words`;
  $('stat-words').className = `stat${est && !est.fits ? ' warn' : ''}`;
  $('stat-edited').hidden = !c.edited;
  const checks = $('stat-checks');
  checks.innerHTML = `${icon(c.issues.length ? 'alert' : 'check')}${c.issues.length ? `${c.issues.length} check${c.issues.length === 1 ? '' : 's'} to review` : 'Checks passed'}`;
  checks.className = `stat stat-btn ${c.issues.length ? 'warn' : 'ok'}`;
  $('checks').innerHTML = c.issues.length
    ? c.issues.map((i) => `<li>${esc(i)}</li>`).join('')
    : '<li>No problems found. Every bullet cites verified library entries and uses only numbers from them.</li>';
  renderFit();
  renderDeadline();
  renderRegenBanner();
  updateTitle();

  renderImprove();
}

/* ---------- Improve: keyword rewrites, summary, checks ---------- */

const openSuggestions = () => (current?.suggestions || []).filter((s) => s.kind === 'rephrase' && !s.applied && !s.dismissed);

function renderImprove() {
  const c = current;

  // Coverage: every posting term, marked by whether the resume says it.
  const terms = kwList();
  const total = terms.length;
  const covered = c.keywords.covered.length;
  $('cov-text').textContent = total ? `${covered}/${total}` : '';
  $('cov-fill').style.width = total ? `${Math.round((covered / total) * 100)}%` : '0%';
  const resumeCounts = markTerms(c.text, terms).counts;
  $('kw-chips').innerHTML = terms.map((t, i) => `<button type="button" class="${resumeCounts[i] ? 'hit' : 'miss'}" data-k="${i}">${esc(t)}<small>${resumeCounts[i]}</small></button>`).join('')
    || '<span class="hint">None</span>';

  renderSuggestions();
  renderSummary();
  renderAts();
  const open = openSuggestions().length;
  $('badge-i').hidden = open === 0;
  $('badge-i').textContent = String(open);
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
      ${s.applied ? `<p class="applied">${icon('check')} Applied</p>` : stale ? '<p class="why">Line changed</p>'
        : `<div class="sug-actions"><button type="button" class="btn small primary" data-sug="apply">${icon('check')}<span>Apply</span></button><button type="button" class="btn small" data-sug="dismiss">Skip</button></div>`}</li>`;
  }).join('') || `<li class="none-yet">${missing ? 'None yet' : 'All terms present'}</li>`;
  $('sug-unsupported').innerHTML = (c.unsupported || []).length
    ? `<h3>Not in library</h3><ul class="rows">${c.unsupported.map((u) => `<li><strong>${esc(u.keyword)}</strong> ${esc(u.why)}</li>`).join('')}</ul>`
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
  $('ats-count').textContent = review ? `${review} to review` : 'Clear';
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
  if (current.edited) { toast('Revert edits first'); return; }
  if (!applyOne(s)) { renderSuggestions(); return; }
  finishChange();
  toast('Applied');
}

function applyAll() {
  if (current.edited) { toast('Revert edits first'); return; }
  let done = 0;
  for (const s of openSuggestions()) if (applyOne(s)) done += 1;
  if (!done) { toast('Lines changed'); return; }
  finishChange();
  toast(`Applied ${done}`);
}

// Asks for natural rewordings that cover the keywords the resume still lacks, then keeps only the safe ones.
async function suggestMore(only = null, { quiet = false } = {}) {
  const missing = only || current.keywords.missing;
  if (!missing.length) return;
  const status = $('sug-status');
  const button = $('sug-more');
  if (!quiet) setBusy(button, true, 'Finding wording...');
  status.textContent = 'Finding…';
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
    if (quiet && fresh.length) toast(`${fresh.length} rewrite${fresh.length === 1 ? '' : 's'}`, { label: 'Review', run: () => showView('resume', 'edits') });
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
  $('sum-current').textContent = typo(c.doc.summary || 'None');
  $('sum-restore').hidden = !c.summaryOriginal || c.summaryOriginal === c.doc.summary;
  $('sum-options').innerHTML = (c.summaryOptions || []).map((o, i) => `<li class="sug" data-i="${i}"><span class="tag">${esc(o.label)}</span>
    <p class="now">${esc(typo(o.text))}</p>
    <div class="sug-actions"><button type="button" class="btn small primary" data-sum="use">${icon('check')}<span>Use</span></button></div></li>`).join('');
}

async function writeSummaries() {
  const button = $('sum-gen');
  const status = $('sum-status');
  setBusy(button, true, 'Writing…');
  status.textContent = '';
  try {
    const opts = { includePersonalLine: $('personal').checked, knowledge };
    const req = buildSummaryRequest(profile, { doc: current.doc, keywords: kwList(), missing: current.keywords.missing, postingTitle: current.title, ...opts });
    const input = await askClaude(req, 'submit_summaries');
    const known = sourceTextLookup(profile, opts);
    current.summaryOptions = checkSummaries(input.options, { knownText: known, years: yearsSince(profile.meta.career_start), startYear: Number(profile.meta.career_start.slice(0, 4)) });
    saveEntry({ summaryOptions: current.summaryOptions });
    status.textContent = current.summaryOptions.length ? '' : 'None safe. Retry';
    renderSummary();
  } catch (err) {
    status.textContent = err.message;
  } finally {
    setBusy(button, false);
  }
}

function useSummary(i) {
  if (current.edited) { toast('Revert edits first'); return; }
  const option = current.summaryOptions[i];
  if (!option) return;
  if (!current.summaryOriginal) current.summaryOriginal = current.doc.summary;
  current.doc = { ...current.doc, summary: option.text };
  finishChange({ summaryOriginal: current.summaryOriginal });
  toast('Summary changed');
}

function restoreSummary() {
  if (!current.summaryOriginal) return;
  current.doc = { ...current.doc, summary: current.summaryOriginal };
  finishChange();
  toast('Restored');
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
    : `<p class="none">No posting saved<br><button type="button" id="cmp-paste" class="btn small">${icon('clipboard')}<span>Paste</span></button></p>`;
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
  $('cmp-detail').innerHTML = `<b>${esc(terms[k])}</b> · ${current.postingText ? `posting ${inPosting.length} · ` : ''}draft ${inResume.length}${missing ? ` <button type="button" class="btn small" id="cmp-find">${icon('sparkle')}<span>Find</span></button>` : ''}`;
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
    const text = cleanPosting(await navigator.clipboard.readText());
    if (text.length < 40) { toast('Too short'); return; }
    current.postingText = text.slice(0, 15000);
    saveEntry({ postingText: current.postingText });
    renderCompare();
    toast('Added');
  } catch { toast('Paste blocked'); }
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
  try { await navigator.clipboard.writeText(text); toast(done); } catch { toast('Copy blocked'); }
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
      if (!doc) { doc = current.doc; toast('Used the original layout'); }
    }
    const out = await buildPdf(doc, { title: [current.title, current.company].filter(Boolean).join(' at ') || undefined });
    const url = URL.createObjectURL(new Blob([out.bytes], { type: 'application/pdf' }));
    const link = Object.assign(document.createElement('a'), { href: url, download: resumeFilename(current.company, current.title, 'pdf') });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast(out.fits ? `PDF · 1 page · ${out.size} pt` : `PDF · ${out.pages} pages · too long`);
  } catch (err) {
    toast(`PDF failed: ${err.message}`);
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
  toast('Saved');
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
  toast('Reverted');
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
  $('q-step').textContent = `${qIndex + 1} / ${questions.length}`;
  $('q-dots').innerHTML = qState.map((s, i) => `<i class="${i === qIndex ? 'cur' : s === 'saved' || s === 'dismissed' ? 'done' : s === 'skipped' ? 'skip' : ''}"></i>`).join('');
  $('q-prev').disabled = qIndex === 0;
  $('q-next').disabled = qIndex === questions.length - 1;

  const role = q.role_id && profile.roles.find((r) => r.id === q.role_id);
  const tags = `<div class="q-tags"><span class="tag">${esc(KIND_LABELS[q.kind] || 'Question')}</span>${role ? `<span class="tag role">${esc(role.org)}</span>` : ''}${state === 'skipped' ? '<span class="tag role">Skipped</span>' : ''}</div>`;
  const text = `<p class="q-text">${esc(q.text)}</p>`;
  if (state === 'saved' || state === 'dismissed') {
    $('q-card').innerHTML = `${tags}${text}<p class="q-status">${state === 'saved' ? 'Saved' : 'Dismissed'}</p>`;
    return;
  }
  const body = q.kind === 'conflict' && q.options?.length
    ? `<div class="q-options">${q.options.map((o, j) => `<button type="button" class="btn" data-act="choice" data-j="${j}">${esc(o.label)}</button>`).join('')}</div>`
    : `<textarea id="q-answer" rows="4" aria-label="Your answer" placeholder="Answer"></textarea>
       <div class="q-actions"><button type="button" class="btn primary" data-act="fact">Fact</button><button type="button" class="btn" data-act="preference">Preference</button></div>`;
  $('q-card').innerHTML = `${tags}${text}${body}<div class="q-more"><button type="button" class="btn quiet" data-act="skip">Skip</button><button type="button" class="btn quiet" data-act="dismiss">Never</button></div>`;
}

function renderQuestionsDone() {
  const saved = qState.filter((s) => s === 'saved' || s === 'dismissed').length;
  const pending = pendingItems(knowledge).length;
  $('q-done').innerHTML = `<p class="done-line">${icon('check')}${saved} answered</p>
    ${pending ? `<button type="button" class="btn primary block" data-done="merge">Merge ${pending}</button>` : ''}
    ${current?.postingText ? `<button type="button" class="btn block" data-done="regen">${icon('refresh')}<span>Redo with answers</span></button>` : `<button type="button" class="btn block" data-done="again">Tailor again</button>`}`;
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
    if (!text) { toast('Type an answer'); $('q-answer').focus(); return; }
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
  if (!pending.length) { toast('Nothing to merge'); return; }
  const box = $('review');
  box.innerHTML = '<p role="status" class="none-yet">Drafting…</p>';
  showDialog('review-dialog');
  try {
    const input = await askClaude(buildLibrarianRequest(profile, pending), 'propose_library_changes');
    const evidence = pending.map((p) => p.text || '').join('\n');
    const preview = applyPatch(profile, input.ops, evidence);
    reviewing = { pending, ops: input.ops, evidence, preview };
    const lines = preview.applied.map((a) => `<li>${esc(describeOp(a.op, profile))}</li>`).join('');
    const skipped = preview.skipped.map((x) => `<li class="skip">Skipped · ${esc(describeOp(x.op, profile))} (${esc(x.why)})</li>`).join('');
    const questions = input.clarify || [];
    const clarify = questions.map((c, i) => `<li class="clarify"><label for="clar-${i}">Question</label><p>${esc(c)}</p>
      <textarea id="clar-${i}" rows="2" data-q="${esc(c)}" placeholder="Answer" aria-label="Your answer"></textarea>
      <div class="toggles"><button type="button" class="toggle-btn" data-fill="clar-${i}" data-text="Yes">Yes</button><button type="button" class="toggle-btn" data-fill="clar-${i}" data-text="No">No</button></div></li>`).join('');
    box.innerHTML = `<p>${esc(input.summary || '')}</p>
      <ul class="cards">${lines || '<li class="none-yet">Nothing new</li>'}${skipped}${clarify}</ul>
      ${questions.length ? '<button type="button" id="revise" class="btn block" disabled>Update</button>' : ''}
      <div class="row2"><button type="button" id="approve" class="btn primary">${preview.applied.length ? 'Merge' : 'Done'}</button>
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
        msg.textContent = 'No GitHub token. Copied instead';
        $('approve').disabled = false;
        return;
      }
      msg.textContent = 'Saving…';
      const done = await updateLibrary(token, (remote) => applyPatch(remote, ops, evidence), 'Merge answers into the library');
      profile = done.profile;
      refreshProfileViews();
    }
    knowledge = markMerged(knowledge, pending);
    await persist();
    $('review').innerHTML = '<p role="status" class="done-line">Merged</p><button type="button" class="btn block" data-close>Done</button>';
    reviewing = null;
    renderQuestions();
  } catch (err) {
    msg.textContent = err.message;
    $('approve').disabled = false;
  }
}

async function teach() {
  const text = $('teach').value.trim();
  if (!text) { toast('Type something'); return; }
  knowledge = applyAnswer(knowledge, { text }, { action: 'note', text });
  $('teach').value = '';
  await persist();
  await startMerge();
}

/* ---------- desktop: window title, quick actions, shortcuts, drag and drop ---------- */

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = IS_MAC ? '⌘' : 'Ctrl';
const ALT = IS_MAC ? '⌥' : 'Alt';
const VIEW_NAMES = { tailor: 'Import', posting: 'Posting', resume: 'Resume', compare: 'Compare', library: 'Library' };
// Alt + number: the stage, then the inspector tabs.
const NAV = [['view', 'tailor', 'Import'], ['view', 'library', 'Library'], ['tab', 'fit', 'Fit'], ['tab', 'terms', 'Terms'], ['tab', 'edits', 'Edits'], ['tab', 'checks', 'Checks'], ['tab', 'questions', 'Ask']];

// The window title names the resume you are in.
function updateTitle() {
  const view = document.querySelector('.view:not([hidden])')?.dataset.view;
  if (!view || $('app').hidden) { document.title = 'Resume Advisor'; return; }
  const about = view === 'posting' ? postingById(postingId)?.title || '' : current && ['resume', 'compare'].includes(view) ? [current.title, current.company].filter(Boolean).join(' at ') : '';
  document.title = `${about || VIEW_NAMES[view] || ''} \u00b7 Resume Advisor`;
}

const SHORTCUTS = [
  ['Commands', `${MOD} K`],
  ['New', `${ALT} 1`],
  ['Library', `${ALT} 2`],
  ['Fit, Terms, Edits, Checks, Ask', `${ALT} 3 to 7`],
  ['Ask for a change', '/'],
  ['Tailor, or send a change', `${MOD} Enter`],
  ['Paste a posting', `${MOD} V`],
  ['Hide or show the list', `${MOD} B`],
  ['Hide or show the panel', `${MOD} \\`],
  ['Copy resume', `${MOD} Shift C`],
  ['PDF', `${MOD} S`],
  ['Keys', '?']
];

function showKeys() {
  $('keys-list').innerHTML = SHORTCUTS.map(([what, keys]) => `<div><dt>${esc(what)}</dt><dd>${keys.split(' ').map((k) => (k === 'to' ? '<span>to</span>' : `<kbd>${esc(k)}</kbd>`)).join('')}</dd></div>`).join('');
  showDialog('keys-dialog');
}

let paletteItems = [];
let paletteActive = 0;

function paletteCommands() {
  const list = NAV.map(([kind, name, label], i) => ({ group: 'Go to', label, hint: `${ALT} ${i + 1}`, run: () => (kind === 'view' ? showView(name) : current ? showView('resume', name) : showView('tailor')) }));
  if (current) {
    list.push(
      { group: 'Resume', label: 'Ask for a change', hint: '/', run: () => askFor('') },
      { group: 'Resume', label: 'Redo', run: openRegenerate },
      { group: 'Resume', label: 'Copy', hint: `${MOD} Shift C`, run: () => writeClipboard(current.text, 'Copied') },
      { group: 'Resume', label: 'PDF', hint: `${MOD} S`, run: () => $('pdf').click() },
      { group: 'Resume', label: 'TXT', run: download },
      { group: 'Resume', label: 'Compare', run: () => openCompare() },
      { group: 'Resume', label: 'Posting link', run: () => openLinkDialog('resume') },
      ...(current.deadline ? [{ group: 'Resume', label: 'Deadline to calendar', run: downloadDeadline }] : []),
      { group: 'Resume', label: 'Recalculate draft score', run: () => { showView('resume', 'fit'); recalculateDraft(); } },
      { group: 'Resume', label: 'Rescore fit', run: () => { showView('resume', 'fit'); assessFit(); } }
    );
  }
  list.push(
    { group: 'App', label: 'Theme', run: cycleTheme },
    { group: 'App', label: 'Settings', run: () => showDialog('settings-dialog') },
    { group: 'App', label: 'Keys', hint: '?', run: showKeys }
  );
  for (const p of postings.slice(0, 20)) list.push({ group: 'Postings', label: [p.title, p.company].filter(Boolean).join(' at '), hint: shortDate(p.at), run: () => openPosting(p.id) });
  for (const e of history.slice(0, 20)) list.push({ group: 'Resumes', label: historyLabel(e), hint: shortDate(e.at), run: () => { loadEntry(e); setQuestions([]); showView('resume'); } });
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
  $('kbd-new').textContent = `${ALT} 1`;
  $('kbd-go').textContent = `${MOD} \u21b5`;
  for (const b of document.querySelectorAll('.icon-btn[aria-label]')) b.title = b.getAttribute('aria-label');
  $('open-palette').addEventListener('click', openPalette);
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
    if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'b') { e.preventDefault(); togglePanel('rail'); return; }
    if (mod && !e.altKey && e.key === '\\') { e.preventDefault(); togglePanel('ins'); return; }
    if (open) return;
    if (e.altKey && !mod && /^Digit[1-7]$/.test(e.code)) {
      e.preventDefault();
      const [kind, name] = NAV[Number(e.code.slice(5)) - 1];
      if (kind === 'view') showView(name); else if (current) showView('resume', name);
      return;
    }
    if (mod && !e.altKey && current) {
      const k = e.key.toLowerCase();
      if (k === 's' && !e.shiftKey) { e.preventDefault(); $('pdf').click(); return; }
      if (k === 'c' && e.shiftKey) { e.preventDefault(); writeClipboard(current.text, 'Copied'); return; }
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
    else if (e.dataTransfer.files?.length) toast('Drop text');
    else acceptPasted(e.dataTransfer.getData('text/plain'));
  });
}

/* ---------- resizable, collapsible side panels ---------- */

const PANEL_STORE = 'resume-advisor-panels';
const PANEL_LIMITS = { rail: [200, 420], ins: [288, 680] };
const COLLAPSED_RAIL = 56;
const panels = { rail: 248, railOpen: true, ins: 384, insOpen: true, ...store.json(PANEL_STORE, {}) };

function applyPanels() {
  const root = document.documentElement.style;
  root.setProperty('--rail-w', `${panels.railOpen ? panels.rail : COLLAPSED_RAIL}px`);
  root.setProperty('--ins-w', `${panels.ins}px`);
  $('app').classList.toggle('rail-collapsed', !panels.railOpen);
  $('app').classList.toggle('ins-collapsed', !panels.insOpen);
  for (const b of document.querySelectorAll('[data-panel-toggle]')) {
    const side = b.dataset.panelToggle;
    const open = side === 'rail' ? panels.railOpen : panels.insOpen;
    b.setAttribute('aria-expanded', String(open));
    b.title = side === 'rail' ? (open ? 'Collapse the list' : 'Expand the list') : (open ? 'Hide the panel' : 'Show the panel');
    b.setAttribute('aria-label', b.title);
  }
  for (const [id, side] of [['split-rail', 'rail'], ['split-ins', 'ins']]) {
    const el = $(id);
    const [min, max] = PANEL_LIMITS[side];
    el.setAttribute('aria-valuemin', String(min));
    el.setAttribute('aria-valuemax', String(max));
    el.setAttribute('aria-valuenow', String(Math.round(panels[side])));
  }
}

function savePanels() { store.set(PANEL_STORE, JSON.stringify(panels)); }

function setPanel(side, open) {
  panels[side === 'rail' ? 'railOpen' : 'insOpen'] = open;
  applyPanels();
  savePanels();
}

const togglePanel = (side) => setPanel(side, !(side === 'rail' ? panels.railOpen : panels.insOpen));

function wirePanels() {
  applyPanels();
  for (const b of document.querySelectorAll('[data-panel-toggle]')) b.addEventListener('click', () => togglePanel(b.dataset.panelToggle));
  for (const [id, side] of [['split-rail', 'rail'], ['split-ins', 'ins']]) {
    const el = $(id);
    const [min, max] = PANEL_LIMITS[side];
    const open = () => (side === 'rail' ? panels.railOpen : panels.insOpen);
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      el.classList.add('dragging');
      document.body.classList.add('resizing');
    });
    el.addEventListener('pointermove', (e) => {
      if (!el.hasPointerCapture(e.pointerId)) return;
      const box = $('app').getBoundingClientRect();
      const raw = side === 'rail' ? e.clientX - box.left : box.right - e.clientX;
      if (raw < min - 60) { panels[side === 'rail' ? 'railOpen' : 'insOpen'] = false; }
      else { panels[side === 'rail' ? 'railOpen' : 'insOpen'] = true; panels[side] = Math.max(min, Math.min(max, raw)); }
      applyPanels();
    });
    const end = (e) => {
      if (!el.hasPointerCapture(e.pointerId)) return;
      el.releasePointerCapture(e.pointerId);
      el.classList.remove('dragging');
      document.body.classList.remove('resizing');
      savePanels();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('dblclick', () => togglePanel(side));
    el.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 48 : 16;
      const dir = (side === 'rail' ? 1 : -1) * (e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0);
      if (e.key === 'Enter') { e.preventDefault(); togglePanel(side); }
      else if (dir) { e.preventDefault(); if (!open()) setPanel(side, true); panels[side] = Math.max(min, Math.min(max, panels[side] + dir * step)); applyPanels(); savePanels(); }
    });
  }
}

/* ---------- the posting link ---------- */

let linkTarget = 'resume';

function openLinkDialog(target = 'resume') {
  linkTarget = target;
  const holder = target === 'posting' ? postingById(postingId) : current;
  if (!holder) return;
  $('link-input').value = holder.link || '';
  $('link-msg').textContent = '';
  showDialog('link-dialog');
  $('link-input').focus();
}

function saveLink(raw) {
  const text = String(raw || '').trim();
  const link = text ? normalizeUrl(text) : '';
  if (text && !link) { $('link-msg').textContent = 'Not a link'; return; }
  if (linkTarget === 'posting') {
    const p = postingById(postingId);
    p.link = link || '';
    for (const e of postingResumes(p.id)) { history = updateEntry(history, e.id, { link: p.link }); if (current?.id === e.id) current.link = p.link; }
    persistPostings();
    persistHistory();
    renderRail();
    renderPostingView();
  } else {
    current.link = link || '';
    saveEntry({ link: current.link });
    renderCurrent();
    renderRail();
  }
  $('link-dialog').close();
  toast(link ? 'Link saved' : 'Link removed');
}

// A site's icon is tried straight from the site first. Some sites refuse to let other pages show it, so then
// DuckDuckGo's icon service is asked for it (it is told only the site's name); failing that, its first letter.
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.classList.contains('site-img')) return;
  if (!img.dataset.stage && img.dataset.host) {
    img.dataset.stage = 'service';
    img.src = `https://icons.duckduckgo.com/ip3/${img.dataset.host}.ico`;
  } else {
    img.replaceWith(Object.assign(document.createElement('span'), { className: 'site-letter', textContent: img.dataset.letter || '?' }));
  }
}, true);

/* ---------- history ---------- */

// The posting site's own icon (its /favicon.ico, fetched straight from that site), or a letter tile if it has none.
const siteLogo = (site, px = 20) => `<img class="site-img" src="${esc(site.origin)}/favicon.ico" alt="" width="${px}" height="${px}" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-letter="${esc(site.letter)}" data-host="${esc(new URL(site.origin).hostname)}">`;
const letterTile = (letter) => `<span class="site-letter" aria-hidden="true">${esc(letter)}</span>`;

// A short due date for a posting that is near or past its deadline and has no resume sent yet.
function dueTag(p) {
  if (!p.deadline || !postingResumes(p.id).every((r) => isOpen(r.status))) return '';
  const st = deadlineState(p.deadline.date);
  return st.days > 14 ? '' : `<b class="due ${st.tone}">${st.days < 0 ? 'Closed' : st.label}</b>`;
}

const statusDot = (status) => ({ Drafted: 'draft', Applied: 'applied', Interviewing: 'live', Offer: 'win', Rejected: 'out', Withdrawn: 'out' }[status] || 'draft');

function renderHistory() {
  renderRail();
}

// The rail: each posting, and under it the resumes built from it. The open one is marked.
function renderRail() {
  $('history').innerHTML = postings.map((p) => {
    const site = p.link && siteOf(p.link);
    const logo = site ? siteLogo(site, 20) : letterTile((p.company || p.title || '?')[0].toUpperCase());
    const resumes = postingResumes(p.id);
    return `<li class="rpost" data-posting="${esc(p.id)}">
      <button type="button" class="ritem" data-open-posting><span class="site" aria-hidden="true">${logo}</span>
        <span class="ritem-text"><strong>${esc(p.title)}</strong><span class="sub"><i class="co">${esc(p.company || shortDate(p.at))}</i>${dueTag(p)}</span></span></button>
      <button type="button" class="ritem-x" data-delete-posting aria-label="Delete the posting"><i data-icon="close"></i></button>
      ${resumes.length ? `<ul class="rsub">${resumes.map((e) => `<li data-id="${esc(e.id)}"><button type="button" class="rres" data-open><span class="dot ${statusDot(e.status)}" title="${esc(e.status || 'Drafted')}"></span><span>Resume · ${esc(shortDate(e.at))}</span></button>
        <button type="button" class="ritem-x" data-delete aria-label="Delete"><i data-icon="close"></i></button></li>`).join('')}</ul>` : ''}</li>`;
  }).join('');
  hydrateIcons($('history'));
  renderRailMarks();
}

function renderRailMarks() {
  const view = document.body.dataset.view;
  for (const li of document.querySelectorAll('#history li[data-posting]')) {
    const on = view === 'posting' && li.dataset.posting === postingId;
    if (on) li.setAttribute('aria-current', 'true'); else li.removeAttribute('aria-current');
  }
  for (const li of document.querySelectorAll('#history li[data-id]')) {
    const on = (view === 'resume' || view === 'compare') && current && li.dataset.id === current.id;
    if (on) li.setAttribute('aria-current', 'true'); else li.removeAttribute('aria-current');
  }
}

function onHistoryClick(event) {
  const post = event.target.closest('li[data-posting]');
  const row = event.target.closest('li[data-id]');
  if (row) {
    const entry = history.find((e) => e.id === row.dataset.id);
    if (!entry) return;
    if (event.target.closest('[data-delete]')) {
      const snapshot = history;
      history = removeHistory(history, entry.id);
      persistHistory();
      if (current?.id === entry.id) { current = null; showView(postingById(entry.postingId) ? 'posting' : 'tailor'); if (postingById(entry.postingId)) { postingId = entry.postingId; renderPostingView(); } }
      renderHistory();
      toast('Deleted', { label: 'Undo', run: () => { history = snapshot; persistHistory(); renderHistory(); } });
    } else { loadEntry(entry); setQuestions([]); showView('resume'); }
    return;
  }
  if (!post) return;
  if (event.target.closest('[data-delete-posting]')) { postingId = post.dataset.posting; deletePosting(); }
  else openPosting(post.dataset.posting);
}

function onStatusChange() {
  if (!current) return;
  history = updateEntry(history, current.id, { status: $('res-status').value });
  persistHistory();
  renderRail();
  renderDeadline();
  if (postingId) renderPostingView();
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
  postings = store.json(POSTINGS_STORE, []);
  migratePostings();
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
      msg.textContent = 'Key must start with sk-ant-';
      return;
    }
    msg.textContent = 'Checking…';
    try {
      await checkKey(key);
      setKey(key, $('remember').checked);
      $('key').value = '';
      msg.textContent = '';
      show(true);
    } catch (err) {
      msg.textContent = err instanceof TypeError
        ? 'Cannot reach Anthropic'
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
  $('signout').addEventListener('click', () => { clearKey(); $('settings-dialog').close(); show(false); toast('Signed out'); });
  $('clear-history').addEventListener('click', () => {
    if (!confirm('Remove all postings and resumes from this device?')) return;
    history = [];
    postings = [];
    current = null;
    postingId = '';
    store.del(HISTORY_STORE);
    store.del(POSTINGS_STORE);
    renderHistory();
    showView('tailor');
    $('settings-dialog').close();
    toast('Cleared');
  });
  $('model').addEventListener('change', () => store.set('resume-advisor-model', $('model').value));

  // import
  $('applink').addEventListener('input', () => { saveDraft(); updateLinkUi(); });
  $('applink').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); readLinkNow(); } });
  $('fetch').addEventListener('click', readLinkNow);
  $('paste-catch').addEventListener('paste', (e) => { e.preventDefault(); acceptPasted(e.clipboardData?.getData('text/plain')); });
  $('paste-catch').addEventListener('input', (e) => { if (/^insertFrom(Paste|Drop)/.test(e.inputType || '')) acceptPasted($('paste-catch').value); });
  $('paste').addEventListener('click', async () => {
    try { acceptPasted(await navigator.clipboard.readText()); }
    catch { $('paste-catch').focus(); toast('Press Ctrl V in the box'); }
  });
  // the posting, and building from it
  $('gen').addEventListener('submit', generate);
  for (const id of ['shorttitles', 'personal']) $(id).addEventListener('input', saveDraft);
  $('pst-edit-link').addEventListener('click', () => openLinkDialog('posting'));
  $('pst-reformat').addEventListener('click', reformatPosting);
  $('pst-delete').addEventListener('click', deletePosting);
  $('pst-deadline').addEventListener('click', () => { const p = postingById(postingId); if (p?.deadline) downloadDeadlineFor(p.deadline, `Apply: ${[p.title, p.company].filter(Boolean).join(', ')}`); });
  $('pst-resumes').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-id]');
    const entry = li && history.find((h) => h.id === li.dataset.id);
    if (entry) { loadEntry(entry); setQuestions([]); showView('resume'); }
  });
  $('toggle-notes').addEventListener('click', () => setNotesOpen($('notes-field').hidden));
  // resume
  $('regen').addEventListener('click', openRegenerate);
  $('composer').addEventListener('submit', sendComposer);
  $('composer-text').addEventListener('input', growComposer);
  $('composer-text').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('composer').requestSubmit(); } });
  // Editing a drafted bullet: keep the text, employer, and library choice on the requirement as they change.
  const draftOf = (el) => { const li = el.closest('[data-req]'); return li ? current?.fit?.requirements[Number(li.dataset.req)]?.draft : null; };
  $('fit-detail').addEventListener('input', (e) => { if (e.target.matches('[data-draft-text]')) { const d = draftOf(e.target); if (d) d.text = e.target.value; } });
  $('fit-detail').addEventListener('change', (e) => {
    const d = draftOf(e.target);
    if (!d) return;
    if (e.target.matches('[data-draft-text]')) d.text = e.target.value;
    else if (e.target.matches('[data-draft-role]')) d.role_id = e.target.value;
    else if (e.target.matches('[data-draft-lib]')) d.library = e.target.checked;
    saveEntry({ fit: current.fit });
  });
  for (const id of ['fit-strip', 'fit-detail']) {
    $(id).addEventListener('click', (e) => {
      const tab = e.target.closest('[data-tab]');
      if (tab) { showView('resume', tab.dataset.tab); return; }
      if (e.target.closest('[data-recalc]')) { recalculateDraft(); return; }
      const dr = e.target.closest('[data-draft]');
      if (dr) { draftBullets(dr.dataset.draft.split(',').map(Number)); return; }
      const add = e.target.closest('[data-draft-add]');
      if (add) { addRequirementBullet(Number(add.dataset.draftAdd)); return; }
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
  $('copy').addEventListener('click', () => writeClipboard(current.text, 'Copied'));
  $('download').addEventListener('click', download);
  $('pdf').addEventListener('click', () => { if (editing) toggleEdit(); makePdf(); });
  $('suggestions').addEventListener('click', onSuggestion);
  $('sug-more').addEventListener('click', () => suggestMore());
  $('sug-all').addEventListener('click', applyAll);
  $('sum-gen').addEventListener('click', writeSummaries);
  $('sum-restore').addEventListener('click', restoreSummary);
  $('sum-options').addEventListener('click', (e) => { const li = e.target.closest('li[data-i]'); if (li && e.target.closest('[data-sum]')) useSummary(Number(li.dataset.i)); });
  $('inspector').addEventListener('click', (e) => { const t = e.target.closest('[data-tab]'); if (t) showTab(t.dataset.tab); });
  $('res-status').innerHTML = STATUSES.map((x) => `<option>${x}</option>`).join('');
  $('res-status').addEventListener('change', onStatusChange);
  $('deadline').addEventListener('click', downloadDeadline);
  $('edit-link').addEventListener('click', () => openLinkDialog('resume'));
  $('link-form').addEventListener('submit', (e) => { e.preventDefault(); saveLink($('link-input').value); });
  $('link-clear').addEventListener('click', () => saveLink(''));
  wireDesktop();
  wirePanels();
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
    showView('resume', 'edits');
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
    else showView('tailor');
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
