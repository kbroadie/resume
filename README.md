# Resume Advisor

A mobile-first web app that tailors Kevin Broadie's resume to a pasted job posting. Claude chooses the phrasing and priorities. It uses only what is in `data/profile.json`.

## Using it

Five tabs along the bottom keep each task on one screen:

- **Tailor:** paste the posting (or tap Paste), pick a location, optionally add the application link, and tap Tailor resume. If you add a link and leave the posting box empty, Claude reads the posting from the link first (using Anthropic's web fetch tool, limited to that site) and puts the text in the box for you to check. Tap Read beside the link to do only that step. Pages that need a login, or organizations that have not allowed web fetch, fall back to pasting. Your draft is saved, so a reload never loses it. Ctrl or Cmd + Enter also tailors.
- **Resume:** the result, with word and page count, a keyword match against the posting's own terms, and a checks summary. Copy the whole resume, or tap the small Copy button on a section or a single job to fill one application field. Download, print to PDF, or Edit the text by hand (with Revert). Open application takes you to the link you saved.
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
