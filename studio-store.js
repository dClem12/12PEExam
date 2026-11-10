/* Shared content layer for Question Studio and student pages.
   - Sanitises rich text, renders response components, validates assessment fields.
   - Keeps DRAFT and PUBLISHED content separate, with version history.
   - Stores uploaded images in IndexedDB (static prototype) and shows students only approved/published assets.
   Load after data.js. Student pages get published overrides applied to QUESTIONS in place. */
(() => {
  const KEY = 'peStudio';
  const STATES = ['draft', 'source_verification', 'teacher_review', 'rights_review', 'accessibility_review', 'published', 'archived'];
  const GATES = STATES.slice(1, 5); // review gates, passed in order, before an item can be published
  const COMPONENTS = ['multiple_choice', 'short_text', 'extended_text', 'number', 'select', 'multi_select', 'editable_table', 'static_table', 'calculation', 'composite'];

  const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } };
  const state = load(); state.items = state.items || {}; state.custom = state.custom || {};
  const save = () => localStorage.setItem(KEY, JSON.stringify(state));
  const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const clone = o => JSON.parse(JSON.stringify(o));
  const QS = () => (typeof QUESTIONS !== 'undefined' ? QUESTIONS : []); // QUESTIONS is a top-level const, so it is not on window

  /* ---------- sanitiser: whitelist tags, drop all attributes except safe href ---------- */
  const ALLOWED = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'UL', 'OL', 'LI', 'A', 'SUP', 'SUB', 'BR', 'P', 'SPAN', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'CODE']);
  function sanitise(html) {
    const doc = new DOMParser().parseFromString('<body>' + String(html ?? '') + '</body>', 'text/html');
    (function walk(node) {
      [...node.childNodes].forEach(ch => {
        if (ch.nodeType === 8) { ch.remove(); return; }
        if (ch.nodeType !== 1) return;
        if (!ALLOWED.has(ch.tagName)) {
          if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH', 'FORM', 'INPUT', 'TEXTAREA', 'BUTTON'].includes(ch.tagName.toUpperCase())) { ch.remove(); return; }
          walk(ch); ch.replaceWith(...ch.childNodes); return;
        }
        [...ch.attributes].forEach(a => {
          const keep = ch.tagName === 'A' && a.name === 'href' && /^(https?:|mailto:)/i.test(a.value.trim());
          if (!keep) ch.removeAttribute(a.name);
        });
        if (ch.tagName === 'A') { ch.setAttribute('rel', 'noopener noreferrer'); ch.setAttribute('target', '_blank'); }
        walk(ch);
      });
    })(doc.body);
    return doc.body.innerHTML;
  }

  /* ---------- response components ---------- */
  // component = { type, options:[], rows:[[...]], header:[...], expected:{ "r,c": "value" }, unit, parts:[component...] }
  function renderComponent(c, id, prior) {
    const val = prior ?? '';
    const name = esc(id);
    switch (c.type) {
      case 'multiple_choice':
        return (c.options || []).map((o, i) => `<label class="option"><input type="radio" name="${name}" value="${'ABCDEFGH'[i]}" ${val === 'ABCDEFGH'[i] ? 'checked' : ''}><strong>${'ABCDEFGH'[i]}.</strong> ${esc(o)}</label>`).join('');
      case 'short_text': return `<input type="text" data-comp="${name}" value="${esc(val)}" maxlength="200">`;
      case 'extended_text': return `<textarea data-comp="${name}">${esc(val)}</textarea>`;
      case 'number': return `<input type="number" step="any" data-comp="${name}" value="${esc(val)}">${c.unit ? ' ' + esc(c.unit) : ''}`;
      case 'select': return `<select data-comp="${name}"><option value="">Select…</option>${(c.options || []).map(o => `<option ${val === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
      case 'multi_select': { const set = Array.isArray(val) ? val : []; return (c.options || []).map(o => `<label class="option"><input type="checkbox" data-multi="${name}" value="${esc(o)}" ${set.includes(o) ? 'checked' : ''}> ${esc(o)}</label>`).join(''); }
      case 'static_table':
        return `<table class="compare"><thead><tr>${(c.header || []).map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${(c.rows || []).map(r => `<tr>${r.map(x => `<td>${esc(x)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
      case 'editable_table': {
        const cells = typeof val === 'object' && val ? val : {};
        return `<table class="compare" data-table="${name}"><thead><tr>${(c.header || []).map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${(c.rows || []).map((r, ri) => `<tr>${r.map((x, ci) => (x === '' || x === null) ? `<td><input type="text" data-cell="${ri},${ci}" value="${esc(cells[ri + ',' + ci] ?? '')}"></td>` : `<td>${esc(x)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
      }
      case 'calculation':
        return `<div class="muted">${esc(c.formula || '')}</div><input type="number" step="any" data-comp="${name}" value="${esc(val)}" aria-label="Calculation answer">${c.unit ? ' ' + esc(c.unit) : ''}<textarea data-comp-working="${name}" placeholder="Show your working"></textarea>`;
      case 'composite':
        return (c.parts || []).map((p, i) => `<div class="part"><div class="label">${esc(p.label || 'Part ' + (i + 1))}</div>${renderComponent(p, id + '.' + i, (val && val[i]) ?? '')}</div>`).join('');
      default: return '<div class="notice warn">Unknown response component.</div>';
    }
  }
  function readComponent(c, id, root) {
    const q = s => root.querySelector(s);
    switch (c.type) {
      case 'multiple_choice': return q(`input[name="${id}"]:checked`)?.value || '';
      case 'multi_select': return [...root.querySelectorAll(`input[data-multi="${id}"]:checked`)].map(x => x.value);
      case 'editable_table': { const o = {}; root.querySelectorAll(`[data-table="${id}"] [data-cell]`).forEach(i => { if (i.value !== '') o[i.dataset.cell] = i.value; }); return o; }
      case 'static_table': return '';
      case 'composite': return (c.parts || []).map((p, i) => readComponent(p, id + '.' + i, root));
      default: return q(`[data-comp="${id}"]`)?.value ?? '';
    }
  }
  // Transparent, objective checks only (no semantic marking). Returns {earned, available, note}.
  function assessComponent(c, answer) {
    const norm = s => String(s ?? '').trim().toLowerCase();
    if (c.type === 'editable_table') {
      const exp = c.expected || {}, keys = Object.keys(exp);
      const earned = keys.filter(k => norm(answer?.[k]) === norm(exp[k])).length;
      return { earned, available: keys.length, note: keys.length ? `${earned} of ${keys.length} table cells match the expected values.` : 'No expected values configured; teacher review required.' };
    }
    if (c.type === 'multiple_choice' || c.type === 'select') return c.correct === undefined ? { earned: 0, available: 0, note: 'No answer key configured.' } : { earned: norm(answer) === norm(c.correct) ? 1 : 0, available: 1, note: '' };
    if (c.type === 'number' || c.type === 'calculation') {
      if (c.correct === undefined) return { earned: 0, available: 0, note: 'No answer key configured.' };
      const tol = c.tolerance ?? 0; return { earned: Math.abs(parseFloat(answer) - parseFloat(c.correct)) <= tol ? 1 : 0, available: 1, note: '' };
    }
    if (c.type === 'composite') {
      const rs = (c.parts || []).map((p, i) => assessComponent(p, (answer || [])[i]));
      return { earned: rs.reduce((a, r) => a + r.earned, 0), available: rs.reduce((a, r) => a + r.available, 0), note: '' };
    }
    return { earned: 0, available: 0, note: 'Written response; use criteria and teacher review.' };
  }

  /* ---------- assessment-field validation ---------- */
  function validateAssessment(question, stats) {
    const errs = [];
    if (!stats) return errs;
    if (stats.statisticType === 'option_distribution') {
      const p = stats.optionPercentages || {}, vals = Object.values(p);
      vals.forEach((v, i) => { if (!(v >= 0 && v <= 100)) errs.push(`Option ${Object.keys(p)[i]} percentage must be between 0 and 100.`); });
      const total = vals.reduce((a, b) => a + Number(b || 0), 0);
      if (Math.abs(total - 100) > 1) errs.push(`Option percentages total ${total}%; they should total about 100% (±1).`);
      if (question.options && question.options.length && !(stats.correctOption in p)) errs.push('The correct option must exist in the question options.');
    } else if (stats.statisticType === 'average_score') {
      if (stats.averageScore < 0) errs.push('Average score cannot be negative.');
      if (stats.averageScore > stats.maximumScore) errs.push('Average score cannot exceed maximum marks.');
      if (stats.maximumScore !== question.marks) errs.push('Maximum marks must match the question’s mark allocation.');
    }
    return errs;
  }
  function validateFullMark(question) {
    const ex = question.fullMarkExample;
    if (question.section !== 'B') return [];
    if (!ex || !ex.content) return ['A Section B question needs a full-mark example.'];
    const missing = (question.criteria || []).filter(c => !ex.criteriaDemonstrated.includes(c[2])).map(c => c[0]);
    return missing.length ? ['The full-mark example must demonstrate every configured criterion. Missing: ' + missing.join('; ')] : [];
  }
  const recalcPercentage = s => s.statisticType === 'average_score' && s.maximumScore ? Math.round(s.averageScore / s.maximumScore * 1000) / 10 : s.calculatedPercentage;

  /* ---------- workflow, drafts, versions ---------- */
  const EDITABLE = ['text', 'sharedContext', 'textHtml', 'sharedContextHtml', 'topic', 'marks', 'assessmentStatistics', 'fullMarkExample', 'criteria', 'hints', 'commonError', 'model', 'responseComponent'];
  const base = id => QS().find(q => q.id === id) || state.custom[id];
  function item(id) {
    if (!state.items[id]) state.items[id] = { status: 'published', gates: [], draft: null, published: null, versions: [] };
    return state.items[id];
  }
  function startDraft(id) {
    const it = item(id);
    if (!it.draft) { it.draft = clone(it.published || pick(base(id))); it.status = 'draft'; it.gates = []; save(); }
    return it.draft;
  }
  const pick = q => { const o = {}; EDITABLE.forEach(k => { if (q && q[k] !== undefined) o[k] = clone(q[k]); }); return o; };
  function updateDraft(id, patch) {
    const d = startDraft(id);
    if ('textHtml' in patch) patch.textHtml = sanitise(patch.textHtml);
    if ('sharedContextHtml' in patch) patch.sharedContextHtml = sanitise(patch.sharedContextHtml);
    const before = JSON.stringify(d);
    Object.assign(d, patch);
    const it = item(id);
    if (JSON.stringify(d) !== before) { it.gates = []; it.status = 'draft'; } // a real edit invalidates earlier review sign-offs
    save(); return d;
  }
  function advance(id, by) {
    const it = item(id); if (!it.draft) return { ok: false, error: 'No draft to advance.' };
    if (it.gates.length >= GATES.length) return { ok: false, error: 'All review gates are complete. Publish when ready.' };
    it.gates.push(GATES[it.gates.length]);
    it.status = it.gates.length >= GATES.length ? 'ready_to_publish' : GATES[it.gates.length]; // status names the gate awaiting sign-off
    (it.log = it.log || []).push({ at: new Date().toISOString(), by: by || 'author', passed: it.gates[it.gates.length - 1] });
    save(); return { ok: true, status: it.status };
  }
  function publish(id, by) {
    const it = item(id); if (!it.draft) return { ok: false, errors: ['No draft to publish.'] };
    if (it.gates.length < GATES.length) return { ok: false, errors: ['Complete every review gate before publishing: ' + GATES.slice(it.gates.length).join(', ') + '.'] };
    const merged = Object.assign(clone(pick(base(id))), it.draft);
    const errors = [...validateAssessment(merged, merged.assessmentStatistics), ...validateFullMark(Object.assign({}, base(id), merged))];
    if (errors.length) return { ok: false, errors };
    const n = it.versions.length + 1;
    it.versions.push({ n, at: new Date().toISOString(), by: by || 'author', snapshot: clone(it.draft) }); // previous published content stays in history; never overwritten
    it.published = clone(it.draft); it.draft = null; it.gates = []; it.status = 'published'; save();
    return { ok: true, version: n };
  }
  function rollback(id, n) {
    const it = item(id), v = it.versions.find(x => x.n === n); if (!v) return { ok: false };
    it.draft = clone(v.snapshot); it.gates = []; it.status = 'draft'; save(); return { ok: true }; // returns to review; does not overwrite what students see
  }
  function archive(id) { const it = item(id); it.status = 'archived'; save(); }
  function duplicate(id, withGroup) {
    const src = base(id), ids = withGroup && src.section === 'B' ? QS().filter(q => q.group === src.group).map(q => q.id) : [id];
    const made = [], suffix = Date.now().toString(36).slice(-4).toUpperCase();
    ids.forEach(sid => {
      const s = base(sid), nid = sid + '-COPY-' + suffix;
      state.custom[nid] = Object.assign(clone(s), { id: nid, displayLabel: s.displayLabel + ' (copy)', duplicateOf: sid });
      state.items[nid] = { status: 'draft', gates: [], draft: pick(state.custom[nid]), published: null, versions: [] }; made.push(nid);
    });
    save(); return made;
  }

  /* ---------- assets (IndexedDB) ---------- */
  function db() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('peStudioAssets', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('assets', { keyPath: 'id' });
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  }
  const tx = async (mode, fn) => { const d = await db(); return new Promise((res, rej) => { const t = d.transaction('assets', mode), s = t.objectStore('assets'), out = fn(s); t.oncomplete = () => res(out && out.result !== undefined ? out.result : undefined); t.onerror = () => rej(t.error); }); };
  const assets = {
    async put(a) { a.id = a.id || 'asset-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); await tx('readwrite', s => s.put(a)); return a; },
    async all() { return tx('readonly', s => s.getAll()); },
    async remove(id) { return tx('readwrite', s => s.delete(id)); },
    async forQuestion(qid, studentView) {
      const list = (await this.all()).filter(a => a.questionIds?.includes(qid)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      return studentView ? list.filter(a => ['approved', 'published'].includes(a.approval) && a.alt) : list;
    }
  };
  async function mountAssets(qid, el) {
    if (!el || !window.indexedDB) return;
    try {
      const list = await assets.forQuestion(qid, true);
      el.innerHTML = list.map(a => `<figure class="asset"><img src="${URL.createObjectURL(a.blob)}" alt="${esc(a.alt)}">${a.caption ? `<figcaption>${esc(a.caption)}</figcaption>` : ''}<small class="muted">${esc(a.source || '')}${a.rightsHolder ? ' · © ' + esc(a.rightsHolder) : ''}</small></figure>`).join('');
    } catch { /* storage unavailable: show nothing rather than unapproved content */ }
  }

  /* ---------- apply published content to student-facing QUESTIONS ---------- */
  function applyPublished() {
    if (!QS().length) return;
    QUESTIONS.forEach((q, i) => {
      const it = state.items[q.id];
      if (it && it.published && it.status !== 'archived') QUESTIONS[i] = Object.assign({}, q, it.published);
    });
    Object.keys(state.custom).forEach(id => {
      const it = state.items[id];
      if (it && it.published && it.status !== 'archived' && !QUESTIONS.some(q => q.id === id)) QUESTIONS.push(Object.assign({}, state.custom[id], it.published));
    });
  }
  function hideArchived() { // archived questions disappear for students; history is kept in the Studio
    const gone = new Set(archivedIds());
    for (let i = QS().length - 1; i >= 0; i--) if (gone.has(QUESTIONS[i].id)) QUESTIONS.splice(i, 1);
  }
  const archivedIds = () => Object.keys(state.items).filter(id => state.items[id].status === 'archived');

  window.StudioStore = { STATES, GATES, COMPONENTS, state, save, sanitise, renderComponent, readComponent, assessComponent, validateAssessment, validateFullMark, recalcPercentage, item, startDraft, updateDraft, advance, publish, rollback, archive, duplicate, assets, mountAssets, applyPublished, archivedIds, base };
  applyPublished();
  if (!/studio\.html$/.test(location.pathname)) hideArchived();
})();
