// كشف حساب العميل وتتبع الفواتير والمرتجعات والتحصيلات (v23).
// الرصيد = مبيعات (فواتير غير ملغاة) − مرتجعات − تحصيلات (+ رصيد افتتاحي إن وُجد). الفاتورة الملغاة بتتعرض (بسببها) بس مش بتدخل الحساب. مفيش حذف نهائي: التحصيل المتسجّل غلط بيتلغى بسبب (VOID نهائي) ويتسجّل غيره.
// التحصيلات في جدول payments (DB v5) وبتتزامن زي باقي الجداول. الصلاحيات (من غير صلاحية جديدة): عرض الكشف = ViewCustomers · تسجيل تحصيل = CreateInvoice · رصيد افتتاحي = EditCustomers · إلغاء تحصيل = CancelInvoice.
// الطباعة/PDF: نافذة طباعة المتصفح (احفظ كـ PDF). التصدير: Excel عبر xlsx-lite. الفاتورة المنفردة: نفس محرك invoice-pdf.js بتاع شاشة الفواتير.
import {all,get,byIndex,txRun,uuid,nowISO,deviceId,ymd} from './db.js';
import {can} from './auth.js';
import {$,el,toast,fmt,modal,askReason} from './ui.js';
import {liveLines} from './reversal.js';
import {showInvoiceView,showCreditNoteView} from './invoices.js';
import {writeXlsx} from './xlsx-lite.js';

const money=n=>Number(n||0).toLocaleString('en-US',{maximumFractionDigits:2});
const r2=n=>Math.round((Number(n)+Number.EPSILON)*100)/100;
const E=(msg,code,extra)=>Object.assign(new Error(msg),{code},extra);
const fdt=iso=>{if(!iso)return '—';const d=new Date(iso),p=n=>String(n).padStart(2,'0');return `${d.getFullYear()}/${p(d.getMonth()+1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const METHODS={CASH:'نقدي',TRANSFER:'تحويل',CHEQUE:'شيك',OTHER:'أخرى'};
const TYPE_AR={INV:'فاتورة',CN:'مرتجع',PAY:'تحصيل',OPEN:'رصيد افتتاحي'};
const MAX_AMT=1e9;
const qput=(t,entity,id,now)=>t.objectStore('syncq').put({OpID:uuid(),Entity:entity,EntityID:id,Status:'PENDING',CreatedAt:now,Tries:0});
const aud=(user,action,id,oldV,newV,notes,now,dev)=>({AuditID:uuid(),UserID:user.UserID,UserName:user.Name,Action:action,EntityType:'Payment',EntityID:id,DateTime:now,DeviceID:dev,
  OldValue:oldV==null?null:JSON.stringify(oldV),NewValue:newV==null?null:JSON.stringify(newV),Notes:notes||'',SyncStatus:'PENDING'});

// ================= التحصيلات (كتابة) =================
// kind: PAYMENT = تحصيل من العميل (بيقلّل المديونية) · OPENING = رصيد افتتاحي مديونية قديمة قبل استخدام التطبيق (مرة واحدة لكل عميل).
export async function recordPayment({customerId,amount,method='CASH',notes='',kind='PAYMENT',user:su}){
  const user=await get('users',su?.UserID);                                    // نعيد قراءة المستخدم من القاعدة مش من الجلسة
  if(!user||!user.Active)throw E('المستخدم غير متاح','FORBIDDEN');
  if(kind!=='PAYMENT'&&kind!=='OPENING')throw E('نوع غير صالح','BAD_KIND');
  if(!await can(user,kind==='OPENING'?'EditCustomers':'CreateInvoice'))throw E('مفيش صلاحية لتسجيل العملية دي','FORBIDDEN');
  const amt=r2(Number(amount));
  if(!Number.isFinite(amt)||amt<=0||amt>MAX_AMT)throw E('المبلغ لازم يبقى رقم أكبر من صفر','BAD_AMOUNT');
  if(!METHODS[method])throw E('طريقة الدفع غير صالحة','BAD_METHOD');
  notes=String(notes||'').trim().slice(0,160);
  const now=nowISO(),dev=deviceId(),id=uuid(),day=ymd(new Date(now));
  return txRun(['customers','payments','syncq','audit','settings'],(t,fail,setOut)=>{
    t.objectStore('customers').get(customerId).onsuccess=e=>{
      const c=e.target.result;if(!c)return fail(E('العميل مش موجود','NOT_FOUND'));
      t.objectStore('payments').index('CustomerID').getAll(customerId).onsuccess=e2=>{
        if(kind==='OPENING'&&e2.target.result.some(p=>p.Kind==='OPENING'&&p.Status!=='VOID'))return fail(E('العميل ده ليه رصيد افتتاحي بالفعل — الغيه الأول لو عايز تعدّله','DUP_OPENING'));
        const st=t.objectStore('settings'),key=`payseq:${dev}:${day}`;
        st.get(key).onsuccess=e3=>{
          const n=(e3.target.result?.value||0)+1;st.put({key,value:n});
          const number=`${kind==='OPENING'?'OB':'PAY'}-${day}-${dev.replace(/^D-/,'')}-${String(n).padStart(4,'0')}`;
          const p={PaymentID:id,Number:number,Kind:kind,CustomerID:c.CustomerID,CustomerName:c.Name,Amount:amt,Method:method,Notes:notes,DateTime:now,Status:'POSTED',
            UserID:user.UserID,UserName:user.Name,DeviceID:dev,UpdatedAt:now,SyncStatus:'PENDING'};
          t.objectStore('payments').put(p);qput(t,'payments',id,now);
          t.objectStore('audit').put(aud(user,kind==='OPENING'?'OPENING_BALANCE':'PAYMENT_CREATE',id,null,{number,customer:c.CustomerID,amount:amt,method},notes,now,dev));
          setOut(p);
        };
      };
    };
  });
}
export async function voidPayment({paymentId,reason,user:su}){
  const user=await get('users',su?.UserID);
  if(!user||!user.Active||!await can(user,'CancelInvoice'))throw E('مفيش صلاحية إلغاء التحصيل','FORBIDDEN');
  reason=String(reason||'').trim();if(reason.length<3)throw E('اكتب السبب (3 حروف على الأقل)','REASON');
  const now=nowISO(),dev=deviceId();
  return txRun(['payments','syncq','audit'],(t,fail,setOut)=>{
    t.objectStore('payments').get(paymentId).onsuccess=e=>{
      const p=e.target.result;if(!p)return fail(E('التحصيل مش موجود','NOT_FOUND'));
      if(p.Status==='VOID')return fail(E('التحصيل ملغي بالفعل','ALREADY_VOID'));
      const v={...p,Status:'VOID',VoidedAt:now,VoidedBy:user.UserID,VoidedByName:user.Name,VoidReason:reason,UpdatedAt:now,SyncStatus:'PENDING'};
      t.objectStore('payments').put(v);qput(t,'payments',paymentId,now);
      t.objectStore('audit').put(aud(user,'PAYMENT_VOID',paymentId,{Status:p.Status,amount:p.Amount},{Status:'VOID',number:p.Number},reason,now,dev));
      setOut(v);
    };
  });
}

// ================= حساب الكشف (قراءة بس) =================
// entry: {type:'INV'|'CN'|'PAY'|'OPEN', id, date, sortKey, number, void, side:'D'|'C', face, debit, credit, rec, balance}
// debit = بيزوّد المديونية (فاتورة/رصيد افتتاحي)، credit = بيقلّلها (مرتجع/تحصيل). الملغي face بس (debit=credit=0).
export async function buildStatement(customerId){
  const customer=await get('customers',customerId);
  const [invs,pays,allCn]=await Promise.all([byIndex('invoices','CustomerID',customerId),byIndex('payments','CustomerID',customerId),all('credit_notes')]);
  const entries=[];
  for(const i of invs){const v=i.Status==='VOID';entries.push({type:'INV',id:i.InvoiceID,date:i.DateTime,sortKey:i.DateTime,number:i.Number,void:v,side:'D',face:i.Total,debit:v?0:i.Total,credit:0,rec:i})}
  for(const c of allCn)if(c.CustomerID===customerId){const v=c.Status==='VOID';entries.push({type:'CN',id:c.CreditNoteID,date:c.DateTime,sortKey:c.DateTime,number:c.Number,void:v,side:'C',face:c.Total,debit:0,credit:v?0:c.Total,rec:c})}
  for(const p of pays){const v=p.Status==='VOID',op=p.Kind==='OPENING';
    entries.push({type:op?'OPEN':'PAY',id:p.PaymentID,date:p.DateTime,sortKey:op?'':p.DateTime,number:p.Number,void:v,side:op?'D':'C',face:p.Amount,debit:op&&!v?p.Amount:0,credit:!op&&!v?p.Amount:0,rec:p})}
  entries.sort((a,b)=>a.sortKey.localeCompare(b.sortKey)||a.date.localeCompare(b.date));
  let bal=0;for(const e of entries){bal=r2(bal+e.debit-e.credit);e.balance=bal}
  const sum=t=>r2(entries.filter(e=>e.type===t&&!e.void).reduce((s,e)=>s+e.face,0));
  const vInv=entries.filter(e=>e.type==='INV'&&e.void);
  const summary={sales:sum('INV'),returns:sum('CN'),paid:sum('PAY'),opening:sum('OPEN'),net:bal,voidedN:vInv.length,voidedAmt:r2(vInv.reduce((s,e)=>s+e.face,0))};
  return{customer,entries,summary,hasOpening:entries.some(e=>e.type==='OPEN'&&!e.void)};
}
// فرق بين نسختين من بنود الفاتورة (حسب الصنف): المضاف / المحذوف / اللي اتغيّرت كميته أو سعره
export function diffLines(a,b){
  const A=new Map((a||[]).filter(l=>!l.Superseded).map(l=>[l.ProductID,l])),B=new Map((b||[]).map(l=>[l.ProductID,l]));
  return{added:[...B].filter(([k])=>!A.has(k)).map(([,l])=>l),removed:[...A].filter(([k])=>!B.has(k)).map(([,l])=>l),
    changed:[...B].filter(([k,l])=>A.has(k)&&(A.get(k).TotalPieces!==l.TotalPieces||A.get(k).UnitPrice!==l.UnitPrice)).map(([k,l])=>({from:A.get(k),to:l}))};
}
// سجل تعديلات فاتورة: كل نسخة قديمة (invoice_revisions) مقارنة بالنسخة اللي بعدها (وآخر واحدة بالحالية). reason = سبب التعديل اللي عمل النسخة الأحدث
export async function editSteps(inv,liveLns){
  if((inv.Version||1)<=1)return[];
  const revs=(await byIndex('invoice_revisions','InvoiceID',inv.InvoiceID)).sort((a,b)=>a.Version-b.Version),steps=[];
  for(let i=0;i<revs.length;i++){
    const from=revs[i].Snapshot?.lines||[],to=i+1<revs.length?(revs[i+1].Snapshot?.lines||[]):liveLns;
    steps.push({version:revs[i].Version+1,at:revs[i].ReplacedAt,by:revs[i].UserName||'',reason:revs[i].Reason||'',...diffLines(from,to)});
  }
  return steps;
}
const lt=l=>`${fmt(l.TotalPieces)} × ${money(l.UnitPrice)}`;
export const stepLines=s=>[...s.added.map(l=>({k:'add',t:`➕ أضيف: ${l.Name} — ${lt(l)}`})),...s.removed.map(l=>({k:'del',t:`➖ اتحذف: ${l.Name} — ${lt(l)}`})),
  ...s.changed.map(x=>({k:'chg',t:`✏️ ${x.to.Name}: ${lt(x.from)} ← ${lt(x.to)}`}))];
const noteOf=e=>{
  const r=e.rec;
  if(e.type==='INV')return e.void?`ملغاة — السبب: ${r.VoidReason||'—'}${r.VoidedByName?' ('+r.VoidedByName+')':''}`:((r.Version||1)>1?`معدّلة (نسخة ${r.Version}) · ${fmt(r.ItemsCount)} صنف`:`${fmt(r.ItemsCount)} صنف · ${fmt(r.TotalPieces)} قطعة`);
  if(e.type==='CN')return `عن فاتورة ${r.ParentNumber||''} — السبب: ${r.Reason||'—'}`;
  if(e.void)return `ملغى — السبب: ${r.VoidReason||'—'}`;
  return [METHODS[r.Method]||'',r.Notes].filter(Boolean).join(' · ')||'—';
};

// ================= طباعة / تصدير =================
function printHtml(html){
  const f=document.createElement('iframe');
  f.setAttribute('aria-hidden','true');f.style.cssText='position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0';
  document.body.appendChild(f);
  const d=f.contentDocument;d.open();d.write(html);d.close();
  setTimeout(()=>{try{f.contentWindow.focus();f.contentWindow.print()}catch(e){toast('تعذرت الطباعة: '+(e.message||''))}setTimeout(()=>f.remove(),120000)},400);
}
async function saveBlob(blob,name){
  const file=new File([blob],name,{type:blob.type});
  if(navigator.canShare?.({files:[file]})){try{await navigator.share({files:[file],title:name});return}catch(e){if(e.name==='AbortError')return}}
  const u=URL.createObjectURL(blob),a=el('a',{href:u,download:name});document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),4000);
}
async function printDoc(doc,lines){                                            // فاتورة/مرتجع منفرد بنفس محرك شاشة الفواتير
  try{
    const {buildInvoiceFiles}=await import('./invoice-pdf.js'),f=await buildInvoiceFiles(doc,lines),u=URL.createObjectURL(f.pdf);
    if(!window.open(u,'_blank')){const a=el('a',{href:u,download:doc.Number+'.pdf'});document.body.append(a);a.click();a.remove()}
    setTimeout(()=>URL.revokeObjectURL(u),60000);
  }catch(e){toast('تعذر تجهيز الملف: '+(e.message||''))}
}
async function statementHtml(D,details){
  const co=(await get('settings','company'))||{},c=D.customer,S=D.summary,lm=new Map(),sm=new Map();
  if(details)for(const e of D.entries){
    if(e.void&&e.type!=='INV')continue;
    if(e.type==='INV'){const ls=await liveLines(e.id);if(!e.void)lm.set(e.id,ls);const st=await editSteps(e.rec,ls);if(st.length)sm.set(e.id,st)}
    else if(e.type==='CN')lm.set(e.id,(await byIndex('credit_note_lines','CreditNoteID',e.id)).sort((a,b)=>a.LineNo-b.LineNo));
  }
  const qty=l=>[l.Cartons?l.Cartons+' كرتونة':'',l.Pieces?l.Pieces+' قطعة':''].filter(Boolean).join(' + ')||fmt(l.TotalPieces)+' قطعة';
  const tr=e=>{
    const cls=e.void?' class="v"':'',sub=[];
    if(details){
      for(const l of lm.get(e.id)||[])sub.push(`${esc(l.Name)} (${esc(l.Code)}) — ${esc(qty(l))} × ${money(l.UnitPrice)} = ${money(l.LineTotal)}`);
      for(const s of sm.get(e.id)||[]){sub.push(`<b>تعديل نسخة ${s.version}</b> — ${esc(fdt(s.at))} — ${esc(s.by)} — السبب: ${esc(s.reason||'—')}`);for(const x of stepLines(s))sub.push('&nbsp;&nbsp;'+esc(x.t))}
    }
    return `<tr><td>${esc(fdt(e.date))}</td><td><b>${TYPE_AR[e.type]} ${e.type==='OPEN'?'':esc(e.number)}</b>${e.void?' <i>(ملغاة)</i>':''}<br><span class="n">${esc(noteOf(e))}</span>${sub.length?`<div class="s">${sub.join('<br>')}</div>`:''}</td>`+
      `<td${cls}>${e.side==='D'?money(e.face):''}</td><td${cls}>${e.side==='C'?money(e.face):''}</td><td>${money(e.balance)}</td></tr>`;
  };
  const lbl=S.net>0?'مستحق على العميل':S.net<0?'رصيد دائن للعميل':'مسدّد';
  const css='@page{size:A4;margin:12mm}html,body{margin:0;padding:0;background:#fff}body{font-family:Tahoma,"Segoe UI",Arial,sans-serif;font-size:11px;color:#000;direction:rtl}'+
    'h1{font-size:17px;margin:0}h2{font-size:14px;margin:8px 0 4px}.hd{display:flex;justify-content:space-between;border-bottom:2px solid #1b3a63;padding-bottom:6px;margin-bottom:8px}'+
    'table{width:100%;border-collapse:collapse}th,td{border:1px solid #999;padding:3px 5px;text-align:right;vertical-align:top}th{background:#eaf0f7}td:nth-child(n+3){white-space:nowrap;text-align:left;direction:ltr}'+
    'tr{page-break-inside:avoid}.v{color:#777;text-decoration:line-through}.n{color:#444;font-size:10px}.s{margin-top:3px;font-size:10px;color:#222;border-top:1px dotted #aaa;padding-top:2px}'+
    '.sum{display:flex;gap:8px;margin:8px 0}.sum div{flex:1;border:1px solid #999;padding:5px 8px}.sum b{display:block;font-size:13px}';
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>كشف حساب ${esc(c.Name)}</title><style>${css}</style></head><body>`+
    `<div class="hd"><div><h1>${esc(co.Name||'العراقي')}</h1>${esc(co.Phone||'')} ${esc(co.Address||'')}</div><div style="text-align:left"><h1>كشف حساب عميل</h1>${esc(fdt(nowISO()))}</div></div>`+
    `<h2>${esc(c.Name)}</h2>${esc(c.Phone||'')} ${esc(c.Address||'')}`+
    `<div class="sum"><div>إجمالي المبيعات<b>${money(S.sales)}</b></div><div>إجمالي المرتجعات<b>${money(S.returns)}</b></div><div>إجمالي التحصيلات<b>${money(S.paid)}</b></div>${S.opening?`<div>رصيد افتتاحي<b>${money(S.opening)}</b></div>`:''}<div>${lbl}<b>${money(Math.abs(S.net))} ج.م</b></div></div>`+
    `<table><thead><tr><th>التاريخ</th><th>البيان</th><th>مدين</th><th>دائن</th><th>الرصيد</th></tr></thead><tbody>${D.entries.map(tr).join('')||'<tr><td colspan="5">لا توجد حركات</td></tr>'}</tbody></table>`+
    `<p class="n">المدين = فواتير ورصيد افتتاحي · الدائن = مرتجعات وتحصيلات · الملغي ظاهر للتتبع وغير محسوب في الرصيد${S.voidedN?` (${S.voidedN} فاتورة ملغاة بقيمة ${money(S.voidedAmt)})`:''}.</p></body></html>`;
}
async function exportXlsx(D){
  const head=['التاريخ','النوع','الرقم','الحالة','البيان','مدين','دائن','الرصيد'];
  const rows=D.entries.map(e=>[fdt(e.date),TYPE_AR[e.type],e.type==='OPEN'?'':e.number,e.void?'ملغاة':'نشطة',noteOf(e),e.side==='D'?{v:e.face,s:'money'}:null,e.side==='C'?{v:e.face,s:'money'}:null,{v:e.balance,s:'money'}]);
  const S=D.summary,sum=[['العميل',D.customer.Name],['الهاتف',D.customer.Phone||''],['تاريخ الكشف',fdt(nowISO())],['إجمالي المبيعات',{v:S.sales,s:'money'}],['إجمالي المرتجعات',{v:S.returns,s:'money'}],['إجمالي التحصيلات',{v:S.paid,s:'money'}],
    ['رصيد افتتاحي',{v:S.opening,s:'money'}],['الصافي المستحق (موجب = على العميل)',{v:S.net,s:'money'}],['فواتير ملغاة (غير محسوبة)',`${S.voidedN} بقيمة ${money(S.voidedAmt)}`]];
  const safe=String(D.customer.Name).replace(/[^\w\u0600-\u06FF.-]+/g,'-').slice(0,30)||'customer';
  await saveBlob(writeXlsx([{name:'كشف الحساب',rows:[head,...rows],widths:[18,14,26,10,60,14,14,14]},{name:'ملخص',rows:sum,widths:[34,40],header:false}]),`statement-${safe}-${ymd()}.xlsx`);
}

// ================= الواجهة =================
const CSS=`.stm-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:12px 0}
.stm-card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:10px 12px}.stm-card span{display:block;font-size:.78rem;color:var(--muted)}.stm-card b{font-size:1.15rem;color:var(--navy)}
.stm-card.due{border-color:var(--danger);background:#fbeeed}.stm-card.due b{color:var(--danger)}.stm-card.ok b{color:var(--emerald)}
.stm-chips{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0}.stm-chips button{min-height:38px;padding:0 14px;border:1px solid var(--line);border-radius:999px;background:#fff;font-weight:700;color:var(--muted);cursor:pointer}
.stm-chips button.on{background:var(--navy);border-color:var(--navy);color:#fff}
.stm-wrap{overflow-x:auto;background:#fff;border:1px solid var(--line);border-radius:14px}.stm-t{width:100%;border-collapse:collapse;font-size:.85rem;min-width:640px}
.stm-t th,.stm-t td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:right;vertical-align:top}.stm-t th{background:var(--navy-soft);color:var(--navy)}
.stm-t tr.row{cursor:pointer}.stm-t tr.row:hover,.stm-t tr.row:focus-visible{background:#f3f7fb;outline:none}.stm-t small{display:block;color:var(--muted);font-size:.74rem}
.stm-t td.num{direction:ltr;text-align:left;white-space:nowrap;font-weight:700}.stm-t tr.void td{color:var(--muted)}.stm-t tr.void td.num{text-decoration:line-through}.stm-t td.bal.due{color:var(--danger)}
.stm-sub{font-size:.8rem;color:var(--muted);padding:2px 4px}.stm-step{border:1px solid var(--line);border-radius:12px;padding:8px 10px;margin:6px 0;font-size:.85rem}.stm-step small{display:block;color:var(--muted)}
.stm-add{color:#1f7a5a}.stm-del{color:var(--danger)}.stm-chg{color:#8a6100}`;
const css=()=>{if(!document.getElementById('stm-css'))document.head.append(el('style',{id:'stm-css'},CSS))};

export async function showStatement(user,customerId,onBack){
  if(!await can(user,'ViewCustomers')){toast('مفيش صلاحية عرض العملاء');onBack();return}
  const [cPay,cOpen,cVoid]=await Promise.all([can(user,'CreateInvoice'),can(user,'EditCustomers'),can(user,'CancelInvoice')]);
  css();
  const D=await buildStatement(customerId);
  if(!D.customer){toast('العميل مش موجود');onBack();return}
  const c=D.customer,S=D.summary,self=()=>showStatement(user,customerId,onBack);
  let filter='all';
  const row=(k,v)=>el('div',{class:'drow'},el('span',{},k),el('b',{dir:'auto'},v||'—'));
  const badges=e=>el('span',{class:'badges'},e.void&&el('span',{class:'bdg void'},'ملغاة'),e.type==='INV'&&!e.void&&(e.rec.Version||1)>1&&el('span',{class:'bdg edited'},'معدّلة'),e.type==='CN'&&el('span',{class:'bdg cn'},'مرتجع'),
    e.type==='OPEN'&&el('span',{class:'bdg warn'},'افتتاحي'));
  const FILTERS=[['all','الكل'],['INV','الفواتير'],['CN','المرتجعات'],['PAY','التحصيلات'],['VOID','الملغاة']];
  const pass=e=>filter==='all'||(filter==='VOID'?e.void:filter==='PAY'?(e.type==='PAY'||e.type==='OPEN'):e.type===filter);

  const netLbl=S.net>0?'الصافي المستحق على العميل':S.net<0?'رصيد دائن للعميل':'الحساب مسدّد';
  const card=(l,v,cls)=>el('div',{class:'stm-card'+(cls?' '+cls:'')},el('span',{},l),el('b',{},money(v)+' ج.م'));
  const cards=el('div',{class:'stm-cards'},card('إجمالي المبيعات',S.sales),card('إجمالي المرتجعات',S.returns),card('إجمالي التحصيلات',S.paid),S.opening>0&&card('رصيد افتتاحي',S.opening),
    card(netLbl,Math.abs(S.net),S.net>0?'due':'ok'));
  const chips=el('div',{class:'stm-chips',role:'group','aria-label':'تصفية الحركات'}),tbody=el('tbody',{});

  function trFor(e){
    const open=()=>openEntry(e);
    return el('tr',{class:'row'+(e.void?' void':''),tabindex:'0',role:'button',onclick:open,onkeydown:ev=>{if(ev.key==='Enter')open()}},
      el('td',{},fdt(e.date).slice(0,10),el('small',{},fdt(e.date).slice(11))),
      el('td',{},el('b',{},TYPE_AR[e.type]+(e.type==='OPEN'?'':' '+e.number)),' ',badges(e),el('small',{dir:'auto'},noteOf(e))),
      el('td',{class:'num'},e.side==='D'?money(e.face):''),el('td',{class:'num'},e.side==='C'?money(e.face):''),
      el('td',{class:'num bal'+(e.balance>0?' due':'')},money(e.balance)));
  }
  function draw(){
    chips.replaceChildren(...FILTERS.map(([k,l])=>el('button',{type:'button',class:k===filter?'on':'','aria-pressed':String(k===filter),onclick:()=>{filter=k;draw()}},l)));
    const rs=D.entries.filter(pass);
    tbody.replaceChildren(...(rs.length?rs.map(trFor):[el('tr',{},el('td',{colspan:'5',class:'empty'},D.entries.length?'مفيش حركات بالتصفية دي':'لسه مفيش حركات للعميل ده'))]));
  }

  // ---- تفاصيل حركة ----
  const lineRow=l=>el('div',{class:'drow'},el('span',{},`${l.Name} · ${l.Code} — ${[l.Cartons?l.Cartons+' كرتونة':'',l.Pieces?l.Pieces+' قطعة':''].filter(Boolean).join(' + ')||fmt(l.TotalPieces)+' قطعة'}`),
    el('b',{},`${money(l.UnitPrice)} × ${fmt(l.TotalPieces)} = ${money(l.LineTotal)}`));
  const stepNode=s=>el('div',{class:'stm-step'},el('b',{},`نسخة ${s.version} — ${fdt(s.at)}`),el('small',{},`${s.by} · السبب: ${s.reason||'—'}`),
    ...stepLines(s).map(x=>el('div',{class:'stm-'+x.k},x.t)),!stepLines(s).length&&el('small',{},'مفيش فرق في البنود'));
  async function invDetails(e){
    const inv=e.rec,lines=await liveLines(inv.InvoiceID),steps=await editSteps(inv,lines),cns=D.entries.filter(x=>x.type==='CN'&&x.rec.ParentInvoiceID===inv.InvoiceID),cl=new Map();
    for(const x of cns)cl.set(x.id,(await byIndex('credit_note_lines','CreditNoteID',x.id)).sort((a,b)=>a.LineNo-b.LineNo));
    const close=modal('فاتورة '+inv.Number,el('div',{class:'badges top'},badges(e)),
      e.void&&el('div',{class:'voidbox'},el('b',{},'فاتورة ملغاة'),row('تاريخ الإلغاء',fdt(inv.VoidedAt)),row('ألغاها',inv.VoidedByName),row('سبب الإلغاء',inv.VoidReason)),
      row('التاريخ',fdt(inv.DateTime)),row('الموظف',inv.UserName),row('الإجمالي',money(inv.Total)+' ج.م'+(e.void?' (غير محسوب في الرصيد)':'')),inv.Notes&&row('ملاحظة',inv.Notes),
      el('h3',{class:'sec'},'الأصناف'),...lines.map(lineRow),
      cns.length>0&&el('h3',{class:'sec'},'المرتجعات على الفاتورة'),
      ...cns.flatMap(x=>[el('div',{class:'drow'},el('span',{dir:'ltr'},x.number+' — '+fdt(x.date)),el('b',{},money(x.face)+' ج.م')),el('div',{class:'stm-sub'},'السبب: '+(x.rec.Reason||'—')),
        ...cl.get(x.id).map(l=>el('div',{class:'stm-sub'},`↩ ${l.Name} — ${fmt(l.TotalPieces)} قطعة × ${money(l.UnitPrice)}`))]),
      steps.length>0&&el('h3',{class:'sec'},'سجل التعديلات (المضاف والمحذوف)'),...steps.map(stepNode),
      el('div',{class:'btnrow act'},el('button',{class:'btn',type:'button',onclick:()=>{close();showInvoiceView(user,inv.InvoiceID,self)}},'فتح الفاتورة'),
        el('button',{class:'btn ghost',type:'button',onclick:()=>printDoc(inv,lines)},'🖨 طباعة الفاتورة')));
  }
  async function cnDetails(e){
    const cn=e.rec,lines=(await byIndex('credit_note_lines','CreditNoteID',cn.CreditNoteID)).sort((a,b)=>a.LineNo-b.LineNo);
    const close=modal('مرتجع '+cn.Number,row('عن الفاتورة',cn.ParentNumber),row('التاريخ',fdt(cn.DateTime)),row('الموظف',cn.UserName),row('إجمالي المرتجع',money(cn.Total)+' ج.م'),row('السبب',cn.Reason),
      el('h3',{class:'sec'},'الأصناف المرتجعة'),...lines.map(lineRow),
      el('div',{class:'btnrow act'},el('button',{class:'btn',type:'button',onclick:()=>{close();showCreditNoteView(user,cn.CreditNoteID,self)}},'فتح المرتجع'),
        el('button',{class:'btn ghost',type:'button',onclick:()=>printDoc({...cn,DocKind:'CREDIT'},lines)},'🖨 طباعة المرتجع'),
        el('button',{class:'btn ghost',type:'button',onclick:()=>{close();showInvoiceView(user,cn.ParentInvoiceID,self)}},'الفاتورة الأصلية')));
  }
  function payDetails(e){
    const p=e.rec;
    const close=modal((e.type==='OPEN'?'رصيد افتتاحي ':'تحصيل ')+p.Number,el('div',{class:'badges top'},badges(e)),
      e.void&&el('div',{class:'voidbox'},el('b',{},'ملغى'),row('تاريخ الإلغاء',fdt(p.VoidedAt)),row('ألغاه',p.VoidedByName),row('السبب',p.VoidReason)),
      row('التاريخ',fdt(p.DateTime)),row('المبلغ',money(p.Amount)+' ج.م'+(e.void?' (غير محسوب)':'')),e.type==='PAY'&&row('طريقة الدفع',METHODS[p.Method]),row('ملاحظة',p.Notes),row('سجّله',p.UserName),
      cVoid&&!e.void&&el('div',{class:'btnrow act'},el('button',{class:'btn ghost danger',type:'button',onclick:async()=>{
        const reason=await askReason('إلغاء '+(e.type==='OPEN'?'الرصيد الافتتاحي':'التحصيل'),'هيفضل محفوظ بختم «ملغى» وبيتشال من حساب العميل. مفيش حاجة بتتمسح.','تأكيد الإلغاء');
        if(!reason)return;
        try{await voidPayment({paymentId:p.PaymentID,reason,user});close();toast('تم الإلغاء');self()}catch(err){toast(typeof err.code==='string'?err.message:'تعذر الإلغاء — حاول تاني')}}},'🚫 إلغاء')));
  }
  const openEntry=e=>e.type==='INV'?invDetails(e):e.type==='CN'?cnDetails(e):payDetails(e);

  // ---- تسجيل تحصيل / رصيد افتتاحي ----
  function payForm(kind){
    const opening=kind==='OPENING';let warned=false;
    const amt=el('input',{type:'number',min:'0',step:'0.01',inputmode:'decimal',dir:'ltr',placeholder:'المبلغ (ج.م)','aria-label':'المبلغ'});
    const mth=el('select',{'aria-label':'طريقة الدفع'},Object.entries(METHODS).map(([k,v])=>el('option',{value:k},v)));
    const note=el('input',{type:'text',maxlength:'160',placeholder:opening?'ملاحظة (مثال: مديونية من الدفتر القديم)':'ملاحظة (اختياري — رقم الشيك/المحوّل منه)','aria-label':'ملاحظة'});
    const err=el('p',{class:'err'});
    const btn=el('button',{class:'btn',type:'button',onclick:async()=>{
      err.textContent='';const v=Number(amt.value);
      if(!(v>0)){err.textContent='اكتب المبلغ';return}
      if(!opening&&S.net>0&&v>S.net&&!warned){warned=true;err.textContent=`المبلغ أكبر من المستحق (${money(S.net)} ج.م) — هيبقى للعميل رصيد دائن. اضغط حفظ تاني للتأكيد.`;return}
      if(!opening&&S.net<=0&&!warned){warned=true;err.textContent='العميل ملوش مستحقات دلوقتي — التحصيل هيبقى رصيد دائن له. اضغط حفظ تاني للتأكيد.';return}
      btn.disabled=true;
      try{await recordPayment({customerId,amount:v,method:opening?'OTHER':mth.value,notes:note.value,kind,user});close();toast(opening?'تم تسجيل الرصيد الافتتاحي':'تم تسجيل التحصيل');self()}
      catch(e){btn.disabled=false;err.textContent=typeof e.code==='string'?e.message:'تعذر الحفظ على الجهاز. حاول تاني.'}}},'حفظ');
    const fill=!opening&&S.net>0?el('button',{class:'btn ghost',type:'button',onclick:()=>{amt.value=String(S.net)}},`المستحق كامل (${money(S.net)})`):null;
    const close=modal(opening?'رصيد افتتاحي (مديونية قديمة)':'تسجيل تحصيل — '+c.Name,
      opening&&el('p',{class:'note'},'ده المبلغ اللي كان على العميل قبل ما تستخدم التطبيق. بيتسجّل مرة واحدة وبيتحسب كمديونية في الكشف.'),
      el('label',{class:'field'},el('span',{},'المبلغ *'),amt),fill,!opening&&el('label',{class:'field'},el('span',{},'طريقة الدفع'),mth),el('label',{class:'field'},el('span',{},'ملاحظة'),note),err,btn);
    amt.focus();
  }

  const actions=el('div',{class:'btnrow act'},
    cPay&&el('button',{class:'btn',type:'button',onclick:()=>payForm('PAYMENT')},'💰 تسجيل تحصيل'),
    cOpen&&!D.hasOpening&&el('button',{class:'btn ghost',type:'button',onclick:()=>payForm('OPENING')},'📒 رصيد افتتاحي'),
    el('button',{class:'btn ghost',type:'button',onclick:async()=>{try{printHtml(await statementHtml(D,false))}catch(e){toast('تعذر تجهيز الكشف: '+(e.message||''))}}},'🖨 طباعة / PDF'),
    el('button',{class:'btn ghost',type:'button',onclick:async()=>{try{printHtml(await statementHtml(D,true));toast('اختار «حفظ كـ PDF» من نافذة الطباعة لو عايز ملف')}catch(e){toast('تعذر تجهيز الكشف: '+(e.message||''))}}},'🖨 طباعة بالتفاصيل'),
    el('button',{class:'btn ghost',type:'button',onclick:async ev=>{const b=ev.currentTarget;b.disabled=true;try{await exportXlsx(D)}catch(e){toast('تعذر التصدير: '+(e.message||''))}b.disabled=false}},'📊 Excel'));

  $('#app').replaceChildren(el('div',{class:'wrap'},
    el('div',{class:'hello'},el('h2',{},'كشف حساب — '+c.Name),el('button',{class:'btn ghost',type:'button',onclick:onBack},'رجوع')),
    el('div',{class:'pmeta'},el('span',{class:'code',dir:'ltr'},c.Phone||'بدون رقم'),el('span',{},c.Address||'')),
    cards,S.voidedN>0&&el('p',{class:'note'},`${fmt(S.voidedN)} فاتورة ملغاة بقيمة ${money(S.voidedAmt)} ج.م — ظاهرة للتتبع وغير محسوبة في الرصيد.`),
    actions,chips,el('div',{class:'stm-wrap'},el('table',{class:'stm-t'},el('thead',{},el('tr',{},['التاريخ','البيان','مدين','دائن','الرصيد'].map(h=>el('th',{},h)))),tbody)),
    el('p',{class:'note'},'المدين = فواتير ورصيد افتتاحي · الدائن = مرتجعات وتحصيلات. اضغط على أي حركة لتفاصيلها وسببها وطباعتها.')));
  draw();
}
