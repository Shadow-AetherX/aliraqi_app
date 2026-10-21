// نظام المراجعة والعكس (Audit Trail & Reversal) — «لا حذف نهائي»:
// كل إلغاء/تعديل/مرتجع = تغيير حالة أو مستند جديد + حركات مخزون (عكسية أو فرق) + سجل عمليات، كله في معاملة IndexedDB واحدة (يا كله يتكتب يا ولا حاجة).
// الصلاحيات هنا تحقق محلي للأوفلاين بس — الإنفاذ الحقيقي هيبقى في Apps Script وقت المزامنة.
import {txRun,uuid,nowISO,deviceId,ymd,toPieces,byIndex,all} from './db.js';
import {can} from './auth.js';

const r2=n=>Math.round((Number(n)+Number.EPSILON)*100)/100;
const E=(msg,code,extra)=>Object.assign(new Error(msg),{code},extra);
const need=async(user,perm)=>{if(!await can(user,perm))throw E('مفيش صلاحية للعملية دي','FORBIDDEN')};
const reasonOf=r=>{const s=String(r||'').trim();if(s.length<3)throw E('اكتب السبب (3 حروف على الأقل)','REASON');return s};
const aud=(user,action,entity,id,oldV,newV,notes,now,dev)=>({AuditID:uuid(),UserID:user.UserID,UserName:user.Name,Action:action,EntityType:entity,EntityID:id,DateTime:now,DeviceID:dev,
  OldValue:oldV==null?null:JSON.stringify(oldV),NewValue:newV==null?null:JSON.stringify(newV),Notes:notes||'',SyncStatus:'PENDING'});
const qput=(t,entity,id,now)=>t.objectStore('syncq').put({OpID:uuid(),Entity:entity,EntityID:id,Status:'PENDING',CreatedAt:now,Tries:0});
// معرّف الحركة العكسية حتمي: REV-<MovementID الأصلي>. لو جهازين عكسوا نفس الحركة أوفلاين، الاتنين بيطلعوا بنفس المفتاح → المزامنة (once) بتخلّيها حركة واحدة بدل عكس مضاعف.
export const revId=id=>'REV-'+id;
// الحركات اللي لسه محتاجة عكس: بنستبعد الحركات العكسية نفسها، وأي حركة ليها REV- موجود (محلي أو جاي من جهاز تاني بالمزامنة).
export function pendingReversals(all){
  const done=new Set(all.filter(m=>m.ReversalOf).map(m=>m.ReversalOf));
  return all.filter(m=>m.MovementType!=='VOID_REVERSAL'&&m.QuantityPieces!==0&&!m.ReversalOf&&!done.has(m.MovementID));
}
function mvPut(t,{productId,warehouseId,type,qty,ref,user,dev,now,notes,reversalOf}){
  const m={MovementID:reversalOf?revId(reversalOf):uuid(),DateTime:now,ProductID:productId,WarehouseID:warehouseId,MovementType:type,QuantityPieces:qty,ReferenceID:ref,
    UserID:user.UserID,DeviceID:dev,SyncStatus:'PENDING',Notes:notes};
  if(reversalOf)m.ReversalOf=reversalOf;
  t.objectStore('movements').put(m);qput(t,'movements',m.MovementID,now);return m;
}
// تسلسل يومي لكل جهاز (نفس فكرة ترقيم الفواتير): بيرجّع PREFIX-YYYYMMDD-DEV-0001
function nextNumber(t,prefix,now,dev,cb){
  const key=`${prefix}seq:${dev}:${ymd(new Date(now))}`,st=t.objectStore('settings');
  st.get(key).onsuccess=e=>{const n=(e.target.result?.value||0)+1;st.put({key,value:n});
    cb(`${prefix.toUpperCase()}-${ymd(new Date(now))}-${dev.replace(/^D-/,'')}-${String(n).padStart(4,'0')}`)};
}
// يتأكد إن رصيد كل صنف في المخزن >= المطلوب سحبه (need: Map productId->pieces). لو لأ: fail(INSUFFICIENT) وكل حاجة بتتلغي.
function checkStock(t,warehouseId,needMap,fail,onOk){
  if(!needMap.size)return onOk();
  let left=needMap.size;
  for(const [pid,q] of needMap){
    t.objectStore('movements').index('ProductID').getAll(pid).onsuccess=e=>{
      const avail=e.target.result.filter(m=>m.WarehouseID===warehouseId).reduce((s,m)=>s+m.QuantityPieces,0);
      if(avail<q){fail(E('الرصيد مش كفاية','INSUFFICIENT',{productId:pid,available:avail,requested:q}));return}
      if(--left===0)onOk();
    };
  }
}
const sigOf=ls=>JSON.stringify(ls.map(l=>[l.ProductID,l.TotalPieces,l.UnitPrice]).sort());

// ---------- قراءات مساعدة ----------
export const liveLines=async id=>(await byIndex('invoice_lines','InvoiceID',id)).filter(l=>!l.Superseded).sort((a,b)=>a.LineNo-b.LineNo);
// اللي اتعمل له مرتجع قبل كده: Map(lineId -> pieces)
export async function returnedByLine(invoiceId){
  const m=new Map();for(const l of await byIndex('credit_note_lines','ParentInvoiceID',invoiceId))m.set(l.ParentLineID,(m.get(l.ParentLineID)||0)+l.TotalPieces);return m;
}

// ================= إلغاء فاتورة =================
// Status='VOID' + حركة VOID_REVERSAL عكسية (نفس القيمة بإشارة معاكسة) لكل حركة أصلية (الصرف الأصلي + أي INVOICE_ADJUST). ممنوع لو عليها مرتجع.
export async function voidInvoice({invoiceId,reason,user}){
  await need(user,'CancelInvoice');reason=reasonOf(reason);
  const now=nowISO(),dev=deviceId();
  return txRun(['invoices','credit_notes','movements','syncq','audit'],(t,fail,setOut)=>{
    t.objectStore('invoices').get(invoiceId).onsuccess=e=>{
      const inv=e.target.result;
      if(!inv)return fail(E('الفاتورة مش موجودة','NOT_FOUND'));
      if(inv.Status==='VOID')return fail(E('الفاتورة ملغاة بالفعل','ALREADY_VOID'));
      t.objectStore('credit_notes').index('ParentInvoiceID').getAll(invoiceId).onsuccess=e2=>{
        if(e2.target.result.length)return fail(E('الفاتورة دي عليها مرتجع — ممنوع إلغاؤها','HAS_RETURN'));
        t.objectStore('movements').index('ReferenceID').getAll(invoiceId).onsuccess=e3=>{
          const orig=pendingReversals(e3.target.result);
          for(const m of orig)mvPut(t,{productId:m.ProductID,warehouseId:m.WarehouseID,type:'VOID_REVERSAL',qty:-m.QuantityPieces,ref:invoiceId,user,dev,now,
            notes:'إلغاء فاتورة '+inv.Number,reversalOf:m.MovementID});
          const v={...inv,Status:'VOID',VoidedAt:now,VoidedBy:user.UserID,VoidedByName:user.Name,VoidReason:reason,UpdatedAt:now,SyncStatus:'PENDING'};
          t.objectStore('invoices').put(v);qput(t,'invoices',invoiceId,now);
          t.objectStore('audit').put(aud(user,'INVOICE_VOID','Invoice',invoiceId,{Status:inv.Status,Total:inv.Total},{Status:'VOID',number:inv.Number,reversals:orig.length},reason,now,dev));
          setOut(v);
        };
      };
    };
  });
}

// ================= إلغاء مستند استلام/صرف =================
// نفس المبدأ. إلغاء استلام = سحب من الرصيد، فبنفحص إن الرصيد يكفي (إلا لو allowNegative ومعاك OverrideStock).
export async function voidStockDoc({docId,reason,user,allowNegative=false}){
  await need(user,'VoidStockDoc');reason=reasonOf(reason);
  allowNegative=!!allowNegative&&await can(user,'OverrideStock');
  const now=nowISO(),dev=deviceId();
  return txRun(['stock_docs','movements','syncq','audit'],(t,fail,setOut)=>{
    t.objectStore('stock_docs').get(docId).onsuccess=e=>{
      const d=e.target.result;
      if(!d)return fail(E('المستند مش موجود','NOT_FOUND'));
      if(d.Type==='TRANSFER')return fail(E('ده مستند تحويل بين مخازن — الإلغاء بيتم من شاشة التحويلات (voidTransfer) عشان فحص الرصيد يتعمل على مخزن الوجهة','USE_VOID_TRANSFER'));
      if(d.Status==='VOID')return fail(E('المستند ملغي بالفعل','ALREADY_VOID'));
      t.objectStore('movements').index('ReferenceID').getAll(docId).onsuccess=e2=>{
        const orig=pendingReversals(e2.target.result);
        const write=()=>{
          for(const m of orig)mvPut(t,{productId:m.ProductID,warehouseId:m.WarehouseID,type:'VOID_REVERSAL',qty:-m.QuantityPieces,ref:docId,user,dev,now,
            notes:'إلغاء مستند '+d.Number,reversalOf:m.MovementID});
          const v={...d,Status:'VOID',VoidedAt:now,VoidedBy:user.UserID,VoidedByName:user.Name,VoidReason:reason,UpdatedAt:now,SyncStatus:'PENDING'};
          t.objectStore('stock_docs').put(v);qput(t,'stock_docs',docId,now);
          t.objectStore('audit').put(aud(user,'STOCKDOC_VOID','StockDoc',docId,{Status:d.Status},{Status:'VOID',number:d.Number,type:d.Type,reversals:orig.length,allowNegative},reason,now,dev));
          setOut(v);
        };
        // اللي هيتسحب من الرصيد (إلغاء الاستلام): المجموع لكل صنف
        const needMap=new Map();
        if(!allowNegative)for(const m of orig)if(m.QuantityPieces>0)needMap.set(m.ProductID,(needMap.get(m.ProductID)||0)+m.QuantityPieces);
        checkStock(t,d.WarehouseID,needMap,fail,write);
      };
    };
  });
}

// ================= مرتجع (Credit Note) =================
// items: [{lineId,cartons,pieces}] — بسعر البيع الأصلي، ويرجع لنفس مخزن الفاتورة. جزئي أو كلي، ومينفعش يزيد عن اللي اتباع ناقص اللي اترجّع قبل كده.
export async function createCreditNote({invoiceId,items,reason,user}){
  await need(user,'CreateReturn');reason=reasonOf(reason);
  const req=(items||[]).map(i=>({lineId:i.lineId,cartons:Number(i.cartons)||0,pieces:Number(i.pieces)||0})).filter(i=>i.cartons+i.pieces>0);
  if(!req.length)throw E('اختار كمية للمرتجع','EMPTY');
  for(const r of req)if(!Number.isInteger(r.cartons)||!Number.isInteger(r.pieces)||r.cartons<0||r.pieces<0)throw E('كمية غير صالحة','BAD_QTY');
  const now=nowISO(),dev=deviceId(),cnId=uuid();
  return txRun(['invoices','invoice_lines','credit_notes','credit_note_lines','movements','syncq','audit','settings'],(t,fail,setOut)=>{
    t.objectStore('invoices').get(invoiceId).onsuccess=e=>{
      const inv=e.target.result;
      if(!inv)return fail(E('الفاتورة مش موجودة','NOT_FOUND'));
      if(inv.Status!=='POSTED')return fail(E('مينفعش مرتجع على فاتورة ملغاة','VOID_INVOICE'));
      t.objectStore('invoice_lines').index('InvoiceID').getAll(invoiceId).onsuccess=e2=>{
        const lines=e2.target.result.filter(l=>!l.Superseded);
        t.objectStore('credit_note_lines').index('ParentInvoiceID').getAll(invoiceId).onsuccess=e3=>{
          const ret=new Map();for(const x of e3.target.result)ret.set(x.ParentLineID,(ret.get(x.ParentLineID)||0)+x.TotalPieces);
          const cnLines=[];let i=0;
          for(const r of req){
            const l=lines.find(x=>x.LineID===r.lineId);
            if(!l)return fail(E('صنف مش موجود في الفاتورة','BAD_LINE'));
            const pcs=l.PcsPerCarton||0;
            if(r.cartons>0&&!pcs)return fail(E('عدد القطع في الكرتونة غير محدد — المرتجع بالقطعة','BAD_QTY'));
            const tp=toPieces(r.cartons,r.pieces,pcs),rem=l.TotalPieces-(ret.get(l.LineID)||0);
            if(tp>rem)return fail(E(`الكمية أكبر من المتاح للمرتجع للصنف «${l.Name}» (المتاح ${rem})`,'OVER_RETURN',{lineId:l.LineID,remaining:rem,requested:tp}));
            cnLines.push({LineID:uuid(),CreditNoteID:cnId,ParentInvoiceID:invoiceId,ParentLineID:l.LineID,LineNo:++i,ProductID:l.ProductID,Code:l.Code,Name:l.Name,
              Cartons:r.cartons,Pieces:r.pieces,PcsPerCarton:pcs,TotalPieces:tp,UnitPrice:l.UnitPrice,LineTotal:r2(tp*l.UnitPrice),
              ...('UnitCost' in l?{UnitCost:l.UnitCost}:{})});   // المرتجع بنفس تكلفة البيع الأصلي (سطر قديم قبل v14.1 مالوش UnitCost فبيفضل من غيرها)
          }
          nextNumber(t,'cn',now,dev,number=>{
            const total=r2(cnLines.reduce((s,l)=>s+l.LineTotal,0)),pcsAll=cnLines.reduce((s,l)=>s+l.TotalPieces,0);
            const cn={CreditNoteID:cnId,Number:number,DocKind:'CREDIT',ParentInvoiceID:invoiceId,ParentNumber:inv.Number,ParentVersion:inv.Version||1,DateTime:now,
              CustomerID:inv.CustomerID,CustomerName:inv.CustomerName,CustomerPhone:inv.CustomerPhone||'',CustomerAddress:inv.CustomerAddress||'',
              WarehouseID:inv.WarehouseID,Status:'POSTED',Total:total,ItemsCount:cnLines.length,TotalPieces:pcsAll,Reason:reason,
              UserID:user.UserID,UserName:user.Name,DeviceID:dev,UpdatedAt:now,SyncStatus:'PENDING'};
            t.objectStore('credit_notes').put(cn);qput(t,'credit_notes',cnId,now);
            for(const l of cnLines){
              t.objectStore('credit_note_lines').put(l);qput(t,'credit_note_lines',l.LineID,now);
              mvPut(t,{productId:l.ProductID,warehouseId:inv.WarehouseID,type:'RETURN',qty:l.TotalPieces,ref:cnId,user,dev,now,notes:`مرتجع ${number} عن فاتورة ${inv.Number}`});
            }
            t.objectStore('audit').put(aud(user,'CREDIT_NOTE_CREATE','CreditNote',cnId,null,
              {number,parent:inv.Number,warehouseId:inv.WarehouseID,total,lines:cnLines.map(l=>({p:l.ProductID,q:l.TotalPieces,price:l.UnitPrice}))},reason,now,dev));
            setOut({cn,lines:cnLines});
          });
        };
      };
    };
  });
}

// ================= تعديل فاتورة =================
// items: [{p:المنتج,cartons,pieces,unitPrice,ppc?}] — الكميات/الأسعار/إضافة وحذف أصناف. ppc (v23.1) = عدد القطع في الكرتونة المجمّد في سطر الفاتورة وقت البيع: لو اتبعت بيتحسب بيه (حتى لو الصنف اتغيّر عدد قطعه بعد كده)، ولو مش متبعت (صنف جديد في الفاتورة) بيتحسب بالعدد الحالي للصنف. بيتحفظ: نسخة الفاتورة القديمة في invoice_revisions، البنود القديمة بتتعلّم Superseded (مش بتتمسح)،
// Version+1 بنفس الرقم، وفي المخزن الفرق بس (INVOICE_ADJUST). مسموح حتى لو عليها مرتجع بشرط إن الكمية الجديدة لكل صنف ما تقلّش عن اللي اترجّع منه (الصافي ≥ 0)؛ ممنوع لو ملغاة.
// الصنف الباقي بيحتفظ بنفس LineID (عشان المرتجعات السابقة تفضل مربوطة ببنده)، والصنف المحذوف بيتعلّم Superseded.
export async function editInvoice({invoiceId,items,reason,user,allowNegative=false}){
  await need(user,'EditInvoice');reason=reasonOf(reason);
  allowNegative=!!allowNegative&&await can(user,'OverrideStock');
  if(!items?.length)throw E('مفيش أصناف في الفاتورة','EMPTY');
  const now=nowISO(),dev=deviceId(),seen=new Set();
  const nl=items.map((it,i)=>{
    const pcs=it.ppc??(it.p.PcsPerCarton||0);
    if(!Number.isInteger(pcs)||pcs<0)throw E('عدد القطع في الكرتونة غير صالح','BAD_QTY');
    const tp=toPieces(it.cartons,it.pieces,pcs),price=Number(it.unitPrice);
    if(seen.has(it.p.ProductID))throw E('صنف متكرر','DUP');seen.add(it.p.ProductID);
    if(!Number.isInteger(tp)||tp<=0)throw E('كمية غير صالحة','BAD_QTY');
    if(!(price>0))throw E('سعر غير صالح','BAD_PRICE');
    return {LineID:uuid(),InvoiceID:invoiceId,LineNo:i+1,ProductID:it.p.ProductID,Code:it.p.Code,Name:it.p.Name||'',Cartons:it.cartons,Pieces:it.pieces,
      PcsPerCarton:pcs,TotalPieces:tp,OriginalUnitPrice:it.p.PricePiece||null,UnitPrice:price,PriceChanged:false,LineTotal:r2(tp*price),
      UnitCost:typeof it.p.Cost==='number'&&Number.isFinite(it.p.Cost)?it.p.Cost:null,UpdatedAt:now};
  });
  return txRun(['invoices','invoice_lines','invoice_revisions','credit_note_lines','movements','syncq','audit'],(t,fail,setOut)=>{
    t.objectStore('invoices').get(invoiceId).onsuccess=e=>{
      const inv=e.target.result;
      if(!inv)return fail(E('الفاتورة مش موجودة','NOT_FOUND'));
      if(inv.Status!=='POSTED')return fail(E('مينفعش تعديل فاتورة ملغاة','VOID_INVOICE'));
      t.objectStore('credit_note_lines').index('ParentInvoiceID').getAll(invoiceId).onsuccess=e2=>{
        const retBy=new Map();for(const x of e2.target.result)retBy.set(x.ProductID,(retBy.get(x.ProductID)||0)+x.TotalPieces);   // اللي اترجّع لكل صنف
        t.objectStore('invoice_lines').index('InvoiceID').getAll(invoiceId).onsuccess=e3=>{
          const old=e3.target.result.filter(l=>!l.Superseded).sort((a,b)=>a.LineNo-b.LineNo);
          const oldBy=new Map(old.map(l=>[l.ProductID,l]));
          for(const l of nl){                                   // السعر الأصلي يفضل زي ما اتسجل وقت البيع لو الصنف كان في الفاتورة
            const o=oldBy.get(l.ProductID);if(o){l.OriginalUnitPrice=o.OriginalUnitPrice??null;l.LineID=o.LineID;if('UnitCost' in o)l.UnitCost=o.UnitCost;else delete l.UnitCost}   // الصنف الباقي بيحتفظ بتكلفة وقت البيع الأصلي
            l.PriceChanged=l.OriginalUnitPrice!==null&&l.OriginalUnitPrice!==l.UnitPrice;
          }
          for(const [pid,r] of retBy){                           // حد الصافي: مينفعش الكمية الجديدة تقل عن المرتجع (ولا حذف صنف اترجّع منه)
            const nt=nl.find(l=>l.ProductID===pid)?.TotalPieces||0;
            if(nt<r)return fail(E(`الكمية الجديدة أقل من اللي اترجّع من الصنف (${r} قطعة) — الصافي مينفعش يبقى بالسالب`,'BELOW_RETURNED',{productId:pid,returned:r}));
          }
          const diffs=new Map();
          for(const pid of new Set([...old.map(l=>l.ProductID),...nl.map(l=>l.ProductID)])){
            const d=(nl.find(l=>l.ProductID===pid)?.TotalPieces||0)-(oldBy.get(pid)?.TotalPieces||0);if(d)diffs.set(pid,d);
          }
          if(!diffs.size&&sigOf(old)===sigOf(nl))return fail(E('مفيش أي تغيير عن النسخة الحالية','NO_CHANGE'));
          const needMap=new Map();if(!allowNegative)for(const [pid,d] of diffs)if(d>0)needMap.set(pid,d);   // الزيادة بس هي اللي بتتفحص
          checkStock(t,inv.WarehouseID,needMap,fail,()=>{
            const ver=inv.Version||1,total=r2(nl.reduce((s,l)=>s+l.LineTotal,0)),pcsAll=nl.reduce((s,l)=>s+l.TotalPieces,0);
            const rev={RevisionID:uuid(),InvoiceID:invoiceId,Number:inv.Number,Version:ver,Snapshot:{invoice:inv,lines:old},ReplacedAt:now,
              UserID:user.UserID,UserName:user.Name,DeviceID:dev,Reason:reason,SyncStatus:'PENDING'};
            t.objectStore('invoice_revisions').put(rev);qput(t,'invoice_revisions',rev.RevisionID,now);
            const keep=new Set(nl.map(l=>l.ProductID));
            for(const o of old)if(!keep.has(o.ProductID)){t.objectStore('invoice_lines').put({...o,Superseded:true,SupersededAtVersion:ver+1,UpdatedAt:now});qput(t,'invoice_lines',o.LineID,now)}
            for(const l of nl){t.objectStore('invoice_lines').put(l);qput(t,'invoice_lines',l.LineID,now)}
            for(const [pid,d] of diffs)mvPut(t,{productId:pid,warehouseId:inv.WarehouseID,type:'INVOICE_ADJUST',qty:-d,ref:invoiceId,user,dev,now,
              notes:`تعديل فاتورة ${inv.Number} (نسخة ${ver+1})`});
            const upd={...inv,Version:ver+1,Total:total,ItemsCount:nl.length,TotalPieces:pcsAll,UpdatedAt:now,EditedAt:now,EditedBy:user.UserID,EditedByName:user.Name,SyncStatus:'PENDING'};
            t.objectStore('invoices').put(upd);qput(t,'invoices',invoiceId,now);
            const brief=(ls,v,tot)=>({version:v,total:tot,lines:ls.map(l=>({p:l.ProductID,q:l.TotalPieces,price:l.UnitPrice}))});
            t.objectStore('audit').put(aud(user,'INVOICE_EDIT','Invoice',invoiceId,brief(old,ver,inv.Total),{...brief(nl,ver+1,total),number:inv.Number,adjust:[...diffs].map(([p,q])=>({p,q:-q}))},reason,now,dev));
            setOut({inv:upd,lines:nl});
          });
        };
      };
    };
  });
}

// ================= مصالحة الإلغاء بعد المزامنة =================
// لو جهاز عدّل فاتورة/مستند (INVOICE_ADJUST) أوفلاين بعد ما جهاز تاني ألغاه، حركة التعديل بتوصل للسيرفر لوحدها (once) والإلغاء ما كانش شايفها — فتفضل من غير عكس.
// هنا بنلف على المستندات الملغاة بس ونعكس أي حركة لسه من غير REV- (وكمان حركات مرتجعات الفواتير الملغاة — v23.1). المعرّف الحتمي بيخلّي أكتر من جهاز يعملوها في نفس الوقت من غير تكرار. بتتنادى من sync.js بعد السحب.
// v23.1 (بند 3.1): مرتجع على فاتورة ملغاة. voidInvoice بيمنع الإلغاء لو على الفاتورة مرتجع، لكن لو جهاز ألغى وجهاز تاني عمل مرتجع والاتنين أوفلاين، الاتنين بينجحوا.
// حركة المرتجع (RETURN، ReferenceID = رقم المرتجع) كانت بتفضل في المخزن (10 اتباعوا و4 اترجعوا ثم إلغاء ← رصيد 104 بدل 100).
// هنا بنعكس حركات المرتجع (REV- حتمي، فجهازين يعملوها مع بعض = حركة واحدة) وبنعلّم المرتجع Status='VOID' (كشف الحساب والتقارير بيتجاهلوا VOID).
// UpdatedAt للمرتجع بيتحط أحدث من القديم بمللي ثانية على الأقل: المزامنة «الأحدث يكسب» للمرتجعات، فلو ساعة الجهاز متأخرة الإلغاء ما يخسرش.
const laterISO=(a,b)=>{const x=Date.parse(a)||0,y=(Date.parse(b)||0)+1;return new Date(Math.max(x,y)).toISOString()};
async function reconcileCreditNote(inv,cnId){
  const sys={UserID:'SYSTEM',Name:'مزامنة تلقائية'},now=nowISO(),dev=deviceId();
  return (await txRun(['credit_notes','movements','syncq','audit'],(t,fail,setOut)=>{
    t.objectStore('credit_notes').get(cnId).onsuccess=e0=>{
      const cn=e0.target.result;
      if(!cn)return setOut(0);
      t.objectStore('movements').index('ReferenceID').getAll(cnId).onsuccess=e=>{
        const orig=pendingReversals(e.target.result),needVoid=cn.Status!=='VOID';                // نعيد الحساب جوه المعاملة
        if(!orig.length&&!needVoid)return setOut(0);
        for(const m of orig)mvPut(t,{productId:m.ProductID,warehouseId:m.WarehouseID,type:'VOID_REVERSAL',qty:-m.QuantityPieces,ref:cnId,user:sys,dev,now,
          notes:'مصالحة: مرتجع '+(cn.Number||'')+' على فاتورة ملغاة '+(inv.Number||''),reversalOf:m.MovementID});
        if(needVoid){
          t.objectStore('credit_notes').put({...cn,Status:'VOID',VoidedAt:now,VoidedBy:sys.UserID,VoidedByName:sys.Name,
            VoidReason:'الفاتورة الأصلية '+(inv.Number||'')+' اتلغت',UpdatedAt:laterISO(now,cn.UpdatedAt),SyncStatus:'PENDING'});
          qput(t,'credit_notes',cnId,now);
        }
        t.objectStore('audit').put(aud(sys,'CN_VOID_RECONCILE','CreditNote',cnId,needVoid?{Status:cn.Status}:null,{number:cn.Number||null,invoice:inv.Number||null,reversals:orig.length,voided:needVoid},'مصالحة بعد المزامنة',now,dev));
        setOut(orig.length+(needVoid?1:0));
      };
    };
  }))||0;
}
export async function reconcileVoids(){
  const sys={UserID:'SYSTEM',Name:'مزامنة تلقائية'},voided=[];
  for(const store of ['invoices','stock_docs']){
    let rows;try{rows=await byIndex(store,'Status','VOID')}catch{rows=(await all(store)).filter(r=>r.Status==='VOID')}
    for(const d of rows)voided.push({store,d});
  }
  let fixed=0;
  for(const {store,d} of voided){
    const id=d[store==='invoices'?'InvoiceID':'DocID'];
    if(!pendingReversals(await byIndex('movements','ReferenceID',id)).length)continue;     // فحص سريع برّه المعاملة
    const now=nowISO(),dev=deviceId();
    fixed+=(await txRun(['movements','syncq','audit'],(t,fail,setOut)=>{
      t.objectStore('movements').index('ReferenceID').getAll(id).onsuccess=e=>{
        const orig=pendingReversals(e.target.result);                               // نعيد الحساب جوه المعاملة
        if(!orig.length)return setOut(0);
        for(const m of orig)mvPut(t,{productId:m.ProductID,warehouseId:m.WarehouseID,type:'VOID_REVERSAL',qty:-m.QuantityPieces,ref:id,user:sys,dev,now,notes:'مصالحة إلغاء '+(d.Number||''),reversalOf:m.MovementID});
        t.objectStore('audit').put(aud(sys,'VOID_RECONCILE',store==='invoices'?'Invoice':'StockDoc',id,null,{number:d.Number||null,reversals:orig.length},'مصالحة بعد المزامنة',now,dev));
        setOut(orig.length);
      };
    }))||0;
  }
  // مرتجعات الفواتير الملغاة (بند 3.1): نتخطى بس المرتجع الملغي اللي مفيش عليه حركات محتاجة عكس
  for(const {store,d} of voided){
    if(store!=='invoices')continue;
    for(const cn of await byIndex('credit_notes','ParentInvoiceID',d.InvoiceID)){
      if(cn.Status==='VOID'&&!pendingReversals(await byIndex('movements','ReferenceID',cn.CreditNoteID)).length)continue;     // فحص سريع برّه المعاملة
      fixed+=await reconcileCreditNote(d,cn.CreditNoteID);
    }
  }
  return fixed;
}
