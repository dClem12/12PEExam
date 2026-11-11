/* Practice mode: filters, cohort-statistic tag row, progressive hints,
   submit -> revise -> reveal full-mark example sequence, comparison and reflection.
   State lives in localStorage key "pe13" (shared with dashboard, exam and results). */
(() => {
  const previewMode = window.MODE === 'preview';
  let ix = 0, visible = [...QUESTIONS], q = QUESTIONS[0];
  const store = JSON.parse(localStorage.getItem('pe13') || '{}');
  store.attempts = store.attempts || {};
  const release = Object.assign(
    { scoreOnly: false, criterionFeedback: true, improvementFeedback: true, hints: true, fullMarkExample: true, allAfterDue: false },
    store.release || {}
  );

  const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const persist = () => localStorage.setItem('pe13', JSON.stringify(store));
  const attemptOf = id => (store.attempts[id] = Object.assign(
    { draft: '', submissions: [], hintsUsed: 0, revisedBeforeReveal: false, skippedRevision: false, viewedExample: false, reflection: '' },
    store.attempts[id] || {}
  ));
  const fmt = n => (Math.round(n * 10) / 10).toString();
  const SS = window.StudioStore;                      // published Question Studio content, if present
  const isEmptyDeep = v => v === '' || v == null || (Array.isArray(v) ? v.every(isEmptyDeep) : typeof v === 'object' ? Object.values(v).every(isEmptyDeep) : false);
  const encode = v => isEmptyDeep(v) ? '' : (typeof v === 'string' ? v : JSON.stringify(v));
  const decode = d => { if (typeof d === 'string' && /^[\[{]/.test(d)) { try { return JSON.parse(d); } catch { /* plain text */ } } return d; };
  const usesComponent = x => !!(SS && x.responseComponent && x.responseComponent.type);
  const richOrPlain = (html, plain) => html ? (SS ? SS.sanitise(html) : html) : esc(plain);

  /* ---------- cohort statistic (tag 5 of 5) ---------- */
  function statisticTag(question) {
    const s = question.assessmentStatistics;
    if (!s) return '<span class="tag stat none">No cohort statistic published</span>';
    if (s.statisticType === 'option_distribution' && question.section === 'A')
      return `<span class="tag green stat" title="${esc(s.cohort)} · ${esc(s.source)}">${s.correctPercentage}% answered correctly</span>`;
    if (s.statisticType === 'average_score' && question.section === 'B')
      return `<span class="tag green stat" title="${esc(s.cohort)} · ${esc(s.source)}">Average: ${fmt(s.averageScore)}/${s.maximumScore}</span>`;
    return '<span class="tag stat none">No cohort statistic published</span>';
  }
  function distributionLine(question) {
    const s = question.assessmentStatistics;
    if (!s || s.statisticType !== 'option_distribution') return '';
    return `<p class="stat-note"><strong>Cohort responses:</strong> ${Object.entries(s.optionPercentages).map(([k, v]) => `${k}: ${v}%`).join(' · ')}</p>`;
  }
  function calculatedNote(question) {
    const s = question.assessmentStatistics;
    if (!s || s.statisticType !== 'average_score') return '';
    return `<p class="stat-note muted">Platform calculation: ${fmt(s.calculatedPercentage)}% of available marks (the published statistic is the average score above).</p>`;
  }

  /* ---------- filters / selector ---------- */
  function populateFilters() {
    [...new Set(QUESTIONS.map(x => x.topic))].sort().forEach(x => topicFilter.insertAdjacentHTML('beforeend', `<option>${esc(x)}</option>`));
  }
  function apply() {
    visible = QUESTIONS.filter(x =>
      (sectionFilter.value === 'all' || x.section === sectionFilter.value) &&
      (topicFilter.value === 'all' || x.topic === topicFilter.value) &&
      (marksFilter.value === 'all' || String(x.marks) === marksFilter.value));
    selector.innerHTML = '';
    visible.forEach((x, i) => selector.insertAdjacentHTML('beforeend',
      `<option value="${i}">${x.section} Question ${esc(x.displayLabel)} • ${esc(x.topic)} • ${x.marks} mark${x.marks === 1 ? '' : 's'}</option>`));
    ix = 0; selector.value = '0'; render();
  }

  function currentAnswer() {
    if (usesComponent(q)) return encode(SS.readComponent(q.responseComponent, 'answer', mount));
    return q.responseType === 'multiple_choice'
      ? (document.querySelector('input[name=answer]:checked')?.value || '')
      : (document.getElementById('writtenAnswer')?.value || '');
  }
  function saveDraft() {
    const a = attemptOf(q.id); a.draft = currentAnswer(); persist();
  }

  /* ---------- render ---------- */
  function render() {
    if (!visible.length) { mount.innerHTML = '<div class="notice">No questions match these filters.</div>'; return; }
    q = visible[ix]; if (window.selector) selector.value = String(ix);
    const a = attemptOf(q.id);
    const prior = a.draft || '';
    const response = usesComponent(q) ? SS.renderComponent(q.responseComponent, 'answer', decode(prior)) : q.responseType === 'multiple_choice'
      ? q.options.map((o, i) => { const l = 'ABCD'[i]; return `<label class="option"><input type="radio" name="answer" value="${l}" ${prior === l ? 'checked' : ''}><strong>${l}.</strong> ${esc(o)}</label>`; }).join('')
      : `<textarea id="writtenAnswer" aria-label="Your response">${esc(prior)}</textarea><div class="muted" id="wordCount"></div>`;

    mount.innerHTML = `<article class="card">
      ${q.section === 'B' ? `<div class="context"><h3>Section B • Question ${esc(q.group)}</h3><div>${richOrPlain(q.sharedContextHtml, q.sharedContext)}</div></div>` : ''}
      <div class="tagrow">
        <span class="tag dark">${q.examYear} VCAA Exam</span>
        <span class="tag purple">Section ${q.section}, Question ${esc(q.displayLabel)}</span>
        <span class="tag">${esc(q.topic)}</span>
        <span class="tag amber">${q.marks} mark${q.marks === 1 ? '' : 's'}</span>
        ${statisticTag(q)}
      </div>
      <div class="label">Exam question</div><div class="qblock"><h2>${richOrPlain(q.textHtml, q.text)}</h2></div><div id="studioAssets"></div>
      ${(q.visualAssets || []).map(x => `<div class="asset"><img src="${esc(x)}" alt="Question stimulus asset"></div>`).join('')}
      <div class="label">Your response</div>${response}
      <div class="actions">
        ${q.section === 'B' && release.hints ? `<button class="btn" id="hint" type="button">${a.hintsUsed ? 'Next hint' : 'Reveal hint'}</button>` : ''}
        <button class="btn primary" id="assess" type="button">${q.section === 'B' && a.submissions.length ? 'Submit revised response' : 'Assess response'}</button>
      </div>
      <div id="hints"></div><div id="feedback"></div><div id="exampleArea"></div>
    </article>`;

    document.querySelectorAll('input[name=answer]').forEach(x => x.onchange = saveDraft);
    if (usesComponent(q)) { mount.addEventListener('input', saveDraft); mount.addEventListener('change', saveDraft); }
    if (SS) SS.mountAssets(q.id, document.getElementById('studioAssets'));
    if (window.writtenAnswer) {
      const wc = () => { const n = writtenAnswer.value.trim().split(/\s+/).filter(Boolean).length; wordCount.textContent = `${n} word${n === 1 ? '' : 's'} • saved automatically`; };
      writtenAnswer.oninput = () => { saveDraft(); wc(); }; wc();
    }
    if (window.hint) hint.onclick = revealHint;
    assess.onclick = assessResponse;
    renderHints();
    if (a.submissions.length) renderFeedback();
    if (a.viewedExample) renderExample();
  }

  /* ---------- hints (progressive, recorded) ---------- */
  function renderHints() {
    const a = attemptOf(q.id);
    if (!window.hints) return;
    hints.innerHTML = q.hints.slice(0, a.hintsUsed).map(h => `<div class="hint"><strong>${esc(h[0])}</strong><p>${esc(h[1])}</p></div>`).join('');
    if (window.hint && a.hintsUsed >= q.hints.length) { hint.disabled = true; hint.textContent = 'No more hints'; }
  }
  function revealHint() {
    const a = attemptOf(q.id);
    if (a.hintsUsed < q.hints.length) a.hintsUsed++;
    persist(); hint.textContent = 'Next hint'; renderHints();
  }

  /* ---------- assess / revise ---------- */
  function assessResponse() {
    const raw = currentAnswer();
    if (!raw.trim()) { feedback.innerHTML = '<div class="notice warn">Enter or select a response first.</div>'; return; }
    saveDraft();
    const a = attemptOf(q.id);
    a.count = (a.count || 0) + 1;

    if (usesComponent(q) && !['extended_text', 'short_text', 'multiple_choice'].includes(q.responseComponent.type)) {
      a.submissions.push({ text: raw, at: new Date().toISOString(), criteriaMet: [] }); persist();
      const r = SS.assessComponent(q.responseComponent, decode(raw));
      feedback.innerHTML = `<div class="notice">${r.available ? `${r.earned} of ${r.available} auto-checked item${r.available === 1 ? '' : 's'} correct.` : 'Submitted for review.'}</div><p>${esc(r.note)}</p>`; return;
    }
    if (q.responseType === 'multiple_choice') {
      a.submissions.push({ text: raw, at: new Date().toISOString(), criteriaMet: [] });
      persist();
      feedback.innerHTML = `<div class="notice">${raw === q.correctOption ? 'Correct' : 'Not yet correct. Correct answer: ' + esc(q.correctOption)}</div>${distributionLine(q)}<p>${esc(q.model)}</p>`;
      return;
    }

    const last = a.submissions[a.submissions.length - 1];
    if (last && last.text.trim() === raw.trim()) {
      a.count--; persist();
      feedback.innerHTML = '<div class="notice warn">Revise your response before submitting again. Use the criteria and hints below.</div>';
      renderFeedback(); return;
    }
    a.submissions.push({ text: raw, at: new Date().toISOString(), criteriaMet: [] });
    if (a.submissions.length >= 2) a.revisedBeforeReveal = !a.viewedExample ? true : a.revisedBeforeReveal;
    persist();
    assess.textContent = 'Submit revised response';
    renderFeedback();
  }

  function renderFeedback() {
    const a = attemptOf(q.id);
    if (q.responseType === 'multiple_choice') return;
    const n = a.submissions.length, latest = a.submissions[n - 1];
    const parts = [`<div class="notice">Response ${n} submitted. Marks are indicative only.</div>`];
    if (release.criterionFeedback) {
      parts.push(`<h3>Criteria self-check</h3><p class="muted">Tick each idea you believe your latest response demonstrates. This is your own check, not automated marking.</p>
        ${q.criteria.map(c => `<label class="option"><input type="checkbox" data-crit="${esc(c[2])}" ${latest.criteriaMet.includes(c[2]) ? 'checked' : ''}> ${esc(c[0])}</label>`).join('')}`);
    }
    if (release.improvementFeedback) parts.push(`<p><strong>Common examiner issue:</strong> ${esc(q.commonError)}</p>`);
    parts.push(calculatedNote(q));
    parts.push(exampleControls(a));
    feedback.innerHTML = parts.join('');
    feedback.querySelectorAll('input[data-crit]').forEach(c => c.onchange = () => {
      latest.criteriaMet = [...feedback.querySelectorAll('input[data-crit]:checked')].map(x => x.dataset.crit);
      persist(); if (a.viewedExample) renderExample();
    });
    const rv = document.getElementById('revealExample'), sk = document.getElementById('skipReveal');
    if (rv) rv.onclick = () => { a.viewedExample = true; persist(); renderFeedback(); renderExample(); };
    if (sk) sk.onclick = () => { a.skippedRevision = true; a.viewedExample = true; persist(); renderFeedback(); renderExample(); };
  }

  function exampleControls(a) {
    if (!release.fullMarkExample) return '<p class="muted">Your teacher has not released the full-mark example yet.</p>';
    if (!q.fullMarkExample) return '<p class="muted">No full-mark example is available for this question yet.</p>';
    const unlocked = a.submissions.length >= 2;
    if (a.viewedExample) return '';
    return `<div class="actions">
      <button class="btn primary" id="revealExample" type="button" ${unlocked ? '' : 'disabled aria-disabled="true"'}>Reveal full-mark example</button>
      <button class="btn" id="skipReveal" type="button">Skip revision and reveal example</button>
    </div>${unlocked ? '' : '<p class="muted">Revise and submit your response again to unlock the example. Skipping is allowed and is recorded.</p>'}`;
  }

  /* ---------- example, comparison, reflection ---------- */
  function renderExample() {
    const a = attemptOf(q.id), ex = q.fullMarkExample;
    if (!ex || !window.exampleArea) return;
    const subs = a.submissions, latest = subs[subs.length - 1], first = subs[0];
    const all = ex.criteriaDemonstrated;
    const label = id => esc((q.criteria.find(c => c[2] === id) || [id])[0]);
    const met = latest ? latest.criteriaMet : [];
    const gained = subs.length >= 2 ? met.filter(c => !first.criteriaMet.includes(c)) : [];
    const missing = all.filter(c => !met.includes(c));
    const list = ids => ids.length ? `<ul>${ids.map(i => `<li>${label(i)}</li>`).join('')}</ul>` : '<p class="muted">None recorded.</p>';
    exampleArea.innerHTML = `<div class="example">
      <div class="notice"><strong>Example full-mark response</strong><br>This is one valid way to achieve full marks. Other wording may also be accepted.</div>
      ${ex.teacherApproved ? '' : '<p class="muted"><em>Draft example grounded in the 2025 assessment report; awaiting teacher approval.</em></p>'}
      <table class="compare"><thead><tr><th>Student response</th><th>Example full-mark response</th></tr></thead>
        <tbody><tr><td>${esc(latest ? latest.text : '').replace(/\n/g, '<br>')}</td><td>${esc(ex.content).replace(/\n/g, '<br>')}</td></tr></tbody></table>
      <div class="grid2">
        <div><h4>Demonstrated by both</h4>${list(met.filter(c => all.includes(c)))}</div>
        <div><h4>Gained after revision</h4>${list(gained)}</div>
      </div>
      <h4>In the example but missing from your response</h4>${list(missing)}
      <p class="muted">Based on your criteria self-check. Valid alternative wording may require teacher review.</p>
      <label class="label" for="reflection">What idea or relationship in the example was missing from your response?</label>
      <textarea id="reflection" placeholder="Optional reflection">${esc(a.reflection)}</textarea>
      <div class="muted" id="reflectionStatus">Saved with this attempt.</div>
    </div>`;
    reflection.oninput = () => { a.reflection = reflection.value; persist(); reflectionStatus.textContent = 'Saved with this attempt.'; };
  }

  /* ---------- wiring ---------- */
  if (previewMode) {
    visible = QUESTIONS.length ? [QUESTIONS[0]] : [];
    ix = 0;
    render();
  } else {
    selector.onchange = () => { ix = +selector.value; render(); };
    [sectionFilter, topicFilter, marksFilter].forEach(x => x.onchange = apply);
    previousQuestion.onclick = () => { ix = Math.max(0, ix - 1); render(); };
    nextQuestion.onclick = () => { ix = Math.min(visible.length - 1, ix + 1); render(); };
    weakTopicSet.onclick = () => { topicFilter.value = 'all'; sectionFilter.value = 'B'; marksFilter.value = 'all'; apply(); };
    resetPractice.onclick = () => {
      if (confirm('Reset all saved practice responses, bookmarks and retry dates? This will not remove exam history or your account.')) {
        store.attempts = {}; store.bookmarks = {}; store.retries = {}; persist(); apply();
      }
    };
    populateFilters(); apply();
  }
})();
