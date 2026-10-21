// سلامة البيانات والنسخ الاحتياطي (v13). شاشة «الإعدادات» (ManageSettings):
//  1) حالة التخزين: هل المتصفح وعدنا بعدم المسح التلقائي (persist)، المساحة، عنوان الموقع (Origin) ونسخة القاعدة، وعدد السجلات على الجهاز ده.
//  2) نسخة احتياطية كاملة (ملف JSON) من العملاء والأصناف والمخازن والفواتير والحركات والمستندات وسجل العمليات وعدّادات الترقيم — من غير PIN/Salt ولا رمز المزامنة.
//  3) استرجاع من ملف: «الأحدث يكسب ومفيش مسح» — السجل الجديد بيتضاف، والموجود بيتبدّل بس لو النسخة اللي في الملف أحدث (UpdatedAt)، ولا بيتمسح أي حاجة.
import {openDB,all,get,put,txRun,nowISO,deviceId,audit,ymd} from './db.js';
import {can} from './auth.js';
import {$,el,toast,fmt,modal} from './ui.js';

const APP_VER='v23.6';
const DATA_STORES={customers:'CustomerID',products:'ProductID',warehouses:'WarehouseID',invoices:'InvoiceID',invoice_lines:'LineID',invoice_revisions:'RevisionID',
  credit_notes:'CreditNoteID',credit_note_lines:'LineID',movements:'MovementID',stock_docs:'DocID',audit:'AuditID',payments:'PaymentID'};
const STORE_AR={customers:'العملاء',products:'الأصناف',warehouses:'المخازن',invoices:'الفواتير',invoice_lines:'سطور الفواتير',invoice_revisions:'نسخ تعديل الفواتير',
  credit_notes:'المرتجعات',credit_note_lines:'سطور المرتجعات',movements:'حركات المخزون',stock_docs:'مستندات المخزن',audit:'سجل العمليات',payments:'التحصيلات',users:'المستخدمين',syncq:'طابور المزامنة'};
const SEQ=/^(docseq|invseq|cnseq|trseq|payseq|adjseq|prodseq):/;                   // عدّادات الترقيم اليومية — لازم تترجع عشان أرقام الفواتير/المستندات ما تتكررش
const MAX_BYTES=60*1024*1024;

const count=async s=>{const db=await openDB();return new Promise((res,rej)=>{const r=db.transaction(s,'readonly').objectStore(s).count();r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})};

// بيطلب من المتصفح «تخزين دائم» عشان ما يمسحش قاعدة البيانات لوحده وقت ضيق المساحة. بيتندهي عند كل تشغيل (آمن للتكرار). بيرجّع true/false/null(مش مدعوم).
export async function protectStorage(){
  try{if(!navigator.storage?.persist)return null;if(await navigator.storage.persisted())return true;return await navigator.storage.persist()}catch{return null}
}

// ---------- نسخة احتياطية ----------
async function exportBackup(user){
  const stores={},counts={};
  for(const s of Object.keys(DATA_STORES)){stores[s]=await all(s);counts[s]=stores[s].length}
  const seq={};for(const r of await all('settings'))if(SEQ.test(r.key))seq[r.key]=r.value;
  const data={app:'aliraqi-backup',format:1,exportedAt:nowISO(),device:deviceId(),appVersion:APP_VER,counts,seq,stores};
  const blob=new Blob([JSON.stringify(data)],{type:'application/json'});
  const d=new Date(),p=n=>String(n).padStart(2,'0'),name=`aliraqi-backup-${ymd(d)}-${p(d.getHours())}${p(d.getMinutes())}-${deviceId()}.json`;
  await put('settings',{key:'last_backup',at:data.exportedAt,counts,bytes:blob.size,name});
  await audit(user,'BACKUP_EXPORT','System','backup',null,JSON.stringify({name,counts}),deviceId());
  const file=new File([blob],name,{type:'application/json'});
  if(navigator.canShare?.({files:[file]})){try{await navigator.share({files:[file],title:'نسخة احتياطية — العراقي'});return name}catch(e){if(e.name==='AbortError')return name}}
  const u=URL.createObjectURL(blob),a=el('a',{href:u,download:name});document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),4000);
  return name;
}

// ---------- استرجاع (الأحدث يكسب — مفيش مسح) ----------
function validate(data){
  if(!data||data.app!=='aliraqi-backup'||data.format!==1||!data.stores||typeof data.stores!=='object')throw new Error('الملف ده مش نسخة احتياطية من تطبيق العراقي');
}
async function plan(data){
  const out={};
  for(const [s,key] of Object.entries(DATA_STORES)){
    const inc=data.stores[s],add=[],upd=[];let skip=0,bad=0;
    if(Array.isArray(inc)){
      const local=new Map((await all(s)).map(r=>[r[key],r]));
      for(const r of inc){
        if(!r||typeof r!=='object'||r[key]==null||r[key]===''){bad++;continue}
        const l=local.get(r[key]);
        if(!l)add.push(r);
        else if((r.UpdatedAt||'')>(l.UpdatedAt||''))upd.push(r);        // الأحدث بس بيبدّل — السجلات اللي مالهاش UpdatedAt (الحركات مثلاً) عمرها ما بتتبدّل
        else skip++;
      }
    }
    out[s]={add,upd,skip,bad};
  }
  return out;
}
async function applyRestore(user,data,pl){
  const stores=[...Object.keys(DATA_STORES),'settings'];
  await txRun(stores,t=>{
    for(const [s,p] of Object.entries(pl)){const os=t.objectStore(s);for(const r of p.add)os.put(r);for(const r of p.upd)os.put(r)}   // put بس — مفيش delete/clear
    const st=t.objectStore('settings');
    for(const [k,v] of Object.entries(data.seq||{})){if(!SEQ.test(k)||!Number.isFinite(v))continue;st.get(k).onsuccess=e=>{if((e.target.result?.value||0)<v)st.put({key:k,value:v})}}
  });
  const sum=Object.fromEntries(Object.entries(pl).map(([s,p])=>[s,{added:p.add.length,updated:p.upd.length}]));
  await audit(user,'BACKUP_RESTORE','System','backup',null,JSON.stringify({from:data.device,exportedAt:data.exportedAt,...sum}),deviceId());
  return sum;
}

// ---------- الشاشة ----------
const fdt=iso=>{if(!iso)return null;const d=new Date(iso),p=n=>String(n).padStart(2,'0');return `${d.getFullYear()}/${p(d.getMonth()+1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`};
const mb=n=>(n/1048576).toFixed(1)+' MB';

export async function showSafety(user,onBack){
  if(!await can(user,'ManageSettings')){toast('الإعدادات للمدير/المالك بس');onBack();return}
  const body=el('div',{});
  const row=(k,v,dir)=>el('div',{class:'drow'},el('span',{},k),el('b',{dir:dir||'auto'},v==null||v===''?'—':String(v)));
  async function draw(){
    const db=await openDB(),[persisted,est,last]=await Promise.all([
      navigator.storage?.persisted?.().catch(()=>null)??null,navigator.storage?.estimate?.().catch(()=>null)??null,get('settings','last_backup')]);
    const cnt={};for(const s of [...Object.keys(DATA_STORES),'users','syncq'])cnt[s]=await count(s);
    const q=await Promise.all(['PENDING','FAILED'].map(async st=>(await all('syncq')).filter(o=>o.Status===st).length));
    const days=last?Math.floor((Date.now()-Date.parse(last.at))/864e5):null;
    body.replaceChildren(
      el('h3',{class:'sec'},'حالة التخزين على الجهاز ده'),
      row('الحماية من المسح التلقائي',persisted==null?'غير مدعومة في المتصفح ده':persisted?'محمية ✅':'غير محمية ⚠️'),
      persisted===false&&el('button',{class:'btn ghost wide',type:'button',onclick:async()=>{const ok=await protectStorage();toast(ok?'تم تفعيل الحماية':'المتصفح رفض — جرّب تثبّت التطبيق على الشاشة الرئيسية');draw()}},'طلب حماية التخزين'),
      est&&row('المساحة المستخدمة',`${mb(est.usage||0)} من ${mb(est.quota||0)}`,'ltr'),
      row('عنوان الموقع (Origin)',location.origin,'ltr'),row('قاعدة البيانات',`aliraqi · v${db.version}`,'ltr'),row('معرّف الجهاز',deviceId(),'ltr'),row('نسخة التطبيق',APP_VER,'ltr'),
      el('p',{class:'note'},'كل جهاز وكل متصفح (وكل عنوان موقع مختلف) ليه قاعدة بيانات مستقلة، والمزامنة (رفع وسحب من الشيت) هي اللي بتوصّل البيانات بين الأجهزة.'),
      el('h3',{class:'sec'},'عدد السجلات على الجهاز'),
      ...[...Object.keys(DATA_STORES),'users'].map(s=>row(STORE_AR[s]||s,fmt(cnt[s]))),
      row('في انتظار المزامنة',fmt(q[0])),q[1]>0&&row('عمليات مزامنة فاشلة',fmt(q[1])),
      el('h3',{class:'sec'},'النسخة الاحتياطية'),
      row('آخر نسخة احتياطية',last?`${fdt(last.at)} (من ${days} يوم)`:'لسه ما اتعملتش ⚠️'),
      (!last||days>=7)&&el('p',{class:'editwarn'},'يُفضّل نسخة احتياطية أسبوعياً على الأقل، وتحفظ الملف خارج الجهاز (درايف / واتساب لنفسك).'),
      el('div',{class:'btnrow act'},
        el('button',{class:'btn',type:'button',onclick:async ev=>{const b=ev.currentTarget;b.disabled=true;
          try{const n=await exportBackup(user);toast('تم تجهيز النسخة: '+n)}catch(e){toast('تعذر إنشاء النسخة — حاول تاني')}b.disabled=false;draw()}},'⬇ تصدير نسخة احتياطية'),
        el('button',{class:'btn ghost',type:'button',onclick:()=>file.click()},'⬆ استرجاع من ملف')),
      el('p',{class:'note'},'الملف فيه بيانات العملاء والفواتير وتكلفة الأصناف — احتفظ بيه في مكان آمن. مش بيحتوي على الأرقام السرية ولا رمز المزامنة. الاسترجاع بيضيف الناقص ويحدّث الأقدم بس، ومش بيمسح أي حاجة.'));
  }
  const file=el('input',{type:'file',accept:'application/json,.json',hidden:true,onchange:async e=>{
    const f=e.target.files[0];e.target.value='';if(!f)return;
    try{
      if(f.size>MAX_BYTES)throw new Error('الملف كبير جداً');
      let data;try{data=JSON.parse(await f.text())}catch{throw new Error('الملف مش JSON سليم')}
      validate(data);const pl=await plan(data);preview(data,pl);
    }catch(err){toast(err.message||'تعذر قراءة الملف')}
  }});
  function preview(data,pl){
    const total=Object.values(pl).reduce((s,p)=>s+p.add.length+p.upd.length,0);
    const btn=el('button',{class:'btn',type:'button',disabled:!total,onclick:async()=>{
      btn.disabled=true;
      try{await applyRestore(user,data,pl);close();toast(`تم الاسترجاع: ${fmt(total)} سجل`);draw()}
      catch{btn.disabled=false;toast('تعذر الاسترجاع — ما اتغيّرش أي حاجة')}}},total?`استرجاع ${fmt(total)} سجل`:'مفيش حاجة تتسترجع');
    const close=modal('معاينة الاسترجاع',
      el('p',{class:'note'},`نسخة بتاريخ ${fdt(data.exportedAt)||'—'} · من جهاز ${data.device||'—'} · تطبيق ${data.appVersion||'—'}`),
      ...Object.entries(pl).map(([s,p])=>el('div',{class:'drow'},el('span',{},STORE_AR[s]||s),el('b',{dir:'auto'},`جديد ${fmt(p.add.length)} · أحدث ${fmt(p.upd.length)} · موجود ${fmt(p.skip)}`+(p.bad?` · تالف ${fmt(p.bad)}`:'')))),
      el('p',{class:'note'},'«جديد» بيتضاف، «أحدث» بيبدّل النسخة الأقدم الموجودة، و«موجود» بيتساب زي ما هو. مفيش مسح.'),btn);
  }
  $('#app').replaceChildren(el('div',{class:'wrap'},el('div',{class:'hello'},el('h2',{},'الإعدادات وسلامة البيانات'),el('button',{class:'btn ghost',type:'button',onclick:onBack},'رجوع')),body,file));
  await draw();
}
