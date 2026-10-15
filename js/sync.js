// مركز المزامنة (v22: أكواد تفعيل الأجهزة + الأجهزة المتصلة + إيقاف جهاز عن بعد + تحقق من السجلات المسحوبة): مزامنة ثنائية الاتجاه مع Google Apps Script Web App — رفع طابور syncq ثم سحب التحديثات من الأجهزة التانية.
// v23: كيان جديد payments (تحصيلات العملاء/الرصيد الافتتاحي) في KEYS/SCAN/PULL_POLICY/FINAL_STATUS/CHECK — لازم Code.gs v23 يتنشر قبل ما الأجهزة تبعت تحصيلات.
// القواعد: (1) مفيش حاجة بتتمسح محلياً. (2) كل عملية بتبعت «لقطة كاملة» للسجل (upsert بالمفتاح) فالإعادة آمنة (idempotent).
// (3) الـ PinHash/Salt ما بيتبعتوش أبداً (whitelist للمستخدمين + deepScrub لأي حاجة تانية). (4) أوفلاين = الطابور بيفضل زي ما هو.
import {all,get as dbGet,put,byIndex,txRun,uuid,nowISO,deviceId,pendingCount,openDB,isDemo} from './db.js';
import {can,ROLES,PERMS} from './auth.js';
import {reconcileVoids} from './reversal.js';
import {$,el,toast,fmt,modal} from './ui.js';
// db.get القديمة كانت بترجّع كائن IDBRequest (مش undefined) لمفتاح مش موجود، فكل «||{}» كانت بتعدّي غلط وبتكسّر شاشة المزامنة — مبنعتمدش على السلوك ده
const get=async(s,k)=>{const v=await dbGet(s,k);return(typeof IDBRequest!=='undefined'&&v instanceof IDBRequest)?undefined:v};

const APP_VER='v23';
const KEYS={customers:'CustomerID',invoices:'InvoiceID',invoice_lines:'LineID',invoice_revisions:'RevisionID',credit_notes:'CreditNoteID',
  credit_note_lines:'LineID',movements:'MovementID',stock_docs:'DocID',audit:'AuditID',users:'UserID',products:'ProductID',warehouses:'WarehouseID',payments:'PaymentID'};
// جداول عليها SyncStatus (بتتعلّم SYNCED بعد الرفع، وبنفحصها لو سجل اتغيّر من غير ما يتحط في الطابور)
const SCAN=['customers','invoices','invoice_lines','invoice_revisions','credit_notes','credit_note_lines','movements','stock_docs','audit','warehouses','products','users','payments'];
const USER_SAFE=['UserID','Name','RoleID','Rank','Active','UpdatedAt','UpdatedBy','ExtraPerms','DeniedPerms'];   // مفيش Salt ولا PinHash
const MAX_TRIES=8,BATCH_OPS=40,BATCH_ITEMS=80,BATCH_BYTES=300000,TIMEOUT=30000,MAX_BATCHES=60;

// ---------- إعدادات وحالة ----------
export const getConfig=async()=>(await get('settings','sync_config'))||{};
export const getInfo=async()=>(await get('settings','sync_state'))||{};
const saveInfo=async patch=>put('settings',{...(await getInfo()),...patch,key:'sync_state'});
// kind: 'master' = الرمز الرئيسي (جهاز المالك، أو جهاز قديم) · 'device' = رمز خاص بالجهاز اتاخد بكود تفعيل. name = اسم الجهاز اللي بيظهر في «الأجهزة المتصلة»
export async function saveConfig(url,token,{kind='master',name=''}={}){if(isDemo())throw new Error('وضع التجربة: المزامنة متوقفة');await put('settings',{key:'sync_config',url,token,kind,name:String(name||'').trim().slice(0,30),UpdatedAt:nowISO()})}
export const getDeviceState=async()=>(await get('settings','device_state'))||{};
export const isRevoked=async()=>!!(await getDeviceState()).revoked;
async function setRevoked(v){const cur=await getDeviceState();if(!!cur.revoked===v)return;await put('settings',{key:'device_state',revoked:v,at:nowISO()});if(v&&typeof dispatchEvent==='function')dispatchEvent(new Event('alr:revoked'))}
const srvErr=res=>Object.assign(new Error(res.error||'رفض من السيرفر'),{code:res.code||''});
const S={running:false,phase:'',done:0,total:0,pulled:0,error:''};
const subs=new Set();
export const syncState=()=>({...S});
export function subscribe(fn){subs.add(fn);return()=>subs.delete(fn)}
const emit=()=>subs.forEach(f=>{try{f({...S})}catch{}});

// ---------- حجب الأسرار ----------
const SECRET=/^(pinhash|salt|pin|password|token)$/i;
function deepScrub(v){
  if(Array.isArray(v))return v.map(deepScrub);
  if(v&&typeof v==='object'){const o={};for(const[k,x]of Object.entries(v))if(!SECRET.test(k))o[k]=deepScrub(x);return o}
  if(typeof v==='string'&&/pinhash|"salt"/i.test(v)){try{return JSON.stringify(deepScrub(JSON.parse(v)))}catch{return '[محجوب]'}}
  return v;
}
const scrub=(store,rec)=>{
  if(store==='users'){const o={};for(const k of USER_SAFE)if(k in rec)o[k]=rec[k];return o}
  return deepScrub(rec);
};

// ---------- الشبكة ----------
// أخطاء الشبكة المؤقتة (ERR_CONNECTION_CLOSED / انقطاع / مهلة) بنعيد المحاولة عليها لحد 3 مرات بتأخير متزايد — آمن لأن الرفع upsert بالمفتاح والسحب قراءة بس
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function post(url,payload){
  let last;
  for(let i=0;i<3;i++){
    try{return await postOnce(url,payload)}
    catch(e){last=e;if(!/تعذر الوصول|انتهت مهلة/.test(e.message||'')||!navigator.onLine)throw e;await sleep(1500*(i+1))}
  }
  throw last;
}
async function postOnce(url,payload){
  const ctl=new AbortController(),t=setTimeout(()=>ctl.abort(),TIMEOUT);
  try{
    // text/plain عشان ما يبقاش فيه preflight (Apps Script مبيدعمش OPTIONS)
    const res=await fetch(url,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify(payload),signal:ctl.signal,redirect:'follow'});
    if(!res.ok)throw new Error('رد السيرفر HTTP '+res.status);
    try{return await res.json()}catch{throw new Error('رد غير مفهوم — اتأكد إن رابط الـ Web App صحيح ومتاح لـ «Anyone»')}
  }catch(e){
    if(e.name==='AbortError')throw new Error('انتهت مهلة الاتصال');
    if(e instanceof TypeError)throw new Error('تعذر الوصول للسيرفر (النت أو الرابط)');
    throw e;
  }finally{clearTimeout(t)}
}
let syncUser=null;
const meta=cfg=>({device:deviceId(),devName:(cfg&&cfg.name)||'',user:syncUser?.Name||'',app:APP_VER});   // بيتبعت مع كل طلب: بيظهر في «الأجهزة المتصلة»
export async function pingEndpoint(url,token,name=''){
  const r=await post(url,{action:'ping',token,...meta({name})});
  if(!r.ok)throw srvErr(r);
  return true;
}
// تفعيل جهاز بكود من المالك: السيرفر بيرد برمز خاص بالجهاز ده (بيتخزّن هنا، ومش بيظهر لأي حد). الكود بيتستخدم مرة واحدة.
export async function enrollDevice(url,code,name=''){
  if(isDemo())throw new Error('وضع التجربة: المزامنة متوقفة');
  url=String(url||'').trim();
  if(!/^https:\/\/script\.google\.com\/.+\/exec$/.test(url))throw new Error('الرابط لازم يبقى رابط Web App من Google (بيبدأ بـ https://script.google.com وبينتهي بـ /exec)');
  if(String(code||'').replace(/[^A-Za-z0-9]/g,'').length<8)throw new Error('اكتب كود التفعيل كامل (8 حروف/أرقام)');
  if(!navigator.onLine)throw new Error('أوفلاين — الربط محتاج نت');
  const res=await postOnce(url,{action:'enroll',code:String(code).trim(),...meta({name})});
  if(!res.ok)throw srvErr(res);
  await saveConfig(url,res.token,{kind:'device',name});
  await put('settings',{key:'device_state',revoked:false,at:nowISO()});
  return true;
}
// عمليات المالك (الرمز الرئيسي بس): newcode / devices / disable / enable
export async function adminCall(action,extra={}){
  const cfg=await getConfig();
  if(!cfg.url||!cfg.token)throw new Error('رابط المزامنة لسه ما اتضبطش');
  if(cfg.kind==='device')throw new Error('العملية دي من جهاز المالك الرئيسي بس (اللي متسجّل عليه الرمز الرئيسي)');
  if(!navigator.onLine)throw new Error('أوفلاين — العملية دي محتاجة نت');
  const res=await post(cfg.url,{action,token:cfg.token,...meta(cfg),...extra});
  if(!res.ok){if(/action غير معروف/.test(res.error||''))throw new Error('Apps Script لسه على النسخة القديمة — الصق Code.gs الجديد (v22) واعمل Deploy ← Manage deployments ← New version');throw srvErr(res)}
  return res;
}

// ---------- تجهيز العمليات ----------
async function buildOp(op){
  const store=op.Entity;
  if(!KEYS[store])return{op,fail:'نوع بيانات غير مدعوم: '+store};
  const rec=await get(store,op.EntityID);
  if(!rec)return{op,fail:'السجل مش موجود على الجهاز'};
  const items=[{entity:store,key:op.EntityID,data:scrub(store,rec)}];
  // الفاتورة/الإشعار بيتبعتوا مع كل سطورهم (بما فيها السطور القديمة Superseded) ونسخ التعديل — فحالة الإلغاء/التعديل توصل صح حتى لو السطر نفسه ما اتحطش في الطابور
  const kids=store==='invoices'?[['invoice_lines','InvoiceID'],['invoice_revisions','InvoiceID']]:store==='credit_notes'?[['credit_note_lines','CreditNoteID']]:[];
  for(const[ks,idx]of kids)for(const k of await byIndex(ks,idx,op.EntityID))items.push({entity:ks,key:k[KEYS[ks]],data:scrub(ks,k)});
  return{op,sent:rec,items};
}
async function markResults(list,results){
  const now=nowISO();let ok=0,bad=0;
  await txRun(['syncq',...SCAN],t=>{
    const q=t.objectStore('syncq');
    for(const b of list){
      const r=results.get(b.op.OpID)||{ok:false,error:'مفيش رد من السيرفر على العملية دي'};
      if(r.ok){
        ok++;q.put({...b.op,Status:'SYNCED',SyncedAt:now,LastError:null,LastHint:null,Permanent:false});
        if(b.sent&&SCAN.includes(b.op.Entity)){
          const s=t.objectStore(b.op.Entity);
          s.get(b.op.EntityID).onsuccess=e=>{const rec=e.target.result;   // نعلّم SYNCED بس لو السجل ما اتغيّرش بعد اللقطة اللي اتبعتت
            if(rec&&rec.SyncStatus==='PENDING'&&(rec.UpdatedAt||null)===(b.sent.UpdatedAt||null))s.put({...rec,SyncStatus:'SYNCED'})};
        }
      }else{
        bad++;const tries=(b.op.Tries||0)+1;
        q.put({...b.op,Tries:tries,LastTryAt:now,LastError:String(r.error||'خطأ').slice(0,200),LastHint:(r.hint||r.fix)?String(r.hint||r.fix).slice(0,200):null,Permanent:!!r.permanent,Status:(r.permanent||tries>=MAX_TRIES)?'FAILED':'PENDING'});
      }
    }
  });
  return{ok,bad};
}
// سجلات متعلّمة PENDING ومالهاش عملية في الطابور (اتعدّلت من غير enqueue) — بنضيفها عشان ما تضيعش
// v14.3: بدل getAll() على 12 جدول كل مرة، بنقرا من فهرس SyncStatus السجلات PENDING بس (في معاملة قراءة واحدة). لو الفهرس لسه ما اتعملش (قبل ترقية DB v4) بنرجع للمسح الكامل.
export async function scanOrphans(){
  const db=await openDB(),rq=r=>new Promise((res,rej)=>{r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});
  const t=db.transaction(['syncq',...SCAN],'readonly');
  const qP=rq(t.objectStore('syncq').index('Status').getAll('PENDING'));          // كل الطلبات بتتبعت في نفس الدورة عشان المعاملة ما تقفلش
  const rows=await Promise.all(SCAN.map(s=>{const os=t.objectStore(s);
    return rq(os.indexNames.contains('SyncStatus')?os.index('SyncStatus').getAll('PENDING'):os.getAll()).then(list=>[s,list])}));
  const queued=new Set((await qP).map(o=>o.Entity+'|'+o.EntityID)),add=[];
  for(const [s,list] of rows)for(const r of list){
    const id=r[KEYS[s]];if(r.SyncStatus!=='PENDING'||!id||queued.has(s+'|'+id))continue;
    add.push({OpID:uuid(),Entity:s,EntityID:id,Status:'PENDING',CreatedAt:r.UpdatedAt||r.DateTime||r.CreatedAt||nowISO(),Tries:0,Orphan:true});
  }
  if(add.length)await txRun(['syncq'],t=>{for(const o of add)t.objectStore('syncq').put(o)});
  return add.length;
}

// ---------- السحب (Pull) ----------
// الشيت بقى مصدر الحقيقة المشترك: كل سجل متخزّن كامل (JSON) برقم تسلسلي عالمي _srv. كل جهاز بيحتفظ بآخر _srv وصله (sync_pull.cursor) وبيطلب اللي بعده على دفعات.
// قواعد الدمج على الجهاز (نفس منطق السيرفر):
//  - lww (عملاء/أصناف/مخازن/مستخدمين/فواتير/سطورها/مستندات مخزن/مرتجعات/تحصيلات): السجل البعيد بيبدّل المحلي بس لو UpdatedAt بتاعه أحدث. لو المحلي لسه «بانتظار المزامنة» واتبدّل → بنسجّل تعارض (النسخة المحلية بتتحفظ في sync_conflicts).
//  - once (حركات المخزون/سجل العمليات/نسخ التعديل/سطور المرتجع): بتتضاف لو مش موجودة، ومبتتبدّلش أبداً.
//  - المستخدمين: بنسحب الاسم والدور والصلاحيات والحالة بس. الـ PIN مش بيتسحب ولا بيتبعت: مستخدم جديد جاي من جهاز تاني بيتعمل بـ PinHash='!' والمالك يعيّن له رقم من «المستخدمين».
//    ومفيش OWNER بييجي من السحابة، وحساب OWNER المحلي بيتجاهل أي تعديل جاي منها.
// السجلات المسحوبة بتتحط SyncStatus='SYNCED' ومبتدخلش الطابور — فمفيش دوران رفع/سحب.
const PULL_POLICY={customers:'lww',products:'lww',warehouses:'lww',users:'users',invoices:'lww',stock_docs:'lww',credit_notes:'lww',invoice_lines:'lww',
  credit_note_lines:'once',invoice_revisions:'once',movements:'once',audit:'once',payments:'lww'};
const FINAL_STATUS={invoices:'VOID',stock_docs:'VOID',payments:'VOID'};                // الإلغاء نهائي ويكسب في الدمج مهما كان UpdatedAt (نفس قاعدة Code.gs)
const CHILD_STORES=['invoice_lines','credit_note_lines','invoice_revisions'];          // بيتبعتوا جوه عملية أبوهم
const PULL_LIMIT=200,MAX_PULL_PAGES=100,PULL_EVERY=60000,MAX_CONFLICTS=30;
const ROLE_RANK=new Map(ROLES.map(r=>[r.RoleID,r.Rank]));
export const getPullState=async()=>(await get('settings','sync_pull'))||{cursor:0};
const savePullState=async patch=>put('settings',{...(await getPullState()),...patch,key:'sync_pull'});
export const getConflicts=async()=>{const r=await get('settings','sync_conflicts');return Array.isArray(r?.list)?r.list:[]};
const saveConflicts=async add=>{const cur=await getConflicts();await put('settings',{key:'sync_conflicts',list:[...add,...cur].slice(0,MAX_CONFLICTS)})};
export const clearConflicts=()=>put('settings',{key:'sync_conflicts',list:[]});
export async function resetPull(){await savePullState({cursor:0,resetAt:nowISO()})}   // السحب من الأول (آمن: الدمج بيتجاهل اللي موجود)

// ---------- تحقق من شكل السجلات المسحوبة (v22) ----------
// أي سجل بنوع حقل غلط (رقم كنص، كمية عشرية…) بيتعدّى عليه ويتحسب «bad» بدل ما يدخل قاعدة البيانات ويبوّظ الأرصدة والتقارير.
const isS=v=>typeof v==='string',isN=v=>typeof v==='number'&&Number.isFinite(v),isI=v=>Number.isInteger(v),optS=v=>v==null||isS(v);
const CHECK={
  customers:r=>optS(r.Name),products:r=>optS(r.Name),warehouses:r=>optS(r.Name),users:()=>true,
  invoices:r=>isN(r.Total)&&isS(r.Status)&&isS(r.DateTime)&&isS(r.WarehouseID),
  invoice_lines:r=>isS(r.InvoiceID)&&isI(r.TotalPieces)&&isN(r.UnitPrice)&&r.UnitPrice>=0,
  invoice_revisions:r=>isS(r.InvoiceID)&&!!r.Snapshot&&typeof r.Snapshot==='object',
  credit_notes:r=>isN(r.Total)&&isS(r.ParentInvoiceID),
  credit_note_lines:r=>isS(r.ParentInvoiceID)&&isI(r.TotalPieces)&&isN(r.UnitPrice),
  movements:r=>isS(r.ProductID)&&isS(r.WarehouseID)&&isI(r.QuantityPieces)&&isS(r.MovementType),
  stock_docs:r=>optS(r.Status)&&optS(r.Type),audit:r=>isS(r.Action),
  payments:r=>isS(r.CustomerID)&&isN(r.Amount)&&r.Amount>0&&isS(r.Status)&&isS(r.DateTime)&&(r.Kind==='PAYMENT'||r.Kind==='OPENING')
};
export function validRecord(entity,r){try{return !!(r&&typeof r==='object'&&!Array.isArray(r)&&CHECK[entity]?.(r)&&JSON.stringify(r).length<400000)}catch{return false}}
// دمج مستخدم جاي من السحابة: بيرجّع السجل اللي يتكتب محلياً أو null لو يتجاهل.
// v22: تغيير الدور/الرتبة/الحالة/الصلاحيات بيتقبل بس لو المسجّل كـ UpdatedBy مستخدم عندنا فعلاً مالك أو عنده «ManageUsers» ورتبته أعلى من المستخدم المتعدّل.
// غير كده: الاسم بس هو اللي بيتغيّر، والمستخدم الجديد بيتعمل «موظف» من غير صلاحيات إضافية. (ده حاجز ضد التلاعب العادي؛ جهاز مفعّل بيزوّر UpdatedBy محتاج الحماية بإيقاف الجهاز.)
export function mergeUser(local,r,admins){
  if(!r||typeof r.UserID!=='string'||!r.UserID)return null;
  if(!ROLE_RANK.has(r.RoleID)||r.RoleID==='OWNER')return null;                    // مفيش OWNER من السحابة
  if(local&&local.RoleID==='OWNER')return null;                                   // حساب المالك محلي بس
  const perms=a=>Array.isArray(a)?a.filter(p=>PERMS.includes(p)&&p!=='ManageRoles'&&!(p==='ManageUsers'&&r.RoleID==='STAFF')):[];
  const name=String(r.Name||'').slice(0,40)||r.UserID,au=admins&&r.UpdatedBy?admins.get(String(r.UpdatedBy)):null;
  const authorOk=!!au&&(au.RoleID==='OWNER'||(au.Rank<ROLE_RANK.get(r.RoleID)&&(!local||au.Rank<local.Rank)));
  if(!authorOk){
    if(local)return{...local,Name:name,UpdatedAt:r.UpdatedAt||local.UpdatedAt||null,SyncStatus:'SYNCED'};            // تغيير حساس من مصدر غير موثّق: الاسم بس
    return{UserID:r.UserID,Name:name,RoleID:'STAFF',Rank:ROLE_RANK.get('STAFF'),Active:true,ExtraPerms:[],DeniedPerms:[],UpdatedAt:r.UpdatedAt||null,SyncStatus:'SYNCED',
      Salt:uuid(),PinHash:'!',MustChangePin:true,FromSync:true,Unverified:true};
  }
  const base={UserID:r.UserID,Name:name,RoleID:r.RoleID,Rank:ROLE_RANK.get(r.RoleID),Active:r.Active!==false,
    ExtraPerms:perms(r.ExtraPerms),DeniedPerms:perms(r.DeniedPerms),UpdatedAt:r.UpdatedAt||null,UpdatedBy:String(r.UpdatedBy),SyncStatus:'SYNCED'};
  return local?{...local,...base}:{...base,Salt:uuid(),PinHash:'!',MustChangePin:true,FromSync:true};   // Salt/PinHash/MustChangePin المحلية بتفضل زي ما هي
}
async function applyPull(items){
  const pend=new Set([...await byIndex('syncq','Status','PENDING'),...await byIndex('syncq','Status','FAILED')].map(o=>o.Entity+'|'+o.EntityID));
  const ok=items.filter(it=>it&&PULL_POLICY[it.entity]&&it.data&&typeof it.data==='object'&&String(it.data[KEYS[it.entity]])===String(it.key)&&validRecord(it.entity,it.data));
  const st={added:0,updated:0,skipped:0,bad:items.length-ok.length,conflicts:0},conf=[];
  const stores=[...new Set(ok.map(i=>i.entity))];
  if(!stores.length)return{st,conf};
  let admins=null;                                                               // مستخدمين محليين مسموح لهم يغيّروا صلاحيات (المالك + اللي معاه ManageUsers)
  if(stores.includes('users')){admins=new Map();for(const u of await all('users'))if(u.Active&&(u.RoleID==='OWNER'||await can(u,'ManageUsers').catch(()=>false)))admins.set(u.UserID,u)}
  await txRun(stores,t=>{
    for(const it of ok){
      const os=t.objectStore(it.entity),pol=PULL_POLICY[it.entity],r=it.data,key=String(it.key);
      os.get(key).onsuccess=e=>{
        const loc=e.target.result;
        if(pol==='once'){if(loc){st.skipped++;return}os.put({...r,SyncStatus:'SYNCED'});st.added++;return}
        const fin=FINAL_STATUS[it.entity];
        if(fin&&loc&&loc.Status===fin){st.skipped++;return}                         // السجل الملغي محلياً عمره ما بيتبدّل بنسخة غير ملغية
        const voidWins=!!fin&&r.Status===fin&&(!loc||loc.Status!==fin);              // نسخة ملغية جاية من السحابة بتكسب حتى لو UpdatedAt المحلي أحدث
        if(!voidWins&&loc&&!((r.UpdatedAt||'')>(loc.UpdatedAt||''))){st.skipped++;return}      // الأحدث يكسب (المتساوي بيتساب)
        let rec;
        if(pol==='users'){rec=mergeUser(loc,r,admins);if(!rec){st.skipped++;return}}
        else rec={...r,SyncStatus:'SYNCED'};
        if(loc&&pend.has(it.entity+'|'+key)){st.conflicts++;conf.push({at:nowISO(),entity:it.entity,key,remoteAt:r.UpdatedAt||null,local:JSON.stringify(deepScrub(loc)).slice(0,4000)})}
        os.put(rec);loc?st.updated++:st.added++;
      };
    }
  });
  return{st,conf};
}
let morePull=false;
async function doPull(cfg){
  let cursor=(await getPullState()).cursor||0,applied=0,added=0,updated=0;const conflicts=[];morePull=false;
  for(let n=0;n<MAX_PULL_PAGES;n++){
    const res=await post(cfg.url,{action:'pull',token:cfg.token,...meta(cfg),cursor,limit:PULL_LIMIT});
    if(!res.ok){
      if(/action غير معروف/.test(res.error||''))throw new Error('Apps Script لسه على النسخة القديمة (من غير سحب) — الصق Code.gs الجديد واعمل Deploy ← Manage deployments ← New version');
      throw srvErr(res);
    }
    if(res.reset){cursor=0;await savePullState({cursor:0});continue}
    const {st,conf}=await applyPull(res.items||[]);
    applied+=st.added+st.updated;added+=st.added;updated+=st.updated;conflicts.push(...conf);S.pulled=applied;emit();
    cursor=Number(res.cursor)||cursor;await savePullState({cursor});               // الموضع بيتحفظ بعد ما الدفعة تتطبّق بس
    if(!res.more)break;
    if(n===MAX_PULL_PAGES-1)morePull=true;
  }
  if(conflicts.length)await saveConflicts(conflicts);
  return{applied,added,updated,conflicts:conflicts.length};
}
// إعادة رفع كل السجلات المحلية (مرة واحدة بعد ترقية Code.gs): بتحط عملية لكل سجل — التوابع (سطور/نسخ) بتروح مع أبوها. الأصناف اللي ما اتعدّلتش مش بتتبعت.
export async function repushAll(){
  const queued=new Set((await byIndex('syncq','Status','PENDING')).map(o=>o.Entity+'|'+o.EntityID)),now=nowISO(),add=[];
  for(const s of SCAN.filter(x=>!CHILD_STORES.includes(x)))for(const r of await all(s)){
    const id=r[KEYS[s]];if(!id||queued.has(s+'|'+id)||(s==='products'&&!r.UpdatedAt))continue;
    add.push({OpID:uuid(),Entity:s,EntityID:id,Status:'PENDING',CreatedAt:now,Tries:0,Resync:true});
  }
  if(add.length)await txRun(['syncq'],t=>{for(const o of add)t.objectStore('syncq').put(o)});
  return add.length;
}

// ---------- المحرك ----------
// الترتيب: (1) رفع الطابور (2) سحب التحديثات. الرفع الأول عشان تعديلاتنا توصل قبل ما نسحب (والأحدث بيكسب عند السيرفر).
async function doSync({manual,scan,pull=true}){
  if(isDemo())return{ok:false,error:'وضع التجربة: المزامنة متوقفة'};
  const cfg=await getConfig();
  if(!cfg.url||!cfg.token)return{ok:false,error:'رابط المزامنة لسه ما اتضبطش — المالك يضبطه من «إعدادات الاتصال»'};
  if(!navigator.onLine)return{ok:false,offline:true,error:'أوفلاين — هتتزامن تلقائياً أول ما النت يرجع'};
  Object.assign(S,{running:true,phase:'push',done:0,total:0,pulled:0,error:''});emit();
  const attempted=new Set();let sent=0,failed=0,staleN=0,lockedN=0,reconciled=0,errMsg='',errCode='',pr=null,clamped=0;
  try{
    if(manual||scan)await scanOrphans();
    S.total=await pendingCount();emit();
    if(!S.total&&!pull)await pingEndpoint(cfg.url,cfg.token);                 // مفيش حاجة تتبعت ولا هنسحب: نتأكد بس إن الاتصال والرمز سليمين
    for(let n=0;n<MAX_BATCHES;n++){
      const pend=(await byIndex('syncq','Status','PENDING')).filter(o=>!attempted.has(o.OpID)).sort((a,b)=>(a.CreatedAt||'').localeCompare(b.CreatedAt||''));
      if(!pend.length)break;
      const batch=[],local=[];let items=0,bytes=0;
      for(const op of pend){
        if(batch.length+local.length>=BATCH_OPS||items>=BATCH_ITEMS||bytes>=BATCH_BYTES)break;
        attempted.add(op.OpID);
        const b=await buildOp(op);
        if(b.fail){local.push(b);continue}
        batch.push(b);items+=b.items.length;bytes+=JSON.stringify(b.items).length;
      }
      const results=new Map();
      if(batch.length){
        const res=await post(cfg.url,{action:'sync',token:cfg.token,...meta(cfg),sentAt:nowISO(),
          ops:batch.map(x=>({opId:x.op.OpID,entity:x.op.Entity,key:x.op.EntityID,createdAt:x.op.CreatedAt,items:x.items}))});
        if(!res.ok)throw srvErr(res);           // رمز غلط/جهاز موقوف أو خطأ عام: نوقف من غير ما نحسب محاولات على العمليات
        clamped+=Number(res.clamped)||0;
        for(const r of res.results||[])results.set(r.opId,r);
      }
      for(const l of local)results.set(l.op.OpID,{ok:false,permanent:true,error:l.fail});
      const m=await markResults([...batch,...local],results);sent+=m.ok;failed+=m.bad;
      // السيرفر رد stale = عنده نسخة أحدث من اللي رفعناها: تعديلنا ما كسبش. بنحتفظ بنسخته المحلية في سجل التعارضات (إعادة الرفع الشاملة مش بتتحسب)
      lockedN+=batch.filter(b=>results.get(b.op.OpID)?.locked).length;               // السيرفر رفض لأن السجل ملغي من جهاز تاني
      const stale=batch.filter(b=>results.get(b.op.OpID)?.stale&&!b.op.Resync).map(b=>({at:nowISO(),entity:b.op.Entity,key:String(b.op.EntityID),remoteAt:null,locked:results.get(b.op.OpID)?.locked||null,local:JSON.stringify(b.items[0].data).slice(0,4000)}));
      if(stale.length){await saveConflicts(stale);staleN+=stale.length}
      const cur=batch.map(b=>results.get(b.op.OpID)?.current).filter(c=>c&&c.entity&&c.data&&c.key!=null);   // v22: السيرفر بيرجّع نسخته الأحدث مع stale — بنطبّقها فوراً (قبل كده كانت بتستنى السحب، ولو الـ cursor عدّى عليها كانت بتضيع)
      if(cur.length)await applyPull(cur.map(c=>({entity:c.entity,key:c.key,data:c.data}))).catch(()=>{});
      S.done+=batch.length+local.length;emit();
    }
    if(pull){S.phase='pull';emit();pr=await doPull(cfg);if(pr.applied>0||lockedN>0)reconciled=await reconcileVoids().catch(()=>0)}   // بعد السحب: أي حركة وصلت على مستند ملغي بتتعكس (REV- حتمي)
  }catch(e){errMsg=e.message||'تعذر الاتصال';errCode=e.code||''}
  const patch={lastAttemptAt:nowISO(),lastCode:errCode,lastError:errMsg||(failed?`${failed} عملية اترفضت من السيرفر (شوف تفاصيلها تحت)`:'')};
  if(errCode==='REVOKED')await setRevoked(true).catch(()=>{});else if(!errMsg)await setRevoked(false).catch(()=>{});   // جهاز موقوف من المالك: بيتقفل عند أول اتصال ويتفتح لوحده لما المالك يفعّله
  if(!errMsg){patch.clockSkew=clamped>0;patch.lastCount=sent;if(!failed)patch.lastSuccessAt=nowISO();if(pr){patch.lastPullAt=nowISO();patch.lastPullCount=pr.applied;}patch.lastPullConflicts=(pr?.conflicts||0)+staleN}
  await saveInfo(patch).catch(()=>{});
  S.running=false;S.phase='';S.error=errMsg;emit();
  return{ok:!errMsg&&!failed,sent,failed,pulled:pr?.applied||0,reconciled,locked:lockedN,conflicts:(pr?.conflicts||0)+staleN,code:errCode,error:errMsg||(failed?patch.lastError:'')};
}
export async function syncNow({manual=false,scan=false,pull=true}={}){
  if(S.running)return{ok:false,error:'المزامنة شغالة بالفعل'};
  if(navigator.locks)return navigator.locks.request('alr-sync',{ifAvailable:true},l=>l?doSync({manual,scan,pull}):{ok:false,error:'المزامنة شغالة في نافذة تانية'});
  return doSync({manual,scan,pull});
}
export const failedOps=()=>byIndex('syncq','Status','FAILED');
export async function retryFailed(){
  const f=await failedOps();
  if(f.length)await txRun(['syncq'],t=>{for(const o of f)t.objectStore('syncq').put({...o,Status:'PENDING',Tries:0,AutoRounds:0,Permanent:false,LastError:null,LastHint:null})});
  return f.length;
}

// ---------- مزامنة تلقائية فورية (v19) ----------
// المحفّزات: (1) كل 30 ثانية (رفع، وسحب كل دقيقة) (2) مراقب سريع كل 4 ثواني بيرفع أي عملية جديدة بعد حفظ فاتورة/حركة (3) حدث online (4) رجوع التطبيق للشاشة: visibilitychange / pageshow
// (5) requestSync() أو الحدث 'alr:saved' من أي شاشة بعد الحفظ (بتأخير 1.2 ث لتجميع الحفظات المتتالية).
// عند الفشل: تأخير متزايد (دقيقة ← 10 دقايق) — والعمليات الفاشلة فشل مؤقت بتتعاد تلقائياً 3 مرات (بعد 2 / 10 / 30 دقيقة) قبل ما تتحط «محتاجة مراجعة».
const AUTO_ROUNDS=3,AUTO_WAIT=[120000,600000,1800000],FAST_EVERY=4000,SAVE_DELAY=1200,VIS_GAP=10000;
let timer,fastT,saveT,fails=0,nextAt=0,lastPull=0,again=false,lastVis=0;
export const needsReview=o=>!!o.Permanent||(o.AutoRounds||0)>=AUTO_ROUNDS;
async function autoRetryFailed(){
  const now=Date.now(),f=(await failedOps()).filter(o=>!needsReview(o)&&now-(Date.parse(o.LastTryAt||'')||0)>=AUTO_WAIT[o.AutoRounds||0]);
  if(f.length)await txRun(['syncq'],t=>{for(const o of f)t.objectStore('syncq').put({...o,Status:'PENDING',Tries:0,AutoRounds:(o.AutoRounds||0)+1})});
  return f.length;
}
async function auto(mode){                       // mode: 'full' | 'tick' | 'fast' | 'save'
  if(!navigator.onLine)return;
  if(S.running){if(mode==='save')again=true;return}
  if(Date.now()<nextAt)return;
  const cfg=await getConfig();if(!cfg.url||!cfg.token)return;
  if(mode!=='fast'){await scanOrphans().catch(()=>{});if(mode!=='save')await autoRetryFailed().catch(()=>{})}
  const pending=await pendingCount().catch(()=>0);
  const pullDue=(mode==='full'||mode==='tick')&&(mode==='full'||morePull||Date.now()-lastPull>=PULL_EVERY);
  if(!pending&&!pullDue)return;
  const r=await syncNow({pull:pullDue});
  if(r.code==='REVOKED'||r.code==='AUTH'){nextAt=Date.now()+60000}                       // موقوف/من غير تفعيل: نحاول كل دقيقة (عشان يتفتح بسرعة لما المالك يفعّله)
  else if(r.error&&!r.offline&&!/شغالة/.test(r.error)){fails++;nextAt=Date.now()+Math.min(30000*2**fails,600000)}else if(r.ok)fails=0;
  if(pullDue&&!r.error)lastPull=Date.now();
  if(again){again=false;if(!r.error)saveT=setTimeout(()=>auto('save').catch(()=>{}),400)}
}
// أي شاشة تحفظ فاتورة/حركة تقدر تنادي requestSync() (أو dispatchEvent(new Event('alr:saved'))) — ولو ما نادتش، المراقب السريع بيلقط العملية في أقل من 5 ثواني.
export function requestSync(){clearTimeout(saveT);saveT=setTimeout(()=>auto('save').catch(()=>{}),SAVE_DELAY)}
// إعادة محاولة فورية (من الشريط أو مركز المزامنة): بتصفّر التأخير المتزايد وبترجّع الفاشل للطابور وبتزامن
export async function retryNow(){
  fails=0;nextAt=0;
  const requeued=await retryFailed();
  const r=await syncNow({manual:true,pull:false});
  scheduleBanner();
  return{...r,requeued};
}
export function setSyncUser(u){syncUser=u||null;scheduleBanner()}
export function startAutoSync(user){
  if(isDemo())return;                              // وضع التجربة: مفيش مزامنة ولا شريط تنبيه
  if(user)syncUser=user;
  if(timer)return;
  mountBanner();
  timer=setInterval(()=>auto('tick').catch(()=>{}),30000);
  fastT=setInterval(()=>{if(document.visibilityState==='visible')auto('fast').catch(()=>{})},FAST_EVERY);
  addEventListener('online',()=>{fails=0;nextAt=0;auto('full').catch(()=>{});scheduleBanner()});
  addEventListener('offline',scheduleBanner);
  const back=()=>{if(Date.now()-lastVis<VIS_GAP)return;lastVis=Date.now();fails=0;nextAt=0;auto('full').catch(()=>{});scheduleBanner()};
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')back()});
  addEventListener('pageshow',e=>{if(e.persisted)back()});
  addEventListener('alr:saved',requestSync);
  subscribe(scheduleBanner);
  setInterval(scheduleBanner,20000);
  setTimeout(()=>auto('full').catch(()=>{}),4000);
}

// ---------- تنبيهات المزامنة جوه التطبيق (شريط أعلى الشاشة) ----------
// بيظهر لكل المستخدمين لما فيه مشكلة (أوفلاين بعمليات معلقة / فشل اتصال / عمليات فاشلة)، وزرار «التفاصيل» للمدير/المالك بس (صلاحية ManageSync).
const BAR_CSS='#syncbar{display:none;position:sticky;top:0;z-index:50;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 12px;color:#fff;font-weight:600;font-size:13px;line-height:1.5;box-shadow:0 2px 8px rgba(0,0,0,.25)}'
  +'#syncbar.on{display:flex}#syncbar.warn{background:#b7791f}#syncbar.bad{background:#c2564e}#syncbar span{flex:1 1 180px}'
  +'#syncbar button{border:1px solid rgba(255,255,255,.75);background:transparent;color:#fff;border-radius:8px;padding:4px 10px;font:inherit;cursor:pointer}#syncbar button:disabled{opacity:.6}@media print{#syncbar{display:none!important}}';
let bannerEl=null,bannerT,dismissedKey='',lastReviewN=0,hadProblem=false;
function mountBanner(){
  if(bannerEl||typeof document==='undefined')return;
  document.head.append(el('style',{},BAR_CSS));
  bannerEl=el('div',{id:'syncbar',role:'status','aria-live':'polite'});
  document.body.prepend(bannerEl);
}
const scheduleBanner=()=>{clearTimeout(bannerT);bannerT=setTimeout(()=>refreshBanner().catch(()=>{}),300)};
async function bannerState(){
  const cfg=await getConfig();if(!cfg.url||!cfg.token)return null;
  const [n,failed,info,dev]=await Promise.all([pendingCount(),failedOps(),getInfo(),getDeviceState()]);
  const review=failed.filter(needsReview),online=navigator.onLine,st=syncState();
  if(dev.revoked)return{lvl:'bad',key:'rv',reviewN:0,text:'⛔ الجهاز ده اتوقف من المالك — مفيش دخول ولا مزامنة لحد ما المالك يفعّله تاني'};
  if(info.lastCode==='AUTH'&&!st.running)return{lvl:'bad',key:'au',reviewN:0,text:'🔑 الجهاز ده مش مفعّل أو الرمز اتغيّر — اطلب من المالك كود تفعيل جديد',enroll:true};
  const details=!!syncUser&&await can(syncUser,'ManageSync').catch(()=>false);
  if(review.length)return{lvl:'bad',key:'r'+review.length,reviewN:review.length,text:`⚠️ ${fmt(review.length)} عملية فشلت في المزامنة ومحتاجة مراجعة`,retry:true,details};
  if(failed.length)return{lvl:'warn',key:'f'+failed.length,reviewN:0,text:`${fmt(failed.length)} عملية فشلت مؤقتاً وهتتعاد تلقائياً`,retry:true,details};
  if(!online&&n)return{lvl:'warn',key:'o'+n,reviewN:0,text:`📴 أوفلاين — ${fmt(n)} عملية هتتبعت أول ما النت يرجع`};
  if(online&&n&&info.lastError&&!st.running)return{lvl:'warn',key:'e'+n,reviewN:0,text:`تعذرت المزامنة (${String(info.lastError).slice(0,90)}) — هنعيد المحاولة تلقائياً`,retry:true,details};
  return null;
}
async function refreshBanner(){
  if(!bannerEl)return;
  const st=await bannerState();
  if(st&&st.reviewN>lastReviewN)toast(`⚠️ ${fmt(st.reviewN)} عملية فشلت في المزامنة — راجع الشريط اللي فوق`);
  lastReviewN=st?st.reviewN:0;
  if(!st&&hadProblem)toast('✅ اتزامنت كل العمليات');
  hadProblem=!!st;
  if(!st||st.key===dismissedKey){bannerEl.className='';return}
  bannerEl.className='on '+st.lvl;
  bannerEl.replaceChildren(el('span',{},st.text),
    st.retry&&el('button',{type:'button',onclick:async ev=>{const b=ev.currentTarget;b.disabled=true;
      const r=await retryNow().catch(e=>({ok:false,error:e.message}));
      toast(r.ok?'✅ اتزامنت كل العمليات':(r.error||'لسه فيه مشكلة — هنعيد المحاولة تلقائياً'));b.disabled=false}},'🔄 إعادة المحاولة'),
    st.details&&el('button',{type:'button',onclick:()=>showFailedModal()},'التفاصيل'),
    st.enroll&&el('button',{type:'button',onclick:()=>import('./devices.js').then(m=>m.enrollDialog({onDone:scheduleBanner})).catch(()=>toast('تعذر فتح الشاشة — أعد تحميل الصفحة وانت متصل'))},'🔗 ربط بكود'),
    el('button',{type:'button','aria-label':'إخفاء',onclick:()=>{dismissedKey=st.key;bannerEl.className=''}},'✕'));
}
async function showFailedModal(){
  const failed=await failedOps();
  let close=()=>{};
  const list=failed.length?failed.slice(0,25).map(o=>el('div',{class:'drow'},
    el('span',{},`${ENT_AR[o.Entity]||o.Entity} · ${String(o.EntityID).slice(0,8)}`,
      el('small',{dir:'auto',style:'display:block'},(o.LastError||'خطأ غير معروف')+(o.LastHint?' — الحل المقترح: '+o.LastHint:''))),
    el('b',{},needsReview(o)?'محتاجة مراجعة':'هتتعاد تلقائياً'))):[el('p',{class:'note'},'مفيش عمليات فاشلة دلوقتي.')];
  const nodes=[...list,
    failed.length>25?el('p',{class:'note'},`وفيه ${fmt(failed.length-25)} عملية تانية — كلها بتتعاد بزرار إعادة المحاولة.`):null,
    el('p',{class:'note'},'نفس الأخطاء بتتسجّل كمان في ورقة sync_errors في الشيت وبتتبعت للمدير بالإيميل (ADMIN_EMAIL).'),
    el('button',{class:'btn',type:'button',onclick:async ev=>{const b=ev.currentTarget;b.disabled=true;const r=await retryNow().catch(e=>({ok:false,error:e.message}));
      toast(r.ok?'✅ اتزامنت كل العمليات':(r.error||'لسه فيه مشكلة'));close();b.disabled=false}},'🔄 إعادة المحاولة للكل')].filter(Boolean);
  close=modal('عمليات المزامنة الفاشلة',...nodes);
}

// ---------- الواجهة ----------
const fdt=iso=>{if(!iso)return null;const d=new Date(iso),p=n=>String(n).padStart(2,'0');return `${d.getFullYear()}/${p(d.getMonth()+1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`};
const ENT_AR={movements:'حركة مخزون',stock_docs:'مستند مخزن',customers:'عميل',invoices:'فاتورة',invoice_lines:'سطر فاتورة',invoice_revisions:'نسخة تعديل',credit_notes:'مرتجع',credit_note_lines:'سطر مرتجع',audit:'سجل عمليات',users:'مستخدم',products:'صنف',warehouses:'مخزن',payments:'تحصيل'};

export async function showSyncCenter(user,onBack){
  if(!await can(user,'ManageSync')){toast('مركز المزامنة للمدير/المالك بس');onBack();return}
  const isOwner=user.RoleID==='OWNER';
  const body=el('div',{});let off=()=>{},root,busy=false;
  const row=(k,v)=>el('div',{class:'drow'},el('span',{},k),el('b',{dir:'auto'},v));
  async function refresh(){
    if(busy)return;busy=true;
    try{
      const [n,failed,info,cfg,conflicts,dev]=await Promise.all([pendingCount(),failedOps(),getInfo(),getConfig(),getConflicts(),getDeviceState()]);
      const st=syncState(),online=navigator.onLine,conf=!!(cfg.url&&cfg.token),pct=st.total?Math.min(100,Math.round(st.done/st.total*100)):0;
      const errText=st.error||(!st.running&&info.lastError)||'';
      const status=st.running?(st.phase==='pull'?`جاري سحب التحديثات… ${fmt(st.pulled)} سجل`:`جاري الإرسال… ${fmt(st.done)} من ${fmt(st.total)}`):st.error?'فشلت المزامنة':info.lastError?'آخر محاولة فيها مشاكل':'جاهز';
      body.replaceChildren(
        el('div',{class:'ssum'},n?`يوجد ${fmt(n)} عملية بانتظار المزامنة`:'مفيش عمليات معلقة ✅'),
        (st.running||st.done>0)&&el('div',{role:'progressbar','aria-valuemin':'0','aria-valuemax':'100','aria-valuenow':String(pct),style:'height:12px;border-radius:999px;background:#e3e7ec;overflow:hidden;margin:10px 0'},
          el('div',{style:`height:100%;width:${pct}%;background:${st.error?'#c2564e':'#1f9d76'};transition:width .2s`})),
        el('button',{class:'btn',type:'button',disabled:st.running||!online||!conf,onclick:async()=>{
          const r=await syncNow({manual:true});
          toast(r.ok?((r.sent||r.pulled)?`رفع ${fmt(r.sent)} · سحب ${fmt(r.pulled)}`+(r.conflicts?` · ${fmt(r.conflicts)} تعارض اتحلّ`:''):'كل شيء متزامن'):(r.error||'فشلت المزامنة'));refresh()}},st.running?'جاري المزامنة…':'🔄 مزامنة الآن'),
        row('الحالة',status),errText&&el('p',{class:'err'},errText),
        row('الاتصال',online?'متصل':'أوفلاين'),row('رابط المزامنة',conf?'مضبوط':'غير مضبوط'),
        conf&&row('نوع الربط',cfg.kind==='device'?'جهاز مفعّل بكود':'الرمز الرئيسي'),conf&&cfg.name&&row('اسم الجهاز',cfg.name),
        dev.revoked&&el('p',{class:'err'},'⛔ الجهاز ده موقوف من المالك'),
        info.clockSkew&&el('p',{class:'err'},'⚠ ساعة الجهاز متقدمة عن الوقت الحقيقي — اضبط التاريخ والوقت (السيرفر بيثبّت تعديلاتك على وقته)'),
        row('آخر مزامنة ناجحة',fdt(info.lastSuccessAt)||'لسه ما حصلتش'),row('آخر محاولة',fdt(info.lastAttemptAt)||'—'),
        info.lastCount!=null&&row('اللي اتبعت في آخر مرة',fmt(info.lastCount)+' عملية'),
        row('آخر سحب من الشيت',fdt(info.lastPullAt)||'لسه ما حصلش'),info.lastPullCount!=null&&row('اللي اتسحب في آخر مرة',fmt(info.lastPullCount)+' سجل'),
        conflicts.length>0&&el('div',{class:'editwarn'},el('b',{},`${fmt(conflicts.length)} تعارض اتحلّ بقاعدة «الأحدث يكسب»`),
          ...conflicts.slice(0,3).map(c=>el('div',{class:'drow'},el('span',{},`${ENT_AR[c.entity]||c.entity} · ${String(c.key).slice(0,8)}`),el('small',{},(c.locked?'اتلغت من جهاز تاني — تعديلك ما اتحفظش · ':'')+fdt(c.at)))),
          el('p',{class:'note'},'النسخة المحلية اللي اتبدّلت محفوظة في سجل التعارضات (اتساب جوه إعدادات الجهاز) لو احتجت ترجع لها.'),
          el('button',{class:'btn ghost',type:'button',onclick:async()=>{await clearConflicts();refresh()}},'مسح سجل التعارضات')),
        !conf&&el('p',{class:'note'},isOwner?'اضغط «إعدادات الاتصال» وحط رابط الـ Web App والرمز السري.':'المالك لازم يضبط رابط المزامنة الأول.'),
        failed.length>0&&el('div',{class:'voidbox'},el('b',{},`${fmt(failed.length)} عملية فشلت ومحتاجة مراجعة`),
          ...failed.slice(0,5).map(o=>el('div',{class:'drow'},el('span',{},`${ENT_AR[o.Entity]||o.Entity} · ${String(o.EntityID).slice(0,8)}`),el('small',{dir:'auto'},(o.LastError||'')+(o.LastHint?' — الحل: '+o.LastHint:'')+(needsReview(o)?'':' — هيتعاد تلقائياً')))),
          el('button',{class:'btn ghost',type:'button',onclick:async()=>{const r=await retryNow();toast(`رجّعنا ${fmt(r.requeued)} عملية للطابور`+(r.ok?' واتزامنت ✅':''));refresh()}},'إعادة المحاولة للفاشلة')),
        isOwner&&cfg.kind!=='device'&&conf&&el('div',{class:'btnrow act'},el('button',{class:'btn',type:'button',onclick:()=>import('./devices.js').then(m=>m.showDevices(user,()=>showSyncCenter(user,onBack))).catch(()=>toast('تعذر فتح الشاشة — أعد تحميل الصفحة وانت متصل'))},'📱 الأجهزة المتصلة وأكواد التفعيل')),
        !conf&&el('div',{class:'btnrow act'},el('button',{class:'btn',type:'button',onclick:()=>import('./devices.js').then(m=>m.enrollDialog({onDone:refresh})).catch(()=>toast('تعذر فتح الشاشة'))},'🔗 ربط الجهاز بكود تفعيل')),
        isOwner&&el('div',{class:'btnrow act'},el('button',{class:'btn ghost',type:'button',onclick:()=>settingsForm(cfg)},'⚙️ إعدادات الاتصال (الرمز الرئيسي)'),
          el('button',{class:'btn ghost',type:'button',disabled:st.running,onclick:async()=>{
            if(!window.confirm('إعادة رفع كل البيانات المحلية للشيت؟ بتتعمل مرة واحدة بعد تحديث Code.gs (عشان السجلات القديمة تبقى قابلة للسحب على الأجهزة التانية). آمنة ومش بتكرر صفوف، لكن ممكن تاخد وقت لو البيانات كبيرة.'))return;
            const c=await repushAll();toast(`اتحطّ ${fmt(c)} سجل في طابور الرفع`);refresh()}},'⬆ إعادة رفع كل البيانات'),
          el('button',{class:'btn ghost',type:'button',disabled:st.running,onclick:async()=>{await resetPull();toast('هيتسحب كل شيء من الأول في المزامنة الجاية');refresh()}},'⬇ إعادة السحب من الصفر')));
    }finally{busy=false}
  }
  function settingsForm(cfg){
    const url=el('input',{type:'url',dir:'ltr',value:cfg.url||'',placeholder:'https://script.google.com/macros/s/.../exec','aria-label':'رابط الـ Web App'});
    const tok=el('input',{type:'password',dir:'ltr',autocomplete:'off',placeholder:cfg.token?'محفوظ — سيبه فاضي لو مش عايز تغيّره':'الرمز السري (نفس SYNC_TOKEN في Apps Script)','aria-label':'الرمز السري'});
    const nm=el('input',{type:'text',maxlength:'30',value:cfg.name||'',placeholder:'اسم الجهاز (مثلاً: موبايل كريم) — بيظهر في «الأجهزة المتصلة»','aria-label':'اسم الجهاز'});
    const msg=el('p',{class:'err'});
    const vals=()=>{const u=url.value.trim(),t=tok.value.trim()||cfg.token||'';
      if(!/^https:\/\/script\.google\.com\/.+\/exec$/.test(u)){msg.textContent='الرابط لازم يبقى رابط Web App من Google (بيبدأ بـ https://script.google.com وبينتهي بـ /exec)';return null}
      if(t.length<8){msg.textContent='الرمز السري قصير (8 حروف على الأقل)';return null}
      msg.textContent='';return{u,t}};
    const test=el('button',{class:'btn ghost',type:'button',onclick:async()=>{const v=vals();if(!v)return;test.disabled=true;msg.style.color='';msg.textContent='بنجرّب الاتصال…';
      try{await pingEndpoint(v.u,v.t,nm.value);msg.style.color='#1f9d76';msg.textContent='الاتصال شغال ✔'}catch(e){msg.style.color='';msg.textContent='فشل: '+e.message}test.disabled=false}},'اختبار الاتصال');
    const save=el('button',{class:'btn',type:'button',onclick:async()=>{const v=vals();if(!v)return;try{await saveConfig(v.u,v.t,{kind:'master',name:nm.value})}catch(e){msg.textContent=e.message;return}close();toast('تم حفظ إعدادات المزامنة');refresh()}},'حفظ');
    const close=modal('إعدادات الاتصال',el('label',{class:'field'},el('span',{},'رابط الـ Web App'),url),el('label',{class:'field'},el('span',{},'الرمز السري (الرئيسي)'),tok),el('label',{class:'field'},el('span',{},'اسم الجهاز'),nm),
      el('p',{class:'note'},'الرمز الرئيسي = SYNC_TOKEN في Apps Script، وبتحطّه على جهاز المالك بس. باقي الأجهزة بتتفعّل بكود من «الأجهزة المتصلة». الإعدادات دي بتتحفظ على الجهاز ده بس ومش بتتبعت مع البيانات.'),msg,test,el('div',{style:'height:8px'}),save);
  }
  root=el('div',{class:'wrap'},el('div',{class:'hello'},el('h2',{},'مركز المزامنة'),el('button',{class:'btn ghost',type:'button',onclick:()=>{off();onBack()}},'رجوع')),body);
  $('#app').replaceChildren(root);
  let t;off=subscribe(()=>{if(!root.isConnected){off();return}clearTimeout(t);t=setTimeout(refresh,120)});
  addEventListener('online',()=>root.isConnected&&refresh());addEventListener('offline',()=>root.isConnected&&refresh());
  await scanOrphans().catch(()=>{});                                          // العدّاد يبقى دقيق من أول ما الشاشة تفتح
  await refresh();
}
