/* Question Studio UI. All persistence and rules live in studio-store.js. */
(() => {
  const S = window.StudioStore;
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  let qid = QUESTIONS[0].id, pvMode = 'desktop', pendingFile = null;

  /* ---------- rich-text editor ---------- */
  function rte(mount, onChange) {
    mount.innerHTML = `<div class="rte"><div class="rte-bar" role="toolbar" aria-label="Formatting">
      <button type="button" data-c="bold" title="Bold"><b>B</b></button><button type="button" data-c="italic" title="Italic"><i>I</i></button>
      <button type="button" data-c="insertUnorderedList" title="Bulleted list">• List</button><button type="button" data-c="insertOrderedList" title="Numbered list">1. List</button>
      <button type="button" data-c="createLink" title="Link">Link</button><button type="button" data-c="superscript" title="Superscript">x²</button><button type="button" data-c="subscript" title="Subscript">x₂</button>
      <button type="button" data-c="formula" title="Formula">Formula</button><button type="button" data-c="table" title="Table">Table</button></div>
      <div class="rte-area" contenteditable="true" role="textbox" aria-multiline="true"></div></div>`;
    const area = mount.querySelector('.rte-area');
    mount.querySelectorAll('[data-c]').forEach(b => b.onmousedown = e => {
      e.preventDefault(); const c = b.dataset.c;
      if (c === 'createLink') { const u = prompt('Link address (https://…)'); if (u) document.execCommand('createLink', false, u); }
      else if (c === 'formula') { const f = prompt('Formula, e.g. Q = SV × HR'); if (f) document.execCommand('insertHTML', false, `<code>${esc(f)}</code>&nbsp;`); }
      else if (c === 'table') document.execCommand('insertHTML', false, '<table><tbody><tr><th>Heading</th><th>Heading</th></tr><tr><td>&nbsp;</td><td>&nbsp;</td></tr></tbody></table><p></p>');
      else document.execCommand(c);
      onChange();
    });
    area.oninput = onChange;
    return { get: () => S.sanitise(area.innerHTML), set: h => { area.innerHTML = S.sanitise(h); } };
  }
  const sharedEd = rte($('rteShared'), () => { renderPreview(); }), qEd = rte($('rteQuestion'), () => { renderPreview(); });

  /* ---------- current content (draft if one exists, else published/base) ---------- */
  function current() {
    const it = S.item(qid), b = S.base(qid);
    return Object.assign({}, b, it.published || {}, it.draft || {});
  }
  const paraHtml = t => t ? '<p>' + esc(t).replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>') + '</p>' : '';
  const htmlOf = (c, k) => c[k + 'Html'] !== undefined ? c[k + 'Html'] : paraHtml(c[k]);

  /* ---------- assessment form ---------- */
  function renderAssess(c) {
    const st = c.assessmentStatistics || {}, box = $('assessFields');
    const common = `
      <label class="field"><span>Assessment-report source</span><input id="fSource" value="${esc(st.source || '')}"></label>
      <label class="field"><span>Source-verification status</span><select id="fVerified"><option value="true" ${st.sourceVerified ? 'selected' : ''}>Verified</option><option value="false" ${st.sourceVerified ? '' : 'selected'}>Not verified</option></select></label>`;
    if (c.section === 'A') {
      const p = st.optionPercentages || { A: 0, B: 0, C: 0, D: 0 };
      box.innerHTML = `<div class="studio-grid"><div>
        <label class="field"><span>Correct option</span><select id="fCorrect">${(st.correctOption || c.correctOption) ? '' : '<option value="">Select…</option>'}${['A', 'B', 'C', 'D'].map(o => `<option ${(st.correctOption || c.correctOption) === o ? 'selected' : ''}>${o}</option>`).join('')}</select></label>
        ${['A', 'B', 'C', 'D'].map(o => `<label class="field"><span>Percentage selecting ${o}</span><input type="number" min="0" max="100" id="fPct${o}" value="${p[o] ?? 0}"></label>`).join('')}
        <label class="field"><span>Calculated percentage correct (read-only)</span><input id="fCalc" readonly></label></div><div>${common}</div></div>`;
      ['A', 'B', 'C', 'D'].concat('Correct').forEach(o => $('f' + (o === 'Correct' ? 'Correct' : 'Pct' + o)).oninput = syncCalc);
      $('fCorrect').onchange = syncCalc; syncCalc();
    } else {
      const ex = c.fullMarkExample || { content: '', criteriaDemonstrated: [], teacherApproved: false };
      box.innerHTML = `<div class="studio-grid"><div>
        <label class="field"><span>Published average score</span><input type="number" step="0.1" id="fAvg" value="${st.averageScore ?? ''}"></label>
        <label class="field"><span>Maximum marks</span><input type="number" id="fMax" value="${st.maximumScore ?? c.marks}"></label>
        <label class="field"><span>Calculated percentage equivalent (read-only)</span><input id="fCalc" readonly></label>
        <label class="field"><span>Marking criteria (one per line)</span><textarea id="fCrit" rows="5">${esc((c.criteria || []).map(x => x[0]).join('\n'))}</textarea></label>
        <label class="field"><span>Accepted alternatives (one per line)</span><textarea id="fAlt" rows="3">${esc((c.acceptedAlternatives || []).join('\n'))}</textarea></label>
      </div><div>
        <label class="field"><span>Common examiner errors</span><textarea id="fCommon" rows="3">${esc(c.commonError || '')}</textarea></label>
        <label class="field"><span>Progressive hints (one per line, “Title | text”)</span><textarea id="fHints" rows="4">${esc((c.hints || []).map(h => h.join(' | ')).join('\n'))}</textarea></label>
        <label class="field"><span>Example full-mark response</span><textarea id="fExample" rows="4">${esc(ex.content)}</textarea></label>
        <label class="field"><span><input type="checkbox" id="fApproved" ${ex.teacherApproved ? 'checked' : ''} style="width:auto"> Teacher approved</span></label>${common}</div></div>`;
      ['fAvg', 'fMax'].forEach(i => $(i).oninput = syncCalc); syncCalc();
    }
    box.querySelectorAll('input,textarea,select').forEach(el => { const o = el.oninput; el.addEventListener('input', () => { liveValidate(); renderPreview(); }); });
  }
  function syncCalc() {
    const c = current();
    if (c.section === 'A') { const k = $('fCorrect').value, el = $('fPct' + k); $('fCalc').value = el ? (el.value || 0) + '%' : ''; }
    else { const a = parseFloat($('fAvg').value), m = parseFloat($('fMax').value); $('fCalc').value = m > 0 && !isNaN(a) ? S.recalcPercentage({ statisticType: 'average_score', averageScore: a, maximumScore: m }) + '%' : ''; }
  }
  function collectStats(c) {
    const src = $('fSource').value, ver = $('fVerified').value === 'true';
    if (c.section === 'A') {
      const p = {}; ['A', 'B', 'C', 'D'].forEach(o => p[o] = parseFloat($('fPct' + o).value) || 0);
      const k = $('fCorrect').value;
      if (!Object.values(p).some(v => v > 0) && !src.trim()) return { statisticType: 'not_published' };
      return { statisticType: 'option_distribution', correctOption: k, correctPercentage: p[k], optionPercentages: p, cohort: '2025 examination cohort', source: src, sourceVerified: ver };
    }
    const avg = parseFloat($('fAvg').value), max = parseFloat($('fMax').value);
    if (isNaN(avg) && !src.trim()) return { statisticType: 'not_published' };
    return { statisticType: 'average_score', averageScore: avg, maximumScore: max, calculatedPercentage: S.recalcPercentage({ statisticType: 'average_score', averageScore: avg, maximumScore: max }), cohort: '2025 examination cohort', source: src, sourceVerified: ver };
  }
  function collect() {
    const c = current(), patch = { textHtml: qEd.get(), sharedContextHtml: sharedEd.get(), assessmentStatistics: collectStats(c) };
    try { const cfg = JSON.parse($('compJson').value || '{}'); cfg.type = $('compType').value; patch.responseComponent = cfg; } catch { patch.responseComponent = null; }
    if (c.section === 'A') {
      const k = $('fCorrect').value; patch.correctOption = k;
      if (patch.responseComponent && patch.responseComponent.type === 'multiple_choice') patch.responseComponent.correct = k;
    }
    if (c.section === 'B') {
      const crit = $('fCrit').value.split('\n').map(x => x.trim()).filter(Boolean);
      patch.criteria = crit.map((t, i) => [t, [], 'criterion-' + (i + 1)]);
      patch.acceptedAlternatives = $('fAlt').value.split('\n').map(x => x.trim()).filter(Boolean);
      patch.commonError = $('fCommon').value;
      patch.hints = $('fHints').value.split('\n').map(x => x.split('|').map(y => y.trim())).filter(h => h[0]).map(h => [h[0], h[1] || '']);
      patch.fullMarkExample = { content: $('fExample').value, maximumScore: c.marks, criteriaDemonstrated: $('fExample').value.trim() ? patch.criteria.map(x => x[2]) : [], sourceType: 'examiner_report_grounded', teacherApproved: $('fApproved').checked, isOnlyAcceptableAnswer: false };
    }
    return patch;
  }
  function liveValidate() {
    const c = current(), p = collect(), merged = Object.assign({}, c, p);
    const errs = [...S.validateAssessment(merged, merged.assessmentStatistics), ...S.validateFullMark(merged), ...S.validateMcKey(merged)];
    $('errors').innerHTML = errs.map(e => `<div>${esc(e)}</div>`).join('');
    return errs;
  }

  /* ---------- response component ---------- */
  function renderComponentEditor(c) {
    const key = c.correctOption || (c.assessmentStatistics && c.assessmentStatistics.correctOption);
    const comp = c.responseComponent || { type: c.responseType === 'multiple_choice' ? 'multiple_choice' : 'extended_text', options: c.options || [], ...(key ? { correct: key } : {}) };
    $('compType').innerHTML = S.COMPONENTS.map(t => `<option ${comp.type === t ? 'selected' : ''}>${t}</option>`).join('');
    const { type, ...rest } = comp; $('compJson').value = JSON.stringify(rest, null, 1);
    drawComponent();
  }
  function drawComponent() {
    let cfg; try { cfg = JSON.parse($('compJson').value || '{}'); cfg.type = $('compType').value; } catch { $('compPreview').innerHTML = '<div class="errors">Component settings are not valid JSON.</div>'; return null; }
    $('compPreview').innerHTML = S.renderComponent(cfg, 'preview', ''); return cfg;
  }
  $('compType').onchange = () => { drawComponent(); renderPreview(); };
  $('compJson').oninput = () => { drawComponent(); renderPreview(); };

  /* ---------- previews ---------- */
  function renderPreview() {
    const c = Object.assign({}, current(), collect()), f = $('previewFrame');
    f.className = 'preview-frame' + (pvMode === 'mobile' ? ' mobile' : '');
    const st = c.assessmentStatistics, strict = pvMode === 'strict';
    const stat = !st ? 'No cohort statistic published' : st.statisticType === 'option_distribution' ? `${st.correctPercentage}% answered correctly` : st.statisticType === 'average_score' ? `Average: ${st.averageScore}/${st.maximumScore}` : 'No cohort statistic published';
    const comp = c.responseComponent || { type: c.responseType === 'multiple_choice' ? 'multiple_choice' : 'extended_text', options: c.options || [] };
    f.innerHTML = `${c.sharedContextHtml ? `<div class="context">${c.sharedContextHtml}</div>` : ''}
      <div class="tagrow"><span class="tag dark">${c.examYear} VCAA Exam</span><span class="tag purple">Section ${c.section}, Question ${esc(c.displayLabel)}</span><span class="tag">${esc(c.topic)}</span><span class="tag amber">${c.marks} mark${c.marks === 1 ? '' : 's'}</span>${strict ? '' : `<span class="tag green stat">${esc(stat)}</span>`}</div>
      <div class="qblock"><h2 style="font-size:18px">${c.textHtml || esc(c.text)}</h2></div>
      <div class="label">Your response</div>${S.renderComponent(comp, 'pv', '')}
      ${strict ? '<p class="muted">Strict exam: statistics, hints, criteria and examples are hidden.</p>' : (c.hints || []).slice(0, 1).map(h => `<div class="hint"><strong>${esc(h[0])}</strong><p>${esc(h[1])}</p></div>`).join('')}`;
  }
  document.querySelectorAll('[data-pv]').forEach(b => b.onclick = () => { pvMode = b.dataset.pv; renderPreview(); });

  /* ---------- assets ---------- */
  async function renderAssets() {
    const list = await S.assets.forQuestion(qid, false), all = await S.assets.all();
    $('assetExisting').innerHTML = '<option value="">Select…</option>' + all.filter(a => !a.questionIds.includes(qid)).map(a => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('');
    $('assetList').innerHTML = list.map((a, i) => `<div class="asset-row" data-id="${esc(a.id)}"><img src="${URL.createObjectURL(a.blob)}" alt="${esc(a.alt || 'No alt text')}"><div>
      <strong>${esc(a.name)}</strong> · ${esc(a.approval)} · ${esc(a.placement)}<br><span class="muted">Alt: ${esc(a.alt || '(missing – hidden from students)')} · Rights: ${esc(a.rightsHolder || '—')} · Licence: ${esc(a.licence || '—')}</span>
      <div class="actions"><button class="btn" data-act="up" ${i === 0 ? 'disabled' : ''}>Move up</button><button class="btn" data-act="down" ${i === list.length - 1 ? 'disabled' : ''}>Move down</button>
      <button class="btn" data-act="approve">Approve</button><button class="btn" data-act="replace">Replace file</button><button class="btn danger" data-act="remove">Remove</button></div></div></div>`).join('') || '<p class="muted">No assets attached to this question.</p>';
    $('assetList').querySelectorAll('[data-act]').forEach(b => b.onclick = async () => {
      const id = b.closest('.asset-row').dataset.id, a = list.find(x => x.id === id), act = b.dataset.act;
      if (act === 'remove') { a.questionIds = a.questionIds.filter(x => x !== qid); a.questionIds.length ? await S.assets.put(a) : await S.assets.remove(a.id); }
      else if (act === 'approve') { a.approval = 'approved'; await S.assets.put(a); }
      else if (act === 'replace') { const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*'; inp.onchange = async () => { if (inp.files[0]) { a.blob = inp.files[0]; a.name = inp.files[0].name; await S.assets.put(a); renderAssets(); } }; inp.click(); return; }
      else { const j = list.findIndex(x => x.id === id), k = act === 'up' ? j - 1 : j + 1; [list[j].order, list[k].order] = [k, j]; list.forEach((x, n) => { if (x.order === undefined) x.order = n; }); await S.assets.put(list[j]); await S.assets.put(list[k]); }
      renderAssets();
    });
  }
  $('assetFile').onchange = async () => {
    const f = $('assetFile').files[0]; if (!f) return;
    const n = (await S.assets.forQuestion(qid, false)).length;
    await S.assets.put({ questionIds: [qid], blob: f, name: f.name, alt: $('aAlt').value.trim(), caption: $('aCaption').value.trim(), source: $('aSource').value.trim(), rightsHolder: $('aRights').value.trim(), licence: $('aLicence').value.trim(), approval: $('aApproval').value, placement: $('aPlacement').value, order: n });
    $('assetFile').value = ''; $('saveMsg').textContent = 'Image attached to this question.'; renderAssets();
  };
  $('attachExisting').onclick = async () => {
    const id = $('assetExisting').value; if (!id) return;
    const a = (await S.assets.all()).find(x => x.id === id); a.questionIds.push(qid); await S.assets.put(a); renderAssets();
  };

  /* ---------- workflow ---------- */
  function renderStatus() {
    const it = S.item(qid);
    $('statusPill').textContent = it.status.replace(/_/g, ' ');
    $('gateText').textContent = it.draft ? `Passed: ${it.gates.length ? it.gates.join(', ') : 'none yet'}` : 'Showing published content to students';
    $('advanceGate').disabled = !it.draft || it.gates.length >= S.GATES.length;
    $('publishBtn').disabled = !it.draft;
    $('versions').innerHTML = it.versions.length ? it.versions.slice().reverse().map(v => `<p><strong>Version ${v.n}</strong> · ${new Date(v.at).toLocaleString()} <button class="btn" data-rb="${v.n}" type="button">Roll back to this version (as new draft)</button></p>`).join('') : 'No published versions yet.';
    $('versions').querySelectorAll('[data-rb]').forEach(b => b.onclick = () => { S.rollback(qid, +b.dataset.rb); load(); $('saveMsg').textContent = 'Rolled back into a draft. Review and publish to make it live.'; });
  }
  function persistDraft() { const errs = liveValidate(); S.updateDraft(qid, collect()); renderStatus(); $('saveMsg').textContent = 'Draft saved. Students still see the published version.'; return errs; }
  $('saveDraft').onclick = persistDraft;
  $('advanceGate').onclick = () => { persistDraft(); const r = S.advance(qid, 'studio'); $('saveMsg').textContent = r.ok ? 'Review gate passed.' : r.error; renderStatus(); };
  $('publishBtn').onclick = () => {
    const r = S.publish(qid, 'studio');
    $('errors').innerHTML = r.ok ? '' : r.errors.map(e => `<div>${esc(e)}</div>`).join('');
    $('saveMsg').textContent = r.ok ? `Published as version ${r.version}. Previous versions are kept in history.` : '';
    renderStatus();
  };
  $('archiveBtn').onclick = () => { S.archive(qid); renderStatus(); $('saveMsg').textContent = 'Archived: hidden from students, history kept.'; };
  $('dupQuestion').onclick = () => { const ids = S.duplicate(qid, false); fillPicker(ids[0]); };
  $('dupGroup').onclick = () => { const ids = S.duplicate(qid, true); fillPicker(ids[0]); };

  /* ---------- load / picker ---------- */
  function allIds() { return [...QUESTIONS.map(q => q.id), ...Object.keys(S.state.custom).filter(id => !QUESTIONS.some(q => q.id === id))]; }
  function fillPicker(select) {
    $('qPicker').innerHTML = allIds().map(id => { const b = S.base(id); return `<option value="${esc(id)}">${b.section} ${esc(b.displayLabel)} • ${esc(b.topic)} • ${b.marks} mark${b.marks === 1 ? '' : 's'}</option>`; }).join('');
    if (select) qid = select; $('qPicker').value = qid; load();
  }
  function load() {
    const c = current();
    sharedEd.set(htmlOf(c, 'sharedContext')); qEd.set(htmlOf(c, 'text'));
    renderComponentEditor(c); renderAssess(c); renderStatus(); liveValidate(); renderPreview(); renderAssets();
  }
  $('qPicker').onchange = () => { qid = $('qPicker').value; $('saveMsg').textContent = ''; load(); };
  window.__studio = { load, collect, current, fillPicker };
  fillPicker();
})();
