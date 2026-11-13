// The app's chrome: navigation, sites, the account menu, quick switching, the midnight roll-over, the connection
// label and sheets.

/* ---------- app chrome: sites, sections, account ---------- */

// Every section, in order. grp: where it lives (diary sections are tabs; records and manage are lists on phones).
const NAV=[
  {id:"day",t:"Today",grp:"diary",ic:"today"},{id:"week",t:"This week",grp:"diary",ic:"week"},{id:"history",t:"Last 4 weeks",grp:"manage",ic:"history",sub:"Days complete, gaps and problems"},
  {id:"inspect",t:"EHO inspection mode",grp:"manage",ic:"shield",tile:"green",sub:"Everything the inspector asks for, on screen or as a PDF"},
  {id:"extras",t:"Extra checks",grp:"records",ic:"extras",tile:"teal"},{id:"cleaning",t:"Cleaning",grp:"records",ic:"cleaning",tile:"blue"},
  {id:"prove",t:"Prove it",grp:"records",ic:"prove",tile:"orange"},{id:"allergens",t:"Allergens",grp:"records",ic:"allergens",tile:"red"},
  {id:"templog",t:"Temperature log",grp:"records",ic:"prove",tile:"blue"},
  {id:"review",t:"4-weekly review",grp:"records",ic:"review",tile:"red"},
  {id:"deliveries",t:"Deliveries",grp:"records",ic:"deliveries",tile:"indigo"},{id:"maintenance",t:"Maintenance",grp:"records",ic:"maintenance",tile:"purple"},
  {id:"fire",t:"Fire safety log",grp:"manage",ic:"fire",tile:"red",sub:"Alarm, lighting, extinguisher and drill checks"},{id:"firelog",t:"Fire safety records",grp:"manage",ic:"fire",tile:"red",sub:"Every site's fire checks in one log"},{id:"accidents",t:"Accident book",grp:"manage",ic:"accidents",tile:"orange",sub:"Record injuries and near misses"},
  {id:"eho",t:"Last EHO inspection report",grp:"manage",ic:"eho",tile:"green"},{id:"plans",t:"HACCP & risk",grp:"manage",ic:"plans",tile:"purple"},
  {id:"suppliers",t:"Suppliers",grp:"manage",ic:"suppliers",tile:"orange"},{id:"contacts",t:"Contacts",grp:"manage",ic:"contacts",tile:"green"},
  {id:"staff",t:"Staff training",grp:"records",ic:"staff",tile:"teal"},{id:"onboarding",t:"Onboarding",grp:"manage",ic:"onboarding",tile:"indigo"},
  {id:"setup",t:"Setup",grp:"admin",ic:"setup",tile:"grey",sub:"Checks, fridges, opening days and sections"},
];
const navOf=id=>NAV.find(n=>n.id===id);
// Sections only managers and admins use. The Worker enforces the same rule on saves (src/access.ts).
const MANAGER_TABS=new Set(["setup"]);
// Sections only admins see: Fire safety records (every site's fire checks together).
const ADMIN_TABS=new Set(["firelog"]);
const roleAllows=t=>ADMIN_TABS.has(t)?S.role==="admin"||!S.role:S.role!=="staff"||!MANAGER_TABS.has(t);
const canTab=t=>t==="records"||t==="more"||(tabOn(t)&&roleAllows(t));
function siteState(id){
  const a=siteAttention(id);
  if(!S.db||!a)return{cls:"",text:"…"};
  if(a.unused)return{cls:"",text:"Not in use"};
  return a.count?{cls:"bad",text:`${a.count} to do`}:{cls:"ok",text:"All clear"};
}
// Small status shown beside a section in lists ("1 overdue").
function navBadge(id){
  if(id==="cleaning"||id==="extras"||id==="fire"){const n=S[id].filter(x=>taskState(x).overdue).length;return n?{cls:"bad",text:`${n} overdue`}:null}
  if(id==="review"&&S.db&&!S.reviewsLoading&&reviewPeriod().due<today())return{cls:"bad",text:"Overdue"};
  if(id==="maintenance"){const u=unreadNotifs().length;if(u)return{cls:"bad",text:`${u} new`};const n=S.maintenance.filter(m=>m.status!=="done"&&m.priority==="urgent").length;return n?{cls:"bad",text:`${n} urgent`}:null}
  return null;
}
function renderSites(){
  const st=siteState(S.site);
  document.querySelectorAll("[data-sitebtn]").forEach(b=>{
    b.replaceChildren(el("span",{class:"sdot "+st.cls}),el("span",{class:"sname",text:curSite().name}),svgi(ICON.chevD));
    b.setAttribute("aria-label",`Site: ${curSite().name}. Change site`);
  });
  const box=$("#siteList");box.replaceChildren();
  for(const x of SITES){
    const s=siteState(x.id),sm=S.sum[x.id];
    box.append(el("button",{class:"lrow"+(x.id===S.site?" on":""),type:"button","aria-current":x.id===S.site?"true":null,onclick:()=>{closeSheets();switchSite(x.id)}},
      el("span",{class:"sdot big "+s.cls}),el("span",{class:"t"},el("b",{text:x.name}),el("span",{class:"s",text:siteAddr(x.id,sm&&sm.settings)})),
      S.db?el("span",{class:"pill "+s.cls,text:s.text}):null));
  }
}
// One line of live status for a section in the Records and More lists, so you can see where to go.
function hubSub(id){
  if(!S.db)return "";
  const n=(k,w)=>`${k} ${w}${k===1?"":"s"}`;
  const t=today();
  switch(id){
    case "extras":case "cleaning":case "fire":{
      const xs=S[id].map(x=>({x,st:taskState(x),due:dueDate(x)}));if(!xs.length)return "Nothing listed yet";
      const over=xs.filter(a=>a.st.overdue),todayN=xs.filter(a=>!a.st.overdue&&a.st.cls==="warn"&&FREQ[a.x.freq]>0);
      if(over.length)return `Overdue: ${over.map(a=>a.x.name).slice(0,2).join(", ")}${over.length>2?` and ${over.length-2} more`:""}`;
      if(todayN.length)return `Due today: ${todayN.map(a=>a.x.name).slice(0,2).join(", ")}`;
      const next=xs.filter(a=>a.due).sort((a,b)=>a.due.localeCompare(b.due))[0];
      return next?`All up to date · next ${next.x.name}, ${nice(next.due)}`:`${n(xs.length,id==="cleaning"?"job":"check")}, all up to date`;
    }
    case "firelog":{const xs=SITES.flatMap(x=>(S.sum[x.id]&&S.sum[x.id].fire||[]).map(f=>({f,site:x.id}))).filter(c=>taskState(c.f).overdue);
      return xs.length?`Overdue: ${xs.slice(0,2).map(c=>`${c.f.name} (${siteOf(c.site).name})`).join(", ")}${xs.length>2?` and ${xs.length-2} more`:""}`:"All sites up to date"}
    case "accidents":{const l=[...S.accidents].sort((a,b)=>(b.date||"").localeCompare(a.date||"")||(b.at||0)-(a.at||0))[0];
      return l?`${n(S.accidents.length,"entry").replace("entrys","entries")}${S.role==="admin"?"":" you recorded"} · last ${short(l.date)}`:S.role==="admin"?"Nothing recorded":"Nothing you've recorded";
    }
    case "prove":{const r=[...S.prove].sort((a,b)=>(b.at||0)-(a.at||0))[0];return r?`Last: ${r.food}, ${r.pass?"pass":"fail"} · ${short(r.date)}`:"No checks recorded yet"}
    case "allergens":return S.allergens.length?`${n(S.allergens.length,"menu item")} · allergen matrix PDF`:"No menu items yet";
    case "history":{let c=0,tr=0;for(let i=1;i<=28;i++){const d=addDays(t,-i),st=dayStatus(S.days[d],null,d);if(closure(S.days[d])||isClosed(d)&&!st.any)continue;tr++;if(st.complete)c++}return `${c} of ${tr} days complete`}
    case "eho":{const l=inspSorted()[0];if(!l)return "No inspection recorded";const o=(l.issues||[]).filter(i=>!i.done).length;return `Rating ${l.rating??"–"} · ${o?n(o,"issue")+" open":"no open issues"}`}
    case "plans":{const due=S.plans.filter(d=>reviewState(d).overdue).length;return S.plans.length?`${n(S.plans.length,"document")}${due?` · ${due} due for review`:""}`:mro()?"None yet":"None yet: start from a template"}
    case "templog":{const d=S.days[t],us=S.settings.units;if(!us.length)return "No fridges or freezers set up";
      const rs=us.map(u=>{const r=d&&d.temps&&d.temps[u.id]&&d.temps[u.id].am;return r&&r.v!=null?`${u.name}: ${r.v}°`:null}).filter(Boolean);
      return rs.length?`Today: ${rs.join(" · ")}`:"No readings yet today"}
    case "deliveries":{const td=S.deliveries.filter(d=>d.date===t),rj=td.filter(d=>d.outcome==="rejected").length,l=[...S.deliveries].sort((a,b)=>(b.at||0)-(a.at||0))[0];
      return td.length?`Today: ${n(td.length,"delivery").replace("deliverys","deliveries")}${rj?` · ${rj} rejected`:""}`:l?`Last: ${l.supplier}, ${short(l.date)}`:"No deliveries recorded yet"}
    case "maintenance":{const o=S.maintenance.filter(m=>m.status!=="done"),u=o.filter(m=>m.priority==="urgent").length,mine=o.filter(m=>m.assignee===S.me).length;return o.length?`${n(o.length,"open job")}${u?` · ${u} urgent`:""}${mine?` · ${mine} assigned to you`:""}`:"Nothing reported"}
    case "suppliers":return S.suppliers.length?n(S.suppliers.length,"supplier"):"None listed yet";
    case "contacts":{const e=S.contacts.filter(c=>c.outOfHours).length;return S.contacts.length?`${n(S.contacts.length,"contact")}${e?` · ${e} out of hours`:""}`:"None listed yet"}
    case "staff":{const g=S.staff.filter(p=>siteTopics().some(([k])=>!(p.topics&&p.topics[k]))).length;return S.staff.length?(g?`${g} of ${S.staff.length} with training to do`:"Everyone trained"):"No one listed yet"}
    case "onboarding":return S.onboarding.length?n(S.onboarding.length,"document"):mro()?"None yet":"None yet: start from a template";
    case "review":{const{due}=reviewPeriod(),left=Math.round((parse(due)-parse(t))/864e5);return left<0?`Overdue since ${nice(due)}`:left===0?"Due today":`Next due ${nice(due)}`}
    case "setup":return "Checks, fridges, opening days and sections";
  }
  return "";
}
function navRow(n,onclick){
  const b=navBadge(n.id),sub=hubSub(n.id)||n.sub;
  return el("button",{class:"lrow",type:"button",onclick},el("span",{class:"tile "+(n.tile||"blue")},svgi(ICON[n.ic])),
    el("span",{class:"t"},el("b",{text:n.t}),sub?el("span",{class:"s",text:sub}):null),b?el("span",{class:"pill "+b.cls,text:b.text}):null,el("span",{class:"chev"},svgi(ICON.chevR)));
}
function renderNav(){
  // Until we know who is signed in, list only what every role can open.
  const vis=NAV.filter(n=>canTab(n.id)&&(S.role||!MANAGER_TABS.has(n.id)&&!ADMIN_TABS.has(n.id)));
  // sidebar
  const sn=$("#snav");sn.replaceChildren();
  const groups=[["diary",""],["records","Records"],["manage","Management"],["admin","Admin"]];
  for(const[g,label]of groups){
    const items=vis.filter(n=>n.grp===g||(g==="diary"&&(n.id==="history"||n.id==="inspect")));
    if(g==="manage")items.splice(0,items.length,...vis.filter(n=>n.grp==="manage"&&n.id!=="history"&&n.id!=="inspect"));
    if(!items.length)continue;
    if(label)sn.append(el("div",{class:"h",text:label}));
    for(const n of items){const b=navBadge(n.id);
      sn.append(el("a",{href:"#"+n.id,class:S.tab===n.id?"on":"","aria-current":S.tab===n.id?"page":null,onclick:e=>{e.preventDefault();show(n.id)}},svgi(ICON[n.ic]),el("span",{text:n.t}),b?el("span",{class:"n pill "+b.cls,text:b.text.split(" ")[0]}):null));}
  }
  // The rota is its own app on its own address; it opens in the same tab.
  // Report sickness opens the rota's self-certified sickness form (public/rota/sickness.js) for the person signed in.
  const sickUrl=String(S.rotaUrl||"/rota/").replace(/#.*$/,"")+"#sick";
  sn.append(el("div",{class:"h",text:"Rota"}),el("a",{href:S.rotaUrl},svgi(ICON.staff),el("span",{text:"Rota"})),el("a",{href:sickUrl},svgi(ICON.sick),el("span",{text:"Report sickness"})));
  if(S.staffOrders)sn.append(el("div",{class:"h",text:"Wholesale"}),el("a",{href:"/orders"},svgi(ICON.records),el("span",{text:"Wholesale orders"})));
  const fade=()=>sn.classList.toggle("more",sn.scrollHeight-sn.scrollTop-sn.clientHeight>4);
  sn.onscroll=fade;requestAnimationFrame(fade);
  // tab bar
  const grpOf=t=>t==="records"||(navOf(t)||{}).grp==="records"?"records":t==="more"||(navOf(t)||{}).grp==="manage"||(navOf(t)||{}).grp==="admin"?"more":t;
  const cur=grpOf(S.tab);
  const recCount=vis.filter(n=>n.grp==="records").reduce((k,n)=>k+(navBadge(n.id)?1:0),0);
  const tb=$("#tabbar");tb.replaceChildren();
  for(const[t,label,ic]of[["day","Today","today"],["week","Week","week"],["records","Records","records"],["more","More","more"]]){
    if(!canTab(t))continue;
    tb.append(el("button",{type:"button",class:"tab"+(cur===t?" on":""),"aria-current":cur===t?"page":null,onclick:()=>show(t)},svgi(ICON[ic]),el("span",{text:label}),t==="records"&&recCount?el("span",{class:"n",text:String(recCount)}):null));
  }
  // Records and More pages
  const rh=$("#recordsHub");rh.replaceChildren(...vis.filter(n=>n.grp==="records").map(n=>navRow(n,()=>show(n.id))));
  const mh=$("#moreHub");mh.replaceChildren();
  const mg=vis.filter(n=>n.grp==="manage");
  if(mg.length){const hist=mg.filter(n=>n.id==="history"||n.id==="inspect"),rest=mg.filter(n=>n.id!=="history"&&n.id!=="inspect");
    if(hist.length)mh.append(el("div",{class:"list glass"},...hist.map(n=>navRow(n,()=>show(n.id)))));
    if(rest.length)mh.append(el("div",{class:"label",text:"Management"}),el("div",{class:"list glass"},...rest.map(n=>navRow(n,()=>show(n.id)))));}
  const ad=vis.filter(n=>n.grp==="admin");
  if(ad.length)mh.append(el("div",{class:"label",text:"Admin"}),el("div",{class:"list glass"},...ad.map(n=>navRow(n,()=>show(n.id)))));
  mh.append(el("div",{class:"label",text:"Rota"}),el("div",{class:"list glass"},el("a",{class:"lrow",href:S.rotaUrl},el("span",{class:"tile teal"},svgi(ICON.staff)),
    el("span",{class:"t"},el("b",{text:"Rota"}),el("span",{class:"s",text:"Your shifts, open shifts, cover and time off"})),el("span",{class:"chev"},svgi(ICON.chevR))),
    el("a",{class:"lrow",href:sickUrl},el("span",{class:"tile red"},svgi(ICON.sick)),
    el("span",{class:"t"},el("b",{text:"Report sickness"}),el("span",{class:"s",text:"Off sick or went home early"})),el("span",{class:"chev"},svgi(ICON.chevR)))));
  if(S.staffOrders)mh.append(el("div",{class:"label",text:"Wholesale"}),el("div",{class:"list glass"},el("a",{class:"lrow",href:"/orders"},el("span",{class:"tile blue"},svgi(ICON.records)),el("span",{class:"t"},el("b",{text:"Wholesale orders"}),el("span",{class:"s",text:"Orders, preparation and account warnings"})),el("span",{class:"chev"},svgi(ICON.chevR)))));
  mh.append(el("div",{class:"label",text:"Account"}),el("div",{class:"list glass"},...accountItems().map(([t,ic,tile,fn,danger])=>
    el("button",{class:"lrow"+(danger?" danger":""),type:"button",onclick:fn},el("span",{class:"tile "+tile},svgi(ICON[ic])),el("span",{class:"t"},el("b",{text:t}),danger&&S.myName?el("span",{class:"s",text:"Signed in as "+S.myName}):null)))));
}
function accountItems(){
  return[...(S.quickSwitch?[["Switch person","staff","teal",openPeopleSheet]]:[]),
    ...(S.role&&S.role!=="admin"?[[S.quickPin?"Change quick PIN":"Set a quick PIN","key","indigo",setQuickPin]]:[]),
    ["Change password","key","grey",()=>{location.href="/signin#change"}],
    ...(S.role==="admin"?[["Admin","shield","blue",()=>{location.href="/admin"}]]:[]),
    ["Sign out","out","red",signOut,true]];
}

/* ---------- quick switching (shared devices) ----------
 * On a device someone has signed in on with a password, staff and managers switch to themselves with a
 * 4-digit quick PIN (pinpad.js) instead of signing out and in. */
async function authPost(route,body){
  let r;try{r=await fetch("/api/auth/"+route,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)})}
  catch(e){return{ok:false,message:"Couldn't reach the diary. Check your connection."}}
  const j=await r.json().catch(()=>({}));return r.ok?{ok:true,...j}:{ok:false,message:j.message||"Something went wrong."};
}
function setQuickPin(){
  PinPad.open({title:"Choose a quick PIN",sub:"4 digits, to switch to yourself on shared devices",onPin:async first=>{
    setTimeout(()=>PinPad.open({title:"Enter it again",sub:"To check it",onPin:async again=>{
      if(again!==first)return "Those didn't match. Start again by choosing a PIN.";
      const r=await authPost("pin",{pin:first});if(!r.ok)return r.message;
      S.quickPin=true;renderNav();toast("Quick PIN set. Use Switch person on a shared device.");return null;
    }}),250);
    return null;
  }});
}
async function openPeopleSheet(){
  const box=$("#peopleList");box.replaceChildren(SC.skeleton({label:"Loading people…"}));
  $("#sheetVeil").hidden=false;$("#peopleSheet").hidden=false;
  let people=[];try{people=(await (await fetch("/api/auth/people")).json()).people||[]}catch(e){}
  box.replaceChildren(...people.map(p=>el("button",{class:"lrow"+(p.name===S.myName?" on":""),type:"button","aria-current":p.name===S.myName?"true":null,onclick:()=>{
      if(p.name===S.myName){closeSheets();return}
      closeSheets();
      PinPad.open({title:`Hi ${firstName(p.name)}`,sub:"Enter your quick PIN",onPin:async pin=>{
        const r=await authPost("switch",{id:p.id,pin});if(!r.ok)return r.message;
        location.reload();return null;
      }});
    }},el("span",{class:"avatar sm",text:initials(p.name)}),el("span",{class:"t"},el("b",{text:p.name}),p.name===S.myName?el("span",{class:"s",text:"Recording now"}):null))));
  if(!people.length)box.replaceChildren(el("div",{class:"empty",text:"No one has a quick PIN yet. Each person sets one from this menu."}));
  $("#peopleNote").replaceChildren("Not listed? ",el("a",{href:"#",onclick:e=>{e.preventDefault();signOut()}},"Sign in with your password"),".");
}

/* ---------- midnight: a kitchen iPad left open overnight moves on to the new day ---------- */
// The date the page started on (core.js): if the server's clock (learned since) says otherwise, rollDay moves it.
S.lastToday=S.date;
function rollDay(){
  const t=today();if(t===S.lastToday)return;
  const was=S.lastToday;S.lastToday=t;
  // Only if it was showing today (or this week): someone looking back at an earlier day stays there.
  if(S.date===was)S.date=t;
  if(S.week===monday(was))S.week=monday(t);
  if(S.db){subscribeSummaries();renderAll()}
}
setInterval(rollDay,60000);
// The first reading of the server's clock on a device that was out (public/shared/core.js): the date may have moved.
addEventListener("sc-clock",()=>{rollDay();if(S.db)renderAll()});
rollDay();
document.addEventListener("visibilitychange",()=>{if(!document.hidden)rollDay()});
// Safari brings a tab back from memory without always saying it became visible.
addEventListener("pageshow",rollDay);addEventListener("focus",rollDay);

/* ---------- connection: changes made offline wait on this device (claude-shim.js) ---------- */
window.addEventListener("diary:connection",e=>{
  const{offline,pending}=e.detail,c=$("#conn");
  const was=!c.hidden;
  c.hidden=!offline&&!pending;
  c.textContent=offline?`Offline${pending?` · ${pending} change${pending===1?"":"s"} waiting`:""}`:`Saving ${pending} change${pending===1?"":"s"}…`;
  c.title=offline?"No connection. Changes are kept on this device and save when it's back.":"";
  if(was&&c.hidden&&!S.droppedSince)toast("Back online. All changes saved.");
  if(c.hidden)S.droppedSince=0;
});
window.addEventListener("diary:dropped",e=>{S.droppedSince=(S.droppedSince||0)+1;toast("A change couldn't be saved: "+(e.detail.message||"refused by the diary"))});
function renderMe(){
  $("#avatarBtn").textContent=initials(S.myName);
  $("#meBox").replaceChildren(el("span",{class:"avatar sm",text:initials(S.myName)}),
    el("span",{class:"t"},el("b",{text:S.myName||"Signed in"}),el("span",{class:"s",text:{admin:"Admin",manager:"Manager",staff:"Staff"}[S.role]||""})),svgi(ICON.chevR));
}
/* sheets and the account menu */
function closeSheets(){$("#sheetVeil").hidden=true;$("#siteSheet").hidden=true;$("#peopleSheet").hidden=true;$("#notifSheet").hidden=true;$("#acctMenu").hidden=true}
$("#bellBtn").addEventListener("click",openNotifs);$("#sideBell").addEventListener("click",openNotifs);
function openSiteSheet(){renderSites();$("#sheetVeil").hidden=false;$("#siteSheet").hidden=false;const on=$("#siteList .on")||$("#siteList button");if(on)on.focus()}
function openAcctMenu(anchor){
  const m=$("#acctMenu");
  m.replaceChildren(el("div",{class:"who"},el("b",{text:S.myName||""}),el("span",{class:"s",text:{admin:"Admin",manager:"Manager",staff:"Staff"}[S.role]||""})),
    ...accountItems().map(([t,ic,,fn,danger])=>el("button",{class:"m"+(danger?" danger":""),type:"button",role:"menuitem",onclick:()=>{closeSheets();fn()}},svgi(ICON[ic]),el("span",{text:t}))));
  const r=anchor.getBoundingClientRect();
  m.style.top=(r.bottom+8)+"px";m.style.left=Math.max(12,Math.min(r.left,innerWidth-272))+"px";
  if(anchor.id==="meBox"){m.style.top="";m.style.bottom=(innerHeight-r.top+8)+"px"}else m.style.bottom="";
  $("#sheetVeil").hidden=false;m.hidden=false;m.querySelector("button").focus();
}
document.querySelectorAll("[data-sitebtn]").forEach(b=>b.addEventListener("click",openSiteSheet));
$("#avatarBtn").addEventListener("click",e=>openAcctMenu(e.currentTarget));
$("#meBox").addEventListener("click",e=>openAcctMenu(e.currentTarget));
$("#sheetVeil").addEventListener("click",closeSheets);
document.addEventListener("keydown",e=>{if(e.key==="Escape"&&!$("#sheetVeil").hidden)closeSheets()});
