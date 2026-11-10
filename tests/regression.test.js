/* Regression suite for cumulative requirements.
   Run from the repo root:  NODE_PATH=$(npm root -g) node tests/regression.test.js
   Requires Playwright and a Chromium/Chrome install. Not part of the public website. */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const url = f => 'file://' + path.join(root, f);
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
      if (target && !fs.existsSync(path.join(root, target))) missing.push(f + ' -> ' + target);
    }
  }
  check('no broken local links or scripts', missing.length === 0, missing.slice(0, 5).join('; '));
  const brokenAssets = Q.flatMap(q => q.visualAssets).filter(a => !fs.existsSync(path.join(root, a)));
  check('every question image asset exists', brokenAssets.length === 0, brokenAssets.join(', '));
  check('12 asset slots in image-assets', fs.readdirSync(path.join(root, 'image-assets')).length === 12);

  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext();
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

  check('no page errors', errors.length === 0, errors.join('; '));
  await browser.close();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
