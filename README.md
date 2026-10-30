# Resume Advisor

A desktop-first web app that tailors Kevin Broadie's resume to a pasted job posting. Claude chooses the phrasing and priorities. It uses only what is in `data/profile.json`. Narrow windows and phones get a stacked layout.

## Using it

Three areas: a **rail** on the left, the **stage** in the middle, and the **inspector** on the right.

- **Rail:** New, then every resume you have tailored (a dot shows its status; hover for the delete button, which can be undone), Library, and the command, theme, and settings buttons.
- **New:** paste the posting (Ctrl or Cmd + V anywhere on the page, the Paste button, or drop text or a text file onto the box). Pick a location and options, then Tailor (Ctrl or Cmd + Enter). Reading a posting from a link did not work reliably, so that field is hidden; set `LINK_READING` to `true` in `app.js` to bring it back.
- **Resume (stage):** the draft, with Copy, TXT, PDF, Edit, Redo, and Compare. Each section and job has a small Copy button for one form field at a time. The status menu (Drafted, Applied, and so on) sits at the top. **Redo** rewrites the draft from the same posting, with optional notes and the short-titles and caregiver options; Undo in the toast brings the old draft back. When you save answers after a draft was written, a banner offers one-click Redo. The comment box under the draft takes a change request ("lead with grant writing"); Claude revises the draft on screen, keeping the rest and using only what the library supports.
- **Compare (stage):** the posting and the draft side by side, with each term marked as present or missing. Click a term to jump to it; Find asks for a rewrite of a missing one.
- **Inspector tabs:** **Fit** (two scores, below), **Terms** (keyword coverage chips), **Edits** (keyword rewrites you can apply or skip, and the summary writer), **Checks** (the applicant tracking check), and **Ask** (the questions Claude has for you, one at a time).
- **Library (stage):** add a fact, correction, or preference; see saved answers and open questions; merge saved answers into the master profile (you review every change first).

The window works with the keyboard: Ctrl or Cmd + K opens the commands, Alt or Option + 1 to 7 jump to New, Library, and the five inspector tabs, `/` asks for a change, Ctrl or Cmd + S saves the PDF, Ctrl or Cmd + Shift + C copies the resume, and `?` lists them all. The window title names the resume. Installed from the browser as an app, the title bar folds into the page where the browser supports it.

## How it works

1. Sign in with an Anthropic API key. The key stays in the browser (session storage, or local storage if "Remember" is checked) and is sent only to `api.anthropic.com`.
2. Paste a posting. Optionally add answers or instructions for the run.
3. The app sends the posting and the verified part of the profile to Claude.
4. Claude returns structured content. Every bullet cites the profile entries it came from.
5. The app checks the output against the profile, then prints titles, employers, and dates from the profile itself, never from the model.

Output is one column of plain text with standard headings (Summary, Skills, Experience, Education, Certifications), `Title | Employer | Location` lines, `Mon YYYY - Mon YYYY` dates, and `-` bullets. That reads cleanly in applicant-tracking systems and form auto-fillers. Use **Copy text** or **Download .txt** for form fields, and **Print or save PDF** for a text-based PDF (not an image).

## Guardrails

- Items with `"status": "needs_confirm"` are never used. They come back as questions.
- Bullets sharing a `group` are alternate wordings or conflicting figures. Claude may use one and must ask which.
- The Checks tab flags any bullet with no source, a source from another role, a held-back source, an extra alternate wording, or a number that is not in its sources.
- `never_include` lists items that stay out of resumes (license number, street address, reference details, self-ID answers, family details beyond the approved line).
- Education years are never printed. Skill levels are never printed. Expired certifications are not used.
- Some profile wording began as answers on applications for the Hemet, Dodgers, and SB Museum postings. Kevin was not hired by them, so the app never names those organizations or implies he worked there, and application-form answers are not resume content.
- Only California Arts Council and CVAG are public service jobs. The government title "Program Specialist II, Visual Branding & Communications Specialist" is used only for government postings, and "Creative Technology Director" only when it fits a posting better than "Art Director".
- Pick the location (Yucca Valley or Palm Springs) for each resume. Only city and state are printed.

## Saved answers (the database that keeps improving)

Each question on the Questions tab can be answered once:

- **Which wording?** Tap the one you want. Its alternates disappear from every future run.
- **Free-text questions:** Type an answer and save it as a **fact** (becomes a citable bullet, attached to a role when the question names one) or a **preference** (a standing instruction, such as "always lead with grants").
- **Don't ask again:** Marks the topic as settled.

The model is told every saved answer and must not repeat the question; the app also filters any repeated question itself. Remove a saved answer under **Saved answers** to be asked again.

Answers always save on the device. To follow you across devices, add a fine-grained GitHub token (repository `resume`, Contents read and write) under **Sync saved answers to GitHub**. Answers are then committed to `data/knowledge.json`. That file is public, like the rest of the repo. Reading works without a token.

## Merging answers into the master library

Saved answers do not stay in a side file. Tap **Merge N saved answers into my library** (on the Questions tab, or under **My library**) and Claude drafts proper edits to `data/profile.json`, the way a chat session would:

- a fact becomes a reworded resume bullet on the right job, with tags
- a wording choice keeps your pick and drops its alternates
- a correction changes a role's title, dates, or location; a title that suits some postings becomes a title option
- a standing instruction becomes a preference; "never include" items are added to the never-include list
- answered entries disappear from the profile's open questions

You see each change in plain words before anything is saved. Nothing is deleted except the alternates of a wording you chose, and any number or date in a new bullet must appear in your own words, so the app cannot add a figure you did not give. The edit is committed to `data/profile.json` on GitHub (a GitHub token is required, see above), and every change is in the git history if you want to undo it. **Teach the library something** adds a free-text fact or correction straight into the same review.

Merged answers stop acting on their own, because the library now holds them, but their questions are still never asked again.

Because the app commits to the repo, pull before editing the profile by hand.

## Editing the profile

Edit `data/profile.json` and reload. Add a bullet by giving it a unique `id`, `status`, `tags`, and `text`. Move something from `needs_confirm` to `verified` once Kevin confirms it. Answer the items in `open_questions` and delete them.

The phone number in the profile is a placeholder, `(555) 555-5555`. This repository is public, so keep real contact details out of it; replace the number in the downloaded resume.

## Run locally

```
npm run serve     # then open http://localhost:8080
npm test          # unit tests for the library
```

There is no build step and no dependencies.

## Publish on GitHub Pages

Settings > Pages > Deploy from a branch > `main` / root. The page is public, and so is the profile. The API key is never stored in the repository.

## Files

- `index.html`, `styles.css`, `app.js`: the interface
- `icons.js`: the inline icon set and the flourish divider
- `fonts/`: the interface fonts (variable), Libertinus Serif for the resume, and `pdf/` for the PDF
- `favicon.svg`, `favicon.ico`, `apple-touch-icon.png`, `icon-*.png`: the icon set (a serif R with a check mark); `manifest.webmanifest` lists the sizes, including a maskable one
- `lib.js`: prompt, schema, validation, and rendering (no DOM)
- `knowledge.js`: saved answers, merging, and question filtering
- `sync.js`: saves `data/knowledge.json` to GitHub
- `data/knowledge.json`: saved answers (starts empty)
- `data/profile.json`: the source of truth
- `test/`: tests

## Typography

- **Interface:** Hanken Grotesk for text and controls and Schibsted Grotesk for headings and numbers, both Google Fonts under the SIL Open Font License, self-hosted as variable fonts (`fonts/HankenGrotesk-Variable.woff2`, `fonts/SchibstedGrotesk-Variable.woff2`, with licenses alongside). The page uses as few words as it can.
- **The resume:** Libertinus Serif (also OFL; `fonts/OFL.txt`), on screen and in the PDF, following Bringhurst: one family, kerning on, hairline rules under capitalized headings, dates in tabular lining figures, hanging bullets, no ligatures so every glyph maps back to text. Real capitals rather than small caps keep the PDF readable by applicant tracking systems (small-cap glyphs extract as mixed-case letters). The PDF engine is `pdf-lib` and `@pdf-lib/fontkit`, vendored in `vendor/` and loaded only when you ask for a PDF. `fonts/pdf/*.ttf` are trimmed so the subsetter keeps every glyph.

## Posting fit and the applicant tracking check

- **Posting fit:** two scores out of 100, shown beside the resume and in detail on the Fit tab. After tailoring, Claude reads the posting and lists its requirements (8 to 16, required or preferred), saying for each how far your library supports it and citing the library entries. The app checks that report: a claim with no real source becomes "not in your library", and a "strong" claim whose own terms appear nowhere in its sources drops to "related". **Library** is how much of the posting your library can honestly support. **This draft** is how much of that the resume actually shows, worked out here from the resume's own text, so it moves when you apply a rewrite, edit, or regenerate. Required items count three times as much as preferred ones, a related match earns half credit, and scores are rounded down. The draft score can never beat the library score. The detail lists what your library backs but the draft leaves out (with an **Ask for it** button that fills the comment box), what the draft already shows, and what your library cannot support. Re-check after you change the library.

- **Applicant tracking check:** local checks that do not use the model: contact details in the body, standard headings, one date format, length, plain characters, whether keywords appear in job bullets and not only the skills list, and whether the posting's title is echoed.
- **Find more rewrites:** the first pass and the automatic pass offer rewordings. "Find more" on the Edits tab goes after every posting term the resume still lacks, asks for natural sentences (swapping a near-synonym already in the line, one term per bullet, spread across bullets, no stacking), and lists any term your library cannot support so you can teach it if it is true. It works on any resume in History.
- **Suggested rephrasings:** the model may propose rewording a bullet (or the summary) to use a posting term, only where your library already supports it. The app drops any suggestion that does not replace a line that is really in the resume, whose keyword is not already in your library, that adds more than two new words, or that adds a number. Apply swaps it in; Dismiss removes it.
