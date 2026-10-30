# Resume Advisor

A mobile-first web app that tailors Kevin Broadie's resume to a pasted job posting. Claude chooses the phrasing and priorities. It uses only what is in `data/profile.json`.

## Using it

Five tabs along the bottom keep each task on one screen (History is the clock in the top bar):

- **Tailor:** paste the job posting: copy it on its page, then tap Paste from clipboard (or press and hold in the strip below and choose Paste). The page does not edit the posting; it shows a "Posting added" card with the word count and the posting's first line, with View to read it and Clear to start over. Then choose a location and tap Tailor resume. Your draft is saved, so a reload never loses it. Ctrl or Cmd + Enter also tailors. Reading a posting from a link did not work reliably, so that field is hidden for now. The code is still in `app.js`; set `LINK_READING` to `true` to bring it back.
- **Resume:** the result, with word and page count, a checks summary, and the posting fit scores. Copy the whole resume, or tap the small Copy button on a section or a single job to fill one application field. The **Download** group holds the two download links, Text (.txt) and PDF (.pdf); the PDF is typeset and is built from your edits too. Edit changes the text by hand (with Revert). **Regenerate** opens a sheet to write a fresh draft from the same posting, with an optional note about what should change (ideas are one tap) and the short-titles and caregiver-line options. The new draft replaces the old one in History, and Undo in the toast brings the previous draft back. Resumes made before the posting text was kept cannot be regenerated. When you save answers on the Questions tab after a draft was written, the Resume tab shows "N new answers since this draft" with a one-tap Regenerate, and the Questions tab's last screen offers "Regenerate the resume with my answers". Both rewrite the same resume in place with the same options, so you never start over. A draft you edited by hand opens the sheet first, since regenerating replaces the edits. Open application takes you to the link you saved. Improve and Compare lead to the next steps.
- **Improve:** keyword coverage as a meter and chips (green is in the resume, amber is missing). Right after tailoring, the app looks for natural rewrites that work the missing keywords into lines your library already supports, and they appear here as **Keyword rewrites** (Apply, or Dismiss; Apply all and Find more are at the top of the list). Settings has a switch for that automatic pass. Terms your library cannot support are listed under "Not in your library" so you can teach them if true. The same tab holds the **Summary** writer and the applicant tracking check.
- **Summary:** Write summary options returns up to three short summaries (Impact, Skills, Brief). Each uses only facts from your library; numbers must come from your own entries, and any option that adds one is dropped. Use this swaps it into the resume, and Restore brings the original back.
- **Comment box:** the bar at the bottom of the Resume tab. Type a change ("lead with grant writing") and send. Claude revises the draft on screen, keeping the rest as it is, and only using what your library supports; Undo in the toast brings the old draft back. Requests accumulate in the draft's notes, so later regenerations keep them.
- **Compare:** the full job posting and the draft resume side by side (Posting, Both, or Resume). Keywords are highlighted green where they appear and amber where they do not; tap a chip to jump between occurrences, or Find wording to ask for a rewrite of a missing term. Postings from before this feature can be pasted in from the Compare view.
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
- `icons.js`: the inline icon set and the flourish divider
- `fonts/LibertinusSans-*.woff2`: the sans cuts used by the interface
- `favicon.svg`, `favicon.ico`, `apple-touch-icon.png`, `icon-*.png`: the icon set (a serif R with a check mark); `manifest.webmanifest` lists the sizes, including a maskable one
- `lib.js`: prompt, schema, validation, and rendering (no DOM)
- `knowledge.js`: saved answers, merging, and question filtering
- `sync.js`: saves `data/knowledge.json` to GitHub
- `data/knowledge.json`: saved answers (starts empty)
- `data/profile.json`: the source of truth
- `test/`: tests

## Typography

The app and the PDF resumes follow Bringhurst's *The Elements of Typographic Style*.

- **Typeface:** Libertinus Serif (SIL Open Font License; `fonts/OFL.txt`), with its Display cut for the name and large headings, and Libertinus Sans from the same family for the controls. The serif reads (titles, questions, the resume) and the sans acts (labels, buttons, chips, tabs, counts, hints), in regular and bold. The PDF stays all serif. It is a deliberate choice away from the usual web fonts, and it carries real small caps, old-style and lining figures, tabular figures, and ligatures. The files come from the Libertinus 7.051 release, converted to TrueType outlines and subset to Latin with their OpenType features kept: `fonts/*.woff2` for the page and `fonts/pdf/*.ttf` for PDFs.
- **In the app:** labels in true small caps with added letterspacing; old-style figures in running text and tabular lining figures for dates and counts; a major-third scale from a 17px base; leading near 140%; a column of about 66 characters; typographic quotes and en dashes (the plain-text export stays ASCII so forms never choke).
- **In the PDF:** one family, kerning on, a hairline under each heading, dates flush right in tabular lining figures, hanging bullets, leading near 129%, a headline in italic, and a quiet running foot on later pages. Line breaking avoids one-word last lines and keeps numbers with their units. Headings, keep-together rules, and widow and orphan control are tested.
- **Why not LaTeX:** LaTeX would need a server, and the PDF can be made on a phone with no install. Direct control of the font's OpenType features gets the same quality without it.
- **Why the PDF has capitals and no ligatures:** an applicant tracking system reads the PDF's text. Small-cap glyphs extract as mixed-case letters ("ExpEriEncE"), so section headings are real letterspaced capitals instead, and ligatures are left off. Every glyph maps back to Unicode text. I checked extraction with `pdftotext`.
- **PDF engine:** `pdf-lib` and `@pdf-lib/fontkit`, vendored in `vendor/` and loaded only when you tap PDF.
- **Fonts and the PDF library:** a font whose outlines exceed about 128 KB switches to a long glyph index that the library's subsetter mishandles, which made italic text lose letters. The PDF fonts are trimmed to the features the layout uses, and a test guards the format.

## Posting fit and the applicant tracking check

- **Posting fit:** two scores out of 100, shown on the Resume tab and in detail on the Improve tab. After tailoring, Claude reads the posting and lists its requirements (8 to 16, required or preferred), saying for each how far your library supports it and citing the library entries. The app checks that report: a claim with no real source becomes "not in your library", and a "strong" claim whose own terms appear nowhere in its sources drops to "related". **Library** is how much of the posting your library can honestly support. **This draft** is how much of that the resume actually shows, worked out here from the resume's own text, so it moves when you apply a rewrite, edit, or regenerate. Required items count three times as much as preferred ones, a related match earns half credit, and scores are rounded down. The draft score can never beat the library score. The detail lists what your library backs but the draft leaves out (with an **Ask for it** button that fills the comment box), what the draft already shows, and what your library cannot support. Re-check after you change the library.

- **Applicant tracking check:** local checks that do not use the model: contact details in the body, standard headings, one date format, length, plain characters, whether keywords appear in job bullets and not only the skills list, and whether the posting's title is echoed.
- **Find more rewrites:** the first pass and the automatic pass offer rewordings. "Find more" on the Improve tab goes after every posting term the resume still lacks, asks for natural sentences (swapping a near-synonym already in the line, one term per bullet, spread across bullets, no stacking), and lists any term your library cannot support so you can teach it if it is true. It works on any resume in History.
- **Suggested rephrasings:** the model may propose rewording a bullet (or the summary) to use a posting term, only where your library already supports it. The app drops any suggestion that does not replace a line that is really in the resume, whose keyword is not already in your library, that adds more than two new words, or that adds a number. Apply swaps it in; Dismiss removes it.
