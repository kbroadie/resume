import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanPosting } from '../posting.js';
import { structureLocal, checkStructure, renderPostingText, buildFormatRequest, FORMAT_TOOL, KINDS } from '../postingdoc.js';

const NOW = new Date('2026-10-31T12:00:00');
const RAW = `Manager II, Website

Position Statement

The Manager II, Website, leads the management, maintenance, and continuous improvement of the public websites and staff intranet.

Essential Functions

Oversees the content, organization, and ongoing maintenance of school websites and the staff intranet.

Manages website publishing workflows and coordinates requests from school departments.

Implements and monitors digital accessibility practices (e.g., WCAG standards).

Minimum Qualifications

Experience with WordPress and Elementor Pro, plus working HTML/CSS.

Bachelor's degree in a job-related field is required

Benefits

Pay Schedule: Range 8B ($79,945-$108,119)

Employer: Sage Oak
Location: Onsite & Remote Office

Applications must be received by 5:00 p.m. on November 14, 2026.`;

test('the plain sorter files a posting into the fixed order and keeps every line', () => {
  const cleaned = cleanPosting(RAW);
  const s = structureLocal(cleaned, NOW);
  assert.equal(s.title, 'Manager II, Website');
  assert.deepEqual(s.sections.map((x) => x.kind), ['about', 'duties', 'requirements', 'benefits', 'other'].filter((k) => s.sections.some((x) => x.kind === k)));
  const duties = s.sections.find((x) => x.kind === 'duties').items;
  assert.equal(duties.length, 3);
  assert.ok(s.sections.find((x) => x.kind === 'requirements').items.some((i) => /Experience with WordPress/.test(i)), 'a line like "Experience with WordPress" is content, not a heading');
  assert.deepEqual(s.deadline, { date: '2026-11-14', quote: 'Applications must be received by 5:00 p.m. on November 14, 2026.' });
  const text = renderPostingText(s, NOW);
  for (const phrase of ['leads the management', 'Oversees the content', 'Elementor Pro', 'Bachelor']) assert.ok(text.includes(phrase), phrase);
});

test('Claude\'s sorting is checked: invented or reworded items are dropped, and anything left out is put back under Other', () => {
  const cleaned = cleanPosting(RAW);
  const report = {
    title: 'Manager II, Website', company: 'Sage Oak', location: 'Onsite & Remote Office', job_type: '', pay: 'Range 8B ($79,945-$108,119)', reference: '',
    deadline_date: '2026-11-14', deadline_quote: 'Applications must be received by 5:00 p.m. on November 14, 2026.',
    sections: [
      { kind: 'duties', items: ['- Oversees the content, organization, and ongoing maintenance of school websites and the staff intranet.', 'Manages website publishing workflows and coordinates requests from school departments.', 'Leads a team of ten designers.'] },
      { kind: 'requirements', items: ['Experience with WordPress and Elementor Pro, plus working HTML/CSS.', 'Experience with WordPress and Elementor Pro, plus working HTML/CSS.', 'Bachelor’s degree in a job-related field is required'] },
      { kind: 'bogus', items: ['Implements and monitors digital accessibility practices (e.g., WCAG standards).'] }
    ]
  };
  const out = checkStructure(report, cleaned, NOW);
  assert.equal(out.dropped, 1, 'the invented line is dropped');
  const all = out.sections.flatMap((s) => s.items).join('\n');
  assert.ok(!/ten designers/.test(all));
  assert.equal(out.sections.find((s) => s.kind === 'requirements').items.length, 2, 'repeats are dropped');
  assert.ok(all.includes('The Manager II, Website, leads the management'), 'a passage Claude left out is recovered');
  assert.ok(out.recovered >= 1);
  assert.deepEqual(out.sections.map((s) => s.kind), KINDS.map((k) => k.kind).filter((k) => out.sections.some((s) => s.kind === k)), 'sections come in the fixed order');
  assert.equal(out.deadline.date, '2026-11-14');
  assert.ok(!out.sections.find((s) => s.kind === 'other')?.items.some((i) => /^Employer: Sage Oak$/.test(i)), 'a line that only repeats a header field is not recovered');
});

test('every posting renders in the same order, with a header, bullets for lists, and paragraphs for prose', () => {
  const p = { title: 'T', company: 'Acme', location: 'Palm Springs, CA', jobType: 'Full time', pay: '$1', reference: '77', deadline: { date: '2026-11-14', quote: 'q' },
    sections: [{ kind: 'about', items: ['One paragraph.'] }, { kind: 'duties', items: ['Do a.', 'Do b.'] }, { kind: 'apply', items: ['Send it.'] }] };
  assert.equal(renderPostingText(p, NOW), ['T', 'Acme · Palm Springs, CA', 'Full time · $1 · Ref 77', 'Closes November 14, 2026', '', 'ABOUT', 'One paragraph.', '', 'DUTIES', '- Do a.', '- Do b.', '', 'HOW TO APPLY', 'Send it.'].join('\n'));
});

test('the format request sends the cleaned posting and the filing tool', () => {
  const r = buildFormatRequest('Some posting.');
  assert.equal(r.tools[0], FORMAT_TOOL);
  assert.match(r.user, /<POSTING>\nSome posting\.\n<\/POSTING>/);
  assert.match(r.system, /copy; you never write/i);
  assert.deepEqual(FORMAT_TOOL.input_schema.properties.sections.items.properties.kind.enum, KINDS.map((k) => k.kind));
});

test('when Claude copies only part of a line, only the rest of that line is put back', () => {
  const cleaned = 'Designer\n\nYou will lead brand work. Daily tools: InDesign and PowerPoint. Strong stakeholder engagement is essential.';
  const out = checkStructure({ title: 'Designer', sections: [{ kind: 'duties', items: ['You will lead brand work.'] }] }, cleaned, NOW);
  const other = out.sections.find((s) => s.kind === 'other').items;
  assert.deepEqual(other, ['Daily tools: InDesign and PowerPoint. Strong stakeholder engagement is essential.']);
  const whole = checkStructure({ title: 'Designer', sections: [{ kind: 'duties', items: ['You will lead brand work.', 'Daily tools: InDesign and PowerPoint.', 'Strong stakeholder engagement is essential.'] }] }, cleaned, NOW);
  assert.equal(whole.sections.find((s) => s.kind === 'other'), undefined, 'nothing is left over to put back');
});
