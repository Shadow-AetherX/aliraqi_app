// مسح الباركود/QR بالكاميرا — شغال أوفلاين.
// BarcodeDetector لو موجود (كروم أندرويد)، وإلا مكتبة jsQR المحلية: js/jsQR.js
import {el,toast} from './ui.js';
export const SCANNER_VERSION='v6';
let _support, _jsqrP;
const JSQR_URL=new URL('./jsQR.js',import.meta.url).href;   // نفس مجلد scanner.js بغض النظر عن مكان الصفحة

function loadJsQR(){
  if(typeof window.jsQR==='function') return Promise.resolve(true);
  return _jsqrP||(_jsqrP=new Promise(res=>{
    const s=document.createElement('script');s.src=JSQR_URL;
    s.onload=()=>res(typeof window.jsQR==='function');
    s.onerror=()=>{_jsqrP=null;res(false)};
    document.head.append(s);
  }));
}
async function nativeDetector(){
  if(!('BarcodeDetector' in window)) return null;
  try{
    const want=['qr_code','code_128','code_39','ean_13','ean_8','upc_a'];
    const have=BarcodeDetector.getSupportedFormats?await BarcodeDetector.getSupportedFormats():want;
    const f=want.filter(x=>have.includes(x));
    return f.length?new BarcodeDetector({formats:f}):null;
  }catch{return null}
}
// بيرجّع 'native' | 'jsqr' | null  (null = مفيش كاميرا أو الصفحة مش على HTTPS)
export async function scannerSupport(){
  if(_support!==undefined) return _support;
  if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia) return (_support=null);
  if(await nativeDetector()) return (_support='native');
  return (_support=(await loadJsQR())?'jsqr':null);
}
const beep=()=>{try{const a=new (window.AudioContext||window.webkitAudioContext)(),o=a.createOscillator();o.frequency.value=880;o.connect(a.destination);o.start();setTimeout(()=>{o.stop();a.close()},90)}catch{}navigator.vibrate?.(40)};

function camError(e){
  switch(e?.name){
    case 'NotAllowedError':case 'SecurityError':return 'الكاميرا مش مسموحة — من إعدادات المتصفح/الموقع اسمح بالكاميرا وجرّب تاني';
    case 'NotFoundError':case 'DevicesNotFoundError':return 'مفيش كاميرا على الجهاز ده';
    case 'NotReadableError':case 'TrackStartError':return 'الكاميرا مشغولة في تطبيق تاني — اقفله وجرّب تاني';
    default:return 'تعذر تشغيل الكاميرا — اسمح بالوصول أو اكتب الكود يدوي';
  }
}
async function getStream(){
  // ترتيب المحاولات: كاميرا خلفية → أي كاميرا (بعض الأجهزة بترفض facingMode)
  const tries=[{video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}},audio:false},
               {video:{facingMode:'environment'},audio:false},{video:true,audio:false}];
  let err;
  for(const c of tries){
    try{return await navigator.mediaDevices.getUserMedia(c)}
    catch(e){err=e;if(['NotAllowedError','SecurityError','NotFoundError','NotReadableError'].includes(e.name)) break}
  }
  throw err;
}

// onCode(text) لازم يرجّع {status:'ok'|'unknown'|'multi', label?} — 'multi' بيقفل الكاميرا (المستخدم يختار بعدها)
export async function openScanner(onCode){
  const mode=await scannerSupport();
  if(!mode){toast(window.isSecureContext?'المسح بالكاميرا غير متاح على الجهاز ده':'الكاميرا محتاجة رابط HTTPS');return}
  let stream,stop=false,last='',lastAt=0,timer,run=0;
  // iOS: لازم muted كـ property + playsinline وإلا الفيديو بيفتح fullscreen أو ما بيشتغلش
  const video=el('video',{autoplay:''});video.muted=true;video.setAttribute('playsinline','');video.setAttribute('webkit-playsinline','');
  const status=el('div',{class:'scanstatus'},'بنشغّل الكاميرا…');
  const diag=el('small',{class:'scandiag',dir:'ltr'},'scanner '+SCANNER_VERSION+' · '+mode);   // بيأكد إن النسخة الجديدة هي اللي شغالة
  const retry=el('button',{class:'btn',type:'button',onclick:()=>start()},'إعادة المحاولة');retry.hidden=true;
  const stopStream=()=>{stream?.getTracks().forEach(t=>t.stop());stream=null};
  const close=()=>{stop=true;clearTimeout(timer);stopStream();video.srcObject=null;ov.remove()};
  const ov=el('div',{class:'overlay scan'},el('div',{class:'scanbox'},video,el('div',{class:'scanframe'}),status,diag,
    el('div',{class:'scanbar'},retry,el('button',{class:'btn ghost',type:'button',onclick:close},'إنهاء المسح'))));
  document.body.append(ov);

  async function start(){
    const my=++run;clearTimeout(timer);stopStream();retry.hidden=true;status.textContent='بنشغّل الكاميرا…';
    try{
      stream=await getStream();                                   // أول حاجة بتحصل: طلب الكاميرا (هنا بيظهر طلب الإذن)
      if(stop||my!==run){stopStream();return}
      video.srcObject=stream;await video.play();
      status.textContent='وجّه الكاميرا ناحية الباركود';
      const det=mode==='native'?await nativeDetector():null;
      if(!det&&typeof window.jsQR!=='function'&&!(await loadJsQR())) throw Object.assign(new Error('تعذر تحميل '+JSQR_URL),{name:'JsQRLoadError'});
      const cv=document.createElement('canvas'),cx=cv.getContext('2d',{willReadFrequently:true});
      const read=async()=>{
        if(video.readyState<2||!video.videoWidth) return null;
        if(det){const c=await det.detect(video);return c.length?c[0].rawValue:null}
        const vw=video.videoWidth,vh=video.videoHeight,k=Math.min(1,640/vw);
        cv.width=Math.round(vw*k);cv.height=Math.round(vh*k);cx.drawImage(video,0,0,cv.width,cv.height);
        const img=cx.getImageData(0,0,cv.width,cv.height);
        const r=window.jsQR(img.data,cv.width,cv.height,{inversionAttempts:'attemptBoth'});
        return r?r.data:null;
      };
      const loop=async()=>{
        if(stop||my!==run)return;
        try{const v=await read();const now=Date.now();
          if(v&&(v!==last||now-lastAt>1800)){last=v;lastAt=now;const r=onCode(v)||{};
            if(r.status==='ok'){beep();status.textContent='✔ '+(r.label||v)}
            else if(r.status==='multi'){status.textContent='أكتر من صنف بنفس الكود — اختار بعد الإنهاء';close();return}
            else status.textContent='✖ كود غير معروف: '+v}
        }catch{}
        if(!stop&&my===run)timer=setTimeout(loop,det?220:300);
      };loop();
    }catch(e){
      stopStream();if(stop||my!==run)return;
      let perm='';try{perm=(await navigator.permissions.query({name:'camera'})).state}catch{}
      let msg=e?.name==='JsQRLoadError'?'ملف js/jsQR.js مش بيتحمّل من الموقع':camError(e);
      if(perm==='denied') msg='الكاميرا متحجبة للموقع ده — لازم تفتحها من إعدادات الموقع في المتصفح (أيقونة القفل/الإعدادات ← الكاميرا ← سماح) وبعدين اضغط إعادة المحاولة';
      status.textContent=msg;                                      // الشاشة بتفضل مفتوحة عشان التشخيص يتقري
      diag.textContent='scanner '+SCANNER_VERSION+' · '+mode+' · '+(e?.name||'Error')+': '+(e?.message||'')+(perm?' · permission='+perm:'');
      retry.hidden=false;
    }
  }
  start();
}
