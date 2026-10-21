// شاشة «مستندات المخزن»: كل مستندات الاستلام والصرف + تفاصيل حركاتها + إلغاء (بصلاحية المدير) بحركات عكسية — مفيش حاجة بتتمسح.
import {all,byIndex,txRun,uuid,ymd,deviceId} from './db.js';
import {can} from './auth.js';
import {norm} from './products.js';
import {$,el,toast,fmt,modal,askReason} from './ui.js';
import {voidStockDoc} from './reversal.js';
import {voidTransfer} from './transfers.js';
import {transferPanel} from './transfer-pdf.js';

const TYPE_AR={STOCK_IN:'استلام',STOCK_OUT:'صرف',TRANSFER:'تحويل'};
const fdt=iso=>{const d=new Date(iso),p=n=>String(n).padStart(2,'0');return `${d.getFullYear()}/${p(d.getMonth()+1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`};

// مستندات اتعملت قبل ترقية DB v3 ماكانش ليها سجل مستند — بنبنيه من سجل العمليات (audit). آمن للتكرار.
export async function backfillStockDocs(){
  const [aud,docs]=await Promise.all([all('audit'),all('stock_docs')]);
  const have=new Set(docs.map(d=>d.DocID));
  const miss=aud.filter(a=>a.EntityType==='StockDoc'&&(a.Action==='STOCK_IN'||a.Action==='STOCK_OUT')&&!have.has(a.EntityID)&&a.DeviceID===deviceId());   // سجل عمليات جاي من جهاز تاني (بالمزامنة) مستنده الحقيقي بيتسحب مش بيتبنى هنا
  if(!miss.length)return 0;
  await txRun(['stock_docs','syncq'],t=>{
    for(const a of miss){
      let nv={};try{nv=JSON.parse(a.NewValue||'{}')}catch{}
      const ls=nv.lines||[];
      t.objectStore('stock_docs').put({DocID:a.EntityID,Number:`${a.Action==='STOCK_IN'?'SI':'SO'}-${ymd(new Date(a.DateTime))}-${a.EntityID.slice(0,4).toUpperCase()}`,Type:a.Action,
        WarehouseID:nv.warehouseId||'',DateTime:a.DateTime,UserID:a.UserID,UserName:a.UserName,DeviceID:a.DeviceID,Notes:a.Notes||'',Status:'POSTED',Legacy:true,
        LinesCount:ls.length,TotalPieces:ls.reduce((s,l)=>s+Math.abs(l.q||0),0),UpdatedAt:a.DateTime,SyncStatus:'PENDING'});
      t.objectStore('syncq').put({OpID:uuid(),Entity:'stock_docs',EntityID:a.EntityID,Status:'PENDING',CreatedAt:a.DateTime,Tries:0});
    }
  });
  return miss.length;
}

export async function showStockDocs(user,onBack){
  const canVoid=await can(user,'VoidStockDoc'),canOv=await can(user,'OverrideStock');
  await backfillStockDocs().catch(()=>{});
  const whs=new Map((await all('warehouses')).map(w=>[w.WarehouseID,w.Name]));
  const prods=new Map((await all('products')).map(p=>[p.ProductID,p]));
  let rows=[];const S={type:'',status:''};
  const q=el('input',{type:'search',class:'psearch',placeholder:'ابحث بالرقم أو الملاحظة أو الموظف…',autocomplete:'off','aria-label':'بحث في المستندات'});
  const sel=(label,key,opts)=>el('select',{'aria-label':label,onchange:e=>{S[key]=e.target.value;draw()}},opts.map(([v,t])=>el('option',{value:v},t)));
  const list=el('div',{class:'plist cust'}),count=el('div',{class:'pcount'});
  async function load(){rows=(await all('stock_docs')).sort((a,b)=>b.DateTime.localeCompare(a.DateTime));draw()}
  function draw(){
    const toks=norm(q.value).split(' ').filter(Boolean);
    const r=rows.filter(d=>(!S.type||d.Type===S.type)&&(!S.status||d.Status===S.status)
      &&toks.every(k=>norm(d.Number+' '+(d.Notes||'')+' '+(d.UserName||'')+' '+(whs.get(d.WarehouseID)||'')+' '+(whs.get(d.ToWarehouseID)||'')).includes(k)));
    count.textContent=`${fmt(r.length)} مستند`;
    list.replaceChildren(...(r.length?r.slice(0,100).map(d=>el('article',{class:'pcard ccard',tabindex:'0',role:'button',onclick:()=>details(d.DocID),onkeydown:e=>{if(e.key==='Enter')details(d.DocID)}},
      el('div',{class:'pbody'},el('h3',{},d.Type==='TRANSFER'?`تحويل · ${whs.get(d.WarehouseID)||'—'} ← ${whs.get(d.ToWarehouseID)||'—'}`:`${TYPE_AR[d.Type]||d.Type} · ${whs.get(d.WarehouseID)||'—'}`),
        el('div',{class:'pmeta'},el('span',{class:'code',dir:'ltr'},d.Number),d.Status==='VOID'&&el('span',{class:'bdg void'},'ملغي')),
        el('div',{class:'pstock'},`${fdt(d.DateTime)} · ${d.UserName||''} · ${fmt(d.LinesCount)} صنف · ${fmt(d.TotalPieces)} قطعة`)))):[el('p',{class:'empty'},rows.length?'مفيش مستند مطابق':'لسه ما فيش مستندات — سجّل أول استلام أو صرف')]));
  }
  q.addEventListener('input',draw);
  async function details(docId){
    const d=(await all('stock_docs')).find(x=>x.DocID===docId);if(!d)return;
    const ms=(await byIndex('movements','ReferenceID',docId)).sort((a,b)=>a.DateTime.localeCompare(b.DateTime));
    const orig=ms.filter(m=>m.MovementType!=='VOID_REVERSAL'),rev=ms.filter(m=>m.MovementType==='VOID_REVERSAL');
    const row=(k,v)=>el('div',{class:'drow'},el('span',{},k),el('b',{dir:'auto'},v||'—'));
    const isTr=d.Type==='TRANSFER';
    const mrow=m=>el('div',{class:'drow'},el('span',{},`${prods.get(m.ProductID)?.Name||m.ProductID} · ${prods.get(m.ProductID)?.Code||''}`+(isTr?` · ${whs.get(m.WarehouseID)||''}`:'')),el('b',{dir:'ltr'},(m.QuantityPieces>0?'+':'')+fmt(m.QuantityPieces)));
    const isVoid=d.Status==='VOID';
    // مستند التحويل A4 (يتجهّز عند الضغط): الأصناف من حركات TRANSFER_IN
    const trPanel=d.Type==='TRANSFER'?transferPanel(d,orig.filter(m=>m.MovementType==='TRANSFER_IN').map(m=>({Code:prods.get(m.ProductID)?.Code||'',Name:prods.get(m.ProductID)?.Name||m.ProductID,Qty:m.QuantityPieces})),
      {from:whs.get(d.WarehouseID)||'—',to:whs.get(d.ToWarehouseID)||'—'}):[];
    const voidBtn=canVoid&&!isVoid?el('button',{class:'btn ghost danger',type:'button',onclick:()=>doVoid(d,close)},'إلغاء المستند'):null;
    const close=modal(`${TYPE_AR[d.Type]||''} ${d.Number}`,
      isVoid&&el('div',{class:'voidbox'},el('b',{},'مستند ملغي'),row('تاريخ الإلغاء',fdt(d.VoidedAt)),row('ألغاه',d.VoidedByName),row('السبب',d.VoidReason)),
      row('النوع',TYPE_AR[d.Type]),...(isTr?[row('من مخزن',whs.get(d.WarehouseID)),row('إلى مخزن',whs.get(d.ToWarehouseID))]:[row('المخزن',whs.get(d.WarehouseID))]),row('التاريخ',fdt(d.DateTime)),row('الموظف',d.UserName),d.Notes&&row('ملاحظة',d.Notes),
      el('h3',{class:'sec'},'الحركات (بالقطعة)'),...orig.map(mrow),
      rev.length>0&&el('h3',{class:'sec'},'الحركات العكسية (إلغاء)'),...rev.map(mrow),
      d.Legacy&&el('p',{class:'note'},'مستند قديم (قبل نسخة v7) — رقمه اتولّد من سجل العمليات.'),
      ...(isTr?trPanel:[]),
      !isVoid&&!canVoid&&el('p',{class:'note'},'إلغاء المستندات للمدير/المالك بس.'),voidBtn);
  }
  async function doVoid(d,closeDetails){
    const isTr=d.Type==='TRANSFER',doVoidFn=isTr?voidTransfer:voidStockDoc;
    const reason=await askReason('إلغاء المستند '+d.Number,isTr?'المستند هيفضل محفوظ بحالة «ملغي»، وهيتسجل عكس للحركتين: الكمية هترجع للمخزن المصدر وهتتسحب من مخزن الوجهة. مفيش حاجة بتتمسح.':'المستند هيفضل محفوظ بحالة «ملغي»، وهيتسجل عكس لكل حركاته على المخزن. مفيش حاجة بتتمسح.','تأكيد الإلغاء');
    if(!reason)return;
    let allow=false;
    for(;;){
      try{await doVoidFn({docId:d.DocID,reason,user,allowNegative:allow});closeDetails();toast('تم إلغاء المستند وعكس حركاته');await load();return}
      catch(e){
        if(e.code==='INSUFFICIENT'){
          const p=prods.get(e.productId),msg=`مينفعش تلغي: رصيد «${p?.Name||''}»${isTr?' في مخزن الوجهة':''} هيبقى بالسالب — المتاح ${fmt(e.available)} والمطلوب سحبه ${fmt(e.requested)}.`;
          if(canOv&&!allow&&window.confirm(msg+'\nتلغي برضه وتسمح بالرصيد بالسالب؟')){allow=true;continue}
          toast(msg);return;
        }
        toast(typeof e.code==='string'?e.message:'تعذر الإلغاء — حاول تاني');return;
      }
    }
  }
  $('#app').replaceChildren(el('div',{class:'wrap'},el('div',{class:'hello'},el('h2',{},'مستندات المخزن'),el('button',{class:'btn ghost',type:'button',onclick:onBack},'رجوع')),
    q,el('div',{class:'filters'},sel('النوع','type',[['','كل الأنواع'],['STOCK_IN','استلام'],['STOCK_OUT','صرف'],['TRANSFER','تحويل']]),sel('الحالة','status',[['','كل الحالات'],['POSTED','سارية'],['VOID','ملغية']])),count,list));
  await load();
}
