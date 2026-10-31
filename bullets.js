// Bullets for requirements the library does not yet support. Claude drafts a plain starting point for each one and
// suggests the job it most likely belongs under; Kevin edits the text, picks the employer, and decides whether it
// goes into his library. Nothing here is a claim about Kevin until he adds it.

import { splitProfile } from './lib.js?v=33';
import { knowledgeForPrompt } from './knowledge.js?v=33';

export const DRAFT_SYSTEM = `You draft resume bullets for requirements of a job posting that Kevin Broadie's library does not yet mention. Kevin will read each draft, change it to what is true, choose the job it belongs under, and decide whether to keep it. He has worked as a designer, art director, systems administrator, web developer, and online producer, and has a long career, so most requirements are likely things he has done.

RULES
1. One bullet per requirement. Plain, specific, past tense, no first person, one sentence, under 30 words.
2. Say only what the requirement itself says, as something done. Do not add numbers, dates, outcomes, results, clients, employers, products, or tools that the requirement does not name. Do not praise.
3. Use the requirement's own terms so the bullet carries the posting's wording.
4. role_id: the id of the job in ROLES where this work most plausibly happened, judged from that job's title and bullets. Use an empty string if none is a good fit.
Respond only by calling draft_bullets, once.`;

export const DRAFT_TOOL = {
  name: 'draft_bullets',
  description: 'Draft one editable bullet for each requirement, with the job it most likely belongs under.',
  input_schema: {
    type: 'object',
    required: ['drafts'],
    properties: {
      drafts: {
        type: 'array',
        items: {
          type: 'object',
          required: ['index', 'bullet', 'role_id'],
          properties: { index: { type: 'integer', description: 'The requirement\'s index, as given.' }, bullet: { type: 'string' }, role_id: { type: 'string' } }
        }
      }
    }
  }
};

export function buildDraftRequest(profile, requirements, { includePersonalLine = true, knowledge = null } = {}) {
  const { usable } = splitProfile(profile, { includePersonalLine, knowledge });
  const roles = usable.roles.map((r) => ({ id: r.id, title: r.title, org: r.org, start: r.start, end: r.end || 'present', bullets: r.bullets.slice(0, 4).map((b) => b.text.slice(0, 140)) }));
  const user = [
    '<REQUIREMENTS>', JSON.stringify(requirements.map((r) => ({ index: r.index, requirement: r.text, terms: r.keywords || [] }))), '</REQUIREMENTS>',
    '<ROLES>', JSON.stringify(roles), '</ROLES>',
    '<KNOWLEDGE>', JSON.stringify(knowledgeForPrompt(knowledge)), '</KNOWLEDGE>'
  ].join('\n');
  return { system: DRAFT_SYSTEM, tools: [DRAFT_TOOL], tool_choice: { type: 'auto' }, user };
}

const digits = (t) => (String(t).match(/\d[\d,.]*/g) || []).map((n) => n.replace(/[,.]+$/, ''));

// Keeps a draft only if it is a plain sentence that adds no numbers beyond the requirement's own and no first person.
// Returns { [index]: { text, role_id } }.
export function checkDrafts(input, requirements, roleIds) {
  const byIndex = new Map(requirements.map((r) => [r.index, r]));
  const out = {};
  for (const d of Array.isArray(input?.drafts) ? input.drafts : []) {
    const req = byIndex.get(d?.index);
    if (!req || out[d.index]) continue;
    let text = String(d.bullet ?? '').replace(/^\s*[-*•]\s+/, '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 260) continue;
    if (/\b(I|my|me|we|our)\b/.test(text)) continue;
    const allowed = new Set(digits(req.text));
    if (digits(text).some((n) => !allowed.has(n))) continue;
    if (!/[.!?]$/.test(text)) text += '.';
    out[d.index] = { text: text[0].toUpperCase() + text.slice(1), role_id: roleIds.includes(d.role_id) ? d.role_id : '' };
  }
  return out;
}
