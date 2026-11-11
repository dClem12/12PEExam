/* Browser PDF ingestion for Question Studio. Requires PDF.js and optional Tesseract.js. */
(()=>{'use strict';const $=id=>document.getElementById(id),S=window.StudioStore;let pdf=null,file=null,pages=[],candidates=[];if(!$('importPdf'))return;
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
function status(t){$('pdfProgress').innerHTML=`<div class="notice">${esc(t)}</div>`}
async function readPage(n){const page=await pdf.getPage(n),tc=await page.getTextContent(),items=tc.items.slice().sort((a,b)=>Math.abs(b.transform[5]-a.transform[5])>4?b.transform[5]-a.transform[5]:a.transform[4]-b.transform[4]);let y=null,line='',out=[];for(const it of items){const iy=it.transform[5];if(y!==null&&Math.abs(iy-y)>4){if(line.trim())out.push(line.trim());line=''}line+=(line?' ':'')+it.str;y=iy}if(line.trim())out.push(line.trim());return{text:out.join('\n'),method:'embedded text',page:n}}
function renderPages(){ $('pdfPages').innerHTML=pages.map((p,i)=>`<article class="card"><h3>Page ${p.page} <span class="tag ${p.text.length<80?'amber':'green'}">${esc(p.method)}</span></h3><textarea class="pageText" data-i="${i}" rows="10">${esc(p.text)}</textarea></article>`).join('');document.querySelectorAll('.pageText').forEach(x=>x.oninput=()=>pages[+x.dataset.i].text=x.value)}
async function loadPdf(f){file=f;status('Reading PDF…');const bytes=await f.arrayBuffer();pdf=await pdfjsLib.getDocument({data:bytes}).promise;pages=[];for(let i=1;i<=pdf.numPages;i++){status(`Extracting page ${i} of ${pdf.numPages}…`);pages.push(await readPage(i))}const year=(f.name.match(/(?:19|20)\d{2}/)||[])[0]||new Date().getFullYear();$('pdfYear').value=year;$('pdfTitle').value=`${year} VCE Physical Education examination`;renderPages();status(`Extracted ${pdf.numPages} pages. Review text, OCR low-text pages if needed, then detect questions.`);$('pdfDialog').showModal()}
async function renderCanvas(n){const p=await pdf.getPage(n),vp=p.getViewport({scale:2}),c=document.createElement('canvas');c.width=Math.ceil(vp.width);c.height=Math.ceil(vp.height);await p.render({canvasContext:c.getContext('2d'),viewport:vp}).promise;return c}
$('runOcr').onclick=async()=>{if(!window.Tesseract){status('OCR library could not load. Embedded-text extraction is still available.');return}const low=pages.filter(p=>p.text.trim().length<80);if(!low.length){status('No low-text pages were detected.');return}const worker=await Tesseract.createWorker('eng',1,{logger:m=>{if(m.status)status(`OCR: ${m.status} ${m.progress?Math.round(m.progress*100)+'%':''}`)}});try{for(const p of low){status(`OCR page ${p.page}…`);const c=await renderCanvas(p.page),r=await worker.recognize(c);p.text=r.data.text.trim();p.method='OCR unreviewed'}}finally{await worker.terminate()}renderPages();status(`OCR completed for ${low.length} page(s). Correct OCR errors before detecting questions.`)};
function detect(){candidates=[];let section='A',group='';for(const p of pages){const lines=p.text.split(/\n+/).map(x=>x.trim()).filter(Boolean);for(let i=0;i<lines.length;i++){const ln=lines[i];if(/section\s+a/i.test(ln))section='A';if(/section\s+b/i.test(ln))section='B';let m=ln.match(/^(?:question\s*)?(\d{1,2})(?:\s*[\.)-]|\s+)(.*)$/i);if(!m)continue;const number=m[1],body=[m[2]];for(let j=i+1;j<Math.min(lines.length,i+12);j++){if(/^(?:question\s*)?\d{1,2}(?:\s*[\.)-]|\s+)/i.test(lines[j])||/section\s+[ab]/i.test(lines[j]))break;body.push(lines[j])}let text=body.join(' ').replace(/\s+/g,' ').trim();if(text.length<12)continue;const marks=(text.match(/\[(\d+)\s*marks?\]/i)||text.match(/(\d+)\s*marks?$/i)||[])[1];text=text.replace(/\[?\d+\s*marks?\]?$/i,'').trim();group=number;candidates.push({page:p.page,section,number,displayLabel:number,marks:Number(marks)||1,text,method:p.method,include:true})}}
// De-duplicate repeated headers/questions while preserving page provenance.
const seen=new Set();candidates=candidates.filter(q=>{const k=q.section+'|'+q.number+'|'+q.text.slice(0,80).toLowerCase();if(seen.has(k))return false;seen.add(k);return true});renderCandidates();status(`Detected ${candidates.length} possible questions. Correct every row before creating drafts.`)}
function renderCandidates(){$('pdfPages').innerHTML=candidates.map((q,i)=>`<article class="card"><div class="grid"><label class="field"><span><input class="inc" data-i="${i}" type="checkbox" ${q.include?'checked':''} style="width:auto"> Include</span></label><label class="field"><span>Source page</span><input class="qp" data-i="${i}" value="${q.page}"></label><label class="field"><span>Section</span><select class="qs" data-i="${i}"><option ${q.section==='A'?'selected':''}>A</option><option ${q.section==='B'?'selected':''}>B</option></select></label><label class="field"><span>Question number</span><input class="qn" data-i="${i}" value="${esc(q.number)}"></label><label class="field"><span>Display label</span><input class="ql" data-i="${i}" value="${esc(q.displayLabel)}"></label><label class="field"><span>Marks</span><input class="qm" data-i="${i}" type="number" min="1" value="${q.marks}"></label></div><label class="field"><span>Detected wording</span><textarea class="qt" data-i="${i}" rows="5">${esc(q.text)}</textarea></label><p class="muted">${esc(q.method)}. This wording will remain unverified until review gates are completed.</p></article>`).join('');const map={inc:'include',qp:'page',qs:'section',qn:'number',ql:'displayLabel',qm:'marks',qt:'text'};Object.entries(map).forEach(([cl,k])=>document.querySelectorAll('.'+cl).forEach(x=>x.oninput=()=>candidates[+x.dataset.i][k]=x.type==='checkbox'?x.checked:(k==='marks'||k==='page'?Number(x.value):x.value)))}
$('detectQuestions').onclick=detect;
$('createPdfDrafts').onclick=()=>{
  const button=$('createPdfDrafts');
  try{
    button.disabled=true; button.textContent='Creating drafts…';
    if(!candidates.length) throw Error('Detect and review questions first.');
    const selected=candidates.filter(x=>x.include);
    if(!selected.length) throw Error('Select at least one detected question.');
    const year=Number($('pdfYear').value);
    if(!Number.isInteger(year)||year<2000||year>2100) throw Error('Enter a valid four-digit exam year.');
    const examType=$('pdfExamType').value.trim()||'MAIN';
    const clean=x=>String(x||'').toUpperCase().replace(/[^A-Z0-9]+/g,'-').replace(/^-|-$/g,'');
    const eid=`VCE-PE-${year}-${clean(examType)}`;
    S.state.examinations=S.state.examinations||{};
    if(!S.state.examinations[eid]){
      S.state.examinations[eid]={id:eid,subject:'VCE Physical Education',examYear:year,examType,title:$('pdfTitle').value.trim()||`${year} VCE Physical Education examination`,studyDesignVersion:$('pdfDesign').value.trim(),sourceType:pages.some(p=>p.method.startsWith('OCR'))?'provisional_scan':'official_pdf',sourceFilename:file.name,provisionalStatus:'provisional',sourceVerification:pages.some(p=>p.method.startsWith('OCR'))?'OCR unreviewed':'unverified',examinerReportStatus:'not_received',createdAt:new Date().toISOString()};
    }
    let made=0; const skipped=[];
    for(const q of selected){
      const id=`VCE-PE-${year}-${clean(examType)}-${clean(q.section)}-Q${String(q.number).padStart(2,'0')}`;
      if(S.base(id)){skipped.push(`${id}: already exists`);continue;}
      const item={id,examinationId:eid,examYear:year,year,section:q.section,group:String(q.number),ref:String(q.number).toLowerCase(),displayLabel:q.displayLabel,partLabel:String(q.number),marks:Number(q.marks)||1,text:q.text,sharedContext:'',topic:'Unclassified',sourcePage:String(q.page),sourceType:pages[q.page-1]?.method==='OCR unreviewed'?'provisional_scan':'official_pdf',responseType:q.section==='A'?'multiple_choice':'written',options:q.section==='A'?['','','','']:[],responseComponent:q.section==='A'?{type:'multiple_choice',options:['','','','']}:{type:'extended_text'},assessmentStatistics:{statisticType:'not_published'},provenance:{wording:{sourceType:'pdf_import',sourceFilename:file.name,sourcePage:String(q.page),verificationStatus:pages[q.page-1]?.method==='OCR unreviewed'?'OCR unreviewed':'unverified'},marks:{sourceType:'pdf_import',sourceFilename:file.name,sourcePage:String(q.page),verificationStatus:'unverified'}}};
      S.state.custom[id]=item;
      S.state.items[id]={status:'draft',gates:[],draft:JSON.parse(JSON.stringify(item)),published:null,versions:[],modifiedAt:new Date().toISOString()};
      made++;
    }
    S.save();
    const message=`Created ${made} unverified question draft${made===1?'':'s'}.${skipped.length?` ${skipped.length} skipped because the stable ID already exists.`:''}`;
    $('pdfProgress').innerHTML=`<div class="notice">${esc(message)} Reloading Studio…</div>`;
    $('globalStatus').textContent=message;
    setTimeout(()=>location.reload(),700);
  }catch(e){
    $('pdfProgress').innerHTML=`<div class="errors">${esc(e.message||String(e))}</div>`;
    button.disabled=false; button.textContent='Create reviewed drafts';
  }
};
$('importPdf').onclick=()=>{$('pdfInput').value='';$('pdfInput').click()};$('pdfInput').onchange=()=>{const f=$('pdfInput').files[0];if(f)loadPdf(f).catch(e=>status('PDF import failed: '+e.message))};
})();
