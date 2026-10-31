// Cleans a pasted job posting: removes the page furniture that comes along with a copy (button and link labels,
// cookie notices, navigation), repeated lines, hard line wraps, and the extra blank lines. It only ever removes a
// whole line that is a known label, so no sentence of the posting is touched.

const LABELS = [
  /^(apply( now| here| today| online| for (this )?(job|position|role))?|apply with .{1,30}|quick apply|easy apply)$/i,
  /^(save( this)?( job)?|saved|share( this)?( job)?|print( this)?( job)?|email( this)?( job)?|email a friend|copy( job)? link|report( this)? job|flag|follow( company)?|like|bookmark|refer( a friend)?)$/i,
  /^(back( to (results|search|jobs|listings|all jobs|job search|careers))?|previous|next|return to .{0,30}|go back)$/i,
  /^(view|see|browse|search) (more|all|similar|other|open) (jobs|openings|positions|roles)$/i,
  /^(more|view|see) (jobs|openings|positions) like this$/i,
  /^skip to (main )?(content|navigation)\.?$/i,
  /^(sign in|sign out|log in|log out|login|logout|sign up|register|join|create (an )?(account|profile|alert|job alert)|(get )?job alerts?|candidate (home|login)|my (account|profile|applications))$/i,
  /^(show|read|see|view|load) (more|less|all)$/i,
  /^(accept( all)?( cookies)?|decline|reject( all)?|manage( cookies| preferences)?|cookie (policy|settings|preferences|notice)|privacy( policy| notice| statement)?|terms( of (use|service))?|terms (&|and) conditions|accessibility( statement)?|site ?map|contact us|help)$/i,
  /^(facebook|twitter|x|linkedin|instagram|youtube|tiktok|whatsapp|pinterest|reddit|tweet|share on .{1,20})$/i,
  /^powered by .{0,40}$/i,
  /^.{0,200}\bpage has loaded\.?$/i,
  /^(©|\(c\)|copyright).{0,100}$/i,
  /^(menu|search|home|close|open|more|jobs?|careers?|employers|filter|filters|sort|results|loading\.*|skip)$/i,
  /^[\W_]{1,4}$/
];
const COOKIE = /\bcookies?\b/i;
const BULLET = /^\s*[•●▪■◦·*–—-]\s+/;

const isLabel = (line) => LABELS.some((re) => re.test(line)) || (COOKIE.test(line) && line.length < 220);
const headingLike = (line) => line.length <= 60 && !/[.!?,;]$/.test(line) && !BULLET.test(line) && /^[A-Z0-9]/.test(line);

export function cleanPosting(raw) {
  let lines = String(raw ?? '').replace(/\r\n?/g, '\n').replace(/[\u00a0\u200b\u2028\u2029]/g, ' ').split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim());

  // Page furniture, then repeats of the same line one after another.
  lines = lines.filter((l) => !l || !isLabel(l));
  // Page tabs (DESCRIPTION, BENEFITS, QUESTIONS) are dropped when they sit together.
  const TAB = /^(description|benefits|questions|overview|details|apply)$/i;
  const around = (i, step) => { for (let k = i + step; k >= 0 && k < lines.length; k += step) if (lines[k]) return lines[k]; return ''; };
  lines = lines.filter((l, i) => !(l && TAB.test(l) && (TAB.test(around(i, 1)) || TAB.test(around(i, -1)))));
  lines = lines.filter((l, i) => !l || l !== lines.slice(0, i).reverse().find((x) => x));

  // A stack of short labels and values ("Employer", blank, "College of the Desert", blank, "Salary", ...) becomes
  // "Employer: College of the Desert" lines, once at least three pairs run in a row.
  const isKey = (l) => l && l.length <= 24 && !/[.:;!?]$/.test(l) && !BULLET.test(l) && /^[A-Z]/.test(l);
  const isVal = (l) => l && l.length <= 100 && !BULLET.test(l);
  const stacked = [];
  for (let i = 0; i < lines.length;) {
    let j = i;
    const pairs = [];
    while (isKey(lines[j]) && lines[j + 1] === '' && isVal(lines[j + 2]) && (lines[j + 3] === '' || j + 3 >= lines.length)) {
      pairs.push(`${lines[j]}: ${lines[j + 2]}`);
      j += 4;
    }
    if (pairs.length >= 3) { stacked.push(...pairs, ''); i = j; } else { stacked.push(lines[i]); i += 1; }
  }
  lines = stacked;

  // Bullet marks become one style.
  lines = lines.map((l) => (BULLET.test(l) ? `- ${l.replace(BULLET, '')}` : l));

  // Double-spaced text (a blank line after nearly every line) loses its blanks, except before headings.
  const filled = lines.filter(Boolean);
  const gaps = lines.reduce((n, l, i) => n + (l && lines[i + 1] === '' && lines[i + 2] ? 1 : 0), 0);
  if (filled.length > 6 && gaps / filled.length >= 0.6) {
    const out = [];
    filled.forEach((l, i) => {
      if (i > 0 && headingLike(l) && !(out.at(-1) && headingLike(out.at(-1)) && out.at(-1).length < 40 && out.length && out.at(-2) === '')) out.push('');
      out.push(l);
    });
    lines = out;
  }

  // Lines broken in the middle of a sentence are joined again.
  const joined = [];
  for (const l of lines) {
    const prev = joined.at(-1);
    if (prev && l && !BULLET.test(l) && !/^- /.test(l) && prev.length >= 50 && !/[.!?:;)"”]$/.test(prev) && /^[a-z(]/.test(l)) joined[joined.length - 1] = `${prev} ${l}`;
    else joined.push(l);
  }

  // One blank line at most, none at the ends, none between bullets.
  const out = [];
  for (const l of joined) {
    if (!l && (!out.length || !out.at(-1))) continue;
    out.push(l);
  }
  while (out.at(-1) === '') out.pop();
  const squeezed = out.filter((l, i) => !(l === '' && out[i - 1]?.startsWith('- ') && out[i + 1]?.startsWith('- ')));
  return squeezed.join('\n');
}
