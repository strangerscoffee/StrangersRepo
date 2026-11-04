// A small PDF writer for the Kitchen Diary: A4 pages in Helvetica with text, boxes, lines, tables and the
// Strangers logo. It runs in the browser, so PDFs are made on the device with no outside service or library.
// Text uses the standard Helvetica fonts (no embedding) in WinAnsi encoding, which covers £, °, ×, – and accents.
// Exposes window.DiaryPDF: { create(opts) → Doc, Flow, save(bytes, fileName) }.
(function(){
"use strict";
// Advance widths (1/1000 em) for WinAnsi codes 32–255, from the standard Adobe font metrics.
const WIDTHS={r:[278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, 761, 556, 0, 222, 556, 333, 1000, 556, 556, 333, 1000, 667, 333, 1000, 0, 611, 0, 0, 222, 222, 333, 333, 350, 556, 1000, 333, 1000, 500, 333, 944, 0, 500, 667, 278, 333, 556, 556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 333, 400, 584, 333, 333, 333, 556, 537, 278, 333, 333, 365, 556, 834, 834, 834, 611, 667, 667, 667, 667, 667, 667, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278, 722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611, 556, 556, 556, 556, 556, 556, 889, 500, 556, 556, 556, 556, 278, 278, 278, 278, 556, 556, 556, 556, 556, 556, 556, 584, 611, 556, 556, 556, 556, 500, 556, 500],b:[278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584, 761, 556, 0, 278, 556, 500, 1000, 556, 556, 333, 1000, 667, 333, 1000, 0, 611, 0, 0, 278, 278, 500, 500, 350, 556, 1000, 333, 1000, 556, 333, 944, 0, 500, 667, 278, 333, 556, 556, 556, 556, 280, 556, 333, 737, 370, 556, 584, 333, 737, 333, 400, 584, 333, 333, 333, 611, 556, 278, 333, 333, 365, 556, 834, 834, 834, 611, 722, 722, 722, 722, 722, 722, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278, 722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611, 556, 556, 556, 556, 556, 556, 889, 556, 556, 556, 556, 556, 278, 278, 278, 278, 611, 611, 611, 611, 611, 611, 611, 584, 611, 611, 611, 611, 611, 556, 611, 556]};
const WIN={0x20ac:128,0x201a:130,0x192:131,0x201e:132,0x2026:133,0x2020:134,0x2021:135,0x2c6:136,0x2030:137,0x160:138,0x2039:139,0x152:140,
  0x17d:142,0x2018:145,0x2019:146,0x201c:147,0x201d:148,0x2022:149,0x2013:150,0x2014:151,0x2dc:152,0x2122:153,0x161:154,0x203a:155,0x153:156,0x17e:158,0x178:159};
const SUBS={"−":"-","≤":"<=","≥":">=","→":"->","←":"<-","✓":"Y","✔":"Y","✕":"x"," ":" "," ":" "," ":" ","​":""};
// One string → WinAnsi byte codes. Anything the font can't show becomes "?".
function codes(s){
  const out=[];
  for(let ch of String(s==null?"":s)){
    if(SUBS[ch]!=null){for(const c of SUBS[ch])out.push(c.charCodeAt(0));continue}
    const u=ch.codePointAt(0);
    if(u===9||u===10||u===13){out.push(32);continue}
    if(u<32)continue;
    if(u<127||(u>=160&&u<=255))out.push(u);
    else if(WIN[u])out.push(WIN[u]);
    else out.push(63);
  }
  return out;
}
const hex=cs=>"<"+cs.map(c=>c.toString(16).padStart(2,"0")).join("")+">";
function width(s,size,bold){const w=bold?WIDTHS.b:WIDTHS.r;let t=0;for(const c of codes(s))t+=w[c-32]||556;return t*size/1000}
const num=n=>(Math.round(n*100)/100).toString();
function rgb(c){
  if(!c)return null;
  const m=/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c);if(!m)return[0,0,0];
  return[1,2,3].map(i=>parseInt(m[i],16)/255);
}
// Break text into lines that fit `w` points. Keeps the person's own line breaks; splits words that are too long.
function wrap(s,w,size,bold){
  const lines=[];
  for(const para of String(s==null?"":s).split(/\r?\n/)){
    const words=para.split(/ +/);let line="";
    for(let word of words){
      const tryLine=line?line+" "+word:word;
      if(width(tryLine,size,bold)<=w){line=tryLine;continue}
      if(line)lines.push(line);
      while(width(word,size,bold)>w&&word.length>1){
        let k=word.length-1;while(k>1&&width(word.slice(0,k),size,bold)>w)k--;
        lines.push(word.slice(0,k));word=word.slice(k);
      }
      line=word;
    }
    lines.push(line);
  }
  return lines;
}

/** The text, shortened with an ellipsis if needed so it's no wider than w. */
function fit(s,w,size,bold){
  s=String(s==null?"":s);if(width(s,size,bold)<=w)return s;
  while(s.length>1&&width(s+"…",size,bold)>w)s=s.slice(0,-1);
  return s.trimEnd()+"…";
}

class Doc{
  constructor({landscape=false,title="",author=""}={}){
    this.W=landscape?841.89:595.28;this.H=landscape?595.28:841.89;
    this.title=title;this.author=author;this.pages=[];this.addPage();
  }
  addPage(){this.ops=[];this.pages.push(this.ops);return this}
  get pageCount(){return this.pages.length}
  onPage(i){this.ops=this.pages[i];return this}
  // Coordinates are from the top-left in points; y for text is the baseline.
  text(s,x,y,{size=10,bold=false,color="#111111",align="left",rotate=0}={}){
    const cs=codes(s);if(!cs.length)return this;
    const w=width(s,size,bold),dx=align==="right"?-w:align==="center"?-w/2:0;
    const c=rgb(color);
    let tm;
    if(rotate===90)tm=`0 1 -1 0 ${num(x)} ${num(this.H-y-dx)} Tm`;
    else tm=`1 0 0 1 ${num(x+dx)} ${num(this.H-y)} Tm`;
    this.ops.push(`BT /${bold?"F2":"F1"} ${num(size)} Tf ${c.map(num).join(" ")} rg ${tm} ${hex(cs)} Tj ET`);
    return this;
  }
  rect(x,y,w,h,{fill=null,stroke=null,lw=0.5}={}){
    if(!fill&&!stroke)return this;
    const f=rgb(fill),s=rgb(stroke);
    this.ops.push(`q ${f?f.map(num).join(" ")+" rg ":""}${s?s.map(num).join(" ")+" RG "+num(lw)+" w ":""}${num(x)} ${num(this.H-y-h)} ${num(w)} ${num(h)} re ${f&&s?"B":f?"f":"S"} Q`);
    return this;
  }
  line(x1,y1,x2,y2,{color="#999999",lw=0.5}={}){
    const c=rgb(color);
    this.ops.push(`q ${c.map(num).join(" ")} RG ${num(lw)} w ${num(x1)} ${num(this.H-y1)} m ${num(x2)} ${num(this.H-y2)} l S Q`);
    return this;
  }
  // A tick mark drawn as a line, `s` points wide, top-left at (x, y).
  tick(x,y,s,{color="#111111",lw=1.4}={}){
    const c=rgb(color),P=(a,b)=>`${num(x+a*s)} ${num(this.H-(y+b*s))}`;
    this.ops.push(`q ${c.map(num).join(" ")} RG ${num(lw)} w 1 J 1 j ${P(0.08,0.55)} m ${P(0.4,0.85)} l ${P(0.94,0.15)} l S Q`);
    return this;
  }
  // Fill an SVG path (absolute M, L, C, Z only, as in public/logo.svg) scaled into place, even-odd rule.
  svg(d,x,y,scale,{fill="#111111"}={}){
    const c=rgb(fill),out=[];const re=/([MLCZ])([^MLCZ]*)/gi;let m;
    const P=(px,py)=>`${num(x+px*scale)} ${num(this.H-(y+py*scale))}`;
    while((m=re.exec(d))){
      const n=(m[2].match(/-?\d*\.?\d+(?:e-?\d+)?/gi)||[]).map(Number),cmd=m[1].toUpperCase();
      if(cmd==="M")for(let i=0;i<n.length;i+=2)out.push(P(n[i],n[i+1])+(i?" l":" m"));
      else if(cmd==="L")for(let i=0;i<n.length;i+=2)out.push(P(n[i],n[i+1])+" l");
      else if(cmd==="C")for(let i=0;i<n.length;i+=6)out.push(`${P(n[i],n[i+1])} ${P(n[i+2],n[i+3])} ${P(n[i+4],n[i+5])} c`);
      else out.push("h");
    }
    this.ops.push(`q ${c.map(num).join(" ")} rg ${out.join(" ")} f* Q`);
    return this;
  }
  output(){
    const objs=[];const add=s=>{objs.push(s);return objs.length};
    const catalog=add(null),pagesId=add(null);
    const f1=add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    const f2=add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
    const kids=[];
    for(const ops of this.pages){
      const body=ops.join("\n");
      const cid=add(`<< /Length ${body.length} >>\nstream\n${body}\nendstream`);
      kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${num(this.W)} ${num(this.H)}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${cid} 0 R >>`));
    }
    objs[pagesId-1]=`<< /Type /Pages /Kids [${kids.map(k=>k+" 0 R").join(" ")}] /Count ${kids.length} >>`;
    objs[catalog-1]=`<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
    const d=new Date(),p=n=>String(n).padStart(2,"0");
    const info=add(`<< /Title ${hex(codes(this.title))} /Author ${hex(codes(this.author))} /Producer (Strangers Coffee Kitchen Diary) /CreationDate (D:${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}) >>`);
    let out="%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";const offs=[];
    objs.forEach((o,i)=>{offs.push(out.length);out+=`${i+1} 0 obj\n${o}\nendobj\n`});
    const xref=out.length;
    out+=`xref\n0 ${objs.length+1}\n0000000000 65535 f \n`+offs.map(o=>String(o).padStart(10,"0")+" 00000 n \n").join("");
    out+=`trailer\n<< /Size ${objs.length+1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const bytes=new Uint8Array(out.length);for(let i=0;i<out.length;i++)bytes[i]=out.charCodeAt(i)&255;
    return bytes;
  }
}

// Flowing layout on top of Doc: headings, paragraphs and tables that continue onto new pages,
// with a running header (drawn by `header(doc)` on every page) and "page x of y" footers added at the end.
class Flow{
  constructor(doc,{margin=34,header=null,footer=""}={}){
    this.doc=doc;this.m=margin;this.header=header;this.footer=footer;this.top=margin;this.y=margin;
    this.startPage(true);
  }
  get width(){return this.doc.W-2*this.m}
  get bottom(){return this.doc.H-this.m-16}
  startPage(first){
    if(!first)this.doc.addPage();
    this.y=this.m;
    if(this.header)this.y=this.header(this.doc,this.m,first)||this.m;
    // Where content starts on a continuation page, for rows that need a whole page.
    if(!first||this.contTop==null)this.contTop=this.y;
  }
  need(h){if(this.y+h>this.bottom){this.startPage(false);return true}return false}
  gap(h=8){this.y+=h;return this}
  // A heading that's wider than the page wraps; it stays on the same page as what follows it (keep).
  heading(t,{size=15,color="#111111",rule=true,keep=60}={}){
    const lines=wrap(t,this.width,size,true);
    this.need(lines.length*size*1.2+keep);
    lines.forEach((ln,i)=>{this.y+=i?size*1.2:size;this.doc.text(ln,this.m,this.y,{size,bold:true,color})});
    this.y+=6;if(rule){this.doc.line(this.m,this.y,this.m+this.width,this.y,{color:"#c9ced6",lw:0.6});this.y+=8}
    return this;
  }
  para(t,{size=9.5,color="#333333",bold=false,lh=1.35,indent=0}={}){
    for(const ln of wrap(t,this.width-indent,size,bold)){this.need(size*lh);this.y+=size*lh;this.doc.text(ln,this.m+indent,this.y-size*0.25,{size,color,bold})}
    return this;
  }
  // Label/value pairs in two columns. A long label wraps within its column; a value longer than the space left
  // carries on onto the next page (the first lines stay with the label).
  facts(pairs,{size=9.5,labelW=130}={}){
    const lh=size*1.35;
    for(const[k,v]of pairs.filter(p=>p[1]!=null&&p[1]!=="")){
      const labels=wrap(String(k),labelW-10,size,true),lines=wrap(String(v),this.width-labelW,size,false);
      const n=Math.max(labels.length,lines.length);
      this.need(Math.min(n,Math.max(3,labels.length))*lh+2);
      for(let i=0;i<n;i++){
        if(i)this.need(lh);
        if(labels[i])this.doc.text(labels[i],this.m,this.y+size,{size,bold:true,color:"#555555"});
        if(lines[i])this.doc.text(lines[i],this.m+labelW,this.y+size,{size});
        this.y+=lh;
      }
      this.y+=2;
    }
    return this;
  }
  // cols: [{label, w (points, or a share of the rest when "flex"), align, size}];
  // rows: arrays of cells, each a string or {t, color, fill, bold, tick}.
  table(cols,rows,{size=8,head=8,pad=3.5,zebra="#f4f6f9",headFill="#2b2f36",headColor="#ffffff",headH=null,rotateHead=false,lineColor="#d9dde3"}={}){
    const fixed=cols.reduce((a,c)=>a+(typeof c.w==="number"?c.w:0),0),flex=cols.filter(c=>typeof c.w!=="number");
    const share=(this.width-fixed)/Math.max(1,flex.reduce((a,c)=>a+(c.flex||1),0));
    const ws=cols.map(c=>typeof c.w==="number"?c.w:share*(c.flex||1));
    const lh=size*1.3;
    // Shrink a heading's type (down to 5.5pt) until its longest word fits the column, so words don't break.
    const hs=cols.map((c,i)=>{let z=head;if(rotateHead&&c.rotate)return z;
      const longest=Math.max(...String(c.label).split(/\s+/).map(w=>width(w,1,true)));
      while(z>5.5&&longest*z>ws[i]-2*pad)z-=0.25;return z});
    const headLines=cols.map((c,i)=>rotateHead&&c.rotate?[c.label]:wrap(c.label,ws[i]-2*pad,hs[i],true));
    const hh=headH||Math.max(...headLines.map((l,i)=>l.length*hs[i]*1.25))+2*pad;
    const drawHead=()=>{
      let x=this.m;
      this.doc.rect(this.m,this.y,this.width,hh,{fill:headFill});
      cols.forEach((c,i)=>{
        if(rotateHead&&c.rotate)this.doc.text(c.label,x+ws[i]/2+head*0.35,this.y+hh-pad,{size:head,bold:true,color:headColor,rotate:90});
        else headLines[i].forEach((ln,j)=>{
          const tx=c.align==="center"?x+ws[i]/2:c.align==="right"?x+ws[i]-pad:x+pad;
          this.doc.text(ln,tx,this.y+pad+hs[i]*0.95+j*hs[i]*1.25,{size:hs[i],bold:true,color:headColor,align:c.align||"left"});
        });
        x+=ws[i];
      });
      this.y+=hh;
    };
    this.need(hh+lh+2*pad);drawHead();
    rows.forEach((row,ri)=>{
      const cells=row.map(c=>c!=null&&typeof c==="object"?c:{t:c==null?"":String(c)});
      const bold=cells.map((c,i)=>!!c.bold||!!cols[i].bold);
      // A word too long for its column first gets smaller type (down to 6pt), so it isn't broken in two.
      const zs=cells.map((c,i)=>{let z=cols[i].size||size;if(c.tick)return z;
        const longest=Math.max(0,...String(c.t||"").split(/\s+/).map(w=>width(w,1,bold[i])));
        while(z>6&&longest*z>ws[i]-2*pad)z-=0.25;return z});
      const lines=cells.map((c,i)=>c.tick?[""]:wrap(c.t||"",ws[i]-2*pad,zs[i],bold[i]));
      const tall=Math.max(...lines.map(l=>l.length));
      const rh=tall*lh+2*pad;
      // A row that doesn't fit on a fresh page is drawn in parts, carrying on under the heading on the next page.
      const room=this.bottom-this.contTop-hh;
      if(rh<=room){if(this.need(rh))drawHead()}
      let from=0;
      while(from<tall){
        let fit=Math.floor((this.bottom-this.y-2*pad)/lh);
        if(fit<1){this.startPage(false);drawHead();fit=Math.floor((this.bottom-this.y-2*pad)/lh)}
        const to=Math.min(tall,from+fit),ph=(to-from)*lh+2*pad;
        if(zebra&&ri%2===1)this.doc.rect(this.m,this.y,this.width,ph,{fill:zebra});
        let x=this.m;
        cells.forEach((c,i)=>{
          if(c.fill)this.doc.rect(x,this.y,ws[i],ph,{fill:c.fill});
          if(c.tick){if(!from){const s=Math.min(ws[i]-4,10);this.doc.tick(x+(ws[i]-s)/2,this.y+(ph-s)/2,s,{color:c.color||"#111111"})}}
          else lines[i].slice(from,to).forEach((ln,j)=>{
            const al=cols[i].align,tx=al==="center"?x+ws[i]/2:al==="right"?x+ws[i]-pad:x+pad;
            this.doc.text(ln,tx,this.y+pad+zs[i]*0.95+j*lh,{size:zs[i],bold:bold[i],color:c.color||"#1a1a1a",align:al||"left"});
          });
          x+=ws[i];
        });
        this.y+=ph;
        this.doc.line(this.m,this.y,this.m+this.width,this.y,{color:lineColor,lw:0.4});
        from=to;
      }
    });
    return this;
  }
  // Footers on every page: the given text on the left, "Page x of y" on the right.
  finish(){
    const n=this.doc.pageCount;
    for(let i=0;i<n;i++){
      this.doc.onPage(i);
      const y=this.doc.H-this.m+4;
      this.doc.line(this.m,y-10,this.doc.W-this.m,y-10,{color:"#d9dde3",lw:0.4});
      const pg=`Page ${i+1} of ${n}`;
      // The footer text is shortened (with …) so it never runs into the page number.
      if(this.footer)this.doc.text(fit(this.footer,this.width-width(pg,7.5,false)-16,7.5,false),this.m,y,{size:7.5,color:"#666666"});
      this.doc.text(pg,this.doc.W-this.m,y,{size:7.5,color:"#666666",align:"right"});
    }
    return this.doc.output();
  }
}

// Hand the PDF to the person: the share sheet on iPhone and iPad (Save to Files, Print, AirDrop), a download elsewhere.
function save(bytes,name){
  const file=typeof File==="function"?new File([bytes],name,{type:"application/pdf"}):null;
  const touchApple=/iPad|iPhone|iPod/.test(navigator.userAgent)||(navigator.platform==="MacIntel"&&navigator.maxTouchPoints>1);
  if(touchApple&&file&&navigator.canShare&&navigator.canShare({files:[file]})){
    return navigator.share({files:[file],title:name.replace(/\.pdf$/,"")}).then(()=>"shared",e=>e&&e.name==="AbortError"?"cancelled":download(bytes,name));
  }
  return Promise.resolve(download(bytes,name));
}
function download(bytes,name){
  const url=URL.createObjectURL(new Blob([bytes],{type:"application/pdf"}));
  const a=document.createElement("a");a.href=url;a.download=name;a.rel="noopener";
  document.body.append(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),60000);
  return "downloaded";
}

window.DiaryPDF={create:o=>new Doc(o),Doc,Flow,wrap,width,fit,save};
})();
