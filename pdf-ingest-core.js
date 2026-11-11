/* Question detection for PDF exam import. Pure logic with no DOM access, so it is unit-tested in Node.
   Input:  pages = [{ page, text, method, include? }]  (text has one line per row)
   Output: { candidates, notes, firstQuestionPage }

   Rules that keep cover pages and instructions out of the drafts:
   - Nothing is read until the first real "Question N" heading. Bare numbers such as "2 hours" or
     "20 questions 20 marks" are never treated as questions.
   - A "SECTION A / SECTION B" heading closes the current question and skips the instructions that follow it.
   - Page furniture (TURN OVER, page numbers, copyright lines) and "extra space" pages are dropped.
   - "END OF QUESTION AND ANSWER BOOK" stops reading.
   Section A questions are split into stem and four options; Section B questions are split into a shared
   statement and lettered parts (a, b, c) with marks read from each part. */
(function (root) {
  'use strict';

  const FURNITURE = [
    /^turn over$/i,
    /^page\s+\d+(\s+of\s+\d+)?$/i,
    /^\d{1,3}$/,                                   // bare page numbers
    /©/,
    /victorian curriculum and assessment authority/i,
    /^\d{4}\s+\S+\s+exam(\s+\d+)?$/i,              // e.g. "2025 PHYSEDU EXAM"
    /^do not write in this area$/i,
    /^section\s+[ab]\s*[–—-]\s*continued$/i,
    /^[_.\s\-–—]{5,}$/                             // answer lines
  ];
  const STOP = /^end of (question and answer book|examination|exam)\b/i;
  const EXTRA_SPACE = /^extra space for responses/i;
  const SECTION_HEAD = /^section\s+([ab])\b/i;
  const CARRY_START = /^(use the following|the following (information|data|table)|refer to the (following|table|information))/i;
  const MARKS_AT_END = /[(\[]?\s*(\d{1,2})\s*marks?\s*[)\]]?\s*$/i;
  const PURE_HEADER_REST = /^\s*(?:[–—:.\-]\s*)?(?:[(\[]?\s*\d{1,2}\s*marks?\s*[)\]]?\s*)?(?:[–—:.\-]\s*)?(continued)?\s*$/i;

  const isFurniture = t => FURNITURE.some(re => re.test(t));
  const clean = t => String(t).replace(/\s+/g, ' ').trim();

  /* Returns { number, marks, rest, continued } for a heading line, or null. */
  function parseHeader(t, style) {
    if (style === 'word') {
      const m = t.match(/^question\s+(\d{1,2})\b(.*)$/i);
      if (!m) return null;
      const rest = m[2];
      if (PURE_HEADER_REST.test(rest)) {
        const mm = rest.match(/(\d{1,2})\s*marks?/i);
        return { number: m[1], marks: mm ? +mm[1] : null, rest: '', continued: /continued/i.test(rest) };
      }
      const inline = rest.match(/^[.:)]\s+(\S.*)$/);          // "Question 1. What is ..."
      if (inline) return { number: m[1], marks: null, rest: inline[1], continued: false };
      return null;                                            // e.g. "Question 5 and Question 6 refer to..."
    }
    const n = t.match(/^(\d{1,2})[.)]\s+(\S.*)$/);            // numbered fallback: punctuation is required
    return n ? { number: n[1], marks: null, rest: n[2], continued: false } : null;
  }

  function takeMarks(text) {
    const m = text.match(MARKS_AT_END);
    return m ? { text: text.slice(0, m.index).trim(), marks: +m[1] } : { text: text.trim(), marks: null };
  }

  function parseMcq(lines) {
    const options = [], stem = [], carry = [];
    let state = 'stem';
    for (const t of lines) {
      const m = t.match(/^([A-D])[.)](?:\s+(.*))?$/);
      if (m && options.length < 4 && m[1] === 'ABCD'[options.length]) { options.push(m[2] || ''); state = 'opts'; continue; }
      if (state === 'opts' && options.length === 4 && CARRY_START.test(t)) state = 'carry';
      if (state === 'carry') carry.push(t);
      else if (state === 'opts') options[options.length - 1] = (options[options.length - 1] + ' ' + t).trim();
      else stem.push(t);
    }
    return { stem: stem.join(' '), options, carry: carry.join(' ') };
  }

  function parseWritten(lines) {
    const statement = [], parts = [];
    let cur = null, expected = 'a';
    for (const t of lines) {
      const m = t.match(/^([a-h])[.)](?:\s+(.*))?$/);        // "e.g." never matches: a space or end must follow the dot
      if (m && m[1] === expected) {
        cur = { label: m[1], lines: m[2] ? [m[2]] : [] };
        parts.push(cur); expected = String.fromCharCode(expected.charCodeAt(0) + 1); continue;
      }
      (cur ? cur.lines : statement).push(t);
    }
    return { statement: statement.join(' '), parts };
  }

  function carryTargets(text) {
    const m = text.match(/questions?\s+(\d{1,2})(?:\s*(?:and|&|,|to|[–—-])\s*(\d{1,2}))?/i);
    if (!m) return [];
    const a = +m[1], b = m[2] ? +m[2] : a, out = [];
    for (let i = a; i <= Math.max(a, b) && i - a < 10; i++) out.push(String(i));
    return out;
  }

  function detectQuestions(pages) {
    const notes = [];
    const lines = [];
    (pages || []).forEach(p => {
      if (p.include === false) return;
      String(p.text || '').split(/\r?\n/).forEach(raw => { const t = clean(raw); if (t) lines.push({ t, page: p.page, method: p.method || '' }); });
    });
    const style = lines.some(l => parseHeader(l.t, 'word')) ? 'word' : 'numbered';

    const blocks = [];
    let section = null, cur = null, skip = true, ignoredBefore = 0, firstQuestionPage = null, seenHeader = false;
    const close = () => { if (cur) blocks.push(cur); cur = null; };

    for (const { t, page, method } of lines) {
      if (STOP.test(t)) { close(); skip = true; continue; }
      const sec = t.length < 90 && t.match(SECTION_HEAD);
      if (sec) { close(); section = sec[1].toUpperCase(); skip = true; continue; }
      const h = parseHeader(t, style);
      if (h && h.continued) continue;
      if (h) {
        close(); seenHeader = true; skip = false;
        if (firstQuestionPage === null) firstQuestionPage = page;
        cur = { number: h.number, marks: h.marks, section, page, method, lines: [] };
        if (h.rest) cur.lines.push(h.rest);
        continue;
      }
      if (EXTRA_SPACE.test(t)) { close(); skip = true; continue; }
      if (isFurniture(t)) continue;
      if (skip) { if (!seenHeader) ignoredBefore++; continue; }
      if (cur) cur.lines.push(t);
    }
    close();

    if (ignoredBefore) notes.push(`Ignored ${ignoredBefore} line${ignoredBefore === 1 ? '' : 's'} of cover and instruction text before the first question.`);
    if (!blocks.length) {
      notes.push('No questions were found. Check that the page text contains headings such as "Question 1", or tick the pages that hold the questions.');
      return { candidates: [], notes, firstQuestionPage };
    }

    const candidates = [], seen = new Set(), carries = [];
    for (const b of blocks) {
      const mcq = parseMcq(b.lines);
      const sectionOf = b.section || (mcq.options.length >= 2 ? 'A' : 'B');
      const base = { page: b.page, method: b.method, section: sectionOf, number: b.number, include: true, warnings: [] };

      if (sectionOf === 'A') {
        const c = Object.assign(base, { part: '', displayLabel: b.number, marks: b.marks || 1, text: mcq.stem, sharedContext: '', options: ['', '', '', ''].map((_, i) => mcq.options[i] || '') });
        if (mcq.options.length < 4) c.warnings.push(`Found ${mcq.options.length} of 4 options. Check the wording against the PDF.`);
        if (!c.text) c.warnings.push('No question wording found.');
        if (mcq.carry) carries.push({ text: mcq.carry, from: b.number, targets: carryTargets(mcq.carry) });
        push(c);
        continue;
      }

      const w = parseWritten(b.lines);
      if (!w.parts.length) {
        const tm = takeMarks(w.statement);
        const c = Object.assign(base, { part: '', displayLabel: b.number, marks: b.marks || tm.marks || 1, text: tm.text, sharedContext: '', options: [] });
        if (!b.marks && !tm.marks) c.warnings.push('Marks not found; defaulted to 1. Check the PDF.');
        push(c);
        continue;
      }
      let sum = 0, allKnown = true;
      w.parts.forEach(p => {
        const tm = takeMarks(p.lines.join(' '));
        if (tm.marks === null) allKnown = false; else sum += tm.marks;
        const c = Object.assign({}, base, { warnings: [], part: p.label, displayLabel: b.number + p.label, marks: tm.marks || 1, text: tm.text, sharedContext: w.statement, options: [] });
        if (tm.marks === null) c.warnings.push('Marks not found; defaulted to 1. Check the PDF.');
        push(c);
      });
      if (b.marks && allKnown && sum !== b.marks) {
        const first = candidates.find(c => c.section === 'B' && c.number === b.number && c.part === 'a');
        if (first) first.warnings.push(`Part marks add up to ${sum} but the question heading says ${b.marks}.`);
      }
    }
    function push(c) {
      const key = `${c.section}|${c.number}|${c.part}`;
      if (seen.has(key)) { notes.push(`Question ${c.displayLabel} (Section ${c.section}) appears more than once; the first copy was kept.`); return; }
      seen.add(key); candidates.push(c);
    }

    carries.forEach(cr => {
      const targets = cr.targets.length ? cr.targets : [String(+cr.from + 1)];
      candidates.filter(c => c.section === 'A' && targets.includes(c.number)).forEach(c => { c.text = (cr.text + ' ' + c.text).trim(); });
    });

    ['A', 'B'].forEach(s => {
      const nums = [...new Set(candidates.filter(c => c.section === s).map(c => +c.number))].sort((a, b) => a - b);
      if (!nums.length) return;
      const missing = []; for (let i = 1; i <= nums[nums.length - 1]; i++) if (!nums.includes(i)) missing.push(i);
      if (missing.length) notes.push(`Section ${s}: question${missing.length === 1 ? '' : 's'} ${missing.join(', ')} not found. Check the page text.`);
    });
    notes.push(`Detected ${candidates.length} question${candidates.length === 1 ? '' : 's'} or part${candidates.length === 1 ? '' : 's'}. Correct every row before creating drafts.`);
    return { candidates, notes, firstQuestionPage };
  }

  /* Pages before the first question heading are the cover and instructions: exclude them by default. */
  function classifyPages(pages) {
    const all = pages.map(p => Object.assign({}, p, { include: true }));
    const first = detectQuestions(all).firstQuestionPage;
    return pages.map(p => {
      const before = first !== null && p.page < first;
      return Object.assign(p, { include: !before, role: before ? 'Cover or instructions (excluded)' : '' });
    });
  }

  root.PdfIngestCore = { detectQuestions, classifyPages, parseHeader };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.PdfIngestCore;
})(typeof window !== 'undefined' ? window : globalThis);
