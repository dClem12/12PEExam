/* Unit tests for PDF question detection. Run: node tests/pdf-ingest-core.test.js */
const assert = require('assert');
const Core = require('../pdf-ingest-core.js');
let pass = 0, fail = 0;
const test = (name, fn) => { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message.split('\n')[0]); } };

const COVER = `Victorian Certificate of Education 2025
PHYSICAL EDUCATION
Written examination
Monday 10 November 2025
Reading time: 15 minutes
Writing time: 2 hours
QUESTION AND ANSWER BOOK
Structure of book
Section Number of questions Number of questions to be answered Number of marks
A 20 20 20
B 4 4 80
Total 100
2 hours
20 questions 20 marks
80 marks total
Students are permitted to bring into the examination room: pens, pencils.
Instructions
Write your student number in the space provided above.
2025 PHYSEDU EXAM`;
const INSTR_A = `SECTION A – Multiple-choice questions
Instructions for Section A
Answer all questions in pencil on the answer sheet provided for multiple-choice questions.
Choose the response that is correct or that best answers the question.
5 marks will not be deducted for incorrect answers.`;
const SECTION_A = `Question 1
Which energy system is the main contributor during a 100 m sprint?
A. aerobic system
B. ATP-CP system
C. lactic acid system
D. glycolysis and the
aerobic system
Question 2
The term 'stroke volume' refers to the
A. number of beats per minute.
B. volume of blood ejected per beat.
C. volume of air breathed per minute.
D. oxygen used per kilogram.
TURN OVER
Page 4
Use the following information to answer Questions 3 and 4.
A cyclist rides at 180 beats per minute.
Question 3
What is the cyclist's likely cardiac output?
A. 5 L
B. 10 L
C. 20 L
D. 30 L
Question 4
Which fuel is used most?
A. glycogen
B. fat
C. protein
D. creatine`;
const INSTR_B = `SECTION B – Short-answer questions
Instructions for Section B
Answer all questions in the spaces provided.
In questions where more than one mark is available, appropriate working must be shown.
© VICTORIAN CURRICULUM AND ASSESSMENT AUTHORITY 2025`;
const SECTION_B = `Question 1 (6 marks)
Fifteen lacrosse players were monitored during an 80-minute match using GPS units, e.g. speed and distance.
a. Describe one adaptation of the cardiovascular system to training.
2 marks
b. Explain how the lactic acid system contributes to a repeated sprint.
i. State the fuel.
ii. State the by-product.
3 marks
c. Identify one recovery strategy. 1 mark
Question 2 (4 marks)
Explain why warm-ups reduce injury risk. 4 marks
Question 2 – continued
Extra space for responses
END OF QUESTION AND ANSWER BOOK
Back cover text that must be ignored 12 marks`;

const pages = [COVER, INSTR_A + '\n' + SECTION_A.split('Question 3')[0], 'Question 3' + SECTION_A.split('Question 3').slice(1).join('Question 3'), INSTR_B + '\n' + SECTION_B]
  .map((text, i) => ({ page: i + 1, text, method: 'embedded text' }));
const r = Core.detectQuestions(pages);
const by = id => r.candidates.find(c => c.section + c.displayLabel === id);

console.log('PDF question detection');
test('cover and instruction lines never become questions', () => {
  assert(!r.candidates.some(c => /hours|questions 20 marks|marks total|student number/i.test(c.text)), r.candidates.map(c => c.displayLabel + ':' + c.text.slice(0, 30)).join(' | '));
  assert(r.notes.some(n => /Ignored \d+ lines of cover and instruction text/.test(n)));
});
test('first candidate is Section A question 1', () => assert.strictEqual(r.candidates[0].section + r.candidates[0].displayLabel, 'A1'));
test('finds 4 Section A questions and 4 Section B items (parts 1a-1c and question 2)', () => {
  assert.strictEqual(r.candidates.filter(c => c.section === 'A').length, 4);
  assert.strictEqual(r.candidates.filter(c => c.section === 'B').length, 4, r.candidates.filter(c => c.section === 'B').map(c => c.displayLabel).join(','));
});
test('Section A splits stem and four options', () => {
  const q = by('A1');
  assert.strictEqual(q.text, 'Which energy system is the main contributor during a 100 m sprint?');
  assert.deepStrictEqual(q.options, ['aerobic system', 'ATP-CP system', 'lactic acid system', 'glycolysis and the aerobic system']);
  assert.strictEqual(q.marks, 1);
});
test('wrapped option text is joined', () => assert.strictEqual(by('A1').options[3], 'glycolysis and the aerobic system'));
test('page furniture is removed', () => assert(!by('A2').options.join(' ').match(/TURN OVER|Page 4/i)));
test('shared "use the following information" text is carried to the named questions', () => {
  assert(/^Use the following information to answer Questions 3 and 4\./.test(by('A3').text), by('A3').text);
  assert(/^Use the following information/.test(by('A4').text));
  assert(!/Use the following/.test(by('A2').options[3]), by('A2').options[3]);
});
test('Section B parts get their own marks', () => {
  assert.deepStrictEqual(['1a', '1b', '1c'].map(l => by('B' + l).marks), [2, 3, 1]);
});
test('Section B parts share the statement', () => assert(/Fifteen lacrosse players/.test(by('B1a').sharedContext) && by('B1b').sharedContext === by('B1a').sharedContext));
test('"e.g." in a statement is not read as part e', () => assert(!r.candidates.some(c => c.displayLabel === '1e') && /e\.g\./.test(by('B1a').sharedContext)));
test('sub-parts i. and ii. stay inside part b', () => assert(/State the fuel\. ii\. State the by-product\./.test(by('B1b').text)));
test('marks are removed from the wording', () => assert(!/marks?$/i.test(by('B1a').text) && !/marks?$/i.test(by('B2').text)));
test('question without parts takes marks from its text or heading', () => assert.strictEqual(by('B2').marks, 4));
test('continued pages, extra space and back cover are ignored', () => assert(!/Back cover|Extra space|continued/i.test(r.candidates.map(c => c.text).join(' '))));
test('section instructions are not attached to the last Section A question', () => assert(!/Instructions for Section B|appropriate working/.test(by('A4').options.join(' '))));
test('part marks that disagree with the heading are flagged', () => {
  const bad = Core.detectQuestions([{ page: 1, text: 'SECTION B\nQuestion 1 (9 marks)\nStatement.\na. One. 2 marks\nb. Two. 3 marks' }]);
  assert(bad.candidates[0].warnings.some(w => /add up to 5/.test(w)), JSON.stringify(bad.candidates[0].warnings));
});
test('missing question numbers are reported', () => {
  const gap = Core.detectQuestions([{ page: 1, text: 'SECTION A\nQuestion 1\nA?\nA. a\nB. b\nC. c\nD. d\nQuestion 3\nB?\nA. a\nB. b\nC. c\nD. d' }]);
  assert(gap.notes.some(n => /Section A: question 2 not found/.test(n)), gap.notes.join('|'));
});
test('fewer than four options is flagged', () => {
  const o = Core.detectQuestions([{ page: 1, text: 'SECTION A\nQuestion 1\nStem?\nA. a\nB. b' }]);
  assert(o.candidates[0].warnings.some(w => /2 of 4 options/.test(w)));
});
test('a line like "Question 5 and Question 6 refer to" is not a heading', () => assert.strictEqual(Core.parseHeader('Question 5 and Question 6 refer to the graph.', 'word'), null));
test('"Question 1." with inline wording is accepted', () => assert.strictEqual(Core.parseHeader('Question 1. What is VO2 max?', 'word').rest, 'What is VO2 max?'));
test('numbered fallback requires punctuation, so "2 hours" is ignored', () => {
  const n = Core.detectQuestions([{ page: 1, text: '2 hours\n20 questions 20 marks\n1. What is stroke volume?\n2) Define cardiac output.' }]);
  assert.deepStrictEqual(n.candidates.map(c => c.number), ['1', '2']);
});
test('empty or deleted page text does not throw', () => {
  const e = Core.detectQuestions([{ page: 1, text: '' }, { page: 2, text: '   \n  ' }]);
  assert.strictEqual(e.candidates.length, 0); assert(e.notes.length === 1);
  assert.strictEqual(Core.detectQuestions([]).candidates.length, 0);
});
test('deleting the cover text changes nothing', () => {
  const noCover = Core.detectQuestions(pages.map((p, i) => i === 0 ? Object.assign({}, p, { text: '' }) : p));
  assert.deepStrictEqual(noCover.candidates.map(c => c.section + c.displayLabel), r.candidates.map(c => c.section + c.displayLabel));
});
test('classifyPages excludes pages before the first question', () => {
  const cp = Core.classifyPages(pages.map(p => Object.assign({}, p)));
  assert.deepStrictEqual(cp.map(p => p.include), [false, true, true, true]);
  assert(/Cover/.test(cp[0].role));
});
test('classifyPages keeps everything when no questions are found', () => {
  const cp = Core.classifyPages([{ page: 1, text: 'nothing here' }, { page: 2, text: 'still nothing' }]);
  assert.deepStrictEqual(cp.map(p => p.include), [true, true]);
});
test('excluded pages are skipped by detection', () => {
  const x = Core.detectQuestions(pages.map((p, i) => i === 3 ? Object.assign({}, p, { include: false }) : p));
  assert.strictEqual(x.candidates.filter(c => c.section === 'B').length, 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
