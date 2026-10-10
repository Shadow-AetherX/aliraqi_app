// شاشة الفواتير: إنشاء فاتورة (عميل + أصناف بالمسح/البحث + كراتين/قطع + سعر)، قائمة الفواتير، عرض الفاتورة + PDF/صور للمشاركة.
// الفاتورة ما بتتمسح أبداً: التعديل (نسخة جديدة، مسموح حتى مع مرتجع على أساس الصافي)، المرتجع (إشعار CN)، والإلغاء (ختم ملغاة + حركات عكسية) في reversal.js. الحفظ = فاتورة + بنودها + حركات الصرف + طابور المزامنة + سجل العمليات في معاملة واحدة.
import {all,get,byIndex,txRun,uuid,nowISO,deviceId,ymd,stockMap,toPieces,pickWarehouse} from './db.js';
import {can} from './auth.js';
import {norm,compact} from './products.js';
import {$,el,toast,fmt,modal,askReason} from './ui.js';
import {pickCustomer} from './customers.js';
import {openScanner,scannerSupport} from './scanner.js';
import {buildInvoiceFiles} from './invoice-pdf.js';
import {voidInvoice,editInvoice,createCreditNote,liveLines,returnedByLine} from './reversal.js';

const money=n=>Number(n||0).toLocaleString('en-US',{maximumFractionDigits:2});
const r2=n=>Math.round((Number(n)+Number.EPSILON)*100)/100;
const parseScan=s=>String(s).trim().replace(/^ALIRAQI-PRODUCT-/i,'');
const fdt=iso=>{const d=new Date(iso),p=n=>String(n).padStart(2,'0');return `${d.getFullYear()}/${p(d.getMonth()+1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`};

// ---------- حفظ الفاتورة (معاملة واحدة) ----------
// items: [{p:المنتج, cartons, pieces, unitPrice}] — سعر القطعة الافتراضي = PricePiece (carton_unit_price) والسعر الأصلي بيتخزن جنب السعر المستخدم.
export function postInvoice({customer,warehouseId,items,user,notes='',allowNegative=false}){
  if(!customer) throw new Error('اختار العميل');
  if(!items.length) throw new Error('مفيش أصناف في الفاتورة');
  const now=nowISO(),dev=deviceId(),invId=uuid();
  const lines=items.map((it,i)=>{
    const pcs=it.p.PcsPerCarton||0,tp=toPieces(it.cartons,it.pieces,pcs),price=Number(it.unitPrice);
    if(!Number.isInteger(tp)||tp<=0) throw new Error('كمية غير صالحة');
    if(!(price>0)) throw new Error('سعر غير صالح');
    const orig=it.p.PricePiece||null;
    return {LineID:uuid(),InvoiceID:invId,LineNo:i+1,ProductID:it.p.ProductID,Code:it.p.Code,Name:it.p.Name||'',Cartons:it.cartons,Pieces:it.pieces,
      PcsPerCarton:pcs,TotalPieces:tp,OriginalUnitPrice:orig,UnitPrice:price,PriceChanged:orig!==null&&orig!==price,LineTotal:r2(tp*price),
      UnitCost:typeof it.p.Cost==='number'&&Number.isFinite(it.p.Cost)?it.p.Cost:null,UpdatedAt:now};   // UnitCost = تكلفة القطعة وقت البيع (مثبّتة): null = الصنف ماكانش له تكلفة وقتها
  });
  const total=r2(lines.reduce((s,l)=>s+l.LineTotal,0)),pcsAll=lines.reduce((s,l)=>s+l.TotalPieces,0);
  return txRun(['invoices','invoice_lines','movements','syncq','audit','settings'],(t,fail,setOut)=>{
    const mv=t.objectStore('movements'),sq=t.objectStore('syncq'),au=t.objectStore('audit'),st=t.objectStore('settings');
    const q=(entity,id)=>sq.put({OpID:uuid(),Entity:entity,EntityID:id,Status:'PENDING',CreatedAt:now,Tries:0});
    const writeAll=n=>{
      const number=`ALR-${ymd(new Date(now))}-${dev.replace(/^D-/,'')}-${String(n).padStart(4,'0')}`;   // لا يتعارض بين الأجهزة
      const inv={InvoiceID:invId,Number:number,DateTime:now,CustomerID:customer.CustomerID,CustomerName:customer.Name,CustomerPhone:customer.Phone||'',
        CustomerAddress:customer.Address||'',WarehouseID:warehouseId,Status:'POSTED',Version:1,Total:total,ItemsCount:lines.length,TotalPieces:pcsAll,
        Notes:notes,UserID:user.UserID,UserName:user.Name,DeviceID:dev,UpdatedAt:now,SyncStatus:'PENDING'};
      t.objectStore('invoices').put(inv);q('invoices',invId);
      for(const l of lines){
        t.objectStore('invoice_lines').put(l);q('invoice_lines',l.LineID);
        const m={MovementID:uuid(),DateTime:now,ProductID:l.ProductID,WarehouseID:warehouseId,MovementType:'STOCK_OUT',QuantityPieces:-l.TotalPieces,
          ReferenceID:invId,UserID:user.UserID,DeviceID:dev,SyncStatus:'PENDING',Notes:'فاتورة '+number};
        mv.put(m);q('movements',m.MovementID);
      }
      au.put({AuditID:uuid(),UserID:user.UserID,UserName:user.Name,Action:'INVOICE_CREATE',EntityType:'Invoice',EntityID:invId,DateTime:now,DeviceID:dev,OldValue:null,
        NewValue:JSON.stringify({number,customer:customer.CustomerID,warehouseId,total,lines:lines.map(l=>({p:l.ProductID,q:l.TotalPieces,price:l.UnitPrice,orig:l.OriginalUnitPrice}))}),Notes:notes,SyncStatus:'PENDING'});
      setOut({inv,lines});
    };
    const seqStep=()=>{const key=`invseq:${dev}:${ymd(new Date(now))}`;
      st.get(key).onsuccess=e=>{const n=(e.target.result?.value||0)+1;st.put({key,value:n});writeAll(n)}};
    if(allowNegative){seqStep();return}
    let left=lines.length;
    for(const l of lines){
      mv.index('ProductID').getAll(l.ProductID).onsuccess=e=>{
        const avail=e.target.result.filter(m=>m.WarehouseID===warehouseId).reduce((s,m)=>s+m.QuantityPieces,0);
        if(avail<l.TotalPieces){fail(Object.assign(new Error('الرصيد مش كفاية'),{code:'INSUFFICIENT',productId:l.ProductID,available:avail,requested:l.TotalPieces}));return}
        if(--left===0) seqStep();
      };
    }
  });
}

// ---------- شاشة إنشاء فاتورة / تعديل فاتورة ----------
// opts.customer: عميل متحدد مسبقاً. opts.edit={inv,lines}: وضع التعديل (المخزن والعميل ثابتين، السبب إجباري، والحفظ بينتج نسخة جديدة بنفس الرقم).
export async function showInvoiceNew(user,onBack,opts={}){
  const edit=opts.edit||null;
  const allProds=await all('products');
  const prods=allProds.filter(p=>p.Active!==false).sort((a,b)=>a.SourceRow-b.SourceRow);
  prods.forEach(p=>{p._hay=norm(p.Name+' '+p.Category+' '+p.Code);p._code=compact(p.Code)});
  const byId=new Map(allProds.map(p=>[p.ProductID,p]));          // كل الأصناف (حتى الموقوفة) عشان بنود فاتورة قديمة
  const whs=(await all('warehouses')).filter(w=>w.Active||(edit&&w.WarehouseID===edit.inv.WarehouseID));
  const canOverride=await can(user,'OverrideStock'),canPrice=await can(user,'OverridePrice');
  const minPcs=new Map(edit?.returned||[]);                // اللي اترجّع لكل صنف: حد أدنى للكمية في التعديل (الصافي ≥ 0)
  const origPcs=new Map(edit?edit.lines.map(l=>[l.ProductID,l.TotalPieces]):[]);   // اللي خرج بالفعل في النسخة الحالية (متاح للتعديل)
  let stock=await stockMap(),customer=edit?{CustomerID:edit.inv.CustomerID,Name:edit.inv.CustomerName,Phone:edit.inv.CustomerPhone,Address:edit.inv.CustomerAddress}:(opts.customer||null),scanUnit='carton',busy=false;
  const lines=new Map();                                   // productId -> {cartons,pieces,price}
  if(edit)for(const l of edit.lines)lines.set(l.ProductID,{cartons:l.Cartons,pieces:l.Pieces,price:l.UnitPrice});

  const lastWh=edit?'':pickWarehouse(whs),hasLast=!edit&&!!lastWh;   // الافتراضي أولاً ثم آخر مخزن اتستخدم
  const whSel=el('select',{'aria-label':'المخزن',onchange:()=>{if(!edit&&whSel.value)localStorage.setItem('alr_last_wh',whSel.value);updateTotals()}},
    !hasLast&&!edit&&el('option',{value:''},'اختر المخزن…'),whs.map(w=>el('option',{value:w.WarehouseID},w.Name)));
  if(edit){whSel.value=edit.inv.WarehouseID;whSel.disabled=true}else if(hasLast)whSel.value=lastWh;
  const note=el('input',{type:'text',maxlength:'160',placeholder:'ملاحظة داخلية (مش بتظهر في الفاتورة)','aria-label':'ملاحظة'});
  const reason=el('input',{type:'text',maxlength:'160',placeholder:'سبب التعديل (مطلوب)','aria-label':'سبب التعديل'});
  reason.addEventListener('input',()=>updateTotals());
  const q=el('input',{type:'search',class:'psearch',placeholder:'اكتب الكود أو الاسم… أو امسح الباركود',autocomplete:'off',enterkeyhint:'done','aria-label':'إضافة صنف'});
  const results=el('div',{class:'results'}),linesBox=el('div',{class:'slines'}),summary=el('div',{class:'ssum'}),msg=el('p',{class:'err'}),hint=el('p',{class:'note'});
  const grand=el('b',{class:'inv-grand'},'0 ج.م');
  const override=el('input',{type:'checkbox'});const ovWrap=canOverride?el('label',{class:'chk warnbox'},override,'تجاوز الرصيد (صلاحية خاصة)'):null;
  const confirmBtn=el('button',{class:'btn',type:'button',onclick:confirm},edit?'حفظ التعديل':'حفظ الفاتورة');
  const custBox=el('div',{class:'inv-cust'});
  const avail=p=>(((stock.get(p.ProductID)||{})[whSel.value])||0)+(origPcs.get(p.ProductID)||0);

  function drawCustomer(){
    custBox.replaceChildren(el('div',{},el('span',{class:'inv-lbl'},'العميل'),customer?el('b',{},customer.Name):el('b',{class:'warn'},'لسه ما اخترتش عميل'),
      customer&&customer.Phone&&el('span',{class:'code',dir:'ltr'},' '+customer.Phone)),
      !edit&&el('button',{class:'btn ghost',type:'button',onclick:()=>pickCustomer({user,onPick:c=>{customer=c;drawCustomer();updateTotals()}})},customer?'تغيير':'اختيار عميل'));
  }
  function add(p,dc=0,dp=0){
    if(!p.PricePiece&&!canPrice){toast('الصنف ده من غير سعر — محتاج صلاحية تعديل السعر');return false}
    const l=lines.get(p.ProductID)||{cartons:0,pieces:0,price:p.PricePiece||''};
    l.cartons+=dc;l.pieces+=dp;lines.set(p.ProductID,l);q.value='';results.replaceChildren();renderLines();return true;
  }
  const addUnit=p=>scanUnit==='carton'&&p.PcsPerCarton?add(p,1,0):add(p,0,1);
  function addFromScanText(text){
    const c=compact(parseScan(text));if(!c)return null;
    const hits=prods.filter(p=>p._code===c);
    if(hits.length===1){const p=hits[0];return addUnit(p)?p:null}
    if(hits.length>1){showPicker(hits);return hits}
    return null;
  }
  function showPicker(list){
    results.replaceChildren(...list.slice(0,8).map(p=>el('button',{class:'rbtn',type:'button',onclick:()=>addUnit(p)},
      el('b',{},p.Name||'(بدون اسم)'),el('span',{dir:'ltr',class:'code'},p.Code),el('small',{},p.Category),
      el('small',{},p.PricePiece?`${money(p.PricePiece)} ج.م للقطعة · الرصيد ${fmt(avail(p))}`:`من غير سعر · الرصيد ${fmt(avail(p))}`))));
  }
  function onType(){
    const toks=norm(q.value).split(' ').filter(Boolean);if(!toks.length){results.replaceChildren();return}
    const r=prods.filter(p=>toks.every(k=>p._hay.includes(k)||p._code.includes(compact(k))));
    const exact=compact(q.value);r.sort((a,b)=>(b._code===exact)-(a._code===exact));
    if(!r.length){results.replaceChildren(el('p',{class:'empty'},'مفيش صنف بالاسم/الكود ده'));return}
    showPicker(r);
  }
  let tm;q.addEventListener('input',()=>{clearTimeout(tm);tm=setTimeout(onType,100)});
  q.addEventListener('keydown',e=>{if(e.key!=='Enter')return;e.preventDefault();
    const c=compact(q.value),hits=prods.filter(p=>p._code===c);
    if(hits.length===1)addFromScanText(q.value);else if(!hits.length&&results.children.length===1&&results.firstChild.classList?.contains('rbtn'))results.firstChild.click()});

  const refs=new Map();
  function buildLines(){
    refs.clear();const rows=[];
    for(const [id,l] of lines){
      const p=byId.get(id);
      const num=(key,dis)=>{const i=el('input',{type:'number',min:'0',step:'1',inputmode:'numeric',value:String(l[key]),disabled:dis,'aria-label':key==='cartons'?'كراتين':'قطع'});
        i.addEventListener('input',()=>{l[key]=Math.max(0,Math.floor(Number(i.value)||0));updateTotals()});i.addEventListener('focus',()=>i.select());return i};
      const price=el('input',{type:'number',min:'0',step:'0.01',inputmode:'decimal',value:l.price===''?'':String(l.price),readonly:!canPrice,placeholder:'السعر','aria-label':'سعر القطعة'});
      price.addEventListener('input',()=>{l.price=price.value===''?'':Number(price.value);updateTotals()});price.addEventListener('focus',()=>price.select());
      const tot=el('b',{}),stk=el('small',{}),cp=el('small',{class:'inv-sub'}),chg=el('small',{class:'warn'});
      const root=el('div',{class:'sline'},
        el('div',{class:'slhead'},el('div',{},el('b',{},p.Name||'(بدون اسم)'),el('span',{class:'code',dir:'ltr'},' '+p.Code)),
          el('button',{class:'x',type:'button','aria-label':'حذف الصنف',onclick:()=>{if(minPcs.get(id)>0){toast('الصنف ده اتعمل له مرتجع — ما ينفعش يتشال من الفاتورة');return}lines.delete(id);renderLines()}},'✕')),
        el('div',{class:'slqty'},el('label',{},'كراتين',num('cartons',!p.PcsPerCarton)),el('label',{},'قطع',num('pieces',false)),
          el('label',{},'سعر القطعة',price)),
        el('div',{class:'inv-lt'},tot),cp,chg,stk,
        !p.PcsPerCarton&&el('small',{class:'warn'},'عدد القطع في الكرتونة غير محدد — الإدخال بالقطعة فقط'));
      refs.set(id,{p,l,tot,stk,cp,chg,root});rows.push(root);
    }
    linesBox.replaceChildren(...(rows.length?rows:[el('p',{class:'empty'},'لسه ما ضفتش أصناف')]));
  }
  function updateTotals(){
    msg.textContent='';let tp=0,sum=0,bad=0,invalid=0;
    for(const {p,l,tot,stk,cp,chg,root} of refs.values()){
      const t=toPieces(l.cartons,l.pieces,p.PcsPerCarton||0),pr=Number(l.price),okP=l.price!==''&&pr>0,lt=okP?r2(t*pr):0;
      tp+=t;sum+=lt;tot.textContent=`${fmt(t)} قطعة · ${money(lt)} ج.م`;
      cp.textContent=okP&&p.PcsPerCarton?`سعر الكرتونة: ${money(r2(pr*p.PcsPerCarton))} ج.م`:'';
      chg.textContent=okP&&p.PricePiece&&pr!==p.PricePiece?`السعر معدّل (الأصلي ${money(p.PricePiece)}) — هيتسجل في السجل`:'';
      const over=t>avail(p),min=minPcs.get(p.ProductID)||0,under=t<min;if(over)bad++;if(t===0||!okP||under)invalid++;
      root.classList.toggle('over',over||under);stk.textContent=`الرصيد في المخزن: ${fmt(avail(p))} قطعة`+(over?' — الكمية أكبر من الرصيد':'')
        +(min?` · اترجّع ${fmt(min)} قطعة (الصافي ${fmt(t-min)})`+(under?' — الكمية أقل من المرتجع':''):'');stk.className=(over||under)?'warn':'';
    }
    grand.textContent=money(r2(sum))+' ج.م';summary.textContent=lines.size?`${fmt(lines.size)} صنف · ${fmt(tp)} قطعة`:'';
    const why=!customer?'اختار العميل':!whSel.value?'اختار المخزن':!lines.size?'ضيف أصناف':invalid?'في صنف من غير كمية أو سعر':(edit&&reason.value.trim().length<3)?'اكتب سبب التعديل':'';
    hint.textContent=why;
    confirmBtn.disabled=!!why||busy||!!(bad&&!(canOverride&&override.checked));
    if(ovWrap)ovWrap.hidden=!bad;
  }
  const renderLines=()=>{buildLines();updateTotals()};
  if(ovWrap)override.addEventListener('change',updateTotals);

  async function confirm(){
    if(busy)return;busy=true;confirmBtn.disabled=true;msg.textContent='';
    try{
      const items=[...lines].map(([id,l])=>({p:byId.get(id),cartons:l.cartons,pieces:l.pieces,unitPrice:Number(l.price)}));
      if(edit){
        await editInvoice({invoiceId:edit.inv.InvoiceID,items,reason:reason.value,user,allowNegative:canOverride&&override.checked});
        toast('تم حفظ التعديل — نسخة جديدة بنفس رقم الفاتورة');onBack();return;
      }
      const r=await postInvoice({customer,warehouseId:whSel.value,items,user,notes:note.value.trim(),allowNegative:canOverride&&override.checked});
      showInvoiceView(user,r.inv.InvoiceID,onBack,{fresh:true});
    }catch(e){
      busy=false;
      if(e.code==='INSUFFICIENT'){const p=byId.get(e.productId);msg.textContent=`الرصيد مش كفاية للصنف «${p?.Name}» — المتاح ${fmt(e.available)} والمطلوب ${fmt(e.requested)}. ${edit?'ما اتحفظش التعديل.':'ما اتسجلتش فاتورة.'}`;stock=await stockMap()}
      else if(typeof e.code==='string')msg.textContent=e.message;
      else msg.textContent='تعذر الحفظ على الجهاز. حاول مرة تانية. ('+(e.message||'')+')';
      updateTotals();
    }
  }
  const scanOnCode=text=>{const r=addFromScanText(text);
    if(r&&!Array.isArray(r))return{status:'ok',label:r.Name+' — '+r.Code};return Array.isArray(r)?{status:'multi'}:{status:'unknown'}};
  const sup=await scannerSupport();
  const scanBtn=sup?el('button',{class:'btn scanb',type:'button',onclick:()=>openScanner(scanOnCode)},'📷 مسح بالكاميرا'):null;
  const unitSw=el('div',{class:'unit-switch2',role:'group','aria-label':'المسح يضيف'},
    ['carton','piece'].map(u=>el('button',{type:'button',class:u===scanUnit?'on':'','data-u':u,onclick:e=>{scanUnit=u;[...e.currentTarget.parentNode.children].forEach(b=>b.classList.toggle('on',b.dataset.u===u))}},u==='carton'?'المسح = كرتونة':'المسح = قطعة')));
  $('#app').replaceChildren(el('div',{class:'wrap'},
    el('div',{class:'hello'},el('h2',{},edit?'تعديل فاتورة '+edit.inv.Number:'فاتورة جديدة'),el('button',{class:'btn ghost',type:'button',onclick:onBack},'رجوع')),
    edit&&el('div',{class:'editwarn'},`هتتحفظ نسخة جديدة (نسخة ${(edit.inv.Version||1)+1}) بنفس الرقم، والنسخة الحالية بتتحفظ في السجل. بيتكتب في المخزن الفرق بس.`+(minPcs.size?' الفاتورة عليها مرتجع: الكمية الجديدة لكل صنف لازم تكون ≥ اللي اترجّع منه.':'')),
    custBox,el('label',{class:'field'},el('span',{},'المخزن'),whSel),
    edit?el('label',{class:'field'},el('span',{},'سبب التعديل *'),reason):el('label',{class:'field'},el('span',{},'ملاحظة'),note),
    q,scanBtn,unitSw,!scanBtn&&el('p',{class:'note'},'المسح بالكاميرا مش مدعوم هنا — اكتب الكود أو استخدم قارئ باركود.'),
    results,linesBox,summary,el('div',{class:'inv-bar'},el('span',{},'الإجمالي'),grand),ovWrap,msg,hint,confirmBtn));
  drawCustomer();renderLines();
}

// ---------- قائمة الفواتير + المرتجعات ----------
export async function showInvoices(user,onBack){
  const canNew=await can(user,'CreateInvoice');
  const invRows=(await all('invoices')).sort((a,b)=>b.DateTime.localeCompare(a.DateTime));
  const cnRows=(await all('credit_notes')).sort((a,b)=>b.DateTime.localeCompare(a.DateTime));
  let mode='inv';
  const q=el('input',{type:'search',class:'psearch',placeholder:'ابحث برقم المستند أو اسم العميل…',autocomplete:'off','aria-label':'بحث في الفواتير'});
  const list=el('div',{class:'plist cust'}),count=el('div',{class:'pcount'});
  const back=()=>showInvoices(user,onBack);
  const sw=el('div',{class:'unit-switch2',role:'group','aria-label':'نوع المستند'},
    [['inv','الفواتير'],['cn','المرتجعات']].map(([m,t])=>el('button',{type:'button',class:m===mode?'on':'','data-m':m,
      onclick:e=>{mode=m;[...e.currentTarget.parentNode.children].forEach(b=>b.classList.toggle('on',b.dataset.m===m));draw()}},t)));
  function draw(){
    const rows=mode==='inv'?invRows:cnRows;
    const toks=norm(q.value).split(' ').filter(Boolean);
    const r=rows.filter(i=>toks.every(k=>norm(i.CustomerName||'').includes(k)||i.Number.toLowerCase().includes(k)));
    count.textContent=`${fmt(r.length)} ${mode==='inv'?'فاتورة':'مرتجع'}`;
    const open=i=>mode==='inv'?showInvoiceView(user,i.InvoiceID,back):showCreditNoteView(user,i.CreditNoteID,back);
    list.replaceChildren(...(r.length?r.slice(0,100).map(i=>el('article',{class:'pcard ccard',tabindex:'0',role:'button',onclick:()=>open(i),onkeydown:e=>{if(e.key==='Enter')open(i)}},
      el('div',{class:'pbody'},el('h3',{},i.CustomerName||'—'),el('div',{class:'pmeta'},el('span',{class:'code',dir:'ltr'},i.Number),el('b',{},money(i.Total)+' ج.م')),
        el('div',{class:'badges'},mode==='inv'&&i.Status==='VOID'&&el('span',{class:'bdg void'},'ملغاة'),mode==='inv'&&i.Version>1&&el('span',{class:'bdg edited'},'معدّلة'),mode==='cn'&&el('span',{class:'bdg cn'},'مرتجع')),
        el('div',{class:'pstock'},fdt(i.DateTime)+(mode==='cn'?' · عن '+i.ParentNumber:''))))):
      [el('p',{class:'empty'},rows.length?'مفيش مستند مطابق':(mode==='inv'?'لسه ما فيش فواتير'+(canNew?' — دوس «فاتورة جديدة»':''):'لسه ما فيش مرتجعات'))]));
  }
  q.addEventListener('input',draw);
  $('#app').replaceChildren(el('div',{class:'wrap'},el('div',{class:'hello'},el('h2',{},'الفواتير'),el('button',{class:'btn ghost',type:'button',onclick:onBack},'رجوع')),
    q,sw,el('div',{class:'filters'},canNew&&el('button',{class:'btn',type:'button',onclick:()=>showInvoiceNew(user,back)},'+ فاتورة جديدة')),count,list));
  draw();
}

// ---------- ملفات المستند (PDF + صور) — مشتركة بين الفاتورة والمرتجع ونسخ التعديل القديمة ----------
function filesPanel(doc,lines){
  const files=el('div',{class:'inv-files'}),status=el('p',{class:'note'});
  const kind=doc.DocKind==='CREDIT'?'إشعار مرتجع':'فاتورة';
  let urls=[];
  const dl=(blob,name)=>{const u=URL.createObjectURL(blob),a=el('a',{href:u,download:name});document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),4000)};
  const share=async(blobs,names,type)=>{
    const fs=blobs.map((b,i)=>new File([b],names[i],{type}));
    if(navigator.canShare?.({files:fs})){try{await navigator.share({files:fs,title:kind+' '+doc.Number,text:kind+' '+doc.Number+' — العراقي'});return}catch(e){if(e.name==='AbortError')return}}
    blobs.forEach((b,i)=>dl(b,names[i]));toast('المشاركة المباشرة مش مدعومة هنا — اتحمّل الملف على الجهاز');
  };
  async function generate(){
    status.textContent='بنجهّز الملف…';files.replaceChildren();urls.forEach(u=>URL.revokeObjectURL(u));urls=[];
    try{
      const f=await buildInvoiceFiles(doc,lines),pn=doc.Number+'.pdf',inames=f.images.map((_,i)=>`${doc.Number}-${i+1}.jpg`);
      urls=f.images.map(b=>URL.createObjectURL(b));const pdfUrl=URL.createObjectURL(f.pdf);urls.push(pdfUrl);
      status.textContent=`الملف جاهز — ${f.pages} صفحة`;
      files.replaceChildren(el('div',{class:'btnrow'},
        el('button',{class:'btn',type:'button',onclick:()=>dl(f.pdf,pn)},'⬇ تحميل PDF'),
        el('button',{class:'btn',type:'button',onclick:()=>share([f.pdf],[pn],'application/pdf')},'📤 مشاركة PDF'),
        el('button',{class:'btn ghost',type:'button',onclick:()=>share(f.images,inames,'image/jpeg')},'🖼 مشاركة كصور'),
        el('button',{class:'btn ghost',type:'button',onclick:()=>window.open(pdfUrl,'_blank')},'🖨 فتح للطباعة')),
        el('div',{class:'inv-pages'},...urls.slice(0,f.images.length).map((u,i)=>el('img',{src:u,alt:`صفحة ${i+1}`}))));
    }catch(e){status.textContent='تعذر تجهيز الملف: '+(e.message||'');files.replaceChildren(el('button',{class:'btn ghost',type:'button',onclick:generate},'إعادة المحاولة'))}
  }
  return {nodes:[status,files],generate};
}
const errMsg=(e,fallback)=>typeof e?.code==='string'?e.message:fallback;

// ---------- عرض فاتورة + ملفاتها + (تعديل / مرتجع / إلغاء) ----------
export async function showInvoiceView(user,invoiceId,onBack,{fresh=false}={}){
  const inv=await get('invoices',invoiceId);
  if(!inv){toast('الفاتورة مش موجودة');onBack();return}
  const lines=await liveLines(invoiceId);
  const wh=(await all('warehouses')).find(w=>w.WarehouseID===inv.WarehouseID);
  const cns=(await byIndex('credit_notes','ParentInvoiceID',invoiceId)).sort((a,b)=>a.DateTime.localeCompare(b.DateTime));
  const revs=(await byIndex('invoice_revisions','InvoiceID',invoiceId)).sort((a,b)=>b.Version-a.Version);
  const [canEdit,canCancel,canReturn]=await Promise.all([can(user,'EditInvoice'),can(user,'CancelInvoice'),can(user,'CreateReturn')]);
  const isVoid=inv.Status==='VOID',hasCn=cns.length>0;
  const retLine=await returnedByLine(invoiceId),retProd=new Map();
  for(const l of lines){const r=retLine.get(l.LineID)||0;if(r)retProd.set(l.ProductID,(retProd.get(l.ProductID)||0)+r)}
  const row=(k,v)=>el('div',{class:'drow'},el('span',{},k),el('b',{dir:'auto'},v||'—'));
  const qty=l=>[l.Cartons?`${l.Cartons} كرتونة`:'',l.Pieces?`${l.Pieces} قطعة`:''].filter(Boolean).join(' + ');
  const self=()=>showInvoiceView(user,invoiceId,onBack);
  const {nodes,generate}=filesPanel(inv,lines);

  async function doVoid(){
    const reason=await askReason('إلغاء الفاتورة '+inv.Number,'الفاتورة هتفضل محفوظة بختم «ملغاة»، والأصناف هترجع للمخزن بحركات عكسية. مفيش حاجة بتتمسح.','تأكيد الإلغاء');
    if(!reason)return;
    try{await voidInvoice({invoiceId,reason,user});toast('تم إلغاء الفاتورة وعكس حركات المخزن');self()}
    catch(e){toast(errMsg(e,'تعذر الإلغاء — حاول تاني'))}
  }
  async function openReturn(){
    const ret=await returnedByLine(invoiceId);
    const st=lines.map(l=>({l,rem:l.TotalPieces-(ret.get(l.LineID)||0),c:0,p:0}));
    if(!st.some(x=>x.rem>0)){toast('كل أصناف الفاتورة اتعمل لها مرتجع');return}
    const err=el('p',{class:'err'}),sumEl=el('div',{class:'ssum'}),why=el('input',{type:'text',maxlength:'160',placeholder:'سبب المرتجع (مطلوب)','aria-label':'سبب المرتجع'});
    const go=el('button',{class:'btn',type:'button',disabled:true},'تسجيل المرتجع');
    const calc=x=>toPieces(x.c,x.p,x.l.PcsPerCarton||0);
    const refresh=()=>{let tot=0,bad=false,any=false;
      for(const x of st){const t=calc(x);if(t>x.rem)bad=true;if(t>0){any=true;tot+=r2(t*x.l.UnitPrice)}}
      sumEl.textContent=`إجمالي المرتجع: ${money(r2(tot))} ج.م`;err.textContent=bad?'في كمية أكبر من المتاح للمرتجع':'';
      go.disabled=!any||bad||why.value.trim().length<3};
    why.addEventListener('input',refresh);
    const inp=(x,key,dis)=>{const i=el('input',{type:'number',min:'0',step:'1',inputmode:'numeric',value:'0',disabled:dis,'aria-label':key==='c'?'كراتين':'قطع'});
      i.addEventListener('input',()=>{x[key]=Math.max(0,Math.floor(Number(i.value)||0));refresh()});i.addEventListener('focus',()=>i.select());return i};
    const cards=st.map(x=>x.rem<=0
      ?el('div',{class:'sline'},el('b',{},x.l.Name),el('small',{},'اتعمل له مرتجع كامل'))
      :el('div',{class:'sline'},el('div',{class:'slhead'},el('div',{},el('b',{},x.l.Name),el('span',{class:'code',dir:'ltr'},' '+x.l.Code))),
        el('small',{},`المتاح للمرتجع: ${fmt(x.rem)} قطعة × ${money(x.l.UnitPrice)} ج.م`),
        el('div',{class:'slqty'},el('label',{},'كراتين',inp(x,'c',!x.l.PcsPerCarton)),el('label',{},'قطع',inp(x,'p',false)))));
    go.addEventListener('click',async()=>{
      go.disabled=true;
      try{const r=await createCreditNote({invoiceId,items:st.filter(x=>calc(x)>0).map(x=>({lineId:x.l.LineID,cartons:x.c,pieces:x.p})),reason:why.value,user});
        close();toast('تم تسجيل المرتجع ورجوع الأصناف للمخزن');showCreditNoteView(user,r.cn.CreditNoteID,self,{fresh:true})}
      catch(e){err.textContent=errMsg(e,'تعذر الحفظ — حاول تاني');refresh()}
    });
    const close=modal('مرتجع على الفاتورة '+inv.Number,el('p',{class:'note'},`الأصناف هترجع لمخزن الفاتورة الأصلي (${wh?.Name||''}) وبنفس سعر البيع.`),
      ...cards,el('label',{class:'field'},el('span',{},'سبب المرتجع *'),why),sumEl,err,go);
  }
  function showRev(rev){
    const ls=[...rev.Snapshot.lines].sort((a,b)=>a.LineNo-b.LineNo);
    const p=filesPanel(rev.Snapshot.invoice,ls);
    modal(`نسخة ${rev.Version} (قبل التعديل)`,el('p',{class:'note'},'ده شكل الفاتورة قبل التعديل — للاطلاع بس.'),...p.nodes);p.generate();
  }

  const acts=[];
  if(!isVoid){
    if(canEdit)acts.push(el('button',{class:'btn ghost',type:'button',onclick:()=>showInvoiceNew(user,self,{edit:{inv,lines,returned:retProd}})},'✏️ تعديل الفاتورة'));
    if(canReturn)acts.push(el('button',{class:'btn ghost',type:'button',onclick:openReturn},'↩️ مرتجع'));
    if(canCancel&&!hasCn)acts.push(el('button',{class:'btn ghost danger',type:'button',onclick:doVoid},'🚫 إلغاء الفاتورة'));
  }
  $('#app').replaceChildren(el('div',{class:'wrap'},
    el('div',{class:'hello'},el('h2',{},fresh?'✅ تم حفظ الفاتورة':'فاتورة'),el('button',{class:'btn ghost',type:'button',onclick:onBack},'رجوع')),
    el('div',{class:'badges top'},isVoid&&el('span',{class:'bdg void'},'ملغاة'),inv.Version>1&&el('span',{class:'bdg edited'},'معدّلة · نسخة '+inv.Version),hasCn&&el('span',{class:'bdg cn'},'عليها مرتجع')),
    isVoid&&el('div',{class:'voidbox'},el('b',{},'فاتورة ملغاة'),row('تاريخ الإلغاء',fdt(inv.VoidedAt)),row('ألغاها',inv.VoidedByName),row('سبب الإلغاء',inv.VoidReason)),
    row('رقم الفاتورة',inv.Number),row('التاريخ',fdt(inv.DateTime)),row('العميل',inv.CustomerName),row('الهاتف',inv.CustomerPhone),
    row('المخزن',wh?.Name),row('الموظف',inv.UserName),row('الإجمالي',money(inv.Total)+' ج.م'),inv.Notes&&row('ملاحظة',inv.Notes),
    acts.length>0&&el('div',{class:'btnrow act'},...acts),
    !isVoid&&hasCn&&canCancel&&el('p',{class:'note'},'إلغاء الفاتورة ممنوع لأن عليها مرتجع. التعديل مسموح بشرط إن الكمية لكل صنف ما تقلّش عن اللي اترجّع منه.'),
    el('h3',{class:'sec'},'الأصناف'),
    ...lines.map(l=>el('div',{class:'drow'},el('span',{},`${l.Name} · ${l.Code} — ${qty(l)}`),
      el('b',{},`${money(l.UnitPrice)} × ${fmt(l.TotalPieces)} = ${money(l.LineTotal)}`+(l.PriceChanged?` (السعر الأصلي ${money(l.OriginalUnitPrice)})`:'')))),
    hasCn&&el('h3',{class:'sec'},'المرتجعات'),
    ...cns.map(c=>el('div',{class:'drow'},el('span',{dir:'ltr'},c.Number),el('b',{},money(c.Total)+' ج.م'),
      el('button',{class:'btn ghost',type:'button',onclick:()=>showCreditNoteView(user,c.CreditNoteID,self)},'عرض'))),
    revs.length>0&&el('h3',{class:'sec'},'سجل النسخ السابقة'),
    ...revs.map(r=>el('div',{class:'drow'},el('span',{},`نسخة ${r.Version} — ${fdt(r.ReplacedAt)}`,el('small',{},`${r.UserName||''} · ${r.Reason||''}`)),
      el('button',{class:'btn ghost',type:'button',onclick:()=>showRev(r)},'عرض'))),
    el('h3',{class:'sec'},'ملف الفاتورة (A4)'),...nodes,
    fresh&&el('button',{class:'btn ghost wide',type:'button',onclick:()=>showInvoiceNew(user,onBack)},'+ فاتورة جديدة')));
  generate();
}

// ---------- عرض إشعار مرتجع ----------
export async function showCreditNoteView(user,cnId,onBack,{fresh=false}={}){
  const cn=await get('credit_notes',cnId);
  if(!cn){toast('المرتجع مش موجود');onBack();return}
  const lines=(await byIndex('credit_note_lines','CreditNoteID',cnId)).sort((a,b)=>a.LineNo-b.LineNo);
  const wh=(await all('warehouses')).find(w=>w.WarehouseID===cn.WarehouseID);
  const doc={...cn,DocKind:'CREDIT'};
  const row=(k,v)=>el('div',{class:'drow'},el('span',{},k),el('b',{dir:'auto'},v||'—'));
  const qty=l=>[l.Cartons?`${l.Cartons} كرتونة`:'',l.Pieces?`${l.Pieces} قطعة`:''].filter(Boolean).join(' + ');
  const {nodes,generate}=filesPanel(doc,lines);
  $('#app').replaceChildren(el('div',{class:'wrap'},
    el('div',{class:'hello'},el('h2',{},fresh?'✅ تم تسجيل المرتجع':'إشعار مرتجع'),el('button',{class:'btn ghost',type:'button',onclick:onBack},'رجوع')),
    row('رقم المرتجع',cn.Number),row('عن الفاتورة',cn.ParentNumber),row('التاريخ',fdt(cn.DateTime)),row('العميل',cn.CustomerName),row('الهاتف',cn.CustomerPhone),
    row('رجع لمخزن',wh?.Name),row('الموظف',cn.UserName),row('إجمالي المرتجع',money(cn.Total)+' ج.م'),row('السبب',cn.Reason),
    el('div',{class:'btnrow act'},el('button',{class:'btn ghost',type:'button',onclick:()=>showInvoiceView(user,cn.ParentInvoiceID,()=>showCreditNoteView(user,cnId,onBack))},'فتح الفاتورة الأصلية')),
    el('h3',{class:'sec'},'الأصناف المرتجعة'),
    ...lines.map(l=>el('div',{class:'drow'},el('span',{},`${l.Name} · ${l.Code} — ${qty(l)}`),el('b',{},`${money(l.UnitPrice)} × ${fmt(l.TotalPieces)} = ${money(l.LineTotal)}`))),
    el('h3',{class:'sec'},'ملف المرتجع (A4)'),...nodes));
  generate();
}
