// زر الرجوع / السحب من الحافة (v21): يرجّع خطوة جوه التطبيق بدل ما يخرج من الصفحة.
// التصميم: history.pushState كحارس (بيتحط عند أول لمسة). على popstate:
//  (أ) فيه نافذة مفتوحة (.overlay) ← تتقفل (وكاميرا المسح تتقفل معاها).
//  (ب) فيه زرار «رجوع» ظاهر في الشاشة ← بيتضغط.
//  (ج) الرئيسية/الدخول ← «اضغط رجوع تاني للخروج» لمدة ثانيتين؛ الضغطة التانية بتسيب المتصفح يخرج فعلاً (مش بنرجّع الحارس في الفترة دي).
import {toast} from './ui.js';
const EXIT_MS=2000;
let guard=false,armed=false,armT=0,started=false;
const BACK_RE=/^[\s←→‹›<>«»]*رجوع/;                         // «رجوع» / «← رجوع» — مش «خروج» ومش «مرتجع»
const topOverlay=()=>{const l=document.querySelectorAll('.overlay');return l.length?l[l.length-1]:null};
function stopCams(){import('./scanner.js').then(m=>m.stopAllScanners&&m.stopAllScanners()).catch(()=>{})}
function closeOverlay(ov){
  const b=ov.querySelector('.x')||ov.querySelector('.scanbar button');
  if(b)b.click();else ov.click();                           // النوافذ العامة بتتقفل بالضغط على الخلفية
  if(ov.isConnected){stopCams();ov.remove()}                // لو ما اتقفلتش بنفسها نشيلها بإيدينا ونقفل الكاميرا
}
function backButton(){
  const app=document.getElementById('app');if(!app)return null;
  const find=root=>[...root.querySelectorAll('button')].find(b=>!b.disabled&&BACK_RE.test(b.textContent||''));
  return find(app.querySelector('.hello')||app)||find(app)||null;
}
function pushGuard(){if(guard)return;try{history.pushState({alr:'guard'},'');guard=true}catch{}}
function disarm(){clearTimeout(armT);if(!armed)return;armed=false;pushGuard()}
function onPop(e){
  if(!guard)return;                                         // مش من عندنا (أو الضغطة التانية بتاعة الخروج)
  if(e.state&&e.state.alr==='guard')return;                 // رجوع لقدّام لحارسنا
  guard=false;
  const ov=topOverlay();
  if(ov){closeOverlay(ov);pushGuard();return}
  const b=backButton();
  if(b){b.click();pushGuard();return}
  armed=true;toast('اضغط رجوع تاني للخروج');clearTimeout(armT);armT=setTimeout(disarm,EXIT_MS);
}
export function installNav(){
  if(started||typeof history==='undefined'||typeof document==='undefined')return;
  started=true;
  try{history.replaceState({alr:'base'},'')}catch{}
  // الحارس بيتحط عند أول لمسة (بعض المتصفحات بتتخطى إدخالات التاريخ اللي اتضافت من غير تفاعل مستخدم)
  const first=()=>{removeEventListener('pointerdown',first,true);removeEventListener('keydown',first,true);pushGuard()};
  addEventListener('pointerdown',first,true);addEventListener('keydown',first,true);
  addEventListener('pointerdown',()=>{if(armed)disarm()},true);   // لمسة أثناء «اضغط تاني للخروج» = لسه شغال، نرجّع الحارس
  addEventListener('popstate',onPop);
}
installNav();
