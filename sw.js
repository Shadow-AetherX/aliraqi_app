// تحديث الـ Service Worker بيغيّر الكاش بس — قاعدة البيانات (IndexedDB) مش بتتلمس أبداً
const VER='v23.6', SHELL_CACHE='alr-shell-'+VER, IMG_CACHE='alr-img-v1', IMG_MAX=400;   // v23.5: كاش الصور بقى له حد أقصى (الأقدم بيتشال) — قبل كده كان بيكبر من غير حد على الموبايل
// ملفات أساسية: لو واحد منها ناقص التثبيت يفشل (عشان نعرف). ملفات اختيارية: بتتحمّل لو موجودة بس.
const CORE=['./','index.html','manifest.json','icon.svg','products.json','css/app.css','css/invoice.css',
  'js/db.js','js/auth.js','js/ui.js','js/products.js','js/stock.js','js/scanner.js','js/customers.js','js/statement.js','js/invoices.js','js/invoice-pdf.js','js/reversal.js','js/stockdocs.js','js/adjust.js','js/users.js','js/sync.js','js/data-xl.js','js/xlsx-lite.js','js/qr-bulk.js','js/roles.js','js/session.js','js/reorder.js','js/warehouses.js','js/transfers.js','js/transfer-pdf.js','js/product-edit.js','js/product-new.js','js/help.js','js/reports.js','js/auditlog.js','js/safety.js','js/app.js','js/jsQR.js','js/qr.js','js/qrlabel.js','js/nav.js','js/devices.js','js/demo.js','js/guide.js'];
const OPTIONAL=['js/pdf-lib.min.js','fonts/invoice-regular.ttf','fonts/invoice-bold.ttf'];
self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil((async()=>{
  const c=await caches.open(SHELL_CACHE);
  await c.addAll(CORE);
  await Promise.all(OPTIONAL.map(u=>c.add(u).catch(()=>{})));
})())});
self.addEventListener('activate',e=>{e.waitUntil((async()=>{
  for(const k of await caches.keys()) if(k.startsWith('alr-shell-')&&k!==SHELL_CACHE) await caches.delete(k);
  await self.clients.claim()})())});
async function trimImg(c){try{const ks=await c.keys();for(let i=0;i<ks.length-IMG_MAX;i++)await c.delete(ks[i])}catch{}}   // الأقدم دخولاً أول (keys() بترجع بترتيب الإضافة)
const timeout=(ms)=>new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')),ms));
self.addEventListener('fetch',e=>{
  const req=e.request; if(req.method!=='GET')return;
  const url=new URL(req.url);
  if(url.origin===location.origin){
    // أونلاين: أحدث نسخة (no-cache عشان كاش GitHub Pages 10 دقايق ما يرجّعش ملف قديم) مع مهلة 3 ثواني، أوفلاين: من الكاش
    e.respondWith((async()=>{
      try{const res=await Promise.race([fetch(req,{cache:'no-cache'}),timeout(3000)]);
        if(res.ok){const cp=res.clone();caches.open(SHELL_CACHE).then(c=>c.put(req,cp))}return res}
      catch{return (await caches.match(req))||(await caches.match('index.html'))}})());
  }else if(req.destination==='image'){
    e.respondWith((async()=>{
      const c=await caches.open(IMG_CACHE),hit=await c.match(req.url);if(hit)return hit;
      try{const res=await fetch(req.url,{mode:'cors',referrerPolicy:'no-referrer'});
        if(res.ok){c.put(req.url,res.clone());trimImg(c);return res}}catch{}
      try{return await fetch(req)}catch{return Response.error()}})());
  }
});
