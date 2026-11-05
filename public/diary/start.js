// Tabs, site switching and subscriptions, events, and start-up. Loaded last.

/* ---------- tabs ---------- */
const TABS=["day","week","history","inspect","extras","cleaning","prove","allergens","templog","deliveries","maintenance","eho","plans","suppliers","contacts","staff","onboarding","review","setup","records","more"];
function show(tab,opts){
  if(!TABS.includes(tab))tab="day";
  if(!canTab(tab)){if(S.role==="staff"&&MANAGER_TABS.has(tab)&&!(opts&&opts.quiet))toast("That section is for managers.");tab="day"}
  const changed=S.tab!==tab;
  S.tab=tab;
  document.querySelectorAll("[data-panel]").forEach(p=>p.hidden=p.dataset.panel!==tab);
  if(changed)for(const n of[document.querySelector(`[data-panel="${tab}"]`),$("#pagehead")])if(n){n.classList.remove("enter");void n.offsetWidth;n.classList.add("enter")}
  $("#dayCtl").hidden=tab!=="day";$("#weekCtl").hidden=tab!=="week";updFab();
  renderHead();renderNav();renderAddBtn();
  if(tab==="inspect")renderInspect();
  if(tab==="templog")renderTempLog();
  if(tab==="maintenance"||tab==="staff")loadTeam();
  if(changed&&!(opts&&opts.keepScroll))window.scrollTo({top:0});
  try{localStorage.setItem("sfbb.tab",tab)}catch(e){}
}
// The large title, its subtitle and (on phones) a back link to Records or More.
function renderHead(){
  const t=S.tab,n=navOf(t);
  const thisWk=S.week===monday(today());
  const title=t==="records"?"Records":t==="more"?"More":t==="day"?(S.date===today()?"Today":S.date===addDays(today(),-1)?"Yesterday":"Diary"):t==="week"?(thisWk?"This week":"Week"):n?n.t:"";
  const sub=t==="day"?parse(S.date).toLocaleDateString("en-GB",{weekday:"long",day:"numeric",month:"long"}):t==="week"?`${nice(S.week)} – ${nice(addDays(S.week,6))}`:curSite().name;
  $("#pageTitle").textContent=title;$("#pageSub").textContent=sub;
  const back=n&&n.grp==="records"?["records","Records"]:n&&(n.grp==="manage"||n.grp==="admin")?["more","More"]:null;
  const bb=$("#backBtn");bb.hidden=!back;
  if(back){bb.replaceChildren(svgi(ICON.chevL),el("span",{text:back[1]}));bb.onclick=()=>show(back[0])}
  document.title="Strangers Coffee - Staff"; // the same tab name on every section
}
function applyTabs(){if(S.tab&&!canTab(S.tab))show("day",{quiet:true});else renderNav()}
window.addEventListener("hashchange",()=>{const h=location.hash.slice(1);if(TABS.includes(h))show(h)});
show((()=>{const h=location.hash.slice(1);if(TABS.includes(h))return h;try{const t=localStorage.getItem("sfbb.tab");return TABS.includes(t)?t:"day"}catch(e){return"day"}})(),{quiet:true});

/* ---------- site switching & subscriptions ---------- */
function switchSite(id){
  if(id===S.site)return;
  if((S.plan&&S.plan.dirty)||(S.insp&&S.insp.dirty)||(S.onb&&S.onb.dirty)||setupDirty){toast("Save or discard your changes before switching site.");return}
  if(S.plan)closePlan();if(S.insp)closeInsp();if(S.onb)closeOnb();
  $("#toast").hidden=true; // an Undo still showing belongs to the site being left
  S.site=id;try{localStorage.setItem("sfbb.site",id)}catch(e){}
  Object.assign(S,{days:{},weeks:{},allergens:[],allergenDocs:[],reviews:[],extras:[],cleaning:[],deliveries:[],maintenance:[],suppliers:[],contacts:[],plans:[],onboarding:[],inspections:[],staff:[],prove:[],rev:{}});
  S.settings=S.sum[id]&&S.sum[id].ready?S.sum[id].settings:normSettings(null);S.cfg=activeCfg(S.settings);
  SE=null;setupDirty=false;pubNote="";$("#setupMsg").textContent="";
  editTask("extras",null);editTask("cleaning",null);editMaint(null);resetDelivery();editSupplier(null);editContact(null);editStaff(null);editAlg(null);
  IN.key="";IN.data=null;IN.loading=null;
  for(const x of["#problems","#wkNotes","#revNotes"])$(x).value="";
  editStaff(null);
  for(const x of["#pMsg","#algConfirm","#tMsg","#revMsg","#pubMsg","#inMsg"])$(x).textContent="";
  fillProve();applyTabs();renderAll();
  if(S.db)subscribeSite();
  S.rota=null;loadRota();
  window.scrollTo({top:0});
}
function subscribeSite(){
  for(const u of S.subs)try{u()}catch(e){}
  S.subs=[];
  const site=S.site,mine=()=>site===S.site;
  const err=e=>{if(e&&e.code==="revoked"){S.canWrite=false;renderAll()}};
  const sub=(q,fn)=>S.subs.push(q.onSnapshot(x=>{if(mine())fn(x)},err));
  const hub=()=>{if(S.tab==="records"||S.tab==="more")renderNav()};
  const list=(col,key,after,q)=>sub(q||C(col,site),x=>{S[key]=x.docs.map(d=>({id:d.id,...d.data()}));after();hub()});
  // A change to what inspection mode reports on (from this device or another) refreshes it if it's open.
  const inspStale=()=>{IN.stale=true;if(S.tab==="inspect")renderInspect()};
  sub(D("settings","main",site),x=>{S.settings=normSettings(x.exists?x.data():null);S.cfg=activeCfg(S.settings);fillProve();applyTabs();renderAll()});
  sub(C("days",site).orderBy("date","desc").limit(400),q=>{const m={};for(const d of q.docs)m[d.id]=d.data();S.days=m;renderDay();renderHistory();renderReview();renderTempLog();renderClosures();inspStale()});
  sub(C("weeks",site).orderBy("week","desc").limit(120),q=>{const m={};for(const d of q.docs)m[d.id]=d.data();S.weeks=m;renderWeek();inspStale()});
  list("allergens","allergens",renderAllergens);
  list("allergenDocs","allergenDocs",renderAllergenDocs);
  S.reviewsLoading=true;
  list("reviews","reviews",()=>{S.reviewsLoading=false;renderReview();renderDay();inspStale()},C("reviews",site).orderBy("date","desc").limit(50));
  list("extras","extras",()=>{renderTasks("extras");renderReview()});
  list("cleaning","cleaning",()=>{renderTasks("cleaning");renderReview()});
  list("suppliers","suppliers",()=>{renderSuppliers();renderDeliveries()});
  list("deliveries","deliveries",()=>{renderDeliveries();inspStale()},C("deliveries",site).orderBy("at","desc").limit(400));
  list("maintenance","maintenance",renderMaint);
  list("contacts","contacts",renderContacts);
  list("plans","plans",()=>{onPlansSnapshot();renderReview()});
  list("onboarding","onboarding",onOnbSnapshot);
  list("inspections","inspections",()=>{onInspSnapshot();renderReview()});
  list("staff","staff",()=>{renderStaff();renderReview()});
  list("proveit","prove",()=>{renderProve();renderReview();inspStale()},C("proveit",site).orderBy("at","desc").limit(500));
}
function subscribeSummaries(){
  const err=()=>{};
  const upd=()=>{renderSites();renderNav();if(S.tab==="day")renderDay();renderPublish()};
  for(const x of SITES){
    const sm=S.sum[x.id]={settings:normSettings(null),days:{},extras:[],cleaning:[],maintenance:[],got:{}};
    const mark=k=>{sm.got[k]=true;sm.ready=["settings","days","extras","cleaning"].every(n=>sm.got[n]);upd()};
    D("settings","main",x.id).onSnapshot(s=>{sm.settings=normSettings(s.exists?s.data():null);mark("settings")},err);
    C("days",x.id).orderBy("date","desc").limit(60).onSnapshot(q=>{const m={};for(const d of q.docs)m[d.id]=d.data();sm.days=m;mark("days")},err);
    for(const k of["extras","cleaning"])C(k,x.id).onSnapshot(q=>{sm[k]=q.docs.map(d=>({id:d.id,...d.data()}));mark(k)},err);
    // Every site's maintenance jobs, for Maintenance → All sites.
    C("maintenance",x.id).onSnapshot(q=>{sm.maintenance=q.docs.map(d=>({id:d.id,...d.data()}));if(S.tab==="maintenance"&&maintAll)renderMaint();renderNotifs();renderNav();if(S.tab==="day")renderDay()},err);
  }
  S.db.doc("config/shared").onSnapshot(s=>{S.shared=s.exists?s.data():null;if(!setupDirty){SE=setupDraft();buildSetup()}renderPublish()},err);
}

/* ---------- events ---------- */
$("#dayDate").addEventListener("change",e=>{if(e.target.value){S.date=e.target.value;renderDay();renderHead()}});
$("#todayBtn").addEventListener("click",()=>{S.date=today();renderDay();renderHead()});
$("#dayPrev").addEventListener("click",()=>{S.date=addDays(S.date,-1);renderDay();renderHead()});
$("#dayNext").addEventListener("click",()=>{if(S.date<today()){S.date=addDays(S.date,1);renderDay();renderHead()}});
$("#saveProb").addEventListener("click",async()=>{if(await patchDay(S.date,{problems:{text:$("#problems").value.trim(),...stamp()}}))toast("Note saved")});
$("#wkPrev").addEventListener("click",()=>{S.week=addDays(S.week,-7);renderWeek();renderHead()});
$("#wkNext").addEventListener("click",()=>{S.week=addDays(S.week,7);renderWeek();renderHead()});
$("#wkSaveNote").addEventListener("click",async()=>{if(await patchWeek(S.week,{notes:{text:$("#wkNotes").value.trim(),...stamp()}}))toast("Note saved")});
$("#algSave").addEventListener("click",async()=>{
  const name=$("#algName").value.trim();if(!name){$("#algConfirm").textContent="Give the item a name first.";return}
  const contains=[...document.querySelectorAll("#algChecks input:checked")].map(c=>c.value);
  const body={name,source:$("#algSupplier").value.trim(),contains,notes:$("#algNotes").value.trim(),by:S.me,at:Date.now()};
  const old=S.editAlg?S.allergens.find(x=>x.id===S.editAlg):null;
  if(algSectionsOn())body.kind=$("#algKind").dataset.v||"drink";else if(old&&old.kind)body.kind=old.kind;
  const r=await multiSave("allergens",algPick.get(),body,{editId:S.editAlg,old:S.editAlg?S.allergens.find(x=>x.id===S.editAlg):null});
  if(r){$("#algConfirm").textContent="";toast(`Saved ${name}${r.where}.${r.warn}`);editAlg(null)}
});
$("#algCancel").addEventListener("click",()=>editAlg(null));
$("#algSearch").addEventListener("input",renderAllergens);
armDelete($("#algDelete"),"Remove item",async()=>{if(await save(()=>D("allergens",S.editAlg).delete())){editAlg(null);toast("Item removed")}});
$("#revSave").addEventListener("click",async()=>{
  if(ro())return;
  if(REVIEW_QS.some(([k])=>!(S.rev[k]&&S.rev[k].a))){$("#revMsg").textContent="Answer every question before signing.";return}
  const date=today();
  if(await save(()=>D("reviews",date).set({date,answers:S.rev,notes:$("#revNotes").value.trim(),by:S.me,at:Date.now()}))){S.rev={};$("#revNotes").value="";$("#revMsg").textContent="Review signed and saved."}
});
document.querySelectorAll(".note.intro").forEach(n=>{n.setAttribute("title","Tap to read more");n.addEventListener("click",()=>n.classList.toggle("full"))});

/* ---------- boot ---------- */
for(const x of["#dv_chilled","#dv_frozen","#pReading"])minusIn(x);
inspectForm();tempLogForm();closureForm();buildAlgChecks();buildTaskForm("extras");buildTaskForm("cleaning");proveForm();delivForm();maintForm();supForm();conForm();staffForm();editStaff(null);
applyTabs();renderAll();
(async()=>{
  const[db,user,assets]=await Promise.all([window.claude?.use?.("db"),window.claude?.use?.("user"),window.claude?.use?.("assets")]);
  S.db=db||null;S.user=user||null;S.assets=assets||null;
  if(!S.db){$("#offline").hidden=false;S.canWrite=false;renderAll();return}
  if(S.user){
    const me=await S.user.me();S.me=me.id;
    const w=await S.user.can("data.write");if(w===false){S.canWrite=false;$("#readonly").hidden=false}
    S.notifSeen=me.notifSeen||0;
    S.myName=me.name||"";S.role=me.role||"staff";S.quickPin=!!me.quickPin;S.quickSwitch=!!me.quickSwitch;renderMe();
    if(!canTab(S.tab))show("day",{quiet:true});else renderNav();
    loadTeam();
  }
  subscribeSummaries();
  subscribeSite();
  renderAll();
  loadRota();
  window.claude.use("rota").then(r=>r&&r.links()).then(l=>{if(l&&l.rota){S.rotaUrl=l.rota;renderNav()}});
})();
