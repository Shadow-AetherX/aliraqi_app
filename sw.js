// تحديث الـ Service Worker بيغيّر الكاش بس — قاعدة البيانات (IndexedDB) مش بتتلمس أبداً
const VER='v14', SHELL_CACHE='alr-shell-'+VER, IMG_CACHE='alr-img-v1';
// ملفات أساسية: لو واحد منها ناقص التثبيت يفشل (عشان نعرف). ملفات اختيارية: بتتحمّل لو موجودة بس.
const CORE=['./','index.html','manifest.json','icon.svg','products.json','css/app.css','css/invoice.css',
  'js/db.js','js/auth.js','js/ui.js','js/products.js','js/stock.js','js/scanner.js','js/customers.js','js/invoices.js','js/invoice-pdf.js','js/reversal.js','js/stockdocs.js','js/users.js','js/sync.js','js/warehouses.js','js/transfers.js','js/transfer-pdf.js','js/product-edit.js','js/help.js','js/reports.js','js/auditlog.js','js/safety.js','js/app.js','js/jsQR.js'];
const OPTIONAL=['js/pdf-lib.min.js','fonts/invoice-regular.ttf','fonts/invoice-bold.ttf'];
self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil((async()=>{
  const c=await caches.open(SHELL_CACHE);
  await c.addAll(CORE);
  await Promise.all(OPTIONAL.map(u=>c.add(u).catch(()=>{})));
})())});
self.addEventListener('activate',e=>{e.waitUntil((async()=>{
  for(const k of await caches.keys()) if(k.startsWith('alr-shell-')&&k!==SHELL_CACHE) await caches.delete(k);
  await self.clients.claim()})())});
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
        if(res.ok){c.put(req.url,res.clone());return res}}catch{}
      try{return await fetch(req)}catch{return Response.error()}})());
  }
});
