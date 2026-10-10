// تحويل مخزون بين مخزنين (v11): مستند واحد (stock_docs بـ Type='TRANSFER') + حركتين لكل صنف بنفس TransferID:
//   TRANSFER_OUT (سالب) من المخزن المصدر، و TRANSFER_IN (موجب) للمخزن الوجهة.
// كله في معاملة IndexedDB واحدة (يا كله يتكتب يا ولا حاجة). مفيش حاجة بتتمسح — الإلغاء = حركات عكسية VOID_REVERSAL.
// الصلاحيات هنا تحقق محلي للأوفلاين بس — الإنفاذ الحقيقي هيبقى في Apps Script وقت المزامنة.
import {get,txRun,uuid,nowISO,deviceId,ymd} from './db.js';
import {can} from './auth.js';

const E=(msg,code,extra)=>Object.assign(new Error(msg),{code},extra);
const qput=(t,id,entity,now)=>t.objectStore('syncq').put({OpID:uuid(),Entity:entity,EntityID:id,Status:'PENDING',CreatedAt:now,Tries:0});
const aud=(u,action,id,oldV,newV,notes,now,dev)=>({AuditID:uuid(),UserID:u.UserID,UserName:u.Name,Action:action,EntityType:'StockDoc',EntityID:id,DateTime:now,DeviceID:dev,
  OldValue:oldV==null?null:JSON.stringify(oldV),NewValue:newV==null?null:JSON.stringify(newV),Notes:notes||'',SyncStatus:'PENDING'});
function mv(t,{productId,warehouseId,type,qty,docId,u,dev,now,notes,reversalOf}){
  const m={MovementID:uuid(),DateTime:now,ProductID:productId,WarehouseID:warehouseId,MovementType:type,QuantityPieces:qty,ReferenceID:docId,TransferID:docId,
    UserID:u.UserID,DeviceID:dev,SyncStatus:'PENDING',Notes:notes};
  if(reversalOf)m.ReversalOf=reversalOf;
  t.objectStore('movements').put(m);qput(t,m.MovementID,'movements',now);
}
// يتأكد إن رصيد كل صنف في المخزن >= المطلوب سحبه (needMap: productId -> pieces). لو لأ: fail(INSUFFICIENT).
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
// ترقيم: TR-YYYYMMDD-جهاز-0001 (تسلسل يومي لكل جهاز، مش بيتعارض بين الأجهزة)
function nextNumber(t,now,dev,cb){
  const key=`trseq:${dev}:${ymd(new Date(now))}`,st=t.objectStore('settings');
  st.get(key).onsuccess=e=>{const n=(e.target.result?.value||0)+1;st.put({key,value:n});
    cb(`TR-${ymd(new Date(now))}-${dev.replace(/^D-/,'')}-${String(n).padStart(4,'0')}`)};
}

// lines: [{productId,qtyPieces}] — بالقطعة. بيرجّع {docId,number,count,doc}
export async function postTransfer({fromId,toId,lines,user,notes='',allowNegative=false}){
  const u=await get('users',user?.UserID);                                      // نعيد قراءة المستخدم من القاعدة مش من الجلسة
  if(!u||!u.Active||!await can(u,'StockTransfer'))throw E('مفيش صلاحية التحويل بين المخازن','FORBIDDEN');
  allowNegative=!!allowNegative&&await can(u,'OverrideStock');
  if(!fromId||!toId)throw E('اختار المخزن المصدر والمخزن الوجهة','NO_WH');
  if(fromId===toId)throw E('المخزن المصدر والوجهة لازم يكونوا مختلفين','SAME_WH');
  const merged=new Map();
  for(const l of lines||[]){if(!Number.isInteger(l.qtyPieces)||l.qtyPieces<=0)throw E('كمية غير صالحة','BAD_QTY');merged.set(l.productId,(merged.get(l.productId)||0)+l.qtyPieces)}
  if(!merged.size)throw E('مفيش أصناف في التحويل','EMPTY');
  const now=nowISO(),dev=deviceId(),docId=uuid();
  return txRun(['warehouses','movements','stock_docs','syncq','audit','settings'],(t,fail,setOut)=>{
    const ws=t.objectStore('warehouses');
    ws.get(fromId).onsuccess=e1=>{
      const a=e1.target.result;
      ws.get(toId).onsuccess=e2=>{
        const b=e2.target.result;
        if(!a||a.Active===false||!b||b.Active===false)return fail(E('أحد المخزنين غير متاح (معطل أو مش موجود)','BAD_WH'));
        const needMap=allowNegative?new Map():merged;
        checkStock(t,fromId,needMap,fail,()=>nextNumber(t,now,dev,number=>{
          const total=[...merged.values()].reduce((s,x)=>s+x,0);
          const doc={DocID:docId,TransferID:docId,Number:number,Type:'TRANSFER',WarehouseID:fromId,ToWarehouseID:toId,DateTime:now,UserID:u.UserID,UserName:u.Name,DeviceID:dev,
            Notes:notes,Status:'POSTED',LinesCount:merged.size,TotalPieces:total,UpdatedAt:now,SyncStatus:'PENDING'};
          t.objectStore('stock_docs').put(doc);qput(t,docId,'stock_docs',now);
          for(const [productId,q] of merged){
            mv(t,{productId,warehouseId:fromId,type:'TRANSFER_OUT',qty:-q,docId,u,dev,now,notes:`تحويل ${number} إلى ${b.Name}`});
            mv(t,{productId,warehouseId:toId,type:'TRANSFER_IN',qty:q,docId,u,dev,now,notes:`تحويل ${number} من ${a.Name}`});
          }
          t.objectStore('audit').put(aud(u,'STOCK_TRANSFER',docId,null,{number,from:fromId,to:toId,lines:[...merged].map(([p,q])=>({p,q})),allowNegative},notes,now,dev));
          setOut({docId,number,count:merged.size,doc});
        }));
      };
    };
  });
}

// إلغاء تحويل: حركات VOID_REVERSAL عكسية للحركتين (المصدر بيرجّع له رصيده، والوجهة بيتسحب منها). بيتمنع لو رصيد الوجهة مش كفاية (إلا لو allowNegative ومعاك OverrideStock).
export async function voidTransfer({docId,reason,user,allowNegative=false}){
  const u=await get('users',user?.UserID);
  if(!u||!u.Active||!await can(u,'VoidStockDoc'))throw E('مفيش صلاحية إلغاء مستندات المخزن','FORBIDDEN');
  reason=String(reason||'').trim();if(reason.length<3)throw E('اكتب السبب (3 حروف على الأقل)','REASON');
  allowNegative=!!allowNegative&&await can(u,'OverrideStock');
  const now=nowISO(),dev=deviceId();
  return txRun(['stock_docs','movements','syncq','audit'],(t,fail,setOut)=>{
    t.objectStore('stock_docs').get(docId).onsuccess=e=>{
      const d=e.target.result;
      if(!d||d.Type!=='TRANSFER')return fail(E('مستند التحويل مش موجود','NOT_FOUND'));
      if(d.Status==='VOID')return fail(E('المستند ملغي بالفعل','ALREADY_VOID'));
      t.objectStore('movements').index('ReferenceID').getAll(docId).onsuccess=e2=>{
        const orig=e2.target.result.filter(m=>m.MovementType!=='VOID_REVERSAL'&&m.QuantityPieces!==0);
        const needMap=new Map();                                                 // اللي هيتسحب من الوجهة (عكس TRANSFER_IN)
        if(!allowNegative)for(const m of orig)if(m.QuantityPieces>0)needMap.set(m.ProductID,(needMap.get(m.ProductID)||0)+m.QuantityPieces);
        checkStock(t,d.ToWarehouseID,needMap,fail,()=>{
          for(const m of orig)mv(t,{productId:m.ProductID,warehouseId:m.WarehouseID,type:'VOID_REVERSAL',qty:-m.QuantityPieces,docId,u,dev,now,notes:'إلغاء تحويل '+d.Number,reversalOf:m.MovementID});
          const v={...d,Status:'VOID',VoidedAt:now,VoidedBy:u.UserID,VoidedByName:u.Name,VoidReason:reason,UpdatedAt:now,SyncStatus:'PENDING'};
          t.objectStore('stock_docs').put(v);qput(t,docId,'stock_docs',now);
          t.objectStore('audit').put(aud(u,'TRANSFER_VOID',docId,{Status:d.Status},{Status:'VOID',number:d.Number,from:d.WarehouseID,to:d.ToWarehouseID,reversals:orig.length,allowNegative},reason,now,dev));
          setOut(v);
        });
      };
    };
  });
}
