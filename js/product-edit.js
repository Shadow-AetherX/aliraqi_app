// تعديل الصنف والسعر (v12): الاسم + الكود (هو نفسه محتوى الباركود/QR) + التكلفة + سعر القطعة الافتراضي.
// الصلاحيات (بتتفحص من القاعدة وقت الحفظ مش بس في الشاشة): EditProducts = الاسم والكود · EditProducts+ViewCost = التكلفة · ChangeDefaultPrice = سعر القطعة.
// الحفظ = الصنف + طابور المزامنة + سجل العمليات في معاملة واحدة. الكود ما يتكررش مع أي صنف تاني (بنفس تطبيع البحث: 0202 = 02-02).
// الفواتير القديمة مش بتتأثر: كل سطر فاتورة محفوظ فيه سعره واسمه وكوده وقت البيع.
import {get,txRun,uuid,nowISO,deviceId} from './db.js';
import {can} from './auth.js';
import {compact} from './products.js';
import {el,toast,fmt,modal} from './ui.js';

const E=(msg,code,extra)=>Object.assign(new Error(msg),{code},extra);
const r2=n=>Math.round((Number(n)+Number.EPSILON)*100)/100;
const num=s=>{s=String(s??'').trim().replace(/[٠-٩]/g,d=>'٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/٫/g,'.').replace(/,/g,'');return s===''?null:Number(s)};
const pick=(o,ks)=>Object.fromEntries(ks.map(k=>[k,o[k]??null]));

// changes: أي مجموعة من {Name,Code,Cost,PricePiece}. بيرجّع {rec,diff} أو بيرمي خطأ بـ code نصي (رسالته عربي وجاهزة للعرض).
export async function saveProduct({user,productId,changes}){
  const u=await get('users',user?.UserID);                                    // نعيد قراءة المستخدم من القاعدة مش من الجلسة
  if(!u||!u.Active)throw E('المستخدم غير متاح','FORBIDDEN');
  const [cEdit,cPrice,cCost]=await Promise.all([can(u,'EditProducts'),can(u,'ChangeDefaultPrice'),can(u,'ViewCost')]);
  const has=k=>Object.prototype.hasOwnProperty.call(changes,k);
  if((has('Name')||has('Code'))&&!cEdit)throw E('مفيش صلاحية تعديل بيانات الصنف','FORBIDDEN');
  if(has('Cost')&&!(cEdit&&cCost))throw E('مفيش صلاحية تعديل التكلفة','FORBIDDEN');
  if(has('PricePiece')&&!cPrice)throw E('مفيش صلاحية تغيير السعر الافتراضي','FORBIDDEN');
  const ch={};
  if(has('Name')){const n=String(changes.Name??'').trim();if(n.length<2||n.length>120)throw E('اسم الصنف لازم يبقى من 2 لـ 120 حرف','BAD_NAME');ch.Name=n}
  if(has('Code')){const c=String(changes.Code??'').trim();if(!c||c.length>40||!compact(c))throw E('الكود/الباركود مطلوب (لحد 40 حرف)','BAD_CODE');ch.Code=c}
  if(has('Cost')){const c=changes.Cost;if(c!==null&&(!Number.isFinite(c)||c<0))throw E('التكلفة لازم تبقى رقم صفر أو أكبر','BAD_COST');ch.Cost=c===null?null:r2(c)}
  if(has('PricePiece')){const p=changes.PricePiece;if(p!==null&&(!Number.isFinite(p)||p<=0))throw E('سعر القطعة لازم يبقى رقم أكبر من صفر','BAD_PRICE');ch.PricePiece=p===null?null:r2(p)}
  if(!Object.keys(ch).length)throw E('مفيش أي تغيير','NO_CHANGE');
  const now=nowISO(),dev=deviceId();
  return txRun(['products','syncq','audit'],(t,fail,setOut)=>{
    const ps=t.objectStore('products');
    ps.get(productId).onsuccess=e=>{
      const old=e.target.result;
      if(!old)return fail(E('الصنف مش موجود','NOT_FOUND'));
      ps.getAll().onsuccess=e2=>{
        if(ch.Code!==undefined&&ch.Code!==old.Code){                           // الفحص جوه المعاملة نفسها على كل الأصناف (النشط والموقوف)
          const k=compact(ch.Code),dup=e2.target.result.find(p=>p.ProductID!==productId&&compact(p.Code)===k);
          if(dup)return fail(E(`الكود ده مستخدم في صنف تاني: «${dup.Name||'(بدون اسم)'}» (${dup.Code})`,'DUP_CODE',{other:dup.ProductID}));
        }
        const diff={};for(const k of Object.keys(ch))if((old[k]??null)!==ch[k])diff[k]=ch[k];
        if(!Object.keys(diff).length)return fail(E('مفيش أي تغيير','NO_CHANGE'));
        const rec={...old,...diff,UpdatedAt:now,UpdatedBy:u.UserID,SyncStatus:'PENDING'};
        if('PricePiece' in diff)                                               // سعر الكرتونة بيتحسب من سعر القطعة (نفس العلاقة الموجودة في كل الأصناف)
          rec.PriceCarton=diff.PricePiece==null?null:(old.PcsPerCarton?r2(diff.PricePiece*old.PcsPerCarton):(old.PriceCarton??null));
        ps.put(rec);
        t.objectStore('syncq').put({OpID:uuid(),Entity:'products',EntityID:rec.ProductID,Status:'PENDING',CreatedAt:now,Tries:0});
        const au=(action,oldV,newV)=>t.objectStore('audit').put({AuditID:uuid(),UserID:u.UserID,UserName:u.Name,Action:action,EntityType:'Product',EntityID:rec.ProductID,
          DateTime:now,DeviceID:dev,OldValue:JSON.stringify(oldV),NewValue:JSON.stringify(newV),Notes:'',SyncStatus:'PENDING'});
        const dk=['Name','Code','Cost'].filter(k=>k in diff);
        if(dk.length)au('PRODUCT_EDIT',{...pick(old,dk),product:`${old.Code} — ${old.Name}`},{...pick(rec,dk),product:`${rec.Code} — ${rec.Name}`});
        if('PricePiece' in diff)au('PRODUCT_PRICE_CHANGE',{...pick(old,['PricePiece','PriceCarton']),product:`${old.Code} — ${old.Name}`},{...pick(rec,['PricePiece','PriceCarton']),product:`${rec.Code} — ${rec.Name}`});
        setOut({rec,diff});
      };
    };
  });
}

// نافذة التعديل. الحقول اللي مالكش صلاحيتها بتظهر مقفولة (والتكلفة مخفية لو مفيش ViewCost).
export async function productForm({user,product,onSaved}){
  const [cEdit,cPrice,cCost]=await Promise.all([can(user,'EditProducts'),can(user,'ChangeDefaultPrice'),can(user,'ViewCost')]);
  if(!cEdit&&!cPrice){toast('مفيش صلاحية تعديل الأصناف');return}
  const p=await get('products',product.ProductID)||product;                    // أحدث نسخة من القاعدة
  const name=el('input',{type:'text',maxlength:'120',value:p.Name||'',disabled:!cEdit,placeholder:'اسم الصنف *','aria-label':'اسم الصنف'});
  const code=el('input',{type:'text',maxlength:'40',dir:'ltr',value:p.Code||'',disabled:!cEdit,placeholder:'الكود / الباركود *','aria-label':'الكود'});
  const cost=cCost?el('input',{type:'text',inputmode:'decimal',dir:'ltr',value:p.Cost!=null?String(p.Cost):'',disabled:!cEdit,placeholder:'التكلفة (اختياري)','aria-label':'التكلفة'}):null;
  const price=el('input',{type:'text',inputmode:'decimal',dir:'ltr',value:p.PricePiece!=null?String(p.PricePiece):'',disabled:!cPrice,placeholder:'سعر القطعة الافتراضي (فاضي = بانتظار التسعير)','aria-label':'سعر القطعة'});
  const info=el('p',{class:'note'}),err=el('p',{class:'err'});
  const field=(l,i)=>el('label',{class:'field'},el('span',{},l),i);
  const upd=()=>{
    const pr=num(price.value),c=cost?num(cost.value):null,parts=[];
    parts.push(pr>0&&p.PcsPerCarton?`سعر الكرتونة (${fmt(p.PcsPerCarton)} قطعة): ${fmt(r2(pr*p.PcsPerCarton))} ج.م — بيتحسب تلقائي`:'سعر الكرتونة: —');
    if(cost&&pr>0&&c>0)parts.push(`هامش الربح: ${(((pr-c)/pr)*100).toFixed(1)}%`);
    info.textContent=parts.join(' · ');
  };
  price.addEventListener('input',upd);cost?.addEventListener('input',upd);upd();
  const save=async()=>{
    err.textContent='';const changes={};
    if(cEdit){
      if(name.value.trim()!==(p.Name||''))changes.Name=name.value;
      if(code.value.trim()!==(p.Code||''))changes.Code=code.value;
      if(cost){const c=num(cost.value);if(Number.isNaN(c)){err.textContent='التكلفة لازم تبقى رقم';return}if(c!==(p.Cost??null))changes.Cost=c}
    }
    if(cPrice){const pr=num(price.value);if(Number.isNaN(pr)){err.textContent='سعر القطعة لازم يبقى رقم';return}if(pr!==(p.PricePiece??null))changes.PricePiece=pr}
    if(!Object.keys(changes).length){err.textContent='مفيش أي تغيير';return}
    if('Code' in changes&&!window.confirm('تغيير الكود/الباركود: الملصقات وأكواد QR المطبوعة بالكود القديم مش هتتعرف في المسح بعد كده. تكمّل؟'))return;
    btn.disabled=true;
    try{const r=await saveProduct({user,productId:p.ProductID,changes});close();toast('تم حفظ التعديل');onSaved?.(r.rec)}
    catch(e){btn.disabled=false;err.textContent=typeof e.code==='string'?e.message:'تعذر الحفظ على الجهاز. حاول تاني.'}
  };
  const btn=el('button',{class:'btn',type:'button',onclick:save},'حفظ');
  const close=modal('تعديل الصنف',field('الاسم *',name),field('الكود / الباركود *',code),cost&&field('التكلفة (ج.م)',cost),field('سعر القطعة الافتراضي (ج.م)',price),info,
    !cEdit&&el('p',{class:'note'},'مفيش معاك صلاحية تعديل بيانات الصنف — تقدر تغيّر السعر بس.'),
    !cPrice&&el('p',{class:'note'},'مفيش معاك صلاحية تغيير السعر الافتراضي.'),
    el('p',{class:'note'},'الفواتير القديمة بتفضل بأسعارها وأسمائها وقت البيع. كل تعديل بيتسجل في سجل العمليات وبيتزامن.'),err,btn);
  (cEdit?name:price).focus();
}
