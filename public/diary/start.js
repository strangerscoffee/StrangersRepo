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
  if(tab==="deliveries"||tab==="prove")needHistory(); // the full lists
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
// The four lists that grow every day (days, weeks, deliveries, Prove it) load only their latest records when the
// diary opens: enough for Today, This week, Last 4 weeks, the review, closures and the menu's summaries. The rest
// loads the first time a screen needs it (needHistory: an older date or week, a longer temperature log, the full
// Deliveries or Prove it list, an overdue review), and stays loaded for that site.
const HIST={days:[90,400],weeks:[12,120],deliveries:[60,400],proveit:[80,500]};
const RECENT_DAYS=55; // what the short lists are sure to cover, days back from today
function needHistory(from){
  if(S.hist||!S.db||!S.site)return;
  if(from&&from>=addDays(today(),-RECENT_DAYS))return;
  S.hist=true;subscribeHistory();
}
const inspStale=()=>{IN.stale=true;if(S.tab==="inspect")renderInspect()}; // what inspection mode reports on changed
function siteSubs(){
  const site=S.site,mine=()=>site===S.site;
  const err=e=>{if(e&&e.code==="revoked"){S.canWrite=false;renderAll()}};
  const sub=(arr,q,fn)=>arr.push(q.onSnapshot(x=>{if(mine())fn(x)},err));
  const hub=()=>{if(S.tab==="records"||S.tab==="more")renderNav()};
  const list=(arr,col,key,after,q)=>sub(arr,q||C(col,site),x=>{S[key]=x.docs.map(d=>({id:d.id,...d.data()}));after();hub()});
  return{site,sub,list};
}
function subscribeHistory(){
  // The new lists open before the old ones close, so they start from what's already here (claude-shim.js), and a
  // change made offline meanwhile still shows.
  const old=S.histSubs||[];
  const subs=S.histSubs=[],{site,sub,list}=siteSubs(),n=k=>HIST[k][S.hist?1:0];
  sub(subs,C("days",site).orderBy("date","desc").limit(n("days")),q=>{const m={};for(const d of q.docs)m[d.id]=d.data();S.days=m;renderDay();renderHistory();renderReview();renderTempLog();renderClosures();renderSites();inspStale()});
  sub(subs,C("weeks",site).orderBy("week","desc").limit(n("weeks")),q=>{const m={};for(const d of q.docs)m[d.id]=d.data();S.weeks=m;renderWeek();inspStale()});
  list(subs,"deliveries","deliveries",()=>{renderDeliveries();inspStale()},C("deliveries",site).orderBy("at","desc").limit(n("deliveries")));
  list(subs,"proveit","prove",()=>{renderProve();renderReview();inspStale()},C("proveit",site).orderBy("at","desc").limit(n("proveit")));
  for(const u of old)try{u()}catch(e){}
}
function subscribeSite(){
  for(const u of S.subs)try{u()}catch(e){}
  S.subs=[];S.hist=false;
  const{site,sub:sub0,list:list0}=siteSubs(),sub=(q,fn)=>sub0(S.subs,q,fn),list=(...a)=>list0(S.subs,...a);
  sub(D("settings","main",site),x=>{S.settings=normSettings(x.exists?x.data():null);S.cfg=activeCfg(S.settings);fillProve();applyTabs();renderAll()});
  subscribeHistory();
  list("allergens","allergens",renderAllergens);
  list("allergenDocs","allergenDocs",renderAllergenDocs);
  S.reviewsLoading=true;
  list("reviews","reviews",()=>{S.reviewsLoading=false;renderReview();renderDay();inspStale()},C("reviews",site).orderBy("date","desc").limit(50));
  // This site's checks, cleaning and jobs are also what Today's reminders, the bell and the site switcher show.
  const atGlance=()=>{renderSites();renderNav();if(S.tab==="day")renderDay()};
  list("extras","extras",()=>{renderTasks("extras");renderReview();atGlance()});
  list("cleaning","cleaning",()=>{renderTasks("cleaning");renderReview();atGlance()});
  list("suppliers","suppliers",()=>{renderSuppliers();renderDeliveries()});
  list("maintenance","maintenance",()=>{renderMaint();renderNotifs();atGlance()});
  list("contacts","contacts",renderContacts);
  list("plans","plans",()=>{onPlansSnapshot();renderReview()});
  list("onboarding","onboarding",onOnbSnapshot);
  list("inspections","inspections",()=>{onInspSnapshot();renderReview()});
  list("staff","staff",()=>{renderStaff();renderReview()});
}
// Every site at a glance (the site switcher, Today's needs-attention, the maintenance bell, Setup's publish preview):
// one live summary of all four (src/summary.ts) rather than each site's lists. This site's own lists, already
// loaded in full, are used for this site (siteAttention, maintNotifs). Asked again at midnight for the new days.
function subscribeSummaries(){
  const upd=()=>{renderSites();renderNav();if(S.tab==="day")renderDay();renderPublish()};
  for(const x of SITES)if(!S.sum[x.id])S.sum[x.id]={settings:normSettings(null),days:{},firstDay:null,extras:[],cleaning:[],maintenance:[],ready:false};
  if(S.sumUnsub)try{S.sumUnsub()}catch(e){}
  const t=today();
  S.sumUnsub=S.db.summary(addDays(t,-8),t).onSnapshot(all=>{
    for(const x of SITES){const a=all[x.id]||{};S.sum[x.id]={settings:normSettings(a.settings||null),days:a.days||{},firstDay:a.firstDay||null,extras:a.extras||[],cleaning:a.cleaning||[],maintenance:a.maintenance||[],ready:true}}
    if(S.tab==="maintenance"&&maintAll)renderMaint();
    renderNotifs();upd();
  },()=>{});
}
// Maintenance → All sites: every job at the other sites (the summary has only open ones and those done lately).
function subscribeMaintAll(){
  if(S.maintFull)return;
  S.maintFull={};
  for(const x of SITES)C("maintenance",x.id).onSnapshot(q=>{S.maintFull[x.id]=q.docs.map(d=>({id:d.id,...d.data()}));if(S.tab==="maintenance"&&maintAll)renderMaint()},()=>{});
}
function subscribeShared(){
  S.db.doc("config/shared").onSnapshot(s=>{S.shared=s.exists?s.data():null;if(!setupDirty){SE=setupDraft();buildSetup()}renderPublish()},()=>{});
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
  subscribeShared();
  subscribeSite();
  renderAll();
  loadRota();
  window.claude.use("rota").then(r=>r&&r.links()).then(l=>{if(l&&l.rota){S.rotaUrl=l.rota;renderNav()}});
})();
