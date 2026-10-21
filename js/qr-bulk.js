// طباعة ملصقات QR مجمّعة (v20، اتعدّل في v22.1): جدول بكل الأصناف + عدد الملصقات لكل صنف (نسخة / حسب الرصيد بالقطعة / حسب الرصيد بالكراتين / يدوي)
// وبترصّها تلقائياً على صفحات A4 (QR فوق، تحته اسم الصنف ثم الكود) وتطبعها بضغطة واحدة من المتصفح. الـQR نفسه من qrlabel.js (نفس المحتوى ALIRAQI-PRODUCT-<الكود>)
// فالمسح بالكاميرا بيشتغل زي الملصق الفردي بالظبط. مفيش حاجة بتتكتب في قاعدة البيانات: الشاشة دي قراءة + طباعة بس (إعدادات ضبط الورق بس في localStorage).
// v22.1: شبكة الطباعة بقت بالمليمتر بالظبط (مواضع مطلقة، مش padding/flow) ومناسبة لشيتات الاستيكر المقطّعة مسبقاً: المقاسات 50×30 / 50×70 / 100×70،
// ومعاها «ضبط الورق» (أعمدة/صفوف/مسافات/هوامش/إزاحة بالمليمتر) و«ورقة اختبار» تتطبع على ورق عادي وتتحط فوق الشيت قصاد الضوء قبل ما تضيّع استيكر.
import {all,stockMap} from './db.js';
import {can} from './auth.js';
import {norm,compact} from './products.js';
import {labelHtml,LABEL_CSS,SIZES} from './qrlabel.js';
import {$,el,toast,fmt} from './ui.js';

const MAX_PER=200,MAX_TOTAL=(navigator.deviceMemory||4)<=2?500:1500,MARGIN=5,PAGE=60;   // v23.3: الأجهزة قليلة الذاكرة (≤2GB) حدها 500 ملصق في الطباعة الواحدة بدل 1500
      // أقصى نسخ للصنف / أقصى ملصقات في الطباعة الواحدة / أقل هامش افتراضي لحساب الأعمدة والصفوف (مم) / حجم صفحة القائمة
const A4W=210,A4H=297,SAFE=4,PG_H=296.5;                // الطابعات الليزر مش بتطبع في أول ~4مم من حافة الورقة · ارتفاع .pg أقل من 297 بنص مم عشان ما تطلعش صفحة فاضية زيادة (تقريب المتصفح)
const CAL_KEY=k=>'alr_qr_cal_'+k;
const CAL_FIELDS=[['cols','عدد الأعمدة'],['rows','عدد الصفوف'],['px','خطوة الأعمدة: من بداية ملصق لبداية اللي جنبه (مم)'],['py','خطوة الصفوف: من بداية ملصق لبداية اللي تحته (مم)'],
  ['left','الهامش الأيسر للصفحة (مم)'],['top','الهامش العلوي للصفحة (مم)'],['dx','إزاحة أفقية للطباعة كلها (مم، + يمين)'],['dy','إزاحة رأسية للطباعة كلها (مم، + لتحت)']];
const FILL={s:{cols:4,rows:10},m:{cols:4,rows:4},l:{cols:2,rows:4}};   // «A4 كامل بدون هوامش»: شيتات 52.5×29.7 و52.5×74.25 و105×74.25 (توزيع الصفحة على الصفوف والأعمدة بالتساوي)

export function loadCal(key){try{const o=JSON.parse(localStorage.getItem(CAL_KEY(key))||'null');return o&&typeof o==='object'?o:{}}catch{return{}}}
export function saveCal(key,c){try{localStorage.setItem(CAL_KEY(key),JSON.stringify(c))}catch{}}
export function resetCal(key){try{localStorage.removeItem(CAL_KEY(key))}catch{}}
const num=(v,lo,hi,d)=>{const n=Number(v);return v!=null&&v!==''&&Number.isFinite(n)?Math.min(hi,Math.max(lo,n)):d};
const r1=n=>Math.round(n*100)/100;

// شبكة الملصقات على A4 (210×297 مم) لكل مقاس. الافتراضي: ملصق بمقاسه الاسمي من غير فواصل، والشبكة في نص الصفحة (أقصى عدد أعمدة/صفوف يدخل بهامش 5مم).
// كل قيمة تتغيّر من «ضبط الورق». ‏cal اختياري (للاختبار) وإلا بتتقرا من localStorage.
export function sheetGrid(key,cal){
  const S=SIZES[key],c=cal||loadCal(key);
  const dc=Math.max(1,Math.floor((A4W-2*MARGIN)/S.w)),dr=Math.max(1,Math.floor((A4H-2*MARGIN)/S.h));
  const cols=Math.round(num(c.cols,1,20,dc)),rows=Math.round(num(c.rows,1,40,dr));
  const px=num(c.px,10,A4W,S.w),py=num(c.py,10,A4H,S.h);                       // خطوة الشبكة (الملصق + الفاصل)
  const left=num(c.left,-50,A4W,(A4W-cols*px)/2),top=num(c.top,-50,A4H,(A4H-rows*py)/2);
  const dx=num(c.dx,-20,20,0),dy=num(c.dy,-20,20,0),x0=left+dx,y0=top+dy;
  const cw=Math.min(S.w,px),ch=Math.min(S.h,py);                               // مساحة الملصق الفعلية (مش بتزيد عن الخطوة)
  const right=x0+cols*px,bottom=y0+rows*py,warn=[];
  if(x0<-.01||y0<-.01||right>A4W+.01||bottom>A4H+.01)warn.push('الشبكة بتخرج برّه ورقة A4 — راجع الأعمدة/الصفوف والمسافات في «ضبط الورق».');
  else if(x0<SAFE||y0<SAFE||A4W-right<SAFE||A4H-bottom<SAFE)warn.push(`الصفوف/الأعمدة الطرفية أقرب من ${SAFE} مم لحافة الورقة — الطابعة الليزر ممكن تقص الحافة دي (الـQR والكود ممكن يتقطعوا).`);
  return{S,cols,rows,per:cols*rows,px,py,left,top,dx,dy,x0,y0,cw,ch,warn};
}
const TEST_CSS=`.tst{box-sizing:border-box;border:.25mm solid #000;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:Arial,Tahoma,sans-serif;font-size:3mm;line-height:1.25;color:#000;background:linear-gradient(#000,#000) center/100% .1mm no-repeat,linear-gradient(#000,#000) center/.1mm 100% no-repeat}.tst b{background:#fff;padding:0 1mm}.tst span{background:#fff;padding:0 1mm}`;
const testCell=(g,i)=>`<div class="tst" style="width:${r1(g.cw)}mm;height:${r1(g.ch)}mm"><b>${i}</b><span>${r1(g.cw)}×${r1(g.ch)}</span></div>`;
// items: [{p,n}] — بيرجّع مستند HTML كامل (كل صفحة A4 فيها شبكة الملصقات) + عدد الصفحات والإجمالي. الـQR بيتولّد مرة لكل صنف وبيتكرر.
// test:true = ورقة اختبار (مربعات فاضية بأرقام وعلامة + في النص) بنفس الشبكة بالظبط. guides = خطوط رفيعة حوالين كل خانة (للورق العادي بس — على الاستيكر بتتطبع على الاستيكر نفسه).
export function sheetsHtml(items,key,{guides=false,test=false}={}){
  const g=sheetGrid(key),cells=[];
  if(test){for(let i=1;i<=g.per;i++)cells.push(testCell(g,i))}
  else for(const {p,n} of items){const h=labelHtml(p,key,{w:g.cw,h:g.ch});for(let i=0;i<n;i++)cells.push(h)}
  const pages=[];for(let i=0;i<cells.length;i+=g.per)pages.push(cells.slice(i,i+g.per));
  const css=`@page{size:210mm 297mm;margin:0}html,body{margin:0;padding:0;background:#fff}.pg{position:relative;box-sizing:border-box;width:210mm;height:${PG_H}mm;overflow:hidden;page-break-after:always;break-after:page}.pg:last-child{page-break-after:auto;break-after:auto}`+
    `.gr{position:absolute;left:${r1(g.x0)}mm;top:${r1(g.y0)}mm;display:grid;grid-template-columns:repeat(${g.cols},${r1(g.px)}mm);grid-template-rows:repeat(${g.rows},${r1(g.py)}mm);direction:ltr}`+
    `.cell{box-sizing:border-box;width:${r1(g.px)}mm;height:${r1(g.py)}mm;display:flex;align-items:center;justify-content:center;overflow:hidden${guides?';outline:.1mm solid #b5b5b5;outline-offset:-.1mm':''}}${LABEL_CSS}${TEST_CSS}`;
  const body=pages.map(pg=>`<div class="pg"><div class="gr">${pg.map(c=>`<div class="cell">${c}</div>`).join('')}</div></div>`).join('');
  return{html:`<!doctype html><html><head><meta charset="utf-8"><title>${test?'ورقة اختبار':'ملصقات QR'}</title><style>${css}</style></head><body>${body}</body></html>`,pages:pages.length,total:cells.length,...g};
}
// v23.3: المعاينة بتبني أول صفحة بس (قبل كده كانت بتبني HTML كل الصفحات — لحد 1500 ملصق — عشان تعرض صفحة واحدة)
export const firstPage=(items,per)=>{const out=[];let left=per;for(const x of items){if(left<=0)break;const n=Math.min(x.n,left);out.push({p:x.p,n});left-=n}return out};
function printHtml(html){
  const f=document.createElement('iframe');
  f.setAttribute('aria-hidden','true');f.style.cssText='position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0';
  document.body.appendChild(f);
  const d=f.contentDocument;d.open();d.write(html);d.close();
  setTimeout(()=>{try{f.contentWindow.focus();f.contentWindow.print()}catch(e){toast('تعذرت الطباعة: '+(e.message||''))}setTimeout(()=>f.remove(),120000)},400);
}
const clampN=v=>Math.max(0,Math.min(MAX_PER,Math.floor(Number(v)||0)));
const hasCode=p=>String(p.Code??'').trim()!=='';

import {makeDraft} from './session.js';
export async function showBulkLabels(user,onBack){
  if(!await can(user,'ViewProducts')){toast('مفيش صلاحية لعرض المنتجات');onBack();return}
  const canStock=await can(user,'ViewStock');
  const prods=(await all('products')).filter(p=>!p.Deleted&&p.Active!==false).sort((a,b)=>(a.SourceRow??1e9)-(b.SourceRow??1e9));
  const whs=(await all('warehouses')).filter(w=>w.Active!==false);
  const sm=canStock?await stockMap():new Map();
  const byId=new Map(prods.map(p=>[p.ProductID,p]));
  prods.forEach(p=>{p._hay=norm((p.Name||'')+' '+(p.Category||'')+' '+(p.Code??''));p._code=compact(p.Code)});
  const cats=[...new Set(prods.map(p=>p.Category).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ar'));
  let key=localStorage.getItem('alr_qr_size');if(!SIZES[key])key='m';
  const S={q:'',cat:'',onlyStock:false,onlySel:false,wh:'',mode:'one',guides:false,shown:PAGE};
  const sel=new Set(),cnt=new Map(prods.map(p=>[p.ProductID,1]));
  // v23.6: مسودة التحديد (على الجهاز): الأصناف المحددة وعدد ملصقات كل صنف ووضع العدد والمخزن. بتتحفظ بعد كل تغيير ولحظة القفل. (مقاس الورق وضبطه محفوظين لوحدهم في localStorage)
  const draft=makeDraft(`qr:${user.UserID}`,()=>({sel:[...sel],cnt:[...sel].map(id=>[id,cnt.get(id)??1]),mode:S.mode,wh:S.wh}));
  let restored=false;
  {const dr=await draft.load();
    if(dr&&Array.isArray(dr.sel)&&dr.sel.length){
      if(['one','manual'].includes(dr.mode)||(canStock&&['pieces','cartons'].includes(dr.mode)))S.mode=dr.mode;
      if(canStock&&dr.wh&&whs.some(w=>w.WarehouseID===dr.wh))S.wh=dr.wh;
      for(const id of dr.sel){const p=byId.get(id);if(p&&hasCode(p))sel.add(id)}
      for(const [id,n] of dr.cnt||[])if(sel.has(id))cnt.set(id,clampN(n));
      restored=sel.size>0;
    }}
  const stockOf=p=>{const o=sm.get(p.ProductID)||{};return S.wh?(o[S.wh]||0):Object.values(o).reduce((a,b)=>a+b,0)};
  const autoCount=p=>{const s=stockOf(p);
    if(S.mode==='one')return 1;
    if(S.mode==='pieces')return clampN(s);
    if(S.mode==='cartons')return p.PcsPerCarton>0?clampN(Math.floor(s/p.PcsPerCarton)):0;
    return cnt.get(p.ProductID)??1};
  function applyMode(){
    if(S.mode==='manual')return;
    cnt.clear();for(const p of prods)cnt.set(p.ProductID,autoCount(p));
    if(S.mode!=='one'){sel.clear();for(const p of prods)if(hasCode(p)&&cnt.get(p.ProductID)>0)sel.add(p.ProductID)}   // حسب الرصيد: بنحدّد تلقائياً كل اللي ليه عدد
  }
  function filtered(){
    const toks=norm(S.q).split(' ').filter(Boolean);
    return prods.filter(p=>(!S.cat||p.Category===S.cat)&&(!S.onlyStock||stockOf(p)>0)&&(!S.onlySel||sel.has(p.ProductID))
      &&toks.every(k=>p._hay.includes(k)||p._code.includes(compact(k))));
  }
  const printItems=()=>[...sel].map(id=>byId.get(id)).filter(p=>p&&hasCode(p)).map(p=>({p,n:clampN(cnt.get(p.ProductID))})).filter(x=>x.n>0);

  const list=el('div',{}),summary=el('div',{class:'ssum'}),info=el('p',{class:'note'}),moreBtn=el('button',{class:'btn ghost',type:'button',onclick:()=>{S.shown+=PAGE;renderRows()}},'عرض المزيد');
  const prevBox=el('div',{});
  const printBtn=el('button',{class:'btn',type:'button',onclick:()=>doPrint()},'🖨️ طباعة');
  const prevBtn=el('button',{class:'btn ghost',type:'button',onclick:()=>doPreview()},'👁 معاينة الصفحة الأولى');
  const sizeRow=el('div',{class:'btnrow qrsizes'});
  const calBox=el('details',{class:'calbox',style:'margin:10px 0'});

  function renderSummary(){
    const items=printItems(),total=items.reduce((s,x)=>s+x.n,0),g=sheetGrid(key),pages=Math.ceil(total/g.per);
    const over=total>MAX_TOTAL;
    draft.touch();
    summary.textContent=`${fmt(sel.size)} صنف محدد · ${fmt(total)} ملصق · ${fmt(pages)} صفحة A4 (${g.cols}×${g.rows} = ${fmt(g.per)} ملصق في الصفحة)`;
    info.textContent=over?`الإجمالي أكبر من ${fmt(MAX_TOTAL)} ملصق — قلّل الأعداد أو اطبع على دفعات.`:g.warn.join(' ');
    info.className=over?'err':g.warn.length?'editwarn':'note';
    printBtn.disabled=!total||over;prevBtn.disabled=!total||over;
  }
  function afterCal(){prevBox.replaceChildren();renderSizes();drawCal();renderSummary()}
  function renderSizes(){
    sizeRow.replaceChildren(...Object.entries(SIZES).map(([k,s])=>{
      const g=sheetGrid(k),b=el('button',{class:'btn ghost'+(k===key?' on':''),type:'button',onclick:()=>{key=k;localStorage.setItem('alr_qr_size',k);prevBox.replaceChildren();renderSizes();drawCal();renderSummary()}},`${s.name} (${g.per}/صفحة)`);
      b.setAttribute('aria-pressed',String(k===key));return b}));
  }
  // «ضبط الورق»: كل مقاس له ضبطه (بيتحفظ على الجهاز). الخانة الفاضية = القيمة التلقائية (ظاهرة رمادي). بيتطبق على المعاينة والطباعة وورقة الاختبار.
  function drawCal(){
    const cal=loadCal(key),g=sheetGrid(key),eff={cols:g.cols,rows:g.rows,px:g.px,py:g.py,left:g.left,top:g.top,dx:g.dx,dy:g.dy},open=calBox.open;
    const fields=CAL_FIELDS.map(([f,label])=>{
      const i=el('input',{type:'number',step:f==='cols'||f==='rows'?'1':'0.1',inputmode:'decimal',dir:'ltr','aria-label':label,style:'width:100%',placeholder:String(r1(eff[f]))});
      i.value=cal[f]!=null&&cal[f]!==''?String(cal[f]):'';
      i.addEventListener('change',()=>{const c=loadCal(key);if(i.value.trim()==='')delete c[f];else c[f]=Number(i.value);saveCal(key,c);afterCal()});
      return el('label',{class:'field'},el('span',{},label),i)});
    const fillBtn=el('button',{class:'btn ghost',type:'button',onclick:()=>{const f=FILL[key];saveCal(key,{cols:f.cols,rows:f.rows,px:r1(A4W/f.cols),py:r1(A4H/f.rows),left:0,top:0});afterCal()}},'ملء A4 كامل (بدون هوامش)');
    const resetBtn=el('button',{class:'btn ghost',type:'button',onclick:()=>{resetCal(key);afterCal()}},'رجوع للافتراضي');
    const testBtn=el('button',{class:'btn',type:'button',onclick:()=>{printHtml(sheetsHtml([],key,{test:true}).html);toast('اطبع ورقة الاختبار على ورق عادي A4 بتحجيم 100% وبدون هوامش')}},'📐 طباعة ورقة اختبار');
    calBox.replaceChildren(el('summary',{style:'cursor:pointer;font-weight:700'},`⚙ ضبط الورق — ${SIZES[key].name}`),
      el('p',{class:'note'},'لو الطباعة مش مظبوطة على مربعات الاستيكر: اطبع «ورقة الاختبار» على ورق عادي وحطها فوق شيت الاستيكر قصاد الضوء، وظبّط الإزاحة أو الخطوة لحد ما المربعات تنطبق. الخانة الفاضية = تلقائي.'),
      el('div',{style:'display:grid;grid-template-columns:1fr 1fr;gap:6px 10px'},...fields),
      el('div',{class:'btnrow'},testBtn,fillBtn,resetBtn),
      el('p',{class:'note'},`الحالي: ${g.cols}×${g.rows} · خطوة ${r1(g.px)}×${r1(g.py)} مم · أول ملصق عند (${r1(g.x0)} ، ${r1(g.y0)}) مم · الملصق نفسه ${r1(g.cw)}×${r1(g.ch)} مم.`));
    calBox.open=open;
  }
  function row(p){
    const id=p.ProductID,nc=!hasCode(p),ck=el('input',{type:'checkbox','aria-label':'تحديد '+(p.Name||p.Code)}),num=el('input',{type:'number',min:'0',max:String(MAX_PER),inputmode:'numeric','aria-label':'عدد الملصقات',style:'width:72px'});
    ck.checked=sel.has(id);ck.disabled=nc;num.value=String(cnt.get(id)??1);num.disabled=nc;
    ck.addEventListener('change',()=>{ck.checked?sel.add(id):sel.delete(id);renderSummary()});
    num.addEventListener('input',()=>{cnt.set(id,clampN(num.value));if(S.mode!=='manual'){S.mode='manual';modeSel.value='manual'}renderSummary()});
    const s=canStock?stockOf(p):null,k=p.PcsPerCarton>0&&s!=null?Math.floor(s/p.PcsPerCarton):null;
    return el('label',{style:'display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #e3e7ec'},ck,
      el('span',{style:'flex:1;min-width:0'},el('b',{dir:'auto',style:'display:block;overflow-wrap:anywhere'},p.Name||'(بدون اسم)'),
        el('small',{dir:'auto',style:'display:block'},nc?'⚠ بدون كود — مش هيتطبع':`${p.Code}${p.Category?' · '+p.Category:''}`+(s!=null?` · رصيد ${fmt(s)}${k!=null?` (≈${fmt(k)} كرتونة)`:''}`:''))),num);
  }
  function renderRows(){
    const r=filtered();
    list.replaceChildren(...(r.length?r.slice(0,S.shown).map(row):[el('p',{class:'empty'},'مفيش أصناف مطابقة')]));
    moreBtn.hidden=r.length<=S.shown;
    count.textContent=`${fmt(r.length)} صنف ظاهر من ${fmt(prods.length)}`;
  }
  const count=el('div',{class:'pcount'});
  const search=el('input',{type:'search',class:'psearch',placeholder:'ابحث بالاسم أو الكود…',autocomplete:'off','aria-label':'بحث'});
  let t;search.addEventListener('input',()=>{clearTimeout(t);t=setTimeout(()=>{S.q=search.value;S.shown=PAGE;renderRows()},120)});
  const catSel=el('select',{'aria-label':'القسم',onchange:e=>{S.cat=e.target.value;S.shown=PAGE;renderRows()}},el('option',{value:''},'كل الأقسام'),...cats.map(c=>el('option',{value:c},c)));
  const whSel=el('select',{'aria-label':'المخزن',onchange:e=>{S.wh=e.target.value;applyMode();S.shown=PAGE;renderRows();renderSummary()}},el('option',{value:''},'كل المخازن'),...whs.map(w=>el('option',{value:w.WarehouseID},w.Name)));
  const modeSel=el('select',{'aria-label':'عدد الملصقات',onchange:e=>{S.mode=e.target.value;applyMode();S.shown=PAGE;renderRows();renderSummary()}},
    el('option',{value:'one'},'نسخة واحدة لكل صنف'),canStock&&el('option',{value:'pieces'},'حسب الرصيد (ملصق لكل قطعة)'),canStock&&el('option',{value:'cartons'},'حسب الرصيد بالكراتين (ملصق لكل كرتونة)'),el('option',{value:'manual'},'يدوي (من الجدول)'));
  const chk=(txt,fn)=>{const i=el('input',{type:'checkbox'});i.addEventListener('change',()=>fn(i.checked));return el('label',{class:'chk'},i,txt)};
  const guidesChk=chk('خطوط حوالين الخانات (للورق العادي بس)',v=>{S.guides=v;prevBox.replaceChildren()});

  function doPreview(){
    const items=printItems();if(!items.length)return;
    try{
      const g0=sheetGrid(key),all=items.reduce((s,x)=>s+x.n,0),pagesAll=Math.ceil(all/g0.per);
      const r=sheetsHtml(firstPage(items,g0.per),key,{guides:S.guides}),sc=Math.min(.55,(Math.min(innerWidth,520)-40)/794),w=Math.round(794*sc),h=Math.round(1123*sc);
      const fr=document.createElement('iframe');fr.setAttribute('title','معاينة الصفحة الأولى');fr.style.cssText=`width:210mm;height:297mm;border:0;transform:scale(${sc});transform-origin:0 0;pointer-events:none;background:#fff`;fr.srcdoc=r.html;
      prevBox.replaceChildren(el('div',{style:`width:${w}px;height:${h}px;overflow:hidden;margin:8px auto;border:1px solid #cbd5e1;background:#fff;direction:ltr`},fr),
        el('p',{class:'note'},`معاينة الصفحة الأولى من ${fmt(pagesAll)} — شكل الطباعة الفعلي ممكن يختلف بسيط حسب الطابعة.`));
    }catch(e){toast(e.message||'تعذر عمل المعاينة')}
  }
  async function doPrint(){
    const items=printItems();if(!items.length)return;
    printBtn.disabled=true;const old=printBtn.textContent;printBtn.textContent='جاري تجهيز الملصقات…';
    await new Promise(r=>setTimeout(r,40));
    try{const r=sheetsHtml(items,key,{guides:S.guides});printHtml(r.html);toast(`تم تجهيز ${fmt(r.total)} ملصق في ${fmt(r.pages)} صفحة — اختار الطابعة وورق A4 والتحجيم 100% (Actual size) والهوامش «بدون»`)}
    catch(e){toast(e.message||'تعذر تجهيز الملصقات')}
    printBtn.textContent=old;renderSummary();
  }

  const noCode=prods.filter(p=>!hasCode(p)).length;
  $('#app').replaceChildren(el('div',{class:'wrap'},
    el('div',{class:'hello'},el('h2',{},'🖨️ طباعة ملصقات مجمّعة'),el('button',{class:'btn ghost',type:'button',onclick:onBack},'رجوع')),
    restored&&el('p',{class:'editwarn'},'اتسترجع تحديد الملصقات اللي كنت شغال عليه — «إلغاء التحديد» بيمسحه.'),
    el('p',{class:'note'},'حدّد الأصناف وعدد الملصقات لكل صنف، وهيترصّوا تلقائياً على صفحات A4 (الـQR فوق، تحته اسم الصنف وبعده الكود بخط كبير). الـQR هو كود الصنف نفسه فالكاميرا بتقراه زي الملصق العادي.'),
    el('p',{class:'note'},'عند الطباعة: ورق A4 · التحجيم 100% (Actual size / مش «Fit to page») · الهوامش «بدون» · من غير رأس وتذييل. وللاستيكر المقطّع: الطابعة على درج الورق اليدوي ونوع الورق «Labels/سميك».'),
    el('label',{class:'field'},el('span',{},'عدد الملصقات'),modeSel),
    canStock&&el('label',{class:'field'},el('span',{},'المخزن (للحساب حسب الرصيد)'),whSel),
    el('div',{class:'field'},el('span',{},'مقاس الملصق'),sizeRow),
    calBox,
    search,el('div',{class:'filters'},catSel,canStock&&chk('اللي ليه رصيد بس',v=>{S.onlyStock=v;S.shown=PAGE;renderRows()}),chk('المحدد بس',v=>{S.onlySel=v;S.shown=PAGE;renderRows()}),guidesChk),
    el('div',{class:'btnrow'},
      el('button',{class:'btn ghost',type:'button',onclick:()=>{for(const p of filtered())if(hasCode(p))sel.add(p.ProductID);renderRows();renderSummary()}},'تحديد كل الظاهر'),
      el('button',{class:'btn ghost',type:'button',onclick:()=>{sel.clear();renderRows();renderSummary()}},'إلغاء التحديد')),
    noCode>0&&el('p',{class:'note'},`${fmt(noCode)} صنف بدون كود مش هيتطبعوا (اكتب لهم كود الأول من «تعديل الصنف»).`),
    summary,info,el('div',{class:'btnrow act'},printBtn,prevBtn),prevBox,count,list,el('div',{class:'morewrap'},moreBtn)));
  modeSel.value=S.mode;if(canStock)whSel.value=S.wh;
  renderSizes();drawCal();renderRows();renderSummary();draft.arm();
}
