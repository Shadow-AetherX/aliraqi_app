// الصلاحيات + الدخول. ملحوظة أمان: ده تحقق محلي للأوفلاين بس — الإنفاذ الحقيقي هيبقى في Apps Script وقت المزامنة.
import {all,get,put,uuid,txRun,nowISO} from './db.js';
export const PERMS=['ViewProducts','EditProducts','ChangeDefaultPrice','ViewStock','StockIn','StockOut','StockTransfer','CreateInvoice','EditInvoice','CancelInvoice','CreateReturn','ViewCustomers','EditCustomers','ViewReports','ViewCost','ViewAudit','ManageUsers','ManageRoles','ManageSettings','ManageSync','ManageWarehouses','OverridePrice','OverrideStock','VoidStockDoc'];
// الرتبة: رقم أقل = صلاحية أعلى. المستخدم ما يعدلش حد رتبته أعلى منه أو مساوية (إلا الـ Owner)
export const ROLES=[
  {RoleID:'OWNER',Name:'مالك / إدارة عليا',Rank:1,Perms:[...PERMS]},
  {RoleID:'MANAGER',Name:'إدارة',Rank:2,Perms:PERMS.filter(p=>p!=='ManageRoles')},
  {RoleID:'STAFF',Name:'موظف',Rank:3,Perms:PERMS.filter(p=>!['ManageRoles','ManageUsers','ManageWarehouses','ViewCost','ManageSettings','EditInvoice','CancelInvoice','CreateReturn','OverridePrice','ChangeDefaultPrice','VoidStockDoc'].includes(p))}
];
export const WAREHOUSES=[{WarehouseID:'WH-FAYEZ',Name:'مخزن فايز',Active:true},{WarehouseID:'WH-EZBET-AMR',Name:'مخزن عزبة عمرو',Active:true}];
const SEED_USERS=[['Karim','كريم','OWNER',1],['ElHag','الحاج','MANAGER',2],['Ahmed','أحمد','STAFF',3],['Nour','نور','STAFF',4]];
export async function sha256(s){const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s));return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('')}
export async function seedIfEmpty(){
  if((await all('roles')).length) return;
  for(const r of ROLES) await put('roles',r);
  for(const w of WAREHOUSES) await put('warehouses',w);
  for(const [id,name,role,rank] of SEED_USERS){
    const salt=uuid();
    // PIN مؤقت 0000 — لازم يتغير عند أول دخول (MustChangePin)
    await put('users',{UserID:id,Name:name,RoleID:role,Rank:rank,Active:true,Salt:salt,PinHash:await sha256(salt+'0000'),MustChangePin:true,ExtraPerms:[],DeniedPerms:[]});
  }
  await put('settings',{key:'company',Name:'العراقي للاستيراد وتجارة الأدوات المنزلية',EnName:'AL-IRAQI HOME APPLIANCES',Phone:'01105236152',Address:'5 شارع سيد مازن، النزهة الجديدة، الهايكستب'});
}
// الأدوار معرّفة في الكود: عند كل تشغيل بنحدّث الأدوار المخزّنة عشان تغيير الصلاحيات يوصل للأجهزة اللي اتعمل لها seed قبل كده (لحد ما نبني شاشة تعديل الأدوار)
export async function refreshRoles(){for(const r of ROLES) await put('roles',r)}
export async function login(userId,pin){
  const u=await get('users',userId);
  if(!u||!u.Active) return {ok:false,msg:'المستخدم غير متاح'};
  if(u.PinHash==='!') return {ok:false,msg:'الحساب ده جاي من جهاز تاني ولسه ما اتحطش له رقم سري على الجهاز ده — اطلب من المالك يعيّنه من «المستخدمين»'};
  if(await sha256(u.Salt+pin)!==u.PinHash) return {ok:false,msg:'الرقم السري غير صحيح'};
  return {ok:true,user:u};
}
export async function changePin(user,newPin,actor=user){
  if(!/^\d{4,8}$/.test(newPin)||newPin==='0000') return false;
  if(!await guardUserWrite(actor,user)) return false;
  user.Salt=uuid();user.PinHash=await sha256(user.Salt+newPin);user.MustChangePin=false;await put('users',user);return true;
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
// حارس إجباري لأي كتابة على حساب مستخدم (بيانات/صلاحيات/PIN): بيعيد قراءة الفاعل والهدف من قاعدة البيانات ومبيصدّقش الكائنات اللي جاية من الشاشة.
// أي حد رتبته أقل من OWNER ممنوع نهائياً يعدّل حساب المالك أو صلاحياته أو الـ PIN بتاعه، ولا يرقّي نفسه/غيره لـ OWNER. كل شاشة إدارة مستخدمين مستقبلاً لازم تكتب عن طريق saveUser/changePin بس.
async function guardUserWrite(actor,target){
  const a=await get('users',actor?.UserID);if(!a||!a.Active) return false;
  const cur=await get('users',target.UserID);
  if((cur&&cur.RoleID==='OWNER')||target.RoleID==='OWNER') return a.RoleID==='OWNER';
  if(a.UserID===target.UserID) return true;
  return canManageUser(a,cur||target);
}
export async function saveUser(actor,target){
  if(!await guardUserWrite(actor,target)) throw Object.assign(new Error('مفيش صلاحية تعديل الحساب ده'),{code:'USER_PROTECTED'});
  const now=nowISO();target.UpdatedAt=now;target.SyncStatus='PENDING';          // UpdatedAt = أساس «الأحدث يكسب» في المزامنة. الـ PIN نفسه مش بيتزامن أبداً
  await txRun(['users','syncq'],t=>{t.objectStore('users').put(target);
    t.objectStore('syncq').put({OpID:uuid(),Entity:'users',EntityID:target.UserID,Status:'PENDING',CreatedAt:now,Tries:0})});
  return target;
}
