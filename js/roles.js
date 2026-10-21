// شاشة «الأدوار والصلاحيات» (v23.6) — للمالك بس (ManageRoles). بتعرض الأدوار الثلاثة وصلاحياتها الفعلية، وبتسمح للمالك يخصّص صلاحيات «إدارة» و«موظف» (OWNER ثابت).
// الكتابة كلها عن طريق saveRole من auth.js (الحارس + الطابور + سجل العمليات في معاملة واحدة). التخصيص بيتزامن للأجهزة التانية ويتقبل هناك بس لو المعدِّل مالك.
// تعديل دور بيأثر على كل مستخدميه فوراً. الصلاحيات الفردية للمستخدمين (إضافية/ممنوعة من شاشة «المستخدمين») بتفضل سارية فوق صلاحيات الدور.
import {all} from './db.js';
import {PERMS,ROLES,can,saveRole,permLocked,CUSTOMIZABLE} from './auth.js';
import {PERM_AR} from './users.js';
import {$,el,toast,fmt,modal,confirmAction} from './ui.js';

const GROUPS=[
  ['المنتجات',['ViewProducts','EditProducts','ChangeDefaultPrice','DeleteProducts']],
  ['المخزون',['ViewStock','StockIn','StockOut','StockTransfer','StockAdjust','VoidStockDoc','OverrideStock']],
  ['المبيعات والعملاء',['CreateInvoice','EditInvoice','CancelInvoice','CreateReturn','OverridePrice','ViewCustomers','EditCustomers']],
  ['التقارير والمراقبة',['ViewReports','ViewCost','ViewAudit']],
  ['الإدارة',['ManageUsers','ManageRoles','ManageSettings','ManageSync','ManageWarehouses']]
];
const fdt=iso=>{const d=new Date(iso),p=n=>String(n).padStart(2,'0');return isNaN(d)?'—':`${d.getFullYear()}/${p(d.getMonth()+1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`};
const ar=p=>PERM_AR[p]||p;

export async function showRoles(actor,onBack){
  if(actor.RoleID!=='OWNER'||!await can(actor,'ManageRoles')){toast('الأدوار والصلاحيات للمالك بس');onBack();return}
  const list=el('div',{class:'plist cust'});
  let roles=new Map(),users=[];
  async function load(){
    roles=new Map((await all('roles')).map(r=>[r.RoleID,r]));users=await all('users');
    list.replaceChildren(...ROLES.map(base=>{
      const r=roles.get(base.RoleID)||base,n=users.filter(u=>u.RoleID===base.RoleID&&u.Active).length;
      return el('article',{class:'pcard ccard',tabindex:'0',role:'button',onclick:()=>details(base),onkeydown:e=>{if(e.key==='Enter')details(base)}},
        el('div',{class:'pbody'},el('h3',{},base.Name),
          el('div',{class:'pmeta'},el('span',{},`${fmt(n)} مستخدم نشط`),
            el('span',{class:'badges'},!CUSTOMIZABLE.includes(base.RoleID)&&el('span',{class:'bdg cn'},'ثابت'),r.Custom&&el('span',{class:'bdg edited'},'مخصّص'))),
          el('div',{class:'pstock'},`${fmt(r.Perms.length)} من ${fmt(PERMS.length)} صلاحية`)));
    }));
  }
  const eff=base=>roles.get(base.RoleID)||base;
  const row=(k,v)=>el('div',{class:'drow'},el('span',{},k),el('b',{dir:'auto'},v||'—'));

  function details(base){
    const r=eff(base),has=new Set(r.Perms),custom=CUSTOMIZABLE.includes(base.RoleID);
    const who=users.find(u=>u.UserID===r.UpdatedBy)?.Name||r.UpdatedBy;
    const withOv=users.filter(u=>u.RoleID===base.RoleID&&u.Active&&((u.ExtraPerms||[]).length||(u.DeniedPerms||[]).length)).length;
    const close=modal(base.Name,
      row('عدد الصلاحيات',`${fmt(r.Perms.length)} من ${fmt(PERMS.length)}`),
      r.Custom&&row('آخر تعديل',r.UpdatedAt?`${fdt(r.UpdatedAt)} — ${who||''}`:'مخصّص'),
      !custom&&el('p',{class:'note'},'دور المالك ثابت: كل الصلاحيات ومحدش يقدر يعدّلها.'),
      ...GROUPS.flatMap(([g,ps])=>[el('h3',{class:'sec'},g),...ps.map(p=>el('div',{class:'drow'},el('span',{},ar(p)),el('b',{style:has.has(p)?'color:#1f9d76':'color:#c2564e'},has.has(p)?'✔':'✘')))]),
      withOv>0&&el('p',{class:'note'},`فيه ${fmt(withOv)} مستخدم نشط في الدور ده عندهم صلاحيات فردية (إضافية/ممنوعة) بتفضل سارية فوق صلاحيات الدور.`),
      custom&&el('div',{class:'btnrow act'},
        el('button',{class:'btn',type:'button',onclick:()=>{close();form(base)}},'تعديل الصلاحيات'),
        r.Custom&&el('button',{class:'btn ghost danger',type:'button',onclick:async()=>{
          if(!await confirmAction('الرجوع للافتراضي',`هترجع صلاحيات «${base.Name}» للإعدادات الافتراضية للتطبيق. ده بيأثر على كل مستخدمي الدور فوراً.`,'رجوع للافتراضي'))return;
          try{await saveRole(actor,base.RoleID,null);close();toast('اتعاد الدور للافتراضي');load()}catch(e){toast(e.message||'تعذر التنفيذ')}
        }},'رجوع للافتراضي')));
  }

  function form(base){
    const r=eff(base),before=new Set(r.Perms),boxes=new Map();
    const err=el('p',{class:'err'});
    const grid=GROUPS.flatMap(([g,ps])=>[el('h3',{class:'sec'},g),
      el('div',{style:'display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:2px 10px'},
        ...ps.map(p=>{const lock=permLocked(base.RoleID,p),i=el('input',{type:'checkbox',checked:!lock&&before.has(p),disabled:lock});boxes.set(p,i);
          return el('label',{class:'chk'},i,ar(p)+(lock?' 🔒':''))}))]);
    const save=async()=>{
      err.textContent='';
      const want=PERMS.filter(p=>boxes.get(p)?.checked&&!permLocked(base.RoleID,p));
      if(!want.length){err.textContent='لازم يفضل في الدور صلاحية واحدة على الأقل';return}
      const add=want.filter(p=>!before.has(p)),rem=[...before].filter(p=>!want.includes(p));
      if(!add.length&&!rem.length){err.textContent='ما اتغيّرش حاجة';return}
      const n=users.filter(u=>u.RoleID===base.RoleID&&u.Active).length;
      const txt=[add.length&&`هتتضاف: ${add.map(ar).join('، ')}`,rem.length&&`هتتشال: ${rem.map(ar).join('، ')}`].filter(Boolean).join(' — ');
      if(!await confirmAction('تأكيد تعديل الدور',`${txt}. ده هيأثر على ${fmt(n)} مستخدم نشط في «${base.Name}» فوراً (وعلى أجهزتهم أول ما تتزامن).`,'حفظ التعديل',!!rem.length))return;
      btn.disabled=true;
      try{await saveRole(actor,base.RoleID,want);close();toast('تم حفظ صلاحيات الدور');load()}
      catch(e){btn.disabled=false;err.textContent=typeof e.code==='string'?e.message:'تعذر الحفظ على الجهاز — حاول تاني'}
    };
    const btn=el('button',{class:'btn',type:'button',onclick:save},'حفظ');
    const close=modal('تعديل صلاحيات: '+base.Name,
      el('p',{class:'note'},'علّم الصلاحيات اللي الدور ده ياخدها. 🔒 صلاحية مقفولة على الدور ده (مالك بس). التعديل بيأثر على كل المستخدمين في الدور.'),...grid,err,btn);
  }

  $('#app').replaceChildren(el('div',{class:'wrap'},el('div',{class:'hello'},el('h2',{},'الأدوار والصلاحيات'),el('button',{class:'btn ghost',type:'button',onclick:onBack},'رجوع')),
    el('p',{class:'note'},'اضغط على دور لعرض صلاحياته. تقدر تخصّص «إدارة» و«موظف». التخصيص بيتزامن لباقي الأجهزة. الصلاحيات الفردية لكل مستخدم من شاشة «المستخدمين».'),list));
  await load();
}
