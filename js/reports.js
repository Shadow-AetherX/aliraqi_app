// شاشة «التقارير» (v14) — قراءة فقط: مفيش أي كتابة في القاعدة ولا في طابور المزامنة ولا في سجل العمليات.
//  1) المبيعات والربحية: إجمالي/صافي المبيعات (بعد المرتجعات)، عدد الفواتير، الربح والهامش، حسب الصنف والمخزن، وقائمة المستندات.
//  2) أرصدة المخزون: الرصيد الحالي لكل صنف في كل مخزن + القيمة بسعر البيع (والقيمة بالتكلفة لمن معه ViewCost).
//  3) حركة الأصناف: ملخص حسب نوع الحركة وحسب الصنف + قائمة تفصيلية (استلام، صرف، بيع، تحويل، مرتجع، عكس إلغاء، تعديل فاتورة).
// الصلاحيات: ViewReports لفتح الشاشة. التكلفة والربح والهامش وقيمة المخزون بالتكلفة بتظهر (••••) لمن ليس معه ViewCost — وبنقرأ المستخدم من القاعدة مش من الجلسة.
// قواعد الحساب: الفواتير الملغاة (VOID) مش بتتحسب. المبيعات بتتحسب بآخر نسخة من الفاتورة بتاريخها الأصلي، والمرتجع بتاريخ إشعار المرتجع نفسه (بيتخصم من الصافي).
// ملحوظة: سطور الفاتورة ما بتحفظش التكلفة وقت البيع، فالربح = سعر البيع − تكلفة الصنف الحالية (products.Cost).
import {all,get} from './db.js';
import {can} from './auth.js';
import {norm,compact} from './products.js';
import {$,el,toast,fmt} from './ui.js';
import {showInvoiceView,showCreditNoteView} from './invoices.js';

const money=n=>Number(n||0).toLocaleString('en-US',{maximumFractionDigits:2});
const r2=n=>Math.round((Number(n)+Number.EPSILON)*100)/100;
const MASK='••••';
const pad=n=>String(n).padStart(2,'0');
const dstr=d=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const fdt=iso=>{const d=new Date(iso);return isNaN(d)?'—':`${d.getFullYear()}/${pad(d.getMonth()+1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`};
const sgn=n=>(n>0?'+':'')+fmt(n);
const PAGE={inv:25,prod:15,mov:50,stock:40};
// SALE = صرف مرتبط بفاتورة (STOCK_OUT اللي ReferenceID بتاعه فاتورة)، والباقي بنفس MovementType
const TYPES=[['SALE','بيع (فاتورة)','ok'],['STOCK_IN','استلام','ok'],['STOCK_OUT','صرف','warn'],['TRANSFER_IN','تحويل وارد','cn'],['TRANSFER_OUT','تحويل صادر','cn'],
  ['RETURN','مرتجع','cn'],['VOID_REVERSAL','عكس إلغاء','void'],['INVOICE_ADJUST','تعديل فاتورة','edited'],['ADJUSTMENT','تسوية','warn']];
const TYPE_AR=Object.fromEntries(TYPES.map(t=>[t[0],t[1]])),TYPE_CLS=Object.fromEntries(TYPES.map(t=>[t[0],t[2]]));
const newState=()=>{const n=new Date();return{tab:'sales',from:dstr(new Date(n.getFullYear(),n.getMonth(),1)),to:dstr(n),wh:'',prod:'',type:'',view:'sum',hideZero:true,shown:{...PAGE}}};

// state: اختياري — بيتبعت لما نرجع من فتح فاتورة عشان الفلاتر تفضل زي ما هي
export async function showReports(user,onBack,state){
  const me=await get('users',user?.UserID);
  if(!me||!me.Active||!await can(me,'ViewReports')){toast('مفيش صلاحية عرض التقارير');onBack();return}
  const canCost=await can(me,'ViewCost');
  const [prods,whs,invs,ilines,cns,clines,moves,sdocs]=await Promise.all(
    ['products','warehouses','invoices','invoice_lines','credit_notes','credit_note_lines','movements','stock_docs'].map(s=>all(s)));
  const S=state||newState();

  // ---------- فهارس مساعدة ----------
  const pById=new Map(prods.map(p=>[p.ProductID,p])),whName=new Map(whs.map(w=>[w.WarehouseID,w.Name]));
  const wn=id=>whName.get(id)||id||'—',pn=id=>{const p=pById.get(id);return p?`${p.Name||'(بدون اسم)'} · ${p.Code}`:String(id||'—')};
  const group=(arr,k)=>{const m=new Map();for(const x of arr){const v=m.get(x[k]);v?v.push(x):m.set(x[k],[x])}return m};
  const lnByInv=group(ilines.filter(l=>!l.Superseded),'InvoiceID'),lnByCn=group(clines,'CreditNoteID');
  const refNum=new Map([...invs.map(i=>[i.InvoiceID,i.Number]),...cns.map(c=>[c.CreditNoteID,c.Number]),...sdocs.map(d=>[d.DocID,d.Number])]);
  const invIds=new Set(invs.map(i=>i.InvoiceID));
  for(const x of [...invs,...cns,...moves])x._t=Date.parse(x.DateTime);
  prods.forEach(p=>{p._hay=norm(p.Name+' '+p.Category+' '+p.Code);p._code=compact(p.Code)});
  const costOf=pid=>{const c=pById.get(pid)?.Cost;return typeof c==='number'&&Number.isFinite(c)?c:null};
  const okProd=pid=>!S.prod||pid===S.prod;
  const range=()=>({f:S.from?new Date(S.from+'T00:00:00').getTime():-Infinity,t:S.to?new Date(S.to+'T23:59:59.999').getTime():Infinity});
  const kindOf=m=>m.MovementType==='STOCK_OUT'&&invIds.has(m.ReferenceID)?'SALE':m.MovementType;
  const kpi=(l,v,cls='')=>el('div',{class:'kpi '+cls},el('span',{},l),el('b',{},v));
  const moreBtn=(key,total)=>total>S.shown[key]?el('div',{class:'morewrap'},el('button',{class:'btn ghost',type:'button',onclick:()=>{S.shown[key]+=PAGE[key];draw()}},'عرض المزيد')):null;

  // ================= 1) المبيعات والربحية =================
  function calcSales(){
    const r=range(),inWh=w=>!S.wh||w===S.wh;
    const T={gross:0,ret:0,cSales:0,cCost:0,noCost:0,nInv:0,nCn:0,nVoid:0,voidTotal:0};
    const perProd=new Map(),perWh=new Map(),rows=[];
    const bucket=(m,k)=>{let o=m.get(k);if(!o){o={pcs:0,sales:0,cSales:0,cCost:0};m.set(k,o)}return o};
    const add=(sign,l,wid,row)=>{
      const tp=l.TotalPieces,amt=l.LineTotal,c=costOf(l.ProductID),cost=c==null?null:r2(tp*c);
      if(sign>0)T.gross+=amt;else T.ret+=amt;
      if(cost==null)T.noCost+=sign*amt;else{T.cSales+=sign*amt;T.cCost+=sign*cost}
      for(const o of [bucket(perProd,l.ProductID),bucket(perWh,wid),row]){o.pcs+=sign*tp;o.sales+=sign*amt;if(cost!=null){o.cSales+=sign*amt;o.cCost+=sign*cost}}
    };
    for(const inv of invs){
      if(inv._t<r.f||inv._t>r.t||!inWh(inv.WarehouseID))continue;
      const ls=(lnByInv.get(inv.InvoiceID)||[]).filter(l=>okProd(l.ProductID));
      if(inv.Status==='VOID'){if(!S.prod||ls.length){T.nVoid++;T.voidTotal+=inv.Total}continue}
      if(inv.Status!=='POSTED'||!ls.length)continue;
      const row={kind:'inv',doc:inv,pcs:0,sales:0,cSales:0,cCost:0};
      for(const l of ls)add(1,l,inv.WarehouseID,row);
      T.nInv++;rows.push(row);
    }
    for(const cn of cns){
      if(cn._t<r.f||cn._t>r.t||!inWh(cn.WarehouseID)||cn.Status==='VOID')continue;
      const ls=(lnByCn.get(cn.CreditNoteID)||[]).filter(l=>okProd(l.ProductID));
      if(!ls.length)continue;
      const row={kind:'cn',doc:cn,pcs:0,sales:0,cSales:0,cCost:0};
      for(const l of ls)add(-1,l,cn.WarehouseID,row);
      T.nCn++;rows.push(row);
    }
    rows.sort((a,b)=>b.doc._t-a.doc._t);
    const prodRows=[...perProd].map(([pid,o])=>({pid,...o})).sort((a,b)=>b.sales-a.sales);
    const whRows=[...perWh].map(([wid,o])=>({wid,...o})).sort((a,b)=>b.sales-a.sales);
    return {T,rows,prodRows,whRows};
  }
  function renderSales(){
    const {T,rows,prodRows,whRows}=calcSales();
    const net=r2(T.gross-T.ret),prof=r2(T.cSales-T.cCost);
    const nodes=[el('div',{class:'kpis'},
      kpi('صافي المبيعات',money(net)+' ج.م'),kpi('إجمالي المبيعات',money(T.gross)+' ج.م'),
      kpi('المرتجعات',money(T.ret)+' ج.م',T.ret?'bad':''),
      kpi('عدد الفواتير',fmt(T.nInv)+(T.nCn?` · ${fmt(T.nCn)} مرتجع`:'')),
      kpi('صافي الربح',canCost?money(prof)+' ج.م':MASK,canCost?(prof<0?'bad':'good'):''),
      kpi('هامش الربح',canCost?(T.cSales>0?((prof/T.cSales)*100).toFixed(1)+'%':'—'):MASK))];
    if(T.nVoid)nodes.push(el('p',{class:'note'},`فواتير ملغاة في الفترة دي: ${fmt(T.nVoid)} (بقيمة ${money(T.voidTotal)} ج.م) — مش محسوبة في المبيعات.`));
    if(canCost){
      if(T.noCost)nodes.push(el('p',{class:'editwarn'},`في مبيعات بقيمة ${money(T.noCost)} ج.م لأصناف من غير تكلفة — خارج حساب الربح والهامش.`));
      nodes.push(el('p',{class:'note'},'الربح = سعر البيع − تكلفة الصنف الحالية. سطور الفاتورة ما بتحفظش التكلفة وقت البيع، فتغيير تكلفة صنف بيغيّر ربح فواتيره القديمة هنا.'));
    }
    if(!rows.length){nodes.push(el('p',{class:'empty'},'مفيش مبيعات مطابقة للفلاتر دي'));return nodes}
    const line=(name,sub,o)=>el('div',{class:'drow'},el('span',{},name,el('small',{},sub)),
      el('b',{},money(o.sales)+' ج.م'+(canCost?` · ربح ${o.cSales||o.cCost?money(o.cSales-o.cCost):'—'}`:'')));
    if(!S.wh&&whRows.length>1)nodes.push(el('h3',{class:'sec'},'حسب المخزن'),...whRows.map(w=>line(wn(w.wid),`${fmt(w.pcs)} قطعة (صافي)`,w)));
    nodes.push(el('h3',{class:'sec'},'حسب الصنف'),...prodRows.slice(0,S.shown.prod).map(p=>line(pn(p.pid),`${fmt(p.pcs)} قطعة (صافي)`,p)),moreBtn('prod',prodRows.length));
    const open=row=>{const back=()=>showReports(user,onBack,S);row.kind==='cn'?showCreditNoteView(me,row.doc.CreditNoteID,back):showInvoiceView(me,row.doc.InvoiceID,back)};
    nodes.push(el('h3',{class:'sec'},'الفواتير والمرتجعات'),
      el('div',{class:'plist cust'},...rows.slice(0,S.shown.inv).map(row=>el('article',{class:'pcard ccard',tabindex:'0',role:'button',onclick:()=>open(row),onkeydown:e=>{if(e.key==='Enter')open(row)}},
        el('div',{class:'pbody'},el('h3',{},row.doc.CustomerName||'—'),
          el('div',{class:'pmeta'},el('span',{class:'code',dir:'ltr'},row.doc.Number),el('b',{},money(row.sales)+' ج.م')),
          el('div',{class:'badges'},row.kind==='cn'&&el('span',{class:'bdg cn'},'مرتجع'),row.kind==='inv'&&row.doc.Version>1&&el('span',{class:'bdg edited'},'معدّلة')),
          el('div',{class:'pstock'},fdt(row.doc.DateTime)+' · '+wn(row.doc.WarehouseID)+(canCost&&(row.cSales||row.cCost)?' · ربح '+money(row.cSales-row.cCost):'')))))),
      moreBtn('inv',rows.length));
    return nodes;
  }

  // ================= 2) أرصدة المخزون (الحالية) =================
  function calcStock(){
    const sm=new Map();
    for(const m of moves){
      if(S.wh&&m.WarehouseID!==S.wh)continue;if(!okProd(m.ProductID))continue;
      let o=sm.get(m.ProductID);if(!o){o={};sm.set(m.ProductID,o)}o[m.WarehouseID]=(o[m.WarehouseID]||0)+m.QuantityPieces;
    }
    const rows=[],W=new Map(),T={pcs:0,cost:0,sell:0,noCost:0,neg:0};
    for(const [pid,o] of sm){
      const vals=Object.values(o);if(S.hideZero&&vals.every(x=>x===0))continue;
      const p=pById.get(pid),total=vals.reduce((s,x)=>s+x,0),c=costOf(pid),sp=typeof p?.PricePiece==='number'?p.PricePiece:null;
      for(const [w,q] of Object.entries(o)){const x=W.get(w)||{pcs:0,cost:0,sell:0};x.pcs+=q;if(c!=null)x.cost+=q*c;if(sp!=null)x.sell+=q*sp;W.set(w,x)}
      T.pcs+=total;if(c!=null)T.cost+=total*c;else if(total!==0)T.noCost++;
      if(sp!=null)T.sell+=total*sp;if(vals.some(x=>x<0))T.neg++;
      rows.push({pid,p,o,total,value:c==null?null:total*c});
    }
    rows.sort((a,b)=>(a.p?.SourceRow??1e9)-(b.p?.SourceRow??1e9));
    return {rows,W,T};
  }
  const cartonsTxt=(p,q)=>{const k=p?.PcsPerCarton;return k&&q>=k?` ≈ ${fmt(Math.floor(q/k))} كرتونة`+(q%k?` + ${fmt(q%k)} قطعة`:''):''};
  function renderStock(){
    const {rows,W,T}=calcStock();
    const nodes=[el('div',{class:'kpis'},
      kpi('عدد الأصناف',fmt(rows.length)),kpi('إجمالي القطع',fmt(T.pcs)),
      kpi('القيمة بسعر البيع',money(r2(T.sell))+' ج.م'),
      kpi('القيمة بالتكلفة',canCost?money(r2(T.cost))+' ج.م':MASK)),
      el('p',{class:'note'},'الأرصدة لحظية (دلوقتي) ومحسوبة من دفتر الحركات — فلتر التاريخ مش بيأثر هنا.')];
    if(T.neg)nodes.push(el('p',{class:'editwarn'},`${fmt(T.neg)} صنف رصيده بالسالب في مخزن واحد على الأقل — راجع الحركات.`));
    if(canCost&&T.noCost)nodes.push(el('p',{class:'editwarn'},`${fmt(T.noCost)} صنف من غير تكلفة — خارج القيمة بالتكلفة.`));
    if(!rows.length){nodes.push(el('p',{class:'empty'},'مفيش أرصدة مطابقة للفلاتر دي'));return nodes}
    if(!S.wh&&W.size>1)nodes.push(el('h3',{class:'sec'},'حسب المخزن'),...[...W].map(([w,x])=>el('div',{class:'drow'},el('span',{},wn(w),el('small',{},'بسعر البيع: '+money(r2(x.sell))+' ج.م')),
      el('b',{},`${fmt(x.pcs)} قطعة`+(canCost?' · '+money(r2(x.cost))+' ج.م':'')))));
    nodes.push(el('h3',{class:'sec'},'حسب الصنف'),...rows.slice(0,S.shown.stock).map(r=>{
      const parts=whs.filter(w=>w.WarehouseID in r.o).map(w=>`${w.Name}: ${fmt(r.o[w.WarehouseID])}`);
      return el('div',{class:'drow'},el('span',{},r.p?`${r.p.Name||'(بدون اسم)'} · ${r.p.Code}`:r.pid,el('small',{},parts.join(' | ')+cartonsTxt(r.p,r.total))),
        el('b',{class:r.total<0?'warn':''},`${fmt(r.total)} قطعة`+(canCost?' · '+(r.value==null?'بدون تكلفة':money(r2(r.value))+' ج.م'):'')));
    }),moreBtn('stock',rows.length));
    return nodes;
  }

  // ================= 3) حركة الأصناف =================
  function calcMoves(){
    const r=range(),list=[],byType=new Map(),byProd=new Map();
    for(const m of moves){
      if(m._t<r.f||m._t>r.t||(S.wh&&m.WarehouseID!==S.wh)||!okProd(m.ProductID))continue;
      const k=kindOf(m);if(S.type&&k!==S.type)continue;
      const q=m.QuantityPieces,t=byType.get(k)||byType.set(k,{k,n:0,in:0,out:0}).get(k),p=byProd.get(m.ProductID)||byProd.set(m.ProductID,{pid:m.ProductID,n:0,in:0,out:0}).get(m.ProductID);
      for(const o of [t,p]){o.n++;if(q>0)o.in+=q;else o.out+=-q}
      list.push({m,k});
    }
    list.sort((a,b)=>b.m._t-a.m._t);
    const types=TYPES.map(t=>byType.get(t[0])).filter(Boolean);
    const prodRows=[...byProd.values()].sort((a,b)=>(b.in+b.out)-(a.in+a.out));
    return {list,types,prodRows};
  }
  function renderMoves(){
    const {list,types,prodRows}=calcMoves();
    const tin=types.reduce((s,t)=>s+t.in,0),tout=types.reduce((s,t)=>s+t.out,0);
    const nodes=[el('div',{class:'kpis'},kpi('عدد الحركات',fmt(list.length)),kpi('إجمالي الداخل',fmt(tin)+' قطعة','good'),kpi('إجمالي الخارج',fmt(tout)+' قطعة',tout?'bad':''))];
    if(!list.length){nodes.push(el('p',{class:'empty'},'مفيش حركات مطابقة للفلاتر دي'));return nodes}
    if(!S.wh)nodes.push(el('p',{class:'note'},'التحويل بين المخازن بيظهر داخل وخارج بنفس القيمة، فبيتعادل في الإجمالي لما كل المخازن مختارة.'));
    nodes.push(el('h3',{class:'sec'},'حسب نوع الحركة'),...types.map(t=>el('div',{class:'drow'},
      el('span',{},el('span',{class:'bdg '+(TYPE_CLS[t.k]||'cn')},TYPE_AR[t.k]||t.k),el('small',{},`${fmt(t.n)} حركة`)),
      el('b',{dir:'ltr'},`+${fmt(t.in)} / −${fmt(t.out)}`))));
    const sw=el('div',{class:'unit-switch2',role:'group','aria-label':'طريقة العرض'},[['sum','ملخص بالصنف'],['det','تفصيلي']].map(([v,t])=>
      el('button',{type:'button',class:v===S.view?'on':'',onclick:()=>{S.view=v;draw()}},t)));
    nodes.push(sw);
    if(S.view==='sum'){
      nodes.push(...prodRows.slice(0,S.shown.stock).map(p=>el('div',{class:'drow'},el('span',{},pn(p.pid),el('small',{},`${fmt(p.n)} حركة`)),
        el('b',{dir:'ltr'},`+${fmt(p.in)} / −${fmt(p.out)} = ${sgn(p.in-p.out)}`))),moreBtn('stock',prodRows.length));
    }else{
      nodes.push(...list.slice(0,S.shown.mov).map(({m,k})=>el('div',{class:'drow'},
        el('span',{},pn(m.ProductID)+' · '+wn(m.WarehouseID),el('small',{},[fdt(m.DateTime),TYPE_AR[k]||k,refNum.get(m.ReferenceID)].filter(Boolean).join(' · '))),
        el('b',{dir:'ltr',class:m.QuantityPieces<0?'warn':''},sgn(m.QuantityPieces)))),moreBtn('mov',list.length));
    }
    return nodes;
  }

  // ================= الواجهة والفلاتر =================
  const resetPage=()=>{S.shown={...PAGE}};
  const TABS=[['sales','المبيعات والربحية'],['stock','أرصدة المخزون'],['moves','حركة الأصناف']];
  const tabs=el('div',{class:'unit-switch2',role:'group','aria-label':'نوع التقرير'},TABS.map(([v,t])=>
    el('button',{type:'button',class:v===S.tab?'on':'','data-t':v,onclick:e=>{S.tab=v;resetPage();[...e.currentTarget.parentNode.children].forEach(b=>b.classList.toggle('on',b.dataset.t===v));draw()}},t)));
  const from=el('input',{type:'date',value:S.from,'aria-label':'من تاريخ',onchange:e=>{S.from=e.target.value;resetPage();draw()}});
  const to=el('input',{type:'date',value:S.to,'aria-label':'إلى تاريخ',onchange:e=>{S.to=e.target.value;resetPage();draw()}});
  const dates=el('div',{class:'filters'},el('label',{class:'field datef'},el('span',{},'من تاريخ'),from),el('label',{class:'field datef'},el('span',{},'إلى تاريخ'),to));
  const whSel=el('select',{'aria-label':'المخزن',onchange:e=>{S.wh=e.target.value;resetPage();draw()}},el('option',{value:''},'كل المخازن'),whs.map(w=>el('option',{value:w.WarehouseID},w.Name+(w.Active===false?' (معطل)':''))));
  whSel.value=S.wh;
  const typeSel=el('select',{'aria-label':'نوع الحركة',onchange:e=>{S.type=e.target.value;resetPage();draw()}},el('option',{value:''},'كل الأنواع'),TYPES.map(t=>el('option',{value:t[0]},t[1])));
  typeSel.value=S.type;
  const hz=el('input',{type:'checkbox',checked:S.hideZero,onchange:e=>{S.hideZero=e.target.checked;resetPage();draw()}});
  const hzWrap=el('label',{class:'chk'},hz,'إخفاء الأصناف الصفرية');
  const pq=el('input',{type:'search',class:'psearch',placeholder:'فلتر بصنف: اكتب الكود أو الاسم…',autocomplete:'off','aria-label':'فلتر الصنف'});
  const pres=el('div',{class:'results'}),chip=el('div',{class:'rep-chip'});
  function drawProd(){
    const p=S.prod&&pById.get(S.prod);
    chip.replaceChildren(...(p?[el('b',{},`${p.Name||'(بدون اسم)'} · ${p.Code}`),el('button',{class:'x',type:'button','aria-label':'إلغاء فلتر الصنف',onclick:()=>{S.prod='';resetPage();drawProd();draw()}},'✕')]:[]));
    chip.hidden=!p;pq.hidden=!!p;pres.replaceChildren();
  }
  pq.addEventListener('input',()=>{
    const toks=norm(pq.value).split(' ').filter(Boolean);if(!toks.length){pres.replaceChildren();return}
    const r=prods.filter(p=>toks.every(k=>p._hay.includes(k)||p._code.includes(compact(k)))).slice(0,8);
    pres.replaceChildren(...(r.length?r.map(p=>el('button',{class:'rbtn',type:'button',onclick:()=>{S.prod=p.ProductID;pq.value='';resetPage();drawProd();draw()}},
      el('b',{},p.Name||'(بدون اسم)'),el('span',{dir:'ltr',class:'code'},p.Code),el('small',{},p.Category))):[el('p',{class:'empty'},'مفيش صنف بالاسم/الكود ده')]));
  });
  const reset=el('button',{class:'btn ghost',type:'button',onclick:()=>{
    Object.assign(S,{...newState(),tab:S.tab});from.value=S.from;to.value=S.to;whSel.value='';typeSel.value='';hz.checked=true;drawProd();draw()}},'مسح الفلاتر');
  const warnDates=el('p',{class:'editwarn'},'تاريخ البداية بعد تاريخ النهاية — مفيش نتايج.');
  const body=el('div',{});
  function draw(){
    dates.hidden=S.tab==='stock';typeSel.hidden=S.tab!=='moves';hzWrap.hidden=S.tab!=='stock';
    warnDates.hidden=!(S.tab!=='stock'&&S.from&&S.to&&S.from>S.to);
    const nodes=S.tab==='sales'?renderSales():S.tab==='stock'?renderStock():renderMoves();
    body.replaceChildren(...nodes.flat().filter(Boolean));
  }
  $('#app').replaceChildren(el('div',{class:'wrap rep'},
    el('div',{class:'hello'},el('h2',{},'التقارير'),el('button',{class:'btn ghost',type:'button',onclick:onBack},'رجوع')),
    tabs,dates,warnDates,el('div',{class:'filters'},whSel,typeSel,hzWrap,reset),pq,chip,pres,body));
  drawProd();draw();
}
