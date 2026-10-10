// قاعدة البيانات المحلية (IndexedDB) — مصدر الحقيقة للمخزون هو دفتر الحركات movements مش رقم رصيد ثابت
const DB_NAME='aliraqi', DB_VER=3;
const STORES={
  products:{keyPath:'ProductID'}, customers:{keyPath:'CustomerID',indexes:['Phone']}, warehouses:{keyPath:'WarehouseID'},
  invoices:{keyPath:'InvoiceID',indexes:['CustomerID','DateTime']}, invoice_lines:{keyPath:'LineID',indexes:['InvoiceID','ProductID']},
  movements:{keyPath:'MovementID',indexes:['ProductID','WarehouseID','ReferenceID']},
  users:{keyPath:'UserID'}, roles:{keyPath:'RoleID'}, audit:{keyPath:'AuditID'},
  syncq:{keyPath:'OpID',indexes:['Status']}, settings:{keyPath:'key'},
  // --- v3: المراجعة والعكس (Audit Trail & Reversal) ---
  stock_docs:{keyPath:'DocID',indexes:['Status','DateTime']},                 // مستند استلام/صرف (الحركات تفضل في movements بنفس ReferenceID)
  invoice_revisions:{keyPath:'RevisionID',indexes:['InvoiceID']},             // نسخة الفاتورة قبل كل تعديل
  credit_notes:{keyPath:'CreditNoteID',indexes:['ParentInvoiceID']},          // إشعارات المرتجع
  credit_note_lines:{keyPath:'LineID',indexes:['CreditNoteID','ParentInvoiceID']}
};
let _db;
export function openDB(){
  if(_db) return Promise.resolve(_db);
  return new Promise((res,rej)=>{
    const rq=indexedDB.open(DB_NAME,DB_VER);
    rq.onupgradeneeded=()=>{const db=rq.result,t=rq.transaction;
      for(const [n,c] of Object.entries(STORES)){
        const s=db.objectStoreNames.contains(n)?t.objectStore(n):db.createObjectStore(n,{keyPath:c.keyPath});
        (c.indexes||[]).forEach(i=>{if(!s.indexNames.contains(i)) s.createIndex(i,i)});   // ترقية آمنة: بتضيف الفهارس من غير ما تلمس البيانات
      }};
    rq.onsuccess=()=>{_db=rq.result;_db.onversionchange=()=>{_db.close();_db=null};res(_db)}; rq.onerror=()=>rej(rq.error);
  });
}
const tx=async(store,mode,fn)=>{const db=await openDB();return new Promise((res,rej)=>{
  const t=db.transaction(store,mode);const out=fn(t);t.oncomplete=()=>res(out.result??out);t.onerror=()=>rej(t.error);t.onabort=()=>rej(t.error)})};
export const get=(s,k)=>tx(s,'readonly',t=>t.objectStore(s).get(k));
export const all=(s)=>tx(s,'readonly',t=>t.objectStore(s).getAll());
export const byIndex=(s,i,v)=>tx(s,'readonly',t=>t.objectStore(s).index(i).getAll(v));
export const put=(s,o)=>tx(s,'readwrite',t=>t.objectStore(s).put(o));
export const uuid=()=>crypto.randomUUID();
export const nowISO=()=>new Date().toISOString();

// ---- دفتر الحركات ----
// QuantityPieces موجب = دخول، سالب = خروج. التحويل = حركتين بنفس TransferID.
export async function addMovement({productId,warehouseId,type,qtyPieces,ref,userId,deviceId,notes=''}){
  if(!Number.isInteger(qtyPieces)||qtyPieces===0) throw new Error('كمية غير صالحة');
  const m={MovementID:uuid(),DateTime:nowISO(),ProductID:productId,WarehouseID:warehouseId,MovementType:type,
    QuantityPieces:qtyPieces,ReferenceID:ref||null,UserID:userId,DeviceID:deviceId,SyncStatus:'PENDING',Notes:notes};
  await put('movements',m);
  await put('syncq',{OpID:uuid(),Entity:'movements',EntityID:m.MovementID,Status:'PENDING',CreatedAt:m.DateTime,Tries:0});
  return m;
}
export async function stockOf(productId,warehouseId){
  const ms=await byIndex('movements','ProductID',productId);
  return ms.filter(m=>!warehouseId||m.WarehouseID===warehouseId).reduce((s,m)=>s+m.QuantityPieces,0);
}
export const toPieces=(cartons,pieces,pcsPerCarton)=>cartons*pcsPerCarton+pieces;
export async function audit(user,action,entity,id,oldV,newV,deviceId){
  await put('audit',{AuditID:uuid(),UserID:user.UserID,UserName:user.Name,Action:action,EntityType:entity,EntityID:id,
    DateTime:nowISO(),DeviceID:deviceId,OldValue:oldV??null,NewValue:newV??null,SyncStatus:'PENDING'});
}
export async function pendingCount(){const q=await byIndex('syncq','Status','PENDING');return q.length}
export function deviceId(){let d=localStorage.getItem('alr_device');if(!d){d='D-'+uuid().slice(0,6).toUpperCase();localStorage.setItem('alr_device',d)}return d}

// ---- ترحيل مستند مخزون (استلام/صرف) كوحدة واحدة: كل الحركات + طابور المزامنة + سجل العمليات في transaction واحدة ----
// لو أي صنف رصيده مش كفاية (في الصرف) كل حاجة بتتلغي ومفيش حاجة بتتكتب.
export async function postStockDoc({type,warehouseId,lines,user,notes='',allowNegative=false}){
  if(!['STOCK_IN','STOCK_OUT'].includes(type)) throw new Error('نوع غير صالح');
  const merged=new Map();                                 // دمج تكرار نفس الصنف
  for(const l of lines){if(!Number.isInteger(l.qtyPieces)||l.qtyPieces<=0) throw new Error('كمية غير صالحة');merged.set(l.productId,(merged.get(l.productId)||0)+l.qtyPieces)}
  if(!merged.size) throw new Error('مفيش أصناف في العملية');
  const db=await openDB(),dev=deviceId(),docId=uuid(),now=nowISO(),sign=type==='STOCK_OUT'?-1:1;
  return new Promise((resolve,reject)=>{
    const t=db.transaction(['movements','syncq','audit','stock_docs','settings'],'readwrite');
    let failed=null,number='';
    t.oncomplete=()=>resolve({docId,count:merged.size,number});
    t.onerror=()=>reject(failed||t.error); t.onabort=()=>reject(failed||t.error||new Error('تم الإلغاء'));
    const mv=t.objectStore('movements'),sq=t.objectStore('syncq'),au=t.objectStore('audit'),sd=t.objectStore('stock_docs'),st=t.objectStore('settings');
    const writeAll=()=>{
      const key=`docseq:${dev}:${ymd(new Date(now))}`;                      // رقم المستند: SI/SO-تاريخ-جهاز-تسلسل (مش بيتعارض بين الأجهزة)
      st.get(key).onsuccess=e=>{
      const n=(e.target.result?.value||0)+1;st.put({key,value:n});
      number=`${type==='STOCK_IN'?'SI':'SO'}-${ymd(new Date(now))}-${dev.replace(/^D-/,'')}-${String(n).padStart(4,'0')}`;
      sd.put({DocID:docId,Number:number,Type:type,WarehouseID:warehouseId,DateTime:now,UserID:user.UserID,UserName:user.Name,DeviceID:dev,Notes:notes,
        Status:'POSTED',LinesCount:merged.size,TotalPieces:[...merged.values()].reduce((s,x)=>s+x,0),UpdatedAt:now,SyncStatus:'PENDING'});
      sq.put({OpID:uuid(),Entity:'stock_docs',EntityID:docId,Status:'PENDING',CreatedAt:now,Tries:0});
      for(const [productId,q] of merged){
        const m={MovementID:uuid(),DateTime:now,ProductID:productId,WarehouseID:warehouseId,MovementType:type,QuantityPieces:sign*q,
          ReferenceID:docId,UserID:user.UserID,DeviceID:dev,SyncStatus:'PENDING',Notes:notes};
        mv.put(m);sq.put({OpID:uuid(),Entity:'movements',EntityID:m.MovementID,Status:'PENDING',CreatedAt:now,Tries:0});
      }
      au.put({AuditID:uuid(),UserID:user.UserID,UserName:user.Name,Action:type,EntityType:'StockDoc',EntityID:docId,DateTime:now,DeviceID:dev,
        OldValue:null,NewValue:JSON.stringify({number,warehouseId,lines:[...merged].map(([p,q])=>({p,q:sign*q})),allowNegative}),Notes:notes,SyncStatus:'PENDING'});
      };
    };
    if(sign>0||allowNegative){writeAll();return}
    let left=merged.size;
    for(const [productId,q] of merged){
      mv.index('ProductID').getAll(productId).onsuccess=e=>{
        if(failed) return;
        const avail=e.target.result.filter(m=>m.WarehouseID===warehouseId).reduce((s,m)=>s+m.QuantityPieces,0);
        if(avail<q){failed=Object.assign(new Error('الرصيد مش كفاية'),{code:'INSUFFICIENT',productId,available:avail,requested:q});t.abort();return}
        if(--left===0) writeAll();
      };
    }
  });
}
// رصيد كل الأصناف: Map(productId -> {warehouseId: pieces})
export async function stockMap(){
  const m=new Map();for(const x of await all('movements')){const o=m.get(x.ProductID)||{};o[x.WarehouseID]=(o[x.WarehouseID]||0)+x.QuantityPieces;m.set(x.ProductID,o)}return m;
}

// معاملة عامة متعددة الجداول: fn(t, fail, setOut) — لو fail(err) اتندهت كل حاجة بتتلغي والـ Promise بيترفض بنفس الخطأ
export function txRun(stores,fn){
  return openDB().then(db=>new Promise((res,rej)=>{
    const t=db.transaction(stores,'readwrite');let failed=null,out;
    t.oncomplete=()=>res(out);t.onerror=()=>rej(failed||t.error);t.onabort=()=>rej(failed||t.error||new Error('تم الإلغاء'));
    const fail=e=>{failed=e;try{t.abort()}catch{}};
    try{fn(t,fail,v=>{out=v})}catch(e){fail(e)}
  }));
}
// المخزن المختار تلقائياً في الاستلام/الصرف/التحويل/الفواتير: المخزن الافتراضي النشط أولاً، وبعده آخر مخزن استخدمه الجهاز، وإلا فاضي (المستخدم يختار).
export function pickWarehouse(whs){
  const ok=id=>!!id&&whs.some(w=>w.WarehouseID===id);
  const def=whs.find(w=>w.IsDefault&&w.Active!==false)?.WarehouseID;
  if(ok(def))return def;
  const last=localStorage.getItem('alr_last_wh');return ok(last)?last:'';
}
export const ymd=(d=new Date())=>d.getFullYear()+String(d.getMonth()+1).padStart(2,'0')+String(d.getDate()).padStart(2,'0');
