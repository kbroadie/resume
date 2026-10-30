# Resume Advisor

A mobile-first web app that tailors Kevin Broadie's resume to a pasted job posting. Claude chooses the phrasing and priorities. It uses only what is in `data/profile.json`.

## Using it

Five tabs along the bottom keep each task on one screen:

- **Tailor:** the application link is the default. Add it and tap Tailor resume, and Claude reads the posting from the page first (using Anthropic's web fetch tool, limited to that site). Tap Read beside the link to do only that step. If there is no link, or the page needs a login, paste the posting instead: tap Paste, or press and hold in the dashed box. The page does not edit the posting; it only shows that the text arrived (a green check and the word count), with View to read it and Clear to start over. Pages that need a login, or organizations that have not allowed web fetch, fall back to pasting. Your draft is saved, so a reload never loses it. Ctrl or Cmd + Enter also tailors.
- **Resume:** the result, with word and page count, a keyword match against the posting's own terms, and a checks summary. Copy the whole resume, or tap the small Copy button on a section or a single job to fill one application field. Download the text or a typeset PDF, or Edit the text by hand (with Revert). The PDF is built from your edits too. Below the resume: suggested rephrasings, an applicant tracking check, the keyword match, and the application system. Open application takes you to the link you saved.
- **Questions:** one at a time. Save an answer as a fact or a preference, pick between wordings, skip, or choose Don't ask again. Answered questions never come back.
- **Library:** merge saved answers into the master profile, or teach it something directly.
- **History:** every resume you tailor, on this device only, with its status (Drafted, Applied, Interviewing, Offer, Rejected, Withdrawn), application link, and keyword match.

The sun and moon button switches between automatic, light, and dark. Settings (gear) holds the model, GitHub sync, and sign-out. You can add the page to your phone's home screen.

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
- `lib.js`: prompt, schema, validation, and rendering (no DOM)
- `knowledge.js`: saved answers, merging, and question filtering
- `sync.js`: saves `data/knowledge.json` to GitHub
- `data/knowledge.json`: saved answers (starts empty)
- `data/profile.json`: the source of truth
- `test/`: tests

## Typography

The app and the PDF resumes follow Bringhurst's *The Elements of Typographic Style*.

- **Typeface:** Libertinus Serif (SIL Open Font License; `fonts/OFL.txt`), with its Display cut for the name and large headings. It is a deliberate choice away from the usual web fonts, and it carries real small caps, old-style and lining figures, tabular figures, and ligatures. The files come from the Libertinus 7.051 release, converted to TrueType outlines and subset to Latin with their OpenType features kept: `fonts/*.woff2` for the page and `fonts/pdf/*.ttf` for PDFs.
- **In the app:** labels in true small caps with added letterspacing; old-style figures in running text and tabular lining figures for dates and counts; a major-third scale from a 17px base; leading near 140%; a column of about 66 characters; typographic quotes and en dashes (the plain-text export stays ASCII so forms never choke).
- **In the PDF:** one family, kerning on, a hairline under each heading, dates flush right in tabular lining figures, hanging bullets, leading near 129%, a headline in italic, and a quiet running foot on later pages. Line breaking avoids one-word last lines and keeps numbers with their units. Headings, keep-together rules, and widow and orphan control are tested.
- **Why not LaTeX:** LaTeX would need a server, and the PDF can be made on a phone with no install. Direct control of the font's OpenType features gets the same quality without it.
- **Why the PDF has capitals and no ligatures:** an applicant tracking system reads the PDF's text. Small-cap glyphs extract as mixed-case letters ("ExpEriEncE"), so section headings are real letterspaced capitals instead, and ligatures are left off. Every glyph maps back to Unicode text. I checked extraction with `pdftotext`.
- **PDF engine:** `pdf-lib` and `@pdf-lib/fontkit`, vendored in `vendor/` and loaded only when you tap PDF.
- **Fonts and the PDF library:** a font whose outlines exceed about 128 KB switches to a long glyph index that the library's subsetter mishandles, which made italic text lose letters. The PDF fonts are trimmed to the features the layout uses, and a test guards the format.

## Application systems and the applicant tracking check

- **Which system:** from the Apply link on the page, then the posting link's address, then any "powered by" wording, against a table of about two dozen systems (Greenhouse, Lever, Workday, iCIMS, Taleo, NEOGOV, CalCareers, USAJOBS and others). Tap the system name on the Resume tab for what it typically asks, with tips for using this resume. These describe typical behavior, since each employer configures its own form.
- **"Find and click Apply":** the page is read, not driven, so only an Apply link whose address appears in the page can be followed. Buttons that open a form with scripts cannot be. The system sheet says so, and lets you pick the system yourself.
- **Check the form:** reads the application page and lists its fields, required marks, accepted file types, questions, and notes such as character limits. Many forms load only after sign-in or with scripts, in which case it tells you so.
- **Applicant tracking check:** local checks that do not use the model: contact details in the body, standard headings, one date format, length, plain characters, whether keywords appear in job bullets and not only the skills list, and whether the posting's title is echoed.
- **Suggested rephrasings:** the model may propose rewording a bullet (or the summary) to use a posting term, only where your library already supports it. The app drops any suggestion that does not replace a line that is really in the resume, whose keyword is not already in your library, that adds more than two new words, or that adds a number. Apply swaps it in; Dismiss removes it.
