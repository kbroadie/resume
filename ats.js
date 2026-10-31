// Applicant tracking: how well the resume suits an automated reader, and rephrasing suggestions that stay inside
// the library.

import { keywordCoverage, splitProfile, yearsSince } from './lib.js?v=35';

/* ---------- the applicant tracking check ---------- */

const STANDARD_HEADINGS = ['SUMMARY', 'SKILLS', 'EXPERIENCE', 'EDUCATION'];

// Checks of the resume text against what automated readers rely on. Each returns { ok, label, detail }.
export function atsLint({ text, doc, keywords = [], postingTitle = '' }) {
  const checks = [];
  const add = (ok, label, detail) => checks.push({ ok, label, detail });

  add(/[\w.+-]+@[\w-]+\.[\w.]+/.test(text) && /\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/.test(text),
    'Contact details are in plain text', 'Email and phone appear in the body, not in a header or image.');

  const present = STANDARD_HEADINGS.filter((h) => new RegExp(`^${h}$`, 'm').test(text));
  add(present.length === STANDARD_HEADINGS.length, 'Standard section headings',
    present.length === STANDARD_HEADINGS.length ? 'Summary, Skills, Experience, and Education, as readers expect.' : `Missing: ${STANDARD_HEADINGS.filter((h) => !present.includes(h)).map((h) => h.toLowerCase()).join(', ')}.`);

  const datePat = /^(?:[A-Z][a-z]{2} )?\d{4} - (?:(?:[A-Z][a-z]{2} )?\d{4}|Present)$/;
  const badDates = (doc?.experience || []).filter((x) => !datePat.test(x.dates));
  add(badDates.length === 0, 'Dates are in one readable format', badDates.length ? `Check the dates for ${badDates.map((x) => x.title).slice(0, 2).join(' and ')}.` : 'Every job shows month and year in the same pattern.');

  const words = (text.match(/\S+/g) || []).length;
  add(words >= 200 && words <= 560, 'Length', words < 200 ? `Only ${words} words. Most postings expect more detail.` : words > 560 ? `${words} words is too long for one page.` : `${words} words fits one page.`);

  const repeats = doc ? findRedundancy(doc) : [];
  add(repeats.length === 0, 'No redundancy', repeats.length ? repeats.slice(0, 3).map((r) => r.text).join(' ') : 'Nothing is said twice.');

  const nonAscii = (text.match(/[^\x00-\x7F]/g) || []).length;
  add(nonAscii === 0, 'Plain characters in the text version', nonAscii ? `${nonAscii} special characters may not paste cleanly into old forms.` : 'No special characters to trip up a form.');

  if (keywords.length) {
    const cov = keywordCoverage(keywords, text);
    const bullets = (doc?.experience || []).flatMap((x) => x.bullets).join('\n');
    const inContext = cov.covered.filter((k) => keywordCoverage([k], bullets).covered.length);
    const onlyListed = cov.covered.filter((k) => !inContext.includes(k));
    add(onlyListed.length <= Math.max(1, Math.floor(cov.covered.length / 2)), 'Keywords appear in context',
      onlyListed.length ? `${onlyListed.slice(0, 4).join(', ')} appear${onlyListed.length === 1 ? 's' : ''} only in the skills list. Readers weigh a term more when a job bullet uses it too.` : 'Matched terms also appear in the job bullets.');
    add(cov.missing.length <= Math.ceil(keywords.length / 2), 'Posting terms covered', `${cov.covered.length} of ${cov.covered.length + cov.missing.length}.${cov.missing.length ? ` Not in the resume: ${cov.missing.slice(0, 5).join(', ')}.` : ''}`);
  }

  if (postingTitle) {
    const tokens = postingTitle.toLowerCase().split(/[^a-z0-9+#]+/).filter((t) => t.length > 2 && !['and', 'the', 'for', 'senior', 'junior', 'lead'].includes(t));
    const head = `${doc?.headline || ''} ${doc?.summary || ''}`.toLowerCase();
    const hit = tokens.filter((t) => head.includes(t));
    add(!tokens.length || hit.length >= Math.ceil(tokens.length / 2), 'The posting\'s job title is echoed',
      !tokens.length || hit.length >= Math.ceil(tokens.length / 2) ? 'The headline or summary uses the posting\'s own title words.' : `The posting says "${postingTitle}". Use its words in your headline only where it is true.`);
  }
  return checks;
}

/* ---------- redundancy ---------- */

const content = (t) => new Set((String(t).toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => !STOP.has(w) && w.length > 2).map((w) => stem(w)));
const overlap = (a, b) => {
  const shared = [...a].filter((w) => b.has(w)).length;
  return { shared, share: shared / Math.max(1, Math.min(a.size, b.size)) };
};
const firstWord = (t) => (String(t).toLowerCase().match(/[a-z]+/) || [''])[0];

// Things said twice: two lines that are mostly the same words, the summary repeated in a bullet, the same opening
// verb over and over in one job, and a skill listed under two headings.
export function findRedundancy(doc) {
  const out = [];
  const lines = [];
  if (doc.summary) lines.push({ where: 'the summary', text: doc.summary, bag: content(doc.summary) });
  for (const x of doc.experience || []) for (const b of x.bullets) lines.push({ where: x.title, text: b, bag: content(b) });
  const clip = (t) => (t.length > 48 ? `${t.slice(0, 45).trim()}...` : t);
  for (let i = 0; i < lines.length; i += 1) {
    for (let j = i + 1; j < lines.length; j += 1) {
      const { shared, share } = overlap(lines[i].bag, lines[j].bag);
      if (shared >= 6 && share >= 0.6) out.push({ kind: 'similar', text: `"${clip(lines[i].text)}" (${lines[i].where}) and "${clip(lines[j].text)}" (${lines[j].where}) say nearly the same thing.` });
    }
  }
  for (const x of doc.experience || []) {
    const counts = new Map();
    for (const b of x.bullets) counts.set(firstWord(b), (counts.get(firstWord(b)) || 0) + 1);
    for (const [w, n] of counts) if (w && n >= 3) out.push({ kind: 'verb', text: `${n} bullets in ${x.title} begin with "${w}".` });
  }
  const seen = new Map();
  for (const g of doc.skills || []) for (const item of g.items) {
    const k = item.toLowerCase();
    if (seen.has(k) && seen.get(k) !== g.category) out.push({ kind: 'skill', text: `${item} is listed under ${seen.get(k)} and ${g.category}.` });
    seen.set(k, g.category);
  }
  return out;
}

/* ---------- rephrasing suggestions ---------- */

const NUMBER_RE = /\d[\d,]*(?:\.\d+)?/g;
const numbersOf = (t) => (String(t).match(NUMBER_RE) || []).map((n) => n.replace(/,/g, ''));

// Keeps only suggestions that are safe to offer: they replace a bullet that is really in the resume, use the
// posting's keyword, cite library entries, and add no number their sources do not already carry.
const STOP = new Set(['a', 'an', 'and', 'the', 'of', 'to', 'in', 'for', 'with', 'on', 'at', 'by', 'or', 'as', 'is', 'that', 'which', 'from', 'into', 'across']);
const words = (t) => (String(t).toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => !STOP.has(w));
// A light stemmer, enough to see that "engagement" and "engage", or "applications" and "application", are one word.
const stem = (w) => {
  let s = w;
  for (const suffix of [/ations?$/, /ments?$/, /ings?$/, /ions?$/, /ers?$/, /ly$/, /ed$/, /es$/, /s$/]) {
    const next = s.replace(suffix, '');
    if (next !== s && next.length >= 4) { s = next; break; }
  }
  return s.replace(/e$/, '');
};

export function checkSuggestions(suggestions, { doc, knownText, libraryText = '' }) {
  const library = new Set(words(libraryText).map(stem));
  const out = [];
  const resumeBullets = (doc?.experience || []).flatMap((x, ri) => x.bullets.map((b, bi) => ({ ri, bi, text: b })));
  for (const s of suggestions || []) {
    if (s.kind === 'ats') {
      if (String(s.text || '').trim()) out.push({ kind: 'ats', text: String(s.text).trim() });
      continue;
    }
    const text = String(s.text || '').trim();
    const replaces = String(s.replaces || '').trim();
    const keyword = String(s.keyword || '').trim();
    if (!text || !replaces || !keyword) continue;
    if (!text.toLowerCase().includes(keyword.toLowerCase())) continue;
    const target = resumeBullets.find((b) => b.text === replaces);
    const isSummary = !target && String(doc?.summary || '').trim() === replaces;
    if (!target && !isSummary) continue;
    const allowed = new Set([...numbersOf(replaces), ...numbersOf(knownText(s.source_ids || []))]);
    if (numbersOf(text).some((n) => !allowed.has(n))) continue;
    if (!(s.source_ids || []).length) continue;
    // The posting's term must already be something the library says, and the new wording may add almost nothing else.
    if (libraryText && words(keyword).some((w) => !library.has(stem(w)))) continue;
    const have = new Set([...words(replaces), ...words(knownText(s.source_ids || [])), ...words(keyword)].map(stem));
    if (words(text).filter((w) => !have.has(stem(w))).length > 2) continue;
    out.push({ kind: 'rephrase', keyword, replaces: target ? target.text : doc.summary, text, why: String(s.why || '').trim(), where: target ? { ri: target.ri, bi: target.bi } : { summary: true } });
  }
  return out.slice(0, 8);
}

// Returns a copy of the document with one suggestion applied.
export function applySuggestion(doc, suggestion) {
  const next = structuredClone(doc);
  if (suggestion.where?.summary) next.summary = suggestion.text;
  else if (suggestion.where) next.experience[suggestion.where.ri].bullets[suggestion.where.bi] = suggestion.text;
  return next;
}

/* ---------- asking for more rephrasings ---------- */

export const SUGGEST_SYSTEM = `You help Kevin Broadie's resume read naturally to an applicant tracking system and to a person, by rewording lines he already has so they use the posting's own terms.

You are given his resume as it stands, the posting terms it is missing, and his full library of verified facts.

RULES
1. Only reword. A rewording may use a posting term only if the library already says the same thing in other words. Never add a tool, result, number, duty, or claim. Keep every number exactly.
2. Make each rewording read as a natural sentence a good editor would write. Do not append a keyword, stack terms, or repeat the term in one line. Prefer swapping a near-synonym that is already there ("grant writing" to "grant applications"). Keep the bullet's length close to the original.
3. Spread terms across different bullets and the summary. Use at most one posting term per bullet, except where two belong together in the posting itself.
4. For each missing term, either give one rewording or, if the library does not support it, list it in "unsupported" with one plain sentence saying what is missing. Kevin can then teach the library if it is true.
5. "replaces" must be copied exactly from the resume text given. "text" must contain the term exactly as the posting words it. Cite the library ids that support it in source_ids.
6. Do not repeat a rewording already offered. Do not suggest anything for terms already in the resume.
Respond only by calling submit_suggestions, once.`;

export const SUGGEST_TOOL = {
  name: 'submit_suggestions',
  description: 'Submit natural rewordings that use missing posting terms, and the terms the library cannot support.',
  input_schema: {
    type: 'object',
    required: ['suggestions', 'unsupported'],
    properties: {
      suggestions: {
        type: 'array',
        items: {
          type: 'object',
          required: ['kind', 'keyword', 'replaces', 'text', 'source_ids', 'why'],
          properties: {
            kind: { type: 'string', enum: ['rephrase'] },
            keyword: { type: 'string' },
            replaces: { type: 'string', description: 'The exact current text of one bullet or the summary.' },
            text: { type: 'string', description: 'The reworded line, natural and close in length to the original.' },
            source_ids: { type: 'array', items: { type: 'string' } },
            why: { type: 'string', description: 'One short sentence.' }
          }
        }
      },
      unsupported: {
        type: 'array',
        items: {
          type: 'object',
          required: ['keyword', 'why'],
          properties: { keyword: { type: 'string' }, why: { type: 'string' } }
        }
      }
    }
  }
};

export function buildSuggestRequest(profile, { doc, missing, offered = [], includePersonalLine = true, knowledge = null }) {
  const { usable } = splitProfile(profile, { includePersonalLine, knowledge });
  const resume = {
    summary: doc.summary,
    jobs: doc.experience.map((x) => ({ title: x.title, employer: x.org, bullets: x.bullets }))
  };
  return {
    system: SUGGEST_SYSTEM,
    tools: [SUGGEST_TOOL],
    tool_choice: { type: 'auto' },
    user: [
      '<RESUME>', JSON.stringify(resume), '</RESUME>',
      '<MISSING_TERMS>', JSON.stringify(missing), '</MISSING_TERMS>',
      '<ALREADY_OFFERED>', JSON.stringify(offered.map((s) => ({ keyword: s.keyword, text: s.text }))), '</ALREADY_OFFERED>',
      '<LIBRARY>', JSON.stringify(usable), '</LIBRARY>'
    ].join('\n')
  };
}

/* ---------- writing the summary ---------- */

export const SUMMARY_SYSTEM = `You write the professional summary at the top of Kevin Broadie's resume.

RULES
1. Use only facts in LIBRARY. Never infer or add anything. Every number must come from LIBRARY or from years_of_experience, which may be written as "N+ years" at most.
2. Offer exactly three options with different emphases. Label them "Impact" (leads with a concrete result from the library), "Skills" (leads with the strengths the posting asks for), and "Brief" (two sentences).
3. Impact and Skills run two to four sentences. All options stay under 70 words, use no first person, and are plain and specific. Avoid filler such as "results-driven", "passionate", or "dynamic".
4. Use the posting's own terms where the library supports them, naturally and never stacked.
5. Cite the library ids each option draws on in source_ids.
Respond only by calling submit_summaries, once.`;

export const SUMMARY_TOOL = {
  name: 'submit_summaries',
  description: 'Submit three summary options for the resume.',
  input_schema: {
    type: 'object',
    required: ['options'],
    properties: {
      options: {
        type: 'array',
        items: {
          type: 'object',
          required: ['label', 'text', 'source_ids'],
          properties: {
            label: { type: 'string', enum: ['Impact', 'Skills', 'Brief'] },
            text: { type: 'string' },
            source_ids: { type: 'array', items: { type: 'string' } }
          }
        }
      }
    }
  }
};

export function buildSummaryRequest(profile, { doc, keywords = [], missing = [], postingTitle = '', includePersonalLine = true, knowledge = null, now = new Date() }) {
  const { usable } = splitProfile(profile, { includePersonalLine, knowledge });
  const facts = { years_of_experience: yearsSince(profile.meta.career_start, now), career_start_year: Number(profile.meta.career_start.slice(0, 4)) };
  return {
    system: SUMMARY_SYSTEM,
    tools: [SUMMARY_TOOL],
    tool_choice: { type: 'auto' },
    user: [
      '<POSTING_TITLE>', postingTitle || '(unknown)', '</POSTING_TITLE>',
      '<POSTING_TERMS>', JSON.stringify({ all: keywords, not_yet_in_resume: missing }), '</POSTING_TERMS>',
      '<CURRENT_SUMMARY>', doc.summary || '', '</CURRENT_SUMMARY>',
      '<FACTS>', JSON.stringify(facts), '</FACTS>',
      '<LIBRARY>', JSON.stringify(usable), '</LIBRARY>'
    ].join('\n')
  };
}

// Keeps only options that cite the library, stay short, avoid first person, and add no number it lacks.
export function checkSummaries(options, { knownText, years, startYear }) {
  const out = [];
  for (const o of options || []) {
    const text = String(o?.text || '').trim().replace(/\s+/g, ' ');
    const label = ['Impact', 'Skills', 'Brief'].includes(o?.label) ? o.label : '';
    if (!text || !label || !(o.source_ids || []).length) continue;
    if (text.split(' ').length > 90 || /\b(I|my|me)\b/.test(text)) continue;
    const allowed = new Set([...numbersOf(knownText(o.source_ids)), String(years), String(startYear)]);
    if (numbersOf(text).some((n) => !allowed.has(n))) continue;
    if (!out.some((x) => x.label === label)) out.push({ label, text, source_ids: o.source_ids });
  }
  return out;
}
