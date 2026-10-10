import {openDB,pendingCount,deviceId,all} from './db.js';
import {seedIfEmpty,refreshRoles,login,changePin,can} from './auth.js';
import {seedProducts,showProducts} from './products.js';
import {showStockDoc,showStockView} from './stock.js';
import {showStockDocs,backfillStockDocs} from './stockdocs.js';
import {showCustomers} from './customers.js';
import {showInvoices,showInvoiceNew} from './invoices.js';
import {showUsers} from './users.js';
import {showSyncCenter,startAutoSync,syncState,subscribe} from './sync.js';
import {showWarehouses,backfillWarehouses} from './warehouses.js';
import {showReports} from './reports.js';
import {showAuditLog} from './auditlog.js';
import {showSafety,protectStorage} from './safety.js';
import {$,el,toast} from './ui.js';
async function renderStatus(){
  const n=await pendingCount().catch(()=>0);const on=navigator.onLine;const ss=syncState();
  $('#statusBar').replaceChildren(
    el('span',{},el('i',{class:'dot'+(on?'':' off')}),on?'متصل':'أوفلاين — بياناتك محفوظة على الجهاز'),
    el('span',{},ss.running?(ss.phase==='pull'?`جاري سحب التحديثات… ${ss.pulled}`:`جاري المزامنة… ${ss.done}/${ss.total}`):n?`في انتظار المزامنة: ${n}`:'كل شيء متزامن'));
}
async function showLogin(){
  const users=(await all('users')).filter(u=>u.Active);
  const sel=el('select',{id:'uSel','aria-label':'المستخدم'},el('option',{value:'',selected:true},'[ اختر اسم المستخدم... ]'),users.map(u=>el('option',{value:u.UserID},u.Name)));
  const pin=el('input',{type:'password',inputmode:'numeric',autocomplete:'current-password',placeholder:'الرقم السري (PIN)'});
  const err=el('p',{class:'err'});
  const go=async()=>{err.textContent='';if(!sel.value){err.textContent='اختر اسم المستخدم';return}const r=await login(sel.value,pin.value);if(!r.ok){err.textContent=r.msg;return}
    r.user.MustChangePin?showChangePin(r.user):showDashboard(r.user)};
  sel.addEventListener('change',()=>{err.textContent='';pin.focus()});
  pin.addEventListener('keydown',e=>{if(e.key==='Enter')go()});
  $('#app').replaceChildren(el('div',{class:'login'},el('h1',{},'العراقي'),el('p',{},'تسجيل الدخول'),
    el('label',{class:'field'},el('span',{},'المستخدم'),sel),el('label',{class:'field'},el('span',{},'الرقم السري'),pin),
    el('button',{class:'btn',onclick:go},'دخول'),err));
}
function showChangePin(user){
  const p=el('input',{type:'password',inputmode:'numeric',placeholder:'رقم سري جديد (4 إلى 8 أرقام)'});const err=el('p',{class:'err'});
  $('#app').replaceChildren(el('div',{class:'login'},el('h1',{},'غيّر الرقم السري'),el('p',{},'ده أول دخول — اختار رقم سري خاص بيك.'),
    el('label',{class:'field'},el('span',{},'الرقم الجديد'),p),
    el('button',{class:'btn',onclick:async()=>{(await changePin(user,p.value))?showDashboard(user):err.textContent='لازم 4 لـ 8 أرقام ومش 0000'}},'حفظ'),err));
}
const PRIMARY=[['StockOut','📦','صرف من المخزن','STOCK OUT','green'],['CreateInvoice','🧾','عمل فاتورة','CREATE INVOICE',''],['StockIn','📥','استلام مخزون','STOCK IN','']];
const back=u=>()=>showDashboard(u);
// «العملاء»: من تفاصيل العميل زرار «إنشاء فاتورة» بيفتح فاتورة جديدة والعميل متحدد
const HANDLERS={
  'المنتجات':u=>showProducts(u,back(u)),
  'المخزون':u=>showStockView(u,back(u)),
  'مستندات المخزن':u=>showStockDocs(u,back(u)),
  'العملاء':u=>showCustomers(u,back(u),c=>showInvoiceNew(u,()=>showCustomers(u,back(u)),{customer:c})),
  'الفواتير':u=>showInvoices(u,back(u)),
  'المستخدمين':u=>showUsers(u,back(u)),
  'مركز المزامنة':u=>showSyncCenter(u,back(u)),
  'المخازن':u=>showWarehouses(u,back(u)),
  'نقل بين المخازن':u=>showStockDoc(u,'TR',back(u)),
  'التقارير':u=>showReports(u,back(u)),
  'سجل العمليات':u=>showAuditLog(u,back(u)),
  'الإعدادات':u=>showSafety(u,back(u))
};
const PRIM_H={StockIn:u=>showStockDoc(u,'IN',back(u)),StockOut:u=>showStockDoc(u,'OUT',back(u)),CreateInvoice:u=>showInvoiceNew(u,back(u))};
const MODULES=[['ViewProducts','المنتجات'],['ViewCustomers','العملاء'],['ViewStock','المخزون'],['ViewStock','مستندات المخزن'],['StockTransfer','نقل بين المخازن'],['ManageWarehouses','المخازن'],['CreateInvoice','الفواتير'],['ViewReports','التقارير'],['ManageUsers','المستخدمين'],['ManageRoles','الأدوار والصلاحيات'],['ViewAudit','سجل العمليات'],['ManageSync','مركز المزامنة'],['ManageSettings','الإعدادات']];
async function showDashboard(user){
  const soon=()=>toast('الشاشة دي لسه تحت التطوير');
  const prim=[];for(const[p,ic,ar,en,cls]of PRIMARY) if(await can(user,p)) prim.push(el('button',{class:'big '+cls,onclick:()=>(PRIM_H[p]||soon)(user)},el('span',{class:'ic'},ic),ar,el('small',{},en)));
  const tiles=[];for(const[p,ar]of MODULES) if(await can(user,p)) tiles.push(el('button',{class:'tile',onclick:()=>(HANDLERS[ar]||soon)(user)},ar));
  $('#app').replaceChildren(el('div',{class:'wrap'},
    el('div',{class:'hello'},el('h2',{},'أهلاً '+user.Name),el('button',{class:'btn ghost',onclick:showLogin},'خروج')),
    el('div',{class:'primary'},prim),el('div',{class:'grid'},tiles)));
}
async function boot(){
  await openDB();protectStorage().catch(()=>{});await seedIfEmpty();await refreshRoles();await seedProducts();await backfillStockDocs().catch(()=>{});await backfillWarehouses().catch(()=>{});deviceId();await renderStatus();
  subscribe(()=>renderStatus());startAutoSync();
  addEventListener('online',renderStatus);addEventListener('offline',renderStatus);setInterval(renderStatus,15000);
  if('serviceWorker' in navigator) {navigator.serviceWorker.register('sw.js').catch(()=>{});navigator.serviceWorker.addEventListener('controllerchange',()=>toast('تم تحديث التطبيق — أعد فتح الصفحة'))}
  showLogin();
}
boot();
