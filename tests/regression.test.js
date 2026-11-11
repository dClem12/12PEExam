/* Regression suite for cumulative requirements.
   Run from the repo root:  NODE_PATH=$(npm root -g) node tests/regression.test.js
   Requires Playwright and a Chromium/Chrome install. Not part of the public website. */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
let base = '';
const url = f => base + f;
let failures = 0, passes = 0;
const check = (name, ok, detail) => {
  if (ok) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.log('  FAIL ' + name + (detail ? ' -> ' + detail : '')); }
};

function loadData() {
  const s = fs.readFileSync(path.join(root, 'data.js'), 'utf8');
  return new Function(s.replace('const QUESTIONS', 'var QUESTIONS').replace('const EXAM_REGISTRY', 'var EXAM_REGISTRY') + ';return QUESTIONS;')();
}

(async () => {
  const Q = loadData();
  const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
  const server = http.createServer((req, res) => {
    const f = path.join(root, decodeURIComponent(req.url.split('?')[0]));
    if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port + '/';

  console.log('Data integrity');
  check('51 questions (20 A, 31 B)', Q.length === 51 && Q.filter(q => q.section === 'A').length === 20 && Q.filter(q => q.section === 'B').length === 31);
  check('all questions carry assessmentStatistics', Q.every(q => q.assessmentStatistics));
  check('Section A uses option_distribution', Q.filter(q => q.section === 'A').every(q => q.assessmentStatistics.statisticType === 'option_distribution'));
  check('Section B uses average_score', Q.filter(q => q.section === 'B').every(q => q.assessmentStatistics.statisticType === 'average_score'));
  check('option percentages total 100 +/- 1', Q.filter(q => q.section === 'A').every(q => Math.abs(Object.values(q.assessmentStatistics.optionPercentages).reduce((a, b) => a + b, 0) - 100) <= 1));
  check('correct option exists and matches correctPercentage', Q.filter(q => q.section === 'A').every(q => q.assessmentStatistics.optionPercentages[q.assessmentStatistics.correctOption] === q.assessmentStatistics.correctPercentage));
  check('average score within 0..max and max equals marks', Q.filter(q => q.section === 'B').every(q => { const s = q.assessmentStatistics; return s.averageScore >= 0 && s.averageScore <= s.maximumScore && s.maximumScore === q.marks; }));
  check('every Section B question has a full-mark example', Q.filter(q => q.section === 'B').every(q => q.fullMarkExample && q.fullMarkExample.content));
  check('every example demonstrates all configured criteria', Q.filter(q => q.section === 'B').every(q => q.criteria.every(c => q.fullMarkExample.criteriaDemonstrated.includes(c[2]))));
  check('examples are never marked as the only acceptable answer', Q.filter(q => q.section === 'B').every(q => q.fullMarkExample.isOnlyAcceptableAnswer === false));

  console.log('Packaging');
  const missing = [];
  for (const f of fs.readdirSync(root).filter(f => f.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(root, f), 'utf8');
    for (const m of html.matchAll(/(?:href|src)="([^"#:][^"]*)"/g)) {
      const target = m[1].split('?')[0];
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // external URLs are not local links
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // external URLs are not local links
      if (target && !fs.existsSync(path.join(root, target))) missing.push(f + ' -> ' + target);
    }
  }
  check('no broken local links or scripts', missing.length === 0, missing.slice(0, 5).join('; '));
  const brokenAssets = Q.flatMap(q => q.visualAssets).filter(a => !fs.existsSync(path.join(root, a)));
  check('every question image asset exists', brokenAssets.length === 0, brokenAssets.join(', '));
  check('12 asset slots in image-assets', fs.readdirSync(path.join(root, 'image-assets')).length === 12);

  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext();
  await ctx.route(/cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net/, r => r.abort()); // tests use the bundled pdf.js, not the CDN
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  console.log('Practice: tag row and selector');
  await page.goto(url('practice.html'));
  check('initial selector matches rendered question', await page.evaluate(() => selector.options[selector.selectedIndex].text.includes('Question ' + document.querySelector('.tag.purple').textContent.split('Question ')[1])));
  const tagsA = await page.$$eval('.tagrow .tag', e => e.map(x => x.textContent.trim()));
  check('Section A tag order: year, label, topic, marks, statistic', tagsA.length === 5 && /VCAA Exam/.test(tagsA[0]) && /^Section A, Question/.test(tagsA[1]) && /mark/.test(tagsA[3]) && /answered correctly$/.test(tagsA[4]), tagsA.join(' | '));
  check('Section A statistic is not called an average or mean', !/average|mean/i.test(tagsA[4]));
  check('distribution hidden before submission', (await page.locator('.stat-note').count()) === 0);
  await page.locator('input[name=answer]').first().check();
  await page.click('#assess');
  check('distribution shown after submission', /A: \d+% · B: \d+%|A: \d+%/.test(await page.locator('.stat-note').first().textContent()));

  await page.selectOption('#sectionFilter', 'B');
  const tagsB = await page.$$eval('.tagrow .tag', e => e.map(x => x.textContent.trim()));
  check('Section B statistic shows Average: x/y', /^Average: [\d.]+\/\d+$/.test(tagsB[4]), tagsB.join(' | '));

  console.log('Practice: learning sequence');
  await page.fill('#writtenAnswer', 'First attempt text');
  check('example control absent before first submission', (await page.locator('#revealExample').count()) === 0);
  await page.click('#assess');
  check('reveal control locked after first submission', await page.locator('#revealExample').isDisabled());
  check('skip option offered', (await page.locator('#skipReveal').count()) === 1);
  await page.click('#assess');
  check('resubmitting unchanged text does not unlock example', await page.locator('#revealExample').isDisabled());
  await page.click('#hint');
  await page.fill('#writtenAnswer', 'Revised attempt text with more detail');
  await page.click('#assess');
  check('reveal unlocks after revised submission', await page.locator('#revealExample').isEnabled());
  await page.click('#revealExample');
  const exampleText = await page.locator('.example').textContent();
  check('required notice shown', /This is one valid way to achieve full marks\. Other wording may also be accepted\./.test(exampleText));
  check('side-by-side comparison table shown', (await page.locator('table.compare th').allTextContents()).join('|') === 'Student response|Example full-mark response');
  await page.fill('#reflection', 'I missed the link between X and Y');
  const rec = await page.evaluate(() => { const d = JSON.parse(localStorage.getItem('pe13')); const id = Object.keys(d.attempts).find(k => d.attempts[k].viewedExample); return d.attempts[id]; });
  check('records hints, revision, skip flag, view and reflection', rec.hintsUsed === 1 && rec.revisedBeforeReveal === true && rec.skippedRevision === false && rec.viewedExample === true && rec.reflection.startsWith('I missed') && rec.submissions.length === 2, JSON.stringify(rec).slice(0, 200));

  await page.click('#nextQuestion');
  await page.fill('#writtenAnswer', 'Only one attempt');
  await page.click('#assess');
  await page.click('#skipReveal');
  const skipped = await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('pe13')).attempts).some(a => a.skippedRevision && a.viewedExample));
  check('skip choice is recorded', skipped);

  console.log('Practice: reset');
  page.once('dialog', d => d.accept());
  await page.click('#resetPractice');
  check('reset clears practice attempts only', await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('pe13')).attempts).length === 0));

  console.log('Teacher release');
  await page.goto(url('teacher.html'));
  await page.uncheck('input[data-k=fullMarkExample]');
  await page.goto(url('practice.html'));
  await page.selectOption('#sectionFilter', 'B');
  await page.fill('#writtenAnswer', 'one'); await page.click('#assess');
  check('teacher can withhold full-mark example', (await page.locator('#revealExample').count()) === 0 && /not released/.test(await page.locator('#feedback').textContent()));

  console.log('Strict exam');
  await page.goto(url('exam.html'));
  const examHtml = await page.locator('#examContent').innerHTML();
  check('timed exam shows no cohort statistic, hints or examples', !/answered correctly|Average:|report mean|hint|full-mark/i.test(examHtml));


  console.log('Question Studio: sanitiser and validation');
  await page.goto(url('studio.html'));
  const san = await page.evaluate(() => StudioStore.sanitise('<p onclick="x()">Hi <b>bold</b><sup>2</sup><script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)">bad</a><a href="https://example.org">ok</a></p>'));
  check('script, event handlers and javascript: links are stripped', !/script|onerror|onclick|javascript:/i.test(san), san);
  check('bold, superscript and safe links survive', /<b>bold<\/b>/.test(san) && /<sup>2<\/sup>/.test(san) && /href="https:\/\/example\.org"/.test(san));
  const v = await page.evaluate(() => ({
    pct: StudioStore.validateAssessment({ options: ['a','b','c','d'] }, { statisticType: 'option_distribution', correctOption: 'B', optionPercentages: { A: 50, B: 70, C: 0, D: 0 } }),
    range: StudioStore.validateAssessment({ options: ['a','b','c','d'] }, { statisticType: 'option_distribution', correctOption: 'B', optionPercentages: { A: -5, B: 105, C: 0, D: 0 } }),
    avg: StudioStore.validateAssessment({ marks: 3 }, { statisticType: 'average_score', averageScore: 4, maximumScore: 3 }),
    neg: StudioStore.validateAssessment({ marks: 3 }, { statisticType: 'average_score', averageScore: -1, maximumScore: 3 }),
    max: StudioStore.validateAssessment({ marks: 3 }, { statisticType: 'average_score', averageScore: 1, maximumScore: 2 }),
    ex: StudioStore.validateFullMark({ section: 'B', criteria: [['c1', [], 'criterion-1'], ['c2', [], 'criterion-2']], fullMarkExample: { content: 'x', criteriaDemonstrated: ['criterion-1'] } })
  }));
  check('option percentages must total about 100', v.pct.length > 0);
  check('percentages must be between 0 and 100', v.range.some(e => /between 0 and 100/.test(e)));
  check('average cannot exceed maximum', v.avg.some(e => /exceed/.test(e)));
  check('average cannot be negative', v.neg.some(e => /negative/.test(e)));
  check('maximum must match mark allocation', v.max.some(e => /match/.test(e)));
  check('example must demonstrate every criterion', v.ex.length === 1);

  console.log('Question Studio: draft / publish / versions');
  const target = 'PE-2025-B-Q2D';
  await page.selectOption('#qPicker', target);
  await page.locator('.rte-area').nth(1).evaluate(e => { e.innerHTML = 'Draft <b>rewrite</b> of the question'; e.dispatchEvent(new Event('input')); });
  await page.click('#saveDraft');
  check('status becomes draft', /draft/.test(await page.textContent('#statusPill')));
  await page.goto(url('practice.html')); await page.selectOption('#sectionFilter', 'B');
  await page.selectOption('#selector', { label: (await page.$$eval('#selector option', o => o.find(x => /Question 2d/.test(x.textContent))?.textContent)) });
  check('students still see published content while a draft exists', !/rewrite/.test(await page.textContent('.qblock')));
  await page.goto(url('studio.html')); await page.selectOption('#qPicker', target);
  await page.click('#publishBtn');
  check('publish blocked until every review gate passes', /Complete every review gate/.test(await page.textContent('#errors')));
  for (let i = 0; i < 4; i++) await page.click('#advanceGate');
  await page.click('#publishBtn');
  check('publish succeeds after all gates', /Published as version 1/.test(await page.textContent('#saveMsg')));
  await page.goto(url('practice.html')); await page.selectOption('#sectionFilter', 'B');
  await page.selectOption('#selector', { label: (await page.$$eval('#selector option', o => o.find(x => /Question 2d/.test(x.textContent))?.textContent)) });
  check('published rich text reaches students', /rewrite/.test(await page.textContent('.qblock')) && (await page.locator('.qblock b').count()) === 1);
  await page.goto(url('studio.html')); await page.selectOption('#qPicker', target);
  await page.locator('.rte-area').nth(1).evaluate(e => { e.innerHTML = 'Second edit'; e.dispatchEvent(new Event('input')); });
  await page.click('#saveDraft');
  for (let i = 0; i < 4; i++) await page.click('#advanceGate');
  await page.click('#publishBtn');
  check('second publish creates version 2 and keeps version 1', (await page.locator('[data-rb]').count()) === 2);
  await page.click('[data-rb="1"]');
  check('rollback returns to draft instead of overwriting live content', /draft/.test(await page.textContent('#statusPill')));

  console.log('Question Studio: editable table saves, restores and assesses');
  await page.goto(url('studio.html')); await page.selectOption('#qPicker', 'PE-2025-B-Q3B');
  await page.selectOption('#compType', 'editable_table');
  await page.fill('#compJson', JSON.stringify({ header: ['Measure', 'Value'], rows: [['Heart rate', ''], ['Work:rest', '']], expected: { '0,1': '180', '1,1': '1:2' } }));
  await page.click('#saveDraft');
  for (let i = 0; i < 4; i++) await page.click('#advanceGate');
  await page.click('#publishBtn');
  check('table component published', /Published as version/.test(await page.textContent('#saveMsg')));
  await page.goto(url('practice.html')); await page.selectOption('#sectionFilter', 'B');
  await page.selectOption('#selector', { label: (await page.$$eval('#selector option', o => o.find(x => /Question 3b/.test(x.textContent))?.textContent)) });
  await page.locator('[data-cell="0,1"]').fill('180'); await page.locator('[data-cell="1,1"]').fill('wrong');
  await page.click('#assess');
  check('table assessed objectively (1 of 2 cells)', /1 of 2 auto-checked/.test(await page.textContent('#feedback')));
  await page.reload(); await page.selectOption('#sectionFilter', 'B');
  await page.selectOption('#selector', { label: (await page.$$eval('#selector option', o => o.find(x => /Question 3b/.test(x.textContent))?.textContent)) });
  check('table entries restore after reload', (await page.locator('[data-cell="0,1"]').inputValue()) === '180');

  console.log('Question Studio: assets');
  const png = path.join(require('os').tmpdir(), 'peasset.png');
  fs.writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==', 'base64'));
  await page.goto(url('studio.html')); await page.selectOption('#qPicker', 'PE-2025-B-Q6A');
  await page.fill('#aAlt', 'Test marathon chart'); await page.fill('#aCaption', 'Caption'); await page.fill('#aRights', 'Test holder'); await page.fill('#aLicence', 'CC0');
  await page.setInputFiles('#assetFile', png);
  await page.waitForSelector('.asset-row');
  check('upload attaches to the selected question with metadata', /Test holder/.test(await page.textContent('.asset-row')));
  const viewFor = async label => {
    await page.goto(url('practice.html')); await page.selectOption('#sectionFilter', 'B');
    await page.selectOption('#selector', { label: (await page.$$eval('#selector option', (o, l) => o.find(x => x.textContent.includes(l))?.textContent, label)) });
    await page.waitForSelector('#studioAssets img', { timeout: 1500 }).catch(() => null); // IndexedDB mount is asynchronous
    return page.locator('#studioAssets img').count();
  };
  check('draft asset hidden from students', (await viewFor('Question 6a')) === 0);
  await page.goto(url('studio.html')); await page.selectOption('#qPicker', 'PE-2025-B-Q6A'); await page.click('[data-act=approve]'); await page.waitForFunction(() => /· approved ·/.test(document.querySelector('.asset-row')?.textContent || '')); // wait for the IndexedDB write
  check('approved asset visible on its own question', (await viewFor('Question 6a')) === 1);
  check('asset not visible on other questions', (await viewFor('Question 6b')) === 0);

  console.log('Question Studio: duplicates, archive, previews');
  await page.goto(url('studio.html'));
  const before = await page.locator('#qPicker option').count();
  await page.selectOption('#qPicker', 'PE-2025-B-Q4A'); await page.click('#dupQuestion');
  check('duplicate question creates one draft copy', (await page.locator('#qPicker option').count()) === before + 1);
  await page.selectOption('#qPicker', 'PE-2025-B-Q4A'); await page.click('#dupGroup');
  check('duplicate group creates a copy of every part in the group', (await page.locator('#qPicker option').count()) === before + 1 + Q.filter(q => q.group === '4').length);
  await page.click('[data-pv=strict]');
  check('strict preview hides cohort statistic', (await page.locator('#previewFrame .stat').count()) === 0);
  await page.click('[data-pv=supported]');
  check('supported preview shows cohort statistic', (await page.locator('#previewFrame .stat').count()) === 1);
  await page.click('[data-pv=mobile]');
  check('mobile preview constrains width', await page.locator('#previewFrame.mobile').count() === 1);
  await page.selectOption('#qPicker', 'PE-2025-B-Q1A'); await page.click('#archiveBtn');
  await page.goto(url('practice.html')); await page.selectOption('#sectionFilter', 'B');
  check('archived question is hidden from students', !(await page.$$eval('#selector option', o => o.some(x => /Question 1a /.test(x.textContent)))));
  check('draft duplicates are not shown to students', !(await page.$$eval('#selector option', o => o.some(x => /copy/i.test(x.textContent)))));


  console.log('PDF import: cover pages, error and re-import');
  const COVER_E = ['Victorian Certificate of Education 2025', 'PHYSICAL EDUCATION', 'Written examination', 'Reading time: 15 minutes', 'Writing time: 2 hours', 'QUESTION AND ANSWER BOOK', 'Structure of book', 'A 20 20 20', 'B 4 4 80', '2 hours', '20 questions 20 marks', '80 marks total', 'Instructions', 'Write your student number in the space provided above.', '2025 PHYSEDU EXAM'];
  const PAGE2 = ['SECTION A – Multiple-choice questions', 'Instructions for Section A', 'Answer all questions in pencil.', 'Question 1', 'Which energy system is the main contributor during a 100 m sprint?', 'A. aerobic system', 'B. ATP-CP system', 'C. lactic acid system', 'D. glycolysis and the aerobic system', 'Question 2', 'The term stroke volume refers to the', 'A. number of beats per minute.', 'B. volume of blood ejected per beat.', 'C. volume of air breathed per minute.', 'D. oxygen used per kilogram.', 'TURN OVER'];
  const PAGE3 = ['SECTION B – Short-answer questions', 'Instructions for Section B', 'Answer all questions in the spaces provided.', 'Question 1 (5 marks)', 'Fifteen lacrosse players were monitored during an 80-minute match.', 'a. Describe one adaptation of the cardiovascular system to training. 2 marks', 'b. Explain how the lactic acid system contributes to a repeated sprint. 3 marks', 'Question 2 (4 marks)', 'Explain why warm-ups reduce injury risk. 4 marks', 'END OF QUESTION AND ANSWER BOOK'];
  const pdfExam = path.join(require('os').tmpdir(), 'VCE-PE-2025-exam.pdf');
  { const pp = await ctx.newPage();
    await pp.setContent('<body style="font:14px sans-serif">' + [COVER_E, PAGE2, PAGE3].map(l => '<section style="page-break-after:always">' + l.map(t => '<div>' + t.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</div>').join('') + '</section>').join('') + '</body>');
    await pp.pdf({ path: pdfExam, format: 'A4' }); await pp.close(); }

  const openPdf = async () => {
    await page.goto(url('studio.html'));
    await page.setInputFiles('#pdfInput', pdfExam);
    await page.waitForSelector('#pdfDialog[open]', { timeout: 20000 });
  };
  const createDrafts = async () => {
    const nav = page.waitForNavigation({ timeout: 20000 });
    await page.click('#createPdfDrafts');
    await page.waitForFunction(() => /Created \d+ unverified/.test(document.getElementById('pdfProgress').textContent) || document.querySelector('#pdfProgress .errors'));
    const msg = await page.textContent('#pdfProgress'); await nav; return msg;
  };
  const stateIds = () => page.evaluate(() => Object.keys(StudioStore.state.custom).filter(k => k.startsWith('VCE-PE-')).sort());

  await page.goto(url('studio.html'));
  check('status element the importer writes to exists', (await page.locator('#globalStatus').count()) === 1);
  await openPdf();
  const incs = await page.$$eval('.pageInc', e => e.map(x => x.checked));
  check('cover page is excluded by default, question pages included', incs.length === 3 && incs[0] === false && incs[1] && incs[2], JSON.stringify(incs));
  check('status explains the excluded cover page', /1 cover or instruction page is excluded/.test(await page.textContent('#pdfProgress')));
  await page.click('#runOcr');
  check('OCR button without the OCR library shows a message, not an error', /OCR library could not load/.test(await page.textContent('#pdfProgress')));
  await page.click('#detectQuestions'); await page.waitForSelector('[data-k=text]');
  const vals = await page.$$eval('[data-k=text]', e => e.map(x => x.value));
  check('five questions detected and none come from the cover', vals.length === 5 && !vals.some(v => /hours|Reading time|student number|Structure of book|questions 20 marks/i.test(v)), vals.join(' | '));
  check('first question is Section A question 1 with parsed options', (await page.inputValue('[data-c="0"][data-k=section]')) === 'A' && (await page.inputValue('[data-c="0"][data-k=opt1]')) === 'ATP-CP system');
  check('Section B parts carry their own marks', (await page.inputValue('[data-c="2"][data-k=marks]')) === '2' && (await page.inputValue('[data-c="3"][data-k=marks]')) === '3');
  check('Section B parts share the statement', /Fifteen lacrosse players/.test(await page.inputValue('[data-c="2"][data-k=sharedContext]')));
  await page.click('#backToPages');
  check('back button returns to the page text', (await page.locator('.pageText').count()) === 3);
  await page.goto(url('studio.html'));

  // The reported scenario: the front-cover text is deleted before detecting and creating drafts.
  await openPdf();
  await page.locator('details').first().evaluate(d => { d.open = true; });
  await page.fill('.pageText[data-i="0"]', '');
  await page.click('#detectQuestions'); await page.waitForSelector('[data-k=text]');
  const msg1 = await createDrafts();
  check('creating drafts after deleting the cover text succeeds (no null error)', /Created 5 unverified question drafts/.test(msg1) && !/Cannot set properties/.test(msg1), msg1);
  const ids1 = await stateIds();
  check('five drafts exist with stable ids', JSON.stringify(ids1) === JSON.stringify(['VCE-PE-2025-MAIN-A-Q01', 'VCE-PE-2025-MAIN-A-Q02', 'VCE-PE-2025-MAIN-B-Q01A', 'VCE-PE-2025-MAIN-B-Q01B', 'VCE-PE-2025-MAIN-B-Q02']), ids1.join(','));
  const draftRec = await page.evaluate(() => { const c = StudioStore.state.custom['VCE-PE-2025-MAIN-B-Q01A'], i = StudioStore.state.items['VCE-PE-2025-MAIN-B-Q01A']; return { marks: c.marks, ctx: c.sharedContext, status: i.status, group: c.group, ref: c.ref, prov: c.provenance.wording.verificationStatus, hints: c.hints, criteria: c.criteria }; });
  check('drafts are unverified, ungated and fully shaped', draftRec.marks === 2 && /Fifteen/.test(draftRec.ctx) && draftRec.status === 'draft' && draftRec.group === '1' && draftRec.ref === '1a' && draftRec.prov === 'unverified' && Array.isArray(draftRec.hints) && Array.isArray(draftRec.criteria));
  check('students cannot see imported drafts', await page.goto(url('practice.html')).then(() => page.evaluate(() => !QUESTIONS.some(q => q.id.startsWith('VCE-PE-')))));

  const msg2 = await (async () => { await openPdf(); await page.click('#detectQuestions'); await page.waitForSelector('[data-k=text]'); return createDrafts(); })();
  check('importing the same PDF again replaces the unedited drafts instead of failing', /Created 0/.test(msg2) && /Replaced 5/.test(msg2), msg2);

  console.log('PDF import: finishing an imported multiple-choice question');
  await page.goto(url('studio.html')); await page.selectOption('#qPicker', 'VCE-PE-2025-MAIN-A-Q01');
  check('correct option starts blank instead of defaulting to A', (await page.inputValue('#fCorrect')) === '');
  await page.click('#saveDraft');
  for (let i = 0; i < 4; i++) await page.click('#advanceGate');
  await page.click('#publishBtn');
  check('cannot publish without choosing the correct option', /Choose the correct option/.test(await page.textContent('#errors')));
  await page.selectOption('#fCorrect', 'B');
  await page.click('#saveDraft');
  for (let i = 0; i < 4; i++) await page.click('#advanceGate');
  await page.click('#publishBtn');
  check('publishes once the answer is chosen, with no cohort statistic yet', /Published as version 1/.test(await page.textContent('#saveMsg')));
  await page.goto(url('practice.html')); await page.selectOption('#topicFilter', 'Unclassified');
  const tagsI = await page.$$eval('.tagrow .tag', e => e.map(x => x.textContent.trim()));
  check('imported question shows "No cohort statistic published"', tagsI[4] === 'No cohort statistic published', tagsI.join(' | '));
  await page.locator('input[name=answer][value=A]').check(); await page.click('#assess');
  check('wrong answer is marked with the right key', /Not yet correct\. Correct answer: B/.test(await page.textContent('#feedback')), await page.textContent('#feedback'));
  await page.locator('input[name=answer][value=B]').check(); await page.click('#assess');
  check('right answer is marked correct', /Correct/.test(await page.textContent('#feedback')) && !/Not yet/.test(await page.textContent('#feedback')));

  console.log('PDF import: protecting edited work, and clean-up');
  await page.goto(url('studio.html')); await page.selectOption('#qPicker', 'VCE-PE-2025-MAIN-B-Q02');
  await page.locator('.rte-area').nth(1).evaluate(e => { e.innerHTML = 'My corrected wording'; e.dispatchEvent(new Event('input')); });
  await page.click('#saveDraft');
  const msg3 = await (async () => { await openPdf(); await page.click('#detectQuestions'); await page.waitForSelector('[data-k=text]'); return createDrafts(); })();
  check('edited and published questions are kept, the rest replaced', /Replaced 3/.test(msg3) && /2 kept as they were/.test(msg3), msg3);
  check('the edit survived the re-import', await page.evaluate(() => /My corrected wording/.test(StudioStore.state.items['VCE-PE-2025-MAIN-B-Q02'].draft.textHtml)));
  await page.goto(url('studio.html'));
  page.once('dialog', d => d.accept());
  const navD = page.waitForNavigation({ timeout: 15000 });
  await page.click('#discardImports'); await navD;
  const ids2 = await stateIds();
  check('discard removes only unedited, unpublished import drafts', JSON.stringify(ids2) === JSON.stringify(['VCE-PE-2025-MAIN-A-Q01', 'VCE-PE-2025-MAIN-B-Q02']), ids2.join(','));

  check('no page errors', errors.length === 0, errors.join('; '));
  await browser.close(); server.close();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
