// استيراد وتصدير Excel (v19) — شاشة «Excel»: تصدير المخزون كله، قالب استيراد فاضي، واستيراد أصناف وكميات من ملف .xlsx أو .csv.
// قواعد الأمان (نفس باقي التطبيق): الاستيراد بيمر على نفس دوال الحفظ (createProduct / saveProduct / postStockDoc / postAdjustment) فكل الصلاحيات والتحقق ومنع تكرار الكود وسجل العمليات والمزامنة بتنطبق.
// المخزون عمره ما بيتكتب كرقم رصيد: الكمية بتتسجّل كمستند استلام (يضيف) أو تسوية جرد (بفروق) — ودايماً بمعاينة قبل التنفيذ.
// الأعمدة بتتعرف بالاسم (عربي/إنجليزي). الأعمدة «رصيد: اسم المخزن» (اللي بيطلعها التصدير) بتحدد كمية كل مخزن، فملف التصدير نفسه ينفع يتعدّل ويتستورد تاني.
import {all,stockMap,postStockDoc,audit,deviceId,nowISO,ymd,put,get,pickWarehouse} from './db.js';
import {can} from './auth.js';
import {norm,compact} from './products.js';
import {createProduct} from './product-new.js';
import {saveProduct} from './product-edit.js';
import {postAdjustment} from './adjust.js';
import {$,el,toast,fmt} from './ui.js';
import {writeXlsx,readTableFile} from './xlsx-lite.js';

const MAX_BYTES=8*1024*1024,MAX_ROWS=3000;
const r2=n=>Math.round((Number(n)+Number.EPSILON)*100)/100;
const toNum=v=>{if(typeof v==='number')return v;let s=String(v??'').trim().replace(/[٠-٩]/g,d=>'٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/٫/g,'.').replace(/[,٬\s]/g,'');return s===''?null:Number(s)};
const str=v=>v==null?'':String(typeof v==='number'?(Number.isInteger(v)?v:v):v).trim();
const H={
  code:['الكود','كود','كود الصنف','code','sku','barcode','باركود'],
  name:['الاسم','اسم الصنف','الصنف','اسم','name','product','item','product name'],
  category:['القسم','الفئة','التصنيف','category'],
  ppc:['القطع في الكرتونة','عدد القطع في الكرتونة','قطع في الكرتونة','قطع/كرتونة','pcspercarton','pcs per carton','pieces per carton'],
  price:['سعر القطعة','سعر البيع','سعر','price','piece price','pricepiece'],
  cost:['التكلفة','سعر الشراء','تكلفة','cost'],
  qty:['الرصيد','الكمية','الرصيد (قطعة)','الكمية (قطعة)','الرصيد بالقطعة','qty','quantity','stock','balance'],
  cartons:['كراتين','عدد الكراتين','cartons','ctn'],
  loose:['قطع','قطع سايبة','pieces']
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
  const head=['الكود','الاسم','القسم','القطع في الكرتونة',...whs.map(w=>'رصيد: '+w.Name),'الإجمالي (قطعة)','كراتين كاملة','قطع زيادة','سعر القطعة','سعر الكرتونة',...(canCost?['التكلفة','قيمة المخزون بالتكلفة']:[])];
  let inStock=0,zero=0,pieces=0,value=0;
  const rows=prods.map(p=>{
    const o=sm.get(p.ProductID)||{},per=whs.map(w=>o[w.WarehouseID]||0),tot=per.reduce((s,x)=>s+x,0),k=p.PcsPerCarton;
    tot>0?inStock++:tot===0&&zero++;pieces+=Math.max(0,tot);
    const val=canCost&&typeof p.Cost==='number'?Math.max(0,tot)*p.Cost:null;if(val)value+=val;
    return[String(p.Code??''),p.Name||'',p.Category||'',k!=null?{v:k,s:'int'}:null,...per.map(q=>({v:q,s:'int'})),{v:tot,s:'int'},
      k&&tot>=k?{v:Math.floor(tot/k),s:'int'}:null,k?(tot>=0?{v:tot%k,s:'int'}:null):{v:tot,s:'int'},
      p.PricePiece!=null?{v:p.PricePiece,s:'money'}:null,p.PriceCarton!=null?{v:p.PriceCarton,s:'money'}:null,
      ...(canCost?[typeof p.Cost==='number'?{v:p.Cost,s:'money'}:null,val!=null?{v:r2(val),s:'money'}:null]:[])];
  });
  const widths=[16,34,16,12,...whs.map(()=>14),14,12,12,12,12,...(canCost?[12,16]:[])];
  const sum=[['تاريخ التصدير',new Date().toLocaleString('en-GB')],['المستخدم',user.Name],['عدد الأصناف',{v:prods.length,s:'int'}],['أصناف ليها رصيد',{v:inStock,s:'int'}],['أصناف رصيدها صفر',{v:zero,s:'int'}],['إجمالي القطع (الموجب)',{v:pieces,s:'int'}],
    ...(canCost?[['قيمة المخزون بالتكلفة (ج.م)',{v:r2(value),s:'money'}]]:[]),
    ['ملاحظة','لتعديل الأرصدة: غيّر أعمدة «رصيد: …» ثم استوردها من شاشة Excel بوضع «ضبط الرصيد (جرد)». الأعمدة الباقية (الإجمالي والكراتين) للقراءة فقط.']];
  const name=`aliraqi-stock-${stamp()}.xlsx`;
  await saveBlob(writeXlsx([{name:'المخزون',rows:[head,...rows],widths},{name:'ملخص',rows:sum,widths:[28,60],header:false}]),name);
  await audit(user,'DATA_EXPORT','System','stock',null,JSON.stringify({name,products:prods.length,warehouses:whs.length}),deviceId()).catch(()=>{});
  return{name,count:prods.length};
}
export async function exportTemplate(user){
  const canCost=await can(user,'ViewCost'),cPrice=await can(user,'ChangeDefaultPrice');
  const head=['الكود','الاسم','القسم','القطع في الكرتونة',...(cPrice?['سعر القطعة']:[]),...(canCost?['التكلفة']:[]),'كراتين','قطع'];
  const ex=(a,b,c,d,e,f,g,h)=>['الكود','الاسم','القسم','القطع في الكرتونة',...(cPrice?['سعر القطعة']:[]),...(canCost?['التكلفة']:[]),'كراتين','قطع'].map((_,i)=>null).map((_,i,arr)=>null);
  const mk=(code,name,cat,ppc,price,cost,cart,pcs)=>[code,name,cat,ppc,...(cPrice?[price]:[]),...(canCost?[cost]:[]),cart,pcs];
  const rows=[head,mk('1001','مكنة فشار 1200 وات','أجهزة منزلية',12,350,300,2,5),mk('1002','منظف ملابس 3 لتر','منظفات',12,95,80,10,0)];
  const help=[['تعليمات الاستيراد'],['الأعمدة بتتعرف بالاسم. الأساسي: «الكود» و«الاسم». الباقي اختياري.'],['الكود: لو سبته فاضي والصنف جديد بيتولّد كود تلقائي. صنف كوده موجود = بيتحدّث، مش بيتكرر.'],
    ['الكمية: اكتب «كراتين» و«قطع» (بتتحسب بعدد القطع في الكرتونة) أو عمود «الكمية» بالقطعة. المخزن بتختاره في شاشة الاستيراد.'],['ممكن تحط عمود «رصيد: اسم المخزن» لكل مخزن لو عايز تدخّل كميات أكتر من مخزن في ملف واحد.'],
    ['قبل التنفيذ بتظهر معاينة بالجديد والتحديث والأخطاء — ومفيش حاجة بتتسجّل قبل ما تأكّد.'],['امسح الصفين الأمثلة قبل ما ترفع الملف.']];
  await saveBlob(writeXlsx([{name:'الأصناف',rows,widths:[16,34,16,14,12,12,10,10]},{name:'تعليمات',rows:help,widths:[110],header:false}]),'aliraqi-import-template.xlsx');
}

// ---------------- الاستيراد: قراءة وتصنيف ----------------
function parseSheet(rows,whs){
  let hr=-1,map=null;
  for(let i=0;i<Math.min(rows.length,10)&&hr<0;i++){
    const m={},wcols={};
    (rows[i]||[]).forEach((h,ci)=>{if(h==null)return;const t=String(h).trim(),w=/^(رصيد|stock)\s*[:：]\s*(.+)$/i.exec(t);
      if(w){const wh=whs.find(x=>norm(x.Name)===norm(w[2]));if(wh)wcols[ci]=wh.WarehouseID;return}
      const k=colKey(t);if(k&&m[k]==null)m[k]=ci});
    if(m.code!=null||m.name!=null){hr=i;map={...m,wcols}}
  }
  if(hr<0)throw new Error('مش لاقي صف العناوين — لازم يبقى فيه عمود «الكود» أو «الاسم»');
  const items=[];
  for(let i=hr+1;i<rows.length;i++){
    const r=rows[i]||[];if(!r.some(v=>v!=null&&String(v).trim()!==''))continue;
    const g=k=>map[k]!=null?r[map[k]]:null;
    items.push({rn:i+1,code:str(g('code')),name:str(g('name')),category:g('category')==null?null:str(g('category')),
      ppc:g('ppc')==null||g('ppc')===''?null:toNum(g('ppc')),price:g('price')==null||g('price')===''?null:toNum(g('price')),cost:g('cost')==null||g('cost')===''?null:toNum(g('cost')),
      qty:g('qty')==null||g('qty')===''?null:toNum(g('qty')),cartons:g('cartons')==null||g('cartons')===''?null:toNum(g('cartons')),loose:g('loose')==null||g('loose')===''?null:toNum(g('loose')),
      wq:Object.entries(map.wcols).map(([ci,wid])=>[wid,r[ci]]).filter(([,v])=>v!=null&&String(v).trim()!=='').map(([wid,v])=>[wid,toNum(v)])});
  }
  if(items.length>MAX_ROWS)throw new Error(`الملف فيه ${fmt(items.length)} صف — الحد الأقصى ${fmt(MAX_ROWS)} في المرة. قسّمه على ملفين.`);
  return{items,hasWhCols:Object.keys(map.wcols).length>0,hasGenericQty:map.qty!=null||map.cartons!=null||map.loose!=null,cols:map};
}
const isInt=n=>Number.isInteger(n);
function classify(parsed,ctx){
  const {prods,perms,mode,wh}=ctx,byCode=new Map(),byName=new Map();
  for(const p of prods){if(p.Deleted)continue;byCode.set(compact(p.Code),p);const k=norm(p.Name||'');byName.set(k,byName.has(k)?null:p)}
  const seen=new Set();
  return parsed.items.map(it=>{
    const out={...it,status:'same',msgs:[],changes:{},plan:{},p:null,err:null};
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
    if(p){
      const ch={};
      if(perms.edit){
        if(it.name&&it.name!==(p.Name||'')){if(it.name.length<2||it.name.length>120)return bad('اسم الصنف لازم من 2 لـ 120 حرف');ch.Name=it.name}
        if(it.category!=null&&it.category!==(p.Category||''))ch.Category=it.category;
        if(it.ppc!=null&&it.ppc!==(p.PcsPerCarton??null))ch.PcsPerCarton=it.ppc;
        if(perms.cost&&it.cost!=null&&r2(it.cost)!==(p.Cost??null))ch.Cost=r2(it.cost);
      }
      if(perms.price&&it.price!=null&&r2(it.price)!==(p.PricePiece??null))ch.PricePiece=r2(it.price);
      out.changes=ch;if(Object.keys(ch).length)out.status='update';
    }else{
      if(!perms.edit)return bad('مفيش صلاحية إضافة أصناف جديدة');
      if(!it.name||it.name.length<2)return bad('الاسم مطلوب للصنف الجديد (حرفين على الأقل)');
      if(it.name.length>120)return bad('الاسم أطول من 120 حرف');
      out.status='new';
    }
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
    if(perms.qty)for(const [wid,v] of Object.entries(plan)){if(mode==='add'&&v<=0)continue;out.plan[wid]=v}
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
        const rec=(await createProduct({user,data:{Name:r.name,Code:r.code,Category:r.category||'',PcsPerCarton:r.ppc,PricePiece:r.price!=null?r2(r.price):null,Cost:r.cost!=null?r2(r.cost):null}})).rec;
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
const FIELD_AR={Name:'الاسم',Category:'القسم',PcsPerCarton:'القطع/كرتونة',PricePiece:'سعر القطعة',Cost:'التكلفة'};
export async function showExcel(user,onBack){
  const [cView,cEdit,cIn,cAdj,cPrice,cCost]=await Promise.all(['ViewStock','EditProducts','StockIn','StockAdjust','ChangeDefaultPrice','ViewCost'].map(p=>can(user,p)));
  if(!cView&&!cEdit){toast('مفيش صلاحية');onBack();return}
  const whs=(await all('warehouses')).filter(w=>w.Active!==false);
  const out=el('div',{}),prev=el('div',{});
  const whSel=el('select',{'aria-label':'المخزن',onchange:()=>reclass()},whs.map(w=>el('option',{value:w.WarehouseID},w.Name)));
  whSel.value=pickWarehouse(whs)||whs[0]?.WarehouseID||'';
  const modeSel=el('select',{'aria-label':'وضع الكميات',onchange:()=>reclass()},
    cIn&&el('option',{value:'add'},'استلام — يضيف الكمية على الرصيد الحالي'),cAdj&&el('option',{value:'set'},'ضبط الرصيد (جرد) — الرصيد يبقى زي الملف'),el('option',{value:'none'},'بدون كميات (أصناف وأسعار بس)'));
  const file=el('input',{type:'file',accept:'.xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv',hidden:true,onchange:e=>{const f=e.target.files[0];e.target.value='';if(f)load(f)}});
  let parsed=null,rows=[],meta=null,busy=false;
  const perms={edit:cEdit,price:cPrice,cost:cCost&&cEdit,get qty(){return modeSel.value!=='none'}};
  function reclass(){if(!parsed)return;rows=classify(parsed,{prods:ctxProds,perms,mode:modeSel.value,wh:whSel.value});drawPreview()}
  let ctxProds=[];
  async function load(f){
    prev.replaceChildren(el('p',{class:'note'},'بنقرا الملف…'));
    try{
      if(f.size>MAX_BYTES)throw new Error('الملف كبير (الحد 8 ميجا)');
      const {rows:raw,bytes}=await readTableFile(f);
      parsed=parseSheet(raw,whs);ctxProds=await all('products');
      meta={name:f.name,hash:await sha(bytes)};
      if(parsed.hasWhCols&&cAdj)modeSel.value='set';else if(modeSel.value==='set'&&!cAdj)modeSel.value='add';
      if(![...modeSel.options].some(o=>o.value===modeSel.value))modeSel.value='none';
      reclass();
    }catch(e){parsed=null;rows=[];prev.replaceChildren(el('p',{class:'err'},e.message||'تعذر قراءة الملف'))}
  }
  function drawPreview(){
    const cnt={new:0,update:0,same:0,error:0};rows.forEach(r=>cnt[r.status]++);
    const qrows=rows.filter(r=>r.status!=='error'&&Object.keys(r.plan).length),mode=modeSel.value;
    const pcs=qrows.reduce((s,r)=>s+Object.values(r.plan).reduce((a,b)=>a+b,0),0);
    const actionable=rows.filter(r=>r.status==='new'||r.status==='update'||(r.status==='same'&&Object.keys(r.plan).length));
    const needWh=mode!=='none'&&rows.some(r=>r.status!=='error'&&(r.qty!=null||r.cartons!=null||r.loose!=null))&&!whSel.value;
    const badge=r=>({new:['bdg ok','جديد'],update:['bdg warn','تحديث'],same:['bdg','بدون تغيير'],error:['bdg no','خطأ']})[r.status];
    const line=r=>{const [c,t]=badge(r);const det=[];
      if(r.status==='update')det.push('هيتغيّر: '+Object.keys(r.changes).map(k=>FIELD_AR[k]).join('، '));
      if(r.status==='error')det.push(r.err);
      if(r.status!=='error'&&Object.keys(r.plan).length)det.push(Object.entries(r.plan).map(([w,q])=>`${whs.find(x=>x.WarehouseID===w)?.Name||''}: ${mode==='add'?'+':'→ '}${fmt(q)} قطعة`).join(' · '));
      return el('div',{class:'drow'},el('span',{},`${r.rn} · ${r.code||'(كود تلقائي)'} — ${r.name||r.p?.Name||''}`,det.length&&el('small',{dir:'auto',style:'display:block'},det.join(' | '))),el('b',{},el('span',{class:c},t)))};
    const go=el('button',{class:'btn',type:'button',disabled:busy||!actionable.length||needWh,onclick:()=>run()},actionable.length?`تنفيذ الاستيراد (${fmt(actionable.length)} صف)`:'مفيش حاجة تتنفّذ');
    prev.replaceChildren(
      el('div',{class:'ssum'},`${meta.name} — جديد ${fmt(cnt.new)} · تحديث ${fmt(cnt.update)} · بدون تغيير ${fmt(cnt.same)}`+(cnt.error?` · أخطاء ${fmt(cnt.error)}`:'')),
      mode!=='none'&&qrows.length>0&&el('p',{class:'note'},mode==='add'?`هيتسجّل استلام ${fmt(pcs)} قطعة على ${fmt(qrows.length)} صنف.`:`هتتسجّل تسوية جرد: الرصيد هيبقى زي الملف لـ ${fmt(qrows.length)} صنف (الفرق بيتسجّل كحركة وتقدر تلغيها من «مستندات المخزن»).`),
      !cEdit&&el('p',{class:'editwarn'},'مفيش معاك صلاحية تعديل الأصناف — الاستيراد هيسجّل الكميات بس.'),
      cEdit&&!cPrice&&parsed.cols.price!=null&&el('p',{class:'note'},'عمود السعر اتتجاهل (مفيش صلاحية تغيير الأسعار).'),
      cEdit&&!cCost&&parsed.cols.cost!=null&&el('p',{class:'note'},'عمود التكلفة اتتجاهل (مفيش صلاحية رؤية/تعديل التكلفة).'),
      needWh&&el('p',{class:'err'},'اختار المخزن للكميات.'),
      ...rows.filter(r=>r.status==='error').slice(0,30).map(line),...rows.filter(r=>r.status!=='error'&&(r.status!=='same'||Object.keys(r.plan).length)).slice(0,150).map(line),
      rows.length>180&&el('p',{class:'note'},'المعاينة بتعرض أول الصفوف بس — التنفيذ بيشمل كل الصفوف.'),go);
  }
  async function run(){
    if(busy)return;const mode=modeSel.value;
    const prevKey='xl_import:'+meta.hash,prevImp=await get('settings',prevKey).catch(()=>null);
    if(prevImp&&!window.confirm(`الملف ده (بنفس المحتوى) اتستورد قبل كده يوم ${new Date(prevImp.at).toLocaleString('en-GB')}. لو استوردته تاني ${mode==='add'?'الكميات هتتضاف مرة تانية':'هتتسجّل نفس الأصناف تاني'}. تكمّل؟`))return;
    if(!window.confirm('تنفيذ الاستيراد دلوقتي؟ الأصناف والكميات هتتسجّل وتتزامن.'))return;
    busy=true;drawPreview();
    const status=el('p',{class:'note'},'جاري التنفيذ…');prev.append(status);
    try{
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
    el('div',{class:'filters'},cView&&exBtn('📊 تصدير المخزون كله (Excel)',exportStock),(cEdit||cIn||cAdj)&&exBtn('📄 تحميل قالب استيراد فاضي',exportTemplate,'ghost')),
    (cEdit||cIn||cAdj)&&el('div',{},el('h3',{class:'sec'},'📥 استيراد من ملف'),
      el('p',{class:'note'},'ملف Excel (.xlsx) أو CSV. الأصناف الجديدة بتتضاف، والموجودة (بالكود) بتتحدّث بيانتها، والكميات بتتسجّل كاستلام أو جرد. بتشوف معاينة قبل ما حاجة تتسجّل.'),
      el('label',{class:'field'},el('span',{},'وضع الكميات'),modeSel),el('label',{class:'field'},el('span',{},'المخزن (للكميات اللي مش محددة بعمود «رصيد: …»)'),whSel),
      el('button',{class:'btn',type:'button',onclick:()=>file.click()},'📎 اختيار ملف'),file,out,prev)));
  if(!whs.length)prev.replaceChildren(el('p',{class:'editwarn'},'مفيش مخزن نشط — أضف مخزن من شاشة «المخازن» لو هتستورد كميات.'));
}
