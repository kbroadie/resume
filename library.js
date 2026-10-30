// Turns Kevin's saved answers into edits to the master profile, the way a chat session would:
// reworded bullets on the right role, resolved wording conflicts, corrected dates and titles.
// Claude proposes the edits; everything here is deterministic and checks them before they are applied.
import { slug } from './knowledge.js?v=29';

export const LIBRARIAN_SYSTEM = `You maintain Kevin Broadie's master resume library (a JSON profile). Kevin has given you answers, corrections, and choices. Turn them into precise edits to the library, as a careful editor would.

RULES
1. Use only what Kevin said. Never infer, embellish, or add numbers, dates, tools, titles, or outcomes he did not state. Every number you write must appear in his words or in the bullet you are updating.
2. Rewrite his words as a resume bullet in the library's voice: past tense, no first person, plain and specific, one fact per bullet, meaning unchanged. Give 2 to 5 lowercase tags.
3. Put each fact on the role it belongs to (use role_id hints when given). If you cannot tell which role, make no edit and say so in "clarify".
4. If an existing bullet already says it, make no edit. If Kevin adds detail to an existing bullet, use update_bullet.
5. A "choice" item means Kevin picked a wording: use resolve_group with keep_id. Do nothing else for it.
6. Corrections to titles, dates, locations, or employers use set_role_field. A title that suits some postings (not all) is an add_title_option with a clear use_when.
7. Standing instructions about how resumes should be written use add_preference. Things that must never appear on a resume use add_never_include.
8. If an answer settles an entry in open_questions, remove it with remove_open_question (match = a distinctive phrase from the question).
9. Never delete anything except through resolve_group. Never touch status, never_include removals, or contact details.
10. If an item is unclear or you cannot merge it safely, list it in "clarify" in plain words and make no edit for it.
11. "summary" is one to three plain sentences telling Kevin what will change.
12. A note that reads "Question: ... Answer: ..." is Kevin's reply to a question you asked earlier. Treat the answer as settled and act on it (for example, if he says two bullets describe the same event, make one bullet with update_bullet rather than adding a second). Do not ask the same question again.

Respond only by calling propose_library_changes, once.`;

export const LIBRARIAN_TOOL = {
  name: 'propose_library_changes',
  description: 'Propose edits to the master resume library, with a plain-language summary.',
  input_schema: {
    type: 'object',
    required: ['summary', 'ops', 'clarify'],
    properties: {
      summary: { type: 'string' },
      clarify: { type: 'array', items: { type: 'string' } },
      ops: {
        type: 'array',
        items: {
          type: 'object',
          required: ['op'],
          properties: {
            op: { type: 'string', enum: ['add_bullet', 'update_bullet', 'resolve_group', 'set_role_field', 'add_role', 'add_skill', 'add_title_option', 'remove_open_question', 'add_preference', 'add_never_include'] },
            role_id: { type: 'string' },
            id: { type: 'string', description: 'Existing bullet id (update_bullet) or new title option id.' },
            text: { type: 'string', description: 'Bullet text, preference, never-include text, or skill name.' },
            tags: { type: 'array', items: { type: 'string' } },
            keep_id: { type: 'string', description: 'resolve_group: the bullet to keep.' },
            field: { type: 'string', enum: ['title', 'org', 'location', 'start', 'end'] },
            value: { type: 'string', description: 'New field value. Dates are YYYY or YYYY-MM; use an empty string for a role that is current.' },
            category: { type: 'string' },
            title: { type: 'string' },
            org: { type: 'string' },
            location: { type: 'string' },
            start: { type: 'string' },
            end: { type: 'string' },
            use_when: { type: 'string' },
            match: { type: 'string' }
          }
        }
      }
    }
  }
};

export function buildLibrarianRequest(profile, pending) {
  const library = {
    roles: profile.roles.map((r) => ({
      id: r.id, title: r.title, org: r.org, location: r.location, start: r.start, end: r.end, status: r.status,
      bullets: r.bullets.map((b) => ({ id: b.id, text: b.text, group: b.group || undefined, status: b.status }))
    })),
    skills: profile.skills.map((s) => s.name),
    preferences: profile.preferences || [],
    open_questions: profile.open_questions || []
  };
  const items = pending.map(({ ref, kind, question, role_id, text, group, keep_id }) => ({ ref, kind, question, role_id, text, group, keep_id }));
  return {
    system: LIBRARIAN_SYSTEM,
    tools: [LIBRARIAN_TOOL],
    tool_choice: { type: 'auto' },
    user: ['<LIBRARY>', JSON.stringify(library), '</LIBRARY>', '<KEVINS_ANSWERS>', JSON.stringify(items), '</KEVINS_ANSWERS>'].join('\n')
  };
}

const NUMBER_RE = /\d[\d,]*(?:\.\d+)?/g;
const numbersOf = (text) => (String(text).match(NUMBER_RE) || []).map((n) => n.replace(/,/g, ''));
const DATE_RE = /^\d{4}(-(0[1-9]|1[0-2]))?$/;
const FIELDS = ['title', 'org', 'location', 'start', 'end'];

const findRole = (profile, id) => profile.roles.find((r) => r.id === id);
const allBullets = (profile) => profile.roles.flatMap((r) => r.bullets.map((b) => ({ b, role: r })));
const norm = (t) => String(t).toLowerCase().replace(/\s+/g, ' ').trim();

// Structural check of the whole profile after edits. Returns problems; empty means sound.
export function validateProfile(profile) {
  const problems = [];
  const ids = new Set();
  const note = (id, where) => { if (ids.has(id)) problems.push(`Duplicate id "${id}" in ${where}`); ids.add(id); };
  for (const r of profile.roles) {
    note(r.id, 'roles');
    for (const f of ['title', 'org', 'start']) if (!r[f]) problems.push(`Role "${r.id}" is missing ${f}`);
    for (const b of r.bullets) {
      note(b.id, `role ${r.id}`);
      if (!b.text || !b.status) problems.push(`Bullet "${b.id}" needs text and status`);
    }
  }
  for (const s of profile.skills) note(s.id, 'skills');
  const groups = {};
  for (const { b } of allBullets(profile)) if (b.group) (groups[b.group] ||= []).push(b.id);
  for (const [g, m] of Object.entries(groups)) if (m.length < 2) problems.push(`Group "${g}" has only one bullet`);
  return problems;
}

// Applies ops to a copy of the profile. `evidence` is Kevin's own words: every number a new or changed text
// contains must appear in it (or in the bullet being updated). Returns { profile, applied, skipped }.
export function applyPatch(profile, ops, evidence = '') {
  const next = structuredClone(profile);
  const applied = [];
  const skipped = [];
  const evidenceNumbers = new Set(numbersOf(evidence));
  const checkNumbers = (text, extra = '') => {
    const allowed = new Set([...evidenceNumbers, ...numbersOf(extra)]);
    const bad = numbersOf(text).filter((n) => !allowed.has(n));
    if (bad.length) throw new Error(`the number ${bad[0]} is not in what Kevin said`);
  };

  for (const op of ops || []) {
    try {
      switch (op.op) {
        case 'add_bullet': {
          const role = findRole(next, op.role_id);
          if (!role) throw new Error(`no role "${op.role_id}"`);
          const text = String(op.text || '').trim();
          if (!text || text.length > 500) throw new Error('bullet text is empty or too long');
          checkNumbers(text);
          if (allBullets(next).some(({ b }) => norm(b.text) === norm(text))) { skipped.push({ op, why: 'already in the library' }); break; }
          let n = role.bullets.length + 1;
          const base = `${role.id}.${slug(text).split('-').slice(0, 3).join('-')}`;
          let id = base;
          while (allBullets(next).some(({ b }) => b.id === id)) id = `${base}-${n++}`;
          role.bullets.push({ id, status: 'verified', tags: (op.tags || []).map((t) => slug(t)).slice(0, 6), text });
          applied.push({ op, role });
          break;
        }
        case 'update_bullet': {
          const hit = allBullets(next).find(({ b }) => b.id === op.id);
          if (!hit) throw new Error(`no bullet "${op.id}"`);
          const text = String(op.text || '').trim();
          if (!text || text.length > 500) throw new Error('bullet text is empty or too long');
          checkNumbers(text, hit.b.text);
          hit.b.text = text;
          if (op.tags?.length) hit.b.tags = op.tags.map((t) => slug(t)).slice(0, 6);
          applied.push({ op, role: hit.role });
          break;
        }
        case 'resolve_group': {
          const keep = allBullets(next).find(({ b }) => b.id === op.keep_id);
          if (!keep?.b.group) throw new Error(`"${op.keep_id}" is not in a wording group`);
          const group = keep.b.group;
          for (const r of next.roles) r.bullets = r.bullets.filter((b) => b.group !== group || b.id === op.keep_id);
          delete keep.b.group;
          applied.push({ op, role: keep.role });
          break;
        }
        case 'set_role_field': {
          const role = findRole(next, op.role_id);
          if (!role) throw new Error(`no role "${op.role_id}"`);
          if (!FIELDS.includes(op.field)) throw new Error(`cannot change "${op.field}"`);
          let value = String(op.value ?? '').trim();
          if (op.field === 'start' || op.field === 'end') {
            if (op.field === 'end' && value === '') value = null;
            else if (!DATE_RE.test(value)) throw new Error(`"${value}" is not a date like 2009-07`);
            if (value) checkNumbers(value);
          } else if (!value) throw new Error(`${op.field} cannot be empty`);
          else checkNumbers(value, op.field === 'title' ? role.title : '');
          role[op.field] = value;
          applied.push({ op, role });
          break;
        }
        case 'add_role': {
          const { title, org, start } = op;
          if (!title || !org || !DATE_RE.test(start || '')) throw new Error('a new role needs title, org, and a start date like 2020-03');
          if (op.end && !DATE_RE.test(op.end)) throw new Error('end date must look like 2021-09');
          checkNumbers(`${start} ${op.end || ''}`);
          let id = slug(org).split('-')[0] || 'role';
          while (next.roles.some((r) => r.id === id)) id += '2';
          next.roles.push({ id, title, org, location: op.location || null, start, end: op.end || null, status: 'verified', bullets: [] });
          applied.push({ op, role: next.roles.at(-1) });
          break;
        }
        case 'add_skill': {
          const name = String(op.text || '').trim();
          if (!name) throw new Error('skill name is empty');
          if (next.skills.some((s) => norm(s.name) === norm(name))) { skipped.push({ op, why: 'already in the library' }); break; }
          next.skills.push({ id: `sk.${slug(name).slice(0, 24)}`, name, category: op.category || 'Other' });
          applied.push({ op });
          break;
        }
        case 'add_title_option': {
          const role = findRole(next, op.role_id);
          if (!role || !op.title || !op.use_when) throw new Error('title option needs a role, title, and use_when');
          const id = slug(op.id || op.title);
          role.title_options ||= [];
          if (role.title_options.some((o) => o.id === id)) { skipped.push({ op, why: 'option already exists' }); break; }
          role.title_options.push({ id, title: op.title, use_when: op.use_when });
          applied.push({ op, role });
          break;
        }
        case 'remove_open_question': {
          const before = next.open_questions?.length || 0;
          next.open_questions = (next.open_questions || []).filter((q) => !norm(q).includes(norm(op.match || '\u0000')));
          if (next.open_questions.length === before) skipped.push({ op, why: 'no matching open question' });
          else applied.push({ op });
          break;
        }
        case 'add_preference': {
          const text = String(op.text || '').trim();
          if (!text) throw new Error('preference is empty');
          next.preferences ||= [];
          if (next.preferences.some((p) => norm(p) === norm(text))) { skipped.push({ op, why: 'already in the library' }); break; }
          next.preferences.push(text);
          applied.push({ op });
          break;
        }
        case 'add_never_include': {
          const text = String(op.text || '').trim();
          if (!text) throw new Error('entry is empty');
          if (!next.never_include.some((p) => norm(p) === norm(text))) next.never_include.push(text);
          applied.push({ op });
          break;
        }
        default:
          throw new Error(`unknown edit "${op.op}"`);
      }
    } catch (err) {
      skipped.push({ op, why: err.message });
    }
  }
  const problems = validateProfile(next);
  if (problems.length) throw new Error(`The edits would break the library: ${problems[0]}`);
  return { profile: next, applied, skipped };
}

// Plain-language line for one edit, shown to Kevin before he approves.
export function describeOp(op, profile) {
  const roleName = (id) => { const r = findRole(profile, id); return r ? `${r.org} (${r.title})` : id; };
  switch (op.op) {
    case 'add_bullet': return `Add to ${roleName(op.role_id)}: "${op.text}"`;
    case 'update_bullet': return `Reword in ${roleName(allBullets(profile).find(({ b }) => b.id === op.id)?.role.id)}: "${op.text}"`;
    case 'resolve_group': return `Keep one wording and drop its alternates: "${allBullets(profile).find(({ b }) => b.id === op.keep_id)?.b.text}"`;
    case 'set_role_field': return `Change ${op.field} of ${roleName(op.role_id)} to ${op.value === '' ? 'Present' : `"${op.value}"`}`;
    case 'add_role': return `Add a role: ${op.title}, ${op.org}, ${op.start} to ${op.end || 'Present'}`;
    case 'add_skill': return `Add skill: ${op.text}`;
    case 'add_title_option': return `Add a title option for ${roleName(op.role_id)}: "${op.title}" (${op.use_when})`;
    case 'remove_open_question': return `Mark as answered: "${op.match}"`;
    case 'add_preference': return `Add a standing preference: ${op.text}`;
    case 'add_never_include': return `Never include: ${op.text}`;
    default: return JSON.stringify(op);
  }
}
