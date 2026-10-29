import { MODELS, buildRequest, validateResult, buildDoc, renderText, renderHtml, escapeHtml } from './lib.js?v=3';

const API = 'https://api.anthropic.com/v1';
const KEY_STORE = 'resume-tailor-key';
const $ = (id) => document.getElementById(id);

let profile = null;
let lastText = '';

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
  const res = await fetch('data/profile.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error('Could not load data/profile.json');
  profile = await res.json();
  $('location').innerHTML = '<option value="" disabled>Choose a location</option>' +
    profile.contact.locations.map((l) => `<option value="${l.id}">${escapeHtml(l.label)}</option>`).join('');
  let saved = '';
  try { saved = localStorage.getItem('resume-tailor-location') || ''; } catch { /* ignore */ }
  $('location').value = profile.contact.locations.some((l) => l.id === saved) ? saved : '';
  $('open-questions').innerHTML = profile.open_questions.map((q) => `<li>${escapeHtml(q)}</li>`).join('');
}

function setTab(name) {
  for (const [tab, panel] of [['t-resume', 'p-resume'], ['t-q', 'p-q'], ['t-checks', 'p-checks']]) {
    const on = tab === name;
    $(tab).setAttribute('aria-selected', String(on));
    $(panel).hidden = !on;
  }
}

function renderResult(result, issues, opts) {
  const doc = buildDoc(result, profile, opts);
  lastText = renderText(doc);
  $('resume').innerHTML = renderHtml(doc);

  $('questions').innerHTML = (result.questions || [])
    .map((q) => `<li><span class="tag">${escapeHtml(q.kind)}</span>${escapeHtml(q.text)}</li>`).join('') || '<li>No questions this time.</li>';
  $('qcount').textContent = result.questions?.length ? `(${result.questions.length})` : '';
  $('fit').textContent = result.fit_notes || '';

  $('checks').innerHTML = issues.length
    ? issues.map((i) => `<li>${escapeHtml(i)}</li>`).join('')
    : '<li>No problems found. Every bullet cites verified profile entries and uses only numbers from them.</li>';
  $('ccount').textContent = issues.length ? `(${issues.length})` : '';

  $('out').hidden = false;
  setTab(issues.length ? 't-checks' : 't-resume');
  $('out').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function generate(event) {
  event.preventDefault();
  const msg = $('gen-msg');
  const btn = $('go');
  const opts = { includePortfolio: $('portfolio').checked, includePersonalLine: $('personal').checked, locationId: $('location').value };
  try { localStorage.setItem('resume-tailor-location', opts.locationId); } catch { /* ignore */ }
  const req = buildRequest(profile, { posting: $('posting').value, notes: $('notes').value, ...opts });
  btn.disabled = true;
  msg.textContent = 'Tailoring. This takes up to a minute.';
  try {
    const res = await fetch(`${API}/messages`, {
      method: 'POST',
      headers: headers(currentKey()),
      body: JSON.stringify({
        model: $('model').value,
        max_tokens: 8000,
        system: req.system,
        tools: req.tools,
        tool_choice: req.tool_choice,
        messages: [{ role: 'user', content: req.user }]
      })
    });
    if (res.status === 401) { clearKey(); show(false); throw new Error('Your key was rejected. Sign in again.'); }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error?.message || `Request failed (HTTP ${res.status}).`);
    }
    const data = await res.json();
    const block = (data.content || []).find((b) => b.type === 'tool_use');
    if (!block) throw new Error('The model did not return a resume. Try again.');
    renderResult(block.input, validateResult(block.input, profile, opts), opts);
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
