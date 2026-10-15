// ملصق QR للصنف (v22.1): توليد QR من كود الصنف الفعلي + معاينة + طباعة + تنزيل PNG.
// v22.1: التخطيط بقى عمودي (QR فوق، تحته اسم الصنف، وتحته كود الصنف بخط كبير) والمقاسات 50×30 / 50×70 / 100×70 مم (الوسط كان 70×50 بالعرض).
// صيغة المحتوى: ALIRAQI-PRODUCT-<Code> — نفس البادئة اللي parseScan في invoices.js بيشيلها، فالكاميرا بتلاقي الصنف بنفس طريقة كتابة الكود يدوي (مفيش روابط ولا JSON).
// الـ QR بيتولّد جوه التطبيق (qr.js) من غير نت ولا مكتبات خارجية. الـQR دايماً مربع (عرضه = ارتفاعه بالمليمتر + preserveAspectRatio) فمفيش تمطيط.
import {el,modal,toast} from './ui.js';
import {qrMatrix,qrSvg} from './qr.js';

import {QR_PREFIX} from './scanner.js';
export {QR_PREFIX};
export const qrPayload=p=>{
  const c=String(p?.Code??'').trim();
  if(!c)throw new Error('الصنف ده من غير كود — اكتب له كود الأول');
  return QR_PREFIX+c;                                                         // الكود زي ما هو متسجل (من غير تعديل) — المطابقة بتتم بنفس compact() بتاعة البحث
};

// مقاسات الملصق (مم). كل الأرقام بالمليمتر:
//  pad = هامش داخلي · qr = مربع الـQR (بما فيه الـquiet zone اللي بيرسمه qr.js) · gap = المسافة بين الـQR والنص · g2 = بين الاسم والكود
//  nl = أقصى عدد أسطر للاسم · fn = خط الاسم · fc = خط الكود (حوالي ضعف الاسم عشان يتقري من بعيد في المخزن)
// المجموع الرأسي لكل مقاس: 2·pad + qr + gap + (nl·fn·1.15 + g2 + fc·1.1) ≤ h  (متحسوب ومتأكد منه في الاختبار)
export const SIZES={
  s:{w:50,h:30,name:'صغير 50×30 مم',pad:1,qr:16.5,gap:.6,g2:.4,nl:2,fn:2.3,fc:4.4},
  m:{w:50,h:70,name:'وسط 50×70 مم',pad:2,qr:40,gap:1.5,g2:.8,nl:3,fn:3.6,fc:8},
  l:{w:100,h:70,name:'كبير 100×70 مم',pad:2.5,qr:38,gap:2,g2:1,nl:2,fn:4.8,fc:10.5}};
const NAME_LH=1.15,CODE_LH=1.1,MONO_EM=.62,AVG_EM=.55;                         // ارتفاع السطر (نسبة من الخط) + تقدير عرض الحرف (نسبة من الخط)

// box = {w,h} اختياري (مم): مساحة الملصق الفعلية لو أصغر من الاسمي (مثلاً خلية الشيت 29.7 مم ارتفاع). من غيره بنستخدم المقاس الاسمي.
export function layout(p,key,box){
  const S=SIZES[key],W=Math.min(S.w,box?.w||S.w),H=Math.min(S.h,box?.h||S.h),pad=S.pad,iw=W-2*pad;
  const name=String(p.Name||'').trim(),code=String(p.Code||'').trim();
  const fc=Math.min(S.fc,iw/(Math.max(code.length,1)*MONO_EM));                // الكود الطويل بيتصغّر بدل ما يتقطع
  const fn=name?Math.min(S.fn,Math.max(S.fn*.72,iw*S.nl/(AVG_EM*name.length))):S.fn;   // الاسم الطويل بيتصغّر لحد 72% وبعدها بيتقطع بنقط
  const need=S.nl*fn*NAME_LH+S.g2+fc*CODE_LH;
  const qr=Math.floor(Math.min(S.qr,iw,H-2*pad-S.gap-need)*10)/10;            // الـQR بيصغر بس لو المساحة الفعلية أقل من الاسمية، وعمره ما بيكبر
  return{S,W,H,pad,gap:S.gap,g2:S.g2,nl:S.nl,qr,name,code,fn,fc};
}
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const mm=n=>(+Number(n).toFixed(2))+'mm';
export const LABEL_CSS=`.alr-lbl{box-sizing:border-box;display:flex;flex-direction:column;align-items:center;background:#fff;color:#000;direction:ltr;overflow:hidden;font-family:system-ui,"Segoe UI",Tahoma,Arial,sans-serif}
.alr-qr{flex:none;display:block;overflow:hidden}
.alr-qr svg{display:block;width:100%;height:100%}
.alr-tx{flex:1;min-height:0;width:100%;display:flex;flex-direction:column;justify-content:center;align-items:center}
.alr-nm{width:100%;font-weight:700;line-height:${NAME_LH};unicode-bidi:plaintext;text-align:center;overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden}
.alr-cd{width:100%;font-weight:800;line-height:${CODE_LH};unicode-bidi:plaintext;text-align:center;white-space:nowrap;overflow:hidden;font-family:ui-monospace,Consolas,"Courier New",monospace}`;

// HTML الملصق (QR متجه SVG حاد داخل مربع بالمليمتر + اسم + كود بخط كبير)
export function labelHtml(p,key,box){
  const L=layout(p,key,box),svg=qrSvg(qrPayload(p),{ecl:'Q',size:mm(L.qr)}).replace(/<svg\b/,'<svg preserveAspectRatio="xMidYMid meet"');   // أول سمة بتكسب لو الـSVG فيه واحدة تانية
  return `<div class="alr-lbl" style="width:${mm(L.W)};height:${mm(L.H)};padding:${mm(L.pad)}">`+
    `<div class="alr-qr" style="width:${mm(L.qr)};height:${mm(L.qr)}">${svg}</div>`+
    `<div class="alr-tx" style="margin-top:${mm(L.gap)};gap:${mm(L.g2)}">`+
    `<div class="alr-nm" style="font-size:${mm(L.fn)};-webkit-line-clamp:${L.nl};max-height:${mm(L.fn*NAME_LH*L.nl)}">${esc(L.name)}</div>`+
    `<div class="alr-cd" style="font-size:${mm(L.fc)}">${esc(L.code)}</div></div></div>`;
}
// مستند الطباعة: كل نسخة صفحة بمقاس الملصق بالظبط (للطابعات الحرارية/الرول) — مفيش موارد خارجية. (الطباعة على شيتات A4 من «ملصقات مجمّعة»)
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

// ---- PNG (300dpi) — بنرسم الـ QR وحدات صحيحة بالبكسل عشان الحواف تفضل حادة، ونفس التخطيط العمودي ----
function wrapLines(g,text,maxW){
  const words=text.split(/\s+/).filter(Boolean),lines=[];let cur='';
  for(const w of words){const t=cur?cur+' '+w:w;if(!cur||g.measureText(t).width<=maxW)cur=t;else{lines.push(cur);cur=w}}
  if(cur)lines.push(cur);
  return lines;
}
export function drawLabelCanvas(p,key,dpi=300,box){
  const L=layout(p,key,box),px=m=>Math.round(m*dpi/25.4),W=px(L.W),H=px(L.H);
  const cv=document.createElement('canvas');cv.width=W;cv.height=H;
  const g=cv.getContext('2d');g.fillStyle='#fff';g.fillRect(0,0,W,H);
  const q=qrMatrix(qrPayload(p),{ecl:'Q'}),quiet=4,total=q.size+quiet*2;
  const mod=Math.max(2,Math.floor(px(L.qr)/total)),qrPx=mod*total,qx=Math.round((W-qrPx)/2),qy=px(L.pad)+Math.round((px(L.qr)-qrPx)/2);
  g.fillStyle='#000';
  for(let y=0;y<q.size;y++)for(let x=0;x<q.size;x++)if(q.modules[y][x])g.fillRect(qx+(x+quiet)*mod,qy+(y+quiet)*mod,mod,mod);
  const ty0=px(L.pad+L.qr+L.gap),ty1=H-px(L.pad),avail=ty1-ty0,maxW=W-2*px(L.pad),cx=Math.round(W/2),g2=px(L.g2),ar=s=>/[\u0600-\u06FF]/.test(s);
  const fam='system-ui,"Segoe UI",Tahoma,Arial,sans-serif',mono='ui-monospace,Consolas,"Courier New",monospace';
  g.textBaseline='top';g.textAlign='center';
  let fc=px(L.fc);g.font=`800 ${fc}px ${mono}`;
  while(fc>8&&g.measureText(L.code).width>maxW){fc=Math.floor(fc*.93);g.font=`800 ${fc}px ${mono}`}
  const fnMin=Math.round(px(L.fn)*.75);let fn=px(L.fn),lines=[];
  for(;;){g.font=`700 ${fn}px ${fam}`;lines=wrapLines(g,L.name,maxW);
    if((lines.length<=L.nl&&lines.length*fn*NAME_LH+g2+fc*CODE_LH<=avail)||fn<=fnMin)break;
    fn=Math.max(fnMin,Math.floor(fn*.94))}
  if(lines.length>L.nl){lines=lines.slice(0,L.nl);let t=lines[L.nl-1];while(t.length>1&&g.measureText(t+'…').width>maxW)t=t.slice(0,-1);lines[L.nl-1]=t.trimEnd()+'…'}
  const nameH=lines.length?lines.length*fn*NAME_LH+g2:0;
  let y=ty0+Math.max(0,Math.round((avail-nameH-fc*CODE_LH)/2));
  g.fillStyle='#000';g.font=`700 ${fn}px ${fam}`;
  for(const ln of lines){g.direction=ar(ln)?'rtl':'ltr';g.fillText(ln,cx,y);y+=Math.round(fn*NAME_LH)}
  if(lines.length)y+=g2;
  g.font=`800 ${fc}px ${mono}`;g.direction=ar(L.code)?'rtl':'ltr';g.fillText(L.code,cx,y);
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
  const sizeRow=el('div',{class:'btnrow qrsizes'});
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
    el('p',{class:'note'},'الطباعة هنا بتطلّع كل نسخة في صفحة بمقاس الملصق (للطابعة الحرارية/الرول). للطباعة على شيتات A4 المقطّعة استخدم «🖨️ طباعة ملصقات مجمّعة».'),
    el('div',{class:'btnrow act'},
      el('button',{class:'btn',type:'button',onclick:()=>printLabels(p,key,Math.max(1,Math.min(100,parseInt(copies.value,10)||1)))},'🖨 طباعة'),
      el('button',{class:'btn ghost',type:'button',onclick:()=>downloadPng(p,key)},'⬇ تنزيل PNG')));
  render();
}
