// شاشة «المخازن»: قائمة + إضافة/تعديل + مخزن افتراضي + تعطيل/تفعيل (مفيش مسح — المخازن بتفضل في السجل).
// الصلاحية: ManageWarehouses (بتتفحص عند فتح الشاشة وعند كل كتابة). كل كتابة = المخزن + طابور المزامنة + سجل العمليات في معاملة واحدة.
import {all,get,txRun,uuid,nowISO,deviceId,stockMap} from './db.js';
import {can} from './auth.js';
import {norm} from './products.js';
import {$,el,toast,fmt,modal} from './ui.js';

const snap=w=>JSON.stringify({Name:w.Name,Address:w.Address||'',Notes:w.Notes||'',Active:w.Active!==false,IsDefault:!!w.IsDefault});

// المخازن اللي اتعملت قبل الشاشة دي ماعندهاش SyncStatus ولا عنوان — بنكمّلها ونحطها في طابور المزامنة مرة واحدة. آمن للتكرار.
export async function backfillWarehouses(){
  if(await get('settings','wh_backfill_v1'))return 0;
  const ws=await all('warehouses');if(!ws.length)return 0;                    // لسه ما اتعملش seed
  const now=nowISO();
  await txRun(['warehouses','syncq','settings'],t=>{
    for(const w of ws){
      const r={...w,Address:w.Address||'',Notes:w.Notes||'',IsDefault:!!w.IsDefault,CreatedAt:w.CreatedAt||now,UpdatedAt:w.UpdatedAt||'1970-01-01T00:00:00.000Z',SyncStatus:'PENDING'};
      t.objectStore('warehouses').put(r);
      t.objectStore('syncq').put({OpID:uuid(),Entity:'warehouses',EntityID:r.WarehouseID,Status:'PENDING',CreatedAt:now,Tries:0});
    }
    t.objectStore('settings').put({key:'wh_backfill_v1',at:now,count:ws.length});
  });
  return ws.length;
}

// changes: [{rec,old,action}] — بتتكتب كلها أو ولا واحدة (مثلاً تغيير الافتراضي بيعدّل مخزنين مع بعض)
async function commit(user,changes){
  const u=await get('users',user.UserID);                                      // نعيد قراءة المستخدم من القاعدة مش من الجلسة
  if(!u||!u.Active||!await can(u,'ManageWarehouses'))throw Object.assign(new Error('مفيش صلاحية إدارة المخازن'),{code:'FORBIDDEN'});
  const now=nowISO(),dev=deviceId();
  await txRun(['warehouses','syncq','audit'],t=>{
    for(const{rec,old,action}of changes){
      const r={...rec,UpdatedAt:now,SyncStatus:'PENDING'};
      t.objectStore('warehouses').put(r);
      t.objectStore('syncq').put({OpID:uuid(),Entity:'warehouses',EntityID:r.WarehouseID,Status:'PENDING',CreatedAt:now,Tries:0});
      t.objectStore('audit').put({AuditID:uuid(),UserID:u.UserID,UserName:u.Name,Action:action,EntityType:'Warehouse',EntityID:r.WarehouseID,DateTime:now,DeviceID:dev,
        OldValue:old?snap(old):null,NewValue:snap(r),Notes:'',SyncStatus:'PENDING'});
    }
  });
}

export async function showWarehouses(user,onBack){
  if(!await can(user,'ManageWarehouses')){toast('إدارة المخازن للمدير/المالك بس');onBack();return}
  let rows=[],totals=new Map();
  const list=el('div',{class:'plist cust'}),count=el('div',{class:'pcount'}),banner=el('div',{});
  async function load(){
    rows=(await all('warehouses')).sort((a,b)=>(b.IsDefault?1:0)-(a.IsDefault?1:0)||(b.Active!==false)-(a.Active!==false)||a.Name.localeCompare(b.Name,'ar'));
    totals=new Map();for(const o of(await stockMap()).values())for(const[w,q]of Object.entries(o))totals.set(w,(totals.get(w)||0)+q);
    draw();
  }
  const card=w=>el('article',{class:'pcard ccard',tabindex:'0',role:'button',onclick:()=>details(w.WarehouseID),onkeydown:e=>{if(e.key==='Enter')details(w.WarehouseID)}},
    el('div',{class:'pbody'},el('h3',{},w.Name),
      el('div',{class:'pmeta'},el('span',{class:'code',dir:'ltr'},w.WarehouseID),
        el('span',{class:'badges'},w.IsDefault&&el('span',{class:'bdg cn'},'افتراضي'),el('span',{class:'bdg '+(w.Active!==false?'ok':'no')},w.Active!==false?'نشط':'معطل'))),
      w.Address&&el('div',{class:'pstock'},w.Address)));
  function draw(){
    count.textContent=`${fmt(rows.length)} مخزن`;
    banner.replaceChildren(...(rows.some(w=>w.IsDefault&&w.Active!==false)?[]:[el('p',{class:'editwarn'},'لسه ما حددتش مخزن افتراضي — افتح أي مخزن نشط واختار «تعيين كافتراضي».')]));
    list.replaceChildren(...(rows.length?rows.map(card):[el('p',{class:'empty'},'مفيش مخازن')]));
  }

  function details(id){
    const w=rows.find(x=>x.WarehouseID===id);if(!w)return;
    const active=w.Active!==false,total=totals.get(w.WarehouseID)||0;
    const row=(k,v)=>el('div',{class:'drow'},el('span',{},k),el('b',{dir:'auto'},v||'—'));
    const close=modal(w.Name,row('الكود / المعرّف',w.WarehouseID),row('الحالة',active?'نشط':'معطل'),row('مخزن افتراضي',w.IsDefault?'أيوه':'لا'),
      row('العنوان',w.Address),row('ملاحظات',w.Notes),row('الرصيد الحالي (بالقطعة)',fmt(total)),
      el('div',{class:'btnrow act'},
        el('button',{class:'btn',type:'button',onclick:()=>{close();form(w)}},'تعديل'),
        active&&!w.IsDefault&&el('button',{class:'btn ghost',type:'button',onclick:()=>{close();setDefault(w)}},'تعيين كافتراضي'),
        el('button',{class:'btn ghost danger',type:'button',onclick:()=>{close();toggle(w,total)}},active?'تعطيل':'تفعيل')));
  }
  const fail=e=>toast(e.code==='FORBIDDEN'?e.message:'تعذر الحفظ على الجهاز — حاول تاني');
  const prevDefault=exceptId=>rows.find(x=>x.IsDefault&&x.WarehouseID!==exceptId);

  async function setDefault(w){
    const prev=prevDefault(w.WarehouseID),changes=[{rec:{...w,IsDefault:true},old:w,action:'WAREHOUSE_SET_DEFAULT'}];
    if(prev)changes.push({rec:{...prev,IsDefault:false},old:prev,action:'WAREHOUSE_SET_DEFAULT'});
    try{await commit(user,changes);toast(`«${w.Name}» بقى المخزن الافتراضي`);load()}catch(e){fail(e)}
  }
  async function toggle(w,total){
    const active=w.Active!==false;
    if(active){
      if(w.IsDefault){toast('ده المخزن الافتراضي — عيّن مخزن تاني كافتراضي الأول');return}
      if(rows.filter(x=>x.Active!==false).length<=1){toast('مينفعش تعطّل آخر مخزن نشط');return}
      if(total!==0){toast(`مينفعش تعطّل «${w.Name}»: فيه رصيد ${fmt(total)} قطعة — صرّفه أو حوّله الأول`);return}   // التعطيل بيخبّي المخزن من شاشات الاستلام/الصرف فالرصيد لازم يبقى صفر
      if(!window.confirm(`تعطيل «${w.Name}»؟ مش هيظهر في الاستلام والصرف، وبياناته القديمة تفضل محفوظة.`))return;
    }
    try{await commit(user,[{rec:{...w,Active:!active},old:w,action:active?'WAREHOUSE_DEACTIVATE':'WAREHOUSE_ACTIVATE'}]);toast(active?'تم تعطيل المخزن':'تم تفعيل المخزن');load()}catch(e){fail(e)}
  }

  function form(w){
    const isNew=!w,inactive=!!w&&w.Active===false;
    const name=el('input',{type:'text',maxlength:'40',value:w?.Name||'',placeholder:'اسم المخزن *','aria-label':'اسم المخزن'});
    const addr=el('input',{type:'text',maxlength:'160',value:w?.Address||'',placeholder:'العنوان (اختياري)','aria-label':'العنوان'});
    const notes=el('input',{type:'text',maxlength:'200',value:w?.Notes||'',placeholder:'ملاحظات (اختياري)','aria-label':'ملاحظات'});
    const def=el('input',{type:'checkbox',checked:!!w?.IsDefault,disabled:!!w?.IsDefault||inactive});
    const err=el('p',{class:'err'}),field=(l,i)=>el('label',{class:'field'},el('span',{},l),i);
    const save=async()=>{
      err.textContent='';const n=name.value.trim();
      if(n.length<2){err.textContent='اكتب اسم المخزن';return}
      if(rows.some(x=>x.WarehouseID!==w?.WarehouseID&&norm(x.Name)===norm(n))){err.textContent='فيه مخزن بنفس الاسم ده';return}
      const wantDefault=def.checked&&!w?.IsDefault;
      btn.disabled=true;
      try{
        const base=isNew?{WarehouseID:'WH-'+uuid().slice(0,8).toUpperCase(),Active:true,CreatedAt:nowISO()}:w;
        const rec={...base,Name:n,Address:addr.value.trim(),Notes:notes.value.trim(),IsDefault:wantDefault?true:!!w?.IsDefault};
        const changes=[{rec,old:w||null,action:isNew?'WAREHOUSE_CREATE':'WAREHOUSE_EDIT'}];
        const prev=wantDefault?prevDefault(rec.WarehouseID):null;
        if(prev)changes.push({rec:{...prev,IsDefault:false},old:prev,action:'WAREHOUSE_SET_DEFAULT'});
        await commit(user,changes);close();toast(isNew?'تم إضافة المخزن':'تم حفظ التعديل');load();
      }catch(e){btn.disabled=false;err.textContent=e.code==='FORBIDDEN'?e.message:'تعذر الحفظ على الجهاز. حاول تاني.'}
    };
    const btn=el('button',{class:'btn',type:'button',onclick:save},'حفظ');
    const close=modal(isNew?'مخزن جديد':'تعديل '+w.Name,field('اسم المخزن *',name),field('العنوان',addr),field('ملاحظات',notes),
      el('label',{class:'chk'},def,'المخزن الافتراضي'),
      w?.IsDefault&&el('p',{class:'note'},'ده المخزن الافتراضي الحالي — لتغييره افتح مخزن تاني واختار «تعيين كافتراضي».'),
      inactive&&el('p',{class:'note'},'المخزن معطل — فعّله الأول لو عايزه افتراضي.'),err,btn);
    name.focus();
  }

  $('#app').replaceChildren(el('div',{class:'wrap'},el('div',{class:'hello'},el('h2',{},'المخازن'),el('button',{class:'btn ghost',type:'button',onclick:onBack},'رجوع')),
    el('div',{class:'filters'},el('button',{class:'btn',type:'button',onclick:()=>form(null)},'+ مخزن جديد')),banner,count,list));
  await backfillWarehouses().catch(()=>{});
  await load();
}
