// ملصق QR للصنف (v14.3): توليد QR من كود الصنف الفعلي + معاينة + طباعة + تنزيل PNG.
// صيغة المحتوى: ALIRAQI-PRODUCT-<Code> — نفس البادئة اللي parseScan في invoices.js بيشيلها، فالكاميرا بتلاقي الصنف بنفس طريقة كتابة الكود يدوي (مفيش روابط ولا JSON).
// الـ QR بيتولّد جوه التطبيق (qr.js) من غير نت ولا مكتبات خارجية.
import {el,modal,toast} from './ui.js';
import {qrMatrix,qrSvg} from './qr.js';

export const QR_PREFIX='ALIRAQI-PRODUCT-';
export const qrPayload=p=>{
  const c=String(p?.Code??'').trim();
  if(!c)throw new Error('الصنف ده من غير كود — اكتب له كود الأول');
  return QR_PREFIX+c;                                                         // الكود زي ما هو متسجل (من غير تعديل) — المطابقة بتتم بنفس compact() بتاعة البحث
};

// مقاسات الملصق (مم) + أحجام الخط الأساسية (مم)
export const SIZES={
  s:{w:50,h:30,name:'صغير 50×30 مم',fn:3.1,fc:5.2},
  m:{w:70,h:50,name:'وسط 70×50 مم',fn:4.4,fc:7.2},
  l:{w:100,h:70,name:'كبير 100×70 مم',fn:6.2,fc:10.4}};

function layout(p,key){
  const S=SIZES[key],pad=Math.max(2,S.h*.07),gap=pad,qr=Math.min(S.h-2*pad,S.w*.52);
  const tw=S.w-2*pad-gap-qr,name=String(p.Name||'').trim(),code=String(p.Code||'').trim();
  const fc=Math.min(S.fc,tw/(Math.max(code.length,1)*.64));                   // الكود الطويل بيتصغّر بدل ما يتقطع
  const fn=S.fn*(name.length>48?.72:name.length>28?.86:1);
  return{S,pad,gap,qr,tw,name,code,fc,fn};
}
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const LABEL_CSS=`.alr-lbl{box-sizing:border-box;display:flex;align-items:center;background:#fff;color:#000;direction:ltr;overflow:hidden;font-family:system-ui,"Segoe UI",Tahoma,Arial,sans-serif}
.alr-lbl svg{flex:none;display:block}
.alr-tx{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center;gap:1.2mm}
.alr-nm{font-weight:700;line-height:1.2;unicode-bidi:plaintext;text-align:center;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
.alr-cd{font-weight:800;line-height:1.1;unicode-bidi:plaintext;text-align:center;overflow-wrap:anywhere;font-family:ui-monospace,Consolas,"Courier New",monospace}`;

// HTML الملصق (QR متجه SVG حاد + اسم + كود بخط كبير)
export function labelHtml(p,key){
  const L=layout(p,key);
  return `<div class="alr-lbl" style="width:${L.S.w}mm;height:${L.S.h}mm;padding:${L.pad}mm;gap:${L.gap}mm">${qrSvg(qrPayload(p),{ecl:'Q',size:L.qr+'mm'})}`+
    `<div class="alr-tx"><div class="alr-nm" style="font-size:${L.fn}mm">${esc(L.name)}</div><div class="alr-cd" style="font-size:${L.fc}mm">${esc(L.code)}</div></div></div>`;
}
// مستند الطباعة: كل نسخة صفحة بمقاس الملصق بالظبط (للطابعات الحرارية/الرول) — مفيش موارد خارجية
export function printDocHtml(p,key,copies=1){
  const S=SIZES[key],one=labelHtml(p,key);
  return `<!doctype html><html><head><meta charset="utf-8"><title>ملصق ${esc(p.Code||'')}</title><style>@page{size:${S.w}mm ${S.h}mm;margin:0}html,body{margin:0;padding:0;background:#fff}.pg{width:${S.w}mm;height:${S.h}mm;page-break-after:always;break-after:page;overflow:hidden}.pg:last-child{page-break-after:auto;break-after:auto}${LABEL_CSS}</style></head><body>${Array.from({length:copies},()=>`<div class="pg">${one}</div>`).join('')}</body></html>`;
}
export function printLabels(p,key,copies=1){
  const f=document.createElement('iframe');
  f.setAttribute('aria-hidden','true');f.style.cssText='position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0';
  document.body.appendChild(f);
  const d=f.contentDocument;d.open();d.write(printDocHtml(p,key,copies));d.close();
  setTimeout(()=>{try{f.contentWindow.focus();f.contentWindow.print()}catch(e){toast('تعذرت الطباعة: '+(e.message||''))}setTimeout(()=>f.remove(),60000)},250);
}

// ---- PNG (300dpi) — بنرسم الـ QR وحدات صحيحة بالبكسل عشان الحواف تفضل حادة ----
function wrapLines(g,text,maxW){
  const words=text.split(/\s+/).filter(Boolean),lines=[];let cur='';
  for(const w of words){const t=cur?cur+' '+w:w;if(!cur||g.measureText(t).width<=maxW)cur=t;else{lines.push(cur);cur=w}}
  if(cur)lines.push(cur);
  return lines;
}
export function drawLabelCanvas(p,key,dpi=300){
  const L=layout(p,key),px=mm=>Math.round(mm*dpi/25.4),W=px(L.S.w),H=px(L.S.h);
  const cv=document.createElement('canvas');cv.width=W;cv.height=H;
  const g=cv.getContext('2d');g.fillStyle='#fff';g.fillRect(0,0,W,H);
  const q=qrMatrix(qrPayload(p),{ecl:'Q'}),quiet=4,total=q.size+quiet*2;
  const mod=Math.max(2,Math.floor(px(L.qr)/total)),qrPx=mod*total,qx=px(L.pad),qy=Math.round((H-qrPx)/2);
  g.fillStyle='#000';
  for(let y=0;y<q.size;y++)for(let x=0;x<q.size;x++)if(q.modules[y][x])g.fillRect(qx+(x+quiet)*mod,qy+(y+quiet)*mod,mod,mod);
  const x0=qx+qrPx+px(L.gap),tw=W-px(L.pad)-x0,ar=s=>/[\u0600-\u06FF]/.test(s);
  const fam='system-ui,"Segoe UI",Tahoma,Arial,sans-serif',mono='ui-monospace,Consolas,"Courier New",monospace';
  g.textBaseline='top';
  let fc=px(L.fc);g.font=`800 ${fc}px ${mono}`;
  while(fc>8&&g.measureText(L.code).width>tw){fc=Math.floor(fc*.93);g.font=`800 ${fc}px ${mono}`}
  const avail=H-2*px(L.pad)-fc*1.1-px(1.2);
  let fn=px(L.fn),lines=[];
  for(let i=0;i<10;i++){g.font=`700 ${fn}px ${fam}`;lines=wrapLines(g,L.name,tw);if(lines.length*fn*1.2<=avail)break;fn=Math.floor(fn*.9)}
  lines=lines.slice(0,Math.max(1,Math.floor(avail/(fn*1.2))));
  let y=Math.round((H-(lines.length*fn*1.2+px(1.2)+fc*1.1))/2);
  g.fillStyle='#000';g.font=`700 ${fn}px ${fam}`;
  g.textAlign='center';const cx=x0+Math.round(tw/2);                        // النص في نص منطقته (متسق بين العربي والإنجليزي)
  for(const ln of lines){g.direction=ar(ln)?'rtl':'ltr';g.fillText(ln,cx,y);y+=Math.round(fn*1.2)}
  y+=px(1.2);g.font=`800 ${fc}px ${mono}`;g.direction=ar(L.code)?'rtl':'ltr';g.fillText(L.code,cx,y);
  return cv;
}
export function downloadPng(p,key){
  const cv=drawLabelCanvas(p,key),safe=String(p.Code).trim().replace(/[^\w\u0600-\u06FF.-]+/g,'-')||'label';
  cv.toBlob(b=>{if(!b){toast('تعذر إنشاء الصورة');return}
    const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=`QR-${safe}.png`;document.body.appendChild(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(a.href),4000)},'image/png');
}
// فحص تلقائي: لو المتصفح بيدعم BarcodeDetector بنفك الصورة اللي رسمناها ونقارنها بالمحتوى. true = اتقرا مطابق، false = ما اتقراش/مختلف، null = الفحص مش مدعوم
export async function verifyDecode(cv,payload){
  try{
    if(!('BarcodeDetector' in window))return null;
    const fm=await BarcodeDetector.getSupportedFormats?.();if(fm&&!fm.includes('qr_code'))return null;
    const r=await new BarcodeDetector({formats:['qr_code']}).detect(cv);
    return r.some(x=>x.rawValue===payload);
  }catch{return null}
}

// ---- الواجهة: openQrLabel(product) ----
export function openQrLabel(p){
  let payload;try{payload=qrPayload(p)}catch(e){toast(e.message);return}
  let key=localStorage.getItem('alr_qr_size');if(!SIZES[key])key='m';
  const prev=el('div',{style:'overflow:auto;max-width:100%;padding:10px;background:#f1f3f5;border-radius:10px;text-align:center'});
  const status=el('p',{class:'note',role:'status'});
  const copies=el('input',{type:'number',min:'1',max:'100',value:'1',inputmode:'numeric','aria-label':'عدد النسخ',style:'width:80px'});
  const sizeRow=el('div',{class:'btnrow'});
  async function render(){
    prev.innerHTML=`<style>${LABEL_CSS}</style><div style="display:inline-block;border:1px solid #cbd5e1;background:#fff">${labelHtml(p,key)}</div>`;
    sizeRow.replaceChildren(...Object.entries(SIZES).map(([k,s])=>el('button',{class:'btn ghost'+(k===key?' on':''),type:'button','aria-pressed':String(k===key),
      onclick:()=>{key=k;localStorage.setItem('alr_qr_size',k);render()}},s.name)));
    status.textContent='';
    const ok=await verifyDecode(drawLabelCanvas(p,key),payload);
    status.textContent=ok===true?'✔ اتأكدنا إن الـ QR بيتقري ومطابق لكود الصنف':ok===false?'⚠ الـ QR ما اتقراش في الفحص التلقائي — جرّب مقاس أكبر وإعادة المحاولة':'جرّب تمسح الملصق بـ «📷 مسح بالكاميرا» قبل ما تطبع كمية كبيرة';
  }
  modal('ملصق QR — '+(p.Name||p.Code),prev,sizeRow,
    el('p',{class:'note',dir:'ltr'},'المحتوى المشفّر: '+payload),status,
    el('label',{class:'field'},el('span',{},'عدد النسخ للطباعة'),copies),
    el('div',{class:'btnrow act'},
      el('button',{class:'btn',type:'button',onclick:()=>printLabels(p,key,Math.max(1,Math.min(100,parseInt(copies.value,10)||1)))},'🖨 طباعة'),
      el('button',{class:'btn ghost',type:'button',onclick:()=>downloadPng(p,key)},'⬇ تنزيل PNG')));
  render();
}
