import {all,byIndex,txRun,uuid,nowISO,deviceId} from './db.js';
import {can} from './auth.js';
import {norm,compact} from './products.js';
import {$,el,toast,fmt} from './ui.js';

export const normPhone=s=>String(s||'').replace(/[٠-٩]/g,d=>'٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[\s\-().]/g,'');

// حفظ عميل (جديد أو تعديل) + طابور المزامنة + سجل العمليات في معاملة واحدة. العملاء ما بيتمسحوش — Active=false بس.
export function saveCustomer(c,user,old){
  const now=nowISO(),dev=deviceId();
  const rec={...c,UpdatedAt:now,SyncStatus:'PENDING'};
  return txRun(['customers','syncq','audit'],t=>{
    t.objectStore('customers').put(rec);
    t.objectStore('syncq').put({OpID:uuid(),Entity:'customers',EntityID:rec.CustomerID,Status:'PENDING',CreatedAt:now,Tries:0});
    t.objectStore('audit').put({AuditID:uuid(),UserID:user.UserID,UserName:user.Name,Action:old?(old.Active!==rec.Active?(rec.Active?'CUSTOMER_ACTIVATE':'CUSTOMER_DEACTIVATE'):'CUSTOMER_EDIT'):'CUSTOMER_CREATE',
      EntityType:'Customer',EntityID:rec.CustomerID,DateTime:now,DeviceID:dev,OldValue:old?JSON.stringify({Name:old.Name,Phone:old.Phone,Address:old.Address,Active:old.Active}):null,
      NewValue:JSON.stringify({Name:rec.Name,Phone:rec.Phone,Address:rec.Address,Active:rec.Active}),Notes:'',SyncStatus:'PENDING'});
  }).then(()=>rec);
}

function modal(title,...kids){
  const close=()=>{ov.remove();removeEventListener('keydown',esc)};const esc=e=>{if(e.key==='Escape')close()};addEventListener('keydown',esc);
  const ov=el('div',{class:'overlay',role:'dialog','aria-modal':'true','aria-label':title,onclick:e=>{if(e.target===ov)close()}},
    el('div',{class:'sheet'},el('div',{class:'shead'},el('h3',{},title),el('button',{class:'x',type:'button',onclick:close,'aria-label':'إغلاق'},'✕')),...kids));
  document.body.append(ov);return close;
}

// نموذج إضافة/تعديل عميل — بيتستخدم في شاشة العملاء وفي الإضافة السريعة من الفاتورة
export async function customerForm({user,customer,onSaved}){
  const isNew=!customer, all_=await all('customers');
  const name=el('input',{type:'text',maxlength:'80',value:customer?.Name||'',placeholder:'اسم العميل / المحل *','aria-label':'اسم العميل'});
  const phone=el('input',{type:'tel',inputmode:'tel',maxlength:'20',value:customer?.Phone||'',placeholder:'رقم الواتساب (مثال: 01012345678)','aria-label':'الهاتف'});
  const addr=el('input',{type:'text',maxlength:'160',value:customer?.Address||'',placeholder:'العنوان (اختياري)','aria-label':'العنوان'});
  const notes=el('input',{type:'text',maxlength:'200',value:customer?.Notes||'',placeholder:'ملاحظات (اختياري)','aria-label':'ملاحظات'});
  const err=el('p',{class:'err'});let warned=false;
  const field=(l,i)=>el('label',{class:'field'},el('span',{},l),i);
  const save=async()=>{
    err.textContent='';const n=name.value.trim(),ph=normPhone(phone.value);
    if(!n){err.textContent='اكتب اسم العميل';return}
    if(ph&&!/^\+?\d{8,15}$/.test(ph)){err.textContent='رقم التليفون غير صحيح';return}
    const dup=ph&&all_.find(c=>c.Active!==false&&c.Phone===ph&&c.CustomerID!==customer?.CustomerID);
    if(dup&&!warned){warned=true;err.textContent=`الرقم ده مسجل للعميل «${dup.Name}». اضغط حفظ تاني لو عايز تحفظ برضه.`;return}
    btn.disabled=true;
    try{const rec=await saveCustomer({CustomerID:customer?.CustomerID||uuid(),Name:n,Phone:ph,Address:addr.value.trim(),Notes:notes.value.trim(),
        Active:customer?customer.Active!==false:true,CreatedAt:customer?.CreatedAt||nowISO()},user,customer);
      close();toast(isNew?'تم إضافة العميل':'تم حفظ التعديل');onSaved?.(rec)}
    catch{btn.disabled=false;err.textContent='تعذر الحفظ على الجهاز. حاول تاني.'}
  };
  const btn=el('button',{class:'btn',type:'button',onclick:save},'حفظ');
  const close=modal(isNew?'عميل جديد':'تعديل عميل',field('الاسم *',name),field('الهاتف',phone),field('العنوان',addr),field('ملاحظات',notes),err,btn);
  name.focus();
}

// اختيار عميل (للفاتورة): بحث بالاسم/الهاتف/المعرّف + إضافة سريعة
export async function pickCustomer({user,onPick}){
  const list=(await all('customers')).filter(c=>c.Active!==false).sort((a,b)=>a.Name.localeCompare(b.Name,'ar'));
  const canAdd=await can(user,'EditCustomers');
  const q=el('input',{type:'search',class:'psearch',placeholder:'ابحث بالاسم أو الهاتف…',autocomplete:'off','aria-label':'بحث عميل'});
  const res=el('div',{class:'results'});
  const draw=()=>{const toks=norm(q.value).split(' ').filter(Boolean),ph=compact(q.value);
    const r=list.filter(c=>toks.every(k=>norm(c.Name).includes(k)||(c.Phone||'').includes(compact(k))||c.CustomerID.startsWith(k)));
    res.replaceChildren(...r.slice(0,30).map(c=>el('button',{class:'rbtn',type:'button',onclick:()=>{close();onPick(c)}},el('b',{},c.Name),el('span',{class:'code',dir:'ltr'},c.Phone||''),el('small',{},c.Address||''))),
      !r.length&&el('p',{class:'empty'},list.length?'مفيش عميل بالاسم ده':'لسه ما فيش عملاء — أضف أول عميل'));};
  q.addEventListener('input',draw);
  const close=modal('اختيار عميل',q,canAdd&&el('button',{class:'btn ghost wide',type:'button',onclick:()=>{close();customerForm({user,onSaved:onPick})}},'+ عميل جديد'),res);
  draw();q.focus();
}

export async function showCustomers(user,onBack,onInvoiceFor){
  const canEdit=await can(user,'EditCustomers'),canInv=await can(user,'CreateInvoice');
  let showInactive=false;
  const q=el('input',{type:'search',class:'psearch',placeholder:'ابحث بالاسم أو الهاتف…',autocomplete:'off','aria-label':'بحث في العملاء'});
  const list=el('div',{class:'plist cust'}),count=el('div',{class:'pcount'});
  const inact=el('label',{class:'chk'},el('input',{type:'checkbox',onchange:e=>{showInactive=e.target.checked;draw()}}),'عرض غير النشطين');
  let rows=[];
  async function load(){rows=(await all('customers')).sort((a,b)=>a.Name.localeCompare(b.Name,'ar'));draw()}
  function draw(){
    const toks=norm(q.value).split(' ').filter(Boolean);
    const r=rows.filter(c=>(showInactive||c.Active!==false)&&toks.every(k=>norm(c.Name).includes(k)||(c.Phone||'').includes(compact(k))||c.CustomerID.startsWith(k)));
    count.textContent=`${fmt(r.length)} عميل`;
    list.replaceChildren(...(r.length?r.map(c=>el('article',{class:'pcard ccard',tabindex:'0',role:'button',onclick:()=>details(c),onkeydown:e=>{if(e.key==='Enter')details(c)}},
      el('div',{class:'pbody'},el('h3',{},c.Name),el('div',{class:'pmeta'},el('span',{class:'code',dir:'ltr'},c.Phone||'بدون رقم'),c.Active===false&&el('span',{class:'bdg no'},'غير نشط')),
        c.Address&&el('div',{class:'pstock'},c.Address)))):[el('p',{class:'empty'},rows.length?'مفيش عميل مطابق':'لسه ما فيش عملاء'+(canEdit?' — دوس «عميل جديد»':''))]));
  }
  q.addEventListener('input',draw);
  async function details(c){
    const inv=(await byIndex('invoices','CustomerID',c.CustomerID)).sort((a,b)=>b.DateTime.localeCompare(a.DateTime));
    const row=(k,v)=>el('div',{class:'drow'},el('span',{},k),el('b',{dir:'auto'},v||'—'));
    const close=modal(c.Name,row('الهاتف',c.Phone),row('العنوان',c.Address),row('ملاحظات',c.Notes),row('الحالة',c.Active===false?'غير نشط':'نشط'),
      row('عدد الفواتير',fmt(inv.length)),
      ...inv.slice(0,5).map(i=>el('div',{class:'drow'},el('span',{dir:'ltr'},i.Number),el('b',{},fmt(i.Total)+' ج.م'))),
      el('div',{class:'btnrow'},
        canInv&&c.Active!==false&&onInvoiceFor&&el('button',{class:'btn',type:'button',onclick:()=>{close();onInvoiceFor(c)}},'إنشاء فاتورة'),
        canEdit&&el('button',{class:'btn ghost',type:'button',onclick:()=>{close();customerForm({user,customer:c,onSaved:load})}},'تعديل'),
        canEdit&&el('button',{class:'btn ghost danger',type:'button',onclick:async()=>{await saveCustomer({...c,Active:c.Active===false},user,c);close();toast(c.Active===false?'تم تفعيل العميل':'تم إيقاف العميل (فواتيره القديمة محفوظة)');load()}},c.Active===false?'تفعيل':'إيقاف')));
  }
  $('#app').replaceChildren(el('div',{class:'wrap'},el('div',{class:'hello'},el('h2',{},'العملاء'),el('button',{class:'btn ghost',onclick:onBack},'رجوع')),
    q,el('div',{class:'filters'},canEdit&&el('button',{class:'btn',type:'button',onclick:()=>customerForm({user,onSaved:load})},'+ عميل جديد'),inact),count,list));
  await load();
}
