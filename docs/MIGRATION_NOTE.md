# Migration note: cohort statistics, full-mark examples, Question Studio

Required by the cumulative-baseline policy because items below were replaced or added.
Not part of the public website; do not ship `docs/` or `tests/` in the public ZIP.

## Replaced (explicitly requested in the Cohort Statistics requirements)
- The `2025 report mean …` tag in Practice and the timed exam is replaced by the cohort-statistic tag
  (Section A: `NN% answered correctly`; Section B: `Average: x/max`; otherwise `No cohort statistic published`).
  The underlying `reportMean` field is kept in `data.js` for compatibility.
- Practice no longer shows the model response immediately after assessing a Section B answer.
  It is available through the revision-gated **Reveal full-mark example** control.

## Added data fields (`data.js`)
- `assessmentStatistics` on all 51 questions (`option_distribution` for A, `average_score` for B).
- `fullMarkExample` on all 31 Section B questions (seeded from the existing report-informed `model` text,
  `teacherApproved: false` until a teacher approves each one).
- Criteria now carry a stable id as their third element (`["label", [], "criterion-1"]`).

## Added files
`studio.html`, `studio.js`, `studio-store.js` (Question Studio and shared content layer), `docs/`, `tests/`.
Root file count is therefore above the earlier 40; this note is the documented migration.

## Layout correction
The 12 SVG assets had been uploaded to the repository root, so every question image path
(`image-assets/…`) was broken. They are moved back into `image-assets/`.

## Known limitations
- Criteria text in `data.js` is still the generic "Demonstrates assessable idea N" placeholder, so the
  comparison view relies on the student's own criteria self-check rather than automated marking.
- Full-mark examples are draft text awaiting teacher approval; the UI labels them as such.
- Studio publishing is a single-browser static prototype (localStorage + IndexedDB); it has no accounts,
  roles or server-side enforcement.
- The timed exam honours published rich text and response components, but not yet per-component autosave edge cases beyond the tested table/text flows.

## PDF import fixes (follows the Copilot-added import screen)
- **Error fixed:** the import wrote to `#globalStatus`, which did not exist in `studio.html`, so creating drafts ended with
  "Cannot set properties of null (setting 'textContent')". The element now exists and the importer no longer fails if it is missing.
- **Detection rewritten** (`pdf-ingest-core.js`): reading starts at the first "Question N" heading, so cover pages, instructions
  and lines such as "2 hours" or "20 questions 20 marks" are never treated as questions. Section A is split into wording and four
  options; Section B into a shared statement and lettered parts with their own marks. Cover/instruction pages are unticked by default.
- **Re-importing** replaces earlier unedited PDF drafts (it no longer stops on "already exists"). Edited or published questions are kept.
  New button: **Discard unedited PDF drafts**.
- **Bundled pdf.js** in `vendor/pdfjs/` is used when the CDN copy does not load.

## Publishing rules changed
- A Section A question cannot be published until a correct option is chosen and it has four non-empty options.
  The Studio "Correct option" box now starts blank instead of defaulting to A, and drives the practice-page answer check.
- A question with no cohort statistic yet saves as "not published" (shown as "No cohort statistic published") instead of
  saving zero percentages or a blank average, so it can be published before the examiner report arrives.

## Not yet covered by PDF import
Tables and graphs are not extracted (they need an image clip); curriculum topic is set to "Unclassified"; hints and
cohort statistics come from the examiner report, which is a separate step. Scanned PDFs need the OCR step and manual correction.
