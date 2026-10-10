export const $=s=>document.querySelector(s);
export const el=(tag,attrs={},...kids)=>{const e=document.createElement(tag);
  for(const[k,v]of Object.entries(attrs)){if(v==null||v===false)continue;if(k==='class')e.className=v;else if(k.startsWith('on'))e.addEventListener(k.slice(2),v);else e.setAttribute(k,v===true?'':v)}
  kids.flat().forEach(k=>{if(k!=null&&k!==false)e.append(k)});return e};
export function toast(m){const t=$('#toast');t.textContent=m;t.classList.add('show');clearTimeout(toast._t);toast._t=setTimeout(()=>t.classList.remove('show'),2800)}
export const fmt=n=>n==null?'—':Number(n).toLocaleString('en-US');

// نافذة منبثقة عامة. العنوان نص أو {title,onClose}. بترجّع دالة الإغلاق.
export function modal(t,...kids){
  const o=typeof t==='string'?{title:t}:t;
  const close=()=>{if(!ov.isConnected)return;ov.remove();removeEventListener('keydown',esc);o.onClose?.()};
  const esc=e=>{if(e.key==='Escape')close()};addEventListener('keydown',esc);
  const ov=el('div',{class:'overlay',role:'dialog','aria-modal':'true','aria-label':o.title,onclick:e=>{if(e.target===ov)close()}},
    el('div',{class:'sheet'},el('div',{class:'shead'},el('h3',{},o.title),el('button',{class:'x',type:'button',onclick:close,'aria-label':'إغلاق'},'✕')),...kids));
  document.body.append(ov);return close;
}
// بيسأل عن سبب (إجباري 3 حروف على الأقل). بيرجّع النص أو null لو المستخدم لغى.
export function askReason(title,text,okLabel='تأكيد'){
  return new Promise(res=>{
    let done=false,close;
    const fin=v=>{if(done)return;done=true;close();res(v)};
    const inp=el('input',{type:'text',maxlength:'160',placeholder:'السبب (مطلوب)','aria-label':'السبب'});
    const err=el('p',{class:'err'});
    const ok=el('button',{class:'btn danger',type:'button',onclick:()=>{const v=inp.value.trim();if(v.length<3){err.textContent='اكتب السبب (3 حروف على الأقل)';return}fin(v)}},okLabel);
    inp.addEventListener('keydown',e=>{if(e.key==='Enter')ok.click()});
    close=modal({title,onClose:()=>fin(null)},el('p',{class:'note'},text),el('label',{class:'field'},el('span',{},'السبب'),inp),err,ok);
    inp.focus();
  });
}
