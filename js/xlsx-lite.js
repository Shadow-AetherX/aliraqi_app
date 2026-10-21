// قراءة وكتابة ملفات Excel (.xlsx) و CSV من غير أي مكتبة خارجية (شغال أوفلاين).
// الكتابة: ZIP بدون ضغط + OOXML بسيط (نصوص inline، اتجاه RTL، صف عناوين مثبّت). الأكواد بتتكتب نص عشان «0202» ما تتحوّلش لرقم.
// القراءة: ZIP (store/deflate عن طريق DecompressionStream الأصلي في المتصفح) + sharedStrings + inlineStr. بتقرا أول ورقة بس.
const enc=new TextEncoder();
const CRC=(()=>{const t=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;t[n]=c>>>0}return t})();
const crc32=b=>{let c=0xFFFFFFFF;for(let i=0;i<b.length;i++)c=CRC[(c^b[i])&255]^(c>>>8);return(c^0xFFFFFFFF)>>>0};
const esc=s=>String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const colName=i=>{let s='';for(i++;i>0;i=Math.floor((i-1)/26))s=String.fromCharCode(65+(i-1)%26)+s;return s};
const STYLE={int:2,money:3};            // 0 عادي · 1 عنوان · 2 عدد صحيح #,##0 · 3 مبلغ #,##0.00

function zip(files){                     // files: [{name, data:Uint8Array}] — بدون ضغط (method 0)
  const parts=[],cen=[];let off=0;
  const u16=n=>[n&255,(n>>8)&255],u32=n=>[n&255,(n>>>8)&255,(n>>>16)&255,(n>>>24)&255];
  for(const f of files){
    const nm=enc.encode(f.name),crc=crc32(f.data),sz=f.data.length;
    const lh=new Uint8Array([0x50,0x4b,3,4,...u16(20),...u16(0x0800),...u16(0),...u16(0),...u16(0x21),...u32(crc),...u32(sz),...u32(sz),...u16(nm.length),...u16(0)]);
    parts.push(lh,nm,f.data);
    cen.push(new Uint8Array([0x50,0x4b,1,2,...u16(20),...u16(20),...u16(0x0800),...u16(0),...u16(0),...u16(0x21),...u32(crc),...u32(sz),...u32(sz),...u16(nm.length),...u16(0),...u16(0),...u16(0),...u16(0),...u32(0),...u32(off)]),nm);
    off+=lh.length+nm.length+sz;
  }
  const cdSize=cen.reduce((s,x)=>s+x.length,0);
  const end=new Uint8Array([0x50,0x4b,5,6,0,0,0,0,...u16(files.length),...u16(files.length),...u32(cdSize),...u32(off),0,0]);
  return new Blob([...parts,...cen,end],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
}

// sheets: [{name, rows:[[cell,...]], widths:[عرض لكل عمود], header:true}] — cell: نص | رقم | null | {v, s:'int'|'money'}
export function writeXlsx(sheets){
  const files=[];const add=(name,xml)=>files.push({name,data:enc.encode(xml)});
  const used=new Set(),names=sheets.map((s,i)=>{let n=String(s.name||'Sheet'+(i+1)).replace(/[\[\]:*?\/\\]/g,' ').trim().slice(0,31)||'Sheet'+(i+1);while(used.has(n.toLowerCase()))n=n.slice(0,28)+'_'+(i+1);used.add(n.toLowerCase());return n});
  add('[Content_Types].xml','<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'+sheets.map((_,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')+'</Types>');
  add('_rels/.rels','<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  add('xl/workbook.xml','<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'+names.map((n,i)=>`<sheet name="${esc(n)}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('')+'</sheets></workbook>');
  add('xl/_rels/workbook.xml.rels','<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+sheets.map((_,i)=>`<Relationship Id="rId${i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join('')+`<Relationship Id="rId${sheets.length+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  add('xl/styles.xml','<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1B3A63"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>');
  sheets.forEach((sh,si)=>{
    const rows=sh.rows||[],hdr=sh.header!==false;
    let x='<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0" rightToLeft="1"'+(si===0?' tabSelected="1"':'')+'>'+(hdr?'<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>':'')+'</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>';
    if(sh.widths?.length)x+='<cols>'+sh.widths.map((w,i)=>`<col min="${i+1}" max="${i+1}" width="${w}" customWidth="1"/>`).join('')+'</cols>';
    x+='<sheetData>';
    rows.forEach((r,ri)=>{
      x+=`<row r="${ri+1}">`;
      r.forEach((c,ci)=>{
        if(c==null||c==='')return;
        const ref=colName(ci)+(ri+1),v=typeof c==='object'?c.v:c;
        if(v==null||v==='')return;
        const st=hdr&&ri===0?1:(typeof c==='object'&&STYLE[c.s])||0;
        if(typeof v==='number'&&Number.isFinite(v))x+=`<c r="${ref}"${st?` s="${st}"`:''}><v>${v}</v></c>`;
        else x+=`<c r="${ref}"${st?` s="${st}"`:''} t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
      });
      x+='</row>';
    });
    x+='</sheetData></worksheet>';
    add(`xl/worksheets/sheet${si+1}.xml`,x);
  });
  return zip(files);
}

// ---------------- القراءة ----------------
const dec=new TextDecoder('utf-8');
async function inflateRaw(bytes){
  if(typeof DecompressionStream==='undefined')throw new Error('المتصفح ده مش بيدعم قراءة ملفات Excel المضغوطة — احفظ الملف كـ CSV وجرّب تاني');
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
}
async function unzip(buf){
  const b=new Uint8Array(buf),dv=new DataView(b.buffer,b.byteOffset,b.byteLength);
  let e=-1;for(let i=b.length-22;i>=Math.max(0,b.length-22-65535);i--)if(dv.getUint32(i,true)===0x06054b50){e=i;break}
  if(e<0)throw new Error('الملف مش Excel (.xlsx) سليم');
  const n=dv.getUint16(e+10,true);let p=dv.getUint32(e+16,true);const out=new Map();
  for(let i=0;i<n;i++){
    if(dv.getUint32(p,true)!==0x02014b50)break;
    const method=dv.getUint16(p+10,true),csz=dv.getUint32(p+20,true),nl=dv.getUint16(p+28,true),xl=dv.getUint16(p+30,true),cl=dv.getUint16(p+32,true),lo=dv.getUint32(p+42,true);
    const name=dec.decode(b.subarray(p+46,p+46+nl));p+=46+nl+xl+cl;
    out.set(name,{method,csz,lo});
  }
  const get=async name=>{
    const f=out.get(name);if(!f)return null;
    const ln=dv.getUint16(f.lo+26,true),lx=dv.getUint16(f.lo+28,true),s=f.lo+30+ln+lx,raw=b.subarray(s,s+f.csz);
    return dec.decode(f.method===0?raw:f.method===8?await inflateRaw(raw):(()=>{throw new Error('نوع ضغط غير مدعوم')})());
  };
  return{has:n=>out.has(n),get};
}
const unesc=s=>s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,(m,g)=>{g=g.toLowerCase();if(g==='amp')return'&';if(g==='lt')return'<';if(g==='gt')return'>';if(g==='quot')return'"';if(g==='apos')return"'";return String.fromCodePoint(g[1]==='x'?parseInt(g.slice(2),16):parseInt(g.slice(1),10))});
const textOf=x=>{let o='';for(const m of x.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g))o+=m[1]?unesc(m[1]):'';return o};
const colIdx=ref=>{let n=0;for(const ch of ref.replace(/[0-9]/g,''))n=n*26+ch.charCodeAt(0)-64;return n-1};
export async function readXlsx(buf){
  const z=await unzip(buf);
  const wb=await z.get('xl/workbook.xml');if(!wb)throw new Error('الملف مش Excel (.xlsx) سليم');
  const rels=await z.get('xl/_rels/workbook.xml.rels')||'';
  const sh=wb.match(/<sheet\b[^>]*>/);if(!sh)throw new Error('الملف مفيهوش أوراق');
  const rid=(sh[0].match(/r:id="([^"]+)"/)||[])[1];
  let target='worksheets/sheet1.xml';
  for(const m of rels.matchAll(/<Relationship\b[^>]*>/g)){if(m[0].includes(`Id="${rid}"`)){const t=(m[0].match(/Target="([^"]+)"/)||[])[1];if(t)target=t.replace(/^\//,'').replace(/^xl\//,'');}}
  const sx=await z.get('xl/'+target);if(!sx)throw new Error('تعذر قراءة الورقة الأولى');
  const ss=[];const sst=await z.get('xl/sharedStrings.xml');
  if(sst)for(const m of sst.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g))ss.push(textOf(m[1]));
  const rows=[];
  for(const rm of sx.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)){
    const rn=Number((rm[1].match(/\br="(\d+)"/)||[])[1])||rows.length+1,cells=[];
    for(const cm of (rm[2]||'').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)){
      const at=cm[1],body=cm[2]||'',ref=(at.match(/\br="([A-Z]+\d+)"/)||[])[1],t=(at.match(/\bt="([^"]+)"/)||[])[1];
      const ci=ref?colIdx(ref):cells.length,v=(body.match(/<v>([\s\S]*?)<\/v>/)||[])[1];
      let val=null;
      if(t==='s')val=v!=null?ss[Number(v)]??'':null;
      else if(t==='inlineStr')val=textOf(body);
      else if(t==='str')val=v!=null?unesc(v):null;
      else if(t==='b')val=v==='1'?'TRUE':'FALSE';
      else if(t==='e')val=null;
      else if(v!=null&&v!==''){const n=Number(v);val=Number.isFinite(n)?n:unesc(v)}
      cells[ci]=val;
    }
    for(let i=0;i<cells.length;i++)if(cells[i]===undefined)cells[i]=null;
    rows[rn-1]=cells;
  }
  for(let i=0;i<rows.length;i++)if(!rows[i])rows[i]=[];
  return rows;
}
export function parseCsv(text){
  text=text.replace(/^\uFEFF/,'');
  const first=text.split(/\r?\n/,1)[0]||'',cnt=c=>first.split(c).length-1;
  const d=cnt('\t')>=cnt(';')&&cnt('\t')>=cnt(',')&&cnt('\t')>0?'\t':cnt(';')>cnt(',')?';':',';
  const rows=[];let r=[],f='',q=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(q){if(c==='"'){if(text[i+1]==='"'){f+='"';i++}else q=false}else f+=c}
    else if(c==='"')q=true;
    else if(c===d){r.push(f);f=''}
    else if(c==='\n'||c==='\r'){if(c==='\r'&&text[i+1]==='\n')i++;r.push(f);rows.push(r);r=[];f=''}
    else f+=c;
  }
  if(f!==''||r.length){r.push(f);rows.push(r)}
  return rows.map(x=>x.map(v=>{v=v.trim();return v===''?null:v}));
}
// بيقرا ملف من <input type=file>: .xlsx أو .csv (UTF-8 أو Windows-1256) ويرجّع {rows, bytes}
export async function readTableFile(file){
  const bytes=new Uint8Array(await file.arrayBuffer());
  if(bytes[0]===0x50&&bytes[1]===0x4b)return{rows:await readXlsx(bytes),bytes};
  if(/\.xls$/i.test(file.name)&&bytes[0]===0xD0)throw new Error('ده ملف Excel قديم (.xls) — احفظه كـ .xlsx أو CSV وجرّب تاني');
  let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes)}catch{text=new TextDecoder('windows-1256').decode(bytes)}
  return{rows:parseCsv(text),bytes};
}
