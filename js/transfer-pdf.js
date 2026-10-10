// مستند تحويل المخزون A4 (v11) — نفس أسلوب invoice-pdf.js: canvas بحجم A4 (200 DPI) + pdf-lib المحلية، شغال أوفلاين.
// مستند داخلي: من غير أسعار. فيه: المخزن المصدر/الوجهة، الأصناف والكميات بالقطعة، وخانة توقيع المسلِّم والمستلِم. وبيرسم ختم «ملغاة» لو doc.Status==='VOID'.
import {COMPANY,loadInvoiceFonts,canvasToBlob,loadPdfLib} from './invoice-pdf.js';
import {el,toast} from './ui.js';

const MM=200/25.4,mm=v=>v*MM,PW=Math.round(210*MM),PH=Math.round(297*MM);
const C={navy:'#1b3a63',green:'#1f9d76',ink:'#1a1f2b',mute:'#5b6577',line:'#d5dbe5',zebra:'#f3f6fb',head:'#e6edf7',white:'#ffffff',red:'#c62828'};
const FONT='ALRInvoice',X=mm(12),BOTTOM=PH-mm(16),TH=mm(8.5),Y1=mm(70),YC=mm(21),FOOT_H=mm(60);
const FS=mm(3.5),LH=mm(5.2),PADV=mm(1.7),PADH=mm(1.8);
const font=(w,s)=>`${w} ${s}px ${FONT}, sans-serif`;
const num=n=>Number(n||0).toLocaleString('en-US');
const fdate=iso=>{const d=new Date(iso),p=n=>String(n).padStart(2,'0');return `${d.getFullYear()}/${p(d.getMonth()+1)}/${p(d.getDate())}  ${p(d.getHours())}:${p(d.getMinutes())}`};
function T(ctx,s,x,y,{al='right',dir='rtl',f=font(400,FS),color=C.ink}={}){ctx.font=f;ctx.fillStyle=color;ctx.textAlign=al;ctx.direction=dir;ctx.textBaseline='middle';ctx.fillText(s,x,y)}
const hasLatinOnly=s=>!/[\u0600-\u06FF]/.test(s);
function fit(ctx,s,maxW){s=String(s||'');ctx.font=font(400,FS);if(ctx.measureText(s).width<=maxW)return s;while(s.length>3&&ctx.measureText(s+'…').width>maxW)s=s.slice(0,-1);return s.trim()+'…'}
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
// الأعمدة (من اليمين): م | الكود | الصنف | الكمية (قطعة)
function columns(){
  const cols=[{k:'no',t:'م',w:9,al:'c'},{k:'code',t:'الكود',w:26,al:'c',wrap:1},{k:'name',t:'الصنف',w:0,al:'r',wrap:1},{k:'qty',t:'الكمية (قطعة)',w:34,al:'c'}];
  const tableW=PW-2*X,fixed=cols.reduce((s,c)=>s+mm(c.w),0);let cur=PW-X;
  for(const c of cols){c.pw=c.w?mm(c.w):tableW-fixed;c.x1=cur;c.x0=cur-c.pw;cur=c.x0}
  return cols;
}
function makeRows(lines,cols){
  const m=document.createElement('canvas').getContext('2d');m.font=font(400,FS);
  return lines.map((l,i)=>{
    const v={no:String(i+1),code:l.Code||'',name:l.Name||'',qty:num(l.Qty)},lw={};let n=1;
    for(const c of cols)if(c.wrap){lw[c.k]=wrap(m,v[c.k],c.pw-2*PADH);n=Math.max(n,lw[c.k].length)}
    return {v,lines:lw,h:n*LH+2*PADV};
  });
}
// الصف عمره ما بيتقسم؛ والتذييل (الإجمالي + التوقيعات) لازم يدخل في آخر صفحة وإلا بيتنقل آخر صف/صفوف لصفحة جديدة
function paginate(rows){
  const sum=a=>a.reduce((s,r)=>s+r.h,0),first=BOTTOM-Y1-TH,other=BOTTOM-YC-TH,pages=[];
  let cur=[],used=0,cap=first;
  for(const r of rows){if(used+r.h>cap&&cur.length){pages.push(cur);cur=[];used=0;cap=other}cur.push(r);used+=r.h}
  pages.push(cur);
  const last=pages.pop(),lastCap=pages.length?other:first,carry=[];
  while(sum(last)+FOOT_H>lastCap&&last.length>1)carry.unshift(last.pop());
  pages.push(last);if(carry.length)pages.push(carry);
  return pages;
}
function drawVoidStamp(ctx){
  const label='ملغي',h=mm(30);
  ctx.save();ctx.translate(PW/2,PH*0.46);ctx.rotate(-Math.PI/6);ctx.globalAlpha=0.5;
  ctx.font=font(700,h);ctx.direction='rtl';ctx.textAlign='center';ctx.textBaseline='middle';
  const w=ctx.measureText(label).width;
  ctx.strokeStyle=C.red;ctx.fillStyle=C.red;ctx.lineWidth=mm(2);
  ctx.strokeRect(-w/2-mm(12),-h*0.8,w+mm(24),h*1.6);ctx.fillText(label,0,0);
  ctx.restore();
}
function drawPage(doc,names,lines,cols,rows,idx,total){
  const cv=document.createElement('canvas');cv.width=PW;cv.height=PH;const ctx=cv.getContext('2d');
  ctx.fillStyle=C.white;ctx.fillRect(0,0,PW,PH);
  const first=idx===0,last=idx===total-1;
  if(first){
    ctx.fillStyle=C.navy;ctx.fillRect(0,0,PW,mm(28));ctx.fillStyle=C.green;ctx.fillRect(0,mm(28),PW,mm(1.6));
    T(ctx,COMPANY.name,PW-X,mm(11),{f:font(700,mm(6.2)),color:C.white});
    T(ctx,COMPANY.en,PW-X,mm(20),{f:font(400,mm(3.6)),color:'#c9d6ea',dir:'ltr'});
    T(ctx,'مستند تحويل مخزون',X,mm(14),{al:'left',f:font(700,mm(6.6)),color:C.white});
    // بيانات المستند
    const bx=X,by=mm(34),bw=PW-2*X,bh=mm(31);
    ctx.fillStyle=C.zebra;ctx.fillRect(bx,by,bw,bh);ctx.strokeStyle=C.line;ctx.lineWidth=2;ctx.strokeRect(bx,by,bw,bh);
    const lab=(t,x,y)=>T(ctx,t,x,y,{f:font(700,FS),color:C.mute});
    const rx=PW-X-mm(3),vx=PW-X-mm(30),mx=X+mm(94);
    lab('من مخزن:',rx,mm(40));T(ctx,fit(ctx,names.from,mm(60)),vx,mm(40),{f:font(700,mm(3.8))});
    lab('إلى مخزن:',rx,mm(47));T(ctx,fit(ctx,names.to,mm(60)),vx,mm(47),{f:font(700,mm(3.8))});
    lab('الموظف:',rx,mm(54));T(ctx,fit(ctx,doc.UserName||'—',mm(60)),vx,mm(54));
    lab('رقم المستند:',mx,mm(40));T(ctx,doc.Number,X+mm(3),mm(40),{al:'left',dir:'ltr',f:font(700,mm(3.7))});
    lab('التاريخ:',mx,mm(47));T(ctx,fdate(doc.DateTime),X+mm(3),mm(47),{al:'left',dir:'ltr'});
    lab('الحالة:',mx,mm(54));T(ctx,doc.Status==='VOID'?'ملغي':'ساري',X+mm(3),mm(54),{al:'left',color:doc.Status==='VOID'?C.red:C.green,f:font(700,FS)});
    if(doc.Notes){lab('ملاحظة:',rx,mm(61));T(ctx,fit(ctx,doc.Notes,PW-2*X-mm(40)),vx,mm(61),{f:font(400,mm(3.2))})}
  }else{
    ctx.fillStyle=C.navy;ctx.fillRect(0,0,PW,mm(14));
    T(ctx,COMPANY.name,PW-X,mm(7),{f:font(700,mm(4.6)),color:C.white});
    const f=font(700,mm(3.8));ctx.font=f;const nw=ctx.measureText(doc.Number).width;
    T(ctx,doc.Number,X,mm(7),{al:'left',dir:'ltr',f,color:C.white});T(ctx,'مستند تحويل رقم',X+nw+mm(2.5),mm(7),{al:'left',dir:'rtl',f,color:C.white});
  }
  let y=first?Y1:YC;
  ctx.fillStyle=C.head;ctx.fillRect(X,y,PW-2*X,TH);
  for(const c of cols)T(ctx,c.t,c.al==='r'?c.x1-PADH:(c.x0+c.x1)/2,y+TH/2,{al:c.al==='r'?'right':'center',f:font(700,mm(3.3)),color:C.navy});
  y+=TH;const top=first?Y1:YC;
  rows.forEach((r,i)=>{
    if(i%2){ctx.fillStyle=C.zebra;ctx.fillRect(X,y,PW-2*X,r.h)}
    for(const c of cols){
      const cy=y+PADV+LH/2;
      if(c.wrap)r.lines[c.k].forEach((ln,j)=>T(ctx,ln,c.al==='r'?c.x1-PADH:(c.x0+c.x1)/2,cy+j*LH,{al:c.al==='r'?'right':'center',dir:(c.k==='code'&&hasLatinOnly(ln))?'ltr':'rtl'}));
      else T(ctx,r.v[c.k],(c.x0+c.x1)/2,y+r.h/2,{al:'center',dir:'ltr',f:font(c.k==='qty'?700:400,FS)});
    }
    ctx.strokeStyle=C.line;ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(X,y+r.h);ctx.lineTo(PW-X,y+r.h);ctx.stroke();
    y+=r.h;
  });
  ctx.strokeStyle=C.line;ctx.lineWidth=1.5;
  for(const c of cols){ctx.beginPath();ctx.moveTo(c.x0,top);ctx.lineTo(c.x0,y);ctx.stroke()}
  ctx.beginPath();ctx.moveTo(PW-X,top);ctx.lineTo(PW-X,y);ctx.stroke();
  if(last){
    y+=mm(7);const pcs=lines.reduce((s,l)=>s+l.Qty,0),bh=mm(14);
    ctx.fillStyle=C.green;ctx.fillRect(X,y,PW-2*X,bh);
    T(ctx,`عدد الأصناف: ${num(lines.length)}`,PW-X-mm(4),y+bh/2,{f:font(700,mm(4)),color:C.white});
    {const f=font(700,mm(4.6));ctx.font=f;const s=num(pcs);const nw=ctx.measureText(s).width;
      T(ctx,s,X+mm(4),y+bh/2,{al:'left',dir:'ltr',f,color:C.white});T(ctx,'إجمالي القطع:',X+mm(4)+nw+mm(3),y+bh/2,{al:'left',dir:'rtl',f:font(700,mm(4)),color:C.white})}
    y+=bh+mm(10);const sw=(PW-2*X-mm(10))/2,sh=mm(30);
    [['المسلِّم — '+names.from,PW-X-sw],['المستلِم — '+names.to,X]].forEach(([t,sx])=>{
      ctx.strokeStyle=C.navy;ctx.lineWidth=2;ctx.strokeRect(sx,y,sw,sh);
      T(ctx,fit(ctx,t,sw-mm(6)),sx+sw-mm(3),y+mm(5.5),{f:font(700,mm(3.4)),color:C.navy});
      T(ctx,'الاسم / التوقيع:',sx+sw-mm(3),y+mm(21),{f:font(400,mm(3)),color:C.mute});
      ctx.strokeStyle=C.line;ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(sx+mm(4),y+mm(24));ctx.lineTo(sx+sw-mm(32),y+mm(24));ctx.stroke();
    });
  }
  ctx.strokeStyle=C.line;ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(X,PH-mm(11));ctx.lineTo(PW-X,PH-mm(11));ctx.stroke();
  T(ctx,`صفحة ${idx+1} من ${total}`,PW/2,PH-mm(7),{al:'center',f:font(400,mm(3.1)),color:C.mute});
  T(ctx,doc.Number,PW-X,PH-mm(7),{dir:'ltr',f:font(400,mm(3)),color:C.mute});
  T(ctx,COMPANY.phone,X,PH-mm(7),{al:'left',dir:'ltr',f:font(400,mm(3)),color:C.mute});
  if(doc.Status==='VOID')drawVoidStamp(ctx);
  return cv;
}
// doc: سجل stock_docs (Type='TRANSFER') — lines: [{Code,Name,Qty}] — names: {from,to}
export async function buildTransferFiles(doc,lines,names){
  await loadInvoiceFonts();
  const cols=columns(),pages=paginate(makeRows(lines,cols));
  const canvases=pages.map((rows,i)=>drawPage(doc,names,lines,cols,rows,i,pages.length));
  await loadPdfLib();
  const {PDFDocument}=window.PDFLib,pdf=await PDFDocument.create(),W=595.28,H=841.89,images=[];
  pdf.setTitle('مستند تحويل '+doc.Number);pdf.setCreator('AL-IRAQI');pdf.setProducer('AL-IRAQI');
  for(const c of canvases){
    const jpg=await canvasToBlob(c);images.push(jpg);
    const img=await pdf.embedJpg(await jpg.arrayBuffer()),pg=pdf.addPage([W,H]);pg.drawImage(img,{x:0,y:0,width:W,height:H});
  }
  return {pdf:new Blob([await pdf.save()],{type:'application/pdf'}),images,pages:canvases.length};
}
// عناصر واجهة جاهزة (زرار + حالة + ملفات): ترجّع [nodes] تتحط في أي نافذة. الملف بيتجهّز لما المستخدم يدوس الزرار.
export function transferPanel(doc,lines,names){
  const files=el('div',{class:'inv-files'}),status=el('p',{class:'note'});let urls=[];
  const dl=(blob,name)=>{const u=URL.createObjectURL(blob),a=el('a',{href:u,download:name});document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),4000)};
  const share=async(blobs,ns,type)=>{
    const fs=blobs.map((b,i)=>new File([b],ns[i],{type}));
    if(navigator.canShare?.({files:fs})){try{await navigator.share({files:fs,title:'تحويل '+doc.Number,text:'مستند تحويل '+doc.Number+' — العراقي'});return}catch(e){if(e.name==='AbortError')return}}
    blobs.forEach((b,i)=>dl(b,ns[i]));toast('المشاركة المباشرة مش مدعومة هنا — اتحمّل الملف على الجهاز');
  };
  async function generate(){
    go.hidden=true;status.textContent='بنجهّز الملف…';files.replaceChildren();urls.forEach(u=>URL.revokeObjectURL(u));urls=[];
    try{
      const f=await buildTransferFiles(doc,lines,names),pn=doc.Number+'.pdf',inames=f.images.map((_,i)=>`${doc.Number}-${i+1}.jpg`);
      urls=f.images.map(b=>URL.createObjectURL(b));const pdfUrl=URL.createObjectURL(f.pdf);urls.push(pdfUrl);
      status.textContent=`الملف جاهز — ${f.pages} صفحة`;
      files.replaceChildren(el('div',{class:'btnrow'},
        el('button',{class:'btn',type:'button',onclick:()=>dl(f.pdf,pn)},'⬇ تحميل PDF'),
        el('button',{class:'btn',type:'button',onclick:()=>share([f.pdf],[pn],'application/pdf')},'📤 مشاركة PDF'),
        el('button',{class:'btn ghost',type:'button',onclick:()=>share(f.images,inames,'image/jpeg')},'🖼 مشاركة كصور'),
        el('button',{class:'btn ghost',type:'button',onclick:()=>window.open(pdfUrl,'_blank')},'🖨 فتح للطباعة')),
        el('div',{class:'inv-pages'},...urls.slice(0,f.images.length).map((u,i)=>el('img',{src:u,alt:`صفحة ${i+1}`}))));
    }catch(e){status.textContent='تعذر تجهيز الملف: '+(e.message||'');go.hidden=false}
  }
  const go=el('button',{class:'btn ghost',type:'button',onclick:generate},'📄 عرض / طباعة مستند التحويل');
  return [go,status,files];
}
