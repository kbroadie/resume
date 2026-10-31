// Application deadlines: read what the posting says, check it against the posting's own words, and report how
// close it is. Nothing here guesses: a date counts only if the posting's text states it.

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
const monthIndex = (name) => MONTHS.findIndex((m) => m.startsWith(name.toLowerCase().slice(0, 3)));
const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
const validDay = (y, m, d) => { const t = new Date(Date.UTC(y, m, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m && t.getUTCDate() === d; };

// Every date written in a piece of text: { month (0-11), day, year or null }.
export function datesIn(text) {
  const out = [];
  const t = String(text);
  for (const m of t.matchAll(new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'gi'))) out.push({ month: monthIndex(m[1]), day: Number(m[2]), year: m[3] ? Number(m[3]) : null, at: m.index });
  for (const m of t.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_RE}(?:,?\\s+(\\d{4}))?\\b`, 'gi'))) out.push({ month: monthIndex(m[2]), day: Number(m[1]), year: m[3] ? Number(m[3]) : null, at: m.index });
  for (const m of t.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/g)) out.push({ month: Number(m[1]) - 1, day: Number(m[2]), year: m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]), at: m.index });
  for (const m of t.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) out.push({ month: Number(m[2]) - 1, day: Number(m[3]), year: Number(m[1]), at: m.index });
  return out.filter((d) => d.month >= 0 && d.month < 12 && d.day >= 1 && d.day <= 31).sort((a, b) => a.at - b.at);
}

// A date with no year means its next occurrence, allowing a month back for a deadline that just passed.
function withYear(d, now) {
  if (d.year) return validDay(d.year, d.month, d.day) ? iso(d.year, d.month, d.day) : null;
  const base = new Date(now.getTime() - 31 * 864e5);
  for (const y of [base.getUTCFullYear(), base.getUTCFullYear() + 1]) {
    if (validDay(y, d.month, d.day) && Date.UTC(y, d.month, d.day) >= Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate())) return iso(y, d.month, d.day);
  }
  return null;
}

const squash = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();

// Checks the model's report. The quote must be in the posting and must contain the reported date.
export function checkDeadline(report, postingText, now = new Date()) {
  const date = String(report?.deadline_date || '').trim();
  const quote = String(report?.deadline_quote || '').replace(/\s+/g, ' ').trim();
  if (!date || !quote || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  if (!squash(postingText).includes(squash(quote))) return null;
  const [y, m, d] = date.split('-').map(Number);
  if (!validDay(y, m - 1, d)) return null;
  const hit = datesIn(quote).some((x) => x.month === m - 1 && x.day === d && (!x.year || x.year === y));
  return hit ? { date, quote: quote.slice(0, 200) } : null;
}

// A plain scan of the posting, for resumes made before deadlines were read and as a second opinion.
const CUE = /\b(clos(?:e|es|ed|ing)|deadline|apply\s+by|applications?\s+(?:must\s+be\s+)?(?:received|submitted|accepted)\s+(?:by|until|through)|final\s+filing|due\s+(?:by|on)|no\s+later\s+than)\b/i;
export function findDeadline(text, now = new Date()) {
  const lines = String(text).split(/\n/);
  for (const line of lines) {
    if (!CUE.test(line) || /\bopen\s+until\s+filled\b|\buntil\s+filled\b|\bcontinuous(ly)?\b/i.test(line)) continue;
    for (const d of datesIn(line)) {
      const date = withYear(d, now);
      if (date) return { date, quote: line.replace(/\s+/g, ' ').trim().slice(0, 200) };
    }
  }
  return null;
}

// How close a deadline is. tone: "late" (passed), "soon" (within a week), or "ok".
export function deadlineState(date, now = new Date()) {
  const [y, m, d] = date.split('-').map(Number);
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((Date.UTC(y, m - 1, d) - today) / 864e5);
  const label = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const text = days < 0 ? `Closed ${label}` : days === 0 ? 'Due today' : days === 1 ? 'Due tomorrow' : days <= 14 ? `Due ${label} · ${days} days` : `Due ${label}`;
  return { days, label, text, tone: days < 0 ? 'late' : days <= 7 ? 'soon' : 'ok' };
}

// A one-day calendar event for the deadline.
export function icsFor({ date, title, now = new Date() }) {
  const [y, m, d] = date.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const ymd = (dt) => `${dt.getUTCFullYear()}${pad(dt.getUTCMonth() + 1)}${pad(dt.getUTCDate())}`;
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const esc = (s) => String(s).replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Resume Advisor//EN', 'BEGIN:VEVENT', `UID:${date}-${Math.abs([...title].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7))}@resume-advisor`,
    `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${date.replace(/-/g, '')}`, `DTEND;VALUE=DATE:${ymd(next)}`, `SUMMARY:${esc(title)}`,
    'BEGIN:VALARM', 'TRIGGER:-P2D', 'ACTION:DISPLAY', `DESCRIPTION:${esc(title)}`, 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n') + '\r\n';
}
