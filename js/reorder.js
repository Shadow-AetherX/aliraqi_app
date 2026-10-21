// تنبيه إعادة الطلب (v20): الأصناف اللي رصيدها وصل للحد الأدنى أو خلص — بتظهر في الشاشة الرئيسية + شاشة كاملة بفلتر وتصدير Excel لطلبيات الشراء.
// القاعدة (قراءة بس، مفيش كتابة في القاعدة):
//  • صنف ليه «حد أدنى» (ReorderLevel رقم ≥ 0): بيظهر لما إجمالي رصيده (كل المخازن) ≤ الحد.
//  • صنف من غير حد أدنى: بيظهر بس لو اتحرّك قبل كده (عنده حركات في الدفتر) ورصيده دلوقتي صفر أو بالسالب — فالأصناف اللي عمرها ما دخلت المخزن ما تزحمش القائمة.
import {all,stockMap} from './db.js';
import {can} from './auth.js';
import {$,el,toast,fmt} from './ui.js';
import {writeXlsx} from './xlsx-lite.js';

const lvlOf=p=>Number.isFinite(p.ReorderLevel)&&p.ReorderLevel>=0?p.ReorderLevel:null;
export async function reorderItems(){
  const prods=(await all('products')).filter(p=>!p.Deleted&&p.Active!==false),sm=await stockMap(),out=[];
  for(const p of prods){
    const o=sm.get(p.ProductID),lvl=lvlOf(p),tot=o?Object.values(o).reduce((s,x)=>s+x,0):0;
    if(lvl!=null){if(tot<=lvl)out.push({p,total:tot,level:lvl})}
    else if(o&&tot<=0)out.push({p,total:tot,level:null});
  }
  // الأخطر الأول: الناقص/السالب، وبعدين الأقرب للصفر
  return out.sort((a,b)=>(a.total<=0?0:1)-(b.total<=0?0:1)||a.total-b.total||String(a.p.Name||'').localeCompare(String(b.p.Name||''),'ar'));
}
const state=i=>i.total<0?'بالسالب':i.total===0?'نفد':'تحت الحد الأدنى';
const cartons=i=>i.p.PcsPerCarton>0?Math.floor(Math.max(0,i.total)/i.p.PcsPerCarton):null;
const line=i=>el('div',{class:'drow'},
  el('span',{dir:'auto'},`${i.p.Code??''} — ${i.p.Name||''}`,el('small',{dir:'auto',style:'display:block'},[i.p.Category,i.level!=null?`الحد الأدنى ${fmt(i.level)}`:null].filter(Boolean).join(' · '))),
  el('b',{},`${state(i)} · ${fmt(i.total)}`+(cartons(i)!=null&&i.total>0?` (≈${fmt(cartons(i))} ك)`:'')));

// كارت الشاشة الرئيسية: بيتملي بعد ما الشاشة تظهر (القراءة من الحركات ممكن تاخد وقت) ويفضل مخفي لو مفيش تنبيهات
export async function fillReorderCard(box,onOpen){
  const items=await reorderItems();
  if(!items.length){box.replaceChildren();return}
  const zero=items.filter(i=>i.total<=0).length;
  box.replaceChildren(el('div',{class:'voidbox',role:'region','aria-label':'تنبيه إعادة الطلب'},
    el('b',{},`📉 ${fmt(items.length)} صنف محتاج إعادة طلب`+(zero?` — منهم ${fmt(zero)} نفد`:'')),
    ...items.slice(0,5).map(line),
    items.length>5&&el('p',{class:'note'},`وفيه ${fmt(items.length-5)} صنف تاني…`),
    el('button',{class:'btn ghost',type:'button',onclick:onOpen},'عرض الكل وتصدير Excel')));
}

function download(blob,name){
  const u=URL.createObjectURL(blob),a=document.createElement('a');a.href=u;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),4000);
}
export async function showReorder(user,onBack){
  if(!await can(user,'ViewStock')){toast('مفيش صلاحية عرض المخزون');onBack();return}
  const items=await reorderItems(),S={f:'all',q:''},list=el('div',{}),count=el('div',{class:'pcount'});
  const shown=()=>items.filter(i=>(S.f==='all'||(S.f==='zero')===(i.total<=0))&&(!S.q||`${i.p.Code} ${i.p.Name} ${i.p.Category||''}`.toLowerCase().includes(S.q)));
  function render(){const r=shown();list.replaceChildren(...(r.length?r.slice(0,300).map(line):[el('p',{class:'empty'},items.length?'مفيش أصناف مطابقة':'مفيش أصناف محتاجة إعادة طلب دلوقتي ✅')]));
    count.textContent=`${fmt(r.length)} صنف`+(r.length>300?' (بيظهر أول 300 — التصدير بيشمل الكل)':'')}
  const fsel=el('select',{'aria-label':'الفلتر',onchange:e=>{S.f=e.target.value;render()}},el('option',{value:'all'},'الكل'),el('option',{value:'zero'},'نفد (صفر أو بالسالب)'),el('option',{value:'low'},'تحت الحد الأدنى بس'));
  const search=el('input',{type:'search',class:'psearch',placeholder:'ابحث بالاسم أو الكود…',autocomplete:'off','aria-label':'بحث'});
  let t;search.addEventListener('input',()=>{clearTimeout(t);t=setTimeout(()=>{S.q=search.value.trim().toLowerCase();render()},120)});
  const exp=el('button',{class:'btn',type:'button',disabled:!items.length,onclick:()=>{
    const r=shown(),head=['الكود','الاسم','القسم','القطع في الكرتونة','الرصيد (قطعة)','الحد الأدنى','النقص عن الحد (قطعة)','الحالة'];
    const rows=r.map(i=>[String(i.p.Code??''),i.p.Name||'',i.p.Category||'',i.p.PcsPerCarton!=null?{v:i.p.PcsPerCarton,s:'int'}:null,{v:i.total,s:'int'},i.level!=null?{v:i.level,s:'int'}:null,i.level!=null?{v:Math.max(0,i.level-i.total),s:'int'}:null,state(i)]);
    const d=new Date(),p=n=>String(n).padStart(2,'0');
    try{download(writeXlsx([{name:'إعادة الطلب',rows:[head,...rows],widths:[16,34,16,12,12,12,14,16]}]),`aliraqi-reorder-${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}.xlsx`);toast(`تم تجهيز الملف (${fmt(r.length)} صنف)`)}
    catch(e){toast('تعذر تجهيز الملف')}}},'📊 تصدير القائمة (Excel)');
  $('#app').replaceChildren(el('div',{class:'wrap'},el('div',{class:'hello'},el('h2',{},'📉 إعادة الطلب'),el('button',{class:'btn ghost',type:'button',onclick:onBack},'رجوع')),
    el('p',{class:'note'},'الأصناف اللي رصيدها (كل المخازن) وصل للحد الأدنى أو خلص. الصنف اللي ما اتحدّدش له حد أدنى بيظهر بس لو رصيده صفر بعد ما كان اتحرّك.'),
    search,el('div',{class:'filters'},fsel),count,el('div',{class:'btnrow act'},exp),list));
  render();
}
