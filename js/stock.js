import {all,postStockDoc,stockMap,toPieces,pickWarehouse} from './db.js';
import {postTransfer} from './transfers.js';
import {transferPanel} from './transfer-pdf.js';
import {can} from './auth.js';
import {norm,compact} from './products.js';
import {$,el,toast,fmt,undoSnack,mapInsert} from './ui.js';
import {openScanner,scannerSupport,parseScan} from './scanner.js';
import {makeDraft} from './session.js';

const T={IN:{type:'STOCK_IN',title:'استلام مخزون',en:'STOCK IN',btn:'تأكيد الاستلام',ok:'تم تسجيل الاستلام'},
         OUT:{type:'STOCK_OUT',title:'صرف من المخزن',en:'STOCK OUT',btn:'تأكيد الصرف',ok:'تم تسجيل الصرف'},
         TR:{type:'TRANSFER',title:'نقل بين المخازن',en:'STOCK TRANSFER',btn:'تأكيد التحويل',ok:'تم تسجيل التحويل'}};
// محتوى الـ QR = كود الصنف بس (مع بادئة اختيارية). مفيش سعر ولا رصيد جواه.
// parseScan: من scanner.js (مصدر واحد للبادئة)

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
  // v23.6: مسودة تلقائية (على الجهاز، مش بتتزامن): المخزن/الوجهة/الملاحظة/الأصناف والكميات. بتتحفظ بعد كل تغيير ولحظة القفل، وبتتمسح بعد الحفظ الناجح.
  const draft=makeDraft(`stock:${kind}:${user.UserID}`,()=>({wh:whSel.value,to:toSel?toSel.value:'',note:note.value,unit:scanUnit,lines:[...lines].map(([id,l])=>[id,{cartons:l.cartons,pieces:l.pieces}])}));
  let restored=false;
  {const dr=await draft.load();
    if(dr&&Array.isArray(dr.lines)&&dr.lines.length){
      if(dr.wh&&whs.some(w=>w.WarehouseID===dr.wh))whSel.value=dr.wh;
      drawTo();if(toSel&&dr.to&&[...toSel.options].some(o=>o.value===dr.to))toSel.value=dr.to;
      if(typeof dr.note==='string')note.value=dr.note.slice(0,120);
      if(dr.unit==='piece'||dr.unit==='carton')scanUnit=dr.unit;
      for(const [id,l] of dr.lines)if(byId.has(id))lines.set(id,{cartons:Math.max(0,Math.floor(Number(l.cartons)||0)),pieces:Math.max(0,Math.floor(Number(l.pieces)||0))});
      restored=lines.size>0;
    }}
  note.addEventListener('input',()=>draft.touch());

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
          el('button',{class:'x',type:'button','aria-label':'حذف الصنف',onclick:()=>{const idx=[...lines.keys()].indexOf(id),saved=lines.get(id);lines.delete(id);renderLines();
            undoSnack('اتشال «'+(p.Name||'الصنف')+'»',()=>{if(lines.has(id))return;mapInsert(lines,id,saved,idx);renderLines()})}},'✕')),
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
    draft.touch();
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
        await draft.clear();
        done(r.count,pcs,`من ${fromName} إلى ${toName}`,{number:r.number,doc:r.doc,names:{from:fromName,to:toName},
          lines:ls.map(x=>({Code:byId.get(x.productId).Code,Name:byId.get(x.productId).Name,Qty:x.qtyPieces}))});
      }else{
        const r=await postStockDoc({type:cfg.type,warehouseId:whSel.value,lines:ls,user,notes:note.value.trim(),allowNegative:canOverride&&override.checked});
        await draft.clear();
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
    restored&&el('div',{class:'editwarn'},'اتسترجعت مسودة غير محفوظة من آخر مرة. راجع الأصناف والكميات. ',el('button',{class:'btn ghost',type:'button',onclick:async()=>{lines.clear();note.value='';await draft.reset();renderLines()}},'مسح المسودة')),
    el('label',{class:'field'},el('span',{},kind==='TR'?'من مخزن (المصدر)':'المخزن'),whSel),
    toSel&&el('label',{class:'field'},el('span',{},'إلى مخزن (الوجهة)'),toSel),
    kind==='TR'&&whs.length<2&&el('p',{class:'editwarn'},'التحويل محتاج مخزنين نشطين على الأقل — أضف مخزن من شاشة «المخازن».'),
    el('label',{class:'field'},el('span',{},kind==='IN'?'الشحنة / ملاحظة':'ملاحظة'),note),
    q,scanBtn,unitSw,!scanBtn&&el('p',{class:'note'},'المسح بالكاميرا مش مدعوم في المتصفح ده — اكتب الكود أو استخدم قارئ باركود (بيكتب في خانة البحث).'),
    results,linesBox,summary,ovWrap,msg,confirmBtn));
  renderLines();draft.arm();                                              // من هنا أي تغيير بيتحفظ كمسودة
}

// ---------- شاشة الأرصدة (كل الأصناف حتى اللي رصيدها صفر) وآخر الحركات ----------
// go (اختياري): {adjust, receive, addProduct} — اختصارات بتتعرض بس لو المستخدم معاه الصلاحية.
export async function showStockView(user,onBack,go={}){
  const allP=(await all('products')).sort((a,b)=>(a.SourceRow??1e9)-(b.SourceRow??1e9));
  const whs=(await all('warehouses')).filter(w=>w.Active),names=new Map(whs.map(w=>[w.WarehouseID,w.Name]));
  const sm=await stockMap(),byId=new Map(allP.map(p=>[p.ProductID,p]));
  const [cAdj,cIn,cAdd]=await Promise.all([can(user,'StockAdjust'),can(user,'StockIn'),can(user,'EditProducts')]);
  const totalOf=(p,wid)=>{const o=sm.get(p.ProductID)||{};return wid?(o[wid]||0):whs.reduce((s,w)=>s+(o[w.WarehouseID]||0),0)};
  const prods=allP.filter(p=>p.Active!==false||totalOf(p)!==0);                  // الموقوف بيظهر بس لو لسه ليه رصيد
  prods.forEach(p=>{p._hay=norm(p.Name+' '+p.Category+' '+p.Code);p._code=compact(p.Code)});
  const moves=(await all('movements')).sort((a,b)=>b.DateTime.localeCompare(a.DateTime)).slice(0,25);
  const typeAr={STOCK_IN:'استلام',STOCK_OUT:'صرف',TRANSFER_IN:'تحويل وارد',TRANSFER_OUT:'تحويل صادر',ADJUSTMENT:'تسوية',RETURN:'مرتجع',VOID_REVERSAL:'عكس إلغاء',INVOICE_ADJUST:'تعديل فاتورة'};
  const cartonsTxt=(p,q)=>{const k=p.PcsPerCarton;return k&&q>=k?` ≈ ${fmt(Math.floor(q/k))} كرتونة`+(q%k?` + ${fmt(q%k)} قطعة`:''):''};
  const S={q:'',f:'all',wh:'',shown:40};
  const search=el('input',{type:'search',class:'psearch',placeholder:'ابحث بالاسم أو الكود…',autocomplete:'off','aria-label':'بحث في المخزون'});
  let t;search.addEventListener('input',()=>{clearTimeout(t);t=setTimeout(()=>{S.q=search.value;S.shown=40;render()},120)});
  const fSel=el('select',{'aria-label':'عرض',onchange:e=>{S.f=e.target.value;S.shown=40;render()}},
    el('option',{value:'all'},'كل الأصناف'),el('option',{value:'in'},'اللي ليها رصيد'),el('option',{value:'zero'},'رصيدها صفر'),el('option',{value:'neg'},'رصيد بالسالب (محتاج مراجعة)'));
  const wSel=el('select',{'aria-label':'المخزن',onchange:e=>{S.wh=e.target.value;S.shown=40;render()}},el('option',{value:''},'كل المخازن'),whs.map(w=>el('option',{value:w.WarehouseID},w.Name)));
  const sumEl=el('div',{class:'pcount'}),list=el('div',{}),more=el('div',{class:'morewrap'},el('button',{class:'btn ghost',type:'button',onclick:()=>{S.shown+=40;render()}},'عرض المزيد'));
  function render(){
    const toks=norm(S.q).split(' ').filter(Boolean);
    const r=prods.filter(p=>{const q=totalOf(p,S.wh);
      if(toks.length&&!toks.every(k=>p._hay.includes(k)||p._code.includes(compact(k))))return false;
      return S.f==='all'||(S.f==='in'&&q>0)||(S.f==='zero'&&q===0)||(S.f==='neg'&&q<0)});
    const act=prods.filter(p=>p.Active!==false),inStock=act.filter(p=>totalOf(p,S.wh)>0).length,zero=act.filter(p=>totalOf(p,S.wh)===0).length;
    const pieces=act.reduce((s,p)=>s+Math.max(0,totalOf(p,S.wh)),0);
    sumEl.textContent=`${fmt(act.length)} صنف · ليها رصيد ${fmt(inStock)} · صفر ${fmt(zero)} · إجمالي ${fmt(pieces)} قطعة`+(r.length!==prods.length?` — المعروض ${fmt(r.length)}`:'');
    list.replaceChildren(...(r.length?r.slice(0,S.shown).map(p=>{
      const ws=(S.wh?whs.filter(w=>w.WarehouseID===S.wh):whs),o=sm.get(p.ProductID)||{};
      return el('div',{class:'drow'},el('span',{},p.Name+' · '+p.Code+(p.Active===false?' (موقوف)':'')),
        el('b',{dir:'auto',class:ws.some(w=>(o[w.WarehouseID]||0)<0)?'warn':''},ws.map(w=>{const q=o[w.WarehouseID]||0;return `${w.Name}: ${fmt(q)} قطعة${cartonsTxt(p,q)}`}).join(' | ')))
    }):[el('p',{class:'empty'},prods.length?'مفيش أصناف مطابقة':'مفيش أصناف لسه — '+(cAdd?'ضيف صنف جديد من الزرار فوق.':'اطلب من المدير يضيف أصناف.'))]));
    more.hidden=r.length<=S.shown;
  }
  const btn=(txt,fn,cls)=>el('button',{class:'btn'+(cls?' '+cls:''),type:'button',onclick:fn},txt);
  const actions=[go.addProduct&&cAdd&&btn('➕ صنف جديد',go.addProduct),go.adjust&&cAdj&&btn('📝 إدخال/تصحيح الكميات (جرد)',go.adjust,'ghost'),go.receive&&cIn&&btn('📥 استلام مخزون',go.receive,'ghost')].filter(Boolean);
  $('#app').replaceChildren(el('div',{class:'wrap'},el('div',{class:'hello'},el('h2',{},'المخزون'),el('button',{class:'btn ghost',onclick:onBack},'رجوع')),
    actions.length&&el('div',{class:'filters'},...actions),
    el('p',{class:'note'},'الكميات بالقطعة، والكراتين تقريبية حسب عدد القطع في الكرتونة. عشان تدخّل كميات الأصناف أول مرة استخدم «إدخال/تصحيح الكميات (جرد)».'),
    search,el('div',{class:'filters'},fSel,wSel),sumEl,list,more,
    el('details',{class:'help-sec'},el('summary',{},'آخر الحركات'),el('div',{class:'help-body'},...(moves.length?moves.map(m=>el('div',{class:'drow'},
      el('span',{},`${typeAr[m.MovementType]||m.MovementType} · ${byId.get(m.ProductID)?.Name||m.ProductID} · ${names.get(m.WarehouseID)||''}`),
      el('b',{dir:'ltr'},(m.QuantityPieces>0?'+':'')+fmt(m.QuantityPieces)))):[el('p',{class:'empty'},'مفيش حركات لسه')])))));
  render();
}
