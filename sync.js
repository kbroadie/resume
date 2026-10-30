// Saves Kevin's knowledge file to the GitHub repo so it follows him across devices.
// Needs a fine-grained token with Contents read/write on this repository; reading works without one.
import { mergeKnowledge, normalizeKnowledge } from './knowledge.js?v=27';

export const REPO = 'kbroadie/resume';
export const PATH = 'data/knowledge.json';
const API = 'https://api.github.com';

const ghHeaders = (token) => ({
  accept: 'application/vnd.github+json',
  ...(token ? { authorization: `Bearer ${token}` } : {})
});

export function encodeContent(obj) {
  const bytes = new TextEncoder().encode(`${JSON.stringify(obj, null, 2)}\n`);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function decodeContent(b64) {
  const binary = atob(String(b64).replace(/\s/g, ''));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))));
}

// Key-sorted JSON, so equal knowledge compares equal regardless of insertion order.
const stable = (value) => JSON.stringify(value, (_, v) =>
  v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v);

export const PROFILE_PATH = 'data/profile.json';

// Reads a JSON file from the repo. Returns { data, sha }; data is null when the file does not exist.
export async function pullFile(path, token, fetchImpl = fetch) {
  const res = await fetchImpl(`${API}/repos/${REPO}/contents/${path}?ref=main`, { headers: ghHeaders(token), cache: 'no-store' });
  if (res.status === 404) return { data: null, sha: null };
  if (!res.ok) throw new Error(`GitHub said HTTP ${res.status} while reading ${path}.`);
  const body = await res.json();
  return { data: decodeContent(body.content), sha: body.sha };
}

export function putFile(path, data, { token, sha, message, fetchImpl = fetch }) {
  return fetchImpl(`${API}/repos/${REPO}/contents/${path}`, {
    method: 'PUT',
    headers: { ...ghHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify({ message, content: encodeContent(data), branch: 'main', ...(sha ? { sha } : {}) })
  });
}

export async function pull(token, fetchImpl = fetch) {
  const { data, sha } = await pullFile(PATH, token, fetchImpl);
  return { knowledge: data ? normalizeKnowledge(data) : null, sha };
}

async function put(knowledge, token, sha, fetchImpl) {
  return putFile(PATH, knowledge, { token, sha, message: 'Update saved answers', fetchImpl });
}

// Reads the latest profile from GitHub, lets `edit(profile)` return { profile, ...rest }, and saves it.
// If someone saved in between, reads again and re-applies the edit once. Returns the edit's result.
export async function updateLibrary(token, edit, message, fetchImpl = fetch) {
  if (!token) throw new Error('Merging into the library needs a GitHub token (see "Sync saved answers to GitHub").');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { data, sha } = await pullFile(PROFILE_PATH, token, fetchImpl);
    if (!data) throw new Error('Could not find data/profile.json on GitHub.');
    const result = edit(data);
    const res = await putFile(PROFILE_PATH, result.profile, { token, sha, message, fetchImpl });
    if (res.ok) return result;
    if (res.status === 401 || res.status === 403) throw new Error('GitHub did not accept the token (it needs Contents read and write on this repository).');
    if (res.status !== 409 && res.status !== 422) throw new Error(`GitHub said HTTP ${res.status} while saving the library.`);
  }
  throw new Error('The library changed while saving. Nothing was lost; try the merge again.');
}

// Merges local with what is on GitHub and, when a token is given and something changed, writes it back.
// Returns { knowledge, pushed }.
export async function syncKnowledge(local, token, fetchImpl = fetch) {
  let remote = await pull(token, fetchImpl);
  let merged = mergeKnowledge(local, remote.knowledge);
  if (!token) return { knowledge: merged, pushed: false };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (remote.knowledge && stable(merged) === stable(remote.knowledge)) return { knowledge: merged, pushed: false };
    const res = await put(merged, token, remote.sha, fetchImpl);
    if (res.ok) return { knowledge: merged, pushed: true };
    if (res.status === 401 || res.status === 403) throw new Error('GitHub did not accept the token (it needs Contents read and write on this repository).');
    if (res.status !== 409 && res.status !== 422) throw new Error(`GitHub said HTTP ${res.status} while saving.`);
    remote = await pull(token, fetchImpl); // someone else saved first: merge again and retry once
    merged = mergeKnowledge(merged, remote.knowledge);
  }
  throw new Error('Could not save to GitHub after a retry. Your answers are kept on this device.');
}
