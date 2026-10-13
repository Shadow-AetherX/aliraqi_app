// شاشة «جرد وتسوية المخزون» (v15).
// الفكرة: المستخدم يدخّل الرصيد الفعلي بعد الجرد لكل صنف، والنظام يحسب الفرق (عجز/زيادة) ويسجّله كحركة ADJUSTMENT = الفرق (فعلي − رصيد السيستم) بنفس دفتر الحركات.
// يعني الرصيد بيتحدّث فوراً (الرصيد = مجموع الحركات)، ومفيش رقم رصيد بيتكتب فوق حاجة. الحفظ كله في معاملة IndexedDB واحدة:
//   مستند (stock_docs بـ Type='ADJUSTMENT' ورقم ADJ-YYYYMMDD-جهاز-0001) + حركة لكل صنف فيه فرق + طابور المزامنة + سجل العمليات. الأصناف المطابقة ما بتتسجّلش كحركات.
// أمان التزامن: بنسجّل «الفرق» مش «الرصيد المطلق» (فيدمج صح مع حركات جاية من أجهزة تانية)، وقبل الحفظ بنقارن رصيد كل صنف لحظتها بالرصيد اللي المستخدم شافه — لو اتغيّر (بيع/سحب جديد) بنرفض ونحدّث الشاشة.
// الصلاحية: StockAdjust (بتتفحص من القاعدة وقت الحفظ). الإلغاء: من «مستندات المخزن» (VoidStockDoc) بحركات عكسية زي باقي المستندات.
// مسودة الجرد بتتحفظ على الجهاز (settings) عشان جرد طويل ما يضيعش لو الصفحة اتقفلت — ومش بتتزامن.
import {all,get,put,txRun,uuid,nowISO,deviceId,ymd,stockMap,toPieces,pickWarehouse} from './db.js';
import {can} from './auth.js';
import {norm,compact} from './products.js';
import {$,el,toast,fmt,modal} from './ui.js';
import {openScanner,scannerSupport,parseScan} from './scanner.js';

const E=(msg,code,extra)=>Object.assign(new Error(msg),{code},extra);
const money=n=>Number(n||0).toLocaleString('en-US',{maximumFractionDigits:2});
const qput=(t,entity,id,now)=>t.objectStore('syncq').put({OpID:uuid(),Entity:entity,EntityID:id,Status:'PENDING',CreatedAt:now,Tries:0});
// parseScan: من scanner.js (مصدر واحد للبادئة)
const PAGE=40;
const REASONS=['جرد دوري','تلف','فقد / عجز','بضاعة زيادة لقيناها','تصحيح خطأ في تسجيل سابق'];

// lines: [{productId, systemQty (الرصيد اللي المستخدم شافه), countedQty (الفعلي)}] بالقطعة. بيرجّع {docId,number,doc,count,matched,surplus,shortage}
export async function postAdjustment({warehouseId,lines,reason,user}){
  const u=await get('users',user?.UserID);                                       // نعيد قراءة المستخدم من القاعدة مش من الجلسة
  if(!u||!u.Active||!await can(u,'StockAdjust'))throw E('مفيش صلاحية جرد وتسوية المخزون','FORBIDDEN');
  reason=String(reason||'').trim();if(reason.length<3)throw E('اكتب سبب التسوية (3 حروف على الأقل)','REASON');
  if(!warehouseId)throw E('اختار المخزن','NO_WH');
  const seen=new Set(),ls=[];
  for(const l of lines||[]){
    if(!l||!l.productId||seen.has(l.productId))throw E('صنف متكرر أو غير صالح في الجرد','BAD_LINE');seen.add(l.productId);
    if(!Number.isInteger(l.systemQty)||!Number.isInteger(l.countedQty)||l.countedQty<0)throw E('كمية غير صالحة (لازم عدد صحيح 0 أو أكتر)','BAD_QTY');
    ls.push({productId:l.productId,systemQty:l.systemQty,countedQty:l.countedQty});
  }
  if(!ls.length)throw E('مفيش أصناف في الجرد','EMPTY');
  const now=nowISO(),dev=deviceId(),docId=uuid();
  return txRun(['warehouses','movements','stock_docs','syncq','audit','settings'],(t,fail,setOut)=>{
    t.objectStore('warehouses').get(warehouseId).onsuccess=e=>{
      const w=e.target.result;
      if(!w||w.Active===false)return fail(E('المخزن غير متاح (معطل أو مش موجود)','BAD_WH'));
      const res=[];let left=ls.length,dead=false;
      for(const l of ls){
        t.objectStore('movements').index('ProductID').getAll(l.productId).onsuccess=e2=>{
          if(dead)return;
          const bal=e2.target.result.filter(m=>m.WarehouseID===warehouseId).reduce((s,m)=>s+m.QuantityPieces,0);
          if(bal!==l.systemQty){dead=true;return fail(E('الرصيد اتغيّر من وقت ما فتحت الجرد','STALE',{productId:l.productId,was:l.systemQty,now:bal}))}
          res.push({...l,delta:l.countedQty-bal});
          if(--left===0)finish(res);
        };
      }
    };
    function finish(res){
      const ch=res.filter(r=>r.delta!==0);
      if(!ch.length)return fail(E('كل الأصناف مطابقة — مفيش فروقات تتسجّل','NO_DIFF'));
      const day=ymd(new Date(now)),key=`adjseq:${dev}:${day}`,st=t.objectStore('settings');
      st.get(key).onsuccess=e=>{
        const n=(e.target.result?.value||0)+1;st.put({key,value:n});
        const number=`ADJ-${day}-${dev.replace(/^D-/,'')}-${String(n).padStart(4,'0')}`;
        const surplus=ch.filter(r=>r.delta>0).reduce((s,r)=>s+r.delta,0),shortage=ch.filter(r=>r.delta<0).reduce((s,r)=>s-r.delta,0),matched=res.length-ch.length;
        const doc={DocID:docId,Number:number,Type:'ADJUSTMENT',WarehouseID:warehouseId,DateTime:now,UserID:u.UserID,UserName:u.Name,DeviceID:dev,Notes:reason,Status:'POSTED',
          LinesCount:ch.length,MatchedCount:matched,TotalPieces:surplus+shortage,Surplus:surplus,Shortage:shortage,UpdatedAt:now,SyncStatus:'PENDING'};
        t.objectStore('stock_docs').put(doc);qput(t,'stock_docs',docId,now);
        for(const r of ch){
          const m={MovementID:uuid(),DateTime:now,ProductID:r.productId,WarehouseID:warehouseId,MovementType:'ADJUSTMENT',QuantityPieces:r.delta,ReferenceID:docId,
            UserID:u.UserID,DeviceID:dev,SyncStatus:'PENDING',Notes:reason};
          t.objectStore('movements').put(m);qput(t,'movements',m.MovementID,now);
        }
        t.objectStore('audit').put({AuditID:uuid(),UserID:u.UserID,UserName:u.Name,Action:'STOCK_ADJUST',EntityType:'StockDoc',EntityID:docId,DateTime:now,DeviceID:dev,OldValue:null,
          NewValue:JSON.stringify({number,warehouseId,lines:ch.map(r=>({p:r.productId,was:r.systemQty,counted:r.countedQty,q:r.delta})),surplus,shortage,matched}),Notes:reason,SyncStatus:'PENDING'});
        setOut({docId,number,doc,count:ch.length,matched,surplus,shortage});
      };
    }
  });
}

// ====================== الشاشة ======================
export async function showAdjust(user,onBack){
  const me=await get('users',user?.UserID);
  if(!me||!me.Active||!await can(me,'StockAdjust')){toast('مفيش صلاحية جرد وتسوية المخزون');onBack();return}
  const canCost=await can(me,'ViewCost');
  const prods=(await all('products')).filter(p=>p.Active!==false).sort((a,b)=>(a.SourceRow??1e9)-(b.SourceRow??1e9));
  prods.forEach(p=>{p._hay=norm(p.Name+' '+p.Category+' '+p.Code);p._code=compact(p.Code)});
  const byId=new Map(prods.map(p=>[p.ProductID,p])),whs=(await all('warehouses')).filter(w=>w.Active!==false);
  let stock=await stockMap();
  const counts=new Map();                               // productId -> {c:'كراتين',p:'قطع'} (نصوص؛ فاضي = لسه ما اتجردش)
  const S={q:'',scope:'stock',shown:PAGE};let scanUnit='carton',busy=false,prevWh='',tm;
  const draftKey='adjust_draft:'+me.UserID;

  if(!whs.length){
    $('#app').replaceChildren(el('div',{class:'wrap'},el('div',{class:'hello'},el('h2',{},'جرد وتسوية المخزون'),el('button',{class:'btn ghost',type:'button',onclick:onBack},'رجوع')),
      el('p',{class:'editwarn'},'مفيش مخزن نشط — أضف مخزن من شاشة «المخازن» الأول.')));return;
  }
  const whSel=el('select',{'aria-label':'المخزن',onchange:()=>{
    if(counts.size&&!window.confirm('تغيير المخزن هيمسح الأرقام اللي دخّلتها. تكمّل؟')){whSel.value=prevWh;return}
    counts.clear();prevWh=whSel.value;if(whSel.value)localStorage.setItem('alr_last_wh',whSel.value);S.shown=PAGE;saveDraft();render()}},
    whs.map(w=>el('option',{value:w.WarehouseID},w.Name)));
  whSel.value=pickWarehouse(whs)||whs[0].WarehouseID;prevWh=whSel.value;
  const nameOf=id=>whs.find(w=>w.WarehouseID===id)?.Name||'';

  // ---- مسودة ----
  let restored=null;
  try{const dr=await get('settings',draftKey);
    if(dr&&Array.isArray(dr.counts)&&dr.counts.length&&whs.some(w=>w.WarehouseID===dr.wh)){
      whSel.value=dr.wh;prevWh=dr.wh;for(const [pid,c] of dr.counts)if(byId.has(pid))counts.set(pid,{c:String(c.c??''),p:String(c.p??'')});
      if(counts.size)restored=dr.at}}catch{}
  const saveDraft=()=>{clearTimeout(tm);tm=setTimeout(()=>{put('settings',{key:draftKey,wh:whSel.value,at:nowISO(),counts:[...counts].map(([k,v])=>[k,{...v}])}).catch(()=>{})},400)};

  // ---- حسابات ----
  const bal=p=>((stock.get(p.ProductID)||{})[whSel.value])||0;
  const entered=c=>!!c&&(c.c!==''||c.p!=='');
  const countedOf=(p,c)=>toPieces(Number(c.c)||0,Number(c.p)||0,p.PcsPerCarton||0);
  const cartonsTxt=(p,q)=>{const k=p.PcsPerCarton;return k&&q>=k?` ≈ ${fmt(Math.floor(q/k))} كرتونة`+(q%k?` + ${fmt(q%k)} قطعة`:''):''};
  function compute(){
    const o={entered:0,matched:0,surplus:0,shortage:0,value:0,changed:[],all:[]};
    for(const [pid,c] of counts){
      const p=byId.get(pid);if(!p||!entered(c))continue;
      const sys=bal(p),cnt=countedOf(p,c),d=cnt-sys,r={p,sys,cnt,d};
      o.entered++;o.all.push(r);
      if(d===0)o.matched++;else{o.changed.push(r);d>0?o.surplus+=d:o.shortage-=d;o.value+=d*(typeof p.Cost==='number'?p.Cost:0)}
    }
    return o;
  }

  // ---- الواجهة ----
  const q=el('input',{type:'search',class:'psearch',placeholder:'اكتب الكود أو الاسم…',autocomplete:'off','aria-label':'بحث عن صنف'});
  const scopeSel=el('select',{'aria-label':'عرض',onchange:e=>{S.scope=e.target.value;S.shown=PAGE;render()}},
    el('option',{value:'stock'},'الأصناف اللي ليها رصيد'),el('option',{value:'all'},'كل الأصناف'),el('option',{value:'done'},'اللي اتجرد بس'));
  const list=el('div',{class:'slines'}),info=el('div',{class:'pcount'}),msg=el('p',{class:'err'}),sumEl=el('div',{class:'sum'});
  const reviewBtn=el('button',{class:'btn',type:'button',onclick:()=>review()},'مراجعة واعتماد');
  const more=el('div',{class:'morewrap'},el('button',{class:'btn ghost',type:'button',onclick:()=>{S.shown+=PAGE;render()}},'عرض المزيد'));
  let ti;q.addEventListener('input',()=>{clearTimeout(ti);ti=setTimeout(()=>{S.q=q.value;S.shown=PAGE;render()},120)});
  const refs=new Map();

  function paint(pid){
    const r=refs.get(pid);if(!r)return;const p=r.p,c=counts.get(pid),sys=bal(p);
    r.root.classList.remove('short','surp','match');
    if(!entered(c)){r.diff.className='bdg';r.diff.textContent='لسه';return}
    const d=countedOf(p,c)-sys;
    if(d===0){r.diff.className='bdg ok';r.diff.textContent='مطابق';r.root.classList.add('match')}
    else if(d>0){r.diff.className='bdg warn';r.diff.textContent='زيادة +'+fmt(d);r.root.classList.add('surp')}
    else{r.diff.className='bdg no';r.diff.textContent='عجز −'+fmt(-d);r.root.classList.add('short')}
  }
  function setCount(p,key,val){
    const cur=counts.get(p.ProductID)||{c:'',p:''},v=String(val).trim();
    cur[key]=v===''?'':String(Math.max(0,Math.floor(Number(v)||0)));
    cur.c===''&&cur.p===''?counts.delete(p.ProductID):counts.set(p.ProductID,cur);
    paint(p.ProductID);updateSummary();saveDraft();
  }
  function rowFor(p){
    const c=counts.get(p.ProductID)||{c:'',p:''},b=bal(p);
    const inp=(key)=>{const i=el('input',{type:'number',min:'0',step:'1',inputmode:'numeric',value:c[key],'aria-label':key==='c'?'كراتين':'قطع'});
      i.addEventListener('input',()=>setCount(p,key,i.value));i.addEventListener('focus',()=>i.select());return i};
    const ic=p.PcsPerCarton?inp('c'):null,ip=inp('p'),diff=el('span',{class:'bdg'},'لسه');
    const same=b>=0?el('button',{class:'btn ghost',type:'button',onclick:()=>{counts.set(p.ProductID,{c:'',p:String(b)});if(ic)ic.value='';ip.value=String(b);paint(p.ProductID);updateSummary();saveDraft()}},'= الرصيد'):null;
    const root=el('div',{class:'sline'},
      el('div',{class:'slhead'},el('div',{},el('b',{},p.Name||'(بدون اسم)'),el('span',{class:'code',dir:'ltr'},' '+p.Code)),same),
      el('div',{class:b<0?'adj-bal warn':'adj-bal'},`الرصيد بالسيستم: ${fmt(b)} قطعة`+cartonsTxt(p,b)),
      el('div',{class:'slqty'},ic&&el('label',{},'كراتين',ic),el('label',{},'قطع',ip),el('div',{class:'sltot'},el('span',{},'الفرق'),diff)),
      !p.PcsPerCarton&&el('small',{class:'warn'},'عدد القطع في الكرتونة غير محدد — الجرد بالقطعة فقط'));
    refs.set(p.ProductID,{p,root,diff,ic,ip});return root;
  }
  function render(){
    refs.clear();
    const toks=norm(S.q).split(' ').filter(Boolean);
    const r=prods.filter(p=>{
      if(toks.length&&!toks.every(k=>p._hay.includes(k)||p._code.includes(compact(k))))return false;
      const e=entered(counts.get(p.ProductID));
      if(S.scope==='done')return e;
      if(S.scope==='stock')return bal(p)!==0||e;
      return true;
    });
    info.textContent=`${fmt(r.length)} صنف`+(counts.size?` · اتجرد ${fmt(counts.size)}`:'');
    list.replaceChildren(...(r.length?r.slice(0,S.shown).map(rowFor):[el('p',{class:'empty'},S.scope==='done'?'لسه ما جردتش أي صنف':'مفيش أصناف مطابقة — جرّب «كل الأصناف» أو غيّر البحث')]));
    r.slice(0,S.shown).forEach(p=>paint(p.ProductID));
    more.hidden=r.length<=S.shown;updateSummary();
  }
  function updateSummary(){
    msg.textContent='';const L=compute();
    sumEl.textContent=L.entered?`اتجرد ${fmt(L.entered)} · مطابق ${fmt(L.matched)} · عجز ${fmt(L.shortage)} · زيادة ${fmt(L.surplus)}`+(canCost&&L.changed.length?` · صافي قيمة الفرق ${money(L.value)} ج.م`:''):'دخّل الرصيد الفعلي للأصناف اللي جردتها';
    reviewBtn.disabled=busy||!L.changed.length;
  }

  // ---- مراجعة واعتماد ----
  function review(){
    const L=compute();
    if(!L.entered){toast('ما دخّلتش أي رصيد فعلي');return}
    if(!L.changed.length){toast('كل الأصناف اللي جردتها مطابقة — مفيش تسوية تتسجّل');return}
    const reason=el('input',{type:'text',maxlength:'120',list:'adjReasons',placeholder:'سبب التسوية (مطلوب) — مثال: جرد دوري','aria-label':'سبب التسوية'});
    const err=el('p',{class:'err'});
    const row=(k,v,cls)=>el('div',{class:'drow'},el('span',{},k),el('b',{dir:'auto',class:cls||''},v));
    const btn=el('button',{class:'btn',type:'button',onclick:async()=>{
      err.textContent='';if(reason.value.trim().length<3){err.textContent='اكتب سبب التسوية (3 حروف على الأقل)';return}
      if(busy)return;busy=true;btn.disabled=true;
      try{
        const r=await postAdjustment({warehouseId:whSel.value,reason:reason.value,user:me,
          lines:L.all.map(x=>({productId:x.p.ProductID,systemQty:x.sys,countedQty:x.cnt}))});
        counts.clear();clearTimeout(tm);await put('settings',{key:draftKey,wh:whSel.value,at:nowISO(),counts:[]}).catch(()=>{});
        close();done(r);
      }catch(e){
        busy=false;btn.disabled=false;
        if(e.code==='STALE'){
          close();stock=await stockMap();render();                        // render بيمسح msg، فبنكتبها بعده
          const p=byId.get(e.productId);msg.textContent=`الرصيد اتغيّر للصنف «${p?.Name||''}» من ${fmt(e.was)} لـ ${fmt(e.now)} (فيه حركة جديدة وصلت). الفروقات اتحدّثت — راجعها واعتمد تاني. ما اتسجّلش حاجة.`;
        }else{err.textContent=typeof e.code==='string'?e.message:'تعذر الحفظ على الجهاز. حاول تاني.';updateSummary()}
      }
    }},'اعتماد التسوية');
    const close=modal('مراجعة التسوية — '+nameOf(whSel.value),
      row('أصناف فيها فرق',fmt(L.changed.length)),row('أصناف مطابقة',fmt(L.matched)),row('إجمالي العجز (قطعة)',fmt(L.shortage),L.shortage?'warn':''),row('إجمالي الزيادة (قطعة)',fmt(L.surplus)),
      canCost&&row('صافي قيمة الفرق بالتكلفة',money(L.value)+' ج.م',L.value<0?'warn':''),
      el('h3',{class:'sec'},'الفروقات (هتتسجّل كحركات تسوية)'),
      ...L.changed.slice(0,40).map(x=>el('div',{class:'drow'},el('span',{},`${x.p.Name||'(بدون اسم)'} · ${x.p.Code}`,el('small',{},`بالسيستم ${fmt(x.sys)} ← الفعلي ${fmt(x.cnt)}`)),
        el('b',{dir:'ltr',class:x.d<0?'warn':''},(x.d>0?'+':'')+fmt(x.d)))),
      L.changed.length>40&&el('p',{class:'note'},`+ ${fmt(L.changed.length-40)} صنف تانيين فيهم فرق`),
      el('label',{class:'field'},el('span',{},'السبب *'),reason),el('datalist',{id:'adjReasons'},REASONS.map(r=>el('option',{value:r}))),
      el('p',{class:'note'},'الرصيد بيتحدّث فور الاعتماد. التسوية بتتسجّل في سجل العمليات وبتتزامن، وتقدر تلغيها بعدين من «مستندات المخزن» (للمدير/المالك).'),err,btn);
    reason.focus();
  }
  function done(r){
    $('#app').replaceChildren(el('div',{class:'wrap'},el('div',{class:'login done'},el('div',{class:'bigok'},'✅'),el('h1',{},'تم اعتماد التسوية'),
      el('p',{},`${nameOf(r.doc.WarehouseID)} · ${r.number} · ${fmt(r.count)} صنف فيه فرق (عجز ${fmt(r.shortage)} · زيادة ${fmt(r.surplus)}) · ${fmt(r.matched)} مطابق — اتحفظ على الجهاز وفي انتظار المزامنة.`),
      el('button',{class:'btn',type:'button',onclick:()=>showAdjust(user,onBack)},'جرد جديد'),el('div',{style:'height:8px'}),
      el('button',{class:'btn ghost',type:'button',onclick:onBack},'رجوع للرئيسية'))));
  }

  // ---- مسح بالكاميرا: كل مسحة = +1 على الصنف (كرتونة أو قطعة) زي شاشة الاستلام ----
  const scanOnCode=text=>{
    const c=compact(parseScan(text));if(!c)return{status:'unknown'};
    const hits=prods.filter(p=>p._code===c);
    if(hits.length===1){const p=hits[0],cur=counts.get(p.ProductID)||{c:'',p:''},k=scanUnit==='carton'&&p.PcsPerCarton?'c':'p';
      cur[k]=String((Number(cur[k])||0)+1);counts.set(p.ProductID,cur);saveDraft();render();return{status:'ok',label:`${p.Name} — ${p.Code}`}}
    if(hits.length>1){S.scope='all';scopeSel.value='all';S.q=parseScan(text);q.value=S.q;render();return{status:'multi'}}
    return{status:'unknown'};
  };
  const sup=await scannerSupport();
  const scanBtn=sup?el('button',{class:'btn scanb',type:'button',onclick:()=>openScanner(scanOnCode)},'📷 مسح بالكاميرا (كل مسحة = +1)'):null;
  const unitSw=sup?el('div',{class:'unit-switch2',role:'group','aria-label':'المسح يضيف'},['carton','piece'].map(u=>
    el('button',{type:'button',class:u===scanUnit?'on':'','data-u':u,onclick:e=>{scanUnit=u;[...e.currentTarget.parentNode.children].forEach(b=>b.classList.toggle('on',b.dataset.u===u))}},u==='carton'?'المسح = كرتونة':'المسح = قطعة'))):null;
  const clearBtn=el('button',{class:'btn ghost',type:'button',onclick:()=>{if(counts.size&&!window.confirm('مسح كل الأرقام اللي دخّلتها؟'))return;counts.clear();saveDraft();render()}},'مسح الجرد');

  $('#app').replaceChildren(el('div',{class:'wrap rep'},
    el('div',{class:'hello'},el('h2',{},'جرد وتسوية المخزون'),el('button',{class:'btn ghost',type:'button',onclick:()=>{clearTimeout(tm);onBack()}},'رجوع')),
    el('label',{class:'field'},el('span',{},'المخزن'),whSel),
    restored&&el('p',{class:'editwarn'},'اتسترجع جرد غير معتمد محفوظ على الجهاز — كمّله أو امسحه.'),
    el('p',{class:'note'},'دخّل الرصيد الفعلي بعد العدّ، والفرق بيتحسب لوحده. الأصناف اللي ما دخّلتش ليها رقم ما بتتغيّرش.'),
    q,scanBtn,unitSw,el('div',{class:'filters'},scopeSel,clearBtn),info,list,more,msg,
    el('div',{class:'adj-bar'},sumEl,reviewBtn)));
  render();
}
