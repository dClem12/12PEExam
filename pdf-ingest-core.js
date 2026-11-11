/* Question detection for PDF exam import. Pure logic with no DOM access, so it is unit-tested in Node.
   Input:  pages = [{ page, text, method, include? }]  (text has one line per row)
   Output: { candidates, notes, firstQuestionPage }

   Rules that keep cover pages, headers and footers out of the drafts:
   - Nothing is read until the first real "Question N" heading. Bare numbers such as "2 hours" are never questions.
   - Headings are checked against the expected numbering, so a cross-reference ("see Question 2") or a repeated
     number is not mistaken for a new question, and a heading with stray OCR characters after it still counts.
   - Running headers/footers are removed by pattern ("Page 3 of 36", "2024 VCE Physical Education ...",
     "SECTION A - continued", "TURN OVER") and by repetition (the same line on many pages).
   - A "SECTION A / SECTION B" heading closes the current question and skips the instructions that follow it.
   - OCR pages get extra clean-up: stray margin characters, speckle between words, look-alike letters.
   Section A questions are split into stem and four options; Section B questions into a shared statement
   and lettered parts (a, b, c) with marks read from each part. */
(function (root) {
  'use strict';

  /* ---------- patterns ---------- */
  const FURNITURE = [
    /^turn over\W*$/i,
    /^page\s+\d+(\s+of\s+\d+)?\W*$/i,
    /^\d{1,3}$/,                                    // bare page numbers
    /©/,
    /victorian curriculum and assessment authority/i,
    /(?:ority|thority)\s+20\d\d\W*$/i,              // "…AUTHORITY 2025", including OCR-damaged copies
    /^\d{4}[\s–-]+\S+\s+exam(\s+\d+)?\W*$/i,        // "2025 PHYSEDU EXAM", "2025-PHYSEDU EXAM"
    /^do not write in this area\W*$/i,
    /continued\W*$/i,                               // "SECTION A – continued" running headers
    /^[_.\s\-–—]{5,}$/                              // answer lines
  ];
  const STOP = /^end of (question and answer book|examination|exam)\b/i;
  const EXTRA_SPACE = /^extra space for responses/i;
  const SECTION_HEAD = /^section\s*[.:]?\s*([ab])\b/i;
  const CARRY_START = /^(use the following|the following (information|data|table)|refer to the (following|table|information))/i;
  const MARKS_AT_END = /[(\[]?\s*(\d{1,2})\s*marks?\s*[)\]]?\W*$/i;
  const PURE_HEADER_REST = /^\s*(?:[–—:.\-]\s*)?(?:[(\[]?\s*\d{1,2}\s*marks?\s*[)\]]?\s*)?(?:[–—:.\-]\s*)?(continued)?\s*$/i;
  const HEADER_LOOSE = /^question\s+\d{1,2}\b/i;
  const OPTION_STRICT = /^\(?([A-Da-d])[.,)](?:\s+(.*))?$/;
  const OPTION_LENIENT = /^([A-D])\s+(\S.*)$/;
  const PART = /^\(?([a-hA-H])[.,)](?:\s+(.*))?$/;

  // Running header/footer text, removed wherever it appears in a line.
  const FOOTER_BITS = [
    /\b\d{4}\s+VCE\s+Physical\s+Education\b(?:\s+(?:Written\s+examination|Section\s+[AB]))?(?:\s+Page\s+\d+\s+of\s+\d+)?/gi,
    /\bPage\s+\d+\s+of\s+\d+\b/gi,
    /\bTURN\s+OVER\W*$/i
  ];

  const isFurniture = t => FURNITURE.some(re => re.test(t));
  const collapse = t => String(t).replace(/\s+/g, ' ').trim();

  /* ---------- line clean-up ---------- */
  // Single stray characters OCR picks up from margins and boxes, e.g. "increased motivation. )".
  function stripTrailingJunk(t) {
    for (let i = 0; i < 4; i++) {
      const m = t.match(/^(.*\S)\s+(\S)$/);
      if (!m) return t;
      const body = m[1], tok = m[2];
      const symbol = /[)\]|[=}{~_<>*»«\\\/+]/.test(tok);
      const afterSentence = /[.?!:]$/.test(body) && body.length >= 15 && /[a-z0-9]/.test(tok);
      if (symbol || afterSentence) t = body; else return t;
    }
    return t;
  }

  function stripLeadingJunkTokens(rest, number) {
    for (let i = 0; i < 3; i++) {
      const m = rest.match(/^(\S)\s+(?=\S)/);
      if (!m) break;
      const tok = m[1];
      const junk = /[^A-Za-z0-9]/.test(tok) || /[a-z]/.test(tok) || tok === String(number);
      if (junk && !/^[(\[]$/.test(tok)) rest = rest.slice(m[0].length); else break;
    }
    return rest;
  }

  function normaliseLine(raw, ocr) {
    let t = collapse(raw).replace(/^[.,;:'"‘’“”`´*»«|_~•·]+\s*/, '');
    FOOTER_BITS.forEach(re => { t = t.replace(re, ' '); });
    t = collapse(t);
    if (ocr) {
      t = t.replace(/^[QO0]u[e3]st[il1!|]on\b/i, 'Question').replace(/^sect[il1!|]on\b/i, 'Section');
      t = t.replace(/(\d)\.(marks?)\b/gi, '$1 $2');
      t = t.replace(/([a-z]{3,})\.([a-z]{2,})/g, '$1 $2');                       // speckle between words
      t = t.replace(/([A-Za-z])['’‘`´]((?!(?:s|t|d|m|re|ve|ll)\b)[A-Za-z]{2,})/g, '$1 $2'); // "Which’energy"
      t = stripTrailingJunk(t);
    }
    return collapse(t);
  }

  /* Returns { number, marks, rest, continued } for a heading line, or null. */
  function parseHeader(t, style) {
    if (style === 'word') {
      const m = t.match(/^question\s+(\d{1,2})\b(.*)$/i);
      if (!m) return null;
      let rest = m[2];
      if (PURE_HEADER_REST.test(rest)) {
        const mm = rest.match(/(\d{1,2})\s*marks?/i);
        return { number: m[1], marks: mm ? +mm[1] : null, rest: '', continued: /continued/i.test(rest) };
      }
      if (/^\s*(and|or|to|&|,|refers?|relates?|–\s*\d)\b/i.test(rest) || /^\s*[,&]/.test(rest)) return null; // cross-reference
      let marks = null;
      const lead = rest.match(/^\s*[(\[]\s*(\d{1,2})\s*marks?\s*[)\]]\s*/i);
      if (lead) { marks = +lead[1]; rest = rest.slice(lead[0].length); }
      rest = stripLeadingJunkTokens(rest.replace(/^[\s.:)\-–—]+/, ''), m[1]);
      return { number: m[1], marks, rest: rest.trim(), continued: false };
    }
    const n = t.match(/^(\d{1,2})[.)]\s+(\S.*)$/);            // numbered fallback: punctuation is required
    return n ? { number: n[1], marks: null, rest: n[2], continued: false } : null;
  }

  function takeMarks(text) {
    const m = text.match(MARKS_AT_END);
    return m ? { text: text.slice(0, m.index).trim(), marks: +m[1] } : { text: text.trim(), marks: null };
  }

  function parseMcq(lines) {
    const run = (re, group) => {
      const options = [], stem = [], carry = [];
      let state = 'stem';
      for (const t of lines) {
        const m = t.match(re);
        if (m && options.length < 4 && m[1].toUpperCase() === 'ABCD'[options.length]) { options.push(m[group] || ''); state = 'opts'; continue; }
        if (state === 'opts' && options.length === 4 && CARRY_START.test(t)) state = 'carry';
        if (state === 'carry') carry.push(t);
        else if (state === 'opts') options[options.length - 1] = (options[options.length - 1] + ' ' + t).trim();
        else stem.push(t);
      }
      return { stem: stem.join(' '), options, carry: carry.join(' ') };
    };
    const strict = run(OPTION_STRICT, 2);
    if (strict.options.length >= 2) return strict;
    const lenient = run(OPTION_LENIENT, 2);                    // OCR dropped the full stops: "A aerobic system"
    return lenient.options.length > strict.options.length ? lenient : strict;
  }

  function parseWritten(lines) {
    const statement = [], parts = [];
    let cur = null, expected = 'a';
    for (const t of lines) {
      const m = t.match(PART);                                 // "e.g." never matches: a space or end must follow
      if (m && m[1].toLowerCase() === expected) {
        cur = { label: expected, lines: m[2] ? [m[2]] : [] };
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

  /* A line that appears on several pages is a running header/footer, not exam content. */
  function repeatedKeys(perPage) {
    const pagesWithText = perPage.filter(p => p.length).length;
    if (pagesWithText < 3) return new Set();
    const seen = new Map();
    perPage.forEach((lines, pi) => lines.forEach(t => {
      if (HEADER_LOOSE.test(t) || OPTION_STRICT.test(t) || PART.test(t) || SECTION_HEAD.test(t) || MARKS_AT_END.test(t) && t.length < 14) return;
      const key = t.toLowerCase().replace(/[^a-z]/g, '').slice(0, 30);
      if (key.length < 8) return;
      if (!seen.has(key)) seen.set(key, new Set());
      seen.get(key).add(pi);
    }));
    const need = Math.max(3, Math.ceil(pagesWithText * 0.35)), out = new Set();
    seen.forEach((set, key) => { if (set.size >= need) out.add(key); });
    return out;
  }

  function detectQuestions(pages) {
    const notes = [];
    const perPage = [], meta = [];
    (pages || []).forEach(p => {
      if (p.include === false) return;
      const ocr = String(p.method || '').startsWith('OCR');
      const lines = [];
      String(p.text || '').split(/\r?\n/).forEach(raw => { const t = normaliseLine(raw, ocr); if (t) lines.push(t); });
      perPage.push(lines); meta.push({ page: p.page, method: p.method || '' });
    });
    const repeated = repeatedKeys(perPage);
    const lines = [];
    let removedRepeats = 0;
    perPage.forEach((ls, pi) => ls.forEach(t => {
      if (repeated.size && repeated.has(t.toLowerCase().replace(/[^a-z]/g, '').slice(0, 30)) && !HEADER_LOOSE.test(t) && !SECTION_HEAD.test(t)) { removedRepeats++; return; }
      lines.push({ t, page: meta[pi].page, method: meta[pi].method });
    }));
    const style = lines.some(l => HEADER_LOOSE.test(l.t)) ? 'word' : 'numbered';

    const blocks = [];
    let section = null, cur = null, skip = true, ignoredBefore = 0, firstQuestionPage = null, seenHeader = false;
    const last = { A: null, B: null, null: null };
    const close = () => { if (cur) blocks.push(cur); cur = null; };

    for (const { t, page, method } of lines) {
      if (STOP.test(t)) { close(); skip = true; continue; }
      if (isFurniture(t)) continue;
      const sec = t.length < 90 && t.match(SECTION_HEAD);
      if (sec) { close(); section = sec[1].toUpperCase(); last[section] = null; skip = true; continue; }
      const h = parseHeader(t, style);
      if (h && h.continued) continue;
      if (h) {
        const n = +h.number, prev = last[section];
        let ok = false;
        if (prev === null) ok = true;
        else if (n === prev + 1 || (n > prev + 1 && n <= prev + 4)) ok = true;
        else if (n === 1 && section === 'A' && prev >= 5) { section = 'B'; last.B = null; notes.push('No "SECTION B" heading was found; Section B was assumed to start where numbering restarts at Question 1.'); ok = true; }
        if (ok) {
          close(); seenHeader = true; skip = false; last[section] = n;
          if (firstQuestionPage === null) firstQuestionPage = page;
          cur = { number: h.number, marks: h.marks, section, page, method, lines: [] };
          if (h.rest) cur.lines.push(h.rest);
          continue;
        }
      }
      if (EXTRA_SPACE.test(t)) { close(); skip = true; continue; }
      if (skip) { if (!seenHeader) ignoredBefore++; continue; }
      if (cur) cur.lines.push(t);
    }
    close();

    if (ignoredBefore) notes.push(`Ignored ${ignoredBefore} line${ignoredBefore === 1 ? '' : 's'} of cover and instruction text before the first question.`);
    if (removedRepeats) notes.push(`Removed ${removedRepeats} repeated header or footer line${removedRepeats === 1 ? '' : 's'}.`);
    if (!blocks.length) {
      notes.push('No questions were found. Check that the page text contains headings such as "Question 1", or tick the pages that hold the questions.');
      return { candidates: [], notes, firstQuestionPage };
    }

    const candidates = [], seen = new Set(), carries = [];
    function push(c) {
      const key = `${c.section}|${c.number}|${c.part}`;
      if (seen.has(key)) { notes.push(`Question ${c.displayLabel} (Section ${c.section}) appears more than once; the first copy was kept.`); return; }
      seen.add(key); candidates.push(c);
    }

    for (const b of blocks) {
      const mcq = parseMcq(b.lines);
      const sectionOf = b.section || (mcq.options.length >= 2 ? 'A' : 'B');
      const base = { page: b.page, method: b.method, section: sectionOf, number: b.number, include: true, warnings: [] };

      if (sectionOf === 'A') {
        const c = Object.assign(base, { part: '', displayLabel: b.number, marks: b.marks || 1, text: mcq.stem, sharedContext: '', options: ['', '', '', ''].map((_, i) => mcq.options[i] || '') });
        if (mcq.options.length < 4) c.warnings.push(`Found ${mcq.options.length} of 4 options. Check the wording against the PDF.`);
        if (!c.text) c.warnings.push('No question wording found.');
        if (c.options.some(o => o.length > 160)) c.warnings.push('An option is unusually long; text from the next question may have run into it.');
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

  root.PdfIngestCore = { detectQuestions, classifyPages, parseHeader, normaliseLine };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.PdfIngestCore;
})(typeof window !== 'undefined' ? window : globalThis);
