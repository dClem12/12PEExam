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

  check('no page errors', errors.length === 0, errors.join('; '));
  await browser.close();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
