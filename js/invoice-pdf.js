// محرك الفاتورة A4 — شغال أوفلاين بالكامل.
// كل صفحة بتتحسب (ترقيم الصفحات بتاعنا) وبتترسم على canvas بحجم A4 (200 DPI)؛ المتصفح بيتولى تشكيل العربي واتجاه النص (BiDi)،
// وبعدين الصفحات بتتحط في PDF بمكتبة pdf-lib المحلية، وبنفس الصفحات بنطلّع صور للمشاركة على واتساب.
// نفس المحرك بيرسم: فاتورة بيع / إشعار مرتجع (inv.DocKind==='CREDIT') — وبيرسم ختم أحمر مائل «ملغاة» لو inv.Status==='VOID'. (مفيش أي شارة «معدّلة» في الـ PDF — دي للشاشة الداخلية بس.)
// الفاتورة اللي بتروح للعميل ما فيها: اسم الموظف / السعر الأصلي / التكلفة / الهامش / سجل العمليات.
export const COMPANY={name:'العراقي للاستيراد وتجارة الأدوات المنزلية',en:'AL-IRAQI HOME APPLIANCES',phone:'01105236152',
  address:'5 شارع سيد مازن، النزهة الجديدة، الهايكستب'};
const MM=200/25.4, mm=v=>v*MM, PW=Math.round(210*MM), PH=Math.round(297*MM);
const C={navy:'#1b3a63',green:'#1f9d76',ink:'#1a1f2b',mute:'#5b6577',line:'#d5dbe5',zebra:'#f3f6fb',head:'#e6edf7',white:'#ffffff',red:'#c62828'};
const FONT='ALRInvoice', MINROWS=3;
const X=mm(12), BOTTOM=PH-mm(16), TH=mm(8.5), Y1=mm(60), YC=mm(21), TOTALS_H=mm(54);
const FS=mm(3.5), LH=mm(5.2), PADV=mm(1.7), PADH=mm(1.8);
export const money=n=>Number(n||0).toLocaleString('en-US',{maximumFractionDigits:2});
const fdate=iso=>{const d=new Date(iso),p=n=>String(n).padStart(2,'0');return `${d.getFullYear()}/${p(d.getMonth()+1)}/${p(d.getDate())}  ${p(d.getHours())}:${p(d.getMinutes())}`};
const here=f=>new URL(f,import.meta.url).href;

let _fonts,_pdfLib;
export function loadInvoiceFonts(){
  return _fonts||(_fonts=(async()=>{
    const get=async n=>{const r=await fetch(here('../fonts/'+n));if(!r.ok)throw new Error('الخط ناقص: fonts/'+n);return r.arrayBuffer()};
    const [rg,bd]=await Promise.all([get('invoice-regular.ttf'),get('invoice-bold.ttf')]);
    const a=new FontFace(FONT,rg,{weight:'400'}),b=new FontFace(FONT,bd,{weight:'700'});
    await Promise.all([a.load(),b.load()]);document.fonts.add(a);document.fonts.add(b);
  })().catch(e=>{_fonts=null;throw e}));
}
export function loadPdfLib(){
  if(window.PDFLib) return Promise.resolve();
  return _pdfLib||(_pdfLib=new Promise((res,rej)=>{const s=document.createElement('script');s.src=here('./pdf-lib.min.js');
    s.onload=()=>window.PDFLib?res():rej(new Error('pdf-lib'));s.onerror=()=>{_pdfLib=null;rej(new Error('ملف js/pdf-lib.min.js مش موجود'))};document.head.append(s)}));
}
const font=(w,s)=>`${w} ${s}px ${FONT}, sans-serif`;

function wrap(ctx,text,maxW){
  const out=[];
  for(const para of String(text??'').split('\n')){
    let cur='';
    for(const w of para.split(/\s+/).filter(Boolean)){
      const t=cur?cur+' '+w:w;
      if(ctx.measureText(t).width<=maxW){cur=t;continue}
      if(cur)out.push(cur);
      if(ctx.measureText(w).width<=maxW){cur=w;continue}
      let part='';for(const ch of w){if(ctx.measureText(part+ch).width>maxW&&part){out.push(part);part=ch}else part+=ch}cur=part;
    }
    out.push(cur);
  }
  return out.length?out:[''];
}
// الأعمدة بتتحدد حسب المستخدم فعلاً: كراتين/قطع بيختفوا لو مش مستخدمين، وسعر الكرتونة بيحل محل سعر القطعة لو الفاتورة كلها كراتين
export function columnsFor(lines){
  const hasC=lines.some(l=>l.Cartons>0),hasP=lines.some(l=>l.Pieces>0),cartonOnly=hasC&&!hasP;
  const cols=[{k:'no',t:'م',w:8,al:'c',ltr:1},{k:'code',t:'الكود',w:21,al:'c',wrap:1},{k:'name',t:'الصنف',w:0,al:'r',wrap:1}];
  if(hasC)cols.push({k:'cartons',t:'كراتين',w:15,al:'c',ltr:1});
  if(hasP)cols.push({k:'pieces',t:'قطع',w:14,al:'c',ltr:1});
  if(hasC&&hasP)cols.push({k:'tp',t:'إجمالي القطع',w:25,al:'c',ltr:1});
  cols.push({k:'price',t:cartonOnly?'سعر الكرتونة':'سعر القطعة',w:26,al:'c',ltr:1});
  cols.push({k:'total',t:'الإجمالي',w:27,al:'c',ltr:1});
  const tableW=PW-2*X;let cur=PW-X;
  const fixed=cols.reduce((s,c)=>s+mm(c.w),0);
  for(const c of cols){c.pw=c.w?mm(c.w):tableW-fixed;c.x1=cur;c.x0=cur-c.pw;cur=c.x0}
  return {cols,cartonOnly};
}
function makeRows(lines,cols,cartonOnly){
  const m=document.createElement('canvas').getContext('2d');m.font=font(400,FS);
  return lines.map((l,i)=>{
    const price=cartonOnly?Math.round(l.UnitPrice*(l.PcsPerCarton||0)*100)/100:l.UnitPrice;
    const v={no:String(i+1),code:l.Code,name:l.Name,cartons:l.Cartons?String(l.Cartons):'',pieces:l.Pieces?String(l.Pieces):'',
      tp:String(l.TotalPieces),price:money(price),total:money(l.LineTotal)};
    const lines_={};let n=1;
    for(const c of cols)if(c.wrap){lines_[c.k]=wrap(m,v[c.k],c.pw-2*PADH);n=Math.max(n,lines_[c.k].length)}
    return {v,lines:lines_,h:n*LH+2*PADV};
  });
}
// ترقيم الصفحات: الصف عمره ما بيتقسم، العنوان بيتكرر، وآخر صفحة فيها ≥3 صفوف + الإجماليات + بيانات الشركة
export function paginate(rows,availFirst,availOther,totalsH){
  const sum=a=>a.reduce((s,r)=>s+r.h,0),N=rows.length;
  if(sum(rows)+totalsH<=availFirst) return [rows];
  const greedy=rs=>{const pages=[];let cur=[],used=0,cap=availFirst;
    for(const r of rs){if(used+r.h>cap&&cur.length){pages.push(cur);cur=[];used=0;cap=availOther}cur.push(r);used+=r.h}
    if(cur.length)pages.push(cur);return pages};
  let pages=greedy(rows);
  const last=pages[pages.length-1],cap=pages.length===1?availFirst:availOther;
  const bad=sum(last)+totalsH>cap||(last.length<MINROWS&&N>=MINROWS&&pages.length>1);
  if(bad||pages.length===1){
    // أقل تعديل ممكن: نكمّل آخر صفحة لـ3 صفوف من اللي قبلها، ولو الإجماليات مش داخلة نشيل صفوف من أولها لحد ما تدخل (مش أقل من 3)
    const tail=[...last],rest=rows.slice(0,N-last.length);
    while(tail.length<MINROWS&&rest.length)tail.unshift(rest.pop());
    while(sum(tail)+totalsH>availOther&&tail.length>MINROWS)rest.push(tail.shift());
    pages=rest.length?[...greedy(rest),tail]:[rows];
  }
  return pages;
}
export const layoutInvoice=(inv,lines)=>{
  const {cols,cartonOnly}=columnsFor(lines),rows=makeRows(lines,cols,cartonOnly);
  const pages=paginate(rows,BOTTOM-Y1-TH,BOTTOM-YC-TH,TOTALS_H);
  return {cols,pages};
};

function T(ctx,s,x,y,{al='right',dir='rtl',f=font(400,FS),color=C.ink}={}){ctx.font=f;ctx.fillStyle=color;ctx.textAlign=al;ctx.direction=dir;ctx.textBaseline='middle';ctx.fillText(s,x,y)}
const hasLatinOnly=s=>!/[\u0600-\u06FF]/.test(s);

// ختم «ملغاة»: مستطيل + نص أحمر مائل بشفافية عشان الفاتورة تفضل مقروءة تحته
function drawVoidStamp(ctx){
  const label='ملغاة',h=mm(30);
  ctx.save();ctx.translate(PW/2,PH*0.46);ctx.rotate(-Math.PI/6);ctx.globalAlpha=0.5;
  ctx.font=font(700,h);ctx.direction='rtl';ctx.textAlign='center';ctx.textBaseline='middle';
  const w=ctx.measureText(label).width;
  ctx.strokeStyle=C.red;ctx.fillStyle=C.red;ctx.lineWidth=mm(2);
  ctx.strokeRect(-w/2-mm(12),-h*0.8,w+mm(24),h*1.6);
  ctx.fillText(label,0,0);
  ctx.restore();
}
function drawPage(inv,lines,cols,rows,idx,total){
  const credit=inv.DocKind==='CREDIT';
  const cv=document.createElement('canvas');cv.width=PW;cv.height=PH;const ctx=cv.getContext('2d');
  ctx.fillStyle=C.white;ctx.fillRect(0,0,PW,PH);
  const first=idx===0,last=idx===total-1;
  // ----- ترويسة -----
  if(first){
    ctx.fillStyle=C.navy;ctx.fillRect(0,0,PW,mm(28));ctx.fillStyle=C.green;ctx.fillRect(0,mm(28),PW,mm(1.6));
    T(ctx,COMPANY.name,PW-X,mm(11),{f:font(700,mm(6.2)),color:C.white});
    T(ctx,COMPANY.en,PW-X,mm(20),{f:font(400,mm(3.6)),color:'#c9d6ea',dir:'ltr',al:'right'});
    T(ctx,credit?'إشعار مرتجع':'فاتورة بيع',X,mm(14),{al:'left',f:font(700,mm(7)),color:C.white});
    if(credit&&inv.ParentNumber){const f=font(400,mm(3.4));ctx.font=f;const nw=ctx.measureText(inv.ParentNumber).width;
      T(ctx,inv.ParentNumber,X,mm(22),{al:'left',dir:'ltr',f,color:'#c9d6ea'});T(ctx,'عن فاتورة',X+nw+mm(2.5),mm(22),{al:'left',dir:'rtl',f,color:'#c9d6ea'})}
    // بيانات العميل والفاتورة
    ctx.fillStyle=C.zebra;ctx.fillRect(X,mm(34),PW-2*X,mm(21));ctx.strokeStyle=C.line;ctx.lineWidth=2;ctx.strokeRect(X,mm(34),PW-2*X,mm(21));
    const lab=(t,y)=>T(ctx,t,PW-X-mm(3),y,{f:font(700,FS),color:C.mute});
    lab('العميل:',mm(40));{ctx.font=font(700,mm(4));let nm=inv.CustomerName||'';while(nm.length>3&&ctx.measureText(nm).width>mm(72))nm=nm.slice(0,-2);if(nm!==(inv.CustomerName||''))nm=nm.trim()+'…';T(ctx,nm,PW-X-mm(24),mm(40),{f:font(700,mm(4)),dir:'rtl'})}
    lab('الهاتف:',mm(47));T(ctx,inv.CustomerPhone||'—',PW-X-mm(24),mm(47),{dir:'ltr'});
    if(inv.CustomerAddress)T(ctx,inv.CustomerAddress,PW-X-mm(3),mm(52.2),{f:font(400,mm(3)),color:C.mute});
    const mx=X+mm(94);
    T(ctx,'رقم الفاتورة:',mx,mm(40),{al:'right',f:font(700,FS),color:C.mute});T(ctx,inv.Number,X+mm(3),mm(40),{al:'left',dir:'ltr',f:font(700,mm(3.7))});
    T(ctx,'التاريخ:',mx,mm(47),{al:'right',f:font(700,FS),color:C.mute});T(ctx,fdate(inv.DateTime),X+mm(3),mm(47),{al:'left',dir:'ltr'});
  }else{
    ctx.fillStyle=C.navy;ctx.fillRect(0,0,PW,mm(14));
    T(ctx,COMPANY.name,PW-X,mm(7),{f:font(700,mm(4.6)),color:C.white});
    {const f=font(700,mm(3.8));ctx.font=f;const nw=ctx.measureText(inv.Number).width;T(ctx,inv.Number,X,mm(7),{al:'left',dir:'ltr',f,color:C.white});T(ctx,credit?'إشعار مرتجع رقم':'فاتورة رقم',X+nw+mm(2.5),mm(7),{al:'left',dir:'rtl',f,color:C.white})}
  }
  // ----- رأس الجدول -----
  let y=first?Y1:YC;
  ctx.fillStyle=C.head;ctx.fillRect(X,y,PW-2*X,TH);
  for(const c of cols)T(ctx,c.t,c.al==='r'?c.x1-PADH:(c.x0+c.x1)/2,y+TH/2,{al:c.al==='r'?'right':'center',f:font(700,mm(3.3)),color:C.navy});
  y+=TH;
  // ----- الصفوف -----
  rows.forEach((r,i)=>{
    if(i%2)  {ctx.fillStyle=C.zebra;ctx.fillRect(X,y,PW-2*X,r.h)}
    for(const c of cols){
      const cy=y+PADV+LH/2;
      if(c.wrap){const ls=r.lines[c.k];ls.forEach((ln,j)=>T(ctx,ln,c.al==='r'?c.x1-PADH:(c.x0+c.x1)/2,cy+j*LH,{al:c.al==='r'?'right':'center',dir:(c.k==='code'&&hasLatinOnly(ln))?'ltr':'rtl'}))}
      else T(ctx,r.v[c.k],(c.x0+c.x1)/2,y+r.h/2,{al:'center',dir:'ltr',f:font(c.k==='total'?700:400,FS)});
    }
    ctx.strokeStyle=C.line;ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(X,y+r.h);ctx.lineTo(PW-X,y+r.h);ctx.stroke();
    y+=r.h;
  });
  // حدود الأعمدة
  ctx.strokeStyle=C.line;ctx.lineWidth=1.5;
  const top=(first?Y1:YC),bot=y;
  for(const c of cols){ctx.beginPath();ctx.moveTo(c.x0,top);ctx.lineTo(c.x0,bot);ctx.stroke()}
  ctx.beginPath();ctx.moveTo(PW-X,top);ctx.lineTo(PW-X,bot);ctx.stroke();
  // ----- آخر صفحة: الإجماليات + بيانات الشركة -----
  if(last){
    y+=mm(7);const bh=mm(36),half=(PW-2*X-mm(8))/2;
    // إجماليات (شمال)
    const tx=X;ctx.fillStyle=C.zebra;ctx.fillRect(tx,y,half,bh);ctx.strokeStyle=C.line;ctx.strokeRect(tx,y,half,bh);
    const pcs=lines.reduce((s,l)=>s+l.TotalPieces,0);
    const rowT=(a,b,yy)=>{T(ctx,a,tx+half-mm(3),yy,{f:font(400,FS),color:C.mute});T(ctx,b,tx+mm(3),yy,{al:'left',dir:'ltr'})};
    rowT('عدد الأصناف',String(lines.length),y+mm(6));rowT('إجمالي القطع',money(pcs),y+mm(13));
    ctx.fillStyle=C.green;ctx.fillRect(tx,y+mm(19),half,bh-mm(19));
    T(ctx,credit?'إجمالي المرتجع':'إجمالي الفاتورة',tx+half-mm(3),y+mm(27.5),{f:font(700,mm(4.2)),color:C.white});
    {const f=font(700,mm(5.4));ctx.font=f;const nw=ctx.measureText(money(inv.Total)).width;T(ctx,money(inv.Total),tx+mm(3),y+mm(27.5),{al:'left',dir:'ltr',f,color:C.white});T(ctx,'ج.م',tx+mm(3)+nw+mm(2),y+mm(27.5),{al:'left',dir:'rtl',f:font(700,mm(4)),color:C.white})}
    // بيانات الشركة (يمين)
    const cx=X+half+mm(8);ctx.fillStyle=C.white;ctx.fillRect(cx,y,half,bh);ctx.strokeStyle=C.navy;ctx.lineWidth=3;ctx.strokeRect(cx,y,half,bh);
    T(ctx,'للتواصل والطلبات',cx+half-mm(3),y+mm(6),{f:font(700,mm(4)),color:C.navy});
    T(ctx,'واتساب / تليفون:',cx+half-mm(3),y+mm(14),{f:font(400,mm(3.2)),color:C.mute});
    T(ctx,COMPANY.phone,cx+mm(3),y+mm(14),{al:'left',dir:'ltr',f:font(700,mm(4))});
    T(ctx,'العنوان:',cx+half-mm(3),y+mm(21.5),{f:font(400,mm(3.2)),color:C.mute});
    const m=ctx.measureText?ctx:null;ctx.font=font(400,mm(3.2));
    wrap(ctx,COMPANY.address,half-mm(6)).forEach((ln,j)=>T(ctx,ln,cx+half-mm(3),y+mm(27.5)+j*mm(4.4),{f:font(400,mm(3.2))}));
    T(ctx,'شكراً لتعاملكم معنا',PW/2,y+bh+mm(8),{al:'center',f:font(700,mm(3.8)),color:C.navy});
  }
  // ----- تذييل -----
  ctx.strokeStyle=C.line;ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(X,PH-mm(11));ctx.lineTo(PW-X,PH-mm(11));ctx.stroke();
  T(ctx,`صفحة ${idx+1} من ${total}`,PW/2,PH-mm(7),{al:'center',f:font(400,mm(3.1)),color:C.mute});
  T(ctx,inv.Number,PW-X,PH-mm(7),{dir:'ltr',f:font(400,mm(3)),color:C.mute});
  T(ctx,COMPANY.phone,X,PH-mm(7),{al:'left',dir:'ltr',f:font(400,mm(3)),color:C.mute});
  if(inv.Status==='VOID')drawVoidStamp(ctx);       // الختم على كل الصفحات (معاينة + طباعة + PDF)
  return cv;
}
export async function renderInvoicePages(inv,lines){
  await loadInvoiceFonts();
  const {cols,pages}=layoutInvoice(inv,lines);
  return pages.map((rows,i)=>drawPage(inv,lines,cols,rows,i,pages.length));
}
export const canvasToBlob=(c,type='image/jpeg',q=0.92)=>new Promise((res,rej)=>c.toBlob(b=>b?res(b):rej(new Error('تعذر إنشاء الصورة')),type,q));
export async function buildInvoiceFiles(inv,lines){
  const canvases=await renderInvoicePages(inv,lines);await loadPdfLib();
  const {PDFDocument}=window.PDFLib,doc=await PDFDocument.create(),W=595.28,H=841.89,images=[];
  doc.setTitle((inv.DocKind==='CREDIT'?'إشعار مرتجع ':'فاتورة ')+inv.Number);doc.setCreator('AL-IRAQI');doc.setProducer('AL-IRAQI');
  for(const c of canvases){
    const jpg=await canvasToBlob(c);images.push(jpg);
    const img=await doc.embedJpg(await jpg.arrayBuffer()),pg=doc.addPage([W,H]);pg.drawImage(img,{x:0,y:0,width:W,height:H});
  }
  const bytes=await doc.save();
  return {pdf:new Blob([bytes],{type:'application/pdf'}),images,pages:canvases.length};
}
