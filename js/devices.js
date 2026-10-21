// الأجهزة (v22): (1) ربط جهاز بكود تفعيل من المالك  (2) «الأجهزة المتصلة» للمالك: مين متصل دلوقتي، آخر ظهور، المستخدم، النسخة  (3) إيقاف/تفعيل جهاز عن بعد  (4) طلع كود تفعيل جديد.
// الحماية الحقيقية على السيرفر (Code.gs): الشاشة دي بتعرض وبتطلب بس. عمليات الإدارة بتشتغل بالرمز الرئيسي (SYNC_TOKEN) المتسجّل على جهاز المالك بس.
import {$,el,toast,modal,confirmAction} from './ui.js';
import {isDemo} from './db.js';
import {adminCall,enrollDevice,getConfig,syncNow,skewLabel,SKEW_WARN} from './sync.js';

const pad=n=>String(n).padStart(2,'0');
const fdt=ms=>{if(!ms)return '—';const d=new Date(ms);return `${d.getFullYear()}/${pad(d.getMonth()+1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`};
export function ago(ms,now=Date.now()){
  if(!ms)return 'لسه ما ظهرش';
  const s=Math.max(0,Math.round((now-ms)/1000));
  if(s<90)return 'دلوقتي';
  const m=Math.round(s/60);if(m<60)return `من ${m} دقيقة`;
  const h=Math.round(m/60);if(h<48)return `من ${h} ساعة`;
  return `من ${Math.round(h/24)} يوم`;
}
const KIND={device:'مفعّل بكود',master:'الرمز الرئيسي'};

// ---------- ربط الجهاز بكود ----------
export function enrollDialog({onDone}={}){
  if(isDemo()){toast('وضع التجربة: المزامنة متوقفة');return}
  getConfig().then(cfg=>{
    const url=el('input',{type:'url',dir:'ltr',value:cfg.url||'',placeholder:'https://script.google.com/macros/s/.../exec','aria-label':'رابط الـ Web App'});
    const code=el('input',{type:'text',dir:'ltr',autocomplete:'off',autocapitalize:'characters',maxlength:'12',placeholder:'XXXX-XXXX','aria-label':'كود التفعيل',style:'letter-spacing:.15em;font-weight:700'});
    const name=el('input',{type:'text',maxlength:'30',value:cfg.name||'',placeholder:'اسم الجهاز (مثلاً: موبايل أحمد)','aria-label':'اسم الجهاز'});
    const msg=el('p',{class:'err'});let busy=false;
    const go=el('button',{class:'btn',type:'button',onclick:async()=>{
      if(busy)return;busy=true;go.disabled=true;msg.style.color='';msg.textContent='بنربط الجهاز…';
      try{await enrollDevice(url.value,code.value,name.value);close();toast('✅ الجهاز اتربط — بنسحب البيانات');onDone?.();syncNow({manual:true}).then(()=>onDone?.()).catch(()=>{})}
      catch(e){msg.textContent=e.message||'تعذر الربط';busy=false;go.disabled=false}}},'ربط الجهاز');
    code.addEventListener('keydown',e=>{if(e.key==='Enter')go.click()});
    const close=modal('ربط الجهاز بالمزامنة',
      el('p',{class:'note'},'اطلب من المالك «كود تفعيل» (من مركز المزامنة ← الأجهزة المتصلة). الكود بيشتغل مرة واحدة وبينتهي بعد مدة.'),
      el('label',{class:'field'},el('span',{},'رابط الـ Web App'),url),el('label',{class:'field'},el('span',{},'كود التفعيل'),code),el('label',{class:'field'},el('span',{},'اسم الجهاز'),name),msg,go);
    code.focus();
  });
}
// زرار في شاشة الدخول: بيظهر بس لو المزامنة لسه ما اتضبطتش على الجهاز
export const enrollLink=()=>isDemo()?null:el('button',{type:'button',class:'btn ghost',style:'margin-top:10px;width:100%',onclick:()=>enrollDialog()},'🔗 ربط الجهاز بالمزامنة (بكود تفعيل)');

// ---------- كود جديد ----------
async function newCodeFlow(refresh){
  const label=el('input',{type:'text',maxlength:'30',placeholder:'لمين الكود؟ (مثلاً: موبايل نور)','aria-label':'اسم صاحب الكود'});
  const hrs=el('select',{'aria-label':'مدة الصلاحية'},[[1,'ساعة'],[6,'6 ساعات'],[24,'24 ساعة'],[72,'3 أيام']].map(([v,t])=>el('option',{value:String(v),selected:v===24},t)));
  const msg=el('p',{class:'err'});
  const go=el('button',{class:'btn',type:'button',onclick:async()=>{
    go.disabled=true;msg.textContent='';
    try{const r=await adminCall('newcode',{label:label.value,hours:Number(hrs.value)});close();showCode(r);refresh()}
    catch(e){msg.textContent=e.message;go.disabled=false}}},'طلّع الكود');
  const close=modal('كود تفعيل جديد',el('label',{class:'field'},el('span',{},'لمين الكود؟'),label),el('label',{class:'field'},el('span',{},'صالح لمدة'),hrs),msg,go);
}
function showCode(r){
  const copy=el('button',{class:'btn ghost',type:'button',onclick:async()=>{try{await navigator.clipboard.writeText(r.code);toast('اتنسخ الكود')}catch{toast('انسخه يدوي من الشاشة')}}},'📋 نسخ');
  modal('كود التفعيل',
    el('div',{dir:'ltr',style:'font-size:2.1rem;font-weight:800;letter-spacing:.2em;text-align:center;padding:14px 0;user-select:all'},r.code),
    el('p',{class:'note'},`صالح لحد ${fdt(r.expires)} (${r.hours} ساعة) ويشتغل مرة واحدة بس.`),
    el('ol',{class:'note'},el('li',{},'في الجهاز الجديد: شاشة الدخول ← «ربط الجهاز بالمزامنة».'),el('li',{},'الصق رابط الـ Web App واكتب الكود واسم الجهاز.'),el('li',{},'ابعت الكود لصاحب الجهاز بنفسك (مكالمة/رسالة) — أي حد يشوفه قبل ما يتستخدم يقدر يستخدمه.')),copy);
}

// ---------- الأجهزة المتصلة ----------
export async function showDevices(user,onBack){
  if(user.RoleID!=='OWNER'){toast('الأجهزة المتصلة للمالك بس');onBack();return}
  const body=el('div',{});let timer=0,root,busy=false;
  const act=async(d,action)=>{
    if(action==='disable'&&!await confirmAction('إيقاف الجهاز',`إيقاف الجهاز «${d.name||d.id}»؟ هيتقفل عند أول اتصال بالنت (مفيش دخول ولا مزامنة)، وتقدر تفعّله تاني في أي وقت. لو الجهاز أوفلاين هيفضل شغال لحد ما يتصل.`,'إيقاف الجهاز'))return;
    try{await adminCall(action,{target:d.id});toast(action==='disable'?'⛔ اتوقف الجهاز':'✅ اتفعّل الجهاز');load()}catch(e){toast(e.message||'تعذر تنفيذ العملية')}
  };
  const card=(d,now)=>el('div',{class:'pcard',style:'padding:12px;margin:8px 0'},
    el('div',{class:'drow'},el('b',{},(d.online?'🟢 ':d.st==='DISABLED'?'⛔ ':'⚪ ')+(d.name||d.id)+(d.me?' (ده الجهاز بتاعك)':'')),
      el('span',{class:'bdg '+(d.st==='DISABLED'?'no':d.online?'ok':'warn')},d.st==='DISABLED'?'موقوف':d.online?'متصل الآن':'غير متصل')),
    el('div',{class:'drow'},el('span',{},'آخر ظهور'),el('b',{},ago(d.seen,now)+(d.seen?` · ${fdt(d.seen)}`:''))),
    el('div',{class:'drow'},el('span',{},'المستخدم'),el('b',{},d.user||'—')),
    el('div',{class:'drow'},el('span',{},'الربط · النسخة'),el('b',{},`${KIND[d.kind]||d.kind} · ${d.ver||'—'}`)),
    d.skewAt?el('div',{class:'drow'},el('span',{},'ساعة الجهاز'),Math.abs(d.skew)<SKEW_WARN?el('b',{},'مضبوطة ✅'):el('b',{style:'color:#c2564e'},'⚠ '+skewLabel(d.skew)+' (قياس '+ago(d.skewAt,now)+')')):null,   // v23.4: الفرق عن وقت السيرفر (موجب = متأخرة)
    d.label&&el('div',{class:'drow'},el('span',{},'كود اتطلب لـ'),el('b',{},d.label)),
    el('div',{class:'drow'},el('span',{},'المعرّف'),el('b',{dir:'ltr'},d.id)),
    !d.me&&el('div',{class:'btnrow act'},d.st==='DISABLED'?el('button',{class:'btn',type:'button',onclick:()=>act(d,'enable')},'✅ تفعيل الجهاز'):el('button',{class:'btn ghost danger',type:'button',onclick:()=>act(d,'disable')},'⛔ إيقاف الجهاز')));
  async function load(){
    if(busy)return;busy=true;
    try{
      const r=await adminCall('devices');
      const on=r.devices.filter(d=>d.online).length;
      body.replaceChildren(
        el('div',{class:'ssum'},`${on} متصل دلوقتي من ${r.devices.length} جهاز مسجّل`+(r.codes?` · ${r.codes} كود لسه ما اتستخدمش`:'')),
        el('button',{class:'btn',type:'button',onclick:()=>newCodeFlow(load)},'➕ كود تفعيل جهاز جديد'),
        ...(r.devices.length?r.devices.map(d=>card(d,r.now)):[el('p',{class:'empty'},'لسه مفيش أجهزة سجّلت — الجهاز بيظهر هنا أول ما يتصل.')]),
        el('p',{class:'note'},'«متصل» = الجهاز كلّم الشيت في آخر 3 دقايق (والتطبيق بيكلّمه كل دقيقة تقريباً وهو مفتوح). الجهاز الموقوف بيتقفل عند أول اتصال؛ الجهاز اللي أوفلاين مش هيعرف إلا لما يتصل.'),
        el('p',{class:'note'},'بعد ما كل أجهزتك تتفعّل بأكواد: غيّر قيمة SYNC_TOKEN في Apps Script ← Script properties لرمز جديد، وحطه على جهازك بس (إعدادات الاتصال). كده الرمز القديم اللي كان على الأجهزة بيبطل.'));
    }catch(e){body.replaceChildren(el('p',{class:'err'},e.message||'تعذر تحميل الأجهزة'),el('button',{class:'btn ghost',type:'button',onclick:load},'إعادة المحاولة'))}
    finally{busy=false}
  }
  root=el('div',{class:'wrap'},el('div',{class:'hello'},el('h2',{},'الأجهزة المتصلة'),el('button',{class:'btn ghost',type:'button',onclick:()=>{clearInterval(timer);onBack()}},'رجوع')),body);
  $('#app').replaceChildren(root);
  timer=setInterval(()=>{if(!root.isConnected){clearInterval(timer);return}if(document.visibilityState==='visible')load()},20000);
  body.replaceChildren(el('p',{class:'note'},'بنحمّل الأجهزة…'));
  await load();
}
