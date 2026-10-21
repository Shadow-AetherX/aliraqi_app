// استعادة الشغل بعد القفل (v23.6): (1) نفتكر آخر شاشة رئيسية فتحها المستخدم (لكل مستخدم) ونرجّعله لها بعد ما يدخل الرقم السري تاني،
// (2) مسودات الشاشات اللي فيها إدخال (makeDraft): حفظ تلقائي بعد كل تغيير + حفظ فوري لحظة القفل/إخفاء الصفحة، وبتتمسح بعد الحفظ الناجح.
// كل ده في جدول settings على الجهاز (مش بيتزامن، مش بيدخل طابور المزامنة، مش بيلمس أي بيانات تشغيل). الجلسة نفسها لسه بتتقفل بالـPIN — الاستعادة بتحصل بعد دخول ناجح بس.
import {get,put} from './db.js';

const SKEY=u=>'ui_state:'+u,MAX_AGE=12*3600*1000;                   // الشاشة المحفوظة بتبطل بعد 12 ساعة
// ---------- ذاكرة الشاشة (الشاشة الرئيسية اللي اتفتحت من الرئيسية: kind='tile' اسم الخانة | 'prim' كود الزرار الكبير) ----------
export const rememberScreen=(userId,kind,id)=>put('settings',{key:SKEY(userId),kind,id,at:Date.now()}).catch(()=>{});
export const forgetScreen=userId=>put('settings',{key:SKEY(userId),kind:null,id:null,at:0}).catch(()=>{});
export async function recallScreen(userId){
  const r=await get('settings',SKEY(userId)).catch(()=>null);
  return r&&r.id&&Date.now()-r.at<MAX_AGE?{kind:r.kind,id:r.id,at:r.at}:null;
}

// ---------- تفريغ الحفظ ----------
// كل شاشة بتسجّل دالة «احفظ دلوقتي». بتتنادى لما الصفحة تتخفي/تتقفل (pagehide/visibilitychange) وقبل القفل بالخمول مباشرةً (قبل ما الشاشة تتشال).
// الدالة بتتخطّى لو الشاشة اتغيّرت (epoch) — عشان شاشة قديمة ما تكتبش مسودة تاني بعد ما المستخدم خرج منها أو حفظ.
let epoch=0;const flushers=new Map();
export const screenEpoch=()=>epoch;
export function onFlush(key,fn){flushers.set(key,{fn,epoch})}       // نسجّل بعد ما الشاشة تتحط على الصفحة (فالـepoch بيبقى الحالي)
export function flushAll(){for(const [k,f] of flushers){if(f.epoch!==epoch){flushers.delete(k);continue}try{f.fn()}catch{}}}
export function initSession(root){
  if(initSession.done)return;initSession.done=true;
  try{new MutationObserver(()=>{epoch++}).observe(root,{childList:true})}catch{}      // أي استبدال للشاشة = epoch جديد
  addEventListener('pagehide',flushAll);
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')flushAll()});
}

// ---------- مسودة شاشة ----------
// const d=makeDraft('stock:IN:'+user.UserID, ()=>({...الحالة الحالية...}));
// const saved=await d.load();            // قبل بناء الشاشة (بيرجّع null لو مفيش أو قديم)
// ... بناء الشاشة ...  d.arm();          // بعد ما الشاشة تتحط: من هنا أي d.touch() بيحفظ
// d.touch() بعد كل تغيير من المستخدم · d.clear() بعد الحفظ الناجح (بيوقف أي كتابة بعده) · d.reset() لزرار «مسح المسودة» (بيمسح من غير ما يوقف)
export function makeDraft(key,collect,{maxAge=7*864e5}={}){
  const k='draft:'+key;let tm=0,armed=false,off=false;
  const write=()=>{clearTimeout(tm);if(off||!armed)return Promise.resolve();let data;try{data=collect()}catch{return Promise.resolve()}return put('settings',{key:k,at:Date.now(),data}).catch(()=>{})};
  return{
    async load(){const r=await get('settings',k).catch(()=>null);return r&&r.data&&Date.now()-r.at<maxAge?r.data:null},
    arm(){armed=true;onFlush(k,write)},
    touch(){if(off||!armed)return;clearTimeout(tm);tm=setTimeout(write,400)},
    flush:write,
    async clear(){off=true;clearTimeout(tm);await put('settings',{key:k,at:0,data:null}).catch(()=>{})},
    async reset(){clearTimeout(tm);await put('settings',{key:k,at:0,data:null}).catch(()=>{})}
  };
}
