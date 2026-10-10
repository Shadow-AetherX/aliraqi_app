import {all,postStockDoc,stockMap,toPieces,pickWarehouse} from './db.js';
import {postTransfer} from './transfers.js';
import {transferPanel} from './transfer-pdf.js';
import {can} from './auth.js';
import {norm,compact} from './products.js';
import {$,el,toast,fmt} from './ui.js';
import {openScanner,scannerSupport} from './scanner.js';

const T={IN:{type:'STOCK_IN',title:'استلام مخزون',en:'STOCK IN',btn:'تأكيد الاستلام',ok:'تم تسجيل الاستلام'},
         OUT:{type:'STOCK_OUT',title:'صرف من المخزن',en:'STOCK OUT',btn:'تأكيد الصرف',ok:'تم تسجيل الصرف'},
         TR:{type:'TRANSFER',title:'نقل بين المخازن',en:'STOCK TRANSFER',btn:'تأكيد التحويل',ok:'تم تسجيل التحويل'}};
// محتوى الـ QR = كود الصنف بس (مع بادئة اختيارية). مفيش سعر ولا رصيد جواه.
const parseScan=s=>String(s).trim().replace(/^ALIRAQI-PRODUCT-/i,'');

export async function showStockDoc(user,kind,onBack){
  const cfg=T[kind];
  const prods=(await all('products')).filter(p=>p.Active!==false).sort((a,b)=>a.SourceRow-b.SourceRow);
  prods.forEach(p=>{p._hay=norm(p.Name+' '+p.Category+' '+p.Code);p._code=compact(p.Code)});
  const byId=new Map(prods.map(p=>[p.ProductID,p]));
  const whs=(await all('warehouses')).filter(w=>w.Active);
  const checks=kind!=='IN',canOverride=checks&&await can(user,'OverrideStock');   // الصرف والتحويل بيتفحصوا على رصيد المخزن المصدر
  let stock=await stockMap();
  const lines=new Map();                       // productId -> {cartons,pieces}
  let scanUnit='carton',busy=false;

  const lastWh=pickWarehouse(whs),hasLast=!!lastWh;                      // المخزن الافتراضي أولاً، ثم آخر مخزن اتستخدم
  const whSel=el('select',{'aria-label':kind==='TR'?'من مخزن':'المخزن',onchange:()=>{if(whSel.value)localStorage.setItem('alr_last_wh',whSel.value);drawTo();updateTotals()}},
    !hasLast&&el('option',{value:''},'اختر المخزن…'),whs.map(w=>el('option',{value:w.WarehouseID},w.Name)));
  if(hasLast)whSel.value=lastWh;
  const toSel=kind==='TR'?el('select',{'aria-label':'إلى مخزن',onchange:()=>updateTotals()}):null;   // مخزن الوجهة (مفيش اختيار تلقائي، ومش بيظهر فيه المخزن المصدر)
  function drawTo(){
    if(!toSel)return;const keep=toSel.value;
    toSel.replaceChildren(el('option',{value:''},'اختر مخزن الوجهة…'),...whs.filter(w=>w.WarehouseID!==whSel.value).map(w=>el('option',{value:w.WarehouseID},w.Name)));
    toSel.value=[...toSel.options].some(o=>o.value===keep)?keep:'';
  }
  drawTo();
  const note=el('input',{type:'text',maxlength:'120',placeholder:kind==='IN'?'رقم الحاوية / الشحنة (اختياري)':'ملاحظة (اختياري)','aria-label':'ملاحظة'});
  const q=el('input',{type:'search',class:'psearch',placeholder:'اكتب الكود أو الاسم… أو امسح الباركود',autocomplete:'off',enterkeyhint:'done','aria-label':'إضافة صنف'});
  const results=el('div',{class:'results'}),linesBox=el('div',{class:'slines'}),summary=el('div',{class:'ssum'}),msg=el('p',{class:'err'});
  const override=el('input',{type:'checkbox'});const ovWrap=canOverride?el('label',{class:'chk warnbox'},override,'تجاوز الرصيد (صلاحية خاصة)'):null;
  const confirmBtn=el('button',{class:'btn',onclick:confirm},cfg.btn);

  const avail=p=>((stock.get(p.ProductID)||{})[whSel.value])||0;
  const totalPieces=(p,l)=>toPieces(l.cartons,l.pieces,p.PcsPerCarton||0);

  function add(p,dc=0,dp=0){
    const l=lines.get(p.ProductID)||{cartons:0,pieces:0};
    l.cartons+=dc;l.pieces+=dp;lines.set(p.ProductID,l);
    q.value='';results.replaceChildren();renderLines();
  }
  function addFromScanText(text){
    const c=compact(parseScan(text));if(!c)return null;
    const hits=prods.filter(p=>p._code===c);
    if(hits.length===1){const p=hits[0];scanUnit==='carton'&&p.PcsPerCarton?add(p,1,0):add(p,0,1);return p}
    if(hits.length>1){showPicker(hits);return hits}
    return null;
  }
  function showPicker(list){
    results.replaceChildren(...list.slice(0,8).map(p=>el('button',{class:'rbtn',type:'button',onclick:()=>(scanUnit==='carton'&&p.PcsPerCarton?add(p,1,0):add(p,0,1))},
      el('b',{},p.Name||'(بدون اسم)'),el('span',{dir:'ltr',class:'code'},p.Code),el('small',{},p.Category),
      el('small',{},checks?`الرصيد: ${fmt(avail(p))}`:`${fmt(p.PcsPerCarton)} قطعة/كرتونة`))));
  }
  function onType(){
    const toks=norm(q.value).split(' ').filter(Boolean);
    if(!toks.length){results.replaceChildren();return}
    const r=prods.filter(p=>toks.every(k=>p._hay.includes(k)||p._code.includes(compact(k))));
    const exact=compact(q.value);r.sort((a,b)=>(b._code===exact)-(a._code===exact));
    if(!r.length){results.replaceChildren(el('p',{class:'empty'},'مفيش صنف بالاسم/الكود ده'));return}
    showPicker(r);
  }
  let tm;q.addEventListener('input',()=>{clearTimeout(tm);tm=setTimeout(onType,100)});
  q.addEventListener('keydown',e=>{if(e.key!=='Enter')return;e.preventDefault();
    const c=compact(q.value),hits=prods.filter(p=>p._code===c);          // قارئ الباركود الخارجي بيكتب الكود + Enter
    if(hits.length===1)addFromScanText(q.value);else if(!hits.length&&results.firstChild?.classList?.contains('rbtn')&&results.children.length===1)results.firstChild.click();});

  const refs=new Map();
  // بناء القائمة (عند إضافة/حذف صنف فقط) — تعديل الكميات بيحدّث الأرقام في مكانها من غير ما يعيد البناء
  function buildLines(){
    refs.clear();const rows=[];
    for(const [id,l] of lines){
      const p=byId.get(id);
      const num=(key,dis)=>{const i=el('input',{type:'number',min:'0',step:'1',inputmode:'numeric',value:String(l[key]),disabled:dis,'aria-label':key==='cartons'?'كراتين':'قطع'});
        i.addEventListener('input',()=>{l[key]=Math.max(0,Math.floor(Number(i.value)||0));updateTotals()});
        i.addEventListener('focus',()=>i.select());return i};
      const tot=el('b',{}),stk=checks?el('small',{}):null;
      const root=el('div',{class:'sline'},
        el('div',{class:'slhead'},el('div',{},el('b',{},p.Name||'(بدون اسم)'),el('span',{class:'code',dir:'ltr'},' '+p.Code)),
          el('button',{class:'x',type:'button','aria-label':'حذف الصنف',onclick:()=>{lines.delete(id);renderLines()}},'✕')),
        el('div',{class:'slqty'},el('label',{},'كراتين',num('cartons',!p.PcsPerCarton)),el('label',{},'قطع',num('pieces',false)),
          el('div',{class:'sltot'},el('span',{},'الإجمالي'),tot)),
        !p.PcsPerCarton&&el('small',{class:'warn'},'عدد القطع في الكرتونة غير محدد — الإدخال بالقطعة فقط'),stk);
      refs.set(id,{p,l,tot,stk,root});rows.push(root);
    }
    linesBox.replaceChildren(...(rows.length?rows:[el('p',{class:'empty'},'لسه ما ضفتش أصناف')]));
  }
  function updateTotals(){
    msg.textContent='';let tp=0,bad=0;
    for(const {p,l,tot,stk,root} of refs.values()){
      const t=totalPieces(p,l);tp+=t;tot.textContent=fmt(t)+' قطعة';
      const over=checks&&t>avail(p);if(over)bad++;root.classList.toggle('over',over);
      if(stk){stk.textContent=`الرصيد في المخزن: ${fmt(avail(p))} قطعة`+(over?' — الكمية أكبر من الرصيد':'');stk.className=over?'warn':''}
    }
    summary.textContent=lines.size?`${fmt(lines.size)} صنف · ${fmt(tp)} قطعة`:'';
    confirmBtn.disabled=!lines.size||busy||!whSel.value||(toSel&&!toSel.value)||tp===0||!!(bad&&!(canOverride&&override.checked));
    if(ovWrap)ovWrap.hidden=!bad;
  }
  const renderLines=()=>{buildLines();updateTotals()};
  if(ovWrap)override.addEventListener('change',updateTotals);

  async function confirm(){
    if(busy||!lines.size||!whSel.value||(toSel&&!toSel.value))return;busy=true;confirmBtn.disabled=true;msg.textContent='';
    try{
      const ls=[];for(const[id,l] of lines){const t=totalPieces(byId.get(id),l);if(t>0)ls.push({productId:id,qtyPieces:t})}
      const pcs=ls.reduce((s,x)=>s+x.qtyPieces,0),fromName=whSel.selectedOptions[0].textContent;
      if(kind==='TR'){
        const toName=toSel.selectedOptions[0].textContent;
        const r=await postTransfer({fromId:whSel.value,toId:toSel.value,lines:ls,user,notes:note.value.trim(),allowNegative:canOverride&&override.checked});
        done(r.count,pcs,`من ${fromName} إلى ${toName}`,{number:r.number,doc:r.doc,names:{from:fromName,to:toName},
          lines:ls.map(x=>({Code:byId.get(x.productId).Code,Name:byId.get(x.productId).Name,Qty:x.qtyPieces}))});
      }else{
        const r=await postStockDoc({type:cfg.type,warehouseId:whSel.value,lines:ls,user,notes:note.value.trim(),allowNegative:canOverride&&override.checked});
        done(r.count,pcs,fromName);
      }
    }catch(e){
      busy=false;
      if(e.code==='INSUFFICIENT'){const p=byId.get(e.productId);msg.textContent=`الرصيد مش كفاية للصنف «${p?.Name}» — المتاح ${fmt(e.available)} والمطلوب ${fmt(e.requested)}. ما اتسجلش حاجة.`;stock=await stockMap()}
      else msg.textContent=typeof e.code==='string'?e.message:'تعذر الحفظ على الجهاز. حاول مرة تانية.';
      updateTotals();
    }
  }
  function done(n,pcs,whName,tr){
    $('#app').replaceChildren(el('div',{class:'wrap'},el('div',{class:'login done'},el('div',{class:'bigok'},'✅'),el('h1',{},cfg.ok),
      el('p',{},`${whName} · ${tr?tr.number+' · ':''}${fmt(n)} صنف · ${fmt(pcs)} قطعة — اتحفظ على الجهاز وفي انتظار المزامنة.`),
      tr&&transferPanel(tr.doc,tr.lines,tr.names),tr&&el('div',{style:'height:8px'}),
      el('button',{class:'btn',onclick:()=>showStockDoc(user,kind,onBack)},'عملية جديدة'),el('div',{style:'height:8px'}),
      el('button',{class:'btn ghost',onclick:onBack},'رجوع للرئيسية'))));
  }

  // ---- مسح بالكاميرا (مشترك: js/scanner.js) ----
  const scanOnCode=text=>{const r=addFromScanText(text);
    if(r&&!Array.isArray(r))return{status:'ok',label:r.Name+' — '+r.Code};return Array.isArray(r)?{status:'multi'}:{status:'unknown'}};
  const openScan=()=>openScanner(scanOnCode);

  const sup=await scannerSupport();
  const scanBtn=sup?el('button',{class:'btn scanb',type:'button',onclick:openScan},'📷 مسح بالكاميرا'):null;
  const unitSw=el('div',{class:'unit-switch2',role:'group','aria-label':'المسح يضيف'},
    ['carton','piece'].map(u=>el('button',{type:'button',class:u===scanUnit?'on':'','data-u':u,onclick:e=>{scanUnit=u;[...e.currentTarget.parentNode.children].forEach(b=>b.classList.toggle('on',b.dataset.u===u))}},u==='carton'?'المسح = كرتونة':'المسح = قطعة')));
  $('#app').replaceChildren(el('div',{class:'wrap'},
    el('div',{class:'hello'},el('h2',{},cfg.title),el('button',{class:'btn ghost',onclick:onBack},'رجوع')),
    el('label',{class:'field'},el('span',{},kind==='TR'?'من مخزن (المصدر)':'المخزن'),whSel),
    toSel&&el('label',{class:'field'},el('span',{},'إلى مخزن (الوجهة)'),toSel),
    kind==='TR'&&whs.length<2&&el('p',{class:'editwarn'},'التحويل محتاج مخزنين نشطين على الأقل — أضف مخزن من شاشة «المخازن».'),
    el('label',{class:'field'},el('span',{},kind==='IN'?'الشحنة / ملاحظة':'ملاحظة'),note),
    q,scanBtn,unitSw,!scanBtn&&el('p',{class:'note'},'المسح بالكاميرا مش مدعوم في المتصفح ده — اكتب الكود أو استخدم قارئ باركود (بيكتب في خانة البحث).'),
    results,linesBox,summary,ovWrap,msg,confirmBtn));
  renderLines();
}

// ---------- شاشة الأرصدة وآخر الحركات ----------
export async function showStockView(user,onBack){
  const prods=(await all('products')).sort((a,b)=>a.SourceRow-b.SourceRow);
  const whs=(await all('warehouses')).filter(w=>w.Active),names=new Map(whs.map(w=>[w.WarehouseID,w.Name]));
  const sm=await stockMap(),byId=new Map(prods.map(p=>[p.ProductID,p]));
  const moves=(await all('movements')).sort((a,b)=>b.DateTime.localeCompare(a.DateTime)).slice(0,25);
  const typeAr={STOCK_IN:'استلام',STOCK_OUT:'صرف',TRANSFER_IN:'تحويل وارد',TRANSFER_OUT:'تحويل صادر',ADJUSTMENT:'تسوية',RETURN:'مرتجع',VOID_REVERSAL:'عكس إلغاء',INVOICE_ADJUST:'تعديل فاتورة'};
  const rows=prods.filter(p=>sm.has(p.ProductID)).map(p=>el('div',{class:'drow'},el('span',{},p.Name+' · '+p.Code),
    el('b',{},whs.map(w=>`${w.Name}: ${fmt(sm.get(p.ProductID)[w.WarehouseID]||0)}`).join(' | '))));
  $('#app').replaceChildren(el('div',{class:'wrap'},el('div',{class:'hello'},el('h2',{},'المخزون'),el('button',{class:'btn ghost',onclick:onBack},'رجوع')),
    el('h3',{class:'sec'},'الأرصدة (بالقطعة)'),...(rows.length?rows:[el('p',{class:'empty'},'مفيش أرصدة لسه — سجّل أول استلام.')]),
    el('h3',{class:'sec'},'آخر الحركات'),...moves.map(m=>el('div',{class:'drow'},
      el('span',{},`${typeAr[m.MovementType]||m.MovementType} · ${byId.get(m.ProductID)?.Name||m.ProductID} · ${names.get(m.WarehouseID)||''}`),
      el('b',{dir:'ltr'},(m.QuantityPieces>0?'+':'')+fmt(m.QuantityPieces))))));
}
