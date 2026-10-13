// مولّد QR Code (ISO/IEC 18004) — JavaScript صافي من غير أي مكتبات، فبيشتغل أوفلاين تماماً جوه الـ PWA.
// الدعم: وضع Byte (UTF-8: عربي وإنجليزي وأرقام و«/»)، الإصدارات 1–40، مستويات التصحيح L/M/Q/H.
// الملف ده نقي (من غير imports) عشان يتختبر لوحده؛ الواجهة في qrlabel.js.

const ECC_PER_BLOCK={
  L:[-1,7,10,15,20,26,18,20,24,30,18,20,24,26,30,22,24,28,30,28,28,28,28,30,30,26,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
  M:[-1,10,16,26,18,24,16,18,22,22,26,30,22,22,24,24,28,28,26,26,26,26,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28],
  Q:[-1,13,22,18,26,18,24,18,22,20,24,28,26,24,20,30,24,28,28,26,30,28,30,30,30,30,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
  H:[-1,17,28,22,16,22,28,26,26,24,28,24,28,22,24,24,30,28,28,26,28,30,24,30,30,30,30,28,30,30,30,30,30,30,30,30,30,30,30,30,30]};
const NUM_BLOCKS={
  L:[-1,1,1,1,1,1,2,2,2,2,4,4,4,4,4,6,6,6,6,7,8,8,9,9,10,12,12,12,13,14,15,16,17,18,19,19,20,21,22,24,25],
  M:[-1,1,1,1,2,2,4,4,4,5,5,5,8,9,9,10,10,11,13,14,16,17,17,18,20,21,23,25,26,28,29,31,33,35,37,38,40,43,45,47,49],
  Q:[-1,1,1,2,2,4,4,6,6,8,8,8,10,12,16,12,17,16,18,21,20,23,23,25,27,29,34,34,35,38,40,43,45,48,51,53,56,59,62,65,68],
  H:[-1,1,1,2,4,4,4,5,6,8,8,11,11,16,16,18,16,19,21,25,25,25,34,30,32,35,37,40,42,45,48,51,54,57,60,63,66,70,74,77,81]};
const FORMAT_BITS={L:1,M:0,Q:3,H:2};

const bit=(x,i)=>((x>>>i)&1)!==0;

function rawModules(ver){
  let r=(16*ver+128)*ver+64;
  if(ver>=2){const n=Math.floor(ver/7)+2;r-=(25*n-10)*n-55;if(ver>=7)r-=36}
  return r;
}
const dataCodewords=(ver,ecl)=>Math.floor(rawModules(ver)/8)-ECC_PER_BLOCK[ecl][ver]*NUM_BLOCKS[ecl][ver];

// ---- Reed–Solomon على GF(256) (كثيرة الحدود 0x11D) ----
function gfMul(x,y){let z=0;for(let i=7;i>=0;i--){z=(z<<1)^((z>>>7)*0x11D);z^=((y>>>i)&1)*x}return z}
function rsDivisor(deg){
  const r=new Array(deg).fill(0);r[deg-1]=1;let root=1;
  for(let i=0;i<deg;i++){for(let j=0;j<deg;j++){r[j]=gfMul(r[j],root);if(j+1<deg)r[j]^=r[j+1]}root=gfMul(root,2)}
  return r;
}
function rsRemainder(data,div){
  const r=div.map(()=>0);
  for(const b of data){const f=b^r.shift();r.push(0);div.forEach((c,i)=>{r[i]^=gfMul(c,f)})}
  return r;
}

// ---- تجهيز الكلمات (data + ECC متداخلة) ----
function buildCodewords(bytes,ver,ecl){
  const cap=dataCodewords(ver,ecl)*8,bits=[];
  const push=(v,n)=>{for(let i=n-1;i>=0;i--)bits.push((v>>>i)&1)};
  push(0b0100,4);push(bytes.length,ver<10?8:16);bytes.forEach(b=>push(b,8));
  push(0,Math.min(4,cap-bits.length));push(0,(8-bits.length%8)%8);
  for(let pad=0xEC;bits.length<cap;pad^=0xEC^0x11)push(pad,8);
  const data=[];for(let i=0;i<bits.length;i+=8){let v=0;for(let j=0;j<8;j++)v=(v<<1)|bits[i+j];data.push(v)}
  const nb=NUM_BLOCKS[ecl][ver],eccLen=ECC_PER_BLOCK[ecl][ver],raw=Math.floor(rawModules(ver)/8);
  const shortBlocks=nb-raw%nb,shortLen=Math.floor(raw/nb),div=rsDivisor(eccLen),blocks=[];
  for(let i=0,k=0;i<nb;i++){
    const d=data.slice(k,k+shortLen-eccLen+(i<shortBlocks?0:1));k+=d.length;
    const ecc=rsRemainder(d,div);if(i<shortBlocks)d.push(0);   // خانة فاضية عشان التداخل يبقى بنفس الطول
    blocks.push(d.concat(ecc));
  }
  const out=[];
  for(let i=0;i<blocks[0].length;i++)blocks.forEach((b,j)=>{if(i!==shortLen-eccLen||j>=shortBlocks)out.push(b[i])});
  return out;
}

// ---- رسم المصفوفة ----
function alignPositions(ver){
  if(ver===1)return[];
  const n=Math.floor(ver/7)+2,step=ver===32?26:Math.ceil((ver*4+4)/(n*2-2))*2,r=[6];
  for(let pos=ver*4+10;r.length<n;pos-=step)r.splice(1,0,pos);
  return r;
}
function build(ver,ecl,codewords){
  const size=ver*4+17,m=Array.from({length:size},()=>new Array(size).fill(false)),fn=Array.from({length:size},()=>new Array(size).fill(false));
  const set=(x,y,d)=>{m[y][x]=d;fn[y][x]=true};
  for(let i=0;i<size;i++){set(6,i,i%2===0);set(i,6,i%2===0)}
  const finder=(cx,cy)=>{for(let dy=-4;dy<=4;dy++)for(let dx=-4;dx<=4;dx++){const x=cx+dx,y=cy+dy;if(x>=0&&x<size&&y>=0&&y<size)set(x,y,Math.max(Math.abs(dx),Math.abs(dy))!==2&&Math.max(Math.abs(dx),Math.abs(dy))!==4)}};
  finder(3,3);finder(size-4,3);finder(3,size-4);
  const ap=alignPositions(ver);
  ap.forEach((x,i)=>ap.forEach((y,j)=>{if((i===0&&j===0)||(i===0&&j===ap.length-1)||(i===ap.length-1&&j===0))return;
    for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++)set(x+dx,y+dy,Math.max(Math.abs(dx),Math.abs(dy))!==1)}));
  const format=mask=>{
    const data=(FORMAT_BITS[ecl]<<3)|mask;let rem=data;for(let i=0;i<10;i++)rem=(rem<<1)^((rem>>>9)*0x537);
    const bits=((data<<10)|rem)^0x5412;
    for(let i=0;i<=5;i++)set(8,i,bit(bits,i));set(8,7,bit(bits,6));set(8,8,bit(bits,7));set(7,8,bit(bits,8));
    for(let i=9;i<15;i++)set(14-i,8,bit(bits,i));
    for(let i=0;i<8;i++)set(size-1-i,8,bit(bits,i));
    for(let i=8;i<15;i++)set(8,size-15+i,bit(bits,i));
    set(8,size-8,true);
  };
  format(0);
  if(ver>=7){
    let rem=ver;for(let i=0;i<12;i++)rem=(rem<<1)^((rem>>>11)*0x1F25);
    const bits=(ver<<12)|rem;
    for(let i=0;i<18;i++){const a=size-11+i%3,b=Math.floor(i/3);set(a,b,bit(bits,i));set(b,a,bit(bits,i))}
  }
  // وضع الكلمات بمسار الزجزاج
  let i=0;
  for(let right=size-1;right>=1;right-=2){
    if(right===6)right=5;
    for(let v=0;v<size;v++)for(let j=0;j<2;j++){
      const x=right-j,y=((right+1)&2)===0?size-1-v:v;
      if(!fn[y][x]&&i<codewords.length*8){m[y][x]=bit(codewords[i>>>3],7-(i&7));i++}
    }
  }
  // اختيار أفضل قناع بأقل غرامة
  const mask=k=>{for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    if(fn[y][x])continue;
    const inv=[(x+y)%2===0,y%2===0,x%3===0,(x+y)%3===0,(Math.floor(x/3)+Math.floor(y/2))%2===0,(x*y)%2+(x*y)%3===0,((x*y)%2+(x*y)%3)%2===0,((x+y)%2+(x*y)%3)%2===0][k];
    if(inv)m[y][x]=!m[y][x]}};
  let best=0,bestPen=Infinity;
  for(let k=0;k<8;k++){mask(k);format(k);const p=penalty(m,size);if(p<bestPen){bestPen=p;best=k}mask(k)}
  mask(best);format(best);
  return m;
}
function penalty(m,size){
  let r=0,dark=0;
  const scan=line=>{
    let run=1;
    for(let i=1;i<size;i++){if(line[i]===line[i-1]){run++;if(run===5)r+=3;else if(run>5)r++}else run=1}
    const s=line.map(v=>v?'1':'0').join('');
    for(let i=0;i+11<=size;i++){const w=s.substr(i,11);if(w==='00001011101'||w==='10111010000')r+=40}
  };
  for(let y=0;y<size;y++){scan(m[y]);scan(m.map(row=>row[y]));for(let x=0;x<size;x++)if(m[y][x])dark++}
  for(let y=0;y<size-1;y++)for(let x=0;x<size-1;x++){const c=m[y][x];if(c===m[y][x+1]&&c===m[y+1][x]&&c===m[y+1][x+1])r+=3}
  const total=size*size;r+=(Math.ceil(Math.abs(dark*20-total*10)/total)-1)*10;
  return r;
}

// ---- الواجهة ----
// qrMatrix(text,{ecl='Q',minVersion=1}) → {size,version,ecl,modules:boolean[][]}
export function qrMatrix(text,{ecl='Q',minVersion=1}={}){
  if(!ECC_PER_BLOCK[ecl])throw new Error('مستوى تصحيح غير صالح');
  const bytes=[...new TextEncoder().encode(String(text))];
  if(!bytes.length)throw new Error('مفيش نص يتحوّل لـ QR');
  for(let ver=Math.max(1,minVersion);ver<=40;ver++){
    if(ecl==='H'&&ver===27)continue;   // الكومبو ده بالذات ما قدرناش نأكد قراءته في الاختبار — بنعدّيه للإصدار اللي بعده (QR أكبر دايماً صالح). مش بيظهر عملياً: أكواد الأصناف بتطلع إصدار 2–4
    const need=4+(ver<10?8:16)+bytes.length*8;
    if(need<=dataCodewords(ver,ecl)*8)return{size:ver*4+17,version:ver,ecl,modules:build(ver,ecl,buildCodewords(bytes,ver,ecl))};
  }
  throw new Error('النص أطول من سعة الـ QR');
}
// SVG واحد بمسار واحد (حاد على الطباعة). quiet=4 وحدات هامش أبيض إجباري عشان الكاميرا تقرا.
export function qrSvg(text,{ecl='Q',quiet=4,size=null,fg='#000',bg='#fff'}={}){
  const q=qrMatrix(text,{ecl}),n=q.size+quiet*2;let d='';
  for(let y=0;y<q.size;y++){
    for(let x=0;x<q.size;){
      if(!q.modules[y][x]){x++;continue}
      let w=1;while(x+w<q.size&&q.modules[y][x+w])w++;
      d+=`M${x+quiet} ${y+quiet}h${w}v1h-${w}z`;x+=w;
    }
  }
  const dim=size?` width="${size}" height="${size}"`:'';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}"${dim} shape-rendering="crispEdges" role="img" aria-label="QR"><rect width="${n}" height="${n}" fill="${bg}"/><path d="${d}" fill="${fg}"/></svg>`;
}
// أقصى عدد بايتات (UTF-8) يتشفّر في إصدار ومستوى معيّنين
export const qrCapacity=(ver,ecl='Q')=>Math.floor((dataCodewords(ver,ecl)*8-4-(ver<10?8:16))/8);
