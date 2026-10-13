// طباعة ملصقات QR مجمّعة (v20): جدول بكل الأصناف + عدد الملصقات لكل صنف (نسخة / حسب الرصيد بالقطعة / حسب الرصيد بالكراتين / يدوي)
// وبترصّها تلقائياً على صفحات A4 (اسم الصنف + الكود + QR) وتطبعها بضغطة واحدة من المتصفح. الـQR نفسه من qrlabel.js (نفس المحتوى ALIRAQI-PRODUCT-<الكود>)
// فالمسح بالكاميرا بيشتغل زي الملصق الفردي بالظبط. مفيش حاجة بتتكتب في قاعدة البيانات: الشاشة دي قراءة + طباعة بس.
import {all,stockMap} from './db.js';
import {can} from './auth.js';
import {norm,compact} from './products.js';
import {labelHtml,LABEL_CSS,SIZES} from './qrlabel.js';
import {$,el,toast,fmt} from './ui.js';

const MAX_PER=200,MAX_TOTAL=1500,MARGIN=5,PAGE=60;      // أقصى نسخ للصنف / أقصى ملصقات في الطباعة الواحدة / هامش الصفحة (مم)

// شبكة الملصقات على A4 (210×297 مم) لكل مقاس
export function sheetGrid(key){
  const S=SIZES[key],cols=Math.max(1,Math.floor((210-2*MARGIN)/S.w)),rows=Math.max(1,Math.floor((297-2*MARGIN)/S.h));
  return{S,cols,rows,per:cols*rows};
}
// items: [{p,n}] — بيرجّع مستند HTML كامل (كل صفحة A4 فيها شبكة الملصقات) + عدد الصفحات والإجمالي. الـQR بيتولّد مرة لكل صنف وبيتكرر.
export function sheetsHtml(items,key,{guides=true}={}){
  const g=sheetGrid(key),cells=[];
  for(const {p,n} of items){const h=labelHtml(p,key);for(let i=0;i<n;i++)cells.push(h)}
  const pages=[];for(let i=0;i<cells.length;i+=g.per)pages.push(cells.slice(i,i+g.per));
  const top=Math.max(0,(297-g.rows*g.S.h)/2);
  const css=`@page{size:A4;margin:0}html,body{margin:0;padding:0;background:#fff}.pg{box-sizing:border-box;width:210mm;height:297mm;padding-top:${top}mm;page-break-after:always;break-after:page;overflow:hidden}.pg:last-child{page-break-after:auto;break-after:auto}`+
    `.gr{display:grid;grid-template-columns:repeat(${g.cols},${g.S.w}mm);grid-auto-rows:${g.S.h}mm;justify-content:center;direction:ltr}.cell{box-sizing:border-box;width:${g.S.w}mm;height:${g.S.h}mm;overflow:hidden${guides?';outline:.1mm solid #b5b5b5;outline-offset:-.1mm':''}}${LABEL_CSS}`;
  const body=pages.map(pg=>`<div class="pg"><div class="gr">${pg.map(c=>`<div class="cell">${c}</div>`).join('')}</div></div>`).join('');
  return{html:`<!doctype html><html><head><meta charset="utf-8"><title>ملصقات QR</title><style>${css}</style></head><body>${body}</body></html>`,pages:pages.length,total:cells.length,...g};
}
function printHtml(html){
  const f=document.createElement('iframe');
  f.setAttribute('aria-hidden','true');f.style.cssText='position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0';
  document.body.appendChild(f);
  const d=f.contentDocument;d.open();d.write(html);d.close();
  setTimeout(()=>{try{f.contentWindow.focus();f.contentWindow.print()}catch(e){toast('تعذرت الطباعة: '+(e.message||''))}setTimeout(()=>f.remove(),120000)},400);
}
const clampN=v=>Math.max(0,Math.min(MAX_PER,Math.floor(Number(v)||0)));
const hasCode=p=>String(p.Code??'').trim()!=='';

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
  const S={q:'',cat:'',onlyStock:false,onlySel:false,wh:'',mode:'one',guides:true,shown:PAGE};
  const sel=new Set(),cnt=new Map(prods.map(p=>[p.ProductID,1]));
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

  function renderSummary(){
    const items=printItems(),total=items.reduce((s,x)=>s+x.n,0),g=sheetGrid(key),pages=Math.ceil(total/g.per);
    const over=total>MAX_TOTAL;
    summary.textContent=`${fmt(sel.size)} صنف محدد · ${fmt(total)} ملصق · ${fmt(pages)} صفحة A4 (${g.cols}×${g.rows} = ${fmt(g.per)} ملصق في الصفحة)`;
    info.textContent=over?`الإجمالي أكبر من ${fmt(MAX_TOTAL)} ملصق — قلّل الأعداد أو اطبع على دفعات.`:'';
    info.className=over?'err':'note';
    printBtn.disabled=!total||over;prevBtn.disabled=!total||over;
  }
  function renderSizes(){
    sizeRow.replaceChildren(...Object.entries(SIZES).map(([k,s])=>{
      const g=sheetGrid(k),b=el('button',{class:'btn ghost'+(k===key?' on':''),type:'button',onclick:()=>{key=k;localStorage.setItem('alr_qr_size',k);prevBox.replaceChildren();renderSizes();renderSummary()}},`${s.name} (${g.per}/صفحة)`);
      b.setAttribute('aria-pressed',String(k===key));return b}));
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
  const guidesChk=chk('خطوط قص رفيعة',v=>{S.guides=v;prevBox.replaceChildren()});
  guidesChk.querySelector('input').checked=true;

  function doPreview(){
    const items=printItems();if(!items.length)return;
    try{
      const r=sheetsHtml(items,key,{guides:S.guides}),sc=Math.min(.55,(Math.min(innerWidth,520)-40)/794),w=Math.round(794*sc),h=Math.round(1123*sc);
      const fr=document.createElement('iframe');fr.setAttribute('title','معاينة الصفحة الأولى');fr.style.cssText=`width:210mm;height:297mm;border:0;transform:scale(${sc});transform-origin:0 0;pointer-events:none;background:#fff`;fr.srcdoc=r.html;
      prevBox.replaceChildren(el('div',{style:`width:${w}px;height:${h}px;overflow:hidden;margin:8px auto;border:1px solid #cbd5e1;background:#fff;direction:ltr`},fr),
        el('p',{class:'note'},`معاينة الصفحة الأولى من ${fmt(r.pages)} — شكل الطباعة الفعلي ممكن يختلف بسيط حسب الطابعة.`));
    }catch(e){toast(e.message||'تعذر عمل المعاينة')}
  }
  async function doPrint(){
    const items=printItems();if(!items.length)return;
    printBtn.disabled=true;const old=printBtn.textContent;printBtn.textContent='جاري تجهيز الملصقات…';
    await new Promise(r=>setTimeout(r,40));
    try{const r=sheetsHtml(items,key,{guides:S.guides});printHtml(r.html);toast(`تم تجهيز ${fmt(r.total)} ملصق في ${fmt(r.pages)} صفحة — اختار الطابعة وحجم الورق A4 وبدون هوامش`)}
    catch(e){toast(e.message||'تعذر تجهيز الملصقات')}
    printBtn.textContent=old;renderSummary();
  }

  const noCode=prods.filter(p=>!hasCode(p)).length;
  $('#app').replaceChildren(el('div',{class:'wrap'},
    el('div',{class:'hello'},el('h2',{},'🖨️ طباعة ملصقات مجمّعة'),el('button',{class:'btn ghost',type:'button',onclick:onBack},'رجوع')),
    el('p',{class:'note'},'حدّد الأصناف وعدد الملصقات لكل صنف، وهيترصّوا تلقائياً على صفحات A4 (اسم الصنف + الكود + QR). الـQR هو كود الصنف نفسه فالكاميرا بتقراه زي الملصق العادي.'),
    el('label',{class:'field'},el('span',{},'عدد الملصقات'),modeSel),
    canStock&&el('label',{class:'field'},el('span',{},'المخزن (للحساب حسب الرصيد)'),whSel),
    el('div',{class:'field'},el('span',{},'مقاس الملصق'),sizeRow),
    search,el('div',{class:'filters'},catSel,canStock&&chk('اللي ليه رصيد بس',v=>{S.onlyStock=v;S.shown=PAGE;renderRows()}),chk('المحدد بس',v=>{S.onlySel=v;S.shown=PAGE;renderRows()}),guidesChk),
    el('div',{class:'btnrow'},
      el('button',{class:'btn ghost',type:'button',onclick:()=>{for(const p of filtered())if(hasCode(p))sel.add(p.ProductID);renderRows();renderSummary()}},'تحديد كل الظاهر'),
      el('button',{class:'btn ghost',type:'button',onclick:()=>{sel.clear();renderRows();renderSummary()}},'إلغاء التحديد')),
    noCode>0&&el('p',{class:'note'},`${fmt(noCode)} صنف بدون كود مش هيتطبعوا (اكتب لهم كود الأول من «تعديل الصنف»).`),
    summary,info,el('div',{class:'btnrow act'},printBtn,prevBtn),prevBox,count,list,el('div',{class:'morewrap'},moreBtn)));
  renderSizes();renderRows();renderSummary();
}
