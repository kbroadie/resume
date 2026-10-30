// Typesets a resume as a PDF.
//
// The design follows Bringhurst, The Elements of Typographic Style, within the limits of an applicant tracking
// system: one family (Libertinus Serif, with its Display cut for the name), letterspaced capitals for section
// headings (small-cap glyphs extract as mixed-case text, so real capitals are used instead), tabular lining figures for dates, a measured leading of about 129%,
// hanging bullets, kerning on, and a hairline rule under each heading. Ligatures are left off and every glyph is
// mapped back to Unicode text, so an ATS reads exactly what a person reads.
//
// layoutResume() is pure: it takes a measuring function and returns positioned text, so it can be tested without
// a browser. buildPdf() embeds the fonts and draws the result.

import { typo } from './lib.js?v=29';

export const PAGE = { width: 612, height: 792, left: 72, right: 72, top: 62, bottom: 70 };

const INK = [0.09, 0.08, 0.06];
const INK2 = [0.31, 0.29, 0.25];
const RULE = [0.79, 0.76, 0.69];

// Font variants. Each pairs a font file with the OpenType features it is embedded with.
export const FONT_VARIANTS = {
  r: { file: 'LibertinusSerif-Regular.ttf', features: { kern: true, liga: false, lnum: true } },
  i: { file: 'LibertinusSerif-Italic.ttf', features: { kern: true, liga: false, lnum: true } },
  s: { file: 'LibertinusSerif-Semibold.ttf', features: { kern: true, liga: false, lnum: true } },
  d: { file: 'LibertinusSerifDisplay-Regular.ttf', features: { kern: true, liga: false, lnum: true } },
  n: { file: 'LibertinusSerif-Regular.ttf', features: { kern: true, liga: false, tnum: true, lnum: true } }
};

/* ---------- line breaking ---------- */

// Words that should never be split from their neighbor: "$50 million", "27+ years", "A & B".
const GLUE_BEFORE = /^[$]?\d[\d,.]*[+%]?$|^&$/;

function tokenize(runs) {
  const tokens = [];
  for (const run of runs) {
    const words = String(run.text).split(/( +)/).filter((w) => w !== '');
    for (const w of words) {
      if (/^ +$/.test(w)) { if (tokens.length) tokens.at(-1).space = (tokens.at(-1).space || 0) + 1; continue; }
      tokens.push({ text: w, font: run.font, color: run.color, space: 0 });
    }
  }
  // Glue short number and ampersand tokens to the word that follows.
  const glued = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (GLUE_BEFORE.test(t.text) && tokens[i + 1] && t.space) {
      const n = tokens[i + 1];
      glued.push({ parts: [{ text: `${t.text} `, font: t.font, color: t.color }, { text: n.text, font: n.font, color: n.color }], space: n.space });
      i += 1;
    } else {
      glued.push({ parts: [{ text: t.text, font: t.font, color: t.color }], space: t.space });
    }
  }
  return glued;
}

// Greedy wrap of styled runs into lines no wider than `width`. The last line is kept from ending on one short word.
export function wrapRuns(runs, width, size, measure) {
  const tokens = tokenize(runs).map((t) => ({
    ...t,
    w: t.parts.reduce((sum, p) => sum + measure(p.text, p.font, size), 0),
    sp: t.space ? measure(' ', t.parts.at(-1).font, size) : 0
  }));
  const lines = [];
  let cur = [];
  let used = 0;
  for (const t of tokens) {
    const add = (cur.length ? cur.at(-1).sp : 0) + t.w;
    if (cur.length && used + add > width) { lines.push(cur); cur = []; used = 0; }
    used += (cur.length ? cur.at(-1).sp : 0) + t.w;
    cur.push(t);
  }
  if (cur.length) lines.push(cur);

  // Avoid a one-word last line: pull the previous line's last word down if both lines still fit.
  if (lines.length > 1) {
    const last = lines.at(-1);
    const prev = lines.at(-2);
    if (last.length === 1 && prev.length > 2) {
      const moved = prev.at(-1);
      const lineWidth = (ts) => ts.reduce((sum, t, i) => sum + t.w + (i < ts.length - 1 ? t.sp : 0), 0);
      if (lineWidth([moved, last[0]]) <= width) { prev.pop(); last.unshift(moved); }
    }
  }
  return lines.map((ts) => {
    const out = [];
    ts.forEach((t, i) => {
      t.parts.forEach((p, j) => out.push({ text: p.text + (j === t.parts.length - 1 && i < ts.length - 1 && t.space ? ' ' : ''), font: p.font, color: p.color }));
    });
    return out;
  });
}

/* ---------- blocks ---------- */

// Builds the document as blocks of lines. Every length scales with the base size.
function buildBlocks(doc, size, measure) {
  const W = PAGE.width - PAGE.left - PAGE.right;
  const lead = size * 1.29;
  const blocks = [];
  const T = (s) => typo(s);
  const plain = (text, font = 'r', color = INK) => [{ text: T(text), font, color }];

  // Name, headline, contact
  blocks.push({ keepNext: true, lines: [{ kind: 'name', runs: plain(doc.name, 'd'), size: size * 2.45, lead: size * 2.7 }] });
  if (doc.headline) blocks.push({ keepNext: true, lines: [{ kind: 'headline', runs: plain(doc.headline, 'i', INK2), size, lead: lead }] });
  if (doc.contact.length) {
    const contactLines = wrapRuns(plain(doc.contact.join(' · '), 'r', INK2), W, size * 0.94, measure);
    blocks.push({ lines: contactLines.map((runs) => ({ kind: 'contact', runs, size: size * 0.94, lead })) });
  }

  const heading = (title) => blocks.push({
    spaceBefore: size * 1.25, keepNext: true,
    lines: [{ kind: 'heading', runs: [{ text: title.toUpperCase(), font: 's', color: INK }], size: size * 0.84, lead, tracking: size * 0.84 * 0.13, rule: true }]
  });
  const paragraph = (runs, opts = {}) => {
    const lines = wrapRuns(runs, W - (opts.indent || 0), size, measure);
    blocks.push({ ...opts, lines: lines.map((r) => ({ kind: 'text', runs: r, x: opts.indent || 0, size, lead })) });
  };

  if (doc.summary) { heading('Summary'); paragraph(plain(doc.summary)); }

  if (doc.skills.length) {
    heading('Skills');
    for (const g of doc.skills) {
      paragraph([{ text: `${T(g.category)}. `, font: 's', color: INK }, { text: T(g.items.join(', ')), font: 'r', color: INK }], { spaceBefore: size * 0.15 });
    }
  }

  if (doc.experience.length) {
    heading('Experience');
    doc.experience.forEach((x, i) => {
      const dates = T(x.dates);
      const datesW = measure(dates, 'n', size * 0.96);
      const titleLines = wrapRuns(plain(x.title, 's'), W - datesW - size * 1.2, size, measure);
      const head = titleLines.map((runs, k) => ({ kind: 'role', runs, size, lead, right: k === 0 ? { text: dates, font: 'n', color: INK2, size: size * 0.96 } : null }));
      const orgRuns = [];
      if (x.org) orgRuns.push({ text: T(x.org), font: 'i', color: INK });
      if (x.location) orgRuns.push({ text: `${x.org ? ', ' : ''}${T(x.location)}`, font: 'r', color: INK2 });
      if (orgRuns.length) {
        for (const runs of wrapRuns(orgRuns, W, size * 0.97, measure)) head.push({ kind: 'org', runs, size: size * 0.97, lead });
      }
      blocks.push({ spaceBefore: i === 0 ? size * 0.05 : size * 0.75, keepNext: true, lines: head });
      x.bullets.forEach((b, k) => {
        const indent = size * 1.1;
        const lines = wrapRuns(plain(b), W - indent, size, measure);
        blocks.push({
          spaceBefore: size * 0.2, keepNext: false, splittable: lines.length > 3,
          lines: lines.map((runs, n) => ({ kind: 'bullet', runs, x: indent, bullet: n === 0, size, lead }))
        });
      });
    });
  }

  const simple = (title, items) => {
    if (!items.length) return;
    heading(title);
    items.forEach((item, i) => {
      const parts = String(item).split(' | ');
      if (parts.length >= 2) {
        const lines = [...wrapRuns(plain(parts[0], 'r'), W, size, measure).map((runs) => ({ kind: 'text', runs, size, lead }))];
        const where = [{ text: T(parts[1]), font: 'i', color: INK }];
        if (parts[2]) where.push({ text: `, ${T(parts[2])}`, font: 'r', color: INK2 });
        for (const runs of wrapRuns(where, W, size * 0.97, measure)) lines.push({ kind: 'org', runs, size: size * 0.97, lead });
        blocks.push({ spaceBefore: i === 0 ? size * 0.05 : size * 0.45, lines });
      } else {
        paragraph(plain(item), { spaceBefore: size * 0.15 });
      }
    });
  };
  simple('Education', doc.education);
  simple('Certifications', doc.certifications);
  simple('Affiliations', doc.affiliations);
  return blocks;
}

/* ---------- pagination ---------- */

function paginate(blocks) {
  const usable = PAGE.height - PAGE.top - PAGE.bottom;
  const pages = [[]];
  let y = 0;
  const heightOf = (lines) => lines.reduce((sum, l) => sum + l.lead, 0);
  const place = (lines, spaceBefore) => {
    const page = pages.at(-1);
    y += page.length ? spaceBefore : 0;
    for (const line of lines) { page.push({ ...line, top: y }); y += line.lead; }
  };
  const newPage = () => { pages.push([]); y = 0; };

  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i];
    const before = pages.at(-1).length ? (b.spaceBefore || 0) : 0;
    let need = before + heightOf(b.lines);
    // Keep a heading or role header with the first lines of what follows, however long the chain of headers.
    for (let j = i; blocks[j].keepNext && blocks[j + 1]; j += 1) {
      const next = blocks[j + 1];
      const take = next.keepNext || !(next.splittable || next.lines.length > 2) ? next.lines : next.lines.slice(0, 2);
      need += (next.spaceBefore || 0) + heightOf(take);
      if (!next.keepNext) break;
    }
    if (y + need > usable && pages.at(-1).length) {
      // A long bullet may split across pages, never leaving a single line behind.
      if (b.splittable && !b.keepNext) {
        const room = usable - y - before;
        let fit = 0;
        let h = 0;
        for (const l of b.lines) { if (h + l.lead > room) break; h += l.lead; fit += 1; }
        if (fit >= 2 && b.lines.length - fit >= 2) {
          place(b.lines.slice(0, fit), b.spaceBefore || 0);
          newPage();
          place(b.lines.slice(fit).map((l) => ({ ...l, bullet: false })), 0);
          continue;
        }
      }
      newPage();
      place(b.lines, 0);
    } else {
      place(b.lines, b.spaceBefore || 0);
    }
  }
  return pages;
}

// Lays the resume out at the largest base size that gives the fewest pages (between 9.75 and 10.5 points).
export function layoutResume(doc, measure) {
  let best = null;
  for (const size of [10.5, 10.25, 10, 9.75]) {
    const pages = paginate(buildBlocks(doc, size, measure));
    if (!best || pages.length < best.pages.length) best = { size, pages };
  }
  return best;
}

/* ---------- drawing ---------- */

async function loadScript(src) {
  await new Promise((resolve, reject) => {
    const s = Object.assign(document.createElement('script'), { src, async: true });
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.append(s);
  });
}

// deps: { PDFLib, fontkit, loadFont(file) -> Uint8Array }. In the browser the defaults load the vendored libraries.
export async function buildPdf(doc, meta = {}, deps = null) {
  if (!deps) {
    if (!window.PDFLib) await loadScript('vendor/pdf-lib.min.js?v=29');
    if (!window.fontkit) await loadScript('vendor/fontkit.umd.min.js?v=29');
    deps = {
      PDFLib: window.PDFLib,
      fontkit: window.fontkit,
      loadFont: async (file) => {
        const res = await fetch(`fonts/pdf/${file}`);
        if (!res.ok) throw new Error(`Could not load font ${file}`);
        return new Uint8Array(await res.arrayBuffer());
      }
    };
  }
  const { PDFLib, fontkit, loadFont } = deps;
  const pdf = await PDFLib.PDFDocument.create();
  pdf.registerFontkit(fontkit);

  const files = {};
  const fonts = {};
  for (const [key, v] of Object.entries(FONT_VARIANTS)) {
    files[v.file] ||= await loadFont(v.file);
    fonts[key] = await pdf.embedFont(files[v.file], { subset: true, features: v.features });
  }
  const tracking = {};
  const measure = (text, font, size, track = 0) => fonts[font].widthOfTextAtSize(text, size) + (track || tracking[font] || 0) * text.length;

  const layout = layoutResume(doc, measure);
  const total = layout.pages.length;
  const rgb = (c) => PDFLib.rgb(c[0], c[1], c[2]);

  layout.pages.forEach((lines, index) => {
    const page = pdf.addPage([PAGE.width, PAGE.height]);
    const baseline = (line) => PAGE.height - PAGE.top - line.top - line.size * 0.92 - (line.lead - line.size * 1.2) / 2;
    for (const line of lines) {
      let x = PAGE.left + (line.x || 0);
      const y = baseline(line);
      if (line.bullet) {
        page.drawText('•', { x: PAGE.left + line.size * 0.15, y, size: line.size, font: fonts.r, color: rgb(INK2) });
      }
      for (const run of line.runs) {
        const track = line.tracking || 0;
        if (track) page.pushOperators(PDFLib.setCharacterSpacing(track));
        page.drawText(run.text, { x, y, size: line.size, font: fonts[run.font], color: rgb(run.color || INK) });
        if (track) page.pushOperators(PDFLib.setCharacterSpacing(0));
        x += measure(run.text, run.font, line.size, track);
      }
      if (line.right) {
        const w = measure(line.right.text, line.right.font, line.right.size);
        page.drawText(line.right.text, { x: PAGE.width - PAGE.right - w, y, size: line.right.size, font: fonts[line.right.font], color: rgb(line.right.color) });
      }
      if (line.rule) {
        const ry = y - line.size * 0.38;
        page.drawLine({ start: { x: PAGE.left, y: ry }, end: { x: PAGE.width - PAGE.right, y: ry }, thickness: 0.5, color: rgb(RULE) });
      }
    }
    if (total > 1) {
      const label = `${doc.name}  ·  Page ${index + 1} of ${total}`;
      const size = 8.5;
      const w = measure(label, 'i', size);
      page.drawText(label, { x: (PAGE.width - w) / 2, y: PAGE.bottom * 0.5, size, font: fonts.i, color: rgb(INK2) });
    }
  });

  pdf.setTitle(meta.title || `${doc.name} Resume`);
  pdf.setAuthor(doc.name);
  pdf.setSubject(meta.subject || 'Resume');
  pdf.setCreator('Resume Advisor');
  pdf.setProducer('Resume Advisor');
  pdf.setLanguage?.('en-US');
  return { bytes: await pdf.save(), pages: total, size: layout.size };
}

/* ---------- reading an edited plain-text resume back into a document ---------- */

// Parses the app's own plain-text format (see renderText). Returns null if it does not look like one.
export function docFromText(text) {
  const lines = String(text).replace(/\r/g, '').split('\n');
  const doc = { name: '', headline: '', contact: [], summary: '', skills: [], experience: [], education: [], certifications: [], affiliations: [] };
  const HEADS = { SUMMARY: 'summary', SKILLS: 'skills', EXPERIENCE: 'experience', EDUCATION: 'education', CERTIFICATIONS: 'certifications', AFFILIATIONS: 'affiliations' };
  let i = 0;
  const next = () => lines[i++];
  const name = (next() || '').trim();
  if (!name) return null;
  doc.name = name.replace(/\b([A-Z])([A-Z]+)\b/g, (_, a, b) => a + b.toLowerCase());
  const head = [];
  while (i < lines.length && lines[i].trim() && !HEADS[lines[i].trim()]) head.push(next().trim());
  if (head.length >= 2) { doc.headline = head[0]; doc.contact = head[1].split(' | '); }
  else if (head.length === 1) doc.contact = head[0].split(' | ');
  let section = null;
  let role = null;
  for (; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) { role = role && section !== 'experience' ? null : role; continue; }
    if (HEADS[line]) { section = HEADS[line]; role = null; continue; }
    if (section === 'summary') doc.summary = [doc.summary, line].filter(Boolean).join(' ');
    else if (section === 'skills') { const m = line.match(/^([^:]+):\s*(.*)$/); doc.skills.push(m ? { category: m[1], items: m[2].split(/,\s*/) } : { category: 'Skills', items: [line] }); }
    else if (section === 'experience') {
      if (line.startsWith('- ')) { role?.bullets.push(line.slice(2)); }
      else if (role && !role.dates && /\d{4}|Present/.test(line)) role.dates = line;
      else { const p = line.split(' | '); role = { title: p[0], org: p[1] || '', location: p[2] || '', dates: '', bullets: [] }; doc.experience.push(role); }
    } else if (section) doc[section].push(line);
  }
  return doc.experience.length || doc.summary ? doc : null;
}
