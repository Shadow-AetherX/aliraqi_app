import {all,put,get} from './db.js';
import {can} from './auth.js';
import {$,el,toast,fmt} from './ui.js';

// ---------- استيراد الأصناف (إضافة فقط — عمره ما بيمسح ولا بيكتب فوق صنف موجود) ----------
export async function seedProducts(){
  let seed;
  try{const r=await fetch('products.json',{cache:'no-cache'});if(!r.ok)return 0;seed=await r.json()}catch{return 0}
  const st=await get('settings','products_seed');
  if(st&&st.version===seed.version)return 0;
  const have=new Set((await all('products')).map(p=>p.ProductID));
  let added=0;
  for(const p of seed.products){if(!have.has(p.ProductID)){await put('products',{...p,CreatedAt:new Date().toISOString(),UpdatedAt:null});added++}}
  await put('settings',{key:'products_seed',version:seed.version,at:new Date().toISOString(),added});
  return added;
}

// ---------- تطبيع البحث العربي ----------
export const norm=s=>String(s??'').toLowerCase().replace(/[\u064B-\u0652\u0640]/g,'').replace(/[أإآ]/g,'ا').replace(/ى/g,'ي').replace(/ة/g,'ه')
  .replace(/[٠-٩]/g,d=>'٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/\s+/g,' ').trim();
export const compact=s=>norm(s).replace(/[^a-z0-9\u0600-\u06ff]/g,'');

const PAGE=40;
export async function showProducts(user,onBack){
  const prods=(await all('products')).filter(p=>p.Active!==false).sort((a,b)=>a.SourceRow-b.SourceRow);
  const whs=(await all('warehouses')).filter(w=>w.Active);
  const canStock=await can(user,'ViewStock');
  const canEdit=(await can(user,'EditProducts'))||(await can(user,'ChangeDefaultPrice')),canCost=await can(user,'ViewCost');
  const stock=new Map();
  if(canStock) for(const m of await all('movements')){const o=stock.get(m.ProductID)||{};o[m.WarehouseID]=(o[m.WarehouseID]||0)+m.QuantityPieces;stock.set(m.ProductID,o)}
  function recompute(){
    const codeCount=new Map();prods.forEach(p=>codeCount.set(p.Code,(codeCount.get(p.Code)||0)+1));
    prods.forEach(p=>{p._hay=norm(p.Name+' '+p.Category+' '+p.Code+' '+(p.Description||''));p._code=compact(p.Code);p._dup=codeCount.get(p.Code)>1;p._noPrice=p.PricePiece==null});
  }
  recompute();
  // بعد تعديل صنف: نبدّل نسخته في الذاكرة ونعيد حساب البحث/الأكواد المكررة ونرسم القائمة تاني
  const hooks={user,canEdit,canCost,onEdit:rec=>{const i=prods.findIndex(x=>x.ProductID===rec.ProductID);if(i>=0)prods[i]=rec;recompute();render()}};
  const cats=[...new Set(prods.map(p=>p.Category).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ar'));
  const S={q:'',cat:'',avail:'all',review:false,shown:PAGE};

  const list=el('div',{class:'plist'}),count=el('div',{class:'pcount'}),more=el('button',{class:'btn ghost',onclick:()=>{S.shown+=PAGE;render()}},'عرض المزيد');
  const search=el('input',{type:'search',class:'psearch',placeholder:'ابحث بالاسم أو الكود…',autocomplete:'off','aria-label':'بحث في المنتجات'});
  let t;search.addEventListener('input',()=>{clearTimeout(t);t=setTimeout(()=>{S.q=search.value;S.shown=PAGE;render()},120)});
  const catSel=el('select',{'aria-label':'القسم',onchange:e=>{S.cat=e.target.value;S.shown=PAGE;render()}},el('option',{value:''},'كل الأقسام'),cats.map(c=>el('option',{value:c},c)));
  const avSel=el('select',{'aria-label':'التوفر',onchange:e=>{S.avail=e.target.value;S.shown=PAGE;render()}},
    el('option',{value:'all'},'الكل'),el('option',{value:'yes'},'متاح'),el('option',{value:'no'},'غير متاح'));
  const rv=el('label',{class:'chk'},el('input',{type:'checkbox',onchange:e=>{S.review=e.target.checked;S.shown=PAGE;render()}}),'محتاج مراجعة');

  function filtered(){
    const toks=norm(S.q).split(' ').filter(Boolean);
    let r=prods.filter(p=>(!S.cat||p.Category===S.cat)&&(S.avail==='all'||(S.avail==='yes')===p.Available)&&(!S.review||p._dup||p._noPrice||p.ReviewFlag)
      &&toks.every(k=>p._hay.includes(k)||p._code.includes(compact(k))));
    const q=compact(S.q);
    if(q) r.sort((a,b)=>(b._code===q)-(a._code===q)||(b._code.startsWith(q))-(a._code.startsWith(q)));
    return r;
  }
  function card(p){
    const img=p.Images[0]?el('img',{src:p.Images[0],alt:'',loading:'lazy',decoding:'async',referrerpolicy:'no-referrer'}):el('div',{class:'noimg'},'بدون صورة');
    const s=stock.get(p.ProductID);
    return el('article',{class:'pcard',tabindex:'0',role:'button','aria-label':p.Name,onclick:()=>details(p,hooks),onkeydown:e=>{if(e.key==='Enter')details(p,hooks)}},
      el('div',{class:'pimg'},img),
      el('div',{class:'pbody'},
        el('h3',{},p.Name||'(بدون اسم)'),
        el('div',{class:'pmeta'},el('span',{class:'code',dir:'ltr'},p.Code),el('span',{class:'cat'},p.Category)),
        el('div',{class:'pmeta'},el('span',{},p.PcsPerCarton?`${fmt(p.PcsPerCarton)} قطعة/كرتونة`:'عدد القطع غير محدد'),
          el('b',{},p.PriceCarton!=null?`${fmt(p.PriceCarton)} ج.م`:'بانتظار التسعير')),
        canStock&&el('div',{class:'pstock'},whs.map(w=>`${w.Name}: ${fmt((s&&s[w.WarehouseID])||0)}`).join(' · ')),
        el('div',{class:'badges'},el('span',{class:'bdg '+(p.Available?'ok':'no')},p.Available?'متاح':'غير متاح'),
          p._dup&&el('span',{class:'bdg warn'},'كود مكرر'))));
  }
  function render(){
    const r=filtered();list.replaceChildren(...r.slice(0,S.shown).map(card));
    count.textContent=`${fmt(r.length)} صنف`+(r.length!==prods.length?` من ${fmt(prods.length)}`:'');
    more.hidden=r.length<=S.shown;
    if(!r.length)list.replaceChildren(el('p',{class:'empty'},prods.length?'مفيش أصناف مطابقة للبحث ده':'لسه ما اتحملتش الأصناف — افتح التطبيق مرة وانت متصل بالإنترنت.'));
  }
  $('#app').replaceChildren(el('div',{class:'wrap'},
    el('div',{class:'hello'},el('h2',{},'المنتجات'),el('button',{class:'btn ghost',onclick:onBack},'رجوع')),
    search,el('div',{class:'filters'},catSel,avSel,rv),count,list,el('div',{class:'morewrap'},more)));
  render();
}

function details(p,hooks={}){
  let cur=0;const big=el('img',{class:'dbig',alt:'',decoding:'async',referrerpolicy:'no-referrer'});
  const thumbs=el('div',{class:'dthumbs'});
  const setImg=i=>{cur=i;big.src=p.Images[i]||'';[...thumbs.children].forEach((c,j)=>c.classList.toggle('on',j===i))};
  p.Images.forEach((u,i)=>thumbs.append(el('img',{src:u,alt:'',loading:'lazy',decoding:'async',referrerpolicy:'no-referrer',onclick:()=>setImg(i)})));
  const close=()=>{ov.remove();removeEventListener('keydown',esc)};const esc=e=>{if(e.key==='Escape')close()};addEventListener('keydown',esc);
  const row=(k,v)=>el('div',{class:'drow'},el('span',{},k),el('b',{dir:'auto'},v));
  const ov=el('div',{class:'overlay',role:'dialog','aria-modal':'true','aria-label':p.Name,onclick:e=>{if(e.target===ov)close()}},
    el('div',{class:'sheet'},
      el('div',{class:'shead'},el('h3',{},p.Name),el('button',{class:'x',onclick:close,'aria-label':'إغلاق'},'✕')),
      p.Images.length?el('div',{},big,p.Images.length>1&&thumbs):el('div',{class:'noimg tall'},'بدون صورة'),
      row('الكود',p.Code),row('القسم',p.Category||'—'),row('القطع في الكرتونة',fmt(p.PcsPerCarton)),
      row('سعر القطعة',p.PricePiece!=null?fmt(p.PricePiece)+' ج.م':'بانتظار التسعير'),row('سعر الكرتونة',p.PriceCarton!=null?fmt(p.PriceCarton)+' ج.م':'—'),
      hooks.canCost&&row('التكلفة',p.Cost!=null?fmt(p.Cost)+' ج.م':'—'),
      row('التوفر',p.Available?'متاح':'غير متاح'),p.Description&&row('الوصف',p.Description),
      p.ReviewFlag&&el('p',{class:'note'},'ملاحظة مراجعة: '+p.ReviewFlag),
      hooks.canEdit&&el('div',{class:'btnrow act'},el('button',{class:'btn',type:'button',onclick:async()=>{
        try{const m=await import('./product-edit.js');close();m.productForm({user:hooks.user,product:p,onSaved:hooks.onEdit})}
        catch{toast('تعذر فتح شاشة التعديل — أعد تحميل الصفحة وانت متصل')}}},'✏️ تعديل الصنف')),
      !hooks.canEdit&&el('p',{class:'note'},'تعديل الأصناف والأسعار للمدير/المالك بس.')));
  document.body.append(ov);if(p.Images.length)setImg(0);
}
