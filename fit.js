// Posting fit: how well a posting lines up with Kevin's library, and with the draft on screen.
//
// Claude reads the posting once and lists its requirements, saying for each how far the library supports it
// and citing the library entries. This module checks that report (a claim needs a real source, and a "strong"
// claim needs its own words in that source), then scores it. The score against the draft is computed here from
// the draft's own text, so it moves as the resume changes. Nothing here asks the model to rate the draft.

import { keywordCoverage, splitProfile, yearsSince, withProfilePreferences, sourceTextLookup } from './lib.js?v=31';
import { knowledgeForPrompt } from './knowledge.js?v=31';

export const FIT_SYSTEM = `You compare one job posting with Kevin Broadie's resume library and report how well the library supports each of the posting's requirements.

RULES
1. Use only the library (PROFILE and KNOWLEDGE). Never infer, assume, or credit anything it does not say. Items in HELD_BACK are not in the library: treat them as unsupported.
2. List the posting's distinct requirements: skills, tools, duties, credentials, and kinds of experience. Between 8 and 16. Merge duplicates and near-duplicates. Leave out boilerplate: equal opportunity statements, benefits, pay, physical demands, how to apply, and the documents an applicant must submit.
3. weight: "must" for what the posting requires or lists as essential, minimum, or core duties; "preferred" for what it calls preferred, desired, or a plus.
4. support:
   - "strong": a verified library entry directly shows it (the same skill, tool, duty, or credential, not just a related one).
   - "partial": related or adjacent experience, or part of the requirement.
   - "none": nothing in the library shows it.
   A requirement for a number of years is "strong" only if the dates in PROFILE and FACTS show at least that many years of that work. A degree requirement is judged against education entries.
5. source_ids: for "strong" and "partial", one to four ids copied exactly from PROFILE (bullet, skill, role, education, or fact ids). Empty for "none".
6. keywords: two to four short terms or phrases a resume would use for this requirement, including the posting's own wording. No sentences.
7. note: one plain sentence saying how the library supports it, or what is missing. No praise, no advice.

Respond only by calling report_fit, once.`;

export const FIT_TOOL = {
  name: 'report_fit',
  description: 'Report the posting\'s requirements and how far the library supports each one.',
  input_schema: {
    type: 'object',
    required: ['requirements'],
    properties: {
      requirements: {
        type: 'array',
        items: {
          type: 'object',
          required: ['text', 'weight', 'keywords', 'support', 'source_ids', 'note'],
          properties: {
            text: { type: 'string', description: 'The requirement in a few plain words.' },
            weight: { type: 'string', enum: ['must', 'preferred'] },
            keywords: { type: 'array', items: { type: 'string' } },
            support: { type: 'string', enum: ['strong', 'partial', 'none'] },
            source_ids: { type: 'array', items: { type: 'string' } },
            note: { type: 'string' }
          }
        }
      }
    }
  }
};

export function buildFitRequest(profile, { posting, includePersonalLine = true, knowledge = null, now = new Date() }) {
  const { usable, heldBack } = splitProfile(profile, { includePersonalLine, knowledge });
  const facts = { years_of_experience: yearsSince(profile.meta.career_start, now), career_start_year: Number(profile.meta.career_start.slice(0, 4)) };
  const user = [
    '<POSTING>', posting.trim(), '</POSTING>',
    '<FACTS>', JSON.stringify(facts), '</FACTS>',
    '<HELD_BACK>', JSON.stringify(heldBack), '</HELD_BACK>',
    '<KNOWLEDGE>', JSON.stringify(withProfilePreferences(knowledgeForPrompt(knowledge), profile)), '</KNOWLEDGE>',
    '<PROFILE>', JSON.stringify(usable), '</PROFILE>'
  ].join('\n');
  return { system: FIT_SYSTEM, tools: [FIT_TOOL], tool_choice: { type: 'auto' }, user };
}

const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// Checks the model's report against the library. `known` is sourceTextLookup(): known(ids) is the text behind ids,
// and known.has(id) says whether an id is in the library. A claim without a real source becomes "none"; a "strong"
// claim whose keywords appear nowhere in its sources becomes "partial".
export function checkFit(input, known) {
  const seen = new Set();
  const out = [];
  for (const r of Array.isArray(input?.requirements) ? input.requirements : []) {
    const text = clean(r?.text, 160);
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    const keywords = [...new Set((Array.isArray(r.keywords) ? r.keywords : []).map((k) => clean(k, 60)).filter(Boolean))].slice(0, 5);
    const ids = [...new Set((Array.isArray(r.source_ids) ? r.source_ids : []).map(String))].filter((id) => known.has(id)).slice(0, 4);
    let support = ['strong', 'partial', 'none'].includes(r.support) ? r.support : 'none';
    let adjusted = false;
    if (support !== 'none' && ids.length === 0) { support = 'none'; adjusted = true; }
    if (support === 'strong' && keywords.length && keywordCoverage(keywords, known(ids)).covered.length === 0) { support = 'partial'; adjusted = true; }
    out.push({ text, weight: r.weight === 'must' ? 'must' : 'preferred', keywords, support, source_ids: support === 'none' ? [] : ids, note: clean(r.note, 240), adjusted });
    if (out.length === 20) break;
  }
  return out;
}

const WEIGHT = { must: 3, preferred: 1 };
const CREDIT = { strong: 1, partial: 0.5, none: 0 };

// Is the requirement visible in this resume? By its own terms in the text, or (for an untouched draft) because the
// draft cites a library entry that supports it.
export function shownIn(req, text, citedIds = null) {
  if (req.keywords.length && keywordCoverage(req.keywords, text).covered.length > 0) return true;
  return Boolean(citedIds && req.support !== 'none' && req.source_ids.some((id) => citedIds.has(id)));
}

// Scores out of 100, rounded down so a score is never flattering. `library` is how much of the posting the library
// can support; `draft` is how much of that the resume actually shows. The draft can never beat the library.
export function fitScores(reqs, text, citedIds = null) {
  if (!reqs?.length) return null;
  let total = 0;
  let lib = 0;
  let draft = 0;
  const rows = reqs.map((r) => {
    const w = WEIGHT[r.weight];
    const credit = CREDIT[r.support];
    const shown = credit > 0 && shownIn(r, text, citedIds);
    total += w;
    lib += w * credit;
    if (shown) draft += w * credit;
    return { ...r, shown, state: r.support === 'none' ? 'missing' : shown ? 'shown' : 'unused' };
  });
  return { library: Math.floor((100 * lib) / total), draft: Math.floor((100 * draft) / total), rows };
}

// Every library id a result cites, for the "draft cites a supporting entry" check.
export function citedIdsOf(result) {
  const ids = new Set();
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (k === 'source_ids' && Array.isArray(x)) x.forEach((id) => ids.add(String(id))); else walk(x); }
  };
  walk(result);
  return [...ids];
}

// A short fingerprint of the library, to tell when a stored fit was scored against an older one.
export function fingerprint(profile) {
  const s = JSON.stringify(profile);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
