// Reports: PDFs made on the device (public/pdf.js), the allergen matrix PDF and EHO inspection mode.

/* ---------- PDFs made on the device (public/pdf.js) ---------- */
let LOGO_D=null;
fetch("/logo.svg").then(r=>r.ok?r.text():"").then(t=>{const m=/ d="([^"]+)"/.exec(t||"");LOGO_D=m?m[1]:null}).catch(()=>{});
const fullName=id=>id&&id===S.me?(S.myName||"you"):nameOf(id);
const longNow=()=>new Date().toLocaleString("en-GB",{day:"numeric",month:"long",year:"numeric",hour:"2-digit",minute:"2-digit",timeZone:UK});
const pdfDate=s=>s?parse(s).toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric"}):"";
// Running header: the Strangers logo, a title and up to three lines underneath. Returns where the page body starts.
function pdfHeader(title,lines){
  return(doc,m)=>{
    if(LOGO_D)doc.svg(LOGO_D,m,m,0.31);
    const x=m+(LOGO_D?78:0);
    const fitW=doc.W-m-x,P=window.DiaryPDF;
    doc.text(P.fit(title,fitW,17,true),x,m+17,{size:17,bold:true});
    (lines||[]).slice(0,3).forEach((l,i)=>doc.text(P.fit(l,fitW,8.5,false),x,m+31+i*11,{size:8.5,color:"#555555"}));
    const y=m+Math.max(42,31+(lines||[]).length*11);
    doc.line(m,y,doc.W-m,y,{color:"#2b2f36",lw:0.8});
    return y+12;
  };
}
// Cell styles in PDF tables, matching the pills on screen.
const PDF_CLS={bad:{color:"#b3261e",fill:"#fde2df"},warn:{color:"#7a4b00",fill:"#fff1d6"},ok:{color:"#17733a"},muted:{color:"#777777"}};
PDF_CLS.okfill={color:"#17733a",fill:"#dcf3e3"};PDF_CLS.warnfill={color:"#7a4b00",fill:"#ffe7b8"};PDF_CLS.badfill={color:"#b3261e",fill:"#fbd3cf"};
// The risk key in a PDF: the formula, both numbered scales, the three bands and the 5×5 grid of scores.
function riskKeyPdf(f){
  f.need(310); // keep the whole key on one page
  f.para("Risk = likelihood × severity: score each from 1 to 5, then multiply.",{size:9.5,bold:true,color:"#111111"}).gap(4);
  pdfTable(f,[{l:"Score",w:40,align:"center"},{l:"Likelihood",flex:1},{l:"Severity",flex:1}],
    [0,1,2,3,4].map(i=>[{t:String(i+1),b:true},`${RISK_L[i][0]}: ${RISK_L[i][1].toLowerCase()}`,`${RISK_S[i][0]}: ${RISK_S[i][1].toLowerCase()}`]),{size:8,head:8});
  f.gap(8);
  const fillOf=v=>riskBand(v)[0]+"fill";
  pdfTable(f,[{l:"Risk score",w:90},{l:"Band",w:70},{l:"What to do",flex:1}],RISK_BANDS.map(([c,l,r,a])=>[{t:r,cls:c+"fill",b:true},{t:l,cls:c+"fill",b:true},a]),{size:8,head:8});
  f.gap(8);f.need(120);
  pdfTable(f,[{l:"Likelihood (down) × Severity (across)",w:130},...[1,2,3,4,5].map(s=>({l:`${s} ${RISK_S[s-1][0]}`,w:80,align:"center"}))],
    [5,4,3,2,1].map(l=>[{t:`${l} ${RISK_L[l-1][0]}`,b:true},...[1,2,3,4,5].map(s=>({t:`${l*s} ${riskBand(l*s)[1]}`,cls:fillOf(l*s),b:true}))]),{size:8,head:8,zebra:null});
}
const pdfCell=c=>{if(c==null||typeof c!=="object")return c;const st=PDF_CLS[c.cls]||{};return{t:c.t,bold:c.b,tick:c.tick,color:st.color,fill:c.tick?"#fde2df":st.fill,...(c.tick?{color:"#b3261e"}:{})}};
function pdfTable(f,cols,rows,opts){f.table(cols.map(c=>({label:c.l,w:c.w,flex:c.flex,align:c.align,rotate:c.rotate,bold:c.bold})),rows.map(r=>r.map(pdfCell)),opts)}

/* ---------- allergen matrix PDF ---------- */
const allergenItems=()=>[...S.allergens].sort((a,b)=>(a.name||"").localeCompare(b.name||""));
// Drinks and Food: a site can keep its allergen items in two sections (on by default at the Cafe; Setup turns it on
// or off per site). An item's kind is "food" or "drink"; items without one are drinks.
const ALG_SECTIONS=[["drink","Drinks"],["food","Food"]];
const algSectionsOn=(s,site)=>{s=s||S.settings;return s.allergenSections!=null?!!s.allergenSections:(site||S.site)==="cafe"};
const algKind=it=>it&&it.kind==="food"?"food":"drink";
// Shown once above the Food section (and in the PDF and inspection mode). The Cafe's own wording comes from its sheet.
const algFoodNote=()=>S.site==="cafe"
  ?"Allergy? Ask us first. Our cakes and pastries are unwrapped and are kept and served together, so allergens can pass between them: every product is marked with every allergen we handle (cereals containing gluten: wheat, oats; tree nuts: hazelnuts, walnuts, almonds, pecan nuts). Do not serve to anyone allergic to a marked allergen. Information comes from our suppliers' allergen specifications and is checked against product labels on delivery. Recipes can change, so always ask."
  :"Food kept and served together can pass allergens between it. If a customer has an allergy or intolerance, check here and ask a manager before serving.";
// Allergens found in every item of a list, and the ones in none of them.
function algSummary(items){
  const inAll=items.length?ALLERGENS.filter(a=>items.every(it=>(it.contains||[]).includes(a))):[];
  const inNone=ALLERGENS.filter(a=>!items.some(it=>(it.contains||[]).includes(a)));
  return{inAll,inNone};
}
// The Cafe's cakes & bakes from its allergen sheet (Cakesmiths and Anglia Culinary Suppliers), added in one tap.
const CAFE_BAKES_CONTAINS=["Cereals with gluten","Eggs","Milk","Tree nuts","Peanuts","Sesame","Soya","Sulphites"];
const CAFE_BAKES=[["Traditional Pastel de Nata","Cakesmiths · 7201"],["Candied Toffee Apple","Cakesmiths · 4171"],["Ultimate Carrot Traycake","Cakesmiths · 4065"],
  ["Salted Caramel Brownie","Cakesmiths · 2065"],["Apple & Blackcurrant Crumblejack","Cakesmiths · 9025"],["Morello Cherry Blondie","Cakesmiths · 2191"],
  ["S'mores Bar","Cakesmiths · 2293","Contains pork gelatine."],["Sticky Toffee with Biscoff® Spread","Cakesmiths · 4087"],["Pumpkin, Maple & Chai","Cakesmiths · 4140"],
  ["Blackcurrant Ripple","Cakesmiths · 4162"],["Plain Croissant","Anglia Culinary Suppliers"],["Almond Croissant","Anglia Culinary Suppliers"],
  ["Pain aux Raisins","Anglia Culinary Suppliers"],["Vegan Sausage Roll","Anglia Culinary Suppliers"],["Cheese Twist","Anglia Culinary Suppliers"]];
async function addCafeBakes(btn){
  if(ro())return;
  const have=new Set(S.allergens.filter(i=>algKind(i)==="food").map(i=>normT(i.name)));
  const todo=CAFE_BAKES.filter(([n])=>!have.has(normT(n)));
  if(!todo.length){toast("They're all on the list already");return}
  btn.disabled=true;btn.textContent="Adding…";let n=0;
  for(const[name,source,extra]of todo){
    const ok=await save(()=>C("allergens").add({name,source,contains:[...CAFE_BAKES_CONTAINS],notes:extra||"",kind:"food",by:S.me,at:Date.now()}));
    if(ok)n++;
  }
  toast(`Added ${n} cakes & bakes to Food`);
}
const ALG_COLS=()=>[{l:"Menu item",w:165,bold:true},...ALLERGENS.map(a=>({l:a,w:27,align:"center",rotate:true})),{l:"Notes: may contain, swaps",flex:1}];
const algRows=items=>items.map(it=>{const h=new Set(it.contains||[]);
  return[it.name,...ALLERGENS.map(a=>h.has(a)?{tick:true}:""),[it.notes,it.source?"Source: "+it.source:""].filter(Boolean).join("\n")]});
const ALG_KEY="A tick means the item contains that allergen, or an ingredient made from it. Cereals with gluten include wheat, rye, barley and oats; tree nuts include almonds, hazelnuts, walnuts, cashews, pecans, Brazil nuts, pistachios and macadamias; sulphites are listed above 10 mg/kg. Recipes and suppliers change: check this matrix is current, and if a customer has an allergy and you're not sure, ask a manager before serving.";
function allergenPdf(){
  const items=allergenItems();
  if(!items.length){toast("Add menu items first: the matrix is made from them.");return}
  const P=window.DiaryPDF,site=curSite(),addr=siteAddr(S.site,S.settings);
  const last=Math.max(...items.map(i=>i.at||0));
  const doc=P.create({landscape:true,title:`Allergen matrix - Strangers Coffee ${site.name}`,author:S.myName});
  const f=new P.Flow(doc,{footer:`Strangers Coffee ${site.name} · allergen matrix · made ${longNow()}`,
    header:pdfHeader("Allergen matrix",[`Strangers Coffee ${site.name} · ${addr}`,`The 14 allergens UK law requires you to declare · ${items.length} menu item${items.length===1?"":"s"}${last?" · last changed "+new Date(last).toLocaleDateString("en-GB",{timeZone:UK,day:"numeric",month:"long",year:"numeric"}):""}`])});
  const secs=algSectionsOn()?ALG_SECTIONS.map(([k,t])=>[k,t,items.filter(it=>algKind(it)===k)]).filter(x=>x[2].length):[[null,"",items]];
  secs.forEach(([k,title,list],i)=>{
    if(i)f.startPage(false);
    if(title)f.heading(`${title} allergens`,{size:14});
    if(k==="food")f.para(algFoodNote(),{size:8.5,color:"#444444"}).gap(4);
    if(title){const sm=algSummary(list);
      f.facts([[k==="food"?"In every item":"In every drink",sm.inAll.join(", ")||"None"],["Not used",sm.inNone.join(", ")||"None"]],{size:8.5,labelW:100}).gap(4)}
    pdfTable(f,ALG_COLS(),algRows(list),{rotateHead:true,headH:96,size:8.5});
  });
  f.gap(10).para(ALG_KEY,{size:8.5,color:"#444444"});
  P.save(f.finish(),`Allergen matrix - Strangers ${site.name} - ${today()}.pdf`);
}

/* ---------- EHO inspection mode ----------
   Everything an Environmental Health Officer usually asks to see, for one site and a chosen period, in one view
   that can be exported as a PDF. Read-only, and open to everyone signed in, so whoever is on shift can show it. */
const IN_RANGES=[["1","Last month"],["2","Last 2 months"],["3","Last 3 months"],["6","Last 6 months"],["12","Last 12 months"],["custom","Choose dates"]];
let IN={range:(()=>{try{return localStorage.getItem("sfbb.inRange")||"1"}catch(e){return"1"}})(),from:"",to:"",data:null,key:"",loading:null,err:""};
function inPeriod(){
  if(IN.range==="custom"){const a=$("#inFrom").value,b=$("#inTo").value;if(!a||!b)return null;return a<=b?{from:a,to:b}:{from:b,to:a}}
  // N months back to the same day (or the month's last day: a month back from 31 March is 28 or 29 February, not
  // 3 March), then the day after, so the period is exactly the last N months.
  const t=parse(today()),y=t.getFullYear(),mo=t.getMonth()-Number(IN.range),last=new Date(y,mo+1,0).getDate();
  const d=new Date(y,mo,Math.min(t.getDate(),last),12);d.setDate(d.getDate()+1);
  return{from:iso(d),to:today()};
}
function inspectForm(){
  const box=$("#inChips");
  for(const[k,l]of IN_RANGES)box.append(el("button",{type:"button",role:"radio","data-r":k,onclick:()=>{IN.range=k;try{localStorage.setItem("sfbb.inRange",k)}catch(e){}renderInspect()}},l));
  $("#inFrom").value=addDays(today(),-27);$("#inTo").value=today();
  for(const x of["#inFrom","#inTo"])$(x).addEventListener("change",()=>renderInspect());
  $("#inPdf").addEventListener("click",inspectPdf);
}
async function loadInspect(site,p){
  const key=`${site}|${p.from}|${p.to}`;
  // The same period is kept unless the site's records have changed since (IN.stale): then it's fetched again,
  // still showing what's loaded until the new copy arrives.
  if(IN.key===key&&(IN.loading||(IN.data&&!IN.stale)))return;
  if(IN.key!==key)IN.data=null;
  IN.key=key;IN.stale=false;IN.err="";
  const get=async(col,order,limit)=>(await C(col,site).orderBy(order,"desc").limit(limit).get()).docs.map(d=>({id:d.id,...d.data()}));
  const job=IN.loading=Promise.all([get("days","date",2000),get("weeks","week",500),get("reviews","date",500),get("proveit","at",2000),get("deliveries","at",2000)]).then(([days,weeks,reviews,prove,deliveries])=>{
    if(IN.loading!==job)return;
    const inR=d=>d&&d>=p.from&&d<=p.to;
    IN.data={site,from:p.from,to:p.to,days:Object.fromEntries(days.map(d=>[d.id,d])),weeks:weeks.filter(w=>w.week<=p.to&&addDays(w.week,6)>=p.from),
      reviews:reviews.filter(r=>inR(r.date)),prove:prove.filter(r=>inR(r.date)),deliveries:deliveries.filter(r=>inR(r.date))};
    IN.loading=null;
    const ids=[];for(const d of days){if(d.signed)ids.push(d.signed.by);if(d.problems)ids.push(d.problems.by);if(d.opening)ids.push(d.opening.by);if(d.closing)ids.push(d.closing.by)}
    resolveNames(ids);
    if(S.tab==="inspect")renderInspect();
  },e=>{if(IN.loading!==job)return;IN.loading=null;IN.key="";IN.err=(e&&e.message)||"Couldn't load the records.";if(S.tab==="inspect")renderInspect()});
}
// Every section of the report, built once and drawn both on screen and in the PDF.
// A cell is text or {t, cls:"ok"|"warn"|"bad"|"muted", b:bold, tick}.
function inspectSections(R){
  const s=S.settings,cfg=S.cfg,site=curSite(),out=[];
  const inR=d=>d&&d>=R.from&&d<=R.to,atIn=ts=>ts&&inR(dayOf(ts));
  const dates=[];for(let d=R.to;d>=R.from;d=addDays(d,-1))dates.push(d);
  const keys=Object.keys(R.days).sort(),start=s.startDate||keys[0]||R.to;
  const units=[...s.units];
  for(const d of Object.values(R.days))for(const id of Object.keys(d.temps||{}))if(!units.some(u=>u.id===id))units.push({id,name:"Unit "+id,kind:"fridge"});
  const tval=(d,u)=>{const r=d&&d.temps&&d.temps[u.id]&&d.temps[u.id].am;return r&&r.v!=null?Number(r.v):null};

  // Daily diary
  let open=0,complete=0,partial=0,missing=0,readings=0,outOfRange=0;
  const dayRows=[],tempRows=[],actions=[];
  for(const date of dates){
    const d=R.days[date],st=dayStatus(d,cfg,date),cl=closure(d),closed=!!cl||isClosed(date,s)&&!(st.any),before=date<start;
    if(before&&(hardStart(s)||!d))continue;
    if(closed){dayRows.push([pdfDate(date),{t:cl?"Closed: "+cl.reason:"Closed",cls:"muted"},"","","",cl?`Marked by ${fullName(cl.by)}, ${when(cl.at)}`:""]);continue}
    open++;
    if(!d||!st.any){
      if(date===today()){open--;dayRows.push([pdfDate(date),{t:"Today: not started yet",cls:"warn"},"","","",""]);continue}
      missing++;dayRows.push([pdfDate(date),{t:"Not recorded",cls:"bad"},"","","",""]);continue}
    if(st.complete)complete++;else partial++;
    const part=(n,t,by)=>({t:`${n}/${t}${by&&n?" · "+fullName(by):""}`,cls:n>=t?"ok":n?"warn":"bad"});
    const temps=units.map(u=>{const v=tval(d,u);if(v==null)return null;readings++;const c=tempState(u.kind,v);if(c==="bad")outOfRange++;return{u,v,c}}).filter(Boolean);
    dayRows.push([pdfDate(date),part(st.oN,st.oT,d.opening&&d.opening.by),
      {t:temps.length?temps.map(x=>`${x.u.name} ${x.v}°C`).join(", "):"None",cls:temps.some(x=>x.c==="bad")?"bad":temps.length<units.length?"warn":"ok"},
      part(st.cN,st.cT,d.closing&&d.closing.by),
      d.signed?{t:d.signed.name||fullName(d.signed.by),cls:"ok"}:{t:"Not signed",cls:"bad"},
      d.problems&&d.problems.text?d.problems.text:""]);
    if(units.length)tempRows.push([pdfDate(date),...units.map(u=>{const v=tval(d,u),rr=tlReading(d,u),ch=rr&&(rr.was||rr.amended||rr.late)?" *":"";
      return v==null?{t:"–"+(rr&&rr.was?" *":""),cls:"muted"}:{t:v+"°C"+ch,cls:tempState(u.kind,v)==="bad"?"bad":tempState(u.kind,v)==="warn"?"warn":""}})]);
    for(const x of temps.filter(x=>x.c==="bad"))actions.push({date,area:"Temperature",what:`${x.u.name} read ${x.v}°C (${x.u.kind==="freezer"?"should be −18°C or below":"should be 5°C or below"})`,
      did:d.problems&&d.problems.text?d.problems.text:{t:"No action noted",cls:"bad"},by:d.problems?fullName(d.problems.by):""});
    if(d.problems&&d.problems.text&&!temps.some(x=>x.c==="bad"))actions.push({date,area:"Daily diary",what:"Problem or change noted",did:d.problems.text,by:fullName(d.problems.by)});
  }
  for(const w of R.weeks)if(w.notes&&w.notes.text&&addDays(w.week,6)>=(hardStart(s)||""))actions.push({date:w.week,area:"Week",what:"Weekly note",did:w.notes.text,by:fullName(w.notes.by)});
  for(const r of R.prove.filter(r=>r.pass===false))actions.push({date:r.date,area:"Prove it",what:`${(PROVE[r.method]||{label:r.method}).label}: ${r.food}${r.reading!=null?" "+r.reading+(r.unit==="min"?" min":"°C"):""} failed`,did:r.action||{t:"No action noted",cls:"bad"},by:fullName(r.by)});
  for(const r of R.deliveries){const p=[r.chilled!=null&&r.chilled>8?`chilled ${r.chilled}°C`:"",r.frozen!=null&&r.frozen>-15?`frozen ${r.frozen}°C`:"",r.packaging==="no"?"packaging damaged":"",r.order==="no"?"not what was ordered":""].filter(Boolean);
    if(r.outcome==="rejected"||p.length)actions.push({date:r.date,area:"Delivery",what:`${r.supplier}: ${p.join(", ")||"rejected"}`,did:`${r.outcome==="rejected"?"Rejected":"Accepted"}${r.note?": "+r.note:""}`,by:fullName(r.by)})}
  const maintAll=S.maintenance;
  for(const m of maintAll)if(m.status==="done"&&atIn(m.doneAt))actions.push({date:dayOf(m.doneAt),area:"Maintenance",what:m.title+(m.area?` (${m.area})`:""),did:m.fixNote||"Done",by:fullName(m.doneBy)});
  const insp=inspSorted()[0];
  if(insp)for(const i of(insp.issues||[]))if(i.done&&atIn(i.doneAt))actions.push({date:dayOf(i.doneAt),area:"EHO issue",what:i.issue,did:i.fixNote||"Fixed",by:fullName(i.doneBy)});
  actions.sort((a,b)=>b.date.localeCompare(a.date));

  // Cleaning and extra checks
  const taskRows=kind=>S[kind].slice().sort((a,b)=>(a.name||"").localeCompare(b.name||"")).map(t=>{const ts=taskState(t),n=(t.log||[]).filter(e=>atIn(e.at)).length;
    return[t.name,t.how||"",(t.freq||"").replace(/^./,c=>c.toUpperCase()),t.who||"",t.lastAt?lastWhen(t.lastAt,t.lastSet)+", "+fullName(t.lastBy):{t:"Never",cls:"bad"},String(n),{t:ts.overdue?ts.text:"Up to date",cls:ts.overdue?"bad":"ok"}]});
  const overdue=["cleaning","extras"].reduce((k,kind)=>k+S[kind].filter(t=>taskState(t).overdue).length,0);
  const topics=siteTopics(),trained=S.staff.filter(p=>topics.every(([k])=>p.topics&&p.topics[k])).length;
  const openM=maintAll.filter(m=>m.status!=="done"),urgent=openM.filter(m=>m.priority==="urgent").length;
  const rej=R.deliveries.filter(r=>r.outcome==="rejected").length,pf=R.prove.filter(r=>r.pass===false).length;
  const plansDue=S.plans.filter(d=>reviewState(d).overdue).length;
  const period=`${pdfDate(R.from)} to ${pdfDate(R.to)}`;

  out.push({id:"summary",title:"At a glance",
    stats:[[`${complete}/${open}`,"days fully recorded",missing?"bad":partial?"warn":"ok"],[String(outOfRange),"temperatures out of range",outOfRange?"warn":"ok"],[String(actions.length),"corrective actions"],
      [`${trained}/${S.staff.length}`,"staff fully trained",trained<S.staff.length?"warn":"ok"],[String(R.deliveries.length),`deliveries checked${rej?`, ${rej} rejected`:""}`],[String(overdue),"cleaning & checks overdue now",overdue?"bad":"ok"]],
    facts:[["Site",`Strangers Coffee ${site.name}`],["Address",siteAddr(S.site,s)],["Manager",(s.info&&s.info.manager)||""],["Period",period],
      ["Opening days",WEEKDAYS.filter(([k])=>!s.closedDays.includes(k)).map(([,l])=>l).join(", ")],
      ["Daily diary",`${open} open days: ${complete} complete, ${partial} partly recorded, ${missing} not recorded`],
      ["Temperatures",`${readings} readings, ${outOfRange} out of range · ${units.map(u=>u.name).join(", ")||"no fridges or freezers"}`],
      ["Prove it checks",`${R.prove.length} in the period${pf?`, ${pf} failed`:""}`],
      ["Maintenance",`${openM.length} open${urgent?`, ${urgent} urgent`:""}`],
      ["HACCP & risk",`${S.plans.length} document${S.plans.length===1?"":"s"}${plansDue?`, ${plansDue} due for review`:""}`],
      ["Last EHO inspection",insp?`${pdfDate(insp.inspectionDate)}${insp.rating!=null&&insp.rating!==""?" · rating "+insp.rating:""}`:"None recorded"],
      ["Prepared",`${longNow()} by ${S.myName||"a team member"}`]]});
  out.push({id:"documents",title:"Food safety documents",
    cols:[{l:"Document",flex:2,bold:true},{l:"Type",w:110},{l:"Dated",w:80},{l:"Next review",w:80},{l:"Status",w:110}],
    rows:[...S.plans.slice().sort((a,b)=>(a.title||"").localeCompare(b.title||"")).map(d=>{const rs=reviewState(d);return[d.title||PL_NAME[d.type],PL_NAME[d.type],pdfDate(d.date),pdfDate(d.reviewDate),{t:rs.text,cls:rs.cls}]}),
      ["Allergen matrix","Allergens","","",{t:`${S.allergens.length} menu items`,cls:S.allergens.length?"ok":"bad"}],
      ["Cleaning schedule","Cleaning","","",{t:`${S.cleaning.length} jobs`,cls:S.cleaning.length?"ok":"bad"}],
      ["Supplier list","Suppliers","","",{t:`${S.suppliers.length} suppliers`,cls:S.suppliers.length?"ok":"warn"}],
      ["Staff training records","Training","","",{t:`${S.staff.length} people`,cls:S.staff.length?"ok":"warn"}],
      ...S.onboarding.map(d=>[d.title||"Onboarding document",d.category||"Onboarding",pdfDate(d.date),pdfDate(d.reviewDate),""])],
    empty:""});
  out.push({id:"daily",title:"Daily diary",intro:`Opening checks, temperatures, closing checks and sign-off for each day the ${site.name} was open.`,
    cols:[{l:"Date",w:80},{l:"Opening checks",w:120},{l:"Temperatures",flex:1.2},{l:"Closing checks",w:120},{l:"Signed off by",w:100},{l:"Problems & changes",flex:1.5}],rows:dayRows,empty:"No days in this period."});
  if(units.length)out.push({id:"temps",title:"Temperature log",intro:"Fridges 5°C or below (8°C legal maximum). Freezers −18°C or below. * added later, or changed: the original reading, who changed it and why are kept in Records → Temperature log.",
    cols:[{l:"Date",w:80},...units.map(u=>({l:u.name,flex:1,align:"center"}))],rows:tempRows,empty:"No readings in this period."});
  out.push({id:"actions",title:"Corrective actions",intro:"Problems found and what was done about them: diary notes, temperatures out of range, failed Prove it checks, deliveries, maintenance and inspection issues.",
    cols:[{l:"Date",w:80},{l:"Area",w:80},{l:"What happened",flex:1.2},{l:"What was done",flex:1.5},{l:"By",w:90}],
    rows:actions.map(a=>[pdfDate(a.date),a.area,a.what,a.did,a.by]),empty:"No problems recorded in this period."});
  if(cfg.weekly.length)out.push({id:"weekly",title:"End-of-week checks",
    cols:[{l:"Week starting",w:90},{l:"Checks done",w:90},{l:"Signed off by",w:110},{l:"Notes",flex:1}],
    rows:R.weeks.filter(w=>addDays(w.week,6)>=(hardStart(s)||"")).sort((a,b)=>b.week.localeCompare(a.week)).map(w=>{const wl=checksOn(cfg.weekly,addDays(w.week,6)),n=wl.filter(c=>w.items&&w.items[c.id]).length;
      return[pdfDate(w.week),{t:`${n}/${wl.length}`,cls:n>=wl.length?"ok":n?"warn":"bad"},w.signed?{t:w.signed.name||fullName(w.signed.by),cls:"ok"}:{t:"Not signed",cls:"bad"},w.notes&&w.notes.text||""]}),empty:"No weeks recorded in this period."});
  const tcols=[{l:"Task",flex:1.2,bold:true},{l:"Method",flex:1.6},{l:"How often",w:70},{l:"Who",w:80},{l:"Last done",w:110},{l:"Done in period",w:60,align:"center"},{l:"Status",w:95}];
  out.push({id:"cleaning",title:"Cleaning schedule",cols:tcols,rows:taskRows("cleaning"),empty:"No cleaning jobs listed."});
  if(S.extras.length)out.push({id:"extras",title:"Extra checks",cols:tcols,rows:taskRows("extras"),empty:""});
  out.push({id:"prove",title:"Prove it checks",intro:"Probe checks of cooking, reheating, cooling and hot holding, and thermometer accuracy.",
    cols:[{l:"Date",w:80},{l:"Check",w:120},{l:"Food or equipment",flex:1},{l:"Reading",w:60,align:"center"},{l:"Result",w:55,align:"center"},{l:"Action",flex:1.2},{l:"By",w:90}],
    rows:R.prove.slice().sort((a,b)=>(b.date||"").localeCompare(a.date||"")).map(r=>[pdfDate(r.date),(PROVE[r.method]||{label:r.method}).label,r.food,r.reading==null?"":`${r.reading}${r.unit==="min"?" min":"°C"}`,{t:r.pass?"Pass":"Fail",cls:r.pass?"ok":"bad"},r.action||"",fullName(r.by)]),
    empty:"No Prove it checks in this period."});
  out.push({id:"deliveries",title:"Deliveries",intro:"Chilled 8°C or below (ideally 5°C), frozen −15°C or below (ideally −18°C), packaging undamaged and what was ordered.",
    cols:[{l:"Date",w:72},{l:"Supplier",flex:1,bold:true},{l:"Delivered",flex:1},{l:"Chilled",w:46,align:"center"},{l:"Frozen",w:46,align:"center"},{l:"Packaging",w:58,align:"center"},{l:"Order",w:50,align:"center"},{l:"Outcome",w:60,align:"center"},{l:"Notes",flex:1.3},{l:"By",w:78}],
    rows:R.deliveries.slice().sort((a,b)=>(b.at||0)-(a.at||0)).map(r=>{const tc=(k,v)=>{const x=dlvTempState(k,v);return x?{t:v+"°C",cls:x.cls==="ok"?"":x.cls}:r.noTemp?{t:"n/a",cls:"muted"}:""};
      return[pdfDate(r.date)+(r.at?" "+time(r.at):""),r.supplier,r.items||"",tc("chilled",r.chilled),tc("frozen",r.frozen),{t:r.packaging==="ok"?"OK":"Damaged",cls:r.packaging==="ok"?"":"bad"},{t:r.order==="ok"?"OK":"Wrong",cls:r.order==="ok"?"":"bad"},{t:r.outcome==="rejected"?"Rejected":"Accepted",cls:r.outcome==="rejected"?"bad":"ok"},r.note||"",fullName(r.by)]}),
    empty:"No deliveries recorded in this period."});
  out.push({id:"training",title:"Staff training",intro:"The date each person was trained on each safe method.",
    cols:[{l:"Name",w:110,bold:true},{l:"Role",w:75},{l:"Started",w:65},...topics.map(([,l])=>({l,flex:1,align:"center"}))],
    rows:S.staff.slice().sort((a,b)=>(a.name||"").localeCompare(b.name||"")).map(p=>[p.name,p.role||"",pdfDate(p.start),...topics.map(([k])=>{const t=p.topics&&p.topics[k];return t?{t:pdfDate(t.date),cls:"ok"}:{t:"Not yet",cls:"bad"}})]),
    empty:"No staff training records."});
  out.push({id:"maintenance",title:"Maintenance",intro:"Equipment problems and maintenance jobs: everything still open, and anything reported or finished in the period.",
    cols:[{l:"Reported",w:72},{l:"Job",flex:1.2,bold:true},{l:"Equipment or area",w:95},{l:"Urgency",w:70},{l:"Status",w:110},{l:"What was done",flex:1.2}],
    rows:maintAll.filter(m=>m.status!=="done"||atIn(m.reportedAt)||atIn(m.doneAt)).sort((a,b)=>(b.reportedAt||0)-(a.reportedAt||0)).map(m=>{const pr=mtPri(m.priority);
      return[m.reportedAt?pdfDate(dayOf(m.reportedAt)):"",m.title,m.area||"",{t:pr[1],cls:pr[3]},m.status==="done"?{t:`Done ${m.doneAt?pdfDate(dayOf(m.doneAt)):""}`,cls:"ok"}:{t:"Open"+(m.assignee?` · ${m.assigneeName||fullName(m.assignee)}`:""),cls:pr[0]==="urgent"?"bad":"warn"},m.fixNote||m.details||""]}),
    empty:"No maintenance jobs."});
  out.push({id:"reviews",title:"4-weekly reviews",
    cols:[{l:"Date",w:80},{l:"Signed by",w:100},{l:"Changes reported",flex:1.4},{l:"Actions taken",flex:1.4}],
    rows:R.reviews.slice().sort((a,b)=>b.date.localeCompare(a.date)).map(r=>[pdfDate(r.date),fullName(r.by),REVIEW_QS.filter(([k])=>r.answers&&r.answers[k]&&r.answers[k].a==="Yes"&&k!=="methods").map(([k,q])=>q.replace(/\?$/,"")+(r.answers[k].d?": "+r.answers[k].d:"")).join("\n")||"None",r.notes||""]),
    empty:"No 4-weekly reviews in this period."});
  if(algSectionsOn()){
    for(const[k,t]of ALG_SECTIONS){const list=allergenItems().filter(it=>algKind(it)===k),sm=algSummary(list);
      out.push({id:"allergens-"+k,title:`Allergen matrix: ${t}`,intro:(k==="food"?algFoodNote()+" ":"")+`In every item: ${sm.inAll.join(", ")||"none"}. Not used: ${sm.inNone.join(", ")||"none"}.`,
        cols:ALG_COLS(),rows:algRows(list),empty:`No ${t.toLowerCase()} listed.`,matrix:true,after:k==="food"?ALG_KEY:""});}
  }else out.push({id:"allergens",title:"Allergen matrix",intro:"The 14 allergens UK law requires you to declare.",cols:ALG_COLS(),rows:algRows(allergenItems()),empty:"No menu items listed.",matrix:true,after:ALG_KEY});
  out.push({id:"suppliers",title:"Suppliers",
    cols:[{l:"Supplier",flex:1,bold:true},{l:"Supplies",flex:1.2},{l:"Contact",w:90},{l:"Phone",w:85},{l:"Hygiene rating",w:80},{l:"Notes",flex:1.2}],
    rows:S.suppliers.slice().sort((a,b)=>(a.name||"").localeCompare(b.name||"")).map(x=>[x.name,x.supplies||"",x.contact||"",x.phone||"",x.rating||"",x.notes||""]),empty:"No suppliers listed."});
  if(insp)out.push({id:"inspection",title:"Last EHO inspection",
    facts:[["Date",pdfDate(insp.inspectionDate)],["Inspector",[insp.inspector,insp.authority].filter(Boolean).join(", ")],["Visit",insp.visitType],["Rating",insp.rating!=null?String(insp.rating):""],
      ["Scores",insp.scores?[["Food handling",insp.scores.hygiene],["Cleanliness & structure",insp.scores.structure],["Management",insp.scores.management]].filter(x=>x[1]!==""&&x[1]!=null).map(x=>x.join(" ")).join(" · "):""],
      ["Revisit",pdfDate(insp.revisitDate)],["Summary",insp.summary]],
    cols:[{l:"Issue",flex:1.4},{l:"Area",w:80},{l:"Action required",flex:1.4},{l:"Deadline",w:72},{l:"Status",w:120}],
    rows:(insp.issues||[]).map(i=>[i.issue,i.area||"",i.action||"",pdfDate(i.deadline),i.done?{t:`Done${i.doneAt?" "+pdfDate(dayOf(i.doneAt)):""}${i.fixNote?": "+i.fixNote:""}`,cls:"ok"}:{t:"Open",cls:"bad"}]),empty:"No issues recorded."});
  for(const d of S.plans.slice().sort((a,b)=>(a.type||"").localeCompare(b.type||"")||(a.title||"").localeCompare(b.title||""))){
    const k=d.type,cols=PL_COLS[k];if(!cols)continue;
    out.push({id:"plan-"+d.id,title:d.title||PL_NAME[k],plan:true,intro:PL_NAME[k],riskKey:k==="risk",
      facts:PL_META[k].map(([f,l,t])=>[l,t==="date"?pdfDate(d[f]):d[f]]).concat([["Notes",d.notes]]),
      cols:cols.map(([f,l,t])=>({l,flex:t==="w-l"?1.6:t==="w-m"?1.2:t==="w-s"?0.9:0.55,align:t==="chk"||t==="num"||t==="rate"?"center":undefined})),
      rows:(d[rowsKey(k)]||[]).map(r=>cols.map(([f,,t])=>t==="chk"?(r[f]?{t:"Yes",b:true}:""):t==="rate"?(()=>{const x=riskOf(r);return{t:x.text,cls:x.cls}})():t==="date"?pdfDate(r[f]):(r[f]==null||r[f]===0?"":String(r[f])))),
      empty:"No rows."});
  }
  return out;
}
const inCls=c=>c&&typeof c==="object"?c:{t:c==null?"":String(c)};
function renderInspect(){
  const box=$("#inReport");if(!box||S.tab!=="inspect")return;
  for(const b of document.querySelectorAll("#inChips button")){const on=b.dataset.r===IN.range;b.classList.toggle("on",on);b.setAttribute("aria-checked",String(on))}
  $("#inCustom").hidden=IN.range!=="custom";
  const p=inPeriod();
  $("#inSub").textContent=p?`${pdfDate(p.from)} to ${pdfDate(p.to)} · ${curSite().name}`:"Choose a start and end date.";
  if(!p||!S.db){box.replaceChildren();$("#inJump").replaceChildren();$("#inPdf").disabled=true;return}
  loadInspect(S.site,p);
  const R=IN.data&&IN.key===`${S.site}|${p.from}|${p.to}`?IN.data:null;
  $("#inPdf").disabled=!R;
  $("#inMsg").textContent=IN.err?IN.err:R?"":"Gathering the records…";
  if(!R){box.replaceChildren(el("div",{class:"empty glass",text:IN.err?"Couldn't gather the records. Check the connection and try again.":"Gathering the records…"}));$("#inJump").replaceChildren();return}
  const secs=inspectSections(R);
  $("#inJump").replaceChildren(...secs.filter(x=>!x.plan).map(x=>el("button",{type:"button",class:"fchip",onclick:()=>{const n=document.getElementById("in-"+x.id);if(n)n.scrollIntoView({behavior:"smooth",block:"start"})}},x.title)),
    ...(secs.some(x=>x.plan)?[el("button",{type:"button",class:"fchip",onclick:()=>{const n=document.querySelector("[id^='in-plan-']");if(n)n.scrollIntoView({behavior:"smooth",block:"start"})}},"HACCP & risk")]:[]));
  box.replaceChildren(...secs.map(x=>{
    const sec=el("section",{class:"panel inrep",id:"in-"+x.id});
    sec.append(el("h2",{text:x.title}));
    if(x.intro)sec.append(el("p",{class:"note",text:x.intro}));
    if(x.stats)sec.append(el("div",{class:"instats"},...x.stats.map(([n,l,c])=>el("div",{class:"stat glass"},el("b",{class:c||"",text:n}),el("span",{text:l})))));
    if(x.facts)sec.append(xfacts(x.facts.filter(f=>f[1]))); 
    if(x.cols){
      if(!x.rows.length){if(x.empty)sec.append(el("p",{class:"by",text:x.empty}))}
      else{
        const head=el("tr",{},...x.cols.map(c=>el("th",{class:(c.rotate?"al ":"")+(c.align==="center"?"c":""),text:c.l})));
        const tb=el("tbody",{},...x.rows.map(r=>el("tr",{},...r.map((c,i)=>{c=inCls(c);
          return el("td",{class:[x.cols[i].align==="center"?"c":"",c.cls?"is-"+c.cls:"",c.b||x.cols[i].bold?"b":""].filter(Boolean).join(" ")},c.tick?el("span",{class:"y",title:x.cols[i].l,text:"●"}):c.t)}))));
        sec.append(el("div",{class:"scroll"},el("table",{class:"rep"+(x.matrix?" matrix":"")},el("thead",{},head),tb)));
      }
    }
    if(x.riskKey)sec.append(riskKeyEl());
    if(x.after)sec.append(el("p",{class:"note",text:x.after}));
    return sec;
  }));
}
function inspectPdf(){
  const p=inPeriod(),R=IN.data;if(!p||!R)return;
  const P=window.DiaryPDF,site=curSite(),secs=inspectSections(R);
  const doc=P.create({landscape:true,title:`EHO inspection records - Strangers Coffee ${site.name}`,author:S.myName});
  const f=new P.Flow(doc,{footer:`Strangers Coffee ${site.name} · EHO inspection records ${pdfDate(R.from)} to ${pdfDate(R.to)} · made ${longNow()}`,
    header:pdfHeader("Food safety records",[`Strangers Coffee ${site.name} · ${siteAddr(S.site,S.settings)}`,`Period: ${pdfDate(R.from)} to ${pdfDate(R.to)} · Safer Food, Better Business diary and records`])});
  // Contents
  f.heading("Contents",{size:13}).para(secs.map((x,i)=>`${i+1}. ${x.title}${x.plan?` (${x.intro})`:""}`).join("\n"),{size:9});
  f.gap(6);
  secs.forEach((x,i)=>{
    if(x.plan||x.id==="allergens"||x.id==="allergens-drink"||x.id==="allergens-food")f.startPage(false);
    f.heading(`${i+1}. ${x.title}`,{size:13});
    if(x.intro)f.para(x.intro,{size:8.5,color:"#555555"}).gap(4);
    if(x.stats)f.facts(x.stats.map(([n,l])=>[n,l]),{labelW:70,size:10});
    if(x.facts){if(x.stats)f.gap(6);f.facts(x.facts.filter(r=>r[1]),{size:9})}
    if(x.cols){if(x.facts||x.stats)f.gap(6);
      if(x.rows.length)pdfTable(f,x.cols,x.rows,x.matrix?{rotateHead:true,headH:96,size:8}:{size:7.8,head:7.5});
      else if(x.empty)f.para(x.empty,{size:9,color:"#555555"});
    }
    if(x.riskKey)riskKeyPdf(f.gap(8));
    if(x.after)f.gap(6).para(x.after,{size:8,color:"#555555"});
    f.gap(14);
  });
  P.save(f.finish(),`EHO inspection records - Strangers ${site.name} - ${R.from} to ${R.to}.pdf`);
}
