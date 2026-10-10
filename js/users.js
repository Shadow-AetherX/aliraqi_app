// شاشة «المستخدمين»: قائمة + إضافة موظف + تعديل الدور/الصلاحيات + تغيير الـ PIN + إيقاف/تفعيل (مفيش مسح).
// قاعدة حماية المالك: أي كتابة على حساب بتتم عن طريق saveUser / changePin من auth.js بس (هما اللي فيهم الحارس guardUserWrite).
// الملف ده عمره ما بيعمل put على جدول users مباشرة.
import {all,get,uuid,nowISO,deviceId,audit} from './db.js';
import {PERMS,ROLES,can,canManageUser,saveUser,changePin} from './auth.js';
import {$,el,toast,fmt,modal} from './ui.js';

const ROLE_BY=new Map(ROLES.map(r=>[r.RoleID,r]));
const roleName=id=>ROLE_BY.get(id)?.Name||id;
const PERM_AR={ViewProducts:'عرض المنتجات',EditProducts:'تعديل المنتجات',ChangeDefaultPrice:'تغيير السعر الأساسي',ViewStock:'عرض المخزون',StockIn:'استلام مخزون',StockOut:'صرف مخزون',
  StockTransfer:'نقل بين المخازن',CreateInvoice:'إنشاء فاتورة',EditInvoice:'تعديل فاتورة',CancelInvoice:'إلغاء فاتورة',CreateReturn:'عمل مرتجع',ViewCustomers:'عرض العملاء',
  EditCustomers:'تعديل العملاء',ViewReports:'التقارير',ViewCost:'رؤية التكلفة والهامش',ViewAudit:'سجل العمليات',ManageUsers:'إدارة المستخدمين',ManageRoles:'إدارة الأدوار',
  ManageSettings:'الإعدادات',ManageSync:'المزامنة',ManageWarehouses:'إدارة المخازن',OverridePrice:'تعديل سعر الصنف في الفاتورة',OverrideStock:'تجاوز الرصيد',VoidStockDoc:'إلغاء مستندات المخزن'};
// صلاحيات مقفولة بالدور: ManageRoles للمالك بس، و ManageUsers ممنوعة على الـ STAFF حتى لو اتضافت كصلاحية إضافية
const LOCKED=(roleId,perm)=>(perm==='ManageRoles'&&roleId!=='OWNER')||(perm==='ManageUsers'&&roleId==='STAFF');
const snap=u=>JSON.stringify({Name:u.Name,RoleID:u.RoleID,Active:u.Active,ExtraPerms:u.ExtraPerms||[],DeniedPerms:u.DeniedPerms||[]});   // من غير Salt/PinHash أبداً
const PIN_OK=p=>/^\d{4,8}$/.test(p)&&p!=='0000';

export async function showUsers(actor,onBack){
  if(!await can(actor,'ManageUsers')){toast('إدارة المستخدمين للمدير/المالك بس');onBack();return}
  const me=await get('users',actor.UserID);                                    // نقرأ الفاعل من القاعدة مش من الجلسة
  const actorPerms=new Set();for(const p of PERMS) if(await can(me,p)) actorPerms.add(p);
  const assignable=()=>ROLES.filter(r=>r.RoleID!=='OWNER'&&(me.RoleID==='OWNER'||r.Rank>me.Rank));   // مفيش حد بيتعيّن OWNER من الشاشة
  let rows=[];
  const list=el('div',{class:'plist cust'}),count=el('div',{class:'pcount'});
  async function load(){rows=(await all('users')).sort((a,b)=>a.Rank-b.Rank||a.Name.localeCompare(b.Name,'ar'));draw()}
  const card=u=>el('article',{class:'pcard ccard',tabindex:'0',role:'button',onclick:()=>details(u.UserID),onkeydown:e=>{if(e.key==='Enter')details(u.UserID)}},
    el('div',{class:'pbody'},el('h3',{},u.Name),
      el('div',{class:'pmeta'},el('span',{},roleName(u.RoleID)),el('span',{class:'bdg '+(u.Active?'ok':'no')},u.Active?'نشط':'موقوف')),
      u.MustChangePin&&el('div',{class:'pstock'},'لسه ما غيّرش الرقم السري المؤقت')));
  function draw(){count.textContent=`${fmt(rows.length)} مستخدم`;list.replaceChildren(...(rows.length?rows.map(card):[el('p',{class:'empty'},'مفيش مستخدمين')]))}

  async function details(id){
    const u=await get('users',id);if(!u)return;
    const self=u.UserID===me.UserID,manage=canManageUser(me,u);
    const row=(k,v)=>el('div',{class:'drow'},el('span',{},k),el('b',{dir:'auto'},v||'—'));
    const eff=[...ROLE_BY.get(u.RoleID).Perms].filter(p=>!(u.DeniedPerms||[]).includes(p)).length+(u.ExtraPerms||[]).length;
    const close=modal(u.Name,row('الدور',roleName(u.RoleID)),row('الحالة',u.Active?'نشط':'موقوف'),
      u.RoleID==='OWNER'?row('الصلاحيات','كل الصلاحيات (ثابتة)'):row('عدد الصلاحيات',fmt(eff)+' من '+fmt(PERMS.length)),
      u.MustChangePin&&row('الرقم السري','مؤقت — هيتغيّر عند أول دخول'),
      u.RoleID==='OWNER'&&el('p',{class:'note'},'حساب المالك محمي: محدش غير المالك يقدر يعدّله أو يغيّر صلاحياته أو الرقم السري بتاعه.'),
      !manage&&u.RoleID!=='OWNER'&&el('p',{class:'note'},'مفيش صلاحية تعديل الحساب ده (رتبته مساوية لرتبتك أو أعلى).'),
      manage&&el('div',{class:'btnrow act'},
        u.RoleID!=='OWNER'&&el('button',{class:'btn',type:'button',onclick:()=>{close();userForm(u)}},'تعديل'),
        el('button',{class:'btn ghost',type:'button',onclick:()=>{close();pinForm(u)}},'تغيير الرقم السري'),
        !self&&u.RoleID!=='OWNER'&&el('button',{class:'btn ghost danger',type:'button',onclick:async()=>{
          if(!window.confirm(u.Active?`إيقاف «${u.Name}»؟ مش هيقدر يدخل لحد ما تفعّله تاني (بياناته وفواتيره محفوظة).`:`تفعيل «${u.Name}»؟`))return;
          try{const rec={...(await get('users',u.UserID)),Active:!u.Active};await saveUser(me,rec);
            await audit(me,rec.Active?'USER_ACTIVATE':'USER_DEACTIVATE','User',rec.UserID,snap(u),snap(rec),deviceId());
            close();toast(rec.Active?'تم تفعيل المستخدم':'تم إيقاف المستخدم');load()}
          catch(e){toast(e.code==='USER_PROTECTED'?e.message:'تعذر التنفيذ — حاول تاني')}
        }},u.Active?'إيقاف':'تفعيل')));
  }

  // ---- تغيير/تعيين الرقم السري (عن طريق changePin بس) ----
  function pinForm(u){
    const self=u.UserID===me.UserID;
    const p1=el('input',{type:'password',inputmode:'numeric',maxlength:'8',placeholder:'الرقم السري الجديد (4 إلى 8 أرقام)','aria-label':'الرقم الجديد'});
    const p2=el('input',{type:'password',inputmode:'numeric',maxlength:'8',placeholder:'أعد كتابة الرقم','aria-label':'تأكيد الرقم'});
    const err=el('p',{class:'err'});
    const btn=el('button',{class:'btn',type:'button',onclick:async()=>{
      err.textContent='';
      if(!PIN_OK(p1.value)){err.textContent='لازم 4 لـ 8 أرقام ومش 0000';return}
      if(p1.value!==p2.value){err.textContent='الرقمين مش متطابقين';return}
      btn.disabled=true;
      try{
        const fresh=await get('users',u.UserID);
        if(!await changePin(fresh,p1.value,me)) throw Object.assign(new Error('مفيش صلاحية تغيير الرقم السري للحساب ده'),{code:'USER_PROTECTED'});
        if(!self){fresh.MustChangePin=true;await saveUser(me,fresh)}              // موظف اتغيّر له الرقم: يختار رقمه بنفسه عند أول دخول
        await audit(me,'USER_PIN_CHANGE','User',u.UserID,null,null,deviceId());
        close();toast(self?'تم تغيير الرقم السري':'تم تعيين رقم مؤقت — الموظف هيغيّره عند أول دخول');load();
      }catch(e){btn.disabled=false;err.textContent=e.code==='USER_PROTECTED'?e.message:'تعذر الحفظ — حاول تاني'}
    }},'حفظ');
    const close=modal('الرقم السري — '+u.Name,el('p',{class:'note'},self?'اختار رقم سري جديد لحسابك.':'الرقم ده مؤقت: الموظف هيطلب منه يغيّره عند أول دخول.'),
      el('label',{class:'field'},el('span',{},'الرقم الجديد'),p1),el('label',{class:'field'},el('span',{},'تأكيد الرقم'),p2),err,btn);
    p1.focus();
  }

  // ---- إضافة / تعديل موظف (عن طريق saveUser بس) ----
  async function userForm(u){
    const isNew=!u,self=!!u&&u.UserID===me.UserID,roles=assignable(),others=await all('users');
    const name=el('input',{type:'text',maxlength:'40',value:u?.Name||'',placeholder:'اسم الموظف *','aria-label':'الاسم'});
    const pin=isNew?el('input',{type:'password',inputmode:'numeric',maxlength:'8',placeholder:'رقم سري مؤقت (4 إلى 8 أرقام)','aria-label':'الرقم السري'}):null;
    const boxes=new Map(),grid=el('div',{style:'display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:2px 10px'});
    const roleSel=el('select',{'aria-label':'الدور',onchange:()=>drawPerms()},roles.map(r=>el('option',{value:r.RoleID},r.Name)));
    if(u&&roles.some(r=>r.RoleID===u.RoleID))roleSel.value=u.RoleID;
    function drawPerms(){
      const roleId=roleSel.value,eff=new Set(ROLE_BY.get(roleId).Perms);
      if(u&&roleId===u.RoleID){(u.ExtraPerms||[]).forEach(p=>eff.add(p));(u.DeniedPerms||[]).forEach(p=>eff.delete(p))}
      boxes.clear();
      grid.replaceChildren(...PERMS.map(p=>{const locked=LOCKED(roleId,p);
        const i=el('input',{type:'checkbox',checked:!locked&&eff.has(p),disabled:locked||!actorPerms.has(p)});   // مفيش حد بيدّي صلاحية هو نفسه معاهوش
        boxes.set(p,i);return el('label',{class:'chk'},i,PERM_AR[p]||p)}));
    }
    drawPerms();
    const err=el('p',{class:'err'});
    const field=(l,i)=>el('label',{class:'field'},el('span',{},l),i);
    const save=async()=>{
      err.textContent='';const n=name.value.trim();
      if(n.length<2){err.textContent='اكتب اسم الموظف';return}
      if(others.some(x=>x.Active&&x.Name===n&&x.UserID!==u?.UserID)){err.textContent='فيه مستخدم نشط بنفس الاسم ده';return}
      if(isNew&&!PIN_OK(pin.value)){err.textContent='الرقم السري لازم 4 لـ 8 أرقام ومش 0000';return}
      btn.disabled=true;
      try{
        if(self){                                                              // تعديل حسابك: الاسم بس (مفيش ترقية ولا تعديل صلاحيات لنفسك)
          const old=await get('users',u.UserID),rec={...old,Name:n};
          await saveUser(me,rec);await audit(me,'USER_EDIT','User',rec.UserID,snap(old),snap(rec),deviceId());
        }else{
          const roleId=roleSel.value;
          if(!roles.some(r=>r.RoleID===roleId)) throw Object.assign(new Error('الدور ده مش متاح ليك'),{code:'USER_PROTECTED'});
          const base=new Set(ROLE_BY.get(roleId).Perms),extra=[],denied=[];
          for(const [p,i] of boxes){
            if(LOCKED(roleId,p)){if(base.has(p))denied.push(p);continue}
            if(i.checked&&!base.has(p))extra.push(p);
            if(!i.checked&&base.has(p))denied.push(p);
          }
          if(isNew){
            // نحفظ الحساب بـ PIN غير صالح، وبعدين نعيّن الـ PIN عن طريق changePin (بيرفض 0000 وفيه الحارس)
            const rec={UserID:'U-'+uuid().slice(0,8).toUpperCase(),Name:n,RoleID:roleId,Rank:ROLE_BY.get(roleId).Rank,Active:true,Salt:uuid(),PinHash:'!',MustChangePin:true,ExtraPerms:extra,DeniedPerms:denied,CreatedAt:nowISO()};
            await saveUser(me,rec);
            const fresh=await get('users',rec.UserID);
            if(!await changePin(fresh,pin.value,me)) throw Object.assign(new Error('اتحفظ الموظف لكن الرقم السري ما اتعيّنش — استخدم «تغيير الرقم السري»'),{code:'USER_PROTECTED'});
            fresh.MustChangePin=true;await saveUser(me,fresh);
            await audit(me,'USER_CREATE','User',rec.UserID,null,snap(fresh),deviceId());
          }else{
            const old=await get('users',u.UserID);
            const rec={...old,Name:n,RoleID:roleId,Rank:roleId===old.RoleID?old.Rank:ROLE_BY.get(roleId).Rank,ExtraPerms:extra,DeniedPerms:denied};
            await saveUser(me,rec);await audit(me,'USER_EDIT','User',rec.UserID,snap(old),snap(rec),deviceId());
          }
        }
        close();toast(isNew?'تم إضافة الموظف':'تم حفظ التعديل');load();
      }catch(e){btn.disabled=false;err.textContent=e.code==='USER_PROTECTED'?e.message:'تعذر الحفظ على الجهاز. حاول تاني.'}
    };
    const btn=el('button',{class:'btn',type:'button',onclick:save},'حفظ');
    const close=modal(isNew?'موظف جديد':'تعديل '+u.Name,field('الاسم *',name),pin&&field('الرقم السري المؤقت *',pin),
      !self&&field('الدور',roleSel),
      !self&&el('details',{class:'help-sec'},el('summary',{},'الصلاحيات التفصيلية'),el('div',{class:'help-body'},
        el('p',{class:'note'},'لما تغيّر الدور الصلاحيات بترجع لافتراضي الدور الجديد. الصلاحيات الباهتة مقفولة (مش متاحة ليك أو ممنوعة على الدور ده).'),grid)),
      self&&el('p',{class:'note'},'ده حسابك: تقدر تعدّل الاسم بس. الدور والصلاحيات من المالك.'),
      isNew&&el('p',{class:'note'},'الموظف هيغيّر الرقم المؤقت عند أول دخول.'),err,btn);
    name.focus();
  }

  $('#app').replaceChildren(el('div',{class:'wrap'},el('div',{class:'hello'},el('h2',{},'المستخدمين'),el('button',{class:'btn ghost',type:'button',onclick:onBack},'رجوع')),
    el('div',{class:'filters'},el('button',{class:'btn',type:'button',onclick:()=>userForm(null)},'+ موظف جديد')),count,list));
  await load();
}
