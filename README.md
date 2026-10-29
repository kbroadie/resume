# Resume Tailor

A mobile-first web app that tailors Kevin Broadie's resume to a pasted job posting. Claude chooses the phrasing and priorities. It uses only what is in `data/profile.json`.

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

Facts that are lasting parts of your history can be promoted into `data/profile.json` by hand or by asking Claude. `knowledge.json` is the app's own file and the profile stays hand-curated.

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
