// إضافة صنف جديد + إيقاف/تفعيل صنف (v17، v20: الحد الأدنى لإعادة الطلب + روابط الصور). مفيش مسح نهائي أبداً: الصنف الموقوف بيختفي من القوائم وبيتفعّل تاني، وفواتيره وحركاته محفوظة.
// الصلاحيات (بتتفحص من القاعدة وقت الحفظ): EditProducts = إضافة/إيقاف · ChangeDefaultPrice = سعر القطعة · EditProducts+ViewCost = التكلفة · StockIn = الرصيد الافتتاحي.
// الصنف الجديد = الصنف + طابور المزامنة + سجل العمليات (+ عدّاد الكود التلقائي) في معاملة واحدة. الرصيد الافتتاحي (اختياري) بيتسجّل كمستند استلام عادي بعدها.
// الكود: لو سبته فاضي بيتولّد كود فريد (NEW…) — وهو نفسه محتوى الـQR، وبعد الحفظ بيتفتح ملصق الـQR جاهز للطباعة.
import {all,get,txRun,uuid,nowISO,deviceId,postStockDoc,stockOf} from './db.js';
import {can} from './auth.js';
import {compact} from './products.js';
import {el,toast,fmt,modal,askReason} from './ui.js';

const E=(msg,code,extra)=>Object.assign(new Error(msg),{code},extra);
const r2=n=>Math.round((Number(n)+Number.EPSILON)*100)/100;
const num=s=>{s=String(s??'').trim().replace(/[٠-٩]/g,d=>'٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/٫/g,'.').replace(/,/g,'');return s===''?null:Number(s)};
export const MAX_REORDER=10000000,MAX_IMAGES=10;
// الحد الأدنى لإعادة الطلب: null (مفيش حد) أو عدد صحيح 0 أو أكتر (بالقطعة). بيرمي خطأ BAD_REORDER لو غير صالح.
export function cleanReorder(v){
  if(v==null)return null;
  if(!Number.isInteger(v)||v<0||v>MAX_REORDER)throw E('الحد الأدنى لإعادة الطلب لازم يبقى عدد صحيح صفر أو أكبر (بالقطعة)','BAD_REORDER');
  return v;
}
// روابط الصور: مصفوفة (أو null) → مصفوفة روابط https سليمة بدون تكرار (حد أقصى 10، كل رابط لحد 500 حرف). أي رابط غير صالح = خطأ BAD_IMAGE (مفيش تجاهل صامت).
export function cleanImages(v){
  if(v==null)return[];
  if(!Array.isArray(v))throw E('الصور لازم تبقى قايمة روابط','BAD_IMAGE');
  const out=[];
  for(const x of v){
    const s=String(x??'').trim();if(!s)continue;
    let u;try{u=new URL(s)}catch{throw E(`رابط الصورة غير صالح: ${s.slice(0,60)}`,'BAD_IMAGE')}
    if(u.protocol!=='https:'||s.length>500)throw E(`رابط الصورة لازم يبدأ بـ https وأقل من 500 حرف: ${s.slice(0,60)}`,'BAD_IMAGE');
    if(!out.includes(s))out.push(s);
  }
  if(out.length>MAX_IMAGES)throw E(`أقصى عدد للصور ${MAX_IMAGES} لكل صنف`,'BAD_IMAGE');
  return out;
}

export async function createProduct({user,data}){
  const u=await get('users',user?.UserID);                                    // نعيد قراءة المستخدم من القاعدة مش من الجلسة
  if(!u||!u.Active)throw E('المستخدم غير متاح','FORBIDDEN');
  const [cEdit,cPrice,cCost]=await Promise.all([can(u,'EditProducts'),can(u,'ChangeDefaultPrice'),can(u,'ViewCost')]);
  if(!cEdit)throw E('مفيش صلاحية إضافة أصناف','FORBIDDEN');
  const d=data||{};
  const name=String(d.Name??'').trim();if(name.length<2||name.length>120)throw E('اسم الصنف لازم يبقى من 2 لـ 120 حرف','BAD_NAME');
  const code=String(d.Code??'').trim();if(code&&(code.length>40||!compact(code)))throw E('الكود لازم يبقى لحد 40 حرف (أو سيبه فاضي ويتولّد لوحده)','BAD_CODE');
  const ppc=d.PcsPerCarton??null;if(ppc!==null&&(!Number.isInteger(ppc)||ppc<1||ppc>100000))throw E('عدد القطع في الكرتونة لازم عدد صحيح 1 أو أكتر','BAD_PCS');
  const reorder=cleanReorder(d.ReorderLevel??null),images=cleanImages(d.Images);
  const cost=d.Cost??null;if(cost!==null){if(!cCost)throw E('مفيش صلاحية تحديد التكلفة','FORBIDDEN');if(!Number.isFinite(cost)||cost<0)throw E('التكلفة لازم تبقى رقم صفر أو أكبر','BAD_COST')}
  const price=d.PricePiece??null;if(price!==null){if(!cPrice)throw E('مفيش صلاحية تحديد السعر','FORBIDDEN');if(!Number.isFinite(price)||price<=0)throw E('سعر القطعة لازم يبقى رقم أكبر من صفر','BAD_PRICE')}
  const category=String(d.Category??'').trim().slice(0,40),desc=String(d.Description??'').trim().slice(0,300);
  const now=nowISO(),dev=deviceId();
  return txRun(['products','syncq','audit','settings'],(t,fail,setOut)=>{
    const ps=t.objectStore('products'),st=t.objectStore('settings');
    ps.getAll().onsuccess=e=>{
      const prods=e.target.result,taken=new Set(prods.filter(p=>!p.Deleted).map(p=>compact(p.Code)));          // الأصناف المحذوفة كودها متاح تاني
      const build=finalCode=>{
        const rec={ProductID:'LP-'+uuid().replace(/-/g,'').slice(0,10).toUpperCase(),Code:finalCode,Name:name,Category:category,Description:desc,PcsPerCarton:ppc,
          PricePiece:price===null?null:r2(price),PriceCarton:price!==null&&ppc?r2(price*ppc):null,Cost:cost===null?null:r2(cost),Available:true,Active:true,Images:images,ReorderLevel:reorder,
          SourceRow:prods.reduce((m,p)=>Math.max(m,Number(p.SourceRow)||0),0)+1,ReviewFlag:'',Origin:'APP',CreatedAt:now,UpdatedAt:now,UpdatedBy:u.UserID,SyncStatus:'PENDING'};
        ps.put(rec);
        t.objectStore('syncq').put({OpID:uuid(),Entity:'products',EntityID:rec.ProductID,Status:'PENDING',CreatedAt:now,Tries:0});
        t.objectStore('audit').put({AuditID:uuid(),UserID:u.UserID,UserName:u.Name,Action:'PRODUCT_CREATE',EntityType:'Product',EntityID:rec.ProductID,DateTime:now,DeviceID:dev,OldValue:null,
          NewValue:JSON.stringify({Code:rec.Code,Name:rec.Name,Category:rec.Category,PcsPerCarton:rec.PcsPerCarton,PricePiece:rec.PricePiece,Cost:rec.Cost,ReorderLevel:rec.ReorderLevel,Images:rec.Images.length}),Notes:'',SyncStatus:'PENDING'});
        setOut({rec});
      };
      if(code){
        const dup=prods.find(p=>!p.Deleted&&compact(p.Code)===compact(code));      // الفحص جوه المعاملة على كل الأصناف (النشط والموقوف — مش المحذوف)
        if(dup)return fail(E(`الكود ده مستخدم في صنف تاني: «${dup.Name||'(بدون اسم)'}» (${dup.Code})`,'DUP_CODE',{other:dup.ProductID}));
        build(code);
      }else{
        const key=`prodseq:${dev}`;
        st.get(key).onsuccess=e2=>{let n=e2.target.result?.value||0,c;do{n++;c=`NEW${dev.replace(/^D-/,'')}${String(n).padStart(4,'0')}`}while(taken.has(compact(c)));
          st.put({key,value:n});build(c)};
      }
    };
  });
}

export async function setProductActive({user,productId,active}){
  const u=await get('users',user?.UserID);
  if(!u||!u.Active||!await can(u,'EditProducts'))throw E('مفيش صلاحية إيقاف/تفعيل الأصناف','FORBIDDEN');
  const now=nowISO(),dev=deviceId();
  return txRun(['products','syncq','audit'],(t,fail,setOut)=>{
    const ps=t.objectStore('products');
    ps.get(productId).onsuccess=e=>{
      const old=e.target.result;if(!old)return fail(E('الصنف مش موجود','NOT_FOUND'));
      if(old.Deleted)return fail(E('الصنف ده محذوف — استرجعه الأول','DELETED'));
      if((old.Active!==false)===active)return fail(E(active?'الصنف نشط بالفعل':'الصنف موقوف بالفعل','NO_CHANGE'));
      const rec={...old,Active:active,UpdatedAt:now,UpdatedBy:u.UserID,SyncStatus:'PENDING'};ps.put(rec);
      t.objectStore('syncq').put({OpID:uuid(),Entity:'products',EntityID:rec.ProductID,Status:'PENDING',CreatedAt:now,Tries:0});
      t.objectStore('audit').put({AuditID:uuid(),UserID:u.UserID,UserName:u.Name,Action:active?'PRODUCT_ACTIVATE':'PRODUCT_DEACTIVATE',EntityType:'Product',EntityID:rec.ProductID,DateTime:now,DeviceID:dev,
        OldValue:JSON.stringify({Active:old.Active!==false,product:`${old.Code} — ${old.Name}`}),NewValue:JSON.stringify({Active:active,product:`${rec.Code} — ${rec.Name}`}),Notes:'',SyncStatus:'PENDING'});
      setOut({rec});
    };
  });
}

export async function toggleActive({user,product,onDone}){
  const to=product.Active===false;                                           // true = هنفعّله
  let msg;
  if(to)msg=`تفعيل «${product.Name}»؟ هيظهر تاني في القوائم والفواتير.`;
  else{const bal=await stockOf(product.ProductID).catch(()=>0);
    msg=`إيقاف «${product.Name}»؟ هيختفي من القوائم والفواتير (بياناته وحركاته وفواتيره القديمة محفوظة وتقدر تفعّله تاني).`+(bal?`\n\nتنبيه: لسه ليه رصيد ${fmt(bal)} قطعة — صفّره بالجرد أو الصرف الأول لو عايز.`:'')}
  if(!window.confirm(msg))return;
  try{const r=await setProductActive({user,productId:product.ProductID,active:to});toast(to?'تم تفعيل الصنف':'تم إيقاف الصنف');onDone?.(r.rec)}
  catch(e){toast(typeof e.code==='string'?e.message:'تعذر التنفيذ — حاول تاني')}
}

// حذف الصنف = أرشفة: بيتشال من كل القوائم والفواتير والمسح وكوده بيتحرّر لصنف جديد، لكن السجل نفسه بيفضل (Deleted=true) فالفواتير والحركات والتقارير القديمة بتفضل بتعرض اسمه وكوده.
// شرط: رصيده صفر في كل المخازن (عشان ما يفضلش رصيد مخفي). مفيش مسح فعلي من القاعدة ولا من الشيت.
export async function deleteProduct({user,productId,reason}){
  const u=await get('users',user?.UserID);
  if(!u||!u.Active||!await can(u,'DeleteProducts'))throw E('مفيش صلاحية حذف الأصناف','FORBIDDEN');
  reason=String(reason||'').trim();if(reason.length<3)throw E('اكتب سبب الحذف (3 حروف على الأقل)','REASON');
  const now=nowISO(),dev=deviceId();
  return txRun(['products','movements','syncq','audit'],(t,fail,setOut)=>{
    const ps=t.objectStore('products');
    ps.get(productId).onsuccess=e=>{
      const old=e.target.result;if(!old)return fail(E('الصنف مش موجود','NOT_FOUND'));
      if(old.Deleted)return fail(E('الصنف محذوف بالفعل','NO_CHANGE'));
      t.objectStore('movements').index('ProductID').getAll(productId).onsuccess=e2=>{
        const bal={};for(const m of e2.target.result)bal[m.WarehouseID]=(bal[m.WarehouseID]||0)+m.QuantityPieces;
        const left=Object.values(bal).filter(q=>q!==0);
        if(left.length)return fail(E(`الصنف لسه ليه رصيد (${left.map(q=>fmt(q)+' قطعة').join(' / ')}) — صفّره الأول بالجرد أو الصرف أو التحويل وبعدين احذفه`,'HAS_STOCK'));
        const rec={...old,Active:false,Available:false,Deleted:true,DeletedAt:now,DeletedBy:u.UserID,DeleteReason:reason,UpdatedAt:now,UpdatedBy:u.UserID,SyncStatus:'PENDING'};ps.put(rec);
        t.objectStore('syncq').put({OpID:uuid(),Entity:'products',EntityID:rec.ProductID,Status:'PENDING',CreatedAt:now,Tries:0});
        t.objectStore('audit').put({AuditID:uuid(),UserID:u.UserID,UserName:u.Name,Action:'PRODUCT_DELETE',EntityType:'Product',EntityID:rec.ProductID,DateTime:now,DeviceID:dev,
          OldValue:JSON.stringify({product:`${old.Code} — ${old.Name}`,Active:old.Active!==false}),NewValue:JSON.stringify({product:`${old.Code} — ${old.Name}`,reason}),Notes:reason,SyncStatus:'PENDING'});
        setOut({rec});
      };
    };
  });
}
export async function restoreProduct({user,productId}){
  const u=await get('users',user?.UserID);
  if(!u||!u.Active||!await can(u,'DeleteProducts'))throw E('مفيش صلاحية استرجاع الأصناف','FORBIDDEN');
  const now=nowISO(),dev=deviceId();
  return txRun(['products','syncq','audit'],(t,fail,setOut)=>{
    const ps=t.objectStore('products');
    ps.get(productId).onsuccess=e=>{
      const old=e.target.result;if(!old)return fail(E('الصنف مش موجود','NOT_FOUND'));
      if(!old.Deleted)return fail(E('الصنف مش محذوف','NO_CHANGE'));
      ps.getAll().onsuccess=e2=>{
        const k=compact(old.Code),dup=e2.target.result.find(p=>p.ProductID!==productId&&!p.Deleted&&compact(p.Code)===k);
        if(dup)return fail(E(`الكود ${old.Code} اتاخد لصنف تاني: «${dup.Name||'(بدون اسم)'}» — غيّر كود الصنف ده الأول أو سيبه محذوف`,'DUP_CODE'));
        const rec={...old,Deleted:false,Active:true,Available:true,RestoredAt:now,UpdatedAt:now,UpdatedBy:u.UserID,SyncStatus:'PENDING'};ps.put(rec);
        t.objectStore('syncq').put({OpID:uuid(),Entity:'products',EntityID:rec.ProductID,Status:'PENDING',CreatedAt:now,Tries:0});
        t.objectStore('audit').put({AuditID:uuid(),UserID:u.UserID,UserName:u.Name,Action:'PRODUCT_RESTORE',EntityType:'Product',EntityID:rec.ProductID,DateTime:now,DeviceID:dev,
          OldValue:JSON.stringify({Deleted:true,product:`${old.Code} — ${old.Name}`}),NewValue:JSON.stringify({Deleted:false,product:`${old.Code} — ${old.Name}`}),Notes:'',SyncStatus:'PENDING'});
        setOut({rec});
      };
    };
  });
}
export async function deleteFlow({user,product,onDone}){
  const reason=await askReason('حذف الصنف',`حذف «${product.Name}» (${product.Code}): هيتشال من القوائم والفواتير والمسح، وكوده يبقى متاح لصنف جديد. فواتيره وحركاته القديمة بتفضل ظاهرة في التقارير وسجل العمليات، وتقدر ترجّعه من فلتر «المحذوفة» لو كوده لسه فاضي. لازم رصيده يبقى صفر.`,'حذف الصنف');
  if(!reason)return;
  try{const r=await deleteProduct({user,productId:product.ProductID,reason});toast('تم حذف الصنف — الكود بقى متاح');onDone?.(r.rec)}
  catch(e){toast(typeof e.code==='string'?e.message:'تعذر الحذف — حاول تاني')}
}
export async function restoreFlow({user,product,onDone}){
  if(!window.confirm(`استرجاع «${product.Name}» (${product.Code})؟`))return;
  try{const r=await restoreProduct({user,productId:product.ProductID});toast('تم استرجاع الصنف');onDone?.(r.rec)}
  catch(e){toast(typeof e.code==='string'?e.message:'تعذر الاسترجاع — حاول تاني')}
}

export async function productCreateForm({user,onSaved}){
  const [cEdit,cPrice,cCost,cIn]=await Promise.all([can(user,'EditProducts'),can(user,'ChangeDefaultPrice'),can(user,'ViewCost'),can(user,'StockIn')]);
  if(!cEdit){toast('مفيش صلاحية إضافة أصناف');return}
  const whs=(await all('warehouses')).filter(w=>w.Active!==false);
  const cats=[...new Set((await all('products')).map(p=>p.Category).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ar'));
  const inp=(o)=>el('input',{type:'text',...o});
  const name=inp({maxlength:'120',placeholder:'اسم الصنف *','aria-label':'اسم الصنف'});
  const code=inp({maxlength:'40',dir:'ltr',placeholder:'الكود / الباركود (فاضي = يتولّد تلقائي)','aria-label':'الكود'});
  const cat=inp({maxlength:'40',list:'newProdCats',placeholder:'القسم (اختياري)','aria-label':'القسم'});
  const ppc=inp({inputmode:'numeric',dir:'ltr',placeholder:'عدد القطع في الكرتونة (اختياري)','aria-label':'القطع في الكرتونة'});
  const cost=cCost?inp({inputmode:'decimal',dir:'ltr',placeholder:'التكلفة (اختياري)','aria-label':'التكلفة'}):null;
  const price=cPrice?inp({inputmode:'decimal',dir:'ltr',placeholder:'سعر القطعة (فاضي = بانتظار التسعير)','aria-label':'سعر القطعة'}):null;
  const rl=inp({inputmode:'numeric',dir:'ltr',placeholder:'الحد الأدنى لإعادة الطلب بالقطعة (اختياري)','aria-label':'الحد الأدنى لإعادة الطلب'});
  const desc=inp({maxlength:'300',placeholder:'وصف (اختياري)','aria-label':'الوصف'});
  const whSel=el('select',{'aria-label':'المخزن'},whs.map(w=>el('option',{value:w.WarehouseID},w.Name)));
  const last=localStorage.getItem('alr_last_wh');if(last&&whs.some(w=>w.WarehouseID===last))whSel.value=last;
  const oc=el('input',{type:'number',min:'0',step:'1',inputmode:'numeric',placeholder:'كراتين','aria-label':'كراتين'});
  const op=el('input',{type:'number',min:'0',step:'1',inputmode:'numeric',placeholder:'قطع','aria-label':'قطع'});
  const info=el('p',{class:'note'}),err=el('p',{class:'err'});
  const field=(l,i)=>el('label',{class:'field'},el('span',{},l),i);
  const upd=()=>{const pc=num(ppc.value),pr=price?num(price.value):null,c=cost?num(cost.value):null,parts=[];
    if(pr>0&&pc>0)parts.push(`سعر الكرتونة: ${fmt(r2(pr*pc))} ج.م — بيتحسب تلقائي`);
    if(cost&&pr>0&&c>0)parts.push(`هامش الربح: ${(((pr-c)/pr)*100).toFixed(1)}%`);info.textContent=parts.join(' · ')};
  [ppc,price,cost].forEach(i=>i?.addEventListener('input',upd));
  const save=async()=>{
    err.textContent='';
    const pc=num(ppc.value),pr=price?num(price.value):null,c=cost?num(cost.value):null;
    const rv=num(rl.value);
    if(Number.isNaN(pc)||Number.isNaN(pr)||Number.isNaN(c)||Number.isNaN(rv)){err.textContent='الأرقام لازم تبقى أرقام صحيحة';return}
    const cart=Math.max(0,Math.floor(Number(oc.value)||0)),pcs=Math.max(0,Math.floor(Number(op.value)||0));
    if(cart>0&&!pc){err.textContent='عشان تدخّل كراتين لازم تكتب عدد القطع في الكرتونة';return}
    const qty=cart*(pc||0)+pcs;if(qty>0&&!whSel.value){err.textContent='اختار المخزن للرصيد الافتتاحي';return}
    btn.disabled=true;
    try{
      const r=await createProduct({user,data:{Name:name.value,Code:code.value,Category:cat.value,Description:desc.value,PcsPerCarton:pc,PricePiece:pr,Cost:c,ReorderLevel:rv}});
      let note='';
      if(qty>0&&cIn){
        try{await postStockDoc({type:'STOCK_IN',warehouseId:whSel.value,lines:[{productId:r.rec.ProductID,qtyPieces:qty}],user,notes:'رصيد افتتاحي — صنف جديد'})}
        catch{note=' — لكن الرصيد الافتتاحي ما اتسجّلش، سجّله من «استلام مخزون»'}
      }
      close();toast('تم إضافة الصنف'+note);onSaved?.(r.rec);
      try{const m=await import('./qrlabel.js');m.openQrLabel(r.rec)}catch{toast('اتضاف الصنف — تعذر فتح ملصق الـQR، افتحه من المنتجات')}
    }catch(e){btn.disabled=false;err.textContent=typeof e.code==='string'?e.message:'تعذر الحفظ على الجهاز. حاول تاني.'}
  };
  const btn=el('button',{class:'btn',type:'button',onclick:save},'حفظ وعمل ملصق QR');
  const close=modal('صنف جديد',field('الاسم *',name),field('الكود / الباركود',code),field('القسم',cat),el('datalist',{id:'newProdCats'},cats.map(c=>el('option',{value:c}))),
    field('القطع في الكرتونة',ppc),field('الحد الأدنى لإعادة الطلب (قطعة)',rl),cost&&field('التكلفة (ج.م)',cost),price&&field('سعر القطعة (ج.م)',price),field('الوصف',desc),info,
    cIn&&whs.length?el('details',{class:'help-sec'},el('summary',{},'رصيد افتتاحي (اختياري)'),el('div',{class:'help-body'},
      el('p',{class:'note'},'لو عندك كمية جاهزة من الصنف ده دخّلها هنا وهتتسجّل كاستلام. سيبها فاضية لو هتدخّلها بعدين.'),field('المخزن',whSel),field('كراتين',oc),field('قطع',op))):null,
    el('p',{class:'note'},'الحد الأدنى: لما إجمالي رصيد الصنف (كل المخازن) يوصل له أو أقل بيظهر في «إعادة الطلب». سيبه فاضي لو مش عايز تنبيه.'),
    !cPrice&&el('p',{class:'note'},'السعر بيتحدد من المدير/المالك — الصنف هيتسجّل «بانتظار التسعير».'),
    el('p',{class:'note'},'بعد الحفظ بيتفتح ملصق الـQR جاهز للطباعة. الإضافة بتتسجّل في سجل العمليات وبتتزامن.'),err,btn);
  name.focus();
}
