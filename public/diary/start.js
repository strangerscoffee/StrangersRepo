// Tabs, site switching and subscriptions, events, and start-up. Loaded last.

/* ---------- tabs ---------- */
const TABS=["day","week","history","inspect","extras","cleaning","prove","allergens","templog","deliveries","maintenance","fire","accidents","eho","plans","suppliers","contacts","staff","onboarding","review","setup","records","more"];

// First snapshots, including a legitimate empty result, determine when a section is ready.
// Refreshes keep their current DOM, drafts and scroll. Nothing here caches employee data.
const DIARY_DATA={day:["settings","days","extras","cleaning","fire","reviews"],week:["settings","weeks"],history:["days"],templog:["days"],deliveries:["deliveries"],prove:["prove"],extras:["extras"],cleaning:["cleaning"],allergens:["allergens","allergenDocs"],maintenance:["maintenance"],fire:["fire"],accidents:["accidents"],eho:["inspections"],plans:["plans"],suppliers:["suppliers"],contacts:["contacts"],staff:["staff"],onboarding:["onboarding"],review:["reviews","days"],setup:["settings"]};
let diaryLoading={ready:new Set(),failed:new Set()},diaryLoadingKey="";
function updateDiaryLoading(){
  const required=DIARY_DATA[S.tab]||[],pending=required.some(key=>!diaryLoading.ready.has(key)),failed=required.some(key=>diaryLoading.failed.has(key));
  const panel=document.querySelector(`[data-panel="${S.tab}"]`);if(!panel)return;
  const loadingKey=[S.site,S.tab,pending,failed].join("|");if(loadingKey===diaryLoadingKey)return;diaryLoadingKey=loadingKey;
  const wasPending=panel.classList.contains("sc-awaiting-data");
  for(const p of document.querySelectorAll("[data-panel]")){p.classList.toggle("sc-awaiting-data",p===panel&&pending);p.inert=p===panel&&pending;p.setAttribute("aria-busy",String(p===panel&&pending));}
  let loader=$("#diaryLoading");
  if(pending){
    if(!loader){loader=el("div",{id:"diaryLoading"});panel.before(loader)}
    const key=S.site+S.tab+String(failed);
    if(loader.dataset.key!==key){loader.dataset.key=key;loader.replaceChildren(failed?el("p",{class:"banner",role:"status",text:"Couldn't load this section. Check your connection and reload, or wait to reconnect."}):SC.skeleton({label:"Loading diary records…"}));}
    loader.hidden=false;
  }else if(loader){loader.hidden=true;loader.replaceChildren();}
  $("#pageAction").inert=pending;
  if(wasPending&&!pending)SC.reveal(panel);
}

function show(tab,opts){
  if(!TABS.includes(tab))tab="day";
  if(!canTab(tab)){if(S.role==="staff"&&MANAGER_TABS.has(tab)&&!(opts&&opts.quiet))toast("That section is for managers.");tab="day"}
  const changed=S.tab!==tab;
  S.tab=tab;
  document.querySelectorAll("[data-panel]").forEach(p=>p.hidden=p.dataset.panel!==tab);
  if(changed)for(const n of[document.querySelector(`[data-panel="${tab}"]`),$("#pagehead")])SC.reveal(n);
  $("#dayCtl").hidden=tab!=="day";$("#weekCtl").hidden=tab!=="week";updFab();
  renderHead();renderNav();renderAddBtn();updateDiaryLoading();
  // Today's reminders follow changes made elsewhere (a cleaning job or fire check added or ticked on its own page).
  if(tab==="day"&&changed&&S.db)renderDay();
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
  S.site=id;diaryLoading={ready:new Set(),failed:new Set()};updateDiaryLoading();try{localStorage.setItem("sfbb.site",id)}catch(e){}
  Object.assign(S,{days:{},weeks:{},allergens:[],allergenDocs:[],reviews:[],extras:[],cleaning:[],deliveries:[],maintenance:[],fire:[],accidents:[],suppliers:[],contacts:[],plans:[],onboarding:[],inspections:[],staff:[],prove:[],rev:{}});
  S.settings=S.sum[id]&&S.sum[id].ready?S.sum[id].settings:normSettings(null);S.cfg=activeCfg(S.settings);
  SE=null;setupDirty=false;pubNote="";$("#setupMsg").textContent="";
  editTask("extras",null);editTask("cleaning",null);editTask("fire",null);editAccident(null);editMaint(null);resetDelivery();editSupplier(null);editContact(null);editStaff(null);editAlg(null);
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
  const state=diaryLoading;
  const finished=(key,error)=>{if(!key||!mine()||state!==diaryLoading)return;if(error){if(!state.ready.has(key))state.failed.add(key)}else{state.ready.add(key);state.failed.delete(key)}updateDiaryLoading()};
  const sub=(arr,q,fn,key)=>arr.push(q.onSnapshot(x=>{if(mine()){fn(x);finished(key)}},e=>{if(e&&e.code==="revoked"){S.canWrite=false;renderAll()}finished(key,true)}));
  const hub=()=>{if(S.tab==="records"||S.tab==="more")renderNav()};
  const list=(arr,col,key,after,q)=>sub(arr,q||C(col,site),x=>{S[key]=x.docs.map(d=>({id:d.id,...d.data()}));after();hub()},key);
  return{site,sub,list};
}
function subscribeHistory(){
  // The new lists open before the old ones close, so they start from what's already here (claude-shim.js), and a
  // change made offline meanwhile still shows.
  const old=S.histSubs||[];
  const subs=S.histSubs=[],{site,sub,list}=siteSubs(),n=k=>HIST[k][S.hist?1:0];
  sub(subs,C("days",site).orderBy("date","desc").limit(n("days")),q=>{const m={};for(const d of q.docs)m[d.id]=d.data();S.days=m;renderDay();renderHistory();renderReview();renderTempLog();renderClosures();renderSites();inspStale()},"days");
  sub(subs,C("weeks",site).orderBy("week","desc").limit(n("weeks")),q=>{const m={};for(const d of q.docs)m[d.id]=d.data();S.weeks=m;renderWeek();inspStale()},"weeks");
  list(subs,"deliveries","deliveries",()=>{renderDeliveries();inspStale()},C("deliveries",site).orderBy("at","desc").limit(n("deliveries")));
  list(subs,"proveit","prove",()=>{renderProve();renderReview();inspStale()},C("proveit",site).orderBy("at","desc").limit(n("proveit")));
  for(const u of old)try{u()}catch(e){}
}
function subscribeSite(){
  for(const u of S.subs)try{u()}catch(e){}
  S.subs=[];S.hist=false;
  const{site,sub:sub0,list:list0}=siteSubs(),sub=(q,fn,key)=>sub0(S.subs,q,fn,key),list=(...a)=>list0(S.subs,...a);
  sub(D("settings","main",site),x=>{S.settings=normSettings(x.exists?x.data():null);S.cfg=activeCfg(S.settings);fillProve();applyTabs();renderAll()},"settings");
  subscribeHistory();
  list("allergens","allergens",renderAllergens);
  list("allergenDocs","allergenDocs",renderAllergenDocs);
  S.reviewsLoading=true;
  list("reviews","reviews",()=>{S.reviewsLoading=false;renderReview();renderDay();inspStale()},C("reviews",site).orderBy("date","desc").limit(50));
  // This site's checks, cleaning and jobs are also what Today's reminders, the bell and the site switcher show.
  const atGlance=()=>{renderSites();renderNav();if(S.tab==="day")renderDay()};
  list("extras","extras",()=>{renderTasks("extras");renderReview();atGlance()});
  list("cleaning","cleaning",()=>{renderTasks("cleaning");renderReview();atGlance()});
  list("fire","fire",()=>{renderTasks("fire");atGlance()});
  list("accidents","accidents",renderAccidents);
  list("suppliers","suppliers",()=>{renderSuppliers();renderDeliveries()});
  list("maintenance","maintenance",()=>{renderMaint();renderNotifs();atGlance()});
  list("contacts","contacts",renderContacts);
  list("plans","plans",()=>{onPlansSnapshot();renderReview()});
  list("onboarding","onboarding",onOnbSnapshot);
  list("inspections","inspections",()=>{onInspSnapshot();renderReview()});
  list("staff","staff",()=>{renderStaff();renderReview();inspStale()});
}
// Every site at a glance (the site switcher, Today's needs-attention, the maintenance bell, Setup's publish preview):
// one live summary of all four (src/summary.ts) rather than each site's lists. This site's own lists, already
// loaded in full, are used for this site (siteAttention, maintNotifs). Asked again at midnight for the new days.
function subscribeSummaries(){
  const upd=()=>{renderSites();renderNav();if(S.tab==="day")renderDay();renderPublish()};
  for(const x of SITES)if(!S.sum[x.id])S.sum[x.id]={settings:normSettings(null),days:{},firstDay:null,extras:[],cleaning:[],fire:[],maintenance:[],ready:false};
  if(S.sumUnsub)try{S.sumUnsub()}catch(e){}
  const t=today();
  S.sumUnsub=S.db.summary(addDays(t,-8),t).onSnapshot(all=>{
    for(const x of SITES){const a=all[x.id]||{};S.sum[x.id]={settings:normSettings(a.settings||null),days:a.days||{},firstDay:a.firstDay||null,extras:a.extras||[],cleaning:a.cleaning||[],fire:a.fire||[],maintenance:a.maintenance||[],ready:true}}
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
// Subscription transport retries offline reads itself; display an error instead of an endless first-load sweep.
window.addEventListener("diary:connection",event=>{
  if(event.detail?.offline){for(const key of new Set(Object.values(DIARY_DATA).flat()))if(!diaryLoading.ready.has(key))diaryLoading.failed.add(key);updateDiaryLoading()}
});
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
// The shared session guard shields first, then clears the old person's private page before reloading.
window.addEventListener("sc:session-invalid",()=>{
  Object.assign(S,{staff:[],contacts:[],onboarding:[],accidents:[],team:[],days:{},weeks:{},reviews:[],plans:[],inspections:[],sum:{},names:{},plan:null,onb:null,insp:null,rota:null,editStaff:null,myUserId:"",myName:"",role:"",me:null,db:null,canWrite:false});
  contactPrivacy={};editCon=null;IN.data=null;IN.loading=null;IN.key="";
  for(const key of Object.keys(BASE))delete BASE[key];
  closeSheets();
  for(const field of document.querySelectorAll("[data-panel] input,[data-panel] textarea,[data-panel] select")){field.value="";if("checked"in field)field.checked=false;field.disabled=true}
  for(const id of ["#tList","#tMatrix","#cList","#cPrivacy","#obList","#obEditView","#inReport","#inJump","#onShift","#peopleList","#acctMenu","#snav","#tabbar","#meBox"])$(id)?.replaceChildren();
  diaryLoading={ready:new Set(),failed:new Set()};diaryLoadingKey="";$("#diaryLoading")?.remove();
  for(const panel of document.querySelectorAll("[data-panel]"))panel.hidden=true;
});
for(const x of["#dv_chilled","#dv_frozen","#pReading"])minusIn(x);
inspectForm();tempLogForm();closureForm();buildAlgChecks();buildTaskForm("extras");buildTaskForm("cleaning");buildTaskForm("fire");accidentForm();proveForm();delivForm();maintForm();supForm();conForm();staffForm();editStaff(null);
applyTabs();renderAll();
(async()=>{
  const[db,user,assets]=await Promise.all([window.claude?.use?.("db"),window.claude?.use?.("user"),window.claude?.use?.("assets")]);
  S.db=db||null;S.user=user||null;S.assets=assets||null;
  if(!S.db){$("#offline").hidden=false;S.canWrite=false;diaryLoading.failed=new Set(Object.values(DIARY_DATA).flat());updateDiaryLoading();renderAll();return}
  if(S.user){
    const me=await S.user.me();S.me=me.id;
    const w=await S.user.can("data.write");if(w===false){S.canWrite=false;$("#readonly").hidden=false}
    S.notifSeen=me.notifSeen||0;
    S.myUserId=me.userId||"";S.myName=me.name||"";S.role=me.role||"staff";S.quickPin=!!me.quickPin;S.quickSwitch=!!me.quickSwitch;S.staffOrders=!!me.staffOrders;renderMe();
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
