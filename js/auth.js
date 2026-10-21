// الصلاحيات + الدخول. ملحوظة أمان: ده تحقق محلي للأوفلاين بس — الإنفاذ الحقيقي هيبقى في Apps Script وقت المزامنة.
import {all,get,put,uuid,txRun,nowISO,deviceId} from './db.js';
export const PERMS=['ViewProducts','EditProducts','ChangeDefaultPrice','ViewStock','StockIn','StockOut','StockTransfer','CreateInvoice','EditInvoice','CancelInvoice','CreateReturn','ViewCustomers','EditCustomers','ViewReports','ViewCost','ViewAudit','ManageUsers','ManageRoles','ManageSettings','ManageSync','ManageWarehouses','OverridePrice','OverrideStock','VoidStockDoc','StockAdjust','DeleteProducts'];
// الرتبة: رقم أقل = صلاحية أعلى. المستخدم ما يعدلش حد رتبته أعلى منه أو مساوية (إلا الـ Owner)
export const ROLES=[
  {RoleID:'OWNER',Name:'مالك / إدارة عليا',Rank:1,Perms:[...PERMS]},
  {RoleID:'MANAGER',Name:'إدارة',Rank:2,Perms:PERMS.filter(p=>p!=='ManageRoles')},
  {RoleID:'STAFF',Name:'موظف',Rank:3,Perms:PERMS.filter(p=>!['ManageRoles','ManageUsers','ManageWarehouses','ViewCost','ManageSettings','EditInvoice','CancelInvoice','CreateReturn','OverridePrice','ChangeDefaultPrice','VoidStockDoc','StockAdjust','DeleteProducts'].includes(p))}
];
export const WAREHOUSES=[{WarehouseID:'WH-FAYEZ',Name:'مخزن فايز',Active:true},{WarehouseID:'WH-EZBET-AMR',Name:'مخزن عزبة عمرو',Active:true}];
const SEED_USERS=[['Karim','كريم','OWNER',1],['ElHag','الحاج','MANAGER',2],['Ahmed','أحمد','STAFF',3],['Nour','نور','STAFF',4]];
const PIN_RE=/^\d{4,8}$/, ITER=150000, MAX_FAILS=5;
export const pinValid=p=>PIN_RE.test(String(p))&&String(p)!=='0000';
export async function sha256(s){const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s));return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('')}
// ---- تشفير الـ PIN: PBKDF2-SHA256. الصيغة المخزّنة: pbkdf2$<iterations>$<hex>. الصيغة القديمة (SHA-256 عادي) لسه بتتقرا وبتترقّى أوتوماتيك عند أول دخول ناجح ----
async function pbkdf2(pin,salt,iter){
  const enc=new TextEncoder(),key=await crypto.subtle.importKey('raw',enc.encode(pin),'PBKDF2',false,['deriveBits']);
  const bits=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:enc.encode(salt),iterations:iter},key,256);
  return [...new Uint8Array(bits)].map(x=>x.toString(16).padStart(2,'0')).join('');
}
const hashPin=async(salt,pin)=>`pbkdf2$${ITER}$${await pbkdf2(pin,salt,ITER)}`;
const sameStr=(a,b)=>{if(a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0};
async function verifyHash(u,pin){
  const h=String(u.PinHash||'');
  if(h.startsWith('pbkdf2$')){const [,it,hex]=h.split('$');return sameStr(await pbkdf2(pin,u.Salt,Number(it)||ITER),hex||'')}
  return sameStr(await sha256(u.Salt+pin),h);
}
// ---- قفل المحاولات الغلط (محلي على الجهاز، مش بيتزامن): من الخامسة بيقفل 30 ث وبيتضاعف لحد 15 د. النجاح بيصفّر العدّاد ----
const waitTxt=ms=>{const s=Math.ceil(ms/1000);return s>=60?`${Math.ceil(s/60)} دقيقة`:`${s} ثانية`};
// تسجيل قفل الحساب في سجل العمليات (v22) — بيتزامن للمالك. المحاولة الغلط العادية مش بتتسجّل (عشان ما نملّاش السجل)
async function logLock(u,fails){
  const now=nowISO(),id=uuid();
  await txRun(['audit','syncq'],t=>{
    t.objectStore('audit').put({AuditID:id,UserID:u.UserID,UserName:u.Name,Action:'PIN_LOCK',EntityType:'User',EntityID:u.UserID,DateTime:now,DeviceID:deviceId(),OldValue:null,NewValue:null,Notes:`${fails} محاولات رقم سري غلط — الحساب اتقفل مؤقتاً`,SyncStatus:'PENDING'});
    t.objectStore('syncq').put({OpID:uuid(),Entity:'audit',EntityID:id,Status:'PENDING',CreatedAt:now,Tries:0});
  }).catch(()=>{});
}
async function checkPin(u,pin){
  const k='pinlock:'+u.UserID,st=(await get('settings',k))||{key:k,fails:0,until:0},now=Date.now();
  if(st.until>now) return {ok:false,msg:`محاولات غلط كتير — جرّب بعد ${waitTxt(st.until-now)}`};
  if(await verifyHash(u,String(pin))){
    if(st.fails||st.until) await put('settings',{key:k,fails:0,until:0});
    if(!String(u.PinHash).startsWith('pbkdf2$')){u.PinHash=await hashPin(u.Salt,String(pin));await put('users',u)}   // ترقية صيغة الـ PIN القديمة بصمت (من غير UpdatedAt ولا مزامنة: الـ PIN مش بيتزامن أصلاً)
    return {ok:true};
  }
  st.fails=(st.fails||0)+1;st.until=st.fails>=MAX_FAILS?now+Math.min(30*2**(st.fails-MAX_FAILS),900)*1000:0;await put('settings',st);
  if(st.until)await logLock(u,st.fails);
  return {ok:false,msg:st.until?`الرقم السري غلط — الحساب اتقفل ${waitTxt(st.until-now)}`:`الرقم السري غير صحيح (باقي ${MAX_FAILS-st.fails} محاولات قبل القفل)`};
}
export async function seedIfEmpty(){
  if((await all('roles')).length) return;
  for(const r of ROLES) await put('roles',r);
  for(const w of WAREHOUSES) await put('warehouses',w);
  // مفيش PIN افتراضي نهائياً: كل الحسابات بتبدأ PinHash='!' (مقفولة). المالك بيحدد رقمه من شاشة «تفعيل الجهاز» (pendingOwner/activateOwner)، والمالك بعدها بيعيّن أرقام الموظفين من «المستخدمين».
  for(const [id,name,role,rank] of SEED_USERS)
    await put('users',{UserID:id,Name:name,RoleID:role,Rank:rank,Active:true,Salt:uuid(),PinHash:'!',MustChangePin:role!=='OWNER',ExtraPerms:[],DeniedPerms:[]});
  await put('settings',{key:'company',Name:'العراقي للاستيراد وتجارة الأدوات المنزلية',EnName:'AL-IRAQI HOME APPLIANCES',Phone:'01105236152',Address:'5 شارع سيد مازن، النزهة الجديدة، الهايكستب'});
}
// ---- الأدوار القابلة للتعديل (v23.6: شاشة «الأدوار والصلاحيات») ----
// الأدوار الأساسية والرتب معرّفة في الكود. المالك يقدر يخصّص صلاحيات «إدارة» و«موظف» بس (OWNER ثابت). التخصيص بيتخزّن في جدول roles نفسه (Custom:true) وبيتزامن زي المستخدمين.
export const CUSTOMIZABLE=['MANAGER','STAFF'];
// صلاحيات مقفولة بالدور: ManageRoles للمالك بس، و ManageUsers ممنوعة على الـ STAFF
export const permLocked=(roleId,perm)=>(perm==='ManageRoles'&&roleId!=='OWNER')||(perm==='ManageUsers'&&roleId==='STAFF');
export const sanitizePerms=(roleId,perms)=>[...new Set(Array.isArray(perms)?perms:[])].filter(p=>PERMS.includes(p)&&!permLocked(roleId,p));
// الأدوار معرّفة في الكود: عند كل تشغيل بنحدّث الأدوار المخزّنة عشان تغيير الصلاحيات في الكود يوصل للأجهزة — إلا الدور اللي المالك خصّصه (Custom) فبنحافظ على صلاحياته (بعد تنقيتها) ونحدّث الاسم والرتبة بس.
export async function refreshRoles(){
  for(const r of ROLES){
    const cur=await get('roles',r.RoleID);
    if(CUSTOMIZABLE.includes(r.RoleID)&&cur&&cur.Custom){
      const perms=sanitizePerms(r.RoleID,cur.Perms);
      if(perms.length){await put('roles',{...cur,Name:r.Name,Rank:r.Rank,Perms:perms});continue}
    }
    await put('roles',{...r,...(cur&&cur.UpdatedAt?{UpdatedAt:cur.UpdatedAt,UpdatedBy:cur.UpdatedBy,SyncStatus:cur.SyncStatus}:{})});
  }
}
// تعديل صلاحيات دور (perms) أو الرجوع للافتراضي (perms=null). بيعيد قراءة الفاعل من القاعدة: المالك بس. كل حاجة (الدور + طابور المزامنة + سجل العمليات) في معاملة واحدة.
export async function saveRole(actor,roleId,perms){
  const bad=(m,c)=>Object.assign(new Error(m),{code:c});
  const a=await get('users',actor?.UserID);
  if(!a||!a.Active||a.RoleID!=='OWNER'||!await can(a,'ManageRoles')) throw bad('تعديل الأدوار للمالك بس','ROLE_PROTECTED');
  if(!CUSTOMIZABLE.includes(roleId)) throw bad('الدور ده ثابت','ROLE_PROTECTED');
  const base=ROLES.find(r=>r.RoleID===roleId),cur=await get('roles',roleId);
  const want=perms==null?[...base.Perms]:sanitizePerms(roleId,perms);
  if(!want.length) throw bad('الدور لازم يفضل فيه صلاحية واحدة على الأقل','ROLE_INVALID');
  const same=sortedJ(want)===sortedJ(base.Perms),now=nowISO(),dev=deviceId();
  const rec={RoleID:roleId,Name:base.Name,Rank:base.Rank,Perms:want,Custom:!same,UpdatedAt:now,UpdatedBy:a.UserID,SyncStatus:'PENDING'};
  await txRun(['roles','syncq','audit'],t=>{
    t.objectStore('roles').put(rec);
    t.objectStore('syncq').put({OpID:uuid(),Entity:'roles',EntityID:roleId,Status:'PENDING',CreatedAt:now,Tries:0});
    t.objectStore('audit').put({AuditID:uuid(),UserID:a.UserID,UserName:a.Name,Action:perms==null?'ROLE_RESET':'ROLE_EDIT',EntityType:'Role',EntityID:roleId,DateTime:now,DeviceID:dev,
      OldValue:JSON.stringify({Perms:cur?.Perms||base.Perms}),NewValue:JSON.stringify({Perms:want,Custom:!same}),Notes:'',SyncStatus:'PENDING'});
  });
  return rec;
}
// تفعيل الجهاز: بس لو حساب المالك لسه من غير PIN (جهاز جديد). مش بتشتغل لو المالك له PIN — يعني مش وسيلة لإعادة تعيين PIN المالك.
export async function pendingOwner(){return (await all('users')).find(u=>u.RoleID==='OWNER'&&u.Active&&u.PinHash==='!')||null}
export async function activateOwner(pin){
  const o=await pendingOwner();if(!o||!pinValid(pin)) return null;
  o.Salt=uuid();o.PinHash=await hashPin(o.Salt,String(pin));o.MustChangePin=false;await put('users',o);return o;
}
export async function login(userId,pin){
  if((await get('settings','device_state'))?.revoked) return {ok:false,msg:'الجهاز ده اتوقف من المالك — تواصل معاه'};   // v22: إيقاف جهاز عن بعد
  const u=await get('users',userId);
  if(!u||!u.Active) return {ok:false,msg:'المستخدم غير متاح'};
  if(u.PinHash==='!') return {ok:false,msg:u.RoleID==='OWNER'?'الجهاز ده لسه ما اتفعّلش — افتح الصفحة تاني وفعّله برقم المالك':'الحساب ده لسه ما اتحطش له رقم سري على الجهاز ده — اطلب من المالك يعيّنه من «المستخدمين»'};
  const r=await checkPin(u,pin);
  if(!r.ok) return r;
  return {ok:true,user:await get('users',userId)};
}
// تغيير الـ PIN. بيشتغل دايماً على نسخة القاعدة (مش على الكائن اللي جاي من الشاشة). تغيير رقمك بنفسك بيطلب الرقم القديم (إلا في أول دخول بعد رقم مؤقت).
// بيرجّع false لو الرقم الجديد مش صالح أو مفيش صلاحية؛ وبيرمي خطأ code='OLD_PIN' لو الرقم القديم غلط/الحساب مقفول.
export async function changePin(user,newPin,actor=user,oldPin){
  if(!pinValid(newPin)) return false;
  const cur=await get('users',user?.UserID);if(!cur) return false;
  if(!await guardUserWrite(actor,cur)) return false;
  if(actor?.UserID===cur.UserID&&!cur.MustChangePin){
    const r=await checkPin(cur,String(oldPin??''));
    if(!r.ok) throw Object.assign(new Error(r.msg||'الرقم القديم غير صحيح'),{code:'OLD_PIN'});
  }
  cur.Salt=uuid();cur.PinHash=await hashPin(cur.Salt,String(newPin));cur.MustChangePin=false;await put('users',cur);
  Object.assign(user,{Salt:cur.Salt,PinHash:cur.PinHash,MustChangePin:false});return true;
}
export async function can(user,perm){
  if(user.RoleID==='OWNER') return PERMS.includes(perm);   // صلاحيات المالك ثابتة ومحدش يقدر يسحب منها (DeniedPerms مش بتسري عليه)
  const role=await get('roles',user.RoleID);
  const set=new Set([...(role?.Perms||[]),...(user.ExtraPerms||[])]);
  (user.DeniedPerms||[]).forEach(p=>set.delete(p));
  return set.has(perm);
}
// هل actor يقدر يعدّل على target (بياناته/صلاحياته)؟
export function canManageUser(actor,target){
  if(target.RoleID==='OWNER'&&actor.RoleID!=='OWNER') return false;   // حساب المالك (كريم): محدش أقل منه يعدّله أبداً
  return actor.RoleID==='OWNER'||actor.Rank<target.Rank;
}
const sortedJ=a=>JSON.stringify([...(a||[])].sort());
// حارس إجباري لأي كتابة على حساب مستخدم (بيانات/صلاحيات/PIN): بيعيد قراءة الفاعل والهدف من قاعدة البيانات ومبيصدّقش الكائنات اللي جاية من الشاشة.
// - حساب المالك: المالك بس يعدّله، ومينفعش يتنزّل أو يتوقف، ومحدش بيتعمل OWNER جديد من هنا.
// - تعديل حسابك (غير المالك): الاسم بس — الدور/الرتبة/الحالة/الصلاحيات ثابتة (ده اللي بيمنع الترقية الذاتية من الـ Console).
// - تعديل حساب غيرك: لازم ManageUsers + رتبتك أعلى + الدور/الرتبة الجديدة أقل من رتبتك + مفيش صلاحية إضافية انت نفسك معاكش (ومفيش ManageRoles/ManageUsers لموظف).
async function guardUserWrite(actor,target){
  const a=await get('users',actor?.UserID);if(!a||!a.Active) return false;
  const cur=await get('users',target.UserID);
  if((cur&&cur.RoleID==='OWNER')||target.RoleID==='OWNER'){
    if(a.RoleID!=='OWNER'||!cur) return false;
    return target.RoleID==='OWNER'&&target.Active!==false;
  }
  const self=a.UserID===target.UserID;
  if(self&&cur){
    return target.RoleID===cur.RoleID&&target.Rank===cur.Rank&&target.Active===cur.Active
      &&sortedJ(target.ExtraPerms)===sortedJ(cur.ExtraPerms)&&sortedJ(target.DeniedPerms)===sortedJ(cur.DeniedPerms);
  }
  if(self) return false;                                                       // حساب جديد بنفس رقم المستخدم الفاعل؟ مستحيل
  if(!await can(a,'ManageUsers')) return false;
  if(cur&&!canManageUser(a,cur)) return false;
  if(a.RoleID!=='OWNER'){
    const role=ROLES.find(r=>r.RoleID===target.RoleID);
    if(!role||role.Rank<=a.Rank||!(Number(target.Rank)>a.Rank)) return false;
    const had=new Set(cur?.ExtraPerms||[]);
    for(const p of target.ExtraPerms||[]) if(!had.has(p)&&!await can(a,p)) return false;   // مفيش حد بيدّي صلاحية هو نفسه معاهوش
  }
  for(const p of target.ExtraPerms||[]){
    if(!PERMS.includes(p)||p==='ManageRoles'||(p==='ManageUsers'&&target.RoleID==='STAFF')) return false;
  }
  return true;
}
export async function saveUser(actor,target){
  if(!await guardUserWrite(actor,target)) throw Object.assign(new Error('مفيش صلاحية تعديل الحساب ده'),{code:'USER_PROTECTED'});
  const now=nowISO();target.UpdatedAt=now;target.UpdatedBy=actor.UserID;target.SyncStatus='PENDING';   // UpdatedBy: الأجهزة التانية بتقبل تغيير الصلاحيات بس لو جاي من مالك/مدير مسموح له          // UpdatedAt = أساس «الأحدث يكسب» في المزامنة. الـ PIN نفسه مش بيتزامن أبداً
  await txRun(['users','syncq'],t=>{t.objectStore('users').put(target);
    t.objectStore('syncq').put({OpID:uuid(),Entity:'users',EntityID:target.UserID,Status:'PENDING',CreatedAt:now,Tries:0})});
  return target;
}
