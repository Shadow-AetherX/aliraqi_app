// مركز المزامنة (v14.1): مزامنة ثنائية الاتجاه مع Google Apps Script Web App — رفع طابور syncq ثم سحب التحديثات من الأجهزة التانية.
// القواعد: (1) مفيش حاجة بتتمسح محلياً. (2) كل عملية بتبعت «لقطة كاملة» للسجل (upsert بالمفتاح) فالإعادة آمنة (idempotent).
// (3) الـ PinHash/Salt ما بيتبعتوش أبداً (whitelist للمستخدمين + deepScrub لأي حاجة تانية). (4) أوفلاين = الطابور بيفضل زي ما هو.
import {all,get,put,byIndex,txRun,uuid,nowISO,deviceId,pendingCount} from './db.js';
import {can,ROLES,PERMS} from './auth.js';
import {$,el,toast,fmt,modal} from './ui.js';

const APP_VER='v14.1';
const KEYS={customers:'CustomerID',invoices:'InvoiceID',invoice_lines:'LineID',invoice_revisions:'RevisionID',credit_notes:'CreditNoteID',
  credit_note_lines:'LineID',movements:'MovementID',stock_docs:'DocID',audit:'AuditID',users:'UserID',products:'ProductID',warehouses:'WarehouseID'};
// جداول عليها SyncStatus (بتتعلّم SYNCED بعد الرفع، وبنفحصها لو سجل اتغيّر من غير ما يتحط في الطابور)
const SCAN=['customers','invoices','invoice_lines','invoice_revisions','credit_notes','credit_note_lines','movements','stock_docs','audit','warehouses','products','users'];
const USER_SAFE=['UserID','Name','RoleID','Rank','Active','UpdatedAt','ExtraPerms','DeniedPerms'];   // مفيش Salt ولا PinHash
const MAX_TRIES=8,BATCH_OPS=40,BATCH_ITEMS=80,BATCH_BYTES=300000,TIMEOUT=30000,MAX_BATCHES=60;

// ---------- إعدادات وحالة ----------
export const getConfig=async()=>(await get('settings','sync_config'))||{};
export const getInfo=async()=>(await get('settings','sync_state'))||{};
const saveInfo=async patch=>put('settings',{...(await getInfo()),...patch,key:'sync_state'});
export async function saveConfig(url,token){await put('settings',{key:'sync_config',url,token,UpdatedAt:nowISO()})}
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
async function post(url,payload){
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
export async function pingEndpoint(url,token){
  const r=await post(url,{action:'ping',token,app:APP_VER});
  if(!r.ok)throw new Error(r.error||'رفض من السيرفر');
  return true;
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
        ok++;q.put({...b.op,Status:'SYNCED',SyncedAt:now,LastError:null});
        if(b.sent&&SCAN.includes(b.op.Entity)){
          const s=t.objectStore(b.op.Entity);
          s.get(b.op.EntityID).onsuccess=e=>{const rec=e.target.result;   // نعلّم SYNCED بس لو السجل ما اتغيّرش بعد اللقطة اللي اتبعتت
            if(rec&&rec.SyncStatus==='PENDING'&&(rec.UpdatedAt||null)===(b.sent.UpdatedAt||null))s.put({...rec,SyncStatus:'SYNCED'})};
        }
      }else{
        bad++;const tries=(b.op.Tries||0)+1;
        q.put({...b.op,Tries:tries,LastTryAt:now,LastError:String(r.error||'خطأ').slice(0,200),Status:(r.permanent||tries>=MAX_TRIES)?'FAILED':'PENDING'});
      }
    }
  });
  return{ok,bad};
}
// سجلات متعلّمة PENDING ومالهاش عملية في الطابور (اتعدّلت من غير enqueue) — بنضيفها عشان ما تضيعش
export async function scanOrphans(){
  const queued=new Set((await byIndex('syncq','Status','PENDING')).map(o=>o.Entity+'|'+o.EntityID)),add=[];
  for(const s of SCAN)for(const r of await all(s)){
    const id=r[KEYS[s]];if(r.SyncStatus!=='PENDING'||!id||queued.has(s+'|'+id))continue;
    add.push({OpID:uuid(),Entity:s,EntityID:id,Status:'PENDING',CreatedAt:r.UpdatedAt||r.DateTime||r.CreatedAt||nowISO(),Tries:0,Orphan:true});
  }
  if(add.length)await txRun(['syncq'],t=>{for(const o of add)t.objectStore('syncq').put(o)});
  return add.length;
}

// ---------- السحب (Pull) ----------
// الشيت بقى مصدر الحقيقة المشترك: كل سجل متخزّن كامل (JSON) برقم تسلسلي عالمي _srv. كل جهاز بيحتفظ بآخر _srv وصله (sync_pull.cursor) وبيطلب اللي بعده على دفعات.
// قواعد الدمج على الجهاز (نفس منطق السيرفر):
//  - lww (عملاء/أصناف/مخازن/مستخدمين/فواتير/سطورها/مستندات مخزن/مرتجعات): السجل البعيد بيبدّل المحلي بس لو UpdatedAt بتاعه أحدث. لو المحلي لسه «بانتظار المزامنة» واتبدّل → بنسجّل تعارض (النسخة المحلية بتتحفظ في sync_conflicts).
//  - once (حركات المخزون/سجل العمليات/نسخ التعديل/سطور المرتجع): بتتضاف لو مش موجودة، ومبتتبدّلش أبداً.
//  - المستخدمين: بنسحب الاسم والدور والصلاحيات والحالة بس. الـ PIN مش بيتسحب ولا بيتبعت: مستخدم جديد جاي من جهاز تاني بيتعمل بـ PinHash='!' والمالك يعيّن له رقم من «المستخدمين».
//    ومفيش OWNER بييجي من السحابة، وحساب OWNER المحلي بيتجاهل أي تعديل جاي منها.
// السجلات المسحوبة بتتحط SyncStatus='SYNCED' ومبتدخلش الطابور — فمفيش دوران رفع/سحب.
const PULL_POLICY={customers:'lww',products:'lww',warehouses:'lww',users:'users',invoices:'lww',stock_docs:'lww',credit_notes:'lww',invoice_lines:'lww',
  credit_note_lines:'once',invoice_revisions:'once',movements:'once',audit:'once'};
const CHILD_STORES=['invoice_lines','credit_note_lines','invoice_revisions'];          // بيتبعتوا جوه عملية أبوهم
const PULL_LIMIT=200,MAX_PULL_PAGES=100,PULL_EVERY=60000,MAX_CONFLICTS=30;
const ROLE_RANK=new Map(ROLES.map(r=>[r.RoleID,r.Rank]));
export const getPullState=async()=>(await get('settings','sync_pull'))||{cursor:0};
const savePullState=async patch=>put('settings',{...(await getPullState()),...patch,key:'sync_pull'});
export const getConflicts=async()=>((await get('settings','sync_conflicts'))||{list:[]}).list;
const saveConflicts=async add=>{const cur=await getConflicts();await put('settings',{key:'sync_conflicts',list:[...add,...cur].slice(0,MAX_CONFLICTS)})};
export const clearConflicts=()=>put('settings',{key:'sync_conflicts',list:[]});
export async function resetPull(){await savePullState({cursor:0,resetAt:nowISO()})}   // السحب من الأول (آمن: الدمج بيتجاهل اللي موجود)

// دمج مستخدم جاي من السحابة: بيرجّع السجل اللي يتكتب محلياً أو null لو يتجاهل
function mergeUser(local,r){
  if(!r||typeof r.UserID!=='string'||!r.UserID)return null;
  if(!ROLE_RANK.has(r.RoleID)||r.RoleID==='OWNER')return null;                    // مفيش OWNER من السحابة
  if(local&&local.RoleID==='OWNER')return null;                                   // حساب المالك محلي بس
  const perms=a=>Array.isArray(a)?a.filter(p=>PERMS.includes(p)&&p!=='ManageRoles'&&!(p==='ManageUsers'&&r.RoleID==='STAFF')):[];
  const base={UserID:r.UserID,Name:String(r.Name||'').slice(0,40)||r.UserID,RoleID:r.RoleID,Rank:ROLE_RANK.get(r.RoleID),Active:r.Active!==false,
    ExtraPerms:perms(r.ExtraPerms),DeniedPerms:perms(r.DeniedPerms),UpdatedAt:r.UpdatedAt||null,SyncStatus:'SYNCED'};
  return local?{...local,...base}:{...base,Salt:uuid(),PinHash:'!',MustChangePin:true,FromSync:true};   // Salt/PinHash/MustChangePin المحلية بتفضل زي ما هي
}
async function applyPull(items){
  const pend=new Set([...await byIndex('syncq','Status','PENDING'),...await byIndex('syncq','Status','FAILED')].map(o=>o.Entity+'|'+o.EntityID));
  const ok=items.filter(it=>it&&PULL_POLICY[it.entity]&&it.data&&typeof it.data==='object'&&String(it.data[KEYS[it.entity]])===String(it.key));
  const st={added:0,updated:0,skipped:0,bad:items.length-ok.length,conflicts:0},conf=[];
  const stores=[...new Set(ok.map(i=>i.entity))];
  if(!stores.length)return{st,conf};
  await txRun(stores,t=>{
    for(const it of ok){
      const os=t.objectStore(it.entity),pol=PULL_POLICY[it.entity],r=it.data,key=String(it.key);
      os.get(key).onsuccess=e=>{
        const loc=e.target.result;
        if(pol==='once'){if(loc){st.skipped++;return}os.put({...r,SyncStatus:'SYNCED'});st.added++;return}
        if(loc&&!((r.UpdatedAt||'')>(loc.UpdatedAt||''))){st.skipped++;return}      // الأحدث يكسب (المتساوي بيتساب)
        let rec;
        if(pol==='users'){rec=mergeUser(loc,r);if(!rec){st.skipped++;return}}
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
    const res=await post(cfg.url,{action:'pull',token:cfg.token,device:deviceId(),app:APP_VER,cursor,limit:PULL_LIMIT});
    if(!res.ok){
      if(/action غير معروف/.test(res.error||''))throw new Error('Apps Script لسه على النسخة القديمة (من غير سحب) — الصق Code.gs الجديد واعمل Deploy ← Manage deployments ← New version');
      throw new Error(res.error||'رفض من السيرفر');
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
  const cfg=await getConfig();
  if(!cfg.url||!cfg.token)return{ok:false,error:'رابط المزامنة لسه ما اتضبطش — المالك يضبطه من «إعدادات الاتصال»'};
  if(!navigator.onLine)return{ok:false,offline:true,error:'أوفلاين — هتتزامن تلقائياً أول ما النت يرجع'};
  Object.assign(S,{running:true,phase:'push',done:0,total:0,pulled:0,error:''});emit();
  const attempted=new Set();let sent=0,failed=0,errMsg='',pr=null;
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
        const res=await post(cfg.url,{action:'sync',token:cfg.token,device:deviceId(),app:APP_VER,sentAt:nowISO(),
          ops:batch.map(x=>({opId:x.op.OpID,entity:x.op.Entity,key:x.op.EntityID,createdAt:x.op.CreatedAt,items:x.items}))});
        if(!res.ok)throw new Error(res.error||'رفض من السيرفر');           // رمز غلط أو خطأ عام: نوقف من غير ما نحسب محاولات على العمليات
        for(const r of res.results||[])results.set(r.opId,r);
      }
      for(const l of local)results.set(l.op.OpID,{ok:false,permanent:true,error:l.fail});
      const m=await markResults([...batch,...local],results);sent+=m.ok;failed+=m.bad;
      S.done+=batch.length+local.length;emit();
    }
    if(pull){S.phase='pull';emit();pr=await doPull(cfg)}
  }catch(e){errMsg=e.message||'تعذر الاتصال'}
  const patch={lastAttemptAt:nowISO(),lastError:errMsg||(failed?`${failed} عملية اترفضت من السيرفر (شوف تفاصيلها تحت)`:'')};
  if(!errMsg){patch.lastCount=sent;if(!failed)patch.lastSuccessAt=nowISO();if(pr){patch.lastPullAt=nowISO();patch.lastPullCount=pr.applied;patch.lastPullConflicts=pr.conflicts}}
  await saveInfo(patch).catch(()=>{});
  S.running=false;S.phase='';S.error=errMsg;emit();
  return{ok:!errMsg&&!failed,sent,failed,pulled:pr?.applied||0,conflicts:pr?.conflicts||0,error:errMsg||(failed?patch.lastError:'')};
}
export async function syncNow({manual=false,scan=false,pull=true}={}){
  if(S.running)return{ok:false,error:'المزامنة شغالة بالفعل'};
  if(navigator.locks)return navigator.locks.request('alr-sync',{ifAvailable:true},l=>l?doSync({manual,scan,pull}):{ok:false,error:'المزامنة شغالة في نافذة تانية'});
  return doSync({manual,scan,pull});
}
export const failedOps=()=>byIndex('syncq','Status','FAILED');
export async function retryFailed(){
  const f=await failedOps();
  if(f.length)await txRun(['syncq'],t=>{for(const o of f)t.objectStore('syncq').put({...o,Status:'PENDING',Tries:0,LastError:null})});
  return f.length;
}

// ---------- مزامنة تلقائية: كل 30 ثانية لو أونلاين وفيه عمليات معلقة، وسحب كل دقيقة (ومع الفتح ورجوع النت)، مع تأخير متزايد عند الفشل ----------
let timer,fails=0,nextAt=0,ticks=0,lastPull=0;
async function auto(full){
  if(!navigator.onLine||S.running||Date.now()<nextAt)return;
  const cfg=await getConfig();if(!cfg.url||!cfg.token)return;
  ticks++;if(full||ticks%10===0)await scanOrphans().catch(()=>{});
  const pending=await pendingCount().catch(()=>0),pullDue=full||morePull||Date.now()-lastPull>=PULL_EVERY;
  if(!pending&&!pullDue)return;
  const r=await syncNow({pull:pullDue});
  if(r.error&&!r.offline){fails++;nextAt=Date.now()+Math.min(30000*2**fails,600000)}else if(r.ok)fails=0;
  if(pullDue&&!r.error)lastPull=Date.now();
}
export function startAutoSync(){
  if(timer)return;
  timer=setInterval(()=>auto(false),30000);
  addEventListener('online',()=>{fails=0;nextAt=0;auto(true)});
  setTimeout(()=>auto(true),4000);
}

// ---------- الواجهة ----------
const fdt=iso=>{if(!iso)return null;const d=new Date(iso),p=n=>String(n).padStart(2,'0');return `${d.getFullYear()}/${p(d.getMonth()+1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`};
const ENT_AR={movements:'حركة مخزون',stock_docs:'مستند مخزن',customers:'عميل',invoices:'فاتورة',invoice_lines:'سطر فاتورة',invoice_revisions:'نسخة تعديل',credit_notes:'مرتجع',credit_note_lines:'سطر مرتجع',audit:'سجل عمليات',users:'مستخدم',products:'صنف',warehouses:'مخزن'};

export async function showSyncCenter(user,onBack){
  if(!await can(user,'ManageSync')){toast('مركز المزامنة للمدير/المالك بس');onBack();return}
  const isOwner=user.RoleID==='OWNER';
  const body=el('div',{});let off=()=>{},root,busy=false;
  const row=(k,v)=>el('div',{class:'drow'},el('span',{},k),el('b',{dir:'auto'},v));
  async function refresh(){
    if(busy)return;busy=true;
    try{
      const [n,failed,info,cfg,conflicts]=await Promise.all([pendingCount(),failedOps(),getInfo(),getConfig(),getConflicts()]);
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
        row('آخر مزامنة ناجحة',fdt(info.lastSuccessAt)||'لسه ما حصلتش'),row('آخر محاولة',fdt(info.lastAttemptAt)||'—'),
        info.lastCount!=null&&row('اللي اتبعت في آخر مرة',fmt(info.lastCount)+' عملية'),
        row('آخر سحب من الشيت',fdt(info.lastPullAt)||'لسه ما حصلش'),info.lastPullCount!=null&&row('اللي اتسحب في آخر مرة',fmt(info.lastPullCount)+' سجل'),
        conflicts.length>0&&el('div',{class:'editwarn'},el('b',{},`${fmt(conflicts.length)} تعارض اتحلّ بقاعدة «الأحدث يكسب»`),
          ...conflicts.slice(0,3).map(c=>el('div',{class:'drow'},el('span',{},`${ENT_AR[c.entity]||c.entity} · ${String(c.key).slice(0,8)}`),el('small',{},fdt(c.at)))),
          el('p',{class:'note'},'النسخة المحلية اللي اتبدّلت محفوظة في سجل التعارضات (اتساب جوه إعدادات الجهاز) لو احتجت ترجع لها.'),
          el('button',{class:'btn ghost',type:'button',onclick:async()=>{await clearConflicts();refresh()}},'مسح سجل التعارضات')),
        !conf&&el('p',{class:'note'},isOwner?'اضغط «إعدادات الاتصال» وحط رابط الـ Web App والرمز السري.':'المالك لازم يضبط رابط المزامنة الأول.'),
        failed.length>0&&el('div',{class:'voidbox'},el('b',{},`${fmt(failed.length)} عملية فشلت ومحتاجة مراجعة`),
          ...failed.slice(0,5).map(o=>el('div',{class:'drow'},el('span',{},`${ENT_AR[o.Entity]||o.Entity} · ${String(o.EntityID).slice(0,8)}`),el('small',{dir:'auto'},o.LastError||''))),
          el('button',{class:'btn ghost',type:'button',onclick:async()=>{const c=await retryFailed();toast(`رجّعنا ${fmt(c)} عملية للطابور`);refresh()}},'إعادة المحاولة للفاشلة')),
        isOwner&&el('div',{class:'btnrow act'},el('button',{class:'btn ghost',type:'button',onclick:()=>settingsForm(cfg)},'⚙️ إعدادات الاتصال'),
          el('button',{class:'btn ghost',type:'button',disabled:st.running,onclick:async()=>{
            if(!window.confirm('إعادة رفع كل البيانات المحلية للشيت؟ بتتعمل مرة واحدة بعد تحديث Code.gs (عشان السجلات القديمة تبقى قابلة للسحب على الأجهزة التانية). آمنة ومش بتكرر صفوف، لكن ممكن تاخد وقت لو البيانات كبيرة.'))return;
            const c=await repushAll();toast(`اتحطّ ${fmt(c)} سجل في طابور الرفع`);refresh()}},'⬆ إعادة رفع كل البيانات'),
          el('button',{class:'btn ghost',type:'button',disabled:st.running,onclick:async()=>{await resetPull();toast('هيتسحب كل شيء من الأول في المزامنة الجاية');refresh()}},'⬇ إعادة السحب من الصفر')));
    }finally{busy=false}
  }
  function settingsForm(cfg){
    const url=el('input',{type:'url',dir:'ltr',value:cfg.url||'',placeholder:'https://script.google.com/macros/s/.../exec','aria-label':'رابط الـ Web App'});
    const tok=el('input',{type:'password',dir:'ltr',autocomplete:'off',placeholder:cfg.token?'محفوظ — سيبه فاضي لو مش عايز تغيّره':'الرمز السري (نفس SYNC_TOKEN في Apps Script)','aria-label':'الرمز السري'});
    const msg=el('p',{class:'err'});
    const vals=()=>{const u=url.value.trim(),t=tok.value.trim()||cfg.token||'';
      if(!/^https:\/\/script\.google\.com\/.+\/exec$/.test(u)){msg.textContent='الرابط لازم يبقى رابط Web App من Google (بيبدأ بـ https://script.google.com وبينتهي بـ /exec)';return null}
      if(t.length<8){msg.textContent='الرمز السري قصير (8 حروف على الأقل)';return null}
      msg.textContent='';return{u,t}};
    const test=el('button',{class:'btn ghost',type:'button',onclick:async()=>{const v=vals();if(!v)return;test.disabled=true;msg.style.color='';msg.textContent='بنجرّب الاتصال…';
      try{await pingEndpoint(v.u,v.t);msg.style.color='#1f9d76';msg.textContent='الاتصال شغال ✔'}catch(e){msg.style.color='';msg.textContent='فشل: '+e.message}test.disabled=false}},'اختبار الاتصال');
    const save=el('button',{class:'btn',type:'button',onclick:async()=>{const v=vals();if(!v)return;await saveConfig(v.u,v.t);close();toast('تم حفظ إعدادات المزامنة');refresh()}},'حفظ');
    const close=modal('إعدادات الاتصال',el('label',{class:'field'},el('span',{},'رابط الـ Web App'),url),el('label',{class:'field'},el('span',{},'الرمز السري'),tok),
      el('p',{class:'note'},'الإعدادات دي بتتحفظ على الجهاز ده بس ومش بتتبعت مع البيانات. تغييرها للمالك بس.'),msg,test,el('div',{style:'height:8px'}),save);
  }
  root=el('div',{class:'wrap'},el('div',{class:'hello'},el('h2',{},'مركز المزامنة'),el('button',{class:'btn ghost',type:'button',onclick:()=>{off();onBack()}},'رجوع')),body);
  $('#app').replaceChildren(root);
  let t;off=subscribe(()=>{if(!root.isConnected){off();return}clearTimeout(t);t=setTimeout(refresh,120)});
  addEventListener('online',()=>root.isConnected&&refresh());addEventListener('offline',()=>root.isConnected&&refresh());
  await scanOrphans().catch(()=>{});                                          // العدّاد يبقى دقيق من أول ما الشاشة تفتح
  await refresh();
}
