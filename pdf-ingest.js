/* Browser PDF ingestion for Question Studio.
   Reads an exam PDF (embedded text, or OCR for scanned pages), detects questions with PdfIngestCore,
   and creates UNVERIFIED drafts for manual review. Nothing reaches students until reviewed and published. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id), S = window.StudioStore, Core = window.PdfIngestCore;
  if (!$('importPdf') || !S || !Core) return;

  const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const CDN_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  let pdfjs = null, pdf = null, file = null, pages = [], candidates = [], view = 'pages', busy = false;

  const status = (text, cls = 'notice') => { $('pdfProgress').innerHTML = `<div class="${cls}">${esc(text)}</div>`; };
  const statusList = (items, cls) => { $('pdfProgress').innerHTML = items.map(t => `<div class="${cls}">${esc(t)}</div>`).join(''); };
  // Never throws: a missing status element must not stop an import.
  const announce = msg => { const el = $('globalStatus') || $('saveMsg'); if (el) el.textContent = msg; };

  /* PDF.js comes from the CDN script tag when it loads; otherwise the copy bundled in vendor/pdfjs is used. */
  async function loadPdfjs() {
    if (pdfjs) return pdfjs;
    if (window.pdfjsLib) {
      pdfjs = window.pdfjsLib;
      if (!pdfjs.GlobalWorkerOptions.workerSrc) pdfjs.GlobalWorkerOptions.workerSrc = CDN_WORKER;
    } else {
      pdfjs = await import('./vendor/pdfjs/pdf.min.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.mjs', document.baseURI).href;
    }
    return pdfjs;
  }

  /* Group text runs into lines by vertical position, then read each line left to right. */
  async function readPage(n) {
    const page = await pdf.getPage(n), tc = await page.getTextContent();
    const items = tc.items.filter(i => typeof i.str === 'string').map(i => ({ s: i.str, x: i.transform[4], y: i.transform[5], w: i.width || 0, h: i.height || 10 }));
    items.sort((a, b) => b.y - a.y);
    const rows = [];
    for (const it of items) {
      const last = rows[rows.length - 1];
      if (last && Math.abs(last.y - it.y) <= 3) last.items.push(it); else rows.push({ y: it.y, items: [it] });
    }
    const lines = rows.map(r => {
      r.items.sort((a, b) => a.x - b.x);
      let out = '', prev = null;
      for (const it of r.items) {
        const gap = prev ? it.x - (prev.x + prev.w) : 0;
        if (prev && gap > prev.h * 0.12 && !/\s$/.test(out) && !/^\s/.test(it.s)) out += ' ';
        out += it.s; prev = it;
      }
      return out.replace(/\s+/g, ' ').trim();
    }).filter(Boolean);
    return { page: n, text: lines.join('\n'), method: 'embedded text' };
  }

  async function loadPdf(f) {
    file = f; candidates = []; view = 'pages';
    status('Reading PDF…');
    pdfjs = await loadPdfjs();
    pdf = await pdfjs.getDocument({ data: new Uint8Array(await f.arrayBuffer()) }).promise;
    pages = [];
    for (let i = 1; i <= pdf.numPages; i++) { status(`Extracting page ${i} of ${pdf.numPages}…`); pages.push(await readPage(i)); }
    Core.classifyPages(pages);
    const year = (f.name.match(/(?:19|20)\d{2}/) || [])[0] || new Date().getFullYear();
    $('pdfYear').value = year;
    $('pdfTitle').value = `${year} VCE Physical Education examination`;
    renderPages();
    const skipped = pages.filter(p => !p.include).length;
    status(`Extracted ${pdf.numPages} pages.${skipped ? ` ${skipped} cover or instruction page${skipped === 1 ? ' is' : 's are'} excluded from detection (tick a page to include it).` : ''} Review the text, OCR low-text pages if needed, then detect questions.`);
    $('pdfDialog').showModal();
  }

  /* ---------- views ---------- */
  function renderPages() {
    view = 'pages';
    $('pdfPages').innerHTML = pages.map((p, i) => `<article class="card">
      <label class="field"><span><input class="pageInc" data-i="${i}" type="checkbox" ${p.include ? 'checked' : ''} style="width:auto"> Include page ${p.page} in question detection</span></label>
      <span class="tag ${p.text.length < 80 ? 'amber' : 'green'}">${esc(p.method)}</span> ${p.role ? `<span class="tag amber">${esc(p.role)}</span>` : ''}
      <details ${p.include ? 'open' : ''}><summary>Page text</summary><textarea class="pageText" data-i="${i}" rows="10">${esc(p.text)}</textarea></details></article>`).join('');
  }

  function renderCandidates() {
    view = 'candidates';
    $('pdfPages').innerHTML = `<div class="actions"><button class="btn" type="button" id="backToPages">Back to page text</button></div>` + candidates.map((q, i) => `<article class="card">
      <div class="grid">
        <label class="field"><span><input data-c="${i}" data-k="include" type="checkbox" ${q.include ? 'checked' : ''} style="width:auto"> Include</span></label>
        <label class="field"><span>Source page</span><input data-c="${i}" data-k="page" value="${q.page}"></label>
        <label class="field"><span>Section</span><select data-c="${i}" data-k="section"><option ${q.section === 'A' ? 'selected' : ''}>A</option><option ${q.section === 'B' ? 'selected' : ''}>B</option></select></label>
        <label class="field"><span>Question number</span><input data-c="${i}" data-k="number" value="${esc(q.number)}"></label>
        <label class="field"><span>Part (blank if none)</span><input data-c="${i}" data-k="part" value="${esc(q.part)}" maxlength="2"></label>
        <label class="field"><span>Display label</span><input data-c="${i}" data-k="displayLabel" value="${esc(q.displayLabel)}"></label>
        <label class="field"><span>Marks</span><input data-c="${i}" data-k="marks" type="number" min="1" value="${q.marks}"></label></div>
      ${q.warnings.map(w => `<div class="notice warn">${esc(w)}</div>`).join('')}
      ${q.section === 'B' ? `<label class="field"><span>Shared statement</span><textarea data-c="${i}" data-k="sharedContext" rows="3">${esc(q.sharedContext)}</textarea></label>` : ''}
      <label class="field"><span>Detected wording</span><textarea data-c="${i}" data-k="text" rows="4">${esc(q.text)}</textarea></label>
      ${q.section === 'A' ? `<div class="grid">${q.options.map((o, k) => `<label class="field"><span>Option ${'ABCD'[k]}</span><input data-c="${i}" data-k="opt${k}" value="${esc(o)}"></label>`).join('')}</div>` : ''}
      <p class="muted">${esc(q.method)}. Wording stays unverified until the review gates are completed.</p></article>`).join('');
    $('backToPages').onclick = () => { renderPages(); statusList(['Page text is shown again. Detect questions to rebuild the list; your edits to the rows below will be replaced.'], 'notice'); };
  }

  // One delegated handler serves both views, so edits are never lost to a re-render.
  function onEdit(e) {
    const t = e.target;
    if (t.classList.contains('pageText')) pages[+t.dataset.i].text = t.value;
    else if (t.classList.contains('pageInc')) pages[+t.dataset.i].include = t.checked;
    else if (t.dataset.k !== undefined) {
      const c = candidates[+t.dataset.c], k = t.dataset.k;
      if (!c) return;
      if (k.startsWith('opt')) c.options[+k.slice(3)] = t.value;
      else if (k === 'include') c.include = t.checked;
      else if (k === 'marks' || k === 'page') c[k] = Number(t.value) || 0;
      else c[k] = t.value;
    }
  }
  $('pdfPages').addEventListener('input', onEdit);
  $('pdfPages').addEventListener('change', onEdit);

  /* ---------- OCR (scanned pages) ---------- */
  async function renderCanvas(n) {
    const p = await pdf.getPage(n), vp = p.getViewport({ scale: 2 }), c = document.createElement('canvas');
    c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    await p.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    return c;
  }
  $('runOcr').onclick = async () => {
    if (!window.Tesseract) { status('The OCR library could not load. Embedded-text extraction is still available.', 'notice warn'); return; }
    const low = pages.filter(p => p.text.trim().length < 80);
    if (!low.length) { status('No low-text pages were detected.'); return; }
    const worker = await Tesseract.createWorker('eng', 1, { logger: m => { if (m.status) status(`OCR: ${m.status} ${m.progress ? Math.round(m.progress * 100) + '%' : ''}`); } });
    try {
      for (const p of low) { status(`OCR page ${p.page}…`); const r = await worker.recognize(await renderCanvas(p.page)); p.text = r.data.text.trim(); p.method = 'OCR unreviewed'; }
    } finally { await worker.terminate(); }
    Core.classifyPages(pages);
    renderPages();
    status(`OCR completed for ${low.length} page(s). Correct OCR errors before detecting questions.`);
  };

  /* ---------- detect ---------- */
  $('detectQuestions').onclick = () => {
    if (!pages.length) { status('Choose an examination PDF first.', 'errors'); return; }
    const r = Core.detectQuestions(pages);
    candidates = r.candidates;
    if (!candidates.length) { statusList(r.notes, 'errors'); return; }
    renderCandidates();
    statusList(r.notes, 'notice');
  };

  /* ---------- create drafts ---------- */
  const clean = x => String(x || '').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '');
  const questionId = (year, examType, c) => `VCE-PE-${year}-${clean(examType)}-${clean(c.section)}-Q${String(c.number).replace(/\D/g, '').padStart(2, '0')}${clean(c.part)}`;

  // A draft made by an earlier import may be replaced only if nobody has worked on it since.
  function isReplaceable(id) {
    const it = S.state.items[id], c = S.state.custom[id];
    if (!it || !c || !it.draft || it.status !== 'draft' || it.published || (it.versions || []).length || (it.gates || []).length) return false;
    if (!(c.provenance && c.provenance.wording && c.provenance.wording.sourceType === 'pdf_import')) return false;
    return it.importSnapshot ? JSON.stringify(it.draft) === it.importSnapshot : !('textHtml' in it.draft || 'sharedContextHtml' in it.draft);
  }

  function buildItem(c, id, eid, year) {
    const isA = c.section === 'A', ocr = String(c.method).startsWith('OCR');
    const prov = verification => ({ sourceType: 'pdf_import', sourceFilename: file.name, sourcePage: String(c.page), verificationStatus: verification });
    return {
      id, examinationId: eid, examYear: year, year, section: c.section, group: String(c.number), ref: String(c.number).toLowerCase() + String(c.part || '').toLowerCase(),
      displayLabel: c.displayLabel, partLabel: c.part || String(c.number), marks: Number(c.marks) || 1, text: c.text,
      sharedContext: isA ? '' : (c.sharedContext || ''), topic: 'Unclassified', command: String(c.text).trim().split(/\s+/)[0] || '',
      sourcePage: String(c.page), sourceType: ocr ? 'provisional_scan' : 'official_pdf', responseType: isA ? 'multiple_choice' : 'written',
      options: isA ? c.options.map(o => String(o || '')) : [], correctOption: '',
      criteria: [], hints: [], model: '', commonError: '', textbook: { chapters: [] }, sourceVerified: false, visualAssets: [],
      assessmentStatistics: { statisticType: 'not_published' },
      provenance: { wording: prov(ocr ? 'OCR unreviewed' : 'unverified'), marks: prov('unverified') }
    };
  }

  $('createPdfDrafts').onclick = () => {
    if (busy) return;
    const button = $('createPdfDrafts');
    let reloading = false;
    try {
      busy = true; button.disabled = true; button.textContent = 'Creating drafts…';
      if (view !== 'candidates' || !candidates.length) throw new Error('Detect and review questions first.');
      const selected = candidates.filter(x => x.include);
      if (!selected.length) throw new Error('Select at least one detected question.');
      const year = Number($('pdfYear').value);
      if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new Error('Enter a valid four-digit exam year.');
      const examType = $('pdfExamType').value.trim() || 'MAIN';
      const eid = `VCE-PE-${year}-${clean(examType)}`;

      const empty = selected.find(c => !String(c.text).trim());
      if (empty) throw new Error(`Question ${empty.displayLabel || empty.number} has no wording. Add it or untick Include.`);
      const ids = selected.map(c => questionId(year, examType, c));
      const dup = ids.find((id, i) => ids.indexOf(id) !== i);
      if (dup) throw new Error(`Two rows would create the same question (${dup}). Check the section, number and part.`);

      S.state.examinations = S.state.examinations || {};
      if (!S.state.examinations[eid]) {
        const scanned = pages.some(p => String(p.method).startsWith('OCR'));
        S.state.examinations[eid] = { id: eid, subject: 'VCE Physical Education', examYear: year, examType, title: $('pdfTitle').value.trim() || `${year} VCE Physical Education examination`, studyDesignVersion: $('pdfDesign').value.trim(), sourceType: scanned ? 'provisional_scan' : 'official_pdf', sourceFilename: file.name, provisionalStatus: 'provisional', sourceVerification: scanned ? 'OCR unreviewed' : 'unverified', examinerReportStatus: 'not_received', createdAt: new Date().toISOString() };
      }

      let made = 0, replaced = 0; const skipped = [];
      selected.forEach((c, i) => {
        const id = ids[i];
        if (S.base(id)) {
          if (!isReplaceable(id)) { skipped.push(`${id}: already exists and has been edited or published`); return; }
          replaced++;
        } else made++;
        const item = buildItem(c, id, eid, year);
        S.state.custom[id] = item;
        S.state.items[id] = { status: 'draft', gates: [], draft: JSON.parse(JSON.stringify(item)), importSnapshot: JSON.stringify(item), published: null, versions: [], modifiedAt: new Date().toISOString() };
      });
      S.save();

      const message = `Created ${made} unverified question draft${made === 1 ? '' : 's'}.${replaced ? ` Replaced ${replaced} earlier unedited draft${replaced === 1 ? '' : 's'}.` : ''}${skipped.length ? ` ${skipped.length} kept as they were (edited or published).` : ''}`;
      statusList([message + ' Reloading Studio…'], 'notice');
      announce(message);
      reloading = true;
      setTimeout(() => location.reload(), 700);
    } catch (e) {
      statusList([e.message || String(e)], 'errors');
    } finally {
      if (!reloading) { busy = false; button.disabled = false; button.textContent = 'Create reviewed drafts'; }
    }
  };

  /* ---------- clean up drafts from earlier imports ---------- */
  if ($('discardImports')) $('discardImports').onclick = () => {
    const ids = Object.keys(S.state.items).filter(isReplaceable);
    if (!ids.length) { announce('No unedited PDF-import drafts to discard.'); return; }
    if (!confirm(`Discard ${ids.length} unedited, unpublished draft${ids.length === 1 ? '' : 's'} created from PDF imports? Drafts you have edited, and anything published, are kept.`)) return;
    ids.forEach(id => { delete S.state.items[id]; delete S.state.custom[id]; });
    S.save();
    announce(`Discarded ${ids.length} unedited PDF-import draft${ids.length === 1 ? '' : 's'}. Reloading Studio…`);
    setTimeout(() => location.reload(), 600);
  };

  $('importPdf').onclick = () => { $('pdfInput').value = ''; $('pdfInput').click(); };
  $('pdfInput').onchange = () => { const f = $('pdfInput').files[0]; if (f) loadPdf(f).catch(e => status('PDF import failed: ' + e.message, 'errors')); };
})();
