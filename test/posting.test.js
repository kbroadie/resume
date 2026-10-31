import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanPosting } from '../posting.js';
import { checkDeadline, findDeadline, datesIn, deadlineState, icsFor } from '../deadline.js';

const NOW = new Date('2026-10-31T12:00:00');

test('page furniture, cookie notices, and button labels are removed whole, sentences are untouched', () => {
  const raw = `Skip to main content.\nView More Jobs\nSenior Graphic Designer (2 year fixed-term)\nUnited States (Remote)\nApply Now\nShare\nSave job\nJob Description\n\nStanford uses cookies to optimize website functionality, analyze traffic, and enhance the user experience. Cookie Policy\nAccept All\nDecline\nYou will apply now to the design team.\nPowered by Oracle`;
  const out = cleanPosting(raw).split('\n');
  assert.deepEqual(out.filter((l) => /^(Apply Now|Share|Save job|Accept All|Decline|Skip to|View More|Powered by)/i.test(l)), []);
  assert.ok(!/cookies/i.test(out.join(' ')));
  assert.ok(out.includes('Senior Graphic Designer (2 year fixed-term)'));
  assert.ok(out.includes('You will apply now to the design team.'));
});

test('extra blank lines go: double-spaced text is tightened, headings keep a blank line before them', () => {
  const raw = ['Manager II, Website', '', 'Position Statement', '', 'The Manager leads the website.', '', 'Oversees the content of the sites.', '', 'Manages the publishing workflow.', '', 'Administers the platforms.', '', 'Essential Functions', '', 'Implements accessibility practices.', '', 'Oversees website security.', '', ''].join('\n');
  const out = cleanPosting(raw);
  assert.ok(!/\n\n\n/.test(out));
  assert.ok(out.includes('The Manager leads the website.\nOversees the content of the sites.\nManages the publishing workflow.'));
  assert.ok(out.includes('\n\nEssential Functions\nImplements accessibility practices.'));
  assert.ok(!out.endsWith('\n'));
});

test('hard-wrapped sentences are joined and bullet marks are made uniform', () => {
  const out = cleanPosting('You will lead brand, presentation, and print work across\nthe whole office and its partners.\n• Design layouts\n●  Write copy\n\n\n- Proof everything');
  assert.ok(out.startsWith('You will lead brand, presentation, and print work across the whole office and its partners.'));
  assert.ok(out.includes('- Design layouts\n- Write copy\n- Proof everything'));
});

test('cleaning twice changes nothing more, and nothing is invented', () => {
  const raw = 'Job title\n\n\nDuties\n\nDo the thing.\n\nApply Now\n';
  const once = cleanPosting(raw);
  assert.equal(cleanPosting(once), once);
  assert.equal(cleanPosting(''), '');
});

test('dates are read in the ways postings write them', () => {
  const f = (t) => datesIn(t).map((d) => [d.month, d.day, d.year]);
  assert.deepEqual(f('Closing date: November 14, 2026'), [[10, 14, 2026]]);
  assert.deepEqual(f('Apply by Nov. 3'), [[10, 3, null]]);
  assert.deepEqual(f('Deadline 14 December 2026'), [[11, 14, 2026]]);
  assert.deepEqual(f('Due 11/14/2026'), [[10, 14, 2026]]);
  assert.deepEqual(f('2026-12-01'), [[11, 1, 2026]]);
});

test('a reported deadline counts only when its quote is in the posting and states that date', () => {
  const posting = 'Position open.\nApplications must be received by 5:00 p.m. on November 14, 2026.\nOpen until filled otherwise.';
  const good = { deadline_date: '2026-11-14', deadline_quote: 'Applications must be received by 5:00 p.m. on November 14, 2026.' };
  assert.deepEqual(checkDeadline(good, posting, NOW), { date: '2026-11-14', quote: good.deadline_quote });
  assert.equal(checkDeadline({ ...good, deadline_date: '2026-11-15' }, posting, NOW), null, 'quote does not state that day');
  assert.equal(checkDeadline({ ...good, deadline_quote: 'Applications close November 14, 2026.' }, posting, NOW), null, 'quote is not in the posting');
  assert.equal(checkDeadline({ deadline_date: '', deadline_quote: '' }, posting, NOW), null);
  assert.equal(checkDeadline({ deadline_date: '2026-02-30', deadline_quote: 'February 30, 2026' }, 'February 30, 2026', NOW), null);
});

test('a plain scan finds a stated deadline, supplies the year, and ignores open-until-filled', () => {
  assert.deepEqual(findDeadline('Title\nClosing Date: December 5, 2026\nPay: $1', NOW), { date: '2026-12-05', quote: 'Closing Date: December 5, 2026' });
  assert.equal(findDeadline('Final filing date: Nov 20', NOW).date, '2026-11-20');
  assert.equal(findDeadline('Final filing date: Jan 9', NOW).date, '2027-01-09');
  assert.equal(findDeadline('Open until filled. Posted Oct 1, 2026.', NOW), null);
  assert.equal(findDeadline('Experience from March 2019 is helpful.', NOW), null);
});

test('how close a deadline is', () => {
  assert.deepEqual([deadlineState('2026-10-30', NOW).tone, deadlineState('2026-10-30', NOW).text], ['late', 'Closed Oct 30']);
  assert.equal(deadlineState('2026-10-31', NOW).text, 'Due today');
  assert.equal(deadlineState('2026-11-01', NOW).text, 'Due tomorrow');
  assert.deepEqual([deadlineState('2026-11-05', NOW).tone, deadlineState('2026-11-05', NOW).days], ['soon', 5]);
  assert.equal(deadlineState('2026-11-12', NOW).tone, 'ok');
  assert.equal(deadlineState('2026-12-25', NOW).text, 'Due Dec 25');
});

test('the calendar file is an all-day event with a reminder two days before', () => {
  const ics = icsFor({ date: '2026-11-14', title: 'Apply: Designer, Acme', now: NOW });
  assert.match(ics, /BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /DTSTART;VALUE=DATE:20261114\r\n/);
  assert.match(ics, /DTEND;VALUE=DATE:20261115\r\n/);
  assert.match(ics, /SUMMARY:Apply: Designer\\, Acme/);
  assert.match(ics, /TRIGGER:-P2D/);
});

test('a stack of labels and values becomes one line each, and a page-loaded notice is dropped', () => {
  const raw = ['Information Technology Technician', '', 'Employer', '', 'College of the Desert (CA)', '', 'Salary', '', '$65,805.48 - $92,595.48 Annually', '', 'Location', '', 'Palm Desert, CA', '', 'Closing Date', '', '11/15/2026 at 11:59 PM Pacific Time', '', 'DESCRIPTION', '', 'You will support the help desk.'].join('\n');
  const out = cleanPosting(`Information Technology Technician | GovernmentJobs.com page has loaded.\n\n${raw}`);
  assert.ok(!/page has loaded/i.test(out));
  assert.ok(out.includes('Employer: College of the Desert (CA)\nSalary: $65,805.48 - $92,595.48 Annually\nLocation: Palm Desert, CA\nClosing Date: 11/15/2026 at 11:59 PM Pacific Time'));
  assert.ok(out.includes('You will support the help desk.'));
  assert.deepEqual(findDeadline(out, NOW), { date: '2026-11-15', quote: 'Closing Date: 11/15/2026 at 11:59 PM Pacific Time' });
  assert.equal(cleanPosting('Employer\n\nAcme\n\nSalary\n\n$1\n\nDo the work.'), cleanPosting('Employer\n\nAcme\n\nSalary\n\n$1\n\nDo the work.'));
});

test('pasted text that is only a web address is recognized as the posting link', async () => {
  const { postingUrl, siteOf } = await import('../posting.js');
  assert.equal(postingUrl('https://www.governmentjobs.com/jobs/5510965-0/information-technology-technician'), 'https://www.governmentjobs.com/jobs/5510965-0/information-technology-technician');
  assert.equal(postingUrl('  https://acme.com/careers/12.  \n'), 'https://acme.com/careers/12');
  assert.equal(postingUrl('www.acme.com/jobs/9'), 'https://www.acme.com/jobs/9');
  assert.equal(postingUrl('See https://acme.com/jobs for the posting'), '');
  assert.equal(postingUrl('Brand Designer\nhttps://acme.com'), '');
  assert.equal(postingUrl('javascript:alert(1)'), '');
  assert.equal(postingUrl('acme'), '');
  assert.equal(postingUrl(''), '');
  assert.deepEqual(siteOf('https://www.governmentjobs.com/jobs/1'), { host: 'governmentjobs.com', origin: 'https://www.governmentjobs.com', letter: 'G' });
  assert.equal(siteOf('nonsense'), null);
});

test('section headings followed by a short line are not mistaken for label and value pairs', () => {
  const raw = 'IT Technician\n\nDuties\n\nSupport the help desk.\n\nQualifications\n\nA+ certification.\n\nBenefits\n\nHealth coverage for you.\n\nClosing date: November 15, 2026';
  const out = cleanPosting(raw);
  assert.ok(!/Duties: /.test(out) && !/Qualifications: /.test(out));
  assert.ok(out.includes('Duties\nSupport the help desk.') || out.includes('Duties\n\nSupport the help desk.'));
});
