// وضع التجربة (v21): قاعدة بيانات منفصلة تماماً (aliraqi_demo) على نفس الجهاز، من غير مزامنة (sync.js بيقف لوحده في الوضع ده).
// بياناتك الحقيقية (قاعدة aliraqi) ما بتتلمسش أبداً. التبديل بيتم بعلامة localStorage.alr_demo وإعادة تحميل الصفحة (db.js بيختار اسم القاعدة وقت التحميل).
import {isDemo} from './db.js';
import {el,toast} from './ui.js';
export {isDemo};
const DEMO_DB='aliraqi_demo';
const reload=()=>location.reload();

export function enterDemo(){
  if(!window.confirm('الدخول لوضع التجربة؟\n\nبيفتح نسخة تانية فاضية من التطبيق على نفس الجهاز، مفيش مزامنة معاها خالص، وبياناتك الحقيقية ما بتتأثرش. تقدر تخرج منه في أي وقت.'))return;
  try{localStorage.setItem('alr_demo','1')}catch{toast('تعذر تفعيل وضع التجربة على المتصفح ده');return}
  reload();
}
export function exitDemo(){
  try{localStorage.removeItem('alr_demo')}catch{}
  reload();
}
export function resetDemo(){
  if(!isDemo())return;
  if(!window.confirm('إعادة ضبط وضع التجربة؟ بيتمسح كل اللي اتعمل في التجربة بس (بياناتك الحقيقية ما بتتأثرش).'))return;
  const r=indexedDB.deleteDatabase(DEMO_DB);
  r.onsuccess=r.onerror=reload;
  r.onblocked=()=>toast('اقفل أي تبويب تاني مفتوح للتطبيق وجرّب تاني');
}
// شريط أصفر فوق + علامة صغيرة ثابتة تحت، وعنوان التبويب — عشان محدش يدخل بيانات حقيقية بالغلط جوه التجربة
export function mountDemoBar(){
  if(!isDemo()||document.getElementById('demoBar'))return;
  document.title='🧪 تجربة — '+document.title;
  const btn='border:1px solid #7a5200;background:transparent;color:#4a3200;border-radius:8px;padding:3px 10px;font:inherit;cursor:pointer';
  document.body.prepend(el('div',{id:'demoBar',role:'status',style:'background:#ffd54f;color:#4a3200;font-weight:700;font-size:13px;padding:6px 12px 6px 46px;display:flex;flex-wrap:wrap;gap:8px;align-items:center'},
    el('span',{style:'flex:1 1 200px'},'🧪 وضع التجربة — بيانات تجريبية منفصلة، مفيش مزامنة مع الشيت'),
    el('button',{type:'button',style:btn,onclick:resetDemo},'إعادة ضبط'),
    el('button',{type:'button',style:btn,onclick:exitDemo},'خروج من التجربة')));
  document.body.append(el('div',{style:'position:fixed;right:10px;bottom:calc(10px + env(safe-area-inset-bottom,0px));z-index:45;background:#ffd54f;color:#4a3200;font-weight:700;font-size:12px;padding:4px 10px;border-radius:999px;box-shadow:0 1px 6px rgba(0,0,0,.3);pointer-events:none'},'🧪 تجربة'));
}
// زرار بيتحط في شاشة الدخول: دخول التجربة (في الوضع العادي) أو الخروج منها
export function demoLink(){
  return el('button',{type:'button',class:'btn ghost',style:'margin-top:14px;width:100%',onclick:isDemo()?exitDemo:enterDemo},
    isDemo()?'↩ خروج من وضع التجربة (ارجع لبياناتك الحقيقية)':'🧪 وضع التجربة (بيانات تجريبية منفصلة)');
}
