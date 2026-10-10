// شاشة «سجل العمليات» (v13) — عرض فقط لجدول audit المحفوظ على الجهاز: التاريخ، المستخدم، العملية، الكيان، القيمة القديمة والجديدة.
// مفيش فيها أي تعديل أو مسح (السجل append-only). محمية بصلاحية ViewAudit (المدير/المالك). التكلفة بتتخبّى (••••) لمن ليس معه ViewCost.
import {all} from './db.js';
import {can} from './auth.js';
import {norm} from './products.js';
import {$,el,toast,fmt,modal} from './ui.js';

const PAGE=50;
// [الاسم بالعربي, لون الشارة]
const ACT={
  INVOICE_CREATE:['إنشاء فاتورة','ok'],INVOICE_EDIT:['تعديل فاتورة','edited'],INVOICE_VOID:['إلغاء فاتورة','void'],CREDIT_NOTE_CREATE:['مرتجع','cn'],
  STOCK_IN:['استلام مخزون','ok'],STOCK_OUT:['صرف مخزون','warn'],STOCK_TRANSFER:['تحويل بين المخازن','cn'],TRANSFER_VOID:['إلغاء تحويل','void'],STOCKDOC_VOID:['إلغاء مستند مخزن','void'],
  CUSTOMER_CREATE:['إضافة عميل','ok'],CUSTOMER_EDIT:['تعديل عميل','edited'],CUSTOMER_ACTIVATE:['تفعيل عميل','ok'],CUSTOMER_DEACTIVATE:['إيقاف عميل','no'],
  USER_CREATE:['إضافة مستخدم','ok'],USER_EDIT:['تعديل مستخدم','edited'],USER_ACTIVATE:['تفعيل مستخدم','ok'],USER_DEACTIVATE:['إيقاف مستخدم','no'],USER_PIN_CHANGE:['تغيير رقم سري','warn'],
  WAREHOUSE_CREATE:['إضافة مخزن','ok'],WAREHOUSE_EDIT:['تعديل مخزن','edited'],WAREHOUSE_SET_DEFAULT:['تعيين مخزن افتراضي','cn'],WAREHOUSE_ACTIVATE:['تفعيل مخزن','ok'],WAREHOUSE_DEACTIVATE:['تعطيل مخزن','no'],
  PRODUCT_EDIT:['تعديل صنف','edited'],PRODUCT_PRICE_CHANGE:['تغيير سعر','edited'],BACKUP_EXPORT:['نسخة احتياطية','cn'],BACKUP_RESTORE:['استرجاع نسخة','warn']
};
const KEY_AR={Name:'الاسم',Code:'الكود',Cost:'التكلفة',PricePiece:'سعر القطعة',PriceCarton:'سعر الكرتونة',Status:'الحالة',Total:'الإجمالي',total:'الإجمالي',number:'الرقم',product:'الصنف',
  RoleID:'الدور',Active:'نشط',ExtraPerms:'صلاحيات إضافية',DeniedPerms:'صلاحيات ممنوعة',Phone:'الهاتف',Address:'العنوان',Notes:'ملاحظات',IsDefault:'افتراضي',version:'النسخة',
  lines:'الأصناف',warehouseId:'المخزن',from:'من مخزن',to:'إلى مخزن',customer:'العميل',parent:'عن فاتورة',reversals:'عدد الحركات العكسية',allowNegative:'تجاوز الرصيد',adjust:'فروق المخزن',
  type:'النوع',name:'الاسم',counts:'الأعداد'};
const STATUS_AR={POSTED:'ساري',VOID:'ملغي'};
const fdt=iso=>{const d=new Date(iso),p=n=>String(n).padStart(2,'0');return isNaN(d)?'—':`${d.getFullYear()}/${p(d.getMonth()+1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`};
const parse=s=>{if(s==null||s==='')return null;if(typeof s!=='string')return s;try{return JSON.parse(s)}catch{return s}};
const label=a=>ACT[a]?.[0]||a;

export async function showAuditLog(user,onBack){
  if(!await can(user,'ViewAudit')){toast('سجل العمليات للمدير/المالك بس');onBack();return}
  const canCost=await can(user,'ViewCost');
  const prods=new Map((await all('products')).map(p=>[p.ProductID,p])),whs=new Map((await all('warehouses')).map(w=>[w.WarehouseID,w.Name]));
  let rows=[];const S={user:'',action:'',from:'',to:'',q:'',shown:PAGE};

  // ---- تحويل القيم لنص مقروء ----
  const prodName=id=>{const p=prods.get(id);return p?`${p.Code} — ${p.Name||'(بدون اسم)'}`:null};
  function show(v,key){
    if(v==null||v==='')return '—';
    if(key==='Cost'&&!canCost)return '••••';
    if(typeof v==='boolean')return v?'نعم':'لا';
    if(typeof v==='number')return fmt(v);
    if(typeof v==='string'){
      if(whs.has(v))return whs.get(v);
      if(key==='Status'&&STATUS_AR[v])return STATUS_AR[v];
      if(/^\d{4}-\d{2}-\d{2}T/.test(v))return fdt(v);
      return prodName(v)||v;
    }
    if(Array.isArray(v)){
      if(!v.length)return '—';
      return v.map(x=>{
        if(x&&typeof x==='object'&&('p' in x)){                                    // بنود: {p:صنف, q:كمية, price?}
          const q=x.q!=null?` × ${fmt(x.q)}`:'',pr=x.price!=null?` @ ${fmt(x.price)}`:'';
          return `${prodName(x.p)||x.p}${q}${pr}`;
        }
        return show(x);
      }).join(typeof v[0]==='object'?'\n':'، ');
    }
    if(typeof v==='object')return Object.entries(v).map(([k,x])=>`${KEY_AR[k]||k}: ${show(x,k)}`).join(' · ');
    return String(v);
  }
  const summary=a=>{
    const o=parse(a.NewValue)??parse(a.OldValue);
    if(o&&typeof o==='object'&&!Array.isArray(o)){const s=o.number||o.product||o.Name||o.name;if(s)return String(s)}
    return `${a.EntityType||''} · ${String(a.EntityID||'').slice(0,8)}`;
  };

  // ---- الواجهة ----
  const q=el('input',{type:'search',class:'psearch',placeholder:'ابحث بالرقم أو الاسم أو الملاحظة…',autocomplete:'off','aria-label':'بحث في السجل'});
  const userSel=el('select',{'aria-label':'المستخدم',onchange:e=>{S.user=e.target.value;S.shown=PAGE;draw()}});
  const actSel=el('select',{'aria-label':'نوع العملية',onchange:e=>{S.action=e.target.value;S.shown=PAGE;draw()}});
  const from=el('input',{type:'date','aria-label':'من تاريخ',onchange:e=>{S.from=e.target.value;S.shown=PAGE;draw()}});
  const to=el('input',{type:'date','aria-label':'إلى تاريخ',onchange:e=>{S.to=e.target.value;S.shown=PAGE;draw()}});
  const list=el('div',{class:'plist cust'}),count=el('div',{class:'pcount'});
  const more=el('button',{class:'btn ghost',type:'button',onclick:()=>{S.shown+=PAGE;draw()}},'عرض المزيد');
  let tm;q.addEventListener('input',()=>{clearTimeout(tm);tm=setTimeout(()=>{S.q=q.value;S.shown=PAGE;draw()},120)});
  const reset=el('button',{class:'btn ghost',type:'button',onclick:()=>{Object.assign(S,{user:'',action:'',from:'',to:'',q:'',shown:PAGE});q.value='';from.value='';to.value='';userSel.value='';actSel.value='';draw()}},'مسح الفلاتر');

  async function load(){
    rows=(await all('audit')).sort((a,b)=>String(b.DateTime).localeCompare(String(a.DateTime)));
    for(const a of rows){a._t=Date.parse(a.DateTime);a._sum=summary(a);a._hay=norm([a.UserName,label(a.Action),a.Action,a.EntityType,a.EntityID,a.Notes,a._sum].join(' '))}
    const users=new Map();rows.forEach(a=>{if(a.UserID&&!users.has(a.UserID))users.set(a.UserID,a.UserName||a.UserID)});
    userSel.replaceChildren(el('option',{value:''},'كل المستخدمين'),...[...users].sort((a,b)=>a[1].localeCompare(b[1],'ar')).map(([id,n])=>el('option',{value:id},n)));
    const acts=[...new Set(rows.map(a=>a.Action).filter(Boolean))].sort((a,b)=>label(a).localeCompare(label(b),'ar'));
    actSel.replaceChildren(el('option',{value:''},'كل العمليات'),...acts.map(a=>el('option',{value:a},label(a))));
    draw();
  }
  function filtered(){
    const toks=norm(S.q).split(' ').filter(Boolean);
    const f=S.from?new Date(S.from+'T00:00:00').getTime():null,t=S.to?new Date(S.to+'T23:59:59.999').getTime():null;
    return rows.filter(a=>(!S.user||a.UserID===S.user)&&(!S.action||a.Action===S.action)&&(f==null||a._t>=f)&&(t==null||a._t<=t)&&toks.every(k=>a._hay.includes(k)));
  }
  const card=a=>el('article',{class:'pcard ccard',tabindex:'0',role:'button',onclick:()=>details(a),onkeydown:e=>{if(e.key==='Enter')details(a)}},
    el('div',{class:'pbody'},
      el('div',{class:'pmeta'},el('span',{class:'bdg '+(ACT[a.Action]?.[1]||'cn')},label(a.Action)),el('span',{dir:'ltr'},fdt(a.DateTime))),
      el('h3',{dir:'auto'},a._sum),
      el('div',{class:'pstock'},`${a.UserName||'—'}${a.Notes?' · '+a.Notes:''}`)));
  function draw(){
    const r=filtered();
    count.textContent=`${fmt(r.length)} عملية`+(r.length!==rows.length?` من ${fmt(rows.length)}`:'');
    list.replaceChildren(...(r.length?r.slice(0,S.shown).map(card):[el('p',{class:'empty'},rows.length?'مفيش عمليات مطابقة للفلاتر دي':'سجل العمليات فاضي لسه')]));
    more.hidden=r.length<=S.shown;
  }

  function details(a){
    const row=(k,v)=>el('div',{class:'drow'},el('span',{},k),el('b',{dir:'auto',style:'white-space:pre-line;text-align:left'},v||'—'));
    const block=(title,raw)=>{
      const v=parse(raw);if(v==null)return null;
      const kids=[el('h3',{class:'sec'},title)];
      if(v&&typeof v==='object'&&!Array.isArray(v))for(const[k,x]of Object.entries(v))kids.push(row(KEY_AR[k]||k,show(x,k)));
      else kids.push(row('القيمة',show(v)));
      if(canCost||!/Cost/.test(String(raw)))kids.push(el('details',{class:'help-sec'},el('summary',{},'البيانات الخام'),el('pre',{class:'aud-pre',dir:'ltr'},typeof raw==='string'?raw:JSON.stringify(raw,null,1))));
      return kids;
    };
    modal(label(a.Action),
      row('التاريخ والوقت',fdt(a.DateTime)),row('المستخدم',a.UserName),row('الجهاز',a.DeviceID),row('العملية',`${label(a.Action)} (${a.Action})`),
      row('الكيان',`${a.EntityType||''} · ${a.EntityID||''}`),a.Notes&&row('ملاحظة / السبب',a.Notes),
      row('حالة المزامنة',a.SyncStatus==='SYNCED'?'متزامن':'بانتظار المزامنة'),
      ...(block('قبل (القيمة القديمة)',a.OldValue)||[]),...(block('بعد (القيمة الجديدة)',a.NewValue)||[]));
  }

  $('#app').replaceChildren(el('div',{class:'wrap'},el('div',{class:'hello'},el('h2',{},'سجل العمليات'),el('button',{class:'btn ghost',type:'button',onclick:onBack},'رجوع')),
    q,el('div',{class:'filters'},userSel,actSel),
    el('div',{class:'filters'},el('label',{class:'field datef'},el('span',{},'من تاريخ'),from),el('label',{class:'field datef'},el('span',{},'إلى تاريخ'),to),reset),
    count,list,el('div',{class:'morewrap'},more),
    el('p',{class:'note'},'السجل للعرض فقط — العمليات بتتسجل تلقائياً ومفيش حد يقدر يعدّلها أو يمسحها من التطبيق.')));
  await load();
}
