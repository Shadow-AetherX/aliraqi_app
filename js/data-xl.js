// استيراد وتصدير Excel (v20: + عمود «الحد الأدنى» وعمود «الصور» بروابط https) — شاشة «Excel»: تصدير المخزون كله، قالب استيراد فاضي، واستيراد أصناف وكميات من ملف .xlsx أو .csv أو من Google Sheet مباشرة.
// v23: (1) ربط شيت جوجل مباشر (رابط مشاركة «أي حد معاه الرابط» أو «نشر على الويب») + زرار تحديث من نفس الشيت · (2) شاشة معاينة فروقات بتبويبات: جديد / متغيّر (القديم ← الجديد بالسعر والكمية) / غير مكتمل / بدون تغيير / أخطاء
// (3) تأكيد نهائي بملخص قبل أي كتابة + لقطة بالقيم القديمة (xl_last_import) · (4) إصلاح: صنف جديد فيه سعر/تكلفة بمستخدم من غير الصلاحية بقى بيتجاهلهم في المعاينة بدل ما يفشل وقت التنفيذ.
// قواعد الأمان (نفس باقي التطبيق): الاستيراد بيمر على نفس دوال الحفظ (createProduct / saveProduct / postStockDoc / postAdjustment) فكل الصلاحيات والتحقق ومنع تكرار الكود وسجل العمليات والمزامنة (لشيت المزامنة المركزي) بتنطبق.
// الاستيراد عمره ما بيمسح: أي صنف في النظام ومش في الملف بيفضل زي ما هو. المخزون عمره ما بيتكتب كرقم رصيد: الكمية بتتسجّل كمستند استلام (يضيف) أو تسوية جرد (بفروق) — ودايماً بمعاينة قبل التنفيذ.
// الأعمدة بتتعرف بالاسم (عربي/إنجليزي). الأعمدة «رصيد: اسم المخزن» (اللي بيطلعها التصدير) بتحدد كمية كل مخزن، فملف التصدير نفسه ينفع يتعدّل ويتستورد تاني.
import {all,stockMap,postStockDoc,audit,deviceId,nowISO,ymd,put,get as dbGet,pickWarehouse} from './db.js';
import {can} from './auth.js';
import {norm,compact} from './products.js';
import {createProduct,cleanImages} from './product-new.js';
import {saveProduct} from './product-edit.js';
import {postAdjustment} from './adjust.js';
import {$,el,toast,fmt,modal} from './ui.js';
import {writeXlsx,readTableFile,parseCsv} from './xlsx-lite.js';

const get=async(s,k)=>{const v=await dbGet(s,k);return(typeof IDBRequest!=='undefined'&&v instanceof IDBRequest)?undefined:v};   // db.get القديمة كانت بترجّع IDBRequest لمفتاح مش موجود
const MAX_BYTES=8*1024*1024,MAX_ROWS=3000;
const r2=n=>Math.round((Number(n)+Number.EPSILON)*100)/100;
const toNum=v=>{if(typeof v==='number')return v;let s=String(v??'').trim().replace(/[٠-٩]/g,d=>'٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/٫/g,'.').replace(/[,٬\s]/g,'');return s===''?null:Number(s)};
const str=v=>v==null?'':String(v).trim();
// خلية الصور: روابط مفصولة بسطر جديد أو | أو مسافة أو فاصلة/فاصلة منقوطة قبل https
const splitImages=s=>String(s??'').replace(/[,;،]\s*(?=https?:)/gi,' ').split(/[\s|]+/).filter(Boolean);
const H={
  code:['الكود','كود','كود الصنف','code','sku','barcode','باركود'],
  name:['الاسم','اسم الصنف','الصنف','اسم','name','product','item','product name'],
  category:['القسم','الفئة','التصنيف','category'],
  ppc:['القطع في الكرتونة','عدد القطع في الكرتونة','قطع في الكرتونة','قطع/كرتونة','pcspercarton','pcs per carton','pieces per carton'],
  price:['سعر القطعة','سعر البيع','سعر','price','piece price','pricepiece'],
  cost:['التكلفة','سعر الشراء','تكلفة','cost'],
  qty:['الرصيد','الكمية','الرصيد (قطعة)','الكمية (قطعة)','الرصيد بالقطعة','qty','quantity','stock','balance'],
  cartons:['كراتين','عدد الكراتين','cartons','ctn'],
  loose:['قطع','قطع سايبة','pieces'],
  reorder:['الحد الأدنى','الحد الادنى','الحد الأدنى لإعادة الطلب','حد إعادة الطلب','حد الطلب','reorderlevel','reorder level','reorder','min','min stock','minimum'],
  images:['الصور','الصورة','صور','صورة','روابط الصور','رابط الصورة','رابط الصور','images','image','image url','image urls','photos','photo']
};
const HN=Object.fromEntries(Object.entries(H).map(([k,v])=>[k,new Set(v.map(norm))]));
const colKey=h=>{const n=norm(h);for(const k of Object.keys(HN))if(HN[k].has(n))return k;return null};

function saveBlob(blob,name){
  return (async()=>{
    const file=new File([blob],name,{type:blob.type});
    if(navigator.canShare?.({files:[file]})){try{await navigator.share({files:[file],title:name});return}catch(e){if(e.name==='AbortError')return}}
    const u=URL.createObjectURL(blob),a=el('a',{href:u,download:name});document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),4000);
  })();
}
const stamp=()=>{const d=new Date(),p=n=>String(n).padStart(2,'0');return ymd(d)+'-'+p(d.getHours())+p(d.getMinutes())};

// ---------------- التصدير ----------------
export async function exportStock(user){
  if(!await can(user,'ViewStock'))throw new Error('مفيش صلاحية عرض المخزون');
  const canCost=await can(user,'ViewCost');
  const prods=(await all('products')).filter(p=>!p.Deleted&&p.Active!==false).sort((a,b)=>(a.SourceRow??1e9)-(b.SourceRow??1e9));
  const whs=(await all('warehouses')).filter(w=>w.Active!==false),sm=await stockMap();
  const head=['الكود','الاسم','القسم','القطع في الكرتونة','الحد الأدنى',...whs.map(w=>'رصيد: '+w.Name),'الإجمالي (قطعة)','كراتين كاملة','قطع زيادة','سعر القطعة','سعر الكرتونة',...(canCost?['التكلفة','قيمة المخزون بالتكلفة']:[]),'الصور'];
  let inStock=0,zero=0,pieces=0,value=0;
  const rows=prods.map(p=>{
    const o=sm.get(p.ProductID)||{},per=whs.map(w=>o[w.WarehouseID]||0),tot=per.reduce((s,x)=>s+x,0),k=p.PcsPerCarton;
    tot>0?inStock++:tot===0&&zero++;pieces+=Math.max(0,tot);
    const val=canCost&&typeof p.Cost==='number'?Math.max(0,tot)*p.Cost:null;if(val)value+=val;
    return[String(p.Code??''),p.Name||'',p.Category||'',k!=null?{v:k,s:'int'}:null,Number.isFinite(p.ReorderLevel)?{v:p.ReorderLevel,s:'int'}:null,...per.map(q=>({v:q,s:'int'})),{v:tot,s:'int'},
      k&&tot>=k?{v:Math.floor(tot/k),s:'int'}:null,k?(tot>=0?{v:tot%k,s:'int'}:null):{v:tot,s:'int'},
      p.PricePiece!=null?{v:p.PricePiece,s:'money'}:null,p.PriceCarton!=null?{v:p.PriceCarton,s:'money'}:null,
      ...(canCost?[typeof p.Cost==='number'?{v:p.Cost,s:'money'}:null,val!=null?{v:r2(val),s:'money'}:null]:[]),
      (p.Images||[]).length?(p.Images||[]).join(' | '):null];
  });
  const widths=[16,34,16,12,12,...whs.map(()=>14),14,12,12,12,12,...(canCost?[12,16]:[]),50];
  const sum=[['تاريخ التصدير',new Date().toLocaleString('en-GB')],['المستخدم',user.Name],['عدد الأصناف',{v:prods.length,s:'int'}],['أصناف ليها رصيد',{v:inStock,s:'int'}],['أصناف رصيدها صفر',{v:zero,s:'int'}],['إجمالي القطع (الموجب)',{v:pieces,s:'int'}],
    ...(canCost?[['قيمة المخزون بالتكلفة (ج.م)',{v:r2(value),s:'money'}]]:[]),
    ['ملاحظة','لتعديل الأرصدة: غيّر أعمدة «رصيد: …» ثم استوردها من شاشة Excel بوضع «ضبط الرصيد (جرد)». الأعمدة الباقية (الإجمالي والكراتين) للقراءة فقط. «الحد الأدنى» و«الصور» (روابط https مفصولة بـ | ) بيتحدّثوا بالاستيراد: الخلية الفاضية = من غير تغيير.']];
  const name=`aliraqi-stock-${stamp()}.xlsx`;
  await saveBlob(writeXlsx([{name:'المخزون',rows:[head,...rows],widths},{name:'ملخص',rows:sum,widths:[28,60],header:false}]),name);
  await audit(user,'DATA_EXPORT','System','stock',null,JSON.stringify({name,products:prods.length,warehouses:whs.length}),deviceId()).catch(()=>{});
  return{name,count:prods.length};
}
export async function exportTemplate(user){
  const canCost=await can(user,'ViewCost'),cPrice=await can(user,'ChangeDefaultPrice');
  const head=['الكود','الاسم','القسم','القطع في الكرتونة',...(cPrice?['سعر القطعة']:[]),...(canCost?['التكلفة']:[]),'الحد الأدنى','كراتين','قطع','الصور'];
  const mk=(code,name,cat,ppc,price,cost,min,cart,pcs,img)=>[code,name,cat,ppc,...(cPrice?[price]:[]),...(canCost?[cost]:[]),min,cart,pcs,img];
  const rows=[head,mk('1001','مكنة فشار 1200 وات','أجهزة منزلية',12,350,300,24,2,5,'https://example.com/images/1001-a.jpg | https://example.com/images/1001-b.jpg'),mk('1002','منظف ملابس 3 لتر','منظفات',12,95,80,36,10,0,null)];
  const help=[['تعليمات الاستيراد'],['الأعمدة الأساسية: «الكود» و«الاسم». الباقي اختياري: القسم، القطع في الكرتونة، سعر القطعة، التكلفة، الحد الأدنى، الصور، كراتين، قطع (أو «الكمية» بالقطعة).'],['«الحد الأدنى» = عدد القطع اللي لما رصيد الصنف (كل المخازن) يوصل له أو أقل يظهر في «إعادة الطلب» (عدد صحيح 0 أو أكتر). الخلية الفاضية = من غير تغيير.'],['«الصور» = روابط https (رابط أو أكتر في الخلية، مفصولة بـ | أو بسطر جديد). الروابط بتستبدل صور الصنف الحالية، وأقصى عدد 10 صور. الخلية الفاضية = من غير تغيير. رابط غير صالح أو http العادي بيرفض الصف كله.'],['الأعمدة بتتعرف بالاسم (عربي أو إنجليزي) وترتيبها مش مهم. أي عمود غير معروف بيتتجاهل وبيظهر لك في المعاينة.'],['الكود: صنف كوده موجود = بيتحدّث ومش بيتكرر. صنف جديد وكوده فاضي = بيتولّد له كود تلقائي. الاسم إجباري للصنف الجديد.'],['اكتب الأكواد كنص (زي 0202 أو 95/3) عشان إكسل ما يحوّلهاش لتاريخ أو رقم.'],
    ['الكمية: اكتب «كراتين» و«قطع» (بتتحسب بعدد القطع في الكرتونة) أو عمود «الكمية» بالقطعة. المخزن بتختاره في شاشة الاستيراد.'],['ممكن تحط عمود «رصيد: اسم المخزن» لكل مخزن لو عايز تدخّل كميات أكتر من مخزن في ملف واحد.'],
    ['قبل التنفيذ بتظهر معاينة بالجديد والمتغيّر (القديم ← الجديد) والناقص والأخطاء — ومفيش حاجة بتتسجّل قبل ما تأكّد.'],['امسح الصفين الأمثلة قبل ما ترفع الملف.']];
  await saveBlob(writeXlsx([{name:'الأصناف',rows,widths:[16,34,16,14,12,12,12,10,10,60]},{name:'تعليمات',rows:help,widths:[110],header:false}]),'aliraqi-import-template.xlsx');
}

// ---------------- رابط Google Sheet ----------------
// بنقبل: رابط التعديل/المشاركة العادي (بنحوّله لـ gviz CSV مع نفس gid) أو رابط «نشر على الويب» (pub) أو رابط CSV جاهز. الشيت لازم يبقى «أي حد معاه الرابط (Viewer)» أو منشور — جوجل مبيسمحش بغير كده من غير تسجيل دخول.
export function sheetCsvUrl(u){
  u=String(u||'').trim();
  const m=/^https:\/\/docs\.google\.com\/spreadsheets\/d\/(e\/[\w-]+|[\w-]+)/.exec(u);
  if(!m)throw new Error('الرابط لازم يبقى رابط Google Sheet (بيبدأ بـ https://docs.google.com/spreadsheets/…)');
  if(/[?&]output=csv|[?&]format=csv|tqx=out:csv/.test(u))return u;
  const gid=/[#&?]gid=(\d+)/.exec(u)?.[1];
  if(m[1].startsWith('e/'))return `https://docs.google.com/spreadsheets/d/${m[1]}/pub?output=csv`+(gid?`&gid=${gid}`:'');
  return `https://docs.google.com/spreadsheets/d/${m[1]}/gviz/tq?tqx=out:csv`+(gid?`&gid=${gid}`:'');
}

// ---------------- الاستيراد: قراءة وتصنيف ----------------
function parseSheet(rows,whs){
  let hr=-1,map=null,ignored=[];
  for(let i=0;i<Math.min(rows.length,10)&&hr<0;i++){
    const m={},wcols={},ign=[];
    (rows[i]||[]).forEach((h,ci)=>{if(h==null)return;const t=String(h).trim(),w=/^(رصيد|stock)\s*[:：]\s*(.+)$/i.exec(t);
      if(w){const wh=whs.find(x=>norm(x.Name)===norm(w[2]));if(wh)wcols[ci]=wh.WarehouseID;else ign.push(t);return}
      const k=colKey(t);if(k&&m[k]==null)m[k]=ci;else ign.push(t)});
    if(m.code!=null||m.name!=null){hr=i;map={...m,wcols};ignored=ign}
  }
  if(hr<0)throw new Error('مش لاقي صف العناوين — لازم يبقى فيه عمود «الكود» أو «الاسم»');
  const items=[];
  for(let i=hr+1;i<rows.length;i++){
    const r=rows[i]||[];if(!r.some(v=>v!=null&&String(v).trim()!==''))continue;
    const g=k=>map[k]!=null?r[map[k]]:null;
    items.push({rn:i+1,code:str(g('code')),name:str(g('name')),category:g('category')==null?null:str(g('category')),
      ppc:g('ppc')==null||g('ppc')===''?null:toNum(g('ppc')),price:g('price')==null||g('price')===''?null:toNum(g('price')),cost:g('cost')==null||g('cost')===''?null:toNum(g('cost')),
      qty:g('qty')==null||g('qty')===''?null:toNum(g('qty')),cartons:g('cartons')==null||g('cartons')===''?null:toNum(g('cartons')),loose:g('loose')==null||g('loose')===''?null:toNum(g('loose')),
      reorder:g('reorder')==null||g('reorder')===''?null:toNum(g('reorder')),images:g('images')==null?'':str(g('images')),
      wq:Object.entries(map.wcols).map(([ci,wid])=>[wid,r[ci]]).filter(([,v])=>v!=null&&String(v).trim()!=='').map(([wid,v])=>[wid,toNum(v)])});
  }
  if(items.length>MAX_ROWS)throw new Error(`الملف فيه ${fmt(items.length)} صف — الحد الأقصى ${fmt(MAX_ROWS)} في المرة. قسّمه على ملفين.`);
  return{items,hasWhCols:Object.keys(map.wcols).length>0,hasGenericQty:map.qty!=null||map.cartons!=null||map.loose!=null,cols:map,ignored};
}
const isInt=n=>Number.isInteger(n);
// كل صف بيطلع: status (new/update/same/error) + diff (القديم والجديد لكل حقل) + qdiff (الرصيد الحالي ← بعد الاستيراد لكل مخزن) + missing (بيانات ناقصة) + plan (الكميات اللي هتتسجّل)
function classify(parsed,ctx){
  const {prods,perms,mode,wh,stock}=ctx,byCode=new Map(),byName=new Map();
  for(const p of prods){if(p.Deleted)continue;byCode.set(compact(p.Code),p);const k=norm(p.Name||'');byName.set(k,byName.has(k)?null:p)}
  const seen=new Set();
  return parsed.items.map(it=>{
    const out={...it,status:'same',msgs:[],changes:{},diff:[],qdiff:[],missing:[],plan:{},p:null,err:null};
    const bad=m=>{out.status='error';out.err=m;return out};
    const ck=it.code?compact(it.code):'';
    if(ck){if(seen.has(ck))return bad('الكود مكرر في الملف');seen.add(ck)}
    let p=ck?byCode.get(ck):(it.name?byName.get(norm(it.name)):null);
    if(!ck&&it.name&&byName.get(norm(it.name))===null)return bad('اسم الصنف مكرر في النظام — اكتب الكود عشان نعرف أنهي صنف');
    out.p=p||null;
    if(it.ppc!=null&&(Number.isNaN(it.ppc)||!isInt(it.ppc)||it.ppc<1))return bad('القطع في الكرتونة لازم عدد صحيح 1 أو أكتر');
    if(it.price!=null&&(Number.isNaN(it.price)||it.price<=0))return bad('سعر القطعة لازم رقم أكبر من صفر');
    if(it.cost!=null&&(Number.isNaN(it.cost)||it.cost<0))return bad('التكلفة لازم رقم صفر أو أكتر');
    if(it.code&&it.code.length>40)return bad('الكود أطول من 40 حرف');
    if(it.reorder!=null&&(Number.isNaN(it.reorder)||!isInt(it.reorder)||it.reorder<0||it.reorder>10000000))return bad('الحد الأدنى لازم عدد صحيح 0 أو أكتر');
    let imgs=null;if(it.images){try{imgs=cleanImages(splitImages(it.images))}catch(e){return bad(e.message)}if(!imgs.length)imgs=null}
    out.imgs=imgs;
    if(p){
      const ch={};
      if(perms.edit){
        if(it.name&&it.name!==(p.Name||'')){if(it.name.length<2||it.name.length>120)return bad('اسم الصنف لازم من 2 لـ 120 حرف');ch.Name=it.name}
        if(it.category!=null&&it.category!==(p.Category||''))ch.Category=it.category;
        if(it.ppc!=null&&it.ppc!==(p.PcsPerCarton??null))ch.PcsPerCarton=it.ppc;
        if(it.reorder!=null&&it.reorder!==(p.ReorderLevel??null))ch.ReorderLevel=it.reorder;
        if(imgs&&JSON.stringify(imgs)!==JSON.stringify(p.Images||[]))ch.Images=imgs;
        if(perms.cost&&it.cost!=null&&r2(it.cost)!==(p.Cost??null))ch.Cost=r2(it.cost);
      }
      if(perms.price&&it.price!=null&&r2(it.price)!==(p.PricePiece??null))ch.PricePiece=r2(it.price);
      out.changes=ch;
      out.diff=Object.entries(ch).map(([k,v])=>({k,old:k==='Images'?(p.Images||[]):(p[k]??null),new:v}));
      if(out.diff.length)out.status='update';
    }else{
      if(!perms.edit)return bad('مفيش صلاحية إضافة أصناف جديدة');
      if(!it.name||it.name.length<2)return bad('الاسم مطلوب للصنف الجديد (حرفين على الأقل)');
      if(it.name.length>120)return bad('الاسم أطول من 120 حرف');
      out.status='new';
      if(!perms.price)out.price=null;                                   // صنف جديد: السعر/التكلفة بيتجاهلوا لو مفيش صلاحية (createProduct كان هيرفض الصف كله وقت التنفيذ)
      if(!perms.cost)out.cost=null;
    }
    // بيانات ناقصة (للتنبيه بس — الصنف بيتسجّل عادي، والسعر الناقص = «بانتظار التسعير»)
    const fPrice=p?(perms.price&&it.price!=null?it.price:p.PricePiece):out.price,fPpc=it.ppc??p?.PcsPerCarton??null,fCat=it.category!=null&&it.category!==''?it.category:(p?.Category||'');
    if(!(fPrice>0))out.missing.push('السعر');
    if(!fPpc)out.missing.push('القطع في الكرتونة');
    if(!fCat)out.missing.push('القسم');
    if(!p&&!it.code)out.missing.push('الكود (هيتولّد تلقائي)');
    // الكميات
    const ppc=it.ppc??p?.PcsPerCarton??null,plan={};
    for(const [wid,v] of it.wq){if(v==null||Number.isNaN(v)||!isInt(v)||v<0)return bad('كمية غير صالحة في عمود رصيد المخزن');plan[wid]=v}
    if(it.qty!=null||it.cartons!=null||it.loose!=null){
      let g=null;
      if(it.qty!=null){if(Number.isNaN(it.qty)||!isInt(it.qty)||it.qty<0)return bad('الكمية لازم عدد صحيح 0 أو أكتر');g=it.qty}
      else{const c=it.cartons??0,l=it.loose??0;
        if([c,l].some(x=>Number.isNaN(x)||!isInt(x)||x<0))return bad('الكراتين والقطع لازم أعداد صحيحة 0 أو أكتر');
        if(c>0&&!ppc)return bad('الكراتين محتاجة «القطع في الكرتونة» (للصنف ده مش محددة)');
        g=c*(ppc||0)+l}
      if(wh&&plan[wh]===undefined)plan[wh]=g;
    }
    if(perms.qty)for(const [wid,v] of Object.entries(plan)){
      const cur=p?((stock.get(p.ProductID)||{})[wid]||0):0;
      if(mode==='add'?v<=0:v===cur)continue;                              // مفيش تغيير فعلي في الكمية = مش بتتسجّل
      out.plan[wid]=v;out.qdiff.push({wid,cur,next:mode==='add'?cur+v:v});
    }
    return out;
  });
}

// ---------------- الاستيراد: التنفيذ ----------------
async function sha(bytes){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('')}
async function applyImport({user,rows,mode,fileName,progress}){
  const res={created:0,updated:0,docs:[],errors:[],noDiff:0};
  const todo=rows.filter(r=>r.status!=='error'),ids=new Map();
  let i=0;
  for(const r of todo){
    progress?.(`الأصناف ${fmt(++i)} من ${fmt(todo.length)}…`);
    try{
      if(r.status==='new'){
        const rec=(await createProduct({user,data:{Name:r.name,Code:r.code,Category:r.category||'',PcsPerCarton:r.ppc,PricePiece:r.price!=null?r2(r.price):null,Cost:r.cost!=null?r2(r.cost):null,ReorderLevel:r.reorder??null,Images:r.imgs||[]}})).rec;
        ids.set(r,rec.ProductID);res.created++;
      }else{
        ids.set(r,r.p.ProductID);
        if(r.status==='update'){await saveProduct({user,productId:r.p.ProductID,changes:r.changes});res.updated++}
      }
    }catch(e){res.errors.push(`سطر ${r.rn}: ${typeof e.code==='string'?e.message:'تعذر الحفظ'}`);ids.delete(r)}
  }
  const byWh=new Map();
  for(const r of todo){const pid=ids.get(r);if(!pid)continue;for(const [wid,q] of Object.entries(r.plan)){if(!byWh.has(wid))byWh.set(wid,[]);byWh.get(wid).push({pid,q,rn:r.rn})}}
  const whs=new Map((await all('warehouses')).map(w=>[w.WarehouseID,w.Name]));
  for(const [wid,list] of byWh){
    progress?.('تسجيل الكميات — '+(whs.get(wid)||'')+'…');
    try{
      if(mode==='add'){
        const d=await postStockDoc({type:'STOCK_IN',warehouseId:wid,lines:list.map(x=>({productId:x.pid,qtyPieces:x.q})),user,notes:'استيراد من Excel — '+fileName});
        res.docs.push(`استلام ${d.number} (${whs.get(wid)}): ${fmt(list.length)} صنف`);
      }else{
        const sm=await stockMap();
        const lines=list.map(x=>({productId:x.pid,systemQty:(sm.get(x.pid)||{})[wid]||0,countedQty:x.q}));
        const d=await postAdjustment({warehouseId:wid,lines,reason:'استيراد من Excel — '+fileName,user});
        res.docs.push(`تسوية ${d.number} (${whs.get(wid)}): ${fmt(d.count)} صنف فيه فرق، ${fmt(d.matched)} مطابق`);
      }
    }catch(e){
      if(e.code==='NO_DIFF')res.noDiff++;
      else res.errors.push(`المخزن ${whs.get(wid)||wid}: ${typeof e.code==='string'?e.message:'تعذر تسجيل الكميات'}`);
    }
  }
  return res;
}

// ---------------- الشاشة ----------------
const COL_AR={code:'الكود',name:'الاسم',category:'القسم',ppc:'القطع/كرتونة',price:'سعر القطعة',cost:'التكلفة',qty:'الكمية',cartons:'كراتين',loose:'قطع',reorder:'الحد الأدنى',images:'الصور'};
const FIELD_AR={Name:'الاسم',Category:'القسم',PcsPerCarton:'القطع/كرتونة',PricePiece:'سعر القطعة',Cost:'التكلفة',ReorderLevel:'الحد الأدنى',Images:'الصور'};
const fv=(k,v)=>v==null||v===''?'—':k==='Images'?`${(v||[]).length} صورة`:(k==='PricePiece'||k==='Cost')?fmt(r2(v)):String(v);
const XL_CSS=`.xl-tabs{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0}.xl-tabs button{min-height:38px;padding:0 12px;border:1px solid var(--line);border-radius:999px;background:#fff;font-weight:700;color:var(--muted);cursor:pointer}
.xl-tabs button.on{background:var(--navy);border-color:var(--navy);color:#fff}.xl-tabs button.bad:not(.on){border-color:var(--danger);color:var(--danger)}
.xl-row{background:#fff;border:1px solid var(--line);border-radius:12px;padding:8px 12px;margin:6px 0;font-size:.88rem}.xl-h{display:flex;justify-content:space-between;gap:8px;align-items:flex-start;font-weight:700;color:var(--navy)}
.xl-d{display:flex;gap:8px;flex-wrap:wrap;align-items:baseline;padding:2px 0;border-top:1px dotted var(--line);margin-top:3px}.xl-d>span:first-child{color:var(--muted);min-width:96px}
.xl-old{color:var(--muted);text-decoration:line-through}.xl-new{color:#1f7a5a}.xl-warn .xl-new,.xl-warn small{color:var(--danger)}.xl-m{color:#8a6100;font-size:.8rem;margin-top:3px}.xl-n{color:var(--muted);font-size:.8rem;margin-top:3px}`;
export async function showExcel(user,onBack){
  const [cView,cEdit,cIn,cAdj,cPrice,cCost,cProd]=await Promise.all(['ViewStock','EditProducts','StockIn','StockAdjust','ChangeDefaultPrice','ViewCost','ViewProducts'].map(p=>can(user,p)));
  if(!cView&&!cEdit){toast('مفيش صلاحية');onBack();return}
  if(!document.getElementById('xl-css'))document.head.append(el('style',{id:'xl-css'},XL_CSS));
  const whs=(await all('warehouses')).filter(w=>w.Active!==false),whName=id=>whs.find(w=>w.WarehouseID===id)?.Name||'';
  const savedSheet=(await get('settings','xl_sheet_url').catch(()=>null))?.url||'';
  const prev=el('div',{});
  const whSel=el('select',{'aria-label':'المخزن',onchange:()=>reclass()},whs.map(w=>el('option',{value:w.WarehouseID},w.Name)));
  whSel.value=pickWarehouse(whs)||whs[0]?.WarehouseID||'';
  const modeSel=el('select',{'aria-label':'وضع الكميات',onchange:()=>reclass()},
    cIn&&el('option',{value:'add'},'استلام — يضيف الكمية على الرصيد الحالي'),cAdj&&el('option',{value:'set'},'ضبط الرصيد (جرد) — الرصيد يبقى زي الملف'),el('option',{value:'none'},'بدون كميات (أصناف وأسعار بس)'));
  const file=el('input',{type:'file',accept:'.xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv',hidden:true,onchange:e=>{const f=e.target.files[0];e.target.value='';if(f)load(f)}});
  const sheetIn=el('input',{type:'url',dir:'ltr',value:savedSheet,placeholder:'https://docs.google.com/spreadsheets/d/…','aria-label':'رابط Google Sheet'});
  let parsed=null,rows=[],meta=null,busy=false,ctxProds=[],ctxStock=new Map(),tab='act',shown=60;
  const perms={edit:cEdit,price:cPrice,cost:cCost&&cEdit,get qty(){return modeSel.value!=='none'}};
  function reclass(){if(!parsed)return;rows=classify(parsed,{prods:ctxProds,perms,mode:modeSel.value,wh:whSel.value,stock:ctxStock});drawPreview()}
  async function ingest(raw,bytes,name){
    parsed=parseSheet(raw,whs);ctxProds=await all('products');ctxStock=await stockMap();
    meta={name,hash:await sha(bytes)};tab='act';shown=60;
    if(parsed.hasWhCols&&cAdj)modeSel.value='set';else if(modeSel.value==='set'&&!cAdj)modeSel.value='add';
    if(![...modeSel.options].some(o=>o.value===modeSel.value))modeSel.value='none';
    reclass();
  }
  async function load(f){
    prev.replaceChildren(el('p',{class:'note'},'بنقرا الملف…'));
    try{
      if(f.size>MAX_BYTES)throw new Error('الملف كبير (الحد 8 ميجا)');
      const {rows:raw,bytes}=await readTableFile(f);
      await ingest(raw,bytes,f.name);
    }catch(e){parsed=null;rows=[];prev.replaceChildren(el('p',{class:'err'},e.message||'تعذر قراءة الملف'))}
  }
  async function fromSheet(){
    let u;try{u=sheetCsvUrl(sheetIn.value)}catch(e){prev.replaceChildren(el('p',{class:'err'},e.message));return}
    if(!navigator.onLine){prev.replaceChildren(el('p',{class:'err'},'أوفلاين — الربط بالشيت محتاج نت'));return}
    prev.replaceChildren(el('p',{class:'note'},'بنجيب الشيت من جوجل…'));
    const ctl=new AbortController(),tm=setTimeout(()=>ctl.abort(),30000);
    try{
      const res=await fetch(u,{signal:ctl.signal,credentials:'omit',referrerPolicy:'no-referrer'});
      if(!res.ok)throw new Error('رد جوجل HTTP '+res.status+' — اتأكد إن الشيت مشارك «أي حد معاه الرابط (Viewer)» أو منشور على الويب');
      const bytes=new Uint8Array(await res.arrayBuffer());
      if(bytes.length>MAX_BYTES)throw new Error('الشيت كبير (الحد 8 ميجا)');
      const text=new TextDecoder('utf-8').decode(bytes);
      if(/^\s*<(!doctype|html)/i.test(text))throw new Error('جوجل رجّع صفحة تسجيل دخول — الشيت لازم يبقى مشارك «أي حد معاه الرابط (Viewer)» أو منشور على الويب');
      await put('settings',{key:'xl_sheet_url',url:sheetIn.value.trim(),at:nowISO()}).catch(()=>{});
      await ingest(parseCsv(text),bytes,'Google Sheet');
    }catch(e){
      parsed=null;rows=[];
      prev.replaceChildren(el('p',{class:'err'},e.name==='AbortError'?'انتهت مهلة الاتصال بجوجل':e instanceof TypeError?'تعذر الوصول للشيت (النت أو صلاحية المشاركة أو حظر المتصفح) — نزّل الشيت كـ Excel/CSV وارفعه من «اختيار ملف»':(e.message||'تعذر جلب الشيت')));
    }finally{clearTimeout(tm)}
  }

  // ---- المعاينة ----
  const TABS=[['act','هيتغيّر'],['new','جديد'],['chg','متغيّر'],['inc','غير مكتمل'],['same','بدون تغيير'],['err','أخطاء']];
  const isChg=r=>r.status==='update'||(r.status==='same'&&r.qdiff.length>0);
  const inTab=(r,t)=>t==='act'?(r.status==='new'||isChg(r)):t==='new'?r.status==='new':t==='chg'?isChg(r):t==='inc'?(r.status!=='error'&&r.missing.length>0):t==='same'?(r.status==='same'&&!r.qdiff.length):r.status==='error';
  const badge=r=>r.status==='same'&&r.qdiff.length?['bdg warn','تغيّر الكمية']:({new:['bdg ok','جديد'],update:['bdg warn','تحديث'],same:['bdg','بدون تغيير'],error:['bdg no','خطأ']})[r.status];
  const pct=(o,n)=>o>0?Math.round((n-o)/o*100):null;
  const diffLine=d=>{
    let extra='',cls='';
    if((d.k==='PricePiece'||d.k==='Cost')&&d.old>0){const p=pct(d.old,d.new);extra=` (${p>0?'+':''}${p}%)`;if(Math.abs(p)>=30)cls=' xl-warn'}
    return el('div',{class:'xl-d'+cls},el('span',{},FIELD_AR[d.k]),el('span',{class:'xl-old'},fv(d.k,d.old)),'←',el('b',{class:'xl-new'},fv(d.k,d.new)),extra&&el('small',{},extra));
  };
  const qLine=q=>{const d=q.next-q.cur;
    return el('div',{class:'xl-d'+(d<0?' xl-warn':'')},el('span',{},'رصيد '+whName(q.wid)),el('span',{class:'xl-old'},fmt(q.cur)),'←',el('b',{class:'xl-new'},fmt(q.next)),el('small',{},`(${d>0?'+':''}${fmt(d)} قطعة)`))};
  const newSummary=r=>[r.category&&'القسم: '+r.category,r.ppc!=null&&'قطع/كرتونة: '+r.ppc,r.price!=null&&'السعر: '+fmt(r2(r.price)),r.cost!=null&&'التكلفة: '+fmt(r2(r.cost)),r.reorder!=null&&'حد أدنى: '+fmt(r.reorder),r.imgs&&r.imgs.length+' صورة'].filter(Boolean).join(' · ')||'من غير بيانات إضافية';
  const card=r=>{const [c,t]=badge(r);
    return el('div',{class:'xl-row'},el('div',{class:'xl-h'},el('span',{},`${r.rn} · ${r.code||'(كود تلقائي)'} — ${r.name||r.p?.Name||''}`),el('span',{class:c},t)),
      r.status==='error'&&el('div',{class:'err'},r.err),r.status==='new'&&el('div',{class:'xl-n'},newSummary(r)),
      ...r.diff.map(diffLine),...r.qdiff.map(qLine),r.status!=='error'&&r.missing.length>0&&el('div',{class:'xl-m'},'ناقص: '+r.missing.join('، ')));};
  const stats=()=>{let up=0,down=0,qn=0;const used=new Set();
    for(const r of rows)if(r.status!=='error'){if(r.p)used.add(r.p.ProductID);if(r.qdiff.length)qn++;for(const q of r.qdiff){const d=q.next-q.cur;d>0?up+=d:down-=d}}
    const outside=ctxProds.filter(p=>!p.Deleted&&p.Active!==false&&!used.has(p.ProductID)).length;
    return{up,down,qn,outside,nNew:rows.filter(r=>r.status==='new').length,nUpd:rows.filter(r=>r.status==='update').length}};
  function drawPreview(){
    const mode=modeSel.value,cnt={};for(const [t] of TABS)cnt[t]=rows.filter(r=>inTab(r,t)).length;
    const list=rows.filter(r=>inTab(r,tab)),actionable=rows.filter(r=>r.status==='new'||isChg(r)),st=stats();
    const needWh=mode!=='none'&&rows.some(r=>r.status!=='error'&&(r.qty!=null||r.cartons!=null||r.loose!=null))&&!whSel.value;
    const tabs=el('div',{class:'xl-tabs',role:'tablist'},TABS.map(([t,l])=>el('button',{type:'button',role:'tab','aria-selected':String(t===tab),class:(t===tab?'on':'')+(t==='err'&&cnt.err?' bad':''),onclick:()=>{tab=t;shown=60;drawPreview()}},`${l} (${fmt(cnt[t])})`)));
    const go=el('button',{class:'btn',type:'button',disabled:busy||!actionable.length||needWh,onclick:()=>run()},actionable.length?`مراجعة وتأكيد التحديث (${fmt(actionable.length)} صنف)`:'مفيش حاجة تتنفّذ');
    prev.replaceChildren(
      el('div',{class:'ssum'},`${meta.name} — ${fmt(rows.length)} صف · جديد ${fmt(st.nNew)} · تحديث بيانات ${fmt(st.nUpd)} · تغيّر كمية ${fmt(st.qn)}`+(cnt.err?` · أخطاء ${fmt(cnt.err)}`:'')),
      el('p',{class:'note'},'الأعمدة اللي اتقرت: '+(Object.keys(parsed.cols).filter(k=>k!=='wcols'&&parsed.cols[k]!=null).map(k=>COL_AR[k]).concat(Object.keys(parsed.cols.wcols).length?[`رصيد ${Object.keys(parsed.cols.wcols).length} مخزن`]:[]).join('، ')||'—')),
      parsed.ignored.length>0&&el('p',{class:'editwarn'},'أعمدة ما اتعرفتش واتتجاهلت: '+parsed.ignored.join('، ')),
      parsed.cols.code==null&&el('p',{class:'editwarn'},'مفيش عمود «الكود»: الصنف الموجود بيتطابق بالاسم، والجديد بيتولّد له كود تلقائي.'),
      parsed.cols.name==null&&el('p',{class:'editwarn'},'مفيش عمود «الاسم»: الأصناف الجديدة هتترفض (الاسم إجباري للصنف الجديد).'),
      mode!=='none'&&st.qn>0&&el('p',{class:'note'},mode==='add'?`هيتسجّل استلام ${fmt(st.up)} قطعة على ${fmt(st.qn)} صنف.`:`هتتسجّل تسوية جرد لـ ${fmt(st.qn)} صنف: زيادة ${fmt(st.up)} قطعة، نقص ${fmt(st.down)} قطعة (الفرق بيتسجّل كحركة وتقدر تلغيها من «مستندات المخزن»).`),
      !cEdit&&el('p',{class:'editwarn'},'مفيش معاك صلاحية تعديل الأصناف — الاستيراد هيسجّل الكميات بس.'),
      cEdit&&!cPrice&&parsed.cols.price!=null&&el('p',{class:'note'},'عمود السعر اتتجاهل (مفيش صلاحية تغيير الأسعار).'),
      cEdit&&!cCost&&parsed.cols.cost!=null&&el('p',{class:'note'},'عمود التكلفة اتتجاهل (مفيش صلاحية رؤية/تعديل التكلفة).'),
      needWh&&el('p',{class:'err'},'اختار المخزن للكميات.'),
      tabs,...(list.length?list.slice(0,shown).map(card):[el('p',{class:'empty'},'مفيش صفوف في التبويب ده')]),
      list.length>shown&&el('button',{class:'btn ghost',type:'button',onclick:()=>{shown+=60;drawPreview()}},`عرض المزيد (${fmt(list.length-shown)})`),
      el('p',{class:'note'},'المعاينة بتوضح القديم ← الجديد. التنفيذ بيشمل كل الصفوف اللي في «هيتغيّر» — ومفيش حاجة بتتسجّل قبل ما تأكّد.'),go);
  }
  // تأكيد نهائي: ملخص اللي هيتكتب + اللي مش هيتلمس. بيرجّع true/false.
  function confirmApply(prevImp){
    const st=stats();
    return new Promise(res=>{
      let done=false,close;const fin=v=>{if(done)return;done=true;close();res(v)};
      const row=(k,v,warn)=>el('div',{class:'drow'},el('span',{},k),el('b',{class:warn?'warn':''},v));
      close=modal({title:'تأكيد التحديث',onClose:()=>fin(false)},
        prevImp&&el('p',{class:'editwarn'},`⚠ الملف ده (بنفس المحتوى) اتستورد قبل كده يوم ${new Date(prevImp.at).toLocaleString('en-GB')}. لو كمّلت ${modeSel.value==='add'?'الكميات هتتضاف مرة تانية':'هتتسجّل نفس الأصناف تاني'}.`),
        row('أصناف جديدة هتتضاف',fmt(st.nNew)),row('أصناف هتتحدّث بياناتها/أسعارها',fmt(st.nUpd)),
        modeSel.value!=='none'&&row('أصناف هتتغيّر كميتها',fmt(st.qn)),modeSel.value!=='none'&&row('إجمالي الزيادة (قطعة)',fmt(st.up)),modeSel.value==='set'&&row('إجمالي النقص (قطعة)',fmt(st.down),st.down>0),
        row('أصناف في النظام ومش في الملف',fmt(st.outside)+' — مش هتتلمس ولا هتتمسح'),
        el('p',{class:'note'},'الأصناف والكميات بتتسجّل على الجهاز وبتتزامن تلقائياً مع Google Sheet المركزي. القيم القديمة بتتحفظ في لقطة على الجهاز، وكل تعديل ليه سجل في «سجل العمليات».'),
        el('div',{class:'btnrow act'},el('button',{class:'btn',type:'button',onclick:()=>fin(true)},'تأكيد التحديث'),el('button',{class:'btn ghost',type:'button',onclick:()=>fin(false)},'رجوع للمراجعة')));
    });
  }
  async function run(){
    if(busy)return;const mode=modeSel.value;
    const prevKey='xl_import:'+meta.hash,prevImp=await get('settings',prevKey).catch(()=>null);
    if(!await confirmApply(prevImp))return;
    busy=true;drawPreview();
    const status=el('p',{class:'note'},'جاري التنفيذ…');prev.append(status);
    try{
      await put('settings',{key:'xl_last_import',at:nowISO(),name:meta.name,hash:meta.hash,mode,                       // لقطة بالقيم القديمة قبل أي كتابة (مرجع للتراجع اليدوي)
        updates:rows.filter(r=>r.status==='update').slice(0,MAX_ROWS).map(r=>({pid:r.p.ProductID,code:r.p.Code,old:Object.fromEntries(r.diff.map(d=>[d.k,d.old]))})),
        qty:rows.filter(r=>r.qdiff.length).slice(0,MAX_ROWS).map(r=>({code:r.code||r.p?.Code||'',name:r.name||r.p?.Name||'',q:r.qdiff}))}).catch(()=>{});
      const r=await applyImport({user,rows,mode,fileName:meta.name,progress:t=>{status.textContent=t}});
      await put('settings',{key:prevKey,at:nowISO(),name:meta.name}).catch(()=>{});
      await audit(user,'DATA_IMPORT','System','excel',null,JSON.stringify({name:meta.name,created:r.created,updated:r.updated,docs:r.docs.length,errors:r.errors.length,mode}),deviceId()).catch(()=>{});
      parsed=null;rows=[];busy=false;
      prev.replaceChildren(el('div',{class:'login done'},el('div',{class:'bigok'},r.errors.length?'⚠️':'✅'),el('h1',{},'تم الاستيراد'),
        el('p',{},`أصناف جديدة ${fmt(r.created)} · أصناف اتحدّثت ${fmt(r.updated)}${r.noDiff?' · الأرصدة مطابقة للملف (مفيش تسوية)':''}`),
        ...r.docs.map(d=>el('p',{class:'note'},d)),
        r.errors.length>0&&el('div',{class:'voidbox'},el('b',{},`${fmt(r.errors.length)} مشكلة (ما اتسجّلتش):`),...r.errors.slice(0,15).map(m=>el('div',{class:'drow'},el('span',{dir:'auto'},m)))),
        el('p',{class:'note'},'كل حاجة اتسجّلت على الجهاز وبتتزامن تلقائياً.')));
    }catch(e){busy=false;prev.replaceChildren(el('p',{class:'err'},typeof e.code==='string'?e.message:'تعذر تنفيذ الاستيراد — ما اتغيّرش حاجة مؤكدة، راجع المخزون وجرّب تاني'))}
  }
  const exBtn=(txt,fn,cls)=>el('button',{class:'btn'+(cls?' '+cls:''),type:'button',onclick:async ev=>{const b=ev.currentTarget;b.disabled=true;try{const r=await fn(user);toast(r?`تم تجهيز الملف (${fmt(r.count)} صنف)`:'تم تجهيز الملف')}catch(e){toast(e.message||'تعذر تجهيز الملف')}b.disabled=false}},txt);
  $('#app').replaceChildren(el('div',{class:'wrap'},el('div',{class:'hello'},el('h2',{},'Excel — استيراد وتصدير'),el('button',{class:'btn ghost',type:'button',onclick:onBack},'رجوع')),
    el('h3',{class:'sec'},'📤 تصدير'),
    el('p',{class:'note'},'بيطلّع كل الأصناف بأرصدتها (حتى الصفر) لكل مخزن + الإجمالي والكراتين'+(cCost?' + التكلفة وقيمة المخزون':'')+'. على الموبايل بيفتح قائمة المشاركة (واتساب/إيميل/درايف).'),
    el('div',{class:'filters'},cView&&exBtn('📊 تصدير المخزون كله (Excel)',exportStock),(cEdit||cIn||cAdj)&&exBtn('📥 تنزيل قالب إكسل جاهز',exportTemplate,'ghost'),
      cProd&&el('button',{class:'btn ghost',type:'button',onclick:async()=>{try{const m=await import('./qr-bulk.js');m.showBulkLabels(user,()=>showExcel(user,onBack))}catch{toast('تعذر فتح شاشة الطباعة المجمّعة — أعد تحميل الصفحة وانت متصل')}}},'🖨️ طباعة ملصقات مجمّعة')),
    (cEdit||cIn||cAdj)&&el('div',{},el('h3',{class:'sec'},'📥 استيراد من ملف أو من Google Sheet'),
      el('p',{class:'note'},'ملف Excel (.xlsx) أو CSV أو رابط شيت جوجل. الأصناف الجديدة بتتضاف، والموجودة (بالكود) بتتحدّث بياناتها، والكميات بتتسجّل كاستلام أو جرد. بتشوف معاينة بالقديم ← الجديد وتأكيد نهائي قبل ما حاجة تتسجّل، ومفيش حاجة بتتمسح.'),
      el('details',{class:'help-sec'},el('summary',{},'📘 إزاي أجهّز ملف الاستيراد؟'),el('div',{class:'help-body'},el('ul',{},
        el('li',{},'أسهل طريقة: نزّل «القالب الجاهز» أو «تصدير المخزون كله» وعدّل عليه.'),
        el('li',{},'الأعمدة الأساسية: «الكود» و«الاسم». الاسم إجباري للصنف الجديد، والكود لو فاضي بيتولّد تلقائي.'),
        el('li',{},'اختياري: القسم، القطع في الكرتونة، سعر القطعة، التكلفة، «الحد الأدنى» (لتنبيه إعادة الطلب)، «الصور» (روابط https، أكتر من رابط مفصولين بـ | )، وكميات (كراتين + قطع، أو الكمية بالقطعة، أو «رصيد: اسم المخزن»). الخلية الفاضية في الحد الأدنى أو الصور = من غير تغيير.'),
        el('li',{},'الأعمدة بتتعرف بالاسم وترتيبها مش مهم. أي عمود مش معروف بيتتجاهل وبيظهر في المعاينة.'),
        el('li',{},'اكتب الأكواد كنص (0202، 95/3). الحد الأقصى 3000 صف و8 ميجا في المرة.'),
        el('li',{},'Google Sheet: افتح الشيت ← «مشاركة» ← «أي حد معاه الرابط (Viewer)» (أو ملف ← مشاركة ← نشر على الويب) وحط الرابط تحت. الورقة المفتوحة (gid) هي اللي بتتقرا.'),
        el('li',{},'قبل أي حفظ بتشوف معاينة بتبويبات: جديد / متغيّر (القديم ← الجديد) / غير مكتمل / بدون تغيير / أخطاء، وبعدها تأكيد نهائي.')))),
      el('label',{class:'field'},el('span',{},'وضع الكميات'),modeSel),el('label',{class:'field'},el('span',{},'المخزن (للكميات اللي مش محددة بعمود «رصيد: …»)'),whSel),
      el('button',{class:'btn',type:'button',onclick:()=>file.click()},'📎 اختيار ملف'),file,
      el('label',{class:'field',style:'margin-top:12px'},el('span',{},'🔗 أو رابط Google Sheet'),sheetIn),
      el('button',{class:'btn ghost',type:'button',onclick:()=>fromSheet()},savedSheet?'🔄 تحديث من الشيت':'🔗 جلب من الشيت'),prev)));
  if(!whs.length)prev.replaceChildren(el('p',{class:'editwarn'},'مفيش مخزن نشط — أضف مخزن من شاشة «المخازن» لو هتستورد كميات.'));
}
