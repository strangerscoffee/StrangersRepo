// Kitchen Diary page logic. Talks to its data only through window.claude (claude-shim.js).
const ALLERGENS=["Celery","Cereals with gluten","Crustaceans","Eggs","Fish","Lupin","Milk","Molluscs","Mustard","Tree nuts","Peanuts","Sesame","Soya","Sulphites"];
const DEFAULT_SETTINGS={
  units:[{id:"u1",name:"Fridge 1",kind:"fridge"},{id:"u2",name:"Freezer 1",kind:"freezer"}],
  opening:[
    {id:"o1",t:"Fridges, chilled displays and freezers working properly"},
    {id:"o2",t:"Other equipment (coffee machine, ovens, dishwasher) working properly"},
    {id:"o3",t:"Staff fit for work and wearing clean work clothes"},
    {id:"o4",t:"Food preparation areas clean and disinfected"},
    {id:"o5",t:"No evidence of pests"},
    {id:"o6",t:"Handwash basins stocked with soap and paper towels; hot water at all sinks"},
    {id:"o7",t:"Allergen information accurate for everything on sale today"},
    {id:"o8",t:"Probe thermometer working and clean"}],
  closing:[
    {id:"c1",t:"Food past its use-by date thrown away"},
    {id:"c2",t:"Food in fridges covered, labelled and dated"},
    {id:"c3",t:"Food preparation areas cleaned and disinfected"},
    {id:"c4",t:"Equipment and utensils cleaned (including milk jugs and steam wand)"},
    {id:"c5",t:"Waste removed and new bin bags in place"},
    {id:"c6",t:"Dirty cloths and aprons removed for washing"},
    {id:"c7",t:"Floors swept and mopped"},
    {id:"c8",t:"Allergen information updated for tomorrow's items"}],
  weekly:[]
};
const FREQ={"after use":0,"daily":1,"weekly":7,"fortnightly":14,"monthly":30,"quarterly":91,"yearly":365};
const PROVE={
  cook:{label:"Cooking – core temperature",min:75,hint:"Pass at 75°C or hotter in the thickest part."},
  reheat:{label:"Reheating – core temperature",min:75,hint:"Pass at 75°C or hotter, steaming hot all the way through."},
  hold:{label:"Hot holding",min:63,hint:"Pass at 63°C or hotter."},
  chill:{label:"Chilled food or display",max:8,hint:"Pass at 8°C or colder (5°C or colder recommended)."},
  cool:{label:"Cooling – minutes to below 8°C",unit:"min",max:90,hint:"Record the minutes it took to get below 8°C. Pass within 90 minutes."},
  delivChill:{label:"Delivery – chilled",max:8,hint:"Pass at 8°C or colder. Reject anything warmer."},
  delivFrozen:{label:"Delivery – frozen",max:-15,hint:"Pass at −15°C or colder. Reject anything warmer."},
  probeIce:{label:"Probe check – iced water",min:-1,max:1,hint:"Pass between −1°C and 1°C. Replace or recalibrate the probe if outside."},
  probeBoil:{label:"Probe check – boiling water",min:99,max:101,hint:"Pass between 99°C and 101°C. Replace or recalibrate the probe if outside."},
  other:{label:"Other check",manual:true,hint:"Record the reading if there is one, and choose pass or fail."}};
const ALL_TOPICS=[["hygiene","Personal hygiene & handwashing"],["cross","Cross-contamination"],["cleaning","Cleaning"],["chilling","Chilling"],["cooking","Cooking & reheating"],["allergens","Allergens"],["diary","Opening & closing checks"],["l2","Level 2 Food Hygiene certificate"]];
const TOPICS=ALL_TOPICS;
const REVIEW_QS=[
  ["problems","Were there any problems recorded in the diary this period?"],
  ["supplier","Have you started using a new supplier or new types of food?"],
  ["menu","Have you added new menu items, recipes or ways of working?"],
  ["equipment","Have you got new equipment, or has any broken down?"],
  ["staff","Have new staff started, and have they been trained on the safe methods?"],
  ["allergen","Has any allergen information changed?"],
  ["pests","Any signs of pests?"],
  ["methods","Have you updated your safe methods to reflect any changes?"]];
/* Sites. The Roastery's records live at the original top-level paths (they were recorded before sites existed);
   every other site keeps its own copy of each collection under sites/<id>/. */
const SITES=[
  {id:"roastery",name:"Roastery",addr:"10 Dove Street, Norwich, NR2 1DE",legacy:true},
  {id:"cafe",name:"Cafe",addr:"21 Pottergate, Norwich, NR2 1DS"},
  {id:"asg",name:"ASG",addr:"14 All Saints Green, Norwich, NR1 3NA"},
  {id:"factory",name:"Factory",addr:"122 Ber Street, Norwich, NR1 3ES"}];
const siteOf=id=>SITES.find(s=>s.id===id)||SITES[0];
const OPT_TABS=[["week","End of week"],["extras","Extra checks"],["cleaning","Cleaning schedule"],["prove","Prove it"],["allergens","Allergens"],["templog","Temperature log"],["deliveries","Deliveries"],["maintenance","Maintenance"],["eho","Last EHO inspection report"],["plans","HACCP & risk"],["suppliers","Suppliers"],["contacts","Contacts"],["staff","Staff training"],["onboarding","Onboarding"],["review","4-weekly review"]];
const WEEKDAYS=[[1,"Monday"],[2,"Tuesday"],[3,"Wednesday"],[4,"Thursday"],[5,"Friday"],[6,"Saturday"],[0,"Sunday"]];
const LISTS=[["opening","Opening"],["closing","Closing"],["weekly","End-of-week"]];

const $=s=>document.querySelector(s);
const el=(t,a={},...kids)=>{const e=document.createElement(t);for(const[k,v]of Object.entries(a)){if(k==="class")e.className=v;else if(k==="text")e.textContent=v;else if(k.startsWith("on"))e.addEventListener(k.slice(2),v);else if(k==="value")e.value=v;else if(v!==false&&v!=null)e.setAttribute(k,v===true?"":v)}for(const k of kids)if(k!=null)e.append(k);return e};
const pad=n=>String(n).padStart(2,"0");
const iso=d=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const parse=s=>{const[y,m,d]=s.split("-").map(Number);return new Date(y,m-1,d)};
const addDays=(s,n)=>{const d=parse(s);d.setDate(d.getDate()+n);return iso(d)};
const today=()=>iso(new Date());
const monday=s=>addDays(s,-((parse(s).getDay()+6)%7));
const nice=s=>s?parse(s).toLocaleDateString("en-GB",{weekday:"short",day:"numeric",month:"short"}):"";
const short=s=>s?parse(s).toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"2-digit"}):"";
const time=ts=>ts?new Date(ts).toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"}):"";
const when=ts=>ts?new Date(ts).toLocaleDateString("en-GB",{day:"numeric",month:"short"})+" "+time(ts):"";
// A task's "last done" date entered by hand has no real time of day, so it shows as a date only.
const lastWhen=(ts,set)=>!ts?"":set?new Date(ts).toLocaleDateString("en-GB",{day:"numeric",month:"short",year:new Date(ts).getFullYear()===new Date().getFullYear()?undefined:"numeric"}):when(ts);
// A short message above the tab bar. With an action (e.g. ["Undo", fn]) it stays longer and shows a button.
function toast(m,action){
  const t=$("#toast");t.hidden=true;void t.offsetWidth;
  t.replaceChildren(el("span",{text:m}),action?el("button",{type:"button",onclick:()=>{t.hidden=true;action[1]()}},action[0]):"");
  t.hidden=false;clearTimeout(toast._t);toast._t=setTimeout(()=>t.hidden=true,action?7000:2400);
}

const S={site:(()=>{try{const s=localStorage.getItem("sfbb.site");return SITES.some(x=>x.id===s)?s:"roastery"}catch(e){return"roastery"}})(),
  cfg:null,sum:{},subs:[],allergenDocs:[],assets:null,shared:null,
  db:null,user:null,me:null,canWrite:true,settings:DEFAULT_SETTINGS,days:{},weeks:{},allergens:[],reviews:[],extras:[],cleaning:[],deliveries:[],maintenance:[],suppliers:[],contacts:[],plans:[],plan:null,onboarding:[],onb:null,inspections:[],insp:null,staff:[],prove:[],
  date:today(),week:monday(today()),editAlg:null,editStaff:null,names:{},rev:{}};
S.role="";S.myName="";
const ro=()=>!S.canWrite||!S.db;
// Everyone can open the management sections (suppliers, contacts, HACCP & risk, the last inspection, training,
// onboarding, the 4-weekly review); only managers and admins can change them, as the Worker enforces.
const MANAGER_DATA=new Set(["eho","plans","suppliers","contacts","staff","onboarding","review"]);
const mro=()=>ro()||S.role==="staff";

/* ---------- sites & per-site paths ---------- */
const path=(name,site)=>{site=site||S.site;return siteOf(site).legacy?name:`sites/${site}/${name}`};
const C=(name,site)=>S.db.collection(path(name,site));
const D=(name,id,site)=>S.db.doc(path(name,site)+"/"+id);
const curSite=()=>siteOf(S.site);
const siteAddr=(id,s)=>((s&&s.info&&s.info.address)||siteOf(id).addr);
function normSettings(raw){
  const s={...DEFAULT_SETTINGS,...(raw||{})};
  s.units=Array.isArray(s.units)?s.units:[];
  for(const[k]of LISTS)s[k]=Array.isArray(s[k])?s[k].filter(c=>c&&c.id&&c.t):[];
  s.closedDays=Array.isArray(s.closedDays)?s.closedDays:[];
  s.hide=s.hide&&typeof s.hide==="object"?s.hide:{};
  s.proveOff=Array.isArray(s.proveOff)?s.proveOff:[];
  s.trainingOff=Array.isArray(s.trainingOff)?s.trainingOff:[];
  s.info=s.info&&typeof s.info==="object"?s.info:{};
  s.fresh=!raw;
  return s;
}
const activeCfg=s=>({...s,opening:s.opening.filter(c=>!c.off),closing:s.closing.filter(c=>!c.off),weekly:s.weekly.filter(c=>!c.off)});
const isClosed=(date,s)=>(s||S.settings).closedDays.includes(parse(date).getDay());
// A day marked closed with a reason (Christmas, maintenance, an unexpected closure): days/<date>.closed. It counts as
// closed whatever was recorded, so it's never shown as incomplete or missed.
const closure=d=>d&&d.closed&&d.closed.reason?d.closed:null;
const CLOSE_REASONS=["Bank holiday","Christmas","Maintenance or repairs","Staff shortage","Power or water off","Private event"];
const tabOn=(t,s)=>!(s||S.settings).hide[t];
S.settings=normSettings(null);S.cfg=activeCfg(S.settings);

/* ---------- rules ---------- */
function tempState(kind,v){
  if(v==null||v==="")return "";
  if(kind==="freezer")return v<=-18?"ok":v<=-15?"warn":"bad";
  return v<=5?"ok":v<=8?"warn":"bad";
}
// A check counts from the day it was added (its "from" date, set when it's saved in Setup or published to a site),
// so adding one never makes earlier days incomplete. Checks without a date have always applied.
const checksOn=(list,date)=>!date?list:list.filter(c=>!c.from||c.from<=date);
function dayStatus(d,cfg,date){
  const s0=cfg||S.cfg;d=d||{};date=date||d.date||"";
  const s={...s0,opening:checksOn(s0.opening,date),closing:checksOn(s0.closing,date)};
  const oi=(d.opening&&d.opening.items)||{},ci=(d.closing&&d.closing.items)||{},tp=d.temps||{};
  const oN=s.opening.filter(c=>oi[c.id]).length,cN=s.closing.filter(c=>ci[c.id]).length;
  let tN=0,issue=false;const tTot=s.units.length;
  for(const u of s.units){const r=tp[u.id]&&tp[u.id].am;if(r&&r.v!=null){tN++;if(tempState(u.kind,r.v)==="bad")issue=true}}
  const part=(n,t)=>t===0?"y":n===0?"":n>=t?"y":"p";
  return{open:part(oN,s.opening.length),temps:issue?"x":part(tN,tTot),close:part(cN,s.closing.length),signed:d.signed?"y":"",issue,
    complete:oN>=s.opening.length&&cN>=s.closing.length&&tN>=tTot&&!!d.signed,any:oN+cN+tN>0||!!d.signed,oN,cN,tN,tTot,oT:s.opening.length,cT:s.closing.length};
}
function taskState(t){
  const days=FREQ[t.freq];
  const base=t.lastAt||t.importedAt;
  if(!base)return days>0?{cls:"bad",text:"Never done",overdue:true}:{cls:"warn",text:"Not done yet",overdue:false};
  if(!days)return t.lastAt?{cls:"ok",text:"Last done "+lastWhen(t.lastAt,t.lastSet),overdue:false}:{cls:"warn",text:"Not done yet",overdue:false};
  const due=new Date(base);due.setHours(0,0,0,0);due.setDate(due.getDate()+days);
  const now=new Date();now.setHours(0,0,0,0);
  const left=Math.round((due-now)/864e5),pre=t.lastAt?"":"Not done yet · ";
  if(left<0)return{cls:"bad",text:`${pre}Overdue by ${-left} day${left===-1?"":"s"}`,overdue:true};
  if(left===0)return{cls:"warn",text:pre+"Due today",overdue:false};
  return{cls:t.lastAt?"ok":"warn",text:`${pre}Due ${due.toLocaleDateString("en-GB",{day:"numeric",month:"short"})}`,overdue:false};
}
function proveResult(m,v,manual){
  const r=PROVE[m];if(!r)return null;
  if(r.manual)return manual==="pass";
  if(v==null||!isFinite(v))return null;
  if(r.min!=null&&v<r.min)return false;
  if(r.max!=null&&v>r.max)return false;
  return true;
}

/* ---------- writes ---------- */
let chain=Promise.resolve();
function patchDoc(col,id,patch,exists,base){
  if(ro())return Promise.resolve();
  const ref=D(col,id);
  chain=chain.then(async()=>{
    try{if(exists)await ref.update(patch);else await ref.set(Object.assign({},base||{},patch))}
    catch(e){if(e&&e.code==="invalid_argument"&&!exists){try{await ref.update(patch)}catch(e2){fail(e2)}}else fail(e)}
  });
  return chain;
}
const patchDay=(date,p)=>patchDoc("days",date,p,!!S.days[date],{date});
const patchWeek=(wk,p)=>patchDoc("weeks",wk,p,!!S.weeks[wk],{week:wk});
async function save(fn){if(ro())return false;try{await fn();return true}catch(e){fail(e);return false}}

/* ---------- saving to several sites ----------
   Extra checks, cleaning, HACCP & risk, suppliers, contacts, onboarding and allergens can be saved to more than
   one site. Every copy carries the same linkId and the list of sites it was sent to (sites). Saving again replaces
   the linked copy at each ticked site (found by linkId, or by name for items saved before linking), or adds one
   where there isn't one. Unticking a site leaves its copy alone; Remove only removes the copy at the current site. */
const MULTI_NAME={extras:"name",cleaning:"name",suppliers:"name",contacts:"name",allergens:"name",allergenDocs:"title",plans:"title",onboarding:"title"};
const newLinkId=()=>"l"+Date.now().toString(36)+Math.random().toString(36).slice(2,8);
// "Save to sites" switches. The current site is always included; All sites ticks every other one too.
const PICKERS=new Set();
// After switching site (or once signed in), lock the new current site on and unlock the others.
function refreshPickers(){for(const pk of PICKERS)if(pk.el.isConnected)pk.lock()}
function sitePicker(id){
  const box=el("div",{class:"toggles"});
  const all=el("input",{type:"checkbox",id:id+"_all"});
  box.append(el("label",{for:all.id},all,el("strong",{text:"All sites"})));
  const cbs=SITES.map(x=>{const cb=el("input",{type:"checkbox",id:id+"_"+x.id,"data-site":x.id});box.append(el("label",{for:cb.id},cb,x.name));return cb});
  const sync=()=>{all.checked=cbs.every(c=>c.checked)};
  const pk={onChange:null,
    el:el("div",{class:"sitepick"},el("div",{class:"label",text:"Save to sites"}),box,
      el("p",{class:"note",text:"Saved at every ticked site, replacing the same item there. Unticking a site doesn't remove it from that site; use Remove on that site's own list."})),
    get:()=>cbs.filter(c=>c.checked||c.dataset.site===S.site).map(c=>c.dataset.site),
    set(list){const on=new Set(Array.isArray(list)?list:[]);for(const c of cbs)c.checked=on.has(c.dataset.site);pk.lock()},
    lock(){const R=ro();for(const c of cbs){if(c.dataset.site===S.site)c.checked=true;c.disabled=R||c.dataset.site===S.site}all.disabled=R;sync()}};
  PICKERS.add(pk);
  all.addEventListener("change",()=>{for(const c of cbs)c.checked=all.checked||c.dataset.site===S.site;sync();pk.onChange&&pk.onChange()});
  for(const c of cbs)c.addEventListener("change",()=>{sync();pk.onChange&&pk.onChange()});
  return pk;
}
// Save an item here and at the other ticked sites. editId: the item being edited at this site (null for new).
// old: the item before editing (for its linkId and name). patch: task lists, where only the item's own fields are
// written (update), so each site keeps its own done-dates and log. match:false never replaces by name (allergen PDFs).
async function multiSave(kind,sites,data,{editId=null,old=null,patch=false,match=true}={}){
  if(ro())return null;
  const here=S.site,linkId=(old&&old.linkId)||data.linkId||newLinkId();
  sites=[...new Set([here,...(sites||[])])];
  const v={...data,linkId,sites},now=Date.now();
  const nm=MULTI_NAME[kind],names=new Set([v[nm],old&&old[nm]].filter(Boolean).map(normT));
  const ok=await save(()=>editId?(patch?D(kind,editId,here).update(v):D(kind,editId,here).set(v)):C(kind,here).add(patch?{...v,createdAt:now}:v));
  if(!ok)return null;
  const done=[siteOf(here).name],fails=[];
  for(const site of sites.filter(x=>x!==here)){
    try{
      const snap=await C(kind,site).get();
      const m=snap.docs.find(d=>(d.data()||{}).linkId===linkId)||(match?snap.docs.find(d=>{const x=d.data()||{};return !x.linkId&&names.has(normT(x[nm]))}):null);
      if(m)await(patch?D(kind,m.id,site).update(v):D(kind,m.id,site).set(v));
      else await C(kind,site).add(patch?{...v,createdAt:now}:v);
      done.push(siteOf(site).name);
    }catch(e){console.error(e);fails.push(siteOf(site).name)}
  }
  return{linkId,done,fails,where:done.length>1?" to "+done.join(", "):"",
    warn:fails.length?` Couldn't save to ${fails.join(", ")}; check the connection and save again.`:""};
}
function fail(e){
  if(e&&e.code==="invalid_argument"){S.canWrite=false;$("#readonly").hidden=false;renderAll();return}
  if(e&&e.code==="quota_exceeded"){toast("The diary is full. Ask the owner to clear old entries.");return}
  toast("Couldn't save. Check your connection and try again.");
}
const stamp=()=>({by:S.me,at:Date.now()});
function armDelete(btn,label,fn){
  btn.addEventListener("click",()=>{
    if(btn.dataset.armed!=="1"){btn.dataset.armed="1";btn.textContent="Tap again to remove";setTimeout(()=>{btn.dataset.armed="";btn.textContent=label},3000);return}
    btn.dataset.armed="";btn.textContent=label;fn();
  });
}

/* ---------- names ---------- */
async function resolveNames(ids){
  ids=[...new Set(ids.filter(Boolean))];
  if(!S.user||!ids.length)return;
  let ps;try{ps=await S.user.profiles(ids)}catch(e){return}
  if(!ps)return; // offline: keep the names already shown
  let changed=false;
  for(const id of ids){const n=(ps[id]&&ps[id].name)||"";if(S.names[id]!==n){S.names[id]=n;changed=true}}
  if(changed)renderAll();
}
const nameOf=id=>id===S.me?"you":(S.names[id]||(String(id||"").startsWith("web:")?String(id).slice(4):"a team member"));

/* ---------- checklist helper ---------- */
function checklist(box,checks,items,prefix,onToggle){
  box.replaceChildren();const ctx=S.site+S.date+S.week;
  for(const c of checks){
    const id=`${prefix}_${c.id}`;
    const cb=el("input",{type:"checkbox",id,disabled:ro()});cb.checked=!!items[c.id];
    if(cb.checked&&box._ctx===ctx&&box._prev[c.id]===false)cb.classList.add("pop"); // just ticked, here or on another device
    cb.addEventListener("change",()=>onToggle(c.id,cb.checked));
    box.append(el("li",{},el("label",{for:id},cb,el("span",{text:c.t}))));
  }
  if(!checks.length)box.append(el("li",{class:"empty",text:"No checks set up. Add them in Setup."}));
  box._prev=Object.fromEntries(checks.map(c=>[c.id,!!items[c.id]]));box._ctx=ctx;
}

/* ---------- list rows and add / edit forms ---------- */
// A list row that opens in place to show more: details, history and actions.
const xOpen={};
function xrow(key,{lead,title,sub,right,details,cls}){
  const open=!!xOpen[key]&&!!details;
  const more=details?el("div",{class:"xmore",hidden:!open},...details):null;
  const main=el("button",{class:"xmain",type:"button","aria-expanded":details?String(open):null,disabled:!details,onclick:()=>{
    xOpen[key]=!xOpen[key];more.hidden=!xOpen[key];more.classList.add("anim");main.setAttribute("aria-expanded",String(xOpen[key]));row.classList.toggle("open",xOpen[key])}},
    lead||null,el("span",{class:"t"},el("b",{text:title}),sub?el("span",{class:"s",text:sub}):null));
  const row=el("div",{class:"xrow"+(open?" open":"")+(cls?" "+cls:"")},el("div",{class:"xhead"},main,...(right||[]).filter(Boolean)),more);
  return row;
}
const xfacts=pairs=>el("dl",{class:"facts"},...pairs.filter(p=>p[1]).flatMap(([k,v])=>[el("dt",{text:k}),el("dd",{},v)]));
const telLink=n=>el("a",{href:"tel:"+String(n).replace(/[^\d+]/g,""),class:"mono"},n);
const callBtn=(n,label)=>n?el("a",{class:"call",href:"tel:"+String(n).replace(/[^\d+]/g,""),"aria-label":label||"Call "+n,title:"Call "+n},svgi(ICON.contacts)):null;

// List sections keep their form closed until someone taps Add (in the page heading) or Edit on an item.
const FORMS={
  extras:{panel:"#xFormPanel",add:"Add check",reset:()=>editTask("extras",null)},
  cleaning:{panel:"#kFormPanel",add:"Add job",reset:()=>editTask("cleaning",null)},
  allergens:{panel:"#algFormPanel",add:"Add item",reset:()=>{algNewKind="drink";editAlg(null)}},
  suppliers:{panel:"#sFormPanel",add:"Add supplier",reset:()=>editSupplier(null)},
  contacts:{panel:"#cFormPanel",add:"Add contact",reset:()=>editContact(null)},
  staff:{panel:"#tFormPanel",add:"Add person",reset:()=>editStaff(null)},
  maintenance:{panel:"#mFormPanel",add:"Report a job",reset:()=>editMaint(null)}};
const formOpen={};
function setForm(tab,open){
  const f=FORMS[tab],p=$(f.panel);formOpen[tab]=!!open;p.hidden=ro()||(MANAGER_DATA.has(tab)&&mro())||!open;
  if(!p._x){p._x=el("button",{class:"closex",type:"button","aria-label":"Close",onclick:()=>{f.reset();setForm(tab,false)}},"Cancel");p.prepend(p._x)}
  if(open&&!p.hidden){p.scrollIntoView({behavior:"smooth",block:"start"});const i=p.querySelector("input[type=text],input:not([type])");if(i)i.focus({preventScroll:true})}
  renderAddBtn();
}
// Things the Add button can start in sections without an add form: one action, or a short menu.
const ADD_ACTIONS={
  plans:()=>S.plan?null:["Add",[["New HACCP plan","plans",()=>newPlan("haccp")],["New risk assessment","review",()=>newPlan("risk")]]],
  onboarding:()=>S.onb?null:["Add",[["New induction checklist","onboarding",()=>newOnb(true)],["New blank document","doc",()=>newOnb(false)]]],
  eho:()=>S.insp||!inspSorted().length?null:["Add",[["Add inspection","eho",manualInsp]]]};
function renderAddBtn(){
  const b=$("#addBtn");if(!b)return;
  const f=FORMS[S.tab],a=ADD_ACTIONS[S.tab]&&ADD_ACTIONS[S.tab]();
  b.hidden=ro()||(MANAGER_DATA.has(S.tab)&&mro())||(f?!!formOpen[S.tab]:!a);if(b.hidden)return;
  b.replaceChildren(svgi(ICON.plus),el("span",{text:f?f.add:a[0]}));
  b.onclick=f?()=>{f.reset();setForm(S.tab,true)}:a[1].length===1?a[1][0][2]:()=>openMenu(b,a[1]);
}
// A small menu under a button: items are [label, icon, action].
function openMenu(anchor,items){
  const m=$("#acctMenu");
  m.replaceChildren(...items.map(([t,ic,fn])=>el("button",{class:"m",type:"button",role:"menuitem",onclick:()=>{closeSheets();fn()}},svgi(ICON[ic]),el("span",{text:t}))));
  const r=anchor.getBoundingClientRect();
  m.style.bottom="";m.style.top=(r.bottom+8)+"px";m.style.left=Math.max(12,Math.min(r.right-260,innerWidth-272))+"px";
  $("#sheetVeil").hidden=false;m.hidden=false;m.querySelector("button").focus();
}

/* ---------- section cards (Today and Week) ---------- */
// Each card has a header that opens and closes it. Unless someone has opened or closed it, a card is
// open while it still has something to do and closes once it's done.
const secOpen={};
function ringEl(n,t){
  const r=15,c=2*Math.PI*r,f=t?Math.min(1,n/t):0;
  const w=el("span",{class:"ring","aria-hidden":"true"});
  w.innerHTML=`<svg viewBox="0 0 34 34"><circle cx="17" cy="17" r="${r}" fill="none" stroke="var(--sunk)" stroke-width="3.5"/><circle cx="17" cy="17" r="${r}" fill="none" stroke="var(--accent)" stroke-width="3.5" stroke-linecap="round" stroke-dasharray="${c*f} ${c}"${f?"":` stroke-opacity="0"`}/></svg>`;
  w.append(el("span",{text:String(n)}));return w;
}
const badgeEl=(state,ic)=>{const b=el("span",{class:"badge "+(state||""),"aria-hidden":"true"});b.append(svgi(ICON[ic||(state==="done"?"check":state==="bad"?"warn":"dot")]||""));return b};
function secCard(card,key,done,mark,title,sub){
  const k=key+":"+(key==="weekly"||key==="wknotes"?S.week:S.date);
  const open=k in secOpen?secOpen[k]:!done;
  // Pop the badge only when this card has just become done (not when moving between days or sites).
  const ctx=S.site+k;
  if(card._ctx===ctx&&done&&card._done===false&&mark.classList)mark.classList.add("pop");
  card._ctx=ctx;card._done=done;
  const h=card.querySelector(".sec");
  h.replaceChildren(mark,el("span",{class:"t"},el("b",{text:title}),el("span",{class:"s",text:sub||""})),el("span",{class:"chev"},svgi(ICON.chevD)));
  h.setAttribute("aria-expanded",String(open));card.classList.toggle("shut",!open);
  h.onclick=()=>{secOpen[k]=!open;key==="weekly"||key==="wknotes"?renderWeek():renderDay()};
}
function openSec(card,key){secOpen[key+":"+(key==="weekly"||key==="wknotes"?S.week:S.date)]=true}
// Ticks for a list of checks, with "Tick all" (recorded as allDone, the "All checks completed" confirmation).
function checkFoot(foot,list,items,part,onAll){
  foot.replaceChildren();
  const left=list.filter(c=>!items[c.id]).length;
  if(!list.length){foot.append(el("span",{class:"s",text:"No checks set up. Add them in Setup."}));return}
  const who=part&&part.allDone?`Confirmed by ${nameOf(part.allDone.by)} at ${time(part.allDone.at)}`:part&&part.at?`Last ticked ${time(part.at)} by ${nameOf(part.by)}`:"";
  foot.append(el("span",{class:"s",text:left?`${left} left${who?" · "+who:""}`:who||"All ticked"}));
  if(left&&!ro())foot.append(el("button",{class:"btn ghost sm",type:"button",onclick:onAll},svgi(ICON.check),`Tick all ${left===list.length?list.length:""}`.trim()));
}
function roundChecks(box){box.querySelectorAll("input[type=checkbox]").forEach(x=>x.classList.add("rc"))}
const firstName=n=>String(n||"").trim().split(/\s+/)[0]||"you";
function setFab(btn,show,label,onclick){
  btn.hidden=!show;if(!show)return;
  btn.replaceChildren(el("span",{class:"avatar",text:initials(S.myName)}),el("span",{text:label}));btn.onclick=onclick;
}
function updFab(){document.body.classList.toggle("hasfab",[...document.querySelectorAll(".fab")].some(b=>!b.hidden&&!b.closest("[hidden]")))}

/* ---------- today ---------- */
function renderDay(){
  const ae=document.activeElement,keep=ae&&ae.id&&ae.closest&&ae.closest("#units")?{id:ae.id,v:ae.value}:null;
  try{renderDayInner()}finally{if(keep){const n=document.getElementById(keep.id);if(n){n.value=keep.v;n.focus()}}}
  updFab();
}
const stepsOf=(st,temps)=>[["Temps",temps?st.temps==="y":true],["Opening",st.open==="y"],["Closing",st.close==="y"],["Sign off",!!st.signed]];
function renderDayInner(){
  const d=S.days[S.date]||{},s=S.cfg,st=dayStatus(d,s,S.date),R=ro(),isToday=S.date===today();
  $("#dayDate").value=S.date;$("#dayDate").max=today();$("#dayNext").disabled=S.date>=today();
  $("#todayBtn").hidden=isToday;
  const ids=[];
  // progress
  const steps=stepsOf(st,s.units.length),nDone=steps.filter(x=>x[1]).length,next=steps.find(x=>!x[1]);
  $("#daySteps").replaceChildren(
    el("div",{class:"head"},el("b",{text:d.signed?"Day signed off":nDone?`${nDone} of 4 done`:"Start with "+steps[0][0].toLowerCase().replace("temps","temperatures")}),
      el("span",{class:"pill "+(d.signed?"ok":next&&next[0]==="Sign off"?"ok":"acc"),text:d.signed?"Complete":next?(next[0]==="Sign off"?"Ready to sign off":next[0]+" next"):""})),
    el("div",{class:"steprow"},...steps.map(([t,ok])=>el("button",{type:"button",class:"step"+(ok?" on":next&&next[0]===t?" now":""),"aria-label":`${t}: ${ok?"done":"to do"}. Go to it`,onclick:()=>goStep(t)},el("i"),el("span",{text:t})))));
  // anything overdue at this site (today only)
  const al=$("#dayAlerts");al.replaceChildren();
  const a=isToday&&S.db?siteAttention(S.site):null;
  if(a&&a.unused){
    al.append(alertEl("Not in use yet",`Nothing is counted as missing at the ${curSite().name} until it starts.`,canTab("setup")?["Set up",()=>show("setup")]:null,""));
  }else if(a){
    if(a.prevDue){const ps=a.pst,gaps=[];if(ps.open!=="y")gaps.push("opening");if(ps.tN<ps.tTot)gaps.push("temps");if(ps.close!=="y")gaps.push("closing");
      al.append(alertEl(`${nice(a.prev)} wasn't signed off`,gaps.length?"Still to do: "+gaps.join(", "):"Everything was ticked; it just needs signing",["Open",()=>goDay(a.prev)]))}
    for(const{kind,t,ts}of a.tasks)
      al.append(alertEl(t.name,`${kind==="cleaning"?"Cleaning":"Extra check"} · ${(t.freq||"").replace(/^./,c=>c.toUpperCase())} · ${ts.text.toLowerCase()}`,R?null:["Done",()=>completeTask(kind,t,a.id,"")]));
  }
  const cl=closure(d);
  const cn=$("#closedNote");cn.hidden=!cl&&!isClosed(S.date);
  cn.textContent=cl?`Closed: ${cl.reason}. Marked by ${nameOf(cl.by)}, ${when(cl.at)}. This day isn't counted as incomplete.`:`${curSite().name} is set as closed on ${parse(S.date).toLocaleDateString("en-GB",{weekday:"long"})}s. You can still record checks if it opened.`;
  cn.classList.toggle("closedday",!!cl);
  renderCloseDay(d);
  const info=S.settings.info||{};
  $("#siteNotePanel").hidden=!info.note;$("#siteNoteTitle").textContent=`${curSite().name} notes`;
  $("#siteNote").replaceChildren(renderBody(info.note||""));
  // temperatures
  const tc=$("#tempsCard");tc.hidden=!s.units.length&&!S.settings.fresh;
  const units=$("#units");units.replaceChildren();const bad=[],chips=[];let last=null;
  for(const u of s.units){
    const r=d.temps&&d.temps[u.id]&&d.temps[u.id].am;const v=r&&r.v!=null?r.v:"";if(r){ids.push(r.by);if(!last||r.at>last.at)last=r}
    const id=`t_${u.id}`,cls=tempState(u.kind,v===""?null:v);
    if(cls==="bad")bad.push([u,v]);
    if(v!=="")chips.push(el("span",{class:"chip "+cls,text:`${u.name} ${v}°`}));
    const inp=el("input",{type:"number",step:"0.1",inputmode:"decimal",id,value:v,placeholder:"°C",disabled:R,"aria-label":`${u.name} temperature °C`});
    const mark=el("span",{class:"st","aria-hidden":"true"});
    const row=el("div",{class:"tf "+cls},el("label",{class:"n",for:id,text:u.name}),el("span",{class:"lim",text:(u.kind==="freezer"?"−18°C or colder":"5°C or below")+(r?` · ${time(r.at)}, ${nameOf(r.by)}`:"")}),el("span",{class:"v"},inp,mark));
    const paint=()=>{const c=tempState(u.kind,inp.value===""?null:Number(inp.value));row.className="tf "+c;mark.replaceChildren(c==="ok"?svgi(ICON.check):c==="bad"||c==="warn"?svgi(ICON.warn):"")};
    paint();inp.addEventListener("input",paint);
    inp.addEventListener("change",()=>{
      const raw=inp.value.trim();const val=raw===""?null:Math.round(Number(raw)*10)/10;
      if(raw!==""&&!isFinite(val))return;
      patchDay(S.date,{temps:{[u.id]:{am:val==null?null:{v:val,...stamp()}}}});
    });
    units.append(row);
  }
  if(!s.units.length)units.append(el("div",{class:"empty",text:"No fridges or freezers set up yet. Add them in Setup."}));
  const adv=$("#tempAdvice");adv.replaceChildren();
  if(bad.length){
    const[u,v]=bad[0];
    adv.append(el("div",{class:"advice"},el("b",{text:bad.length>1?`${bad.length} readings out of range`:`${u.name} is out of range (${v}°C)`}),
      el("span",{text:`Move high-risk food to a unit that's in range, check the door seal and setting, then take the reading again in 30 minutes. If it's still ${u.kind==="freezer"?"above −15°C":"above 8°C"}, call the engineer and decide what to throw away.`}),
      R?null:el("button",{class:"btn ghost sm",type:"button",onclick:()=>{openSec($("#probCard"),"problems");renderDay();const pb=$("#problems");if(!pb.value)pb.value=`${u.name} read ${v}°C at ${time(Date.now())}. `;pb.focus();pb.scrollIntoView({block:"center",behavior:"smooth"})}},"Write down what you did")));
  }
  const tDone=st.tN>=st.tTot&&st.tTot>0;
  secCard(tc,"temps",tDone&&!bad.length,bad.length?badgeEl("bad"):tDone?badgeEl("done"):ringEl(st.tN,st.tTot),"Temperatures",
    bad.length?"Out of range: needs action":tDone?`All in range${last?` · ${time(last.at)}, ${nameOf(last.by)}`:""}`:st.tN?`${st.tN} of ${st.tTot} taken`:"Fridges 5°C or below · freezers −18°C or colder");
  const tch=$("#tempChips");tch.replaceChildren(...chips);tch.hidden=!tc.classList.contains("shut")||!chips.length;
  // opening and closing
  for(const[key,list,card,box,foot,title]of[["opening",checksOn(s.opening,S.date),"#openCard","#openList","#openFoot","Opening checks"],["closing",checksOn(s.closing,S.date),"#closeCard","#closeList","#closeFoot","Closing checks"]]){
    const part=d[key]||{};const items=part.items||{};
    checklist($(box),list,items,key,(cid,v)=>patchDay(S.date,{[key]:{items:{[cid]:v},...stamp(),...(v?{}:{allDone:null})}}));roundChecks($(box));
    if(part.by)ids.push(part.by);if(part.allDone&&part.allDone.by)ids.push(part.allDone.by);
    const n=list.filter(c=>items[c.id]).length,all=list.length>0&&n===list.length;
    checkFoot($(foot),list,items,part,()=>{const set={},back={},date=S.date;for(const c of list){set[c.id]=true;back[c.id]=!!items[c.id]}
      patchDay(date,{[key]:{items:set,...stamp(),allDone:stamp()}});toast(`All ${key} checks done`,["Undo",()=>patchDay(date,{[key]:{items:back,allDone:null}})])});
    secCard($(card),key,all,all?badgeEl("done"):ringEl(n,list.length),title,
      all?`${n} of ${n}${part.allDone||part.at?` · ${nameOf((part.allDone||part).by)}, ${time((part.allDone||part).at)}`:""}`:n?`${n} of ${list.length} ticked`:key==="closing"?`After close · ${list.length} checks`:`${list.length} checks`);
  }
  // problems
  const pb=$("#problems"),pt=(d.problems&&d.problems.text)||"";if(document.activeElement!==pb)pb.value=pt;
  pb.disabled=R;$("#saveProb").disabled=R;
  if(d.problems&&d.problems.by)ids.push(d.problems.by);
  $("#probBy").textContent=d.problems&&d.problems.at?`Saved ${time(d.problems.at)} by ${nameOf(d.problems.by)}`:"";
  secCard($("#probCard"),"problems",true,badgeEl("acc","pen"),"Problems & changes (Corrective actions)",pt?pt.split("\n")[0]:bad.length?"Note what you did about the reading":"Optional · nothing noted");
  // sign off
  const sc=$("#signCard");sc.replaceChildren();
  const missing=steps.slice(0,3).filter(x=>!x[1]).map(x=>x[0].toLowerCase().replace("temps","temperatures")+(x[0]==="Temps"?"":" checks"));
  const sign=()=>{patchDay(S.date,{signed:{...stamp(),name:S.myName}});toast(`Day signed off by ${S.myName||"you"}`)}; // also replaces any Undo still showing
  if(d.signed){
    ids.push(d.signed.by);
    const who=d.signed.name||nameOf(d.signed.by),on=d.signed.at&&iso(new Date(d.signed.at))!==S.date?" on "+short(iso(new Date(d.signed.at))):"";
    sc.className="scard glass signcard done";
    sc.append(el("span",{class:"big"},svgi(ICON.check)),el("h2",{text:"Day signed off"}),el("span",{class:"s",text:`By ${who} at ${time(d.signed.at)}${on}`}),
      R?null:el("button",{class:"btn ghost sm",type:"button",onclick:()=>patchDay(S.date,{signed:null})},"Undo sign-off"));
  }else{
    sc.className="scard glass signcard";
    sc.append(el("div",{class:"sec"},badgeEl(missing.length?"":"acc",missing.length?"lock":"pen"),el("span",{class:"t"},el("b",{text:"Sign off"}),
      el("span",{class:"s",text:missing.length?"Still to do: "+missing.join(", "):`Confirms the day's checks were done. Signs as ${S.myName||"you"}.`}))));
    if(missing.length&&!R)sc.append(el("div",{class:"secfoot"},el("span",{class:"s",text:"Couldn't do everything? Say why under Problems, then sign off."}),
      el("button",{class:"btn ghost sm",type:"button",onclick:()=>{
        if(!pt.trim()){openSec($("#probCard"),"problems");renderDay();$("#problems").focus();toast("Write what was missed under Problems first.");return}
        sign();
      }},"Sign off anyway")));
  }
  setFab($("#signFab"),!d.signed&&!missing.length&&!R,`Sign off as ${firstName(S.myName)}`,sign);
  resolveNames(ids);
}
// From the progress bar: open that part of the day and bring it into view.
function goStep(t){
  const[card,key]={Temps:["#tempsCard","temps"],Opening:["#openCard","opening"],Closing:["#closeCard","closing"]}[t]||["#signCard",null];
  if(key)openSec($(card),key);renderDay();
  const n=$(card);n.scrollIntoView({behavior:"smooth",block:"start"});
  const i=n.querySelector("input:not(:checked):not([disabled])");if(i&&key==="temps")i.focus({preventScroll:true});
}
function alertEl(title,sub,action,cls){
  return el("div",{class:"alert "+(cls==null?"":cls)},el("span",{class:"ic"},svgi(ICON.warn)),el("span",{class:"t"},el("b",{text:title}),el("span",{class:"s",text:sub})),
    action?el("button",{class:"btn sm",type:"button",onclick:action[1]},action[0]):null);
}

/* ---------- week ---------- */
function renderWeek(){
  const wk=S.week,w=S.weeks[wk]||{},list=checksOn(S.cfg.weekly||[],addDays(wk,6)),items=w.items||{},R=ro();
  $("#wkNext").disabled=wk>=monday(today());
  // the seven days, each with how complete it was
  const strip=$("#weekDays");strip.replaceChildren();
  for(let i=0;i<7;i++){
    const date=addDays(wk,i),dd=S.days[date],st=dayStatus(dd,null,date),t=today();
    const cls=closure(dd)?"closed":date===t?"today":date>t?"future":dd&&dd.signed&&st.complete?"ok":st.any?"part":isClosed(date)?"closed":"bad";
    const lbl=parse(date).toLocaleDateString("en-GB",{weekday:"short"});
    strip.append(el("button",{class:"wday "+cls,type:"button",disabled:date>t,"aria-label":`${nice(date)}: ${cls==="ok"?"signed off":cls==="part"?"partly done":cls==="bad"?"nothing recorded":cls==="closed"?"closed":""}`,onclick:()=>goDay(date)},
      el("span",{text:lbl.slice(0,1)}),el("b",{text:String(parse(date).getDate())}),el("span",{class:"d"})));
  }
  const n=list.filter(c=>items[c.id]).length,all=list.length>0&&n===list.length;
  checklist($("#wkList"),list,items,"wk",(cid,v)=>patchWeek(wk,{items:{[cid]:v},...stamp()}));roundChecks($("#wkList"));
  checkFoot($("#wkFoot"),list,items,w,()=>{const set={},back={};for(const c of list){set[c.id]=true;back[c.id]=!!items[c.id]}
    patchWeek(wk,{items:set,...stamp()});toast("All end-of-week checks done",["Undo",()=>patchWeek(wk,{items:back})])});
  secCard($("#wkCard"),"weekly",all,all?badgeEl("done"):ringEl(n,list.length),"End-of-week checks",
    all?`${n} of ${n}${w.at?` · ${nameOf(w.by)}, ${when(w.at)}`:""}`:n?`${n} of ${list.length} ticked`:"Do these after the last shift of the week");
  const nt=$("#wkNotes"),ntx=(w.notes&&w.notes.text)||"";if(document.activeElement!==nt)nt.value=ntx;
  nt.disabled=R;$("#wkSaveNote").disabled=R;
  $("#wkNoteBy").textContent=w.notes&&w.notes.at?`Saved ${when(w.notes.at)} by ${nameOf(w.notes.by)}`:"";
  secCard($("#wkNoteCard"),"wknotes",true,badgeEl("acc","pen"),"Notes for the week",ntx?ntx.split("\n")[0]+(w.notes.by?` · ${nameOf(w.notes.by)}`:""):"Optional · pests, maintenance, anything to follow up");
  const sc=$("#wkSignCard");sc.replaceChildren();
  const sign=()=>{patchWeek(wk,{signed:{...stamp(),name:S.myName}});toast(`Week signed off by ${S.myName||"you"}`)};
  if(w.signed){
    sc.className="scard glass signcard done";
    sc.append(el("span",{class:"big"},svgi(ICON.check)),el("h2",{text:"Week signed off"}),el("span",{class:"s",text:`By ${w.signed.name||nameOf(w.signed.by)} on ${when(w.signed.at)}`}),
      R?null:el("button",{class:"btn ghost sm",type:"button",onclick:()=>patchWeek(wk,{signed:null})},"Undo sign-off"));
  }else{
    sc.className="scard glass signcard";
    sc.append(el("div",{class:"sec"},badgeEl(all?"acc":"",all?"pen":"lock"),el("span",{class:"t"},el("b",{text:"Sign off the week"}),
      el("span",{class:"s",text:all?`Signs as ${S.myName||"you"}.`:`Unlocks when the ${list.length-n===1?"last check is":`${list.length-n} checks are`} done`}))));
  }
  setFab($("#wkSignFab"),!w.signed&&all&&!R,`Sign off week as ${firstName(S.myName)}`,sign);
  updFab();
  resolveNames([w.by,w.signed&&w.signed.by,w.notes&&w.notes.by]);
}

/* ---------- history ---------- */
// The first day the diary counts at this site (Setup → Diary starts on). Earlier days are never shown as missed.
const diaryStart=(s)=>(s||S.settings).startDate||"";
// Only a start date someone chose in Setup (startSet) hides the days before it altogether; one filled in
// automatically when Setup was first saved only stops empty earlier days counting as missed.
const hardStart=(s)=>{s=s||S.settings;return s.startSet?s.startDate||"":""};
function renderHistory(){
  const grid=$("#strip");grid.replaceChildren();
  const end=today(),first=addDays(end,-27),start=monday(first);
  let complete=0,trading=0,missed=0,hot=0;const exc=[];
  for(const h of["M","T","W","T","F","S","S"])grid.append(el("span",{class:"h",text:h}));
  for(let date=start;date<=addDays(monday(end),6);date=addDays(date,1)){
    const dd=parse(date);
    if(date<first||date>end){grid.append(el("span",{class:"cd out",text:String(dd.getDate())}));continue}
    if(diaryStart()&&date<diaryStart()&&(hardStart()||!S.days[date])){grid.append(el("span",{class:"cd out",title:"Before the diary started",text:String(dd.getDate())}));continue}
    const d=S.days[date],st=dayStatus(d,null,date),shut=!!closure(d)||isClosed(date)&&!st.any;
    if(closure(d))exc.push([date,"Closed: "+closure(d).reason,""]);
    if(!shut){trading++;if(st.complete)complete++;else if(date<end&&!st.any)missed++}
    const cls=shut?"closed":st.complete||(d&&d.signed)?"ok":st.any?"part":date<end?"bad":"";
    grid.append(el("button",{class:"cd "+cls+(date===end?" today":"")+(st.issue?" hot":""),type:"button",title:nice(date),"aria-label":nice(date),onclick:()=>goDay(date)},String(dd.getDate())));
    if(d&&d.temps)for(const u of S.settings.units){const r=d.temps[u.id]&&d.temps[u.id].am;if(r&&tempState(u.kind,r.v)==="bad"){hot++;exc.push([date,`${u.name} read ${r.v}°C`,"bad"])}}
    if(date<end&&!st.complete&&!shut)exc.push([date,st.any?"Diary not completed":"No diary entry",st.any?"warn":"bad"]);
    if(d&&d.problems&&d.problems.text)exc.push([date,d.problems.text,""]);
  }
  const stat=(n,l,c)=>el("div",{class:"stat glass"},el("b",{class:c||"",text:n}),el("span",{text:l}));
  $("#histStats").replaceChildren(stat(`${complete}/${trading}`,"days complete",complete>=trading-2?"ok":"warn"),stat(String(missed),"days missed",missed?"bad":"ok"),stat(String(hot),"readings out of range",hot?"bad":"ok"));
  const box=$("#excList");box.replaceChildren();
  if(!exc.length)box.append(el("div",{class:"empty",text:"Nothing to report in the last 4 weeks."}));
  for(const[date,w,c]of exc.reverse())box.append(el("button",{class:"lrow",type:"button",onclick:()=>goDay(date)},
    el("span",{class:"sdot "+c}),el("span",{class:"t"},el("b",{text:w}),el("span",{class:"s",text:nice(date)})),el("span",{class:"chev"},svgi(ICON.chevR))));
}

/* ---------- task lists (extra checks & cleaning) ---------- */
const TASKS={
  extras:{list:"#xList",form:"#xForm",title:"#xFormTitle",panel:"#xFormPanel",noun:"extra check",
    fields:[["name","Check","text","e.g. Probe thermometer accuracy check"],["how","How to do it","text","e.g. Iced water and boiling water test; record in Prove it"],["freq","How often","freq"],["who","Who does it","text","e.g. Duty manager"]]},
  cleaning:{list:"#kList",form:"#kForm",title:"#kFormTitle",panel:"#kFormPanel",noun:"cleaning task",
    fields:[["name","Item or area","text","e.g. Coffee machine group heads"],["how","How to clean (method & product)","text","e.g. Backflush with cleaning tablet, rinse"],["freq","How often","freq"],["who","Who does it","text","e.g. Closing barista"]]}};
const editing={extras:null,cleaning:null};
function buildTaskForm(kind){
  const cfg=TASKS[kind],box=$(cfg.form);box.replaceChildren();
  const f=el("div",{class:"fields"});
  for(const[k,lbl,type,ph]of cfg.fields){
    const id=`${kind}_f_${k}`;let inp;
    if(type==="freq"){inp=el("select",{id});for(const o of Object.keys(FREQ))inp.append(el("option",{value:o},o[0].toUpperCase()+o.slice(1)));inp.value="weekly"}
    else inp=el("input",{type:"text",id,placeholder:ph});
    f.append(el("div",{class:"field"},el("label",{class:"label",for:id,text:lbl}),inp));
  }
  const msg=el("span",{class:"by"});
  const cancel=el("button",{class:"btn ghost",hidden:true,onclick:()=>editTask(kind,null)},"Cancel edit");
  const del=el("button",{class:"btn ghost danger",hidden:true},"Remove");
  armDelete(del,"Remove",async()=>{if(await save(()=>D(kind,editing[kind]).delete())){editTask(kind,null);toast("Removed")}});
  const pick=sitePicker(kind+"_sites");
  const saveBtn=el("button",{class:"btn",onclick:async()=>{
    const v={};for(const[k]of cfg.fields)v[k]=$(`#${kind}_f_${k}`).value.trim();
    if(!v.name){msg.textContent="Give it a name first.";return}
    const old=editing[kind]?S[kind].find(x=>x.id===editing[kind]):null;
    const r=await multiSave(kind,pick.get(),v,{editId:editing[kind],old,patch:true});
    if(r){msg.textContent="";toast(`Saved ${v.name}${r.where}.${r.warn}`);editTask(kind,null)}
  }},"Save");
  box.append(f,pick.el,el("div",{class:"row"},saveBtn,cancel,del,msg));
  box._cancel=cancel;box._del=del;box._pick=pick;
}
function editTask(kind,t){
  const cfg=TASKS[kind];editing[kind]=t?t.id:null;
  $(cfg.title).textContent=t?"Edit "+t.name:"Add a "+cfg.noun;
  for(const[k,,type]of cfg.fields)$(`#${kind}_f_${k}`).value=t?(t[k]||(type==="freq"?"weekly":"")):(type==="freq"?"weekly":"");
  const box=$(cfg.form);box._cancel.hidden=true;box._del.hidden=!t;box._pick.set(t&&t.sites);
  setForm(kind,!!t);
}
function renderTasks(kind){
  const cfg=TASKS[kind],box=$(cfg.list);box.replaceChildren();
  const R=ro(),ids=[];let over=0;
  const items=[...S[kind]].map(t=>({t,st:taskState(t),due:dueDate(t)}));
  if(!items.length)box.append(el("div",{class:"empty glass",text:`Nothing listed yet.${R?"":` Tap ${FORMS[kind].add} to add your first ${cfg.noun}.`}`}));
  const groups=[["Overdue",x=>x.st.overdue],["Due today",x=>!x.st.overdue&&x.st.cls==="warn"&&FREQ[x.t.freq]>0],["As needed",x=>!FREQ[x.t.freq]],["Coming up",()=>true]];
  const left=new Set(items);
  for(const[label,test]of groups){
    const g=[...left].filter(test);g.forEach(x=>left.delete(x));if(!g.length)continue;
    g.sort((a,b)=>(a.due||"9").localeCompare(b.due||"9")||a.t.name.localeCompare(b.t.name));
    if(label==="Overdue")over=g.length;
    const list=el("div",{class:"list glass"});
    for(const{t,st}of g){
      if(t.lastBy)ids.push(t.lastBy);
      const note=el("input",{type:"text",placeholder:"Note (optional)",disabled:R,"aria-label":"Note for "+t.name});
      const hist=(t.log||[]).slice(0,10).map((e,i)=>{
        let del=null;
        if(!R){del=el("button",{class:"btn ghost sm danger",type:"button","aria-label":`Delete the entry for ${lastWhen(e.at,e.set)}`},"Delete");armDelete(del,"Delete",()=>deleteTaskEntry(kind,t,S.site,i))}
        return el("li",{},el("span",{text:lastWhen(e.at,e.set)}),el("span",{class:"s",text:nameOf(e.by)+(e.note?" · "+e.note:"")}),del)});
      const dateId=`${kind}_last_${t.id}`;
      const dateIn=el("input",{type:"date",id:dateId,max:iso(new Date()),value:t.lastAt?iso(new Date(t.lastAt)):""});
      for(const e of(t.log||[]).slice(0,10))ids.push(e.by);
      list.append(xrow(kind+t.id,{
        title:t.name,
        sub:[(t.freq||"").replace(/^./,c=>c.toUpperCase()),t.who,t.lastAt?`last ${lastWhen(t.lastAt,t.lastSet)}, ${nameOf(t.lastBy)}`:"never done"].filter(Boolean).join(" · "),
        right:[label==="Coming up"||label==="As needed"?el("span",{class:"pill "+(label==="As needed"?"":"ok"),text:label==="As needed"?"As needed":st.text.replace(/^Due /,"")}):el("span",{class:"pill "+st.cls,text:st.overdue?st.text.replace(/^Not done yet · /,"").replace(/^Overdue by (\d+) days?$/,"$1d late"):"Today"}),
          R?null:el("button",{class:"btn sm",type:"button",onclick:()=>completeTask(kind,t,S.site,"")},"Done")],
        details:[t.how?el("p",{class:"how",text:t.how}):null,
          R?null:el("div",{class:"row"},note,el("button",{class:"btn ghost sm",type:"button",onclick:()=>completeTask(kind,t,S.site,note.value.trim())},"Done with note")),
          R?null:el("div",{class:"row lastdate"},el("label",{class:"label",for:dateId,text:"Last done on"}),dateIn,
            el("button",{class:"btn ghost sm",type:"button",onclick:()=>setTaskDate(kind,t,S.site,dateIn.value)},"Save date")),
          hist.length?el("ul",{class:"hist"},...hist):el("p",{class:"s",text:"Not recorded as done yet."}),
          R?null:el("div",{class:"row"},el("button",{class:"btn ghost sm",type:"button",onclick:()=>editTask(kind,t)},"Edit "+cfg.noun))]}));
    }
    box.append(el("div",{class:"label"+(label==="Overdue"?" bad":""),text:`${label} · ${g.length}`}),list);
  }
  $(cfg.panel).hidden=R||!formOpen[kind];
  resolveNames(ids);
  return over;
}

async function completeTask(kind,t,site,note){
  const entry={at:Date.now(),by:S.me,note:note||""};
  const log=[entry,...(t.log||[])].slice(0,30);
  const before={lastAt:t.lastAt||null,lastBy:t.lastBy||null,lastSet:!!t.lastSet,log:t.log||[]};
  if(await save(()=>D(kind,t.id,site).update({lastAt:entry.at,lastBy:entry.by,lastSet:false,log})))
    toast(`${t.name}: done${site!==S.site?" at "+siteOf(site).name:""}`,["Undo",()=>save(()=>D(kind,t.id,site).update(before))]);
}

// Delete one entry from a task's history (ticked by mistake, or the wrong date). If it was the latest, the
// task's last-done date goes back to the entry before it, so the next due date is worked out from that.
async function deleteTaskEntry(kind,t,site,i){
  const log=[...(t.log||[])],[gone]=log.splice(i,1);if(!gone)return;
  const before={lastAt:t.lastAt||null,lastBy:t.lastBy||null,lastSet:!!t.lastSet,log:t.log||[]};
  const patch={log};
  if(t.lastAt===gone.at||!log.length){const prev=log[0];patch.lastAt=prev?prev.at:null;patch.lastBy=prev?prev.by:null;patch.lastSet=!!(prev&&prev.set)}
  if(await save(()=>D(kind,t.id,site).update(patch)))
    toast(`${t.name}: entry for ${lastWhen(gone.at,gone.set)} deleted`,["Undo",()=>save(()=>D(kind,t.id,site).update(before))]);
}
// Set the date a task was last carried out by hand, e.g. when it was done but not ticked off at the time.
// Stored at midday on that date (now, if it's today) and marked lastSet so it shows without a time.
async function setTaskDate(kind,t,site,value){
  const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(value||"");
  if(!m){toast("Choose a date first");return}
  const d=new Date(+m[1],+m[2]-1,+m[3],12);
  const today=iso(new Date())===value;
  if(!today&&d>new Date()){toast("That date is in the future");return}
  const at=today?Date.now():d.getTime();
  const entry={at,by:S.me,note:"Date entered by hand",set:true};
  const log=[entry,...(t.log||[])].slice(0,30);
  const before={lastAt:t.lastAt||null,lastBy:t.lastBy||null,lastSet:!!t.lastSet,log:t.log||[]};
  if(await save(()=>D(kind,t.id,site).update({lastAt:at,lastBy:S.me,lastSet:true,log})))
    toast(`${t.name}: last done ${lastWhen(at,true)}`,["Undo",()=>save(()=>D(kind,t.id,site).update(before))]);
}

/* ---------- prove it ---------- */
function fillProve(){
  const sel=$("#pMethod"),cur=sel.value;sel.replaceChildren();
  for(const[k,r]of Object.entries(PROVE))if(!S.settings.proveOff.includes(k))sel.append(el("option",{value:k},r.label));
  if(!sel.options.length)sel.append(el("option",{value:"other"},PROVE.other.label));
  if([...sel.options].some(o=>o.value===cur))sel.value=cur;
  const box=$("#pMethods");box.replaceChildren();
  for(const o of sel.options)box.append(el("button",{type:"button",role:"radio","aria-checked":String(o.value===sel.value),class:o.value===sel.value?"on":"",
    onclick:()=>{sel.value=o.value;fillProve()}},o.textContent));
  sel.dispatchEvent(new Event("change"));
}
// The pass/fail result, worked out as the reading is typed.
function proveLive(){
  const m=$("#pMethod").value,r=PROVE[m],box=$("#pResult");if(!r)return;
  const raw=$("#pReading").value.trim(),v=raw===""?null:Number(raw);
  const pass=proveResult(m,v,$("#pManual").value);
  box.hidden=pass==null||(r.manual&&raw===""&&!$("#pAction").value);
  if(box.hidden)return;
  box.className="result "+(pass?"ok":"bad");
  box.replaceChildren(el("span",{class:"badge "+(pass?"done":"bad")},svgi(ICON[pass?"check":"warn"])),
    el("span",{text:pass?"Pass":r.manual?"Fail: say what you did about it":`Fail: ${r.hint.replace(/^Pass /,"needs to be ").replace(/\..*$/,"")}. Say what you did about it.`}));
}
function proveForm(){
  const sel=$("#pMethod");
  $("#pDate").value=today();
  const upd=()=>{const r=PROVE[sel.value];if(!r)return;$("#pReadLbl").textContent=r.unit==="min"?"Minutes":`Reading (${r.unit||"°C"})`;$("#pHint").textContent=r.hint;$("#pManualWrap").hidden=!r.manual;proveLive()};
  sel.addEventListener("change",upd);fillProve();
  for(const x of["#pReading","#pManual"])$(x).addEventListener("input",proveLive);
  $("#pSave").addEventListener("click",async()=>{
    const m=sel.value,raw=$("#pReading").value.trim(),v=raw===""?null:Number(raw);
    const food=$("#pFood").value.trim();
    if(!food){$("#pMsg").textContent="Say what food or equipment you checked.";return}
    if(!PROVE[m].manual&&(v==null||!isFinite(v))){$("#pMsg").textContent="Enter the reading.";return}
    const pass=proveResult(m,v,$("#pManual").value);
    if(pass===false&&!$("#pAction").value.trim()){$("#pMsg").textContent="It failed: write what you did about it before saving.";$("#pAction").focus();return}
    const rec={date:$("#pDate").value||today(),method:m,food,reading:v,unit:PROVE[m].unit||"°C",pass,action:$("#pAction").value.trim(),by:S.me,at:Date.now()};
    let ref=null;
    if(await save(async()=>{ref=await C("proveit").add(rec)})){
      const site=S.site;
      $("#pMsg").textContent="";toast(pass?`Saved: ${food} passed`:`Saved: ${food} failed, action recorded`,ref&&ref.id?["Undo",async()=>{if(await save(()=>D("proveit",ref.id,site).delete()))toast("Record removed")}]:null);
      $("#pFood").value="";$("#pReading").value="";$("#pAction").value="";proveLive();
    }
  });
}
// A record as loaded (with its id) back into the shape that's saved, for Undo after a delete.
const storableRec=r=>{const o={...r};delete o.id;return o};
function renderProve(){
  const box=$("#pList");box.replaceChildren();const ids=[];
  const recs=[...S.prove].sort((a,b)=>(b.date||"").localeCompare(a.date||"")||(b.at||0)-(a.at||0));
  const fails=recs.filter(r=>r.pass===false).length;
  const p=$("#pPill");p.textContent=`${recs.length} record${recs.length===1?"":"s"}${fails?` · ${fails} failed`:""}`;p.className="pill "+(fails?"warn":recs.length?"ok":"");
  if(!recs.length)box.append(el("div",{class:"empty",text:"No records yet. Start with a probe thermometer check and the core temperature of something you cook or reheat."}));
  for(const r of recs.slice(0,200)){
    ids.push(r.by);
    const rule=PROVE[r.method]||{label:r.method};
    let del=null;if(!ro()){del=el("button",{class:"btn ghost sm danger",type:"button"},"Delete this record");armDelete(del,"Delete this record",async()=>{if(await save(()=>D("proveit",r.id).delete()))toast(`Deleted: ${r.food}, ${short(r.date)}`,["Undo",()=>save(()=>D("proveit",r.id).set(storableRec(r)))])})}
    box.append(xrow("p"+r.id,{
      title:r.food,sub:`${rule.label} · ${short(r.date)}`,
      right:[el("span",{class:"res",text:r.reading==null?"":`${r.reading}${r.unit==="min"?" min":"°"}`}),el("span",{class:"pill "+(r.pass?"ok":"bad"),text:r.pass?"Pass":"Fail"})],
      details:[xfacts([["Action",r.action],["Recorded by",nameOf(r.by)+(r.at?", "+when(r.at):"")],["Rule",rule.hint]]),del?el("div",{class:"row"},del):null]}));
  }
  $("#pFormPanel").hidden=ro();
  resolveNames(ids);
}

/* ---------- temperature log ----------
   Every fridge and freezer reading at this site, a day per row, newest first. Open a day to add a missed reading
   or amend one: the reading's first value is kept as `was` (with who took it and when), and the amendment is
   stamped with who changed it, when, and why. Removing a reading keeps it the same way (v: null). */
const TL_RANGES=[["7","Last 7 days"],["28","Last 4 weeks"],["91","Last 3 months"],["365","Last 12 months"]];
let TL={range:(()=>{try{return localStorage.getItem("sfbb.tlRange")||"28"}catch(e){return"28"}})(),edit:{}};
const tlReading=(d,u)=>d&&d.temps&&d.temps[u.id]&&d.temps[u.id].am||null;
function tempLogForm(){
  const box=$("#tlChips");
  for(const[k,l]of TL_RANGES)box.append(el("button",{type:"button",role:"radio","data-r":k,onclick:()=>{TL.range=k;try{localStorage.setItem("sfbb.tlRange",k)}catch(e){}renderTempLog()}},l));
}
async function saveReading(date,u,raw,note){
  const d=S.days[date],r=tlReading(d,u);
  const v=raw===""?null:Math.round(Number(raw)*10)/10;
  if(raw!==""&&!isFinite(v)){toast("Enter a number, like 3.5 or -19");return false}
  if(r&&r.v===v)return true;
  if(!r&&v==null)return true;
  const amend=!!(r&&r.v!=null)&&(date!==today()||note);
  const am={v,...stamp(),note:note||""};
  if(r&&r.v!=null&&!r.was)am.was={v:r.v,by:r.by,at:r.at};
  if(amend||r&&r.was)am.amended=true;
  if((!r||r.v==null)&&!r?.was&&date!==today())am.late=true;
  return await save(()=>patchDay(date,{temps:{[u.id]:{am}}}));
}
function renderTempLog(){
  const box=$("#tlList");if(!box||S.tab!=="templog")return;
  for(const b of document.querySelectorAll("#tlChips button")){const on=b.dataset.r===TL.range;b.classList.toggle("on",on);b.setAttribute("aria-checked",String(on))}
  const units=S.settings.units,R=ro(),t=today(),ids=[];
  box.replaceChildren();
  if(!units.length){box.append(el("div",{class:"empty glass",text:`No fridges or freezers are set up at the ${curSite().name}.${canTab("setup")?" Add them in Setup.":""}`}));$("#tlStats").replaceChildren();return}
  const from=addDays(t,-(Number(TL.range)-1)),start=hardStart()||"";
  let readings=0,out=0,missing=0;
  const list=el("div",{class:"list glass"});
  for(let date=t;date>=from;date=addDays(date,-1)){
    if(start&&date<start)break;
    if(diaryStart()&&date<diaryStart()&&!S.days[date])continue;
    const d=S.days[date],closed=!!closure(d)||isClosed(date)&&!(d&&dayStatus(d,null,date).any);
    const cells=units.map(u=>{const r=tlReading(d,u),v=r&&r.v!=null?Number(r.v):null;
      if(v!=null){readings++;if(tempState(u.kind,v)==="bad")out++}else if(!closed&&date<t)missing++;
      if(r){ids.push(r.by);if(r.was)ids.push(r.was.by)}
      return{u,r,v,c:v==null?"":tempState(u.kind,v)}});
    if(closed&&!cells.some(c=>c.r))continue;
    const pills=cells.map(c=>el("span",{class:"pill "+(c.v==null?(date<t&&!closed?"bad":""):c.c==="ok"?"ok":c.c),title:c.u.name},`${c.u.name}: ${c.v==null?"–":c.v+"°"}${c.r&&(c.r.was||c.r.amended||c.r.late)?" ✎":""}`));
    const details=[];
    for(const c of cells){
      const id=`tl_${date}_${c.u.id}`;
      const inp=el("input",{type:"number",step:"0.1",inputmode:"decimal",id,value:c.v==null?"":String(c.v),placeholder:"°C",disabled:R,"aria-label":`${c.u.name} on ${nice(date)}, °C`});
      const hist=[];
      if(c.r&&c.r.v!=null)hist.push(`${c.r.amended||c.r.was?"Changed":c.r.late?"Added later":"Taken"} ${when(c.r.at)}, ${fullName(c.r.by)}${c.r.note?" · "+c.r.note:""}`);
      if(c.r&&c.r.v==null&&c.r.was)hist.push(`Removed ${when(c.r.at)}, ${fullName(c.r.by)}${c.r.note?" · "+c.r.note:""}`);
      if(c.r&&c.r.was)hist.push(`First recorded as ${c.r.was.v}°C, ${when(c.r.was.at)}, ${fullName(c.r.was.by)}`);
      details.push(el("div",{class:"tlunit "+(c.c||"")},
        el("label",{class:"n",for:id},el("b",{text:c.u.name}),el("span",{class:"s",text:c.u.kind==="freezer"?" · −18°C or colder":" · 5°C or below"})),
        el("span",{class:"v"},inp),
        hist.length?el("div",{class:"s tlh",text:hist.join("\n")}):null));
    }
    if(!R){
      const note=el("input",{type:"text",placeholder:"Reason for the change (e.g. misread, probe recalibrated)","aria-label":`Reason for changing ${nice(date)}`});
      const saveBtn=el("button",{class:"btn sm",type:"button",onclick:async()=>{
        let ok=true,changed=0;
        for(const c of cells){const raw=$(`#tl_${date}_${c.u.id}`).value.trim();const before=c.v==null?"":String(c.v);
          if(raw===before)continue;
          if(c.v!=null&&date!==today()&&!note.value.trim()){toast("Say why the reading is being changed");note.focus();return}
          changed++;ok=(await saveReading(date,c.u,raw,note.value.trim()))&&ok}
        if(!changed){toast("Nothing changed");return}
        if(ok){toast(`${nice(date)}: readings saved`);const bad=cells.some(c=>{const raw=$(`#tl_${date}_${c.u.id}`).value.trim();return raw!==""&&tempState(c.u.kind,Number(raw))==="bad"});
          if(bad)toast(`${nice(date)}: a reading is out of range. Write what you did in Problems & changes.`,["Open the day",()=>goDay(date)])}
      }},"Save changes");
      details.push(el("div",{class:"row"},note,saveBtn,el("button",{class:"btn ghost sm",type:"button",onclick:()=>goDay(date)},"Open the day")));
    }
    const amended=cells.some(c=>c.r&&(c.r.was||c.r.amended||c.r.late));
    list.append(xrow("tl"+date,{title:date===t?"Today":nice(date),sub:closed?(closure(d)?"Closed: "+closure(d).reason:"Closed"):amended?"Includes a changed or late reading":"",right:[el("span",{class:"tlpills"},...pills)],details}));
  }
  if(!list.children.length)box.append(el("div",{class:"empty glass",text:"No days in this period."}));else box.append(list);
  const stat=(n,l,c)=>el("div",{class:"stat glass"},el("b",{class:c||"",text:n}),el("span",{text:l}));
  $("#tlStats").replaceChildren(stat(String(readings),"readings"),stat(String(out),"out of range",out?"bad":"ok"),stat(String(missing),"missed",missing?"warn":"ok"));
  $("#tlKey").textContent=units.map(u=>`${u.name}: ${u.kind==="freezer"?"−18°C or colder":"5°C or below (8°C legal maximum)"}`).join(" · ");
  resolveNames(ids);
}

/* ---------- deliveries ----------
   SFBB "Delivery" safe method: chilled food 8°C or below (ideally 5°C), frozen −15°C or below (ideally −18°C),
   packaging undamaged, and what you ordered. Today's date and the time are added automatically. */
const DLV_TEMP={chilled:{label:"Chilled food",ok:5,max:8,ph:"e.g. 3.4"},frozen:{label:"Frozen food",ok:-18,max:-15,ph:"e.g. -19"}};
function dlvTempState(kind,v){
  if(v==null||v===""||isNaN(v))return null;const r=DLV_TEMP[kind];v=Number(v);
  return v<=r.ok?{cls:"ok",text:`${v}°C · good`}:v<=r.max?{cls:"warn",text:`${v}°C · OK, ideally ${r.ok}°C`}:{cls:"bad",text:`${v}°C · too warm, reject`};
}
const DV={supplier:"",other:false,packaging:"",order:""};
function delivForm(){
  // The saved value is always "ok" (fine) or "no" (a problem). "Any damage to packaging?" is asked the other way
  // round, so its Yes records a problem.
  const yn=(key,box)=>{box.replaceChildren();
    for(const[v,l]of key==="packaging"?[["no","Yes"],["ok","No"]]:[["ok","Yes"],["no","No"]]){const b=el("button",{type:"button","aria-pressed":String(DV[key]===v),onclick:()=>{DV[key]=v;yn(key,box);dlvVerdict()}},l);box.append(b)}};
  yn("packaging",$("#dvPack"));yn("order",$("#dvOrder"));
  for(const k of["chilled","frozen"])$("#dv_"+k).addEventListener("input",dlvVerdict);
  $("#dvNoTemp").addEventListener("change",()=>{for(const k of["chilled","frozen"]){$("#dv_"+k).disabled=$("#dvNoTemp").checked;if($("#dvNoTemp").checked)$("#dv_"+k).value=""}dlvVerdict()});
  $("#dvAccept").addEventListener("click",()=>saveDelivery("accepted"));
  $("#dvReject").addEventListener("click",()=>saveDelivery("rejected"));
  resetDelivery();
}
function resetDelivery(){
  Object.assign(DV,{supplier:"",other:false,packaging:"",order:""});
  for(const x of["#dvOther","#dvItems","#dvNote","#dv_chilled","#dv_frozen"]){const n=$(x);if(n){n.value="";n.disabled=false}}
  if($("#dvNoTemp"))$("#dvNoTemp").checked=false;
  if($("#dvDate"))$("#dvDate").value=today();
  if($("#dvMsg"))$("#dvMsg").textContent="";
  if($("#dvPack")){for(const b of document.querySelectorAll("#dvPack button,#dvOrder button"))b.setAttribute("aria-pressed","false");renderDvSuppliers();dlvVerdict()}
}
function renderDvSuppliers(){
  const box=$("#dvSup");if(!box)return;box.replaceChildren();
  const names=[...new Set(S.suppliers.map(s=>s.name).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
  for(const nm of names)box.append(el("button",{type:"button",role:"radio","aria-checked":String(!DV.other&&DV.supplier===nm),class:!DV.other&&DV.supplier===nm?"on":"",
    onclick:()=>{DV.supplier=nm;DV.other=false;renderDvSuppliers()}},nm));
  box.append(el("button",{type:"button",role:"radio","aria-checked":String(DV.other),class:DV.other?"on":"",onclick:()=>{DV.other=true;DV.supplier="";renderDvSuppliers();$("#dvOther").focus()}},names.length?"Other supplier":"Type a supplier"));
  $("#dvOtherWrap").hidden=!DV.other;
  $("#dvSupNote").hidden=names.length>0;
}
function dlvProblems(){
  const p=[];
  for(const k of["chilled","frozen"]){const s=dlvTempState(k,$("#dv_"+k).value);if(s&&s.cls==="bad")p.push(DLV_TEMP[k].label.toLowerCase()+" too warm")}
  if(DV.packaging==="no")p.push("packaging damaged");
  if(DV.order==="no")p.push("not what was ordered");
  return p;
}
function dlvVerdict(){
  for(const k of["chilled","frozen"]){const s=dlvTempState(k,$("#dv_"+k).value),o=$("#dv_"+k+"_st");o.hidden=!s;if(s){o.className="pill "+s.cls;o.textContent=s.text}}
  const p=dlvProblems(),r=$("#dvResult");
  r.hidden=!p.length;if(p.length){r.className="result bad";r.replaceChildren(svgi(ICON.warn),el("span",{text:`Reject, or write what you did: ${p.join(", ")}.`}))}
}
async function saveDelivery(outcome){
  if(ro())return;
  const msg=$("#dvMsg");
  const supplier=(DV.other?$("#dvOther").value:DV.supplier).trim();
  if(!supplier){msg.textContent="Choose the supplier first.";return}
  const num=k=>{const v=$("#dv_"+k).value;return v===""?null:Number(v)};
  const chilled=num("chilled"),frozen=num("frozen"),noTemp=$("#dvNoTemp").checked;
  if(!noTemp&&chilled==null&&frozen==null){msg.textContent="Enter the chilled or frozen temperature, or tick “No chilled or frozen food”.";return}
  if(!DV.packaging||!DV.order){msg.textContent="Answer both questions: damage to packaging, and whether it's what you ordered.";return}
  const note=$("#dvNote").value.trim(),p=dlvProblems();
  if(outcome==="rejected"&&!note){msg.textContent="Write why it was rejected and what happens next.";$("#dvNote").focus();return}
  if(outcome==="accepted"&&p.length&&!note){msg.textContent=`Something failed (${p.join(", ")}). Reject it, or write why you accepted it.`;$("#dvNote").focus();return}
  const sup=S.suppliers.find(s=>s.name===supplier);
  const now=Date.now(),date=$("#dvDate").value||today();
  const v={date,at:now,supplier,supplierId:sup?sup.id:null,items:$("#dvItems").value.trim(),chilled,frozen,noTemp,
    packaging:DV.packaging,order:DV.order,outcome,note,by:S.me};
  if(await save(()=>C("deliveries").add(v))){resetDelivery();toast(`${supplier}: delivery ${outcome}`)}
}
function renderDeliveries(){
  const box=$("#dvList");if(!box)return;box.replaceChildren();const ids=[];
  renderDvSuppliers();
  const recs=[...S.deliveries].sort((a,b)=>(b.date||"").localeCompare(a.date||"")||(b.at||0)-(a.at||0));
  const rj=recs.filter(r=>r.outcome==="rejected").length;
  const p=$("#dvPill");p.textContent=`${recs.length} recorded${rj?` · ${rj} rejected`:""}`;p.className="pill "+(rj?"warn":recs.length?"ok":"");
  if(!recs.length)box.append(el("div",{class:"empty glass",text:"No deliveries recorded yet. Check each one as it arrives, then Accept or Reject it above."}));
  let cur=null,grp=null;
  for(const r of recs.slice(0,200)){
    if(r.date!==cur){cur=r.date;grp=el("div",{class:"list glass"});box.append(el("div",{class:"label",text:r.date===today()?"Today":longDate(r.date)}),grp)}
    ids.push(r.by);
    const temps=[r.chilled!=null?`chilled ${r.chilled}°C`:"",r.frozen!=null?`frozen ${r.frozen}°C`:"",r.noTemp?"no chilled or frozen":""].filter(Boolean).join(", ");
    let del=null;if(!ro()){del=el("button",{class:"btn ghost sm danger",type:"button"},"Remove record");armDelete(del,"Remove record",()=>save(()=>D("deliveries",r.id).delete()))}
    grp.append(xrow("d"+r.id,{
      title:r.supplier,sub:[r.at?time(r.at):"",r.items,temps].filter(Boolean).join(" · "),
      right:[el("span",{class:"pill "+(r.outcome==="rejected"?"bad":"ok"),text:r.outcome==="rejected"?"Rejected":"Accepted"})],
      details:[xfacts([["Delivered",r.items],["Chilled",r.chilled!=null?dlvTempState("chilled",r.chilled).text:""],["Frozen",r.frozen!=null?dlvTempState("frozen",r.frozen).text:""],
        ["Temperatures",r.noTemp?"No chilled or frozen food":""],["Packaging",r.packaging==="ok"?"Not damaged":"Damaged"],["Order",r.order==="ok"?"What we ordered":"Not what we ordered"],
        [r.outcome==="rejected"?"Why rejected":"Note",r.note],["Checked by",nameOf(r.by)+(r.at?", "+when(r.at):"")]]),del?el("div",{class:"row"},del):null]}));
  }
  $("#dvFormPanel").hidden=ro();
  resolveNames(ids);
}

/* ---------- the team (everyone with an account) ---------- */
S.team=[];
let teamLoading=null;
// Refreshed when the diary opens and whenever Maintenance or Staff training is opened, so new accounts show up.
function loadTeam(){
  if(!S.user||!S.user.team||teamLoading)return teamLoading;
  teamLoading=S.user.team().then(t=>{teamLoading=null;if(Array.isArray(t)){S.team=t;renderMaint();renderStaff()}},()=>{teamLoading=null});
  return teamLoading;
}
const ROLE_NAME={staff:"Staff",manager:"Manager",admin:"Admin"};

/* ---------- maintenance ----------
   Equipment problems and general jobs, per site. All sites shows every site's open and finished jobs together. */
const MT_PRI=[["urgent","Urgent","Unsafe, or stops us working","bad"],["soon","Soon","Needs doing this week","warn"],["later","When possible","Not holding anything up",""]];
const mtPri=k=>MT_PRI.find(p=>p[0]===k)||MT_PRI[1];
let editMt=null,maintAll=false;
function maintForm(){
  const pr=$("#mPri");pr.replaceChildren();
  for(const[k,l,h]of MT_PRI)pr.append(el("button",{type:"button",role:"radio","data-pri":k,onclick:()=>setMtPri(k)},el("b",{text:l}),el("span",{text:h})));
  $("#mSave").addEventListener("click",saveMaint);
  $("#mWho").dataset.v="";
  armDelete($("#mDelete"),"Remove job",async()=>{if(await save(()=>D("maintenance",editMt).delete())){editMaint(null);toast("Job removed")}});
  for(const b of document.querySelectorAll("#mScope button"))b.addEventListener("click",()=>{maintAll=b.dataset.scope==="all";renderMaint()});
  editMaint(null);
}
// "Assigned to": one tap on a name (everyone with an account), or Not assigned. Stored as their record id and name.
function renderMtWho(){
  const box=$("#mWho");if(!box)return;const cur=box.dataset.v||"";box.replaceChildren();
  const people=[...S.team];if(cur&&!people.some(p=>p.id===cur))people.push({id:cur,name:box.dataset.name||nameOf(cur)});
  for(const[id,label]of[["","Not assigned"],...people.map(p=>[p.id,p.id===S.me?`${p.name} (you)`:p.name])])
    box.append(el("button",{type:"button",role:"radio","aria-checked":String(cur===id),class:cur===id?"on":"",onclick:()=>{box.dataset.v=id;box.dataset.name=label.replace(/ \(you\)$/,"");renderMtWho()}},label));
}
function setMtPri(k){for(const b of document.querySelectorAll("#mPri button")){const on=b.dataset.pri===k;b.classList.toggle("on",on);b.setAttribute("aria-checked",String(on))}$("#mPri").dataset.v=k}
function editMaint(m){
  editMt=m?m.id:null;
  $("#mFormTitle").textContent=m?"Edit "+m.title:"Report a maintenance job";
  $("#mTitle").value=m?m.title:"";$("#mArea").value=m?(m.area||""):"";$("#mDetails").value=m?(m.details||""):"";
  setMtPri(m?m.priority:"soon");$("#mDelete").hidden=!m;$("#mMsg").textContent="";
  $("#mWho").dataset.v=m&&m.assignee||"";$("#mWho").dataset.name=m&&m.assigneeName||"";renderMtWho();
  setForm("maintenance",!!m);
}
async function saveMaint(){
  const title=$("#mTitle").value.trim();if(!title){$("#mMsg").textContent="Say what needs doing first.";return}
  const who=$("#mWho").dataset.v||"";
  const v={title,area:$("#mArea").value.trim(),details:$("#mDetails").value.trim(),priority:$("#mPri").dataset.v||"soon",
    assignee:who||null,assigneeName:who?($("#mWho").dataset.name||nameOf(who)):null,at:Date.now()};
  const ok=editMt?await save(()=>D("maintenance",editMt).update(v)):await save(()=>C("maintenance").add({...v,status:"open",reportedBy:S.me,reportedAt:Date.now(),log:[]}));
  if(ok){toast(`${editMt?"Saved":"Reported"}: ${title}`);editMaint(null)}
}
// Change who a job is assigned to straight from the list.
async function assignMaint(m,site,id){
  const p=S.team.find(x=>x.id===id),name=id?(p?p.name:nameOf(id)):null;
  const log=[{at:Date.now(),by:S.me,what:id?`Assigned to ${name}`:"Unassigned",note:""},...(m.log||[])].slice(0,30);
  if(await save(()=>D("maintenance",m.id,site).update({assignee:id||null,assigneeName:name,log})))toast(id?`${m.title}: assigned to ${id===S.me?"you":name}`:`${m.title}: not assigned`);
}
async function setMaintDone(m,site,done,note){
  const log=[{at:Date.now(),by:S.me,what:done?"Done":"Reopened",note:note||""},...(m.log||[])].slice(0,30);
  const v=done?{status:"done",doneBy:S.me,doneAt:Date.now(),fixNote:note||"",log}:{status:"open",doneBy:null,doneAt:null,log};
  if(await save(()=>D("maintenance",m.id,site).update(v)))toast(`${m.title}: ${done?"done":"reopened"}${site!==S.site?" at the "+siteOf(site).name:""}`);
}
function renderMaint(){
  const box=$("#mList");if(!box)return;box.replaceChildren();const ids=[],R=ro();
  for(const b of document.querySelectorAll("#mScope button"))b.setAttribute("aria-pressed",String((b.dataset.scope==="all")===maintAll));
  const items=maintAll?SITES.flatMap(x=>(x.id===S.site?S.maintenance:(S.sum[x.id]&&S.sum[x.id].maintenance)||[]).map(m=>({m,site:x.id})))
    :S.maintenance.map(m=>({m,site:S.site}));
  const rank={urgent:0,soon:1,later:2};
  const open=items.filter(x=>x.m.status!=="done").sort((a,b)=>(rank[a.m.priority]??1)-(rank[b.m.priority]??1)||(a.m.reportedAt||0)-(b.m.reportedAt||0));
  const done=items.filter(x=>x.m.status==="done").sort((a,b)=>(b.m.doneAt||0)-(a.m.doneAt||0)).slice(0,30);
  const row=({m,site})=>{
    ids.push(m.reportedBy,m.doneBy);const pr=mtPri(m.priority),isDone=m.status==="done";
    const note=el("input",{type:"text",placeholder:"What was done (optional)","aria-label":"What was done for "+m.title});
    const hist=(m.log||[]).slice(0,5).map(e=>{ids.push(e.by);return el("li",{},el("span",{text:when(e.at)}),el("span",{class:"s",text:`${e.what} · ${nameOf(e.by)}${e.note?" · "+e.note:""}`}))});
    return xrow("m"+site+m.id,{
      title:m.title,
      sub:[maintAll?siteOf(site).name:"",m.area,!isDone&&m.assignee?`→ ${m.assignee===S.me?"you":m.assigneeName||nameOf(m.assignee)}`:"",isDone?`done ${short(iso(new Date(m.doneAt)))}, ${nameOf(m.doneBy)}`:`reported ${short(iso(new Date(m.reportedAt||m.at||Date.now())))}, ${nameOf(m.reportedBy)}`].filter(Boolean).join(" · "),
      right:[el("span",{class:"pill "+(isDone?"ok":pr[3]),text:isDone?"Done":pr[1]})],
      details:[m.details?el("p",{class:"how",text:m.details}):null,
        isDone&&m.fixNote?xfacts([["What was done",m.fixNote]]):null,
        !isDone?(R?xfacts([["Assigned to",m.assignee?m.assigneeName||nameOf(m.assignee):"Not assigned"]]):(()=>{
          const sel=el("select",{"aria-label":"Assigned to, for "+m.title});
          const people=[...S.team];if(m.assignee&&!people.some(p=>p.id===m.assignee))people.push({id:m.assignee,name:m.assigneeName||nameOf(m.assignee)});
          sel.append(el("option",{value:""},"Not assigned"),...people.map(p=>el("option",{value:p.id},p.id===S.me?`${p.name} (you)`:p.name)));
          sel.value=m.assignee||"";sel.addEventListener("change",()=>assignMaint(m,site,sel.value));
          const meBtn=m.assignee===S.me?null:el("button",{class:"btn ghost sm",type:"button",onclick:()=>assignMaint(m,site,S.me)},"Assign to me");
          return el("div",{class:"row assign"},el("span",{class:"label",text:"Assigned to"}),sel,meBtn);
        })()):null,
        R?null:isDone?el("div",{class:"row"},el("button",{class:"btn ghost sm",type:"button",onclick:()=>setMaintDone(m,site,false)},"Reopen"))
          :el("div",{class:"row"},note,el("button",{class:"btn sm",type:"button",onclick:()=>setMaintDone(m,site,true,note.value.trim())},"Mark as done")),
        hist.length?el("ul",{class:"hist"},...hist):null,
        R||site!==S.site?null:el("div",{class:"row"},el("button",{class:"btn ghost sm",type:"button",onclick:()=>editMaint(m)},"Edit job"))]});
  };
  if(!items.length)box.append(el("div",{class:"empty glass",text:maintAll?"Nothing reported at any site.":`Nothing reported at the ${curSite().name}.${R?"":" Tap Report a job when something needs fixing."}`}));
  if(open.length)box.append(el("div",{class:"label"+(open.some(x=>x.m.priority==="urgent")?" bad":""),text:`Open · ${open.length}`}),el("div",{class:"list glass"},...open.map(row)));
  if(done.length)box.append(el("div",{class:"label",text:`Done · ${done.length}`}),el("div",{class:"list glass"},...done.map(row)));
  $("#mFormPanel").hidden=R||!formOpen.maintenance;
  renderMtWho();
  resolveNames(ids.filter(Boolean));
}

/* ---------- suppliers ---------- */
const SUP_FIELDS=[["name","Supplier name","text","e.g. Green Valley Dairy"],["supplies","What they supply","text","e.g. Milk, cream, butter"],["contact","Contact name","text",""],["phone","Phone","tel",""],["email","Email","email",""],["address","Address","text",""],["rating","Food hygiene rating","text","e.g. 5 (checked Oct 2026)"],["notes","Notes","text","e.g. Delivers Tue & Fri, order by 2pm"]];
let editSup=null;
function supForm(){
  const box=$("#sForm");const f=el("div",{class:"fields"});
  for(const[k,lbl,type,ph]of SUP_FIELDS)f.append(el("div",{class:"field"+(k==="address"||k==="notes"?" wide":"")},el("label",{class:"label",for:"s_"+k,text:lbl}),el("input",{type,id:"s_"+k,placeholder:ph})));
  const msg=el("span",{class:"by"});
  const cancel=el("button",{class:"btn ghost",hidden:true,onclick:()=>editSupplier(null)},"Cancel edit");
  const del=el("button",{class:"btn ghost danger",hidden:true},"Remove supplier");
  armDelete(del,"Remove supplier",async()=>{if(await save(()=>D("suppliers",editSup).delete())){editSupplier(null);toast("Supplier removed")}});
  const saveBtn=el("button",{class:"btn",onclick:async()=>{
    const v={};for(const[k]of SUP_FIELDS)v[k]=$("#s_"+k).value.trim();
    if(!v.name){msg.textContent="Add the supplier's name first.";return}
    v.by=S.me;v.at=Date.now();
    const r=await multiSave("suppliers",pick.get(),v,{editId:editSup,old:editSup?S.suppliers.find(x=>x.id===editSup):null});
    if(r){msg.textContent="";toast(`Saved ${v.name}${r.where}.${r.warn}`);editSupplier(null)}
  }},"Save supplier");
  const pick=sitePicker("s_sites");
  box.append(f,pick.el,el("div",{class:"row"},saveBtn,cancel,del,msg));box._cancel=cancel;box._del=del;box._pick=pick;
}
function editSupplier(s){
  editSup=s?s.id:null;$("#sFormTitle").textContent=s?"Edit "+s.name:"Add a supplier";
  for(const[k]of SUP_FIELDS)$("#s_"+k).value=s?(s[k]||""):"";
  $("#sForm")._cancel.hidden=true;$("#sForm")._del.hidden=!s;$("#sForm")._pick.set(s&&s.sites);
  setForm("suppliers",!!s);
}
function renderSuppliers(){
  const box=$("#sList");box.replaceChildren();
  const list=[...S.suppliers].sort((a,b)=>a.name.localeCompare(b.name));
  if(!list.length)box.append(el("div",{class:"empty",text:"No suppliers yet. Add your milk, coffee, bakery and any other food or drink suppliers."}));
  for(const s of list)box.append(xrow("s"+s.id,{
    lead:el("span",{class:"avatar sm",text:initials(s.name)}),title:s.name,sub:s.supplies||s.contact||"",
    right:[callBtn(s.phone,"Call "+s.name)],
    details:[xfacts([["Contact",s.contact],["Phone",s.phone?telLink(s.phone):""],["Email",s.email?el("a",{href:"mailto:"+s.email,text:s.email}):""],["Address",s.address],["Hygiene rating",s.rating],["Notes",s.notes]]),
      mro()?null:el("div",{class:"row"},el("button",{class:"btn ghost sm",type:"button",onclick:()=>editSupplier(s)},"Edit supplier"))]}));
  $("#sFormPanel").hidden=mro()||!formOpen.suppliers;
}

/* ---------- HACCP plans & risk assessments ---------- */
const PL_COLS={
  haccp:[["step","Process step","w-s"],["hazard","Hazard","w-m"],["hazardType","Type","sel"],["control","Control measure","w-l"],["ccp","CCP","chk"],["criticalLimit","Critical limit","w-m"],["monitoring","Monitoring","w-m"],["correctiveAction","Corrective action","w-l"],["verification","Verification","w-m"],["records","Records","w-s"]],
  risk:[["hazard","Hazard","w-m"],["whoHarmed","Who might be harmed","w-s"],["existingControls","Existing controls","w-l"],["likelihood","Likelihood","num"],["severity","Severity","num"],["_rate","Risk","rate"],["furtherAction","Further action needed","w-l"],["actionBy","By whom","w-s"],["dueDate","Due","date"],["done","Done","chk"]]};
const PL_META={
  haccp:[["scope","Scope (products and processes covered)","text"],["preparedBy","Prepared by","text"],["date","Date written","date"],["reviewDate","Next review","date"]],
  risk:[["area","Area or activity","text"],["assessor","Assessor","text"],["date","Date assessed","date"],["reviewDate","Next review","date"]]};
const HAZ_TYPES=["","Biological","Chemical","Physical","Allergen"];
const PL_NAME={haccp:"HACCP plan",risk:"Risk assessment"};
const rowsKey=k=>k==="haccp"?"steps":"rows";
const clone=x=>{const c=JSON.parse(JSON.stringify(x||{}));delete c.id;return c};
function blankRow(k){return k==="haccp"?{step:"",hazard:"",hazardType:"",control:"",ccp:false,criticalLimit:"",monitoring:"",correctiveAction:"",verification:"",records:""}
  :{hazard:"",whoHarmed:"",existingControls:"",likelihood:0,severity:0,furtherAction:"",actionBy:"",dueDate:"",done:false}}
// The risk scoring used on risk assessments: each scale 1–5, Risk = likelihood × severity, then three colour bands.
const RISK_L=[["Rare","Hard to imagine it happening"],["Unlikely","Could happen, but not expected"],["Possible","Could happen now and then"],["Likely","Will probably happen at some point"],["Almost certain","Expected to happen, often"]];
const RISK_S=[["Negligible","No injury or illness"],["Minor","First aid, or a mild short illness"],["Moderate","Needs medical treatment or time off work"],["Major","Serious injury or illness, hospital"],["Severe","Fatal or life-changing"]];
const RISK_BANDS=[["ok","Low","1–4","Acceptable: keep the existing controls in place"],["warn","Medium","5–12","Reduce the risk where you reasonably can, and review it"],["bad","High","15–25","Act now: don't carry on until the risk is reduced"]];
const riskBand=v=>!v?null:RISK_BANDS[v<=4?0:v<=12?1:2];
function riskKeyEl(){
  const scale=(title,list)=>el("div",{class:"rk-scale"},el("h3",{text:title}),el("ol",{},...list.map(([n,d],i)=>el("li",{},el("span",{class:"rk-n",text:String(i+1)}),el("span",{},el("b",{text:n}),el("span",{class:"s",text:" · "+d}))))));
  const grid=el("table",{class:"rk-grid","aria-label":"Risk scores: likelihood down, severity across"},
    el("thead",{},el("tr",{},el("th",{class:"rk-corner",text:"L × S"}),...[1,2,3,4,5].map(s=>el("th",{scope:"col",title:RISK_S[s-1][0],text:String(s)})))),
    el("tbody",{},...[5,4,3,2,1].map(l=>el("tr",{},el("th",{scope:"row",title:RISK_L[l-1][0],text:String(l)}),...[1,2,3,4,5].map(s=>{const v=l*s;return el("td",{class:"rate "+riskBand(v)[0],title:`${RISK_L[l-1][0]} × ${RISK_S[s-1][0]} = ${v} ${riskBand(v)[1]}`,text:String(v)})})))));
  return el("div",{class:"riskkey"},
    el("p",{class:"rk-formula"},el("b",{text:"Risk = likelihood × severity"}),el("span",{class:"s",text:" · score each from 1 to 5, then multiply"})),
    el("div",{class:"rk-scales"},scale("Likelihood",RISK_L),scale("Severity",RISK_S)),
    el("div",{class:"rk-bottom"},
      el("div",{class:"rk-bands"},...RISK_BANDS.map(([c,l,r,a])=>el("div",{class:"rk-band"},el("span",{class:"rate "+c,text:`${r} ${l}`}),el("span",{class:"s",text:a})))),
      el("div",{class:"rk-gridwrap"},el("div",{class:"s rk-axis",text:"Likelihood ↓  Severity →"}),grid)));
}
function riskOf(r){const v=(Number(r.likelihood)||0)*(Number(r.severity)||0);return{v,cls:!v?"":v<=4?"ok":v<=12?"warn":"bad",text:!v?"–":`${v} ${v<=4?"Low":v<=12?"Medium":"High"}`}}
function reviewState(d){
  if(!d.reviewDate)return{cls:"",text:"No review date",overdue:false};
  const left=Math.round((parse(d.reviewDate)-parse(today()))/864e5);
  if(left<0)return{cls:"bad",text:"Review overdue",overdue:true};
  if(left<=14)return{cls:"warn",text:"Review due "+short(d.reviewDate),overdue:false};
  return{cls:"ok",text:"Review "+short(d.reviewDate),overdue:false};
}

/* extraction */
async function newPlan(k){
  if(mro())return;
  const now=Date.now();
  const steps=["Purchasing & delivery","Chilled storage","Dry storage","Preparation","Cooking & reheating","Hot holding","Chilled display","Service","Cleaning"];
  const d={type:k,title:k==="haccp"?"HACCP plan":"Risk assessment",notes:"",source:"",createdBy:S.me,createdAt:now,updatedBy:S.me,updatedAt:now,history:[{by:S.me,at:now,what:"Created from template"}]};
  for(const[f]of PL_META[k])d[f]="";
  d.date=today();
  d[rowsKey(k)]=k==="haccp"?steps.map(s=>({...blankRow(k),step:s})):[blankRow(k),blankRow(k),blankRow(k)];
  try{const ref=await C("plans").add(d);openPlan(ref.id,d)}catch(e){fail(e)}
}
function renderPlansList(){
  const box=$("#plList");box.replaceChildren();const ids=[];
  const list=[...S.plans].sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));
  if(!list.length)box.append(el("div",{class:"empty",text:`No HACCP plans or risk assessments yet.${mro()?"":" Tap Add to start one from a template."}`}));
  for(const d of list){
    const rows=d[rowsKey(d.type)]||[];ids.push(d.updatedBy);
    const summary=d.type==="haccp"
      ?`${rows.length} step${rows.length===1?"":"s"} · ${rows.filter(r=>r.ccp).length} CCP${rows.filter(r=>r.ccp).length===1?"":"s"}`
      :`${rows.length} hazard${rows.length===1?"":"s"} · ${rows.filter(r=>riskOf(r).cls==="bad").length} high risk`;
    const rs=reviewState(d);
    box.append(el("button",{class:"lrow",type:"button",onclick:()=>openPlan(d.id)},el("span",{class:"tile "+(d.type==="haccp"?"purple":"orange")},svgi(ICON.plans)),
      el("span",{class:"t"},el("b",{text:d.title||PL_NAME[d.type]}),el("span",{class:"s",text:`${PL_NAME[d.type]} · ${summary} · updated ${when(d.updatedAt)}, ${nameOf(d.updatedBy)}`})),
      el("span",{class:"pill "+rs.cls,text:rs.text}),el("span",{class:"chev"},svgi(ICON.chevR))));
  }
  renderAddBtn();resolveNames(ids);
}
function openPlan(id,data){
  const p=data||S.plans.find(x=>x.id===id);if(!p)return;
  S.plan={id,doc:clone(p),baseAt:p.updatedAt,dirty:false,remote:false};
  $("#planListView").hidden=true;$("#planEditView").hidden=false;
  renderEditor();window.scrollTo({top:0});renderAddBtn();
}
function closePlan(){S.plan=null;$("#planEditView").hidden=true;$("#planEditView").replaceChildren();$("#planListView").hidden=false;renderPlansList()}
function grow(ta){ta.style.height="auto";ta.style.height=ta.scrollHeight+2+"px"}
function markDirty(){if(S.plan&&!S.plan.dirty){S.plan.dirty=true;updateSaveBar()}}
function updateSaveBar(){
  const P=S.plan;if(!P)return;
  const st=$("#plSaveState"),btn=$("#plSaveBtn"),back=$("#plBack");
  if(st){st.textContent=P.dirty?"Unsaved changes":`Saved ${when(P.doc.updatedAt)}`;st.className="pill "+(P.dirty?"warn":"ok")}
  if(btn)btn.disabled=!P.dirty||mro();
  if(back&&back.dataset.armed!=="1")back.textContent="← All documents";
  const rb=$("#plRemote");if(rb)rb.hidden=!P.remote;
}
function renderEditor(){
  const P=S.plan,d=P.doc,k=d.type,R=mro(),box=$("#planEditView");
  const rk=rowsKey(k);d[rk]=d[rk]||[];
  const back=el("button",{class:"btn ghost sm",id:"plBack"},"← All documents");
  back.addEventListener("click",()=>{
    if(!P.dirty)return closePlan();
    if(back.dataset.armed!=="1"){back.dataset.armed="1";back.textContent="Discard unsaved changes?";setTimeout(()=>{back.dataset.armed="";updateSaveBar()},3500);return}
    closePlan();
  });
  const remote=el("div",{class:"banner",id:"plRemote",hidden:!P.remote},
    el("span",{text:"Someone else saved this document while you were editing. Saving now will replace their changes. "}),
    el("button",{class:"linkbtn",onclick:()=>{const p=S.plans.find(x=>x.id===P.id);if(p){S.plan={id:P.id,doc:clone(p),baseAt:p.updatedAt,dirty:false,remote:false};renderEditor()}}},"Load their version"));
  // header
  const title=el("input",{type:"text",class:"title-in",id:"pl_title",value:d.title||"","aria-label":"Title",disabled:R});
  title.addEventListener("input",()=>{d.title=title.value;markDirty()});
  const meta=el("div",{class:"fields"});
  for(const[f,lbl,t]of PL_META[k]){
    const id="pl_"+f;const inp=el("input",{type:t==="date"?"date":"text",id,value:d[f]||"",disabled:R});
    inp.addEventListener("input",()=>{d[f]=inp.value;markDirty()});
    meta.append(el("div",{class:"field"+(f==="scope"||f==="area"?" wide":"")},el("label",{class:"label",for:id,text:lbl}),inp));
  }
  // table
  const cols=PL_COLS[k];
  const tbody=el("tbody");
  const buildRows=()=>{
    tbody.replaceChildren();
    d[rk].forEach((r,i)=>{
      const tr=el("tr",{class:r.ccp?"ccp":""});let rateSpan=null;
      for(const[f,lbl,t]of cols){
        const td=el("td",{class:t.startsWith("w-")?t:"w-x"});
        const aria=`${lbl}, row ${i+1}`;
        if(t.startsWith("w-")){
          const ta=el("textarea",{class:"cell",rows:1,value:r[f]||"","aria-label":aria,disabled:R});
          ta.addEventListener("input",()=>{r[f]=ta.value;grow(ta);markDirty()});
          td.append(ta);
        }else if(t==="sel"){
          const s=el("select",{"aria-label":aria,disabled:R});for(const h of HAZ_TYPES)s.append(el("option",{value:h},h||"–"));s.value=r[f]||"";
          s.addEventListener("change",()=>{r[f]=s.value;markDirty()});td.append(s);
        }else if(t==="chk"){
          td.className="ctr";const cb=el("input",{type:"checkbox","aria-label":aria,disabled:R});cb.checked=!!r[f];
          cb.addEventListener("change",()=>{r[f]=cb.checked;if(f==="ccp")tr.classList.toggle("ccp",cb.checked);markDirty()});td.append(cb);
        }else if(t==="num"){
          const lab=f==="likelihood"?RISK_L:RISK_S;
          const s=el("select",{"aria-label":aria,disabled:R});for(let n=0;n<=5;n++)s.append(el("option",{value:String(n)},n?`${n} ${lab[n-1][0]}`:"–"));s.value=String(r[f]||0);
          s.addEventListener("change",()=>{r[f]=Number(s.value);const q=riskOf(r);rateSpan.textContent=q.text;rateSpan.className="rate "+q.cls;markDirty()});td.append(s);
        }else if(t==="rate"){
          td.className="ctr";const q=riskOf(r);rateSpan=el("span",{class:"rate "+q.cls,text:q.text});td.append(rateSpan);
        }else if(t==="date"){
          const inp=el("input",{type:"date",value:r[f]||"","aria-label":aria,disabled:R});
          inp.addEventListener("input",()=>{r[f]=inp.value;markDirty()});td.append(inp);
        }
        tr.append(td);
      }
      if(!R){
        const add=el("button",{type:"button","aria-label":`Add a row below row ${i+1}`,title:"Add a row below",onclick:()=>{d[rk].splice(i+1,0,k==="haccp"?{...blankRow(k),step:r.step}:blankRow(k));markDirty();buildRows()}},"+");
        const del=el("button",{type:"button","aria-label":`Delete row ${i+1}`,title:"Delete row"},"✕");
        del.addEventListener("click",()=>{
          if(!del.classList.contains("armed")){del.classList.add("armed");del.textContent="Delete?";setTimeout(()=>{del.classList.remove("armed");del.textContent="✕"},3000);return}
          d[rk].splice(i,1);markDirty();buildRows();
        });
        tr.append(el("td",{},el("div",{class:"rowact"},add,del)));
      }
      tbody.append(tr);
    });
    if(!d[rk].length)tbody.append(el("tr",{},el("td",{colspan:cols.length+1,class:"by",text:"No rows yet."})));
    requestAnimationFrame(()=>tbody.querySelectorAll("textarea.cell").forEach(grow));
  };
  buildRows();
  const table=el("table",{class:"doc-table"},el("thead",{},el("tr",{},...cols.map(([,l,t])=>el("th",{class:t.startsWith("w-")?t:"",text:l})),R?null:el("th",{}))),tbody);
  const notes=el("textarea",{id:"pl_notes",value:d.notes||"",disabled:R,style:"min-height:110px"});
  notes.addEventListener("input",()=>{d.notes=notes.value;markDirty()});
  const legend=k==="haccp"
    ?"Rows ticked as CCP are critical control points and are highlighted. Click any cell to edit it, then save."
    :null;
  const del=el("button",{class:"btn ghost danger",hidden:R},"Delete document");
  armDelete(del,"Delete document",async()=>{if(await save(()=>D("plans",P.id).delete())){closePlan();toast("Document deleted")}});
  const hist=(d.history||[]).slice(0,10);
  const pick=sitePicker("pl_sites");pick.set(d.sites);pick.onChange=()=>{d.sites=pick.get();markDirty()};P.pick=pick;
  box.replaceChildren(
    el("div",{class:"row spread"},back,el("div",{class:"row",style:"gap:8px"},el("span",{class:"pill",text:PL_NAME[k]}),(()=>{const rs=reviewState(d);return el("span",{class:"pill "+rs.cls,text:rs.text})})())),
    remote,
    el("section",{class:"panel"},title,d.source?el("div",{class:"by",text:"Converted from "+d.source}):null,meta),
    el("section",{class:"panel"},
      el("div",{class:"row spread"},el("h2",{text:k==="haccp"?"Hazards and controls":"Hazards and actions"}),R?null:el("button",{class:"btn ghost sm",onclick:()=>{d[rk].push(blankRow(k));markDirty();buildRows()}},"Add row")),
      legend?el("p",{class:"note",text:legend}):riskKeyEl(),
      el("div",{class:"scroll"},table)),
    el("section",{class:"panel"},el("label",{class:"label",for:"pl_notes",text:"Notes"}),notes),
    R?null:el("section",{class:"panel"},pick.el),
    el("section",{class:"panel"},el("h3",{text:"History"}),
      hist.length?el("div",{},...hist.map(h=>el("div",{class:"by",text:`${when(h.at)} · ${h.what} · ${nameOf(h.by)}`}))):el("div",{class:"by",text:"No history yet."})),
    R?el("div",{class:"note",text:"You can view this document but not edit it."})
     :el("div",{class:"savebar"},el("span",{class:"pill",id:"plSaveState"}),el("div",{class:"row",style:"gap:8px"},del,el("button",{class:"btn",id:"plSaveBtn",onclick:savePlan},"Save changes"))));
  updateSaveBar();
  resolveNames([...hist.map(h=>h.by)]);
}
async function savePlan(){
  const P=S.plan;if(!P||!P.dirty||mro())return;
  const d=P.doc,now=Date.now();
  d.updatedBy=S.me;d.updatedAt=now;
  d.history=[{by:S.me,at:now,what:"Edited"},...(d.history||[])].slice(0,20);
  d.linkId=d.linkId||newLinkId();d.sites=P.pick?P.pick.get():[S.site];
  const body=clone(d);
  if(JSON.stringify(body).length>250000){toast("This document is too large to save. Split it into two documents.");return}
  P.baseAt=now;
  const r=await multiSave("plans",d.sites,body,{editId:P.id,old:S.plans.find(x=>x.id===P.id),match:false});
  if(r){P.dirty=false;P.remote=false;updateSaveBar();toast(`Saved${r.where}.${r.warn}`)}
}
function onPlansSnapshot(){
  renderPlansList();
  const P=S.plan;if(!P)return;
  const p=S.plans.find(x=>x.id===P.id);
  if(!p){if(!P.dirty){closePlan();toast("That document was deleted.")}return}
  if(p.updatedAt!==P.baseAt){
    if(!P.dirty){S.plan={id:P.id,doc:clone(p),baseAt:p.updatedAt,dirty:false,remote:false};renderEditor()}
    else{P.remote=true;updateSaveBar()}
  }
}
window.addEventListener("beforeunload",e=>{if(S.plan&&S.plan.dirty){e.preventDefault();e.returnValue=""}});

/* ---------- EHO inspections ---------- */
const EHO_AREAS=["Hygienic food handling","Cleanliness and structure","Management of food safety","Allergens","Other"];
const EHO_PRI=[["must","Must do","bad"],["should","Should do","warn"],["advice","Advice","ok"]];
const priOf=k=>EHO_PRI.find(p=>p[0]===k)||EHO_PRI[1];
const ratingCls=r=>r==null||r===""?"":r>=4?"ok":r===3?"warn":"bad";
const longDate=s=>s?parse(s).toLocaleDateString("en-GB",{weekday:"long",day:"numeric",month:"long",year:"numeric"}):"";
const newIssueId=()=>"i"+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
const inspSorted=()=>[...S.inspections].sort((a,b)=>(b.inspectionDate||"").localeCompare(a.inspectionDate||"")||(b.createdAt||0)-(a.createdAt||0));
function deadlineState(i){
  if(i.done||!i.deadline)return null;
  const left=Math.round((parse(i.deadline)-parse(today()))/864e5);
  if(left<0)return{cls:"bad",text:"Overdue since "+short(i.deadline)};
  if(left<=7)return{cls:"warn",text:"Due "+short(i.deadline)};
  return{cls:"",text:"Due "+short(i.deadline)};
}
async function tickIssue(inspId,issueId,patch){
  if(mro())return;
  const cur=S.inspections.find(x=>x.id===inspId);if(!cur)return;
  const issues=(cur.issues||[]).map(i=>i.id===issueId?{...i,...patch}:i);
  await save(()=>D("inspections",inspId).update({issues,updatedBy:S.me,updatedAt:Date.now()}));
}
function inspHero(d,big){
  const n=(d.issues||[]).length,fixed=(d.issues||[]).filter(i=>i.done).length;
  const ago=d.inspectionDate?Math.round((parse(today())-parse(d.inspectionDate))/864e5):null;
  const rc=ratingCls(d.rating);
  const sec=el("section",{class:"panel"});
  sec.append(el("div",{class:"hero"},
    el("div",{style:"display:grid;gap:6px;min-width:0"},
      el("div",{class:"label",text:big?`${curSite().name}: last EHO inspection`:"Inspection date"}),
      el("div",{class:"bigdate",text:d.inspectionDate?longDate(d.inspectionDate):"Date not recorded"}),
      el("div",{class:"metaline",style:"display:flex;flex-wrap:wrap;gap:4px 14px;font-size:13px;color:var(--muted)"},
        ...[ago!=null?(ago===0?"Today":ago>0?`${ago} day${ago===1?"":"s"} ago`:`in ${-ago} days`):"",d.visitType,d.inspector?"Inspector: "+d.inspector:"",d.authority].filter(Boolean).map(t=>el("span",{text:t})))),
    el("div",{class:"ratingbadge "+rc,title:"Food hygiene rating"},el("b",{text:d.rating==null?"–":String(d.rating)}),el("span",{text:"Hygiene rating"}))));
  const sc=d.scores||{};
  if(sc.hygiene||sc.structure||sc.management)sec.append(el("div",{class:"scores"},
    ...[["Food handling",sc.hygiene],["Cleanliness & structure",sc.structure],["Management",sc.management]].filter(x=>x[1]).map(([l,v])=>el("div",{},el("span",{class:"by",text:l}),el("b",{text:v})))));
  if(d.revisitDate)sec.append(el("div",{class:"chips"},el("span",{class:"pill "+(d.revisitDate>=today()?"warn":""),text:"Revisit: "+longDate(d.revisitDate)})));
  if(d.summary)sec.append(el("p",{class:"note",style:"font-size:14px;color:var(--fg)",text:d.summary}));
  if(n){
    sec.append(el("div",{style:"display:grid;gap:6px"},
      el("div",{class:"row spread"},el("strong",{text:`${fixed} of ${n} issue${n===1?"":"s"} addressed`}),el("span",{class:"pill "+(fixed===n?"ok":(d.issues.some(i=>!i.done&&i.priority==="must")?"bad":"warn")),text:fixed===n?"All done":`${n-fixed} still to do`})),
      el("div",{class:"progress",role:"progressbar","aria-valuemin":"0","aria-valuemax":String(n),"aria-valuenow":String(fixed)},el("i",{style:`width:${Math.round(100*fixed/n)}%`}))));
  }
  return sec;
}
function issueList(d){
  const box=el("div",{});const R=mro();const ids=[];
  const order={must:0,should:1,advice:2};
  const list=[...(d.issues||[])].sort((a,b)=>(a.done-b.done)||(order[a.priority]-order[b.priority])||(a.deadline||"9").localeCompare(b.deadline||"9"));
  if(!list.length)box.append(el("div",{class:"empty",text:"No issues recorded for this inspection."}));
  for(const i of list){
    const id="iss_"+d.id+"_"+i.id;if(i.doneBy)ids.push(i.doneBy);
    const cb=el("input",{type:"checkbox",id,disabled:R,"aria-label":"Addressed: "+i.issue});cb.checked=!!i.done;
    cb.addEventListener("change",async()=>{
      await tickIssue(d.id,i.id,cb.checked?{done:true,doneBy:S.me,doneAt:Date.now()}:{done:false,doneBy:null,doneAt:null});
      if(cb.checked)toast("Marked as addressed");
    });
    const p=priOf(i.priority);const dl=deadlineState(i);
    const body=el("div",{class:"body"},
      el("label",{for:id,class:"itext",text:i.issue||i.action}),
      i.action&&i.issue?el("div",{text:"Action: "+i.action}):null,
      el("div",{class:"chips"},el("span",{class:"pill "+p[2],text:p[1]}),el("span",{class:"pill",text:i.area}),dl?el("span",{class:"pill "+dl.cls,text:dl.text}):null,i.ref?el("span",{class:"by",text:i.ref}):null),
      i.done?el("div",{class:"by",text:`Addressed by ${nameOf(i.doneBy)} on ${when(i.doneAt)}`}):null);
    if(i.done&&!R){
      const fx=el("input",{type:"text",id:"fx_"+d.id+"_"+i.id,value:i.fixNote||"",placeholder:"What did you do? (optional)","aria-label":"What was done"});
      fx.addEventListener("change",()=>tickIssue(d.id,i.id,{fixNote:fx.value.trim()}));
      body.append(el("div",{class:"fix"},fx));
    }else if(i.done&&i.fixNote)body.append(el("div",{class:"by",text:"What we did: "+i.fixNote}));
    box.append(el("div",{class:"issue"+(i.done?" done":"")},cb,body));
  }
  resolveNames(ids);
  return box;
}
function renderInspList(){
  const R=mro();const list=inspSorted();const latest=list[0];
  // header pill
  const hd=$("#ehoHead");hd.replaceChildren();
  if(latest&&latest.inspectionDate){
    const open=(latest.issues||[]).filter(i=>!i.done).length;
    hd.append(el("button",{class:"ehohead",onclick:()=>show("eho")},el("span",{text:`${curSite().name}: last EHO inspection`}),el("strong",{text:longDate(latest.inspectionDate)}),
      latest.rating!=null?el("span",{class:"pill "+ratingCls(latest.rating),text:"Rated "+latest.rating}):null,
      open?el("span",{class:"pill bad",text:`${open} issue${open===1?"":"s"} open`}):null));
  }
  if(S.insp)return;
  const box=$("#ehoLatest");box.replaceChildren();
  if(!latest){
    box.append(el("section",{class:"panel"},el("div",{class:"empty",text:`No inspection recorded for the ${curSite().name} yet. Enter the last inspection below: the date, rating, scores and anything the inspector asked you to fix.`})));
  }else{
    box.append(inspHero(latest,true));
    box.append(el("section",{class:"panel"},
      el("div",{class:"row spread"},el("h2",{text:"Issues to address"}),R?null:el("button",{class:"btn ghost sm",onclick:()=>openInsp(latest.id)},"Edit inspection")),
      el("p",{class:"note",text:"Tick each issue once it's been put right. Must-do items are legal requirements; the inspector may check them at a revisit or your next inspection."}),
      issueList(latest)));
    if(latest.goodPoints&&latest.goodPoints.length)box.append(el("section",{class:"panel"},el("h3",{text:"What the inspector said was good"}),el("ul",{style:"margin:0;padding-left:20px;display:grid;gap:4px"},...latest.goodPoints.map(g=>el("li",{text:g})))));
    if(latest.notes)box.append(el("section",{class:"panel"},el("h3",{text:"Notes"}),el("div",{class:"docview"},renderBody(latest.notes))));
  }
  const past=list.slice(1);const pb=$("#ehoPast");pb.replaceChildren();
  $("#ehoPastPanel").hidden=!past.length;
  for(const d of past){
    const n=(d.issues||[]).length,f=(d.issues||[]).filter(i=>i.done).length;
    pb.append(el("div",{class:"plan-card"},
      el("div",{},el("button",{class:"open",onclick:()=>openInsp(d.id)},d.inspectionDate?longDate(d.inspectionDate):"Date not recorded"),
        el("div",{class:"by",text:[d.visitType,d.authority,n?`${f} of ${n} issues addressed`:"No issues"].filter(Boolean).join(" · ")})),
      el("span",{class:"pill "+ratingCls(d.rating),text:d.rating==null?"No rating":"Rated "+d.rating})));
  }
  $("#ehoUploadPanel").hidden=R||!!latest;
  renderAddBtn();
}
function openInsp(id,data){
  const p=data||S.inspections.find(x=>x.id===id);if(!p)return;
  S.insp={id,doc:clone(p),baseAt:p.updatedAt,dirty:false,remote:false};
  $("#ehoListView").hidden=true;$("#ehoEditView").hidden=false;renderInspEditor();window.scrollTo({top:0});renderAddBtn();
}
function closeInsp(){S.insp=null;$("#ehoEditView").hidden=true;$("#ehoEditView").replaceChildren();$("#ehoListView").hidden=false;renderInspList()}
function ehoDirty(){if(S.insp&&!S.insp.dirty){S.insp.dirty=true;ehoSaveBar()}}
function ehoSaveBar(){
  const P=S.insp;if(!P)return;
  const st=$("#ehoSaveState"),btn=$("#ehoSaveBtn"),back=$("#ehoBack");
  if(st){st.textContent=P.dirty?"Unsaved changes":`Saved ${when(P.doc.updatedAt)}`;st.className="pill "+(P.dirty?"warn":"ok")}
  if(btn)btn.disabled=!P.dirty||mro();
  if(back&&back.dataset.armed!=="1")back.textContent="← Back";
  const rb=$("#ehoRemote");if(rb)rb.hidden=!P.remote;
}
function renderInspEditor(){
  const P=S.insp,d=P.doc,box=$("#ehoEditView");
  d.issues=d.issues||[];d.scores=d.scores||{};d.goodPoints=d.goodPoints||[];
  const back=el("button",{class:"btn ghost sm",id:"ehoBack"},"← Back");
  back.addEventListener("click",()=>{
    if(!P.dirty)return closeInsp();
    if(back.dataset.armed!=="1"){back.dataset.armed="1";back.textContent="Discard unsaved changes?";setTimeout(()=>{back.dataset.armed="";ehoSaveBar()},3500);return}
    closeInsp();
  });
  const remote=el("div",{class:"banner",id:"ehoRemote",hidden:!P.remote},
    el("span",{text:"Someone else changed this inspection while you were editing (for example, ticked an issue). Saving now will replace their changes. "}),
    el("button",{class:"linkbtn",onclick:()=>{const p=S.inspections.find(x=>x.id===P.id);if(p){S.insp={id:P.id,doc:clone(p),baseAt:p.updatedAt,dirty:false,remote:false};renderInspEditor()}}},"Load their version"));
  const fld=(id,lbl,inp,wide)=>el("div",{class:"field"+(wide?" wide":"")},el("label",{class:"label",for:id,text:lbl}),inp);
  const txt=(key,obj,type)=>{const i=el("input",{type:type||"text",id:"eh_"+key,value:(obj||d)[key]||""});i.addEventListener("input",()=>{(obj||d)[key]=i.value;ehoDirty()});return i};
  const rating=el("select",{id:"eh_rating"});rating.append(el("option",{value:""},"Not given"));for(let n=5;n>=0;n--)rating.append(el("option",{value:String(n)},String(n)));
  rating.value=d.rating==null?"":String(d.rating);rating.addEventListener("change",()=>{d.rating=rating.value===""?null:Number(rating.value);ehoDirty()});
  const dateIn=txt("inspectionDate",null,"date");dateIn.style.fontWeight="700";
  const summary=el("textarea",{id:"eh_summary",value:d.summary||"",style:"min-height:70px"});summary.addEventListener("input",()=>{d.summary=summary.value;ehoDirty()});
  const good=el("textarea",{id:"eh_good",value:d.goodPoints.join("\n"),style:"min-height:70px"});good.addEventListener("input",()=>{d.goodPoints=good.value.split("\n").map(s=>s.trim()).filter(Boolean);ehoDirty()});
  const notes=el("textarea",{id:"eh_notes",value:d.notes||"",style:"min-height:70px"});notes.addEventListener("input",()=>{d.notes=notes.value;ehoDirty()});
  const iss=el("div",{style:"display:grid;gap:12px"});
  d.issues.forEach((i,k)=>{
    const ta=(key,lbl)=>{const t=el("textarea",{id:`eh_${key}_${k}`,value:i[key]||""});t.addEventListener("input",()=>{i[key]=t.value;grow(t);ehoDirty()});return fld(`eh_${key}_${k}`,lbl,t,true)};
    const area=el("select",{id:"eh_area_"+k});for(const a of EHO_AREAS)area.append(el("option",{value:a},a));area.value=i.area||"Other";area.addEventListener("change",()=>{i.area=area.value;ehoDirty()});
    const pri=el("select",{id:"eh_pri_"+k});for(const[v,l]of EHO_PRI)pri.append(el("option",{value:v},l));pri.value=i.priority||"should";pri.addEventListener("change",()=>{i.priority=pri.value;ehoDirty()});
    const dl=el("input",{type:"date",id:"eh_dl_"+k,value:i.deadline||""});dl.addEventListener("input",()=>{i.deadline=dl.value;ehoDirty()});
    const ref=el("input",{type:"text",id:"eh_ref_"+k,value:i.ref||""});ref.addEventListener("input",()=>{i.ref=ref.value;ehoDirty()});
    const dn=el("input",{type:"checkbox",id:"eh_done_"+k});dn.checked=!!i.done;
    dn.addEventListener("change",()=>{i.done=dn.checked;i.doneBy=dn.checked?S.me:null;i.doneAt=dn.checked?Date.now():null;ehoDirty()});
    const del=el("button",{class:"btn ghost sm danger"},"Delete issue");
    armDelete(del,"Delete issue",()=>{d.issues.splice(k,1);ehoDirty();renderInspEditor()});
    iss.append(el("div",{class:"iss-edit"},el("div",{class:"row spread"},el("strong",{text:`Issue ${k+1}`}),el("label",{class:"row",style:"gap:6px",for:"eh_done_"+k},dn,"Addressed")),
      el("div",{class:"fields"},ta("issue","What the inspector found"),ta("action","Action needed"),fld("eh_area_"+k,"Area",area),fld("eh_pri_"+k,"Priority",pri),fld("eh_dl_"+k,"Deadline",dl),fld("eh_ref_"+k,"Legal reference",ref)),
      el("div",{class:"row"},del)));
  });
  requestAnimationFrame(()=>iss.querySelectorAll("textarea").forEach(grow));
  const delDoc=el("button",{class:"btn ghost danger"},"Delete inspection");
  armDelete(delDoc,"Delete inspection",async()=>{if(await save(()=>D("inspections",P.id).delete())){closeInsp();toast("Inspection deleted")}});
  box.replaceChildren(
    el("div",{class:"row spread"},back,el("span",{class:"pill",text:"Editing inspection"})),
    remote,
    el("section",{class:"panel"},el("h2",{text:"Inspection details"}),d.source?el("div",{class:"by",text:"Read from "+d.source}):null,
      el("div",{class:"fields"},fld("eh_inspectionDate","Inspection date",dateIn),fld("eh_rating","Food hygiene rating",rating),fld("eh_visitType","Type of visit",txt("visitType")),
        fld("eh_inspector","Inspector",txt("inspector")),fld("eh_authority","Local authority",txt("authority")),fld("eh_revisitDate","Revisit date",txt("revisitDate",null,"date")),
        fld("eh_hygiene","Score: food handling",txt("hygiene",d.scores)),fld("eh_structure","Score: cleanliness & structure",txt("structure",d.scores)),fld("eh_management","Score: management",txt("management",d.scores)),
        fld("eh_summary","Summary",summary,true),fld("eh_good","Good points (one per line)",good,true))),
    el("section",{class:"panel"},el("div",{class:"row spread"},el("h2",{text:"Issues"}),el("button",{class:"btn ghost sm",onclick:()=>{d.issues.push({id:newIssueId(),issue:"",area:"Other",priority:"should",action:"",deadline:"",ref:"",done:false,doneBy:null,doneAt:null,fixNote:""});ehoDirty();renderInspEditor()}},"Add issue")),
      d.issues.length?iss:el("div",{class:"empty",text:"No issues. Add one if the inspector raised anything."})),
    el("section",{class:"panel"},fld("eh_notes","Notes",notes,true)),
    el("div",{class:"savebar"},el("span",{class:"pill",id:"ehoSaveState"}),el("div",{class:"row",style:"gap:8px"},delDoc,el("button",{class:"btn",id:"ehoSaveBtn",onclick:saveInsp},"Save changes"))));
  ehoSaveBar();
}
async function saveInsp(){
  const P=S.insp;if(!P||!P.dirty||mro())return;
  const d=P.doc,now=Date.now();
  d.issues=d.issues.filter(i=>(i.issue||"").trim()||(i.action||"").trim());
  d.updatedBy=S.me;d.updatedAt=now;
  d.history=[{by:S.me,at:now,what:"Edited"},...(d.history||[])].slice(0,20);
  P.baseAt=now;
  if(await save(()=>D("inspections",P.id).set(clone(d)))){P.dirty=false;P.remote=false;toast("Saved");closeInsp()}
}
function onInspSnapshot(){
  renderInspList();
  const P=S.insp;if(!P)return;
  const p=S.inspections.find(x=>x.id===P.id);
  if(!p){if(!P.dirty){closeInsp();toast("That inspection was deleted.")}return}
  if(p.updatedAt!==P.baseAt){
    if(!P.dirty){S.insp={id:P.id,doc:clone(p),baseAt:p.updatedAt,dirty:false,remote:false};renderInspEditor()}
    else{P.remote=true;ehoSaveBar()}
  }
}
async function manualInsp(){
  if(mro())return;const now=Date.now();
  const d={inspectionDate:"",inspector:"",authority:"",visitType:"Routine inspection",rating:null,scores:{hygiene:"",structure:"",management:""},revisitDate:"",summary:"",goodPoints:[],
    issues:[],notes:"",source:"",createdBy:S.me,createdAt:now,updatedBy:S.me,updatedAt:now,history:[{by:S.me,at:now,what:"Entered by hand"}]};
  try{const ref=await C("inspections").add(d);openInsp(ref.id,{...d,id:ref.id})}catch(e){fail(e)}
}
$("#ehoManual").addEventListener("click",manualInsp);
window.addEventListener("beforeunload",e=>{if(S.insp&&S.insp.dirty){e.preventDefault();e.returnValue=""}});

/* ---------- onboarding documents ---------- */
const ONB_CATS=["Induction checklist","Staff handbook","Policy","Procedure","Job description","Training guide","Form or template","Other"];
const ONB_META=[["category","Type","cat"],["audience","Who it's for","text"],["owner","Owner","text"],["date","Dated","date"],["reviewDate","Next review","date"]];
function renderBody(text){
  const frag=document.createDocumentFragment();
  const lines=String(text||"").split("\n");let list=null,kind=null,para=[];
  const flushP=()=>{if(para.length){frag.append(el("p",{text:para.join(" ")}));para=[]}};
  const flushL=()=>{if(list){frag.append(list);list=null;kind=null}};
  for(const raw of lines){
    const l=raw.trim();let m;
    if(!l){flushP();flushL();continue}
    if((m=l.match(/^\[( |x|X)\]\s*(.*)$/))){
      flushP();if(kind!=="check"){flushL();list=el("ul",{class:"check"});kind="check"}
      list.append(el("li",{},el("span",{class:"box","aria-hidden":"true",text:m[1].trim()?"✓":""}),el("span",{text:m[2]})));continue;
    }
    if((m=l.match(/^[-•*]\s+(.*)$/))){flushP();if(kind!=="ul"){flushL();list=el("ul");kind="ul"}list.append(el("li",{text:m[1]}));continue}
    if((m=l.match(/^\d+[.)]\s+(.*)$/))){flushP();if(kind!=="ol"){flushL();list=el("ol");kind="ol"}list.append(el("li",{text:m[1]}));continue}
    flushL();para.push(l);
  }
  flushP();flushL();
  return frag;
}
async function newOnb(template){
  if(mro())return;
  const now=Date.now();
  const d={category:template?"Induction checklist":"Other",title:template?"New starter induction":"Untitled document",audience:template?"All new staff":"",owner:"",date:today(),reviewDate:"",
    summary:template?"What every new member of staff needs to be shown, told and signed off on before and during their first weeks.":"",
    sections:template?[
      {heading:"Before the first shift",body:"[ ] Contract and right-to-work check completed\n[ ] Bank and payroll details collected (kept off this diary)\n[ ] Emergency contact recorded\n[ ] Uniform or apron given\n[ ] Rota and start time confirmed"},
      {heading:"First day",body:"[ ] Tour of the café, kitchen, stores and toilets\n[ ] Fire exits, fire alarm and assembly point\n[ ] First aid kit and accident book\n[ ] Handwashing and personal hygiene\n[ ] Reporting illness: stay off work until 48 hours after sickness or diarrhoea have stopped\n[ ] Where to find this diary, and how to fill in opening and closing checks"},
      {heading:"Food safety (Safer Food, Better Business)",body:"[ ] Cross-contamination\n[ ] Cleaning and the cleaning schedule\n[ ] Chilling and fridge temperatures\n[ ] Cooking and reheating\n[ ] Allergens: the 14 allergens and how to answer customer questions\n[ ] Recorded on the Staff training tab"},
      {heading:"First week",body:"[ ] Coffee machine and grinder: use and cleaning\n[ ] Till and card machine\n[ ] Opening routine\n[ ] Closing routine\n[ ] Deliveries: checking dates and temperatures"},
      {heading:"Sign-off",body:"Signed by the new starter and their manager once everything above is complete."}]
      :[{heading:"",body:""}],
    notes:"",source:"",createdBy:S.me,createdAt:now,updatedBy:S.me,updatedAt:now,history:[{by:S.me,at:now,what:template?"Created from induction template":"Created"}]};
  try{const ref=await C("onboarding").add(d);openOnb(ref.id,d,"edit")}catch(e){fail(e)}
}
function renderOnbList(){
  const box=$("#obList");box.replaceChildren();const ids=[];
  const list=[...S.onboarding].sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));
  if(!list.length)box.append(el("div",{class:"empty",text:`No onboarding documents yet.${mro()?"":" Tap Add to start an induction checklist or a blank document."}`}));
  for(const d of list){
    ids.push(d.updatedBy);const rs=reviewState(d);
    box.append(el("button",{class:"lrow",type:"button",onclick:()=>openOnb(d.id,null,"view")},el("span",{class:"tile indigo"},svgi(ICON.onboarding)),
      el("span",{class:"t"},el("b",{text:d.title||"Untitled document"}),el("span",{class:"s",text:[d.category,d.audience?"for "+d.audience:"",`updated ${when(d.updatedAt)}, ${nameOf(d.updatedBy)}`].filter(Boolean).join(" · ")})),
      d.reviewDate?el("span",{class:"pill "+rs.cls,text:rs.text}):null,el("span",{class:"chev"},svgi(ICON.chevR))));
  }
  renderAddBtn();resolveNames(ids);
}
function openOnb(id,data,mode){
  const p=data||S.onboarding.find(x=>x.id===id);if(!p)return;
  S.onb={id,doc:clone(p),baseAt:p.updatedAt,dirty:false,remote:false,mode:mro()?"view":(mode||"view")};
  $("#obListView").hidden=true;$("#obEditView").hidden=false;renderOnbEditor();window.scrollTo({top:0});renderAddBtn();
}
function closeOnb(){S.onb=null;$("#obEditView").hidden=true;$("#obEditView").replaceChildren();$("#obListView").hidden=false;renderOnbList()}
function obDirty(){if(S.onb&&!S.onb.dirty){S.onb.dirty=true;obSaveBar()}}
function obSaveBar(){
  const P=S.onb;if(!P)return;
  const st=$("#obSaveState"),btn=$("#obSaveBtn"),back=$("#obBack");
  if(st){st.textContent=P.dirty?"Unsaved changes":`Saved ${when(P.doc.updatedAt)}`;st.className="pill "+(P.dirty?"warn":"ok")}
  if(btn)btn.disabled=!P.dirty||mro();
  if(back&&back.dataset.armed!=="1")back.textContent="← All documents";
  const rb=$("#obRemote");if(rb)rb.hidden=!P.remote;
}
function renderOnbEditor(){
  const P=S.onb,d=P.doc,R=mro(),edit=P.mode==="edit"&&!R,box=$("#obEditView");
  d.sections=d.sections||[];
  const back=el("button",{class:"btn ghost sm",id:"obBack"},"← All documents");
  back.addEventListener("click",()=>{
    if(!P.dirty)return closeOnb();
    if(back.dataset.armed!=="1"){back.dataset.armed="1";back.textContent="Discard unsaved changes?";setTimeout(()=>{back.dataset.armed="";obSaveBar()},3500);return}
    closeOnb();
  });
  const toggle=R?null:el("div",{class:"seg",role:"group","aria-label":"Mode"},
    el("button",{type:"button","aria-pressed":String(!edit),onclick:()=>{P.mode="view";renderOnbEditor()}},"View"),
    el("button",{type:"button","aria-pressed":String(edit),onclick:()=>{P.mode="edit";renderOnbEditor()}},"Edit"));
  const remote=el("div",{class:"banner",id:"obRemote",hidden:!P.remote},
    el("span",{text:"Someone else saved this document while you were editing. Saving now will replace their changes. "}),
    el("button",{class:"linkbtn",onclick:()=>{const p=S.onboarding.find(x=>x.id===P.id);if(p){S.onb={id:P.id,doc:clone(p),baseAt:p.updatedAt,dirty:false,remote:false,mode:P.mode};renderOnbEditor()}}},"Load their version"));
  let main;
  if(edit){
    const title=el("input",{type:"text",class:"title-in",id:"ob_title",value:d.title||"","aria-label":"Title"});
    title.addEventListener("input",()=>{d.title=title.value;obDirty()});
    const meta=el("div",{class:"fields"});
    for(const[f,lbl,t]of ONB_META){
      const id="ob_"+f;let inp;
      if(t==="cat"){inp=el("select",{id});for(const c of ONB_CATS)inp.append(el("option",{value:c},c));inp.value=d.category||"Other";inp.addEventListener("change",()=>{d.category=inp.value;obDirty()})}
      else{inp=el("input",{type:t==="date"?"date":"text",id,value:d[f]||""});inp.addEventListener("input",()=>{d[f]=inp.value;obDirty()})}
      meta.append(el("div",{class:"field"},el("label",{class:"label",for:id,text:lbl}),inp));
    }
    const summary=el("textarea",{id:"ob_summary",value:d.summary||"",style:"min-height:60px"});
    summary.addEventListener("input",()=>{d.summary=summary.value;obDirty()});
    const secs=el("div",{style:"display:grid;gap:12px"});
    d.sections.forEach((s,i)=>{
      const h=el("input",{type:"text",class:"sec-h",id:"ob_h"+i,value:s.heading||"",placeholder:"Section heading","aria-label":`Section ${i+1} heading`});
      h.addEventListener("input",()=>{s.heading=h.value;obDirty()});
      const b=el("textarea",{id:"ob_b"+i,value:s.body||"","aria-label":`Section ${i+1} text`});
      b.addEventListener("input",()=>{s.body=b.value;grow(b);obDirty()});
      const mv=(dir)=>{const j=i+dir;if(j<0||j>=d.sections.length)return;[d.sections[i],d.sections[j]]=[d.sections[j],d.sections[i]];obDirty();renderOnbEditor();const n=document.getElementById("ob_h"+j);if(n)n.scrollIntoView({block:"center"})};
      const del=el("button",{class:"btn ghost sm danger"},"Delete section");
      armDelete(del,"Delete section",()=>{d.sections.splice(i,1);obDirty();renderOnbEditor()});
      secs.append(el("div",{class:"sec-edit"},h,b,el("div",{class:"row",style:"gap:6px"},
        el("button",{class:"btn ghost sm",disabled:i===0,onclick:()=>mv(-1)},"Move up"),
        el("button",{class:"btn ghost sm",disabled:i===d.sections.length-1,onclick:()=>mv(1)},"Move down"),
        el("button",{class:"btn ghost sm",onclick:()=>{d.sections.splice(i+1,0,{heading:"",body:""});obDirty();renderOnbEditor();const n=document.getElementById("ob_h"+(i+1));if(n){n.scrollIntoView({block:"center"});n.focus()}}},"Add section below"),del)));
    });
    const notes=el("textarea",{id:"ob_notes",value:d.notes||"",style:"min-height:80px"});
    notes.addEventListener("input",()=>{d.notes=notes.value;obDirty()});
    main=[
      el("section",{class:"panel"},title,d.source?el("div",{class:"by",text:"Converted from "+d.source}):null,meta,
        el("div",{class:"field"},el("label",{class:"label",for:"ob_summary",text:"Summary"}),summary)),
      el("section",{class:"panel"},el("div",{class:"row spread"},el("h2",{text:"Sections"}),el("button",{class:"btn ghost sm",onclick:()=>{d.sections.push({heading:"",body:""});obDirty();renderOnbEditor()}},"Add section")),
        el("p",{class:"note",text:"Start a line with - for a bullet point, 1. for a numbered step, or [ ] for a tick box. Leave a blank line between paragraphs."}),secs),
      el("section",{class:"panel"},el("label",{class:"label",for:"ob_notes",text:"Notes and sign-off"}),notes)];
    requestAnimationFrame(()=>secs.querySelectorAll("textarea").forEach(grow));
  }else{
    const view=el("div",{class:"docview"});
    view.append(el("div",{class:"label",text:d.category||"Document"}),el("h2",{text:d.title||"Untitled document"}));
    const ml=[d.audience?"For: "+d.audience:"",d.owner?"Owner: "+d.owner:"",d.date?"Dated "+short(d.date):"",d.reviewDate?"Review "+short(d.reviewDate):""].filter(Boolean);
    if(ml.length)view.append(el("div",{class:"metaline"},...ml.map(t=>el("span",{text:t}))));
    if(d.summary)view.append(el("p",{class:"lead",text:d.summary}));
    const named=d.sections.map((s,i)=>[s,i]).filter(([s])=>s.heading);
    if(named.length>3)view.append(el("div",{class:"toc"},...named.map(([s,i])=>el("button",{type:"button",onclick:()=>{const n=document.getElementById("obs"+i);if(n)n.scrollIntoView({behavior:"smooth",block:"start"})}},s.heading))));
    d.sections.forEach((s,i)=>{if(s.heading)view.append(el("h3",{id:"obs"+i,text:s.heading}));if(s.body)view.append(renderBody(s.body))});
    if(!d.sections.some(s=>s.heading||s.body))view.append(el("p",{class:"note",text:R?"This document is empty.":"This document is empty. Switch to Edit to add content."}));
    if(d.notes){view.append(el("h3",{text:"Notes"}));view.append(renderBody(d.notes))}
    main=[el("section",{class:"panel"},d.source?el("div",{class:"by",text:"Converted from "+d.source}):null,view)];
  }
  const del=el("button",{class:"btn ghost danger"},"Delete document");
  armDelete(del,"Delete document",async()=>{if(await save(()=>D("onboarding",P.id).delete())){closeOnb();toast("Document deleted")}});
  const hist=(d.history||[]).slice(0,10);
  const pick=sitePicker("ob_sites");pick.set(d.sites);pick.onChange=()=>{d.sites=pick.get();obDirty()};P.pick=pick;
  box.replaceChildren(
    el("div",{class:"row spread"},back,el("div",{class:"row",style:"gap:8px"},el("span",{class:"pill",text:d.category||"Document"}),toggle)),
    remote,...main,
    R?null:el("section",{class:"panel"},pick.el),
    el("section",{class:"panel"},el("h3",{text:"History"}),
      hist.length?el("div",{},...hist.map(h=>el("div",{class:"by",text:`${when(h.at)} · ${h.what} · ${nameOf(h.by)}`}))):el("div",{class:"by",text:"No history yet."})),
    R?el("div",{class:"note",text:"You can read this document but not edit it."})
     :el("div",{class:"savebar"},el("span",{class:"pill",id:"obSaveState"}),el("div",{class:"row",style:"gap:8px"},del,el("button",{class:"btn",id:"obSaveBtn",onclick:saveOnb},"Save changes"))));
  obSaveBar();
  resolveNames(hist.map(h=>h.by));
}
async function saveOnb(){
  const P=S.onb;if(!P||!P.dirty||mro())return;
  const d=P.doc,now=Date.now();
  d.sections=(d.sections||[]).filter(s=>(s.heading||"").trim()||(s.body||"").trim());
  d.updatedBy=S.me;d.updatedAt=now;
  d.history=[{by:S.me,at:now,what:"Edited"},...(d.history||[])].slice(0,20);
  d.linkId=d.linkId||newLinkId();d.sites=P.pick?P.pick.get():[S.site];
  const body=clone(d);
  if(JSON.stringify(body).length>250000){toast("This document is too large to save. Split it into two documents.");return}
  P.baseAt=now;
  const r=await multiSave("onboarding",d.sites,body,{editId:P.id,old:S.onboarding.find(x=>x.id===P.id),match:false});
  if(r){P.dirty=false;P.remote=false;obSaveBar();toast(`Saved${r.where}.${r.warn}`)}
}
function onOnbSnapshot(){
  renderOnbList();
  const P=S.onb;if(!P)return;
  const p=S.onboarding.find(x=>x.id===P.id);
  if(!p){if(!P.dirty){closeOnb();toast("That document was deleted.")}return}
  if(p.updatedAt!==P.baseAt){
    if(!P.dirty){S.onb={id:P.id,doc:clone(p),baseAt:p.updatedAt,dirty:false,remote:false,mode:P.mode};renderOnbEditor()}
    else{P.remote=true;obSaveBar()}
  }
}
window.addEventListener("beforeunload",e=>{if(S.onb&&S.onb.dirty){e.preventDefault();e.returnValue=""}});

/* ---------- contacts ---------- */
const CON_TYPES=["Local council / environmental health","Pest control","Fridge & freezer engineer","Coffee machine technician","Equipment repairs","Gas engineer","Electrician","Plumber","Water supplier","Electricity supplier","Waste collection","Landlord / building manager","Insurance","Doctor / NHS 111","Key holder / manager","Other"];
const CON_FIELDS=[["type","Type","select"],["name","Name or company","text","e.g. City council food safety team"],["person","Contact person","text",""],["phone","Phone","tel",""],["outOfHours","Out-of-hours / emergency number","tel",""],["email","Email","email",""],["account","Account or reference number","text","e.g. contract no. for pest control"],["notes","Notes","text","e.g. Visits monthly; call for any sighting"]];
let editCon=null;
function conForm(){
  const box=$("#cForm");const f=el("div",{class:"fields"});
  for(const[k,lbl,type,ph]of CON_FIELDS){
    let inp;
    if(type==="select"){inp=el("select",{id:"c_"+k});for(const t of CON_TYPES)inp.append(el("option",{value:t},t))}
    else inp=el("input",{type,id:"c_"+k,placeholder:ph||""});
    f.append(el("div",{class:"field"+(k==="notes"?" wide":"")},el("label",{class:"label",for:"c_"+k,text:lbl}),inp));
  }
  const msg=el("span",{class:"by"});
  const cancel=el("button",{class:"btn ghost",hidden:true,onclick:()=>editContact(null)},"Cancel edit");
  const del=el("button",{class:"btn ghost danger",hidden:true},"Remove contact");
  armDelete(del,"Remove contact",async()=>{if(await save(()=>D("contacts",editCon).delete())){editContact(null);toast("Contact removed")}});
  const saveBtn=el("button",{class:"btn",onclick:async()=>{
    const v={};for(const[k]of CON_FIELDS)v[k]=$("#c_"+k).value.trim();
    if(!v.name){msg.textContent="Add a name or company first.";return}
    if(!v.phone&&!v.email&&!v.outOfHours){msg.textContent="Add a phone number or email so people can reach them.";return}
    v.by=S.me;v.at=Date.now();
    const r=await multiSave("contacts",pick.get(),v,{editId:editCon,old:editCon?S.contacts.find(x=>x.id===editCon):null});
    if(r){msg.textContent="";toast(`Saved ${v.name}${r.where}.${r.warn}`);editContact(null)}
  }},"Save contact");
  const pick=sitePicker("c_sites");
  box.append(f,pick.el,el("div",{class:"row"},saveBtn,cancel,del,msg));box._cancel=cancel;box._del=del;box._msg=msg;box._pick=pick;
}
function editContact(c,typeOnly){
  editCon=c?c.id:null;$("#cFormTitle").textContent=c?"Edit "+c.name:"Add a contact";
  for(const[k]of CON_FIELDS)$("#c_"+k).value=c?(c[k]||(k==="type"?"Other":"")):(k==="type"?(typeOnly||CON_TYPES[0]):"");
  $("#cForm")._cancel.hidden=true;$("#cForm")._del.hidden=!c;$("#cForm")._pick.set(c&&c.sites);
  setForm("contacts",!!(c||typeOnly));
}
function copyBtn(text){
  return el("button",{class:"btn ghost sm",onclick:async e=>{
    try{await navigator.clipboard.writeText(text);toast("Copied "+text)}
    catch(_){const r=document.createRange();r.selectNodeContents(e.target.previousSibling);const s=getSelection();s.removeAllRanges();s.addRange(r);toast("Number selected")}
  }},"Copy");
}
function renderContacts(){
  const box=$("#cList");box.replaceChildren();
  const order=t=>{const i=CON_TYPES.indexOf(t);return i<0?99:i};
  const list=[...S.contacts].sort((a,b)=>order(a.type)-order(b.type)||a.name.localeCompare(b.name));
  if(!list.length)box.append(el("div",{class:"empty glass",text:"No contacts yet. Start with your council's food safety team, pest control and your fridge engineer."}));
  const row=c=>xrow("c"+c.id,{
    title:c.name,sub:[c.person,c.type].filter(Boolean).join(" · "),
    right:[callBtn(c.outOfHours||c.phone,"Call "+c.name)],
    details:[xfacts([["Phone",c.phone?telLink(c.phone):""],["Out of hours",c.outOfHours?telLink(c.outOfHours):""],["Email",c.email?el("a",{href:"mailto:"+c.email,text:c.email}):""],["Reference",c.account],["Notes",c.notes]]),
      mro()?null:el("div",{class:"row"},el("button",{class:"btn ghost sm",type:"button",onclick:()=>editContact(c)},"Edit contact"))]});
  // Anyone with an out-of-hours number goes first: that's who you need in a hurry.
  const urgent=list.filter(c=>c.outOfHours);
  if(urgent.length)box.append(el("div",{class:"label bad",text:"Emergency and out of hours"}),el("div",{class:"list glass"},...urgent.map(row)));
  let cur=null,grp=null;
  for(const c of list.filter(c=>!c.outOfHours)){
    if(c.type!==cur){cur=c.type;grp=el("div",{class:"list glass"});box.append(el("div",{class:"label",text:c.type||"Other"}),grp)}
    grp.append(row(c));
  }
  const have=new Set(list.map(c=>c.type));
  const sug=$("#cSuggest");sug.replaceChildren();
  const missing=["Local council / environmental health","Pest control","Fridge & freezer engineer","Coffee machine technician","Gas engineer","Electrician","Plumber","Water supplier","Doctor / NHS 111","Key holder / manager"].filter(t=>!have.has(t));
  for(const t of missing)sug.append(el("button",{class:"btn ghost sm",type:"button",onclick:()=>editContact(null,t)},"+ "+t));
  $("#cSuggestPanel").hidden=mro()||!missing.length;
  $("#cFormPanel").hidden=mro()||!formOpen.contacts;
}

/* ---------- staff training ---------- */
// The training topics this site uses: Setup's trainingOff lists the ones it doesn't need.
// Dates already recorded for a switched-off topic are kept, just not shown or counted.
const siteTopics=()=>TOPICS.filter(([k])=>!S.settings.trainingOff.includes(k));
function staffForm(){
  const box=$("#tTopics");
  for(const[k,lbl]of TOPICS)box.append(el("div",{class:"field","data-topic":k},el("label",{class:"label",for:"tt_"+k,text:lbl}),el("input",{type:"date",id:"tt_"+k})));
  // Most training happens on one day: fill every topic shown with one date.
  $("#tAllApply").addEventListener("click",()=>{
    const d=$("#tAllDate").value;if(!d){$("#tMsg").textContent="Choose a date to apply first.";$("#tAllDate").focus();return}
    for(const[k]of siteTopics())$("#tt_"+k).value=d;
    $("#tMsg").textContent="";toast(`${short(d)} applied to all ${siteTopics().length} topics. Save to keep it.`);
  });
  const sb=$("#tSites");
  const all=el("input",{type:"checkbox",id:"ts_all"});
  sb.append(el("label",{for:"ts_all"},all,el("strong",{text:"All sites"})));
  for(const x of SITES)sb.append(el("label",{for:"ts_"+x.id},el("input",{type:"checkbox",id:"ts_"+x.id,"data-site":x.id}),x.name));
  const boxes=()=>[...sb.querySelectorAll("input[data-site]")];
  all.addEventListener("change",()=>boxes().forEach(b=>b.checked=all.checked));
  sb.addEventListener("change",e=>{if(e.target!==all)all.checked=boxes().every(b=>b.checked)});
  $("#tSave").addEventListener("click",async()=>{
    const name=$("#tName").value.trim();if(!name){$("#tMsg").textContent="Add the person's name first.";return}
    const sites=boxes().filter(b=>b.checked).map(b=>b.dataset.site);
    if(!sites.length){$("#tMsg").textContent="Tick at least one site to save to.";return}
    const old=S.editStaff?S.staff.find(x=>x.id===S.editStaff):null;
    const topics={};
    for(const[k]of TOPICS){const d=$("#tt_"+k).value;if(d){const prev=old&&old.topics&&old.topics[k];topics[k]=prev&&prev.date===d?prev:{date:d,by:S.me}}}
    const personId=(old&&old.personId)||("p"+Date.now().toString(36)+Math.random().toString(36).slice(2,6));
    const v={name,role:$("#tRole").value.trim(),start:$("#tStart").value,topics,notes:$("#tNotes").value.trim(),personId,sites,at:Date.now()};
    const key=normT(old?old.name:name),editId=S.editStaff,here=S.site;
    $("#tSave").disabled=true;$("#tMsg").textContent="Saving…";
    const done=[];
    for(const site of sites){
      const ok=await save(async()=>{
        if(site===here&&editId)return D("staff",editId,site).set(v);
        const snap=await C("staff",site).get();
        const m=snap.docs.find(d=>{const x=d.data()||{};return x.personId===personId||normT(x.name)===key});
        return m?D("staff",m.id,site).set(v):C("staff",site).add(v);
      });
      if(ok)done.push(siteOf(site).name);
    }
    $("#tSave").disabled=mro();
    if(done.length){editStaff(null);$("#tMsg").textContent="";toast(`Saved ${name} to ${done.join(", ")}`+(done.length<sites.length?". Some sites couldn't be saved; try again.":""))}
  });
  $("#tCancel").addEventListener("click",()=>editStaff(null));
  armDelete($("#tDelete"),"Remove person",async()=>{if(await save(()=>D("staff",S.editStaff).delete())){editStaff(null);toast("Removed")}});
}
function editStaff(p){
  S.editStaff=p?p.id:null;$("#tFormTitle").textContent=p?"Edit "+p.name:"Add a staff member";
  $("#tName").value=p?p.name:"";$("#tRole").value=p?(p.role||""):"";$("#tStart").value=p?(p.start||""):"";$("#tNotes").value=p?(p.notes||""):"";
  for(const[k]of TOPICS)$("#tt_"+k).value=p&&p.topics&&p.topics[k]?p.topics[k].date:"";
  $("#tAllDate").value="";
  const on=p&&Array.isArray(p.sites)&&p.sites.length?p.sites:[S.site];
  document.querySelectorAll("#tSites input[data-site]").forEach(b=>b.checked=on.includes(b.dataset.site)||b.dataset.site===S.site&&!!p);
  $("#ts_all").checked=[...document.querySelectorAll("#tSites input[data-site]")].every(b=>b.checked);
  $("#tCancel").hidden=true;$("#tDelete").hidden=!p;
  setForm("staff",!!p);
}
// Record that someone was trained on one topic today.
async function trainedToday(p,k){
  const topics={...(p.topics||{}),[k]:{date:today(),by:S.me}};
  if(await save(()=>D("staff",p.id).update({topics})))toast(`${p.name}: ${TOPICS.find(t=>t[0]===k)[1]} recorded`);
}
// Untick a topic and it's no longer shown or counted at this site. Saved straight to the site's settings.
async function setTopicOff(k,on){
  const off=S.settings.trainingOff.filter(x=>x!==k);if(!on)off.push(k);
  if(off.length>=TOPICS.length){toast("Keep at least one topic");renderStaff();return}
  const patch={trainingOff:off,updatedBy:S.me,updatedAt:Date.now()};
  const ok=await save(()=>S.settings.fresh?D("settings","main",S.site).set({...storable(S.settings),...patch}):D("settings","main",S.site).update(patch));
  if(ok)toast(`${TOPICS.find(t=>t[0]===k)[1]} ${on?"added back for":"removed from"} the ${curSite().name}`);else renderStaff();
}
// Staff training → "New accounts to add": everyone with an account who isn't on this site's list yet (matched by
// name), ticked by default. One tap adds them, here or at all four sites, with no training dates yet.
const impSkip=new Set();
function renderStaffImport(){
  const panel=$("#tImport");if(!panel)return;
  const have=new Set(S.staff.map(x=>normT(x.name)));
  const missing=S.team.filter(p=>!have.has(normT(p.name)));
  panel.hidden=mro()||!S.db||!missing.length||S.role==="staff";
  if(panel.hidden)return;
  const box=$("#tImpList");box.replaceChildren();
  for(const p of missing){const id="ti_"+normT(p.name).replace(/[^a-z0-9]+/g,"_");
    const cb=el("input",{type:"checkbox",id});cb.checked=!impSkip.has(p.id);
    cb.addEventListener("change",()=>{cb.checked?impSkip.delete(p.id):impSkip.add(p.id);updImp()});
    box.append(el("label",{for:id},cb,el("span",{},p.name,el("span",{class:"s",text:" · "+(ROLE_NAME[p.role]||p.role)}))))}
  const updImp=()=>{const n=missing.filter(p=>!impSkip.has(p.id)).length;$("#tImpGo").textContent=n?`Add ${n} ${n===1?"person":"people"} to the staff list`:"Tick someone to add";$("#tImpGo").disabled=!n;
    $("#tImpPill").textContent=`${missing.length} new`;};
  updImp();
  $("#tImpGo").onclick=async()=>{
    const people=missing.filter(p=>!impSkip.has(p.id));if(!people.length)return;
    const sites=$("#tImpAll").checked?SITES.map(x=>x.id):[S.site];
    $("#tImpGo").disabled=true;$("#tImpMsg").textContent="Adding…";
    let added=0;const fails=[];
    for(const site of sites){
      let existing=[];
      try{existing=site===S.site?S.staff:(await C("staff",site).get()).docs.map(d=>d.data()||{})}catch(e){fails.push(siteOf(site).name);continue}
      const there=new Set(existing.map(x=>normT(x.name)));
      for(const p of people){
        if(there.has(normT(p.name)))continue;
        const rec={name:p.name,role:"",start:"",topics:{},notes:"",personId:"p"+Date.now().toString(36)+Math.random().toString(36).slice(2,6),sites,at:Date.now()};
        try{await C("staff",site).add(rec);if(site===S.site)added++}catch(e){if(!fails.includes(siteOf(site).name))fails.push(siteOf(site).name)}
      }
    }
    $("#tImpMsg").textContent=fails.length?`Couldn't add everyone at the ${fails.join(", ")}. Try again.`:"";
    toast(`Added ${people.length} ${people.length===1?"person":"people"} to the staff list${sites.length>1?" at all four sites":""}`);
  };
}
function renderStaff(){
  renderStaffImport();
  const TOPICS=siteTopics();
  for(const n of document.querySelectorAll("#tTopics [data-topic]"))n.hidden=!TOPICS.some(([k])=>k===n.dataset.topic);
  const tb0=$("#tTopicToggles");tb0.replaceChildren();
  for(const[k,lbl]of ALL_TOPICS){
    const id="tto_"+k,cb=el("input",{type:"checkbox",id,disabled:mro()});cb.checked=TOPICS.some(t=>t[0]===k);
    cb.addEventListener("change",()=>setTopicOff(k,cb.checked));
    tb0.append(el("label",{for:id},cb,lbl));
  }
  $("#tTopicsPanel").hidden=mro();
  const list=[...S.staff].sort((a,b)=>a.name.localeCompare(b.name));
  const todo=p=>TOPICS.filter(([k])=>!(p.topics&&p.topics[k]));
  const full=list.filter(p=>!todo(p).length).length,gaps=list.length-full;
  const stat=(n,l,c)=>el("div",{class:"stat glass"},el("b",{class:c||"",text:n}),el("span",{text:l}));
  $("#tStats").replaceChildren(stat(String(list.length),list.length===1?"person":"people"),stat(String(full),"fully trained","ok"),stat(String(gaps),"training to do",gaps?"warn":"ok"));
  $("#tStats").hidden=!list.length;
  const box=$("#tList");box.replaceChildren();
  if(!list.length)box.append(el("div",{class:"empty",text:"No one listed yet. Add each member of staff with the dates they were trained."}));
  for(const p of list){
    const left=todo(p),done=TOPICS.length-left.length;
    box.append(xrow("t"+p.id,{
      lead:ringEl(done,TOPICS.length),title:p.name,
      sub:[p.role,left.length?`${left.length} to do`:"All training done"].filter(Boolean).join(" · "),
      right:[left.length?el("span",{class:"pill warn",text:`${done}/${TOPICS.length}`}):el("span",{class:"pill ok",text:"Trained"})],
      details:[el("ul",{class:"topics"},...TOPICS.map(([k,l])=>{const t=p.topics&&p.topics[k];
          return el("li",{class:t?"on":""},el("span",{class:"badge "+(t?"done":"")},t?svgi(ICON.check):""),el("span",{class:"t"},el("b",{text:l}),el("span",{class:"s",text:t?"Trained "+short(t.date):"Not yet"})),
            t||mro()?null:el("button",{class:"btn ghost sm",type:"button",onclick:()=>trainedToday(p,k)},"Trained today"))})),
        xfacts([["Started",p.start?short(p.start):""],["Sites",Array.isArray(p.sites)&&p.sites.length>1?p.sites.map(x=>siteOf(x).name).join(", "):""],["Notes",p.notes]]),
        mro()?null:el("div",{class:"row"},el("button",{class:"btn ghost sm",type:"button",onclick:()=>editStaff(p)},"Edit record"))]}));
  }
  const mx=$("#tMatrix");mx.replaceChildren();
  if(list.length){
    const head=el("tr",{},el("th",{text:"Name"}),...TOPICS.map(([,l])=>el("th",{class:"al",text:l})));
    const tb=el("tbody");
    for(const p of list)tb.append(el("tr",{},el("td",{},el("b",{text:p.name}),el("div",{class:"by",text:p.role||""})),
      ...TOPICS.map(([k])=>{const t=p.topics&&p.topics[k];return el("td",{class:"dt"+(t?"":" no"),text:t?short(t.date):"–"})})));
    mx.append(el("div",{class:"scroll"},el("table",{class:"matrix"},el("thead",{},head),tb)));
  }
  mx.closest("section").hidden=!list.length;
  $("#tFormPanel").hidden=mro()||!formOpen.staff;
}

/* ---------- allergens ---------- */
const algFilter=new Set();
const ALG_SHORT={"Cereals with gluten":"Gluten","Sulphur dioxide":"Sulphites"};
const algShort=a=>ALG_SHORT[a]||a.replace(/ \(.*\)$/,"");
let algNewKind="drink";
function renderAllergens(){
  const items=[...S.allergens].sort((a,b)=>a.name.localeCompare(b.name)),R=ro(),secOn=algSectionsOn();
  // "Free from" chips: tap allergens a customer must avoid, and the list shows only what's safe.
  const fb=$("#algFilter");fb.replaceChildren(el("span",{class:"s",text:"Free from"}));
  for(const a of ALLERGENS)fb.append(el("button",{type:"button",class:"fchip"+(algFilter.has(a)?" on":""),"aria-pressed":String(algFilter.has(a)),
    onclick:()=>{algFilter.has(a)?algFilter.delete(a):algFilter.add(a);renderAllergens()}},algShort(a)));
  const q=normT($("#algSearch").value);
  const match=it=>(!q||normT(it.name+" "+(it.source||"")).includes(q))&&![...algFilter].some(a=>(it.contains||[]).includes(a));
  const row=it=>{const has=it.contains||[];
    return xrow("a"+it.id,{
      title:it.name,sub:[it.source,it.notes].filter(Boolean).join(" · "),
      right:[el("span",{class:"agl"},...(has.length?has.map(a=>el("span",{class:"ag",text:algShort(a)})):[el("span",{class:"pill ok",text:"None of the 14"})]))],
      details:[xfacts([["Contains",has.join(", ")||"None of the 14 allergens"],["Notes",it.notes],["Source",it.source],["Checked",it.at?new Date(it.at).toLocaleDateString("en-GB")+(it.by?", "+nameOf(it.by):""):""],["Copied from",it.importedFrom?siteOf(it.importedFrom).name:""]]),
        R?null:el("div",{class:"row"},el("button",{class:"btn ghost sm",type:"button",onclick:()=>editAlg(it)},"Edit item"))]})};
  const matrix=list=>{
    const head=el("tr",{},el("th",{text:"Item"}),...ALLERGENS.map(a=>el("th",{class:"al",text:algShort(a)})));
    const tb=el("tbody");
    for(const it of list){const h=new Set(it.contains||[]);
      tb.append(el("tr",{},el("td",{},el("b",{text:it.name}),it.notes?el("div",{class:"by",text:it.notes}):null),...ALLERGENS.map(a=>el("td",{class:"c"},h.has(a)?el("span",{class:"y",title:a,text:"●"}):""))))}
    return el("div",{class:"scroll"},el("table",{class:"matrix"},el("thead",{},head),tb));
  };
  const summary=(list,k)=>{const sm=algSummary(list);return el("div",{class:"algsum"},
    el("div",{class:"algsum-box"+(sm.inAll.length?" all":" none")},el("div",{class:"label",text:k==="food"?"In every item":"In every drink"}),el("div",{class:"chips"},...(sm.inAll.length?sm.inAll.map(a=>el("span",{class:"ag",text:a})):[el("span",{class:"s",text:"None"})]))),
    el("div",{class:"algsum-box none"},el("div",{class:"label",text:"Not used"}),el("div",{class:"chips"},...(sm.inNone.length?sm.inNone.map(a=>el("span",{class:"agn",text:a})):[el("span",{class:"s",text:"None"})]))))};
  const box=$("#algList");box.replaceChildren();box.classList.toggle("glass",!secOn);box.classList.toggle("list",!secOn);
  const mx=$("#algMatrix");mx.replaceChildren();
  if(!secOn){
    const shown=items.filter(match);
    if(!items.length)box.append(el("div",{class:"empty",text:`No menu items yet.${R?"":" Tap Add item to add your first, then tick the allergens it contains."}`}));
    else if(!shown.length)box.append(el("div",{class:"empty",text:algFilter.size?`Nothing on the list is free from ${[...algFilter].map(algShort).join(", ")}.`:"No items match."}));
    for(const it of shown)box.append(row(it));
    if(items.length)mx.append(matrix(items));
  }else{
    for(const[k,title]of ALG_SECTIONS){
      const list=items.filter(it=>algKind(it)===k),shown=list.filter(match);
      const add=R?null:el("button",{class:"btn ghost sm",type:"button",onclick:()=>{algNewKind=k;editAlg(null);setForm("allergens",true)}},k==="food"?"Add food":"Add drink");
      const sec=el("section",{class:"algsec",id:"algsec-"+k},el("div",{class:"row spread"},el("h2",{text:title}),el("div",{class:"row",style:"gap:8px"},el("span",{class:"pill",text:`${list.length} item${list.length===1?"":"s"}`}),add)));
      if(k==="food"&&list.length)sec.append(el("p",{class:"note",text:algFoodNote()}));
      if(list.length)sec.append(summary(list,k));
      const lb=el("div",{class:"list glass"});
      if(!list.length){
        lb.append(el("div",{class:"empty",text:`No ${title.toLowerCase()} listed yet.`}));
        if(k==="food"&&S.site==="cafe"&&!R)lb.append(el("div",{class:"row",style:"padding:0 14px 14px"},el("button",{class:"btn",type:"button",onclick:e=>addCafeBakes(e.currentTarget)},`Add the ${CAFE_BAKES.length} cakes & bakes from the allergen sheet`)));
      }else if(!shown.length)lb.append(el("div",{class:"empty",text:algFilter.size?`Nothing here is free from ${[...algFilter].map(algShort).join(", ")}.`:"No items match."}));
      for(const it of shown)lb.append(row(it));
      sec.append(lb);box.append(sec);
      if(list.length)mx.append(el("h3",{text:title}),matrix(list));
    }
  }
  mx.closest("section").hidden=!items.length;
  $("#algFormPanel").hidden=R||!formOpen.allergens;
}
function setAlgKind(k){const box=$("#algKind");box.dataset.v=k;for(const b of box.querySelectorAll("button"))b.setAttribute("aria-pressed",String(b.dataset.k===k))}
function buildAlgChecks(){
  for(const b of document.querySelectorAll("#algKind button"))b.addEventListener("click",()=>setAlgKind(b.dataset.k));
  const c=$("#algChecks");
  ALLERGENS.forEach((a,i)=>{const id="alg_"+i;c.append(el("label",{for:id},el("input",{type:"checkbox",id,value:a}),a))});
}
function editAlg(it){
  S.editAlg=it?it.id:null;
  $("#algFormTitle").textContent=it?"Edit "+it.name:"Add a menu item";
  $("#algName").value=it?it.name:"";$("#algSupplier").value=it?(it.source||""):"";$("#algNotes").value=it?(it.notes||""):"";
  const has=new Set(it?it.contains||[]:[]);
  document.querySelectorAll("#algChecks input").forEach(cb=>cb.checked=has.has(cb.value));
  $("#algCancel").hidden=true;$("#algDelete").hidden=!it;algPick.set(it&&it.sites);
  $("#algKindRow").hidden=!algSectionsOn();setAlgKind(it?algKind(it):(algNewKind||"drink"));
  setForm("allergens",!!it);
}

const algPick=sitePicker("alg_sites");$("#algSites").replaceWith(algPick.el);

/* ---------- PDFs made on the device (public/pdf.js) ---------- */
let LOGO_D=null;
fetch("/logo.svg").then(r=>r.ok?r.text():"").then(t=>{const m=/ d="([^"]+)"/.exec(t||"");LOGO_D=m?m[1]:null}).catch(()=>{});
const fullName=id=>id&&id===S.me?(S.myName||"you"):nameOf(id);
const longNow=()=>new Date().toLocaleString("en-GB",{day:"numeric",month:"long",year:"numeric",hour:"2-digit",minute:"2-digit"});
const pdfDate=s=>s?parse(s).toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric"}):"";
// Running header: the Strangers logo, a title and up to three lines underneath. Returns where the page body starts.
function pdfHeader(title,lines){
  return(doc,m)=>{
    if(LOGO_D)doc.svg(LOGO_D,m,m,0.31);
    const x=m+(LOGO_D?78:0);
    doc.text(title,x,m+17,{size:17,bold:true});
    (lines||[]).slice(0,3).forEach((l,i)=>doc.text(l,x,m+31+i*11,{size:8.5,color:"#555555"}));
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
const allergenItems=()=>[...S.allergens].sort((a,b)=>a.name.localeCompare(b.name));
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
    header:pdfHeader("Allergen matrix",[`Strangers Coffee ${site.name} · ${addr}`,`The 14 allergens UK law requires you to declare · ${items.length} menu item${items.length===1?"":"s"}${last?" · last changed "+new Date(last).toLocaleDateString("en-GB",{day:"numeric",month:"long",year:"numeric"}):""}`])});
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
  const d=parse(today());d.setMonth(d.getMonth()-Number(IN.range));d.setDate(d.getDate()+1);
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
  if(IN.key===key&&(IN.data||IN.loading))return;
  IN.key=key;IN.data=null;IN.err="";
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
  const inR=d=>d&&d>=R.from&&d<=R.to,atIn=ts=>ts&&inR(iso(new Date(ts)));
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
  for(const m of maintAll)if(m.status==="done"&&atIn(m.doneAt))actions.push({date:iso(new Date(m.doneAt)),area:"Maintenance",what:m.title+(m.area?` (${m.area})`:""),did:m.fixNote||"Done",by:fullName(m.doneBy)});
  const insp=inspSorted()[0];
  if(insp)for(const i of(insp.issues||[]))if(i.done&&atIn(i.doneAt))actions.push({date:iso(new Date(i.doneAt)),area:"EHO issue",what:i.issue,did:i.fixNote||"Fixed",by:fullName(i.doneBy)});
  actions.sort((a,b)=>b.date.localeCompare(a.date));

  // Cleaning and extra checks
  const taskRows=kind=>S[kind].slice().sort((a,b)=>a.name.localeCompare(b.name)).map(t=>{const ts=taskState(t),n=(t.log||[]).filter(e=>atIn(e.at)).length;
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
    rows:S.staff.slice().sort((a,b)=>a.name.localeCompare(b.name)).map(p=>[p.name,p.role||"",pdfDate(p.start),...topics.map(([k])=>{const t=p.topics&&p.topics[k];return t?{t:pdfDate(t.date),cls:"ok"}:{t:"Not yet",cls:"bad"}})]),
    empty:"No staff training records."});
  out.push({id:"maintenance",title:"Maintenance",intro:"Equipment problems and maintenance jobs: everything still open, and anything reported or finished in the period.",
    cols:[{l:"Reported",w:72},{l:"Job",flex:1.2,bold:true},{l:"Equipment or area",w:95},{l:"Urgency",w:70},{l:"Status",w:110},{l:"What was done",flex:1.2}],
    rows:maintAll.filter(m=>m.status!=="done"||atIn(m.reportedAt)||atIn(m.doneAt)).sort((a,b)=>(b.reportedAt||0)-(a.reportedAt||0)).map(m=>{const pr=mtPri(m.priority);
      return[m.reportedAt?pdfDate(iso(new Date(m.reportedAt))):"",m.title,m.area||"",{t:pr[1],cls:pr[3]},m.status==="done"?{t:`Done ${m.doneAt?pdfDate(iso(new Date(m.doneAt))):""}`,cls:"ok"}:{t:"Open"+(m.assignee?` · ${m.assigneeName||fullName(m.assignee)}`:""),cls:pr[0]==="urgent"?"bad":"warn"},m.fixNote||m.details||""]}),
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
    rows:S.suppliers.slice().sort((a,b)=>a.name.localeCompare(b.name)).map(x=>[x.name,x.supplies||"",x.contact||"",x.phone||"",x.rating||"",x.notes||""]),empty:"No suppliers listed."});
  if(insp)out.push({id:"inspection",title:"Last EHO inspection",
    facts:[["Date",pdfDate(insp.inspectionDate)],["Inspector",[insp.inspector,insp.authority].filter(Boolean).join(", ")],["Visit",insp.visitType],["Rating",insp.rating!=null?String(insp.rating):""],
      ["Scores",insp.scores?[["Food handling",insp.scores.hygiene],["Cleanliness & structure",insp.scores.structure],["Management",insp.scores.management]].filter(x=>x[1]!==""&&x[1]!=null).map(x=>x.join(" ")).join(" · "):""],
      ["Revisit",pdfDate(insp.revisitDate)],["Summary",insp.summary]],
    cols:[{l:"Issue",flex:1.4},{l:"Area",w:80},{l:"Action required",flex:1.4},{l:"Deadline",w:72},{l:"Status",w:120}],
    rows:(insp.issues||[]).map(i=>[i.issue,i.area||"",i.action||"",pdfDate(i.deadline),i.done?{t:`Done${i.doneAt?" "+pdfDate(iso(new Date(i.doneAt))):""}${i.fixNote?": "+i.fixNote:""}`,cls:"ok"}:{t:"Open",cls:"bad"}]),empty:"No issues recorded."});
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

/* ---------- review ---------- */
function reviewPeriod(){
  const last=S.reviews[0];
  const start=last?last.date:(S.settings.startDate||Object.keys(S.days).sort()[0]||today());
  return{start,due:addDays(start,28)};
}
function renderReview(){
  const{start,due}=reviewPeriod();const t=today();
  const p=$("#revDue");const left=Math.round((parse(due)-parse(t))/864e5);
  p.textContent=left<0?`Overdue since ${nice(due)}`:left===0?"Due today":`Next due ${nice(due)} (${left} days)`;
  p.className="pill "+(left<0?"bad":left<=3?"warn":"ok");
  let comp=0,days=0,temps=0;
  for(let dt=start;dt<=t;dt=addDays(dt,1)){const st=dayStatus(S.days[dt],null,dt);if(closure(S.days[dt])||isClosed(dt)&&!st.any)continue;days++;if(st.complete)comp++;if(st.issue)temps++}
  const xOver=S.extras.filter(x=>taskState(x).overdue).length,kOver=S.cleaning.filter(x=>taskState(x).overdue).length;
  const pFail=S.prove.filter(r=>r.date>=start&&r.pass===false).length;
  const untrained=S.staff.filter(p=>siteTopics().some(([k])=>!(p.topics&&p.topics[k]))).length;
  // What happened since the last review, each linked to where it's recorded.
  const nPlans=S.plans.filter(d=>reviewState(d).overdue).length,lastInsp=inspSorted()[0],nEho=lastInsp?(lastInsp.issues||[]).filter(i=>!i.done).length:0;
  const pl=(n,w)=>`${n} ${w}${n===1?"":"s"}`;
  const facts=[["history",`${comp} of ${days} days complete`,comp===days?"ok":"warn"],["history",pl(temps,"day")+" with temperature problems",temps?"bad":"ok"],
    ["prove",pl(pFail,"failed Prove it check"),pFail?"bad":"ok"],["cleaning",pl(kOver,"cleaning job")+" overdue",kOver?"bad":"ok"],["extras",pl(xOver,"extra check")+" overdue",xOver?"bad":"ok"],
    ["staff",pl(untrained,"person")+" with training to do",untrained?"warn":"ok"],["plans",pl(nPlans,"HACCP or risk document")+" due for review",nPlans?"bad":"ok"],
    ...(lastInsp?[["eho",pl(nEho,"EHO issue")+" still open",nEho?"bad":"ok"]]:[])].filter(([t])=>canTab(t));
  $("#revSummary").replaceChildren(el("div",{class:"s",text:`Since ${nice(start)}`}),...facts.map(([t,text,c])=>
    el("button",{class:"lrow",type:"button",onclick:()=>show(t)},el("span",{class:"sdot "+c}),el("span",{class:"t"},el("b",{text})),el("span",{class:"chev"},svgi(ICON.chevR)))));
  const qs=$("#revQs");qs.replaceChildren();
  for(const[k,q]of REVIEW_QS){
    const cur=S.rev[k]||{};
    const seg=el("div",{class:"seg",role:"group","aria-label":q});
    for(const v of["Yes","No"])seg.append(el("button",{type:"button","aria-pressed":String(cur.a===v),disabled:mro(),onclick:()=>{S.rev[k]={...cur,a:v};renderReview()}},v));
    const det=el("input",{type:"text",id:"rq_"+k,placeholder:"Details (what changed, what you did)",value:cur.d||"",disabled:mro()});
    det.addEventListener("input",()=>{S.rev[k]={...(S.rev[k]||{}),d:det.value}});
    qs.append(el("div",{class:"qa"},el("div",{class:"row spread"},el("span",{text:q}),seg),cur.a==="Yes"||cur.d?det:null));
  }
  $("#revSave").disabled=mro();$("#revNotes").disabled=mro();
  // Staff read the summary and past reviews; the questions are for the manager who signs it.
  const ro4=S.role==="staff";qs.hidden=ro4;$("#revNotes").closest(".field").hidden=ro4;$("#revSave").closest(".row").hidden=ro4;$("#revStaffNote").hidden=!ro4;
  const list=$("#revList");list.replaceChildren();
  if(!S.reviews.length)list.append(el("div",{class:"empty",text:"No reviews signed yet. Your first one is due "+nice(due)+"."}));
  for(const r of S.reviews){
    const yes=REVIEW_QS.filter(([k])=>r.answers&&r.answers[k]&&r.answers[k].a==="Yes");
    list.append(el("div",{class:"qa"},
      el("div",{class:"row spread"},el("strong",{text:nice(r.date)}),el("span",{class:"by",text:"Signed by "+nameOf(r.by)})),
      el("div",{class:"note",text:yes.length?"Yes to: "+yes.map(([k,q])=>q+(r.answers[k].d?` (${r.answers[k].d})`:"")).join(" "):"No changes recorded."}),
      r.notes?el("div",{class:"note",text:"Actions: "+r.notes}):null));
  }
  resolveNames(S.reviews.map(r=>r.by));
}

/* ---------- allergen PDFs ---------- */
const kb=n=>n>=1048576?(n/1048576).toFixed(1)+" MB":Math.max(1,Math.round(n/1024))+" KB";
// The allergen matrix is made on the spot from this site's menu items (allergenPdf). PDFs uploaded before that
// change are still listed under it, with Open and Remove, until someone removes them.
function renderAllergenDocs(){
  const box=$("#adList");box.replaceChildren();const ids=[];
  const items=S.allergens,last=items.length?Math.max(...items.map(i=>i.at||0)):0;
  box.append(el("div",{class:"pdfcard glass"},el("span",{class:"tile red"},svgi(ICON.doc)),
    el("span",{class:"t"},el("b",{text:"Allergen matrix (PDF)"}),
      el("span",{class:"s",text:items.length?`${items.length} menu item${items.length===1?"":"s"} × the 14 UK allergens${last?" · last changed "+new Date(last).toLocaleDateString("en-GB",{day:"numeric",month:"short"}):""}`:`Add the ${curSite().name}'s menu items below, then make the matrix.`})),
    el("button",{class:"btn sm",type:"button",id:"amMake",disabled:!items.length||!S.db,onclick:allergenPdf},"Generate PDF")));
  const list=[...S.allergenDocs].sort((a,b)=>(b.at||0)-(a.at||0));
  if(list.length)box.append(el("div",{class:"label",text:"Uploaded earlier"}));
  list.forEach(d=>{
    ids.push(d.by);
    const url="/_blob/"+d.assetId;
    let del=null;
    if(!ro()&&S.assets){
      del=el("button",{class:"btn ghost sm danger",type:"button"},"Remove");
      armDelete(del,"Remove",async()=>{
        if(await save(()=>D("allergenDocs",d.id).delete())){
          // The same file may be listed at other sites: only delete it once no site uses it.
          let used=false;
          try{for(const x of SITES){const q=await C("allergenDocs",x.id).get();if(q.docs.some(e=>(e.data()||{}).assetId===d.assetId)){used=true;break}}}catch(e){used=true}
          if(!used){try{await S.assets.delete(d.assetId)}catch(e){}}
          toast(`PDF removed from the ${curSite().name}`);
        }
      });
    }
    box.append(el("div",{class:"pdfcard glass old"},
      el("span",{class:"tile grey"},svgi(ICON.doc)),
      el("span",{class:"t"},el("b",{text:d.title||d.fileName||"Allergen information"}),
        el("span",{class:"s",text:[d.size?kb(d.size):"",`${when(d.at)}, ${nameOf(d.by)}`].filter(Boolean).join(" · ")}),
        d.note?el("span",{class:"s",text:d.note}):null),
      el("a",{class:"btn ghost sm",href:url,target:"_blank",rel:"noopener"},"Open"),del));
  });
  resolveNames(ids);
}

/* ---------- needs attention (per site) ---------- */
function prevTradingDay(s,days){
  for(let i=1;i<=7;i++){const d=addDays(today(),-i);if(closure(days[d]))continue;if(!isClosed(d,s)||(days[d]&&dayStatus(days[d],activeCfg(s),d).any))return d}
  return null;
}
function siteAttention(id){
  const sm=S.sum[id];if(!sm||!sm.ready)return null;
  const s=sm.settings,cfg=activeCfg(s),t=today();
  const st=dayStatus(sm.days[t],cfg,t),closedToday=!!closure(sm.days[t])||isClosed(t,s)&&!st.any;
  const prev=prevTradingDay(s,sm.days),pd=prev?sm.days[prev]:null,pst=prev?dayStatus(pd,cfg,prev):null;
  const tasks=[];
  for(const kind of["cleaning","extras"]){
    if(!tabOn(kind,s))continue;
    for(const x of sm[kind]){const ts=taskState(x);if(ts.overdue)tasks.push({kind,t:x,ts})}
  }
  tasks.sort((a,b)=>(a.t.lastAt||0)-(b.t.lastAt||0));
  let openDue=!closedToday&&st.oT>0&&st.open!=="y";
  const dayKeys=Object.keys(sm.days).sort();
  const start=s.startDate||dayKeys[0]||null;
  const unused=s.fresh&&!dayKeys.length;
  const prevDue=!unused&&!!prev&&!!start&&prev>=start&&!(pd&&pd.signed);
  if(unused)openDue=false;
  return{id,s,cfg,t,st,closedToday,prev,pd,pst,tasks,openDue,prevDue,unused,start,count:(openDue?1:0)+(prevDue?1:0)+tasks.length};
}
// Today → "Closed today?": mark the day shown as closed with a reason, or reopen it.
// Setup → Closures & holidays: plan closures ahead (one day or a run of days, here or at all four sites), and see
// and remove the ones from the last two months onwards.
function closureForm(){
  for(const r of CLOSE_REASONS)$("#clChips").append(el("button",{type:"button",class:"fchip",onclick:()=>{$("#clReason").value=r}},r));
  $("#clAdd").addEventListener("click",async()=>{
    const from=$("#clFrom").value,to=$("#clTo").value||from,reason=$("#clReason").value.trim(),msg=$("#clMsg");
    if(!from){msg.textContent="Choose the date it's closed.";return}
    if(!reason){msg.textContent="Write why it's closed.";$("#clReason").focus();return}
    if(to<from){msg.textContent="The end date is before the start.";return}
    const dates=[];for(let d=from;d<=to;d=addDays(d,1))dates.push(d);
    if(dates.length>31){msg.textContent="Add up to 31 days at a time.";return}
    const sites=$("#clAll").checked?SITES.map(x=>x.id):[S.site],closed={reason,...stamp()};
    msg.textContent="Saving…";const fails=new Set();
    for(const site of sites)for(const date of dates){
      try{
        if(site===S.site)await patchDay(date,{closed});
        else{const ref=D("days",date,site);try{await ref.update({closed})}catch(e){if(e&&e.code==="not_found")await ref.set({date,closed});else throw e}}
      }catch(e){fails.add(siteOf(site).name)}
    }
    msg.textContent=fails.size?`Couldn't save at the ${[...fails].join(", ")}. Try again.`:"";
    if(!fails.size){$("#clFrom").value="";$("#clTo").value="";$("#clReason").value="";$("#clAll").checked=false;
      toast(`Closed ${dates.length===1?nice(from):`${nice(from)} to ${nice(to)}`}${sites.length>1?" at all four sites":""}`)}
  });
}
function renderClosures(){
  const box=$("#clList");if(!box)return;box.replaceChildren();
  const R=ro(),from=addDays(today(),-60);
  const list=Object.entries(S.days).filter(([date,d])=>date>=from&&closure(d)).sort(([a],[b])=>a.localeCompare(b));
  if(!list.length)box.append(el("div",{class:"empty",text:"No closures in the last two months or coming up."}));
  for(const[date,d]of list){const cl=closure(d);
    const del=R?null:el("button",{class:"btn ghost sm danger",type:"button"},"Remove");
    if(del)armDelete(del,"Remove",async()=>{if(await save(()=>patchDay(date,{closed:null})))toast(`${nice(date)} is no longer closed`)});
    box.append(el("div",{class:"lrow"},el("span",{class:"t"},el("b",{text:date===today()?"Today":`${nice(date)} ${parse(date).getFullYear()}`}),
      el("span",{class:"s",text:`${cl.reason} · ${nameOf(cl.by)}`})),date>=today()?el("span",{class:"pill acc",text:"Coming up"}):null,del));
  }
  for(const x of["#clFrom","#clTo","#clReason","#clAll","#clAdd"])$(x).disabled=R;
}
function renderCloseDay(d){
  const box=$("#closeDay");if(!box)return;box.replaceChildren();
  const cl=closure(d),R=ro();box.hidden=R||S.date>today();if(box.hidden)return;
  const date=S.date,label=date===today()?"today":nice(date);
  if(cl){box.append(el("button",{class:"btn ghost sm",type:"button",onclick:async()=>{if(await save(()=>patchDay(date,{closed:null})))toast(`${nice(date)} reopened`)}},"Reopen this day"));return}
  const det=el("details",{class:"closeday"},el("summary",{},`Shop closed ${label}? Mark it closed`));
  const txt=el("input",{type:"text",id:"cdReason",placeholder:"Why it was closed, e.g. Boiler broken, engineer booked","aria-label":"Why it was closed"});
  const chips=el("div",{class:"chiprow wrap"},...CLOSE_REASONS.map(r=>el("button",{type:"button",class:"fchip",onclick:()=>{txt.value=r;txt.focus()}},r)));
  const go=el("button",{class:"btn sm",type:"button",onclick:async()=>{const reason=txt.value.trim();if(!reason){toast("Write why it was closed");txt.focus();return}
    if(await save(()=>patchDay(date,{closed:{reason,...stamp()}})))toast(`${nice(date)} marked closed`)}},"Mark as closed");
  det.append(chips,el("div",{class:"row"},txt,go));
  box.append(det);
}
function dueDate(t){const n=FREQ[t.freq],b=t.lastAt||t.importedAt;if(!b||!n)return"";const d=new Date(b);d.setDate(d.getDate()+n);return iso(d)}
function goDay(date){S.date=date;show("day");renderDay();renderHead()}
/* ---------- app chrome: sites, sections, account ---------- */
const svgi=(d)=>{const n=document.createElementNS("http://www.w3.org/2000/svg","svg");n.setAttribute("viewBox","0 0 24 24");n.setAttribute("class","i");n.setAttribute("aria-hidden","true");n.innerHTML=d;return n};
const ICON={
  today:'<rect x="4" y="5" width="16" height="15" rx="3"/><path d="M4 10h16M9 3v4M15 3v4"/><path d="M9 14.5l2 2 4-4"/>',
  week:'<rect x="4" y="5" width="16" height="15" rx="3"/><path d="M4 10h16M9 3v4M15 3v4M8 14h.01M12 14h.01M16 14h.01M8 17h.01M12 17h.01"/>',
  history:'<path d="M4 12a8 8 0 108-8 8.5 8.5 0 00-6 2.5L4 8"/><path d="M4 4v4h4M12 8v4l3 2"/>',
  records:'<rect x="5" y="3" width="14" height="18" rx="2.5"/><path d="M9 8h6M9 12h6M9 16h4"/>',
  more:'<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  extras:'<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6"/>',
  cleaning:'<path d="M9 9h6v12H9zM10 9V6h4v3M14 4h3M16 2v4"/>',
  prove:'<path d="M10 14V5a2 2 0 014 0v9a4 4 0 11-4 0z"/>',
  allergens:'<path d="M5 19c0-9 6-14 15-14 0 9-5 15-14 15zM5 19l7-7"/>',
  eho:'<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/>',
  deliveries:'<path d="M3.5 7.5L12 3l8.5 4.5v9L12 21l-8.5-4.5z"/><path d="M3.5 7.5L12 12l8.5-4.5M12 12v9M7.8 5.2l8.5 4.6"/>',
  maintenance:'<path d="M14.7 6.3a4 4 0 015 5l-1.4-1.4-2.1.7-.7 2.1 1.4 1.4a4 4 0 01-5-5L4.6 17.4a1.9 1.9 0 002.7 2.7l8.3-8.3"/>',
  plans:'<path d="M9 3h6M10 3v6l-5 9a2 2 0 002 3h10a2 2 0 002-3l-5-9V3"/>',
  suppliers:'<path d="M3 7h11v9H3zM14 10h4l3 3v3h-7"/><circle cx="7" cy="18" r="1.8"/><circle cx="17" cy="18" r="1.8"/>',
  contacts:'<path d="M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a1 1 0 01-1 1A16 16 0 014 5a1 1 0 011-1z"/>',
  staff:'<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.5 2.7-6 6-6s6 2.5 6 6M16 11a3 3 0 100-6M21 20c0-3-1.8-5.2-4.5-5.8"/>',
  onboarding:'<path d="M5 4h6a3 3 0 013 3v13a2 2 0 00-2-2H5zM19 4h-5v14h5z"/>',
  review:'<path d="M12 4l2.5 5.2 5.5.8-4 4 1 5.6L12 17l-5 2.6 1-5.6-4-4 5.5-.8z"/>',
  setup:'<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/>',
  chevD:'<path d="M6 9l6 6 6-6"/>',chevR:'<path d="M9 6l6 6-6 6"/>',chevL:'<path d="M15 6l-6 6 6 6"/>',
  key:'<circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 7l3 3"/>',shield:'<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/><path d="M9 12l2 2 4-4"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',doc:'<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/>',
  out:'<path d="M14 4h4a2 2 0 012 2v12a2 2 0 01-2 2h-4M10 16l-4-4 4-4M6 12h10"/>',
  check:'<path d="M5 12.5l4.5 4.5L19 7.5"/>',warn:'<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17h.01"/>',dot:'',
  pen:'<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',lock:'<rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 018 0v3"/>',
};
// Every section, in order. grp: where it lives (diary sections are tabs; records and manage are lists on phones).
const NAV=[
  {id:"day",t:"Today",grp:"diary",ic:"today"},{id:"week",t:"This week",grp:"diary",ic:"week"},{id:"history",t:"Last 4 weeks",grp:"manage",ic:"history",sub:"Days complete, gaps and problems"},
  {id:"inspect",t:"EHO inspection mode",grp:"manage",ic:"shield",tile:"green",sub:"Everything the inspector asks for, on screen or as a PDF"},
  {id:"extras",t:"Extra checks",grp:"records",ic:"extras",tile:"teal"},{id:"cleaning",t:"Cleaning",grp:"records",ic:"cleaning",tile:"blue"},
  {id:"prove",t:"Prove it",grp:"records",ic:"prove",tile:"orange"},{id:"allergens",t:"Allergens",grp:"records",ic:"allergens",tile:"red"},
  {id:"templog",t:"Temperature log",grp:"records",ic:"prove",tile:"blue"},
  {id:"deliveries",t:"Deliveries",grp:"records",ic:"deliveries",tile:"indigo"},{id:"maintenance",t:"Maintenance",grp:"records",ic:"maintenance",tile:"purple"},
  {id:"eho",t:"Last EHO inspection report",grp:"manage",ic:"eho",tile:"green"},{id:"plans",t:"HACCP & risk",grp:"manage",ic:"plans",tile:"purple"},
  {id:"suppliers",t:"Suppliers",grp:"manage",ic:"suppliers",tile:"orange"},{id:"contacts",t:"Contacts",grp:"manage",ic:"contacts",tile:"green"},
  {id:"staff",t:"Staff training",grp:"manage",ic:"staff",tile:"teal"},{id:"onboarding",t:"Onboarding",grp:"manage",ic:"onboarding",tile:"indigo"},
  {id:"review",t:"4-weekly review",grp:"manage",ic:"review",tile:"red"},{id:"setup",t:"Setup",grp:"admin",ic:"setup",tile:"grey",sub:"Checks, fridges, opening days and sections"},
];
const navOf=id=>NAV.find(n=>n.id===id);
// Sections only managers and admins use. The Worker enforces the same rule on saves (src/access.ts).
const MANAGER_TABS=new Set(["setup"]);
const roleAllows=t=>S.role!=="staff"||!MANAGER_TABS.has(t);
const canTab=t=>t==="records"||t==="more"||(tabOn(t)&&roleAllows(t));
const initials=n=>String(n||"?").split(/\s+/).filter(Boolean).map(w=>w[0]).slice(0,2).join("").toUpperCase();
function siteState(id){
  const a=siteAttention(id);
  if(!S.db||!a)return{cls:"",text:"…"};
  if(a.unused)return{cls:"",text:"Not in use"};
  return a.count?{cls:"bad",text:`${a.count} to do`}:{cls:"ok",text:"All clear"};
}
// Small status shown beside a section in lists ("1 overdue").
function navBadge(id){
  if(id==="cleaning"||id==="extras"){const n=S[id].filter(x=>taskState(x).overdue).length;return n?{cls:"bad",text:`${n} overdue`}:null}
  if(id==="maintenance"){const n=S.maintenance.filter(m=>m.status!=="done"&&m.priority==="urgent").length;return n?{cls:"bad",text:`${n} urgent`}:null}
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
    case "extras":case "cleaning":{
      const xs=S[id].map(x=>({x,st:taskState(x),due:dueDate(x)}));if(!xs.length)return "Nothing listed yet";
      const over=xs.filter(a=>a.st.overdue),todayN=xs.filter(a=>!a.st.overdue&&a.st.cls==="warn"&&FREQ[a.x.freq]>0);
      if(over.length)return `Overdue: ${over.map(a=>a.x.name).slice(0,2).join(", ")}${over.length>2?` and ${over.length-2} more`:""}`;
      if(todayN.length)return `Due today: ${todayN.map(a=>a.x.name).slice(0,2).join(", ")}`;
      const next=xs.filter(a=>a.due).sort((a,b)=>a.due.localeCompare(b.due))[0];
      return next?`All up to date · next ${next.x.name}, ${nice(next.due)}`:`${n(xs.length,id==="cleaning"?"job":"check")}, all up to date`;
    }
    case "prove":{const r=[...S.prove].sort((a,b)=>(b.at||0)-(a.at||0))[0];return r?`Last: ${r.food}, ${r.pass?"pass":"fail"} · ${short(r.date)}`:"No checks recorded yet"}
    case "allergens":return S.allergens.length?`${n(S.allergens.length,"menu item")} · allergen matrix PDF`:"No menu items yet";
    case "history":{let c=0,tr=0;for(let i=1;i<=28;i++){const d=addDays(t,-i),st=dayStatus(S.days[d],null,d);if(closure(S.days[d])||isClosed(d)&&!st.any)continue;tr++;if(st.complete)c++}return `${c} of ${tr} days complete`}
    case "eho":{const l=inspSorted()[0];if(!l)return "No inspection recorded";const o=(l.issues||[]).filter(i=>!i.done).length;return `Rating ${l.rating??"–"} · ${o?n(o,"issue")+" open":"no open issues"}`}
    case "plans":{const due=S.plans.filter(d=>reviewState(d).overdue).length;return S.plans.length?`${n(S.plans.length,"document")}${due?` · ${due} due for review`:""}`:"None yet: start from a template"}
    case "templog":{const d=S.days[t],us=S.settings.units;if(!us.length)return "No fridges or freezers set up";
      const rs=us.map(u=>{const r=d&&d.temps&&d.temps[u.id]&&d.temps[u.id].am;return r&&r.v!=null?`${u.name}: ${r.v}°`:null}).filter(Boolean);
      return rs.length?`Today: ${rs.join(" · ")}`:"No readings yet today"}
    case "deliveries":{const td=S.deliveries.filter(d=>d.date===t),rj=td.filter(d=>d.outcome==="rejected").length,l=[...S.deliveries].sort((a,b)=>(b.at||0)-(a.at||0))[0];
      return td.length?`Today: ${n(td.length,"delivery").replace("deliverys","deliveries")}${rj?` · ${rj} rejected`:""}`:l?`Last: ${l.supplier}, ${short(l.date)}`:"No deliveries recorded yet"}
    case "maintenance":{const o=S.maintenance.filter(m=>m.status!=="done"),u=o.filter(m=>m.priority==="urgent").length,mine=o.filter(m=>m.assignee===S.me).length;return o.length?`${n(o.length,"open job")}${u?` · ${u} urgent`:""}${mine?` · ${mine} assigned to you`:""}`:"Nothing reported"}
    case "suppliers":return S.suppliers.length?n(S.suppliers.length,"supplier"):"None listed yet";
    case "contacts":{const e=S.contacts.filter(c=>c.outOfHours).length;return S.contacts.length?`${n(S.contacts.length,"contact")}${e?` · ${e} out of hours`:""}`:"None listed yet"}
    case "staff":{const g=S.staff.filter(p=>siteTopics().some(([k])=>!(p.topics&&p.topics[k]))).length;return S.staff.length?(g?`${g} of ${S.staff.length} with training to do`:"Everyone trained"):"No one listed yet"}
    case "onboarding":return S.onboarding.length?n(S.onboarding.length,"document"):"None yet: start from a template";
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
  const vis=NAV.filter(n=>canTab(n.id)&&(S.role||!MANAGER_TABS.has(n.id)));
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
  const box=$("#peopleList");box.replaceChildren(el("div",{class:"empty",text:"Loading…"}));
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

/* ---------- connection: changes made offline wait on this device (claude-shim.js) ---------- */
window.addEventListener("diary:connection",e=>{
  const{offline,pending}=e.detail,c=$("#conn");
  const was=!c.hidden;
  c.hidden=!offline&&!pending;
  c.textContent=offline?`Offline${pending?` · ${pending} change${pending===1?"":"s"} waiting`:""}`:`Saving ${pending} change${pending===1?"":"s"}…`;
  c.title=offline?"No connection. Changes are kept on this device and save when it's back.":"";
  if(was&&c.hidden)toast("Back online. All changes saved.");
});
window.addEventListener("diary:dropped",e=>toast("A change couldn't be saved: "+(e.detail.message||"refused by the diary")));
async function signOut(){try{await fetch("/api/auth/logout",{method:"POST"})}catch(e){}location.replace("/signin")}
function renderMe(){
  $("#avatarBtn").textContent=initials(S.myName);
  $("#meBox").replaceChildren(el("span",{class:"avatar sm",text:initials(S.myName)}),
    el("span",{class:"t"},el("b",{text:S.myName||"Signed in"}),el("span",{class:"s",text:{admin:"Admin",manager:"Manager",staff:"Staff"}[S.role]||""})),svgi(ICON.chevR));
}
/* sheets and the account menu */
function closeSheets(){$("#sheetVeil").hidden=true;$("#siteSheet").hidden=true;$("#peopleSheet").hidden=true;$("#acctMenu").hidden=true}
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

/* ---------- setup (per site) & publishing ---------- */
let SE=null,setupDirty=false;
const normT=t=>String(t||"").trim().toLowerCase().replace(/\s+/g," ");
function setupDraft(){const s=S.settings;return JSON.parse(JSON.stringify({allergenSections:algSectionsOn(s),startDate:s.startDate||"",startAll:false,info:s.info||{},closedDays:s.closedDays,hide:s.hide,proveOff:s.proveOff,units:s.units,opening:s.opening,closing:s.closing,weekly:s.weekly}))}
function sDirty(){if(!setupDirty){setupDirty=true;$("#setupBar").classList.remove("idle");$("#setupMsg").textContent="Unsaved changes for the "+curSite().name;renderPublish()}}
function sharedHas(k,t){return !!S.shared&&(S.shared[k]||[]).some(c=>normT(c.t)===normT(t))}
function renderSetup(){
  renderClosures();
  $("#setupBar").classList.toggle("idle",!setupDirty);
  if(!setupDirty||!SE){SE=setupDraft();buildSetup()}
  renderPublish();
}
function toggleBox(box,items,isOn,onChange){
  box.replaceChildren();
  for(const[k,lbl]of items){
    const id=box.id+"_"+k;const cb=el("input",{type:"checkbox",id,disabled:ro()});cb.checked=isOn(k);
    cb.addEventListener("change",()=>{onChange(k,cb.checked);sDirty()});
    box.append(el("label",{for:id},cb,lbl));
  }
}
function buildSetup(){
  const R=ro(),site=curSite(),s=SE;
  $("#setupTitle").textContent=`${site.name} details`;
  const fr=$("#setupFresh");fr.hidden=!S.settings.fresh;
  fr.textContent=`The ${site.name} hasn't been set up yet, so it's using the standard checks. Change them below and save, or publish another site's checks to it.`;
  const bind=(sel,key,def)=>{const n=$(sel);n.value=s.info[key]!=null?s.info[key]:(def||"");n.disabled=R;n.oninput=()=>{s.info[key]=n.value;sDirty()}};
  bind("#siAddr","address",site.addr);bind("#siManager","manager");bind("#siNote","note");
  const st=$("#siStart");st.value=s.startDate||"";st.disabled=R;st.oninput=()=>{s.startDate=st.value;s.startTouched=true;sDirty()};
  const as=$("#siAlgSec");as.checked=!!s.allergenSections;as.disabled=R;as.onchange=()=>{s.allergenSections=as.checked;sDirty()};
  const sa=$("#siStartAll");sa.checked=!!s.startAll;sa.disabled=R;sa.onchange=()=>{s.startAll=sa.checked;sDirty()};
  toggleBox($("#siDays"),WEEKDAYS,k=>!s.closedDays.includes(k),(k,on)=>{s.closedDays=s.closedDays.filter(x=>x!==k);if(!on)s.closedDays.push(k)});
  toggleBox($("#siTabs"),OPT_TABS,k=>!s.hide[k],(k,on)=>{if(on)delete s.hide[k];else s.hide[k]=true});
  toggleBox($("#siProve"),Object.entries(PROVE).map(([k,r])=>[k,r.label]),k=>!s.proveOff.includes(k),(k,on)=>{s.proveOff=s.proveOff.filter(x=>x!==k);if(!on)s.proveOff.push(k)});
  const ub=$("#unitEdit");ub.replaceChildren();
  s.units.forEach((u,i)=>ub.append(unitRow(u,i)));
  if(!s.units.length)ub.append(el("div",{class:"by",text:"No fridges or freezers at this site. The temperature section is hidden from the daily diary."}));
  for(const[k]of LISTS){
    const box=$("#ce"+k[0].toUpperCase()+k.slice(1));box.replaceChildren();
    s[k].forEach((c,i)=>{
      const cb=el("input",{type:"checkbox",disabled:R,"aria-label":"Used at this site: "+(c.t||"new check"),title:"Used at this site"});cb.checked=!c.off;
      const tx=el("input",{type:"text",id:`ce_${k}_${i}`,value:c.t,disabled:R,placeholder:"Describe the check","aria-label":"Check"});
      const row=el("div",{class:"chk-row"+(c.off?" off":"")});
      const grip=R?el("span"):dragHandle(row,k,i,box);
      cb.addEventListener("change",()=>{if(cb.checked)delete c.off;else c.off=true;row.classList.toggle("off",!cb.checked);sDirty()});
      tx.addEventListener("input",()=>{c.t=tx.value;sDirty()});
      const tag=el("span",{class:"tag",text:!S.shared?"":sharedHas(k,c.t)?"Shared":"This site only"});
      const del=el("button",{class:"btn ghost sm danger",disabled:R,"aria-label":"Delete check"},"✕");
      armDelete(del,"✕",()=>{s[k].splice(i,1);sDirty();buildSetup()});
      row.append(grip,cb,tx,tag,del);box.append(row);
    });
    if(!s[k].length)box.append(el("div",{class:"by",text:"No checks."}));
  }
  for(const x of["#addUnit","#saveSetup","#discardSetup"])$(x).disabled=R;
  document.querySelectorAll("[data-addchk]").forEach(b=>b.disabled=R);
}
// Drag a check up or down by its handle (mouse, finger or pen), or focus the handle and use the arrow keys.
// The new order is saved with the rest of Setup.
function dragHandle(row,k,i,box){
  const h=el("button",{class:"grip",type:"button","aria-label":"Move this check: drag, or use the up and down arrow keys",title:"Drag to reorder"},
    svgi('<path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01"/>'));
  const moveTo=(from,to)=>{
    const list=SE[k];if(to<0||to>=list.length||to===from)return false;
    const [it]=list.splice(from,1);list.splice(to,0,it);sDirty();return true;
  };
  h.addEventListener("keydown",e=>{
    if(e.key!=="ArrowUp"&&e.key!=="ArrowDown")return;
    e.preventDefault();const to=i+(e.key==="ArrowUp"?-1:1);
    if(moveTo(i,to)){buildSetup();const n=$("#ce"+k[0].toUpperCase()+k.slice(1)).querySelectorAll(".grip")[to];if(n)n.focus()}
  });
  h.addEventListener("pointerdown",e=>{
    if(e.button!==0)return;
    e.preventDefault();h.setPointerCapture(e.pointerId);
    const rows=[...box.querySelectorAll(".chk-row")],from=rows.indexOf(row);
    const top0=row.getBoundingClientRect().top,y0=e.clientY;
    row.classList.add("dragging");box.classList.add("sorting");
    let to=from;
    const mid=rows.map(r=>{const b=r.getBoundingClientRect();return b.top+b.height/2});
    const hgt=row.getBoundingClientRect().height+6;
    const move=ev=>{
      const dy=ev.clientY-y0;row.style.transform=`translateY(${dy}px)`;
      const c=top0+dy+row.getBoundingClientRect().height/2;
      to=from;for(let j=0;j<rows.length;j++){if(j<from&&c<mid[j]){to=j;break}if(j>from&&c>mid[j])to=j}
      rows.forEach((r,j)=>{if(r===row)return;const s=(from<to&&j>from&&j<=to)?-hgt:(to<from&&j>=to&&j<from)?hgt:0;r.style.transform=s?`translateY(${s}px)`:""});
    };
    const end=()=>{
      h.removeEventListener("pointermove",move);h.removeEventListener("pointerup",end);h.removeEventListener("pointercancel",end);
      rows.forEach(r=>r.style.transform="");row.classList.remove("dragging");box.classList.remove("sorting");
      if(moveTo(from,to))buildSetup();
    };
    h.addEventListener("pointermove",move);h.addEventListener("pointerup",end);h.addEventListener("pointercancel",end);
  });
  return h;
}
function unitRow(u,i){
  const r=el("div",{class:"row"});
  const nm=el("input",{type:"text",value:u.name,id:"un_"+i,"aria-label":"Unit name",style:"flex:1 1 180px;width:auto",disabled:ro()});
  nm.addEventListener("input",()=>{u.name=nm.value;sDirty()});
  const s=el("select",{id:"uk_"+i,"aria-label":"Type",style:"width:auto",disabled:ro()},el("option",{value:"fridge"},"Fridge / chiller"),el("option",{value:"freezer"},"Freezer"));s.value=u.kind;
  s.addEventListener("change",()=>{u.kind=s.value;sDirty()});
  r.append(nm,s,el("button",{class:"btn ghost",disabled:ro(),onclick:()=>{SE.units.splice(i,1);sDirty();buildSetup()}},"Remove"));
  return r;
}
// prev: the list as saved before. A check that's new, or was turned off and is now back on, applies from today.
const cleanList=(l,prev)=>l.map(c=>{
  const was=(prev||[]).find(p=>p.id===c.id);
  const from=!was||(was.off&&!c.off)?today():was.from;
  return{id:c.id,t:String(c.t||"").trim(),...(c.off?{off:true}:{}),...(from?{from}:{})};
}).filter(c=>c.t);
function storable(s){const o={...s};delete o.fresh;return o}
async function saveSetup(){
  if(ro()||!SE)return;
  const site=S.site,s=SE;
  const next={...storable(S.settings),info:{...s.info},closedDays:[...s.closedDays],hide:{...s.hide},proveOff:[...s.proveOff],
    units:s.units.map(u=>({id:u.id,name:String(u.name||"").trim()||"Unnamed unit",kind:u.kind})),
    opening:cleanList(s.opening,S.settings.fresh?null:S.settings.opening),closing:cleanList(s.closing,S.settings.fresh?null:S.settings.closing),weekly:cleanList(s.weekly,S.settings.fresh?null:S.settings.weekly),updatedBy:S.me,updatedAt:Date.now()};
  if(s.startDate)next.startDate=s.startDate;
  next.allergenSections=!!s.allergenSections;
  if(s.startTouched||s.startAll)next.startSet=true;
  if(!next.startDate)next.startDate=today();
  if(next.closedDays.length===7){$("#setupMsg").textContent="Leave at least one day open.";return}
  if(!await save(()=>D("settings","main",site).set(next)))return;
  // "Use this start date at all four sites": only the start date changes at the other sites.
  let also="";
  if(s.startAll){
    const done=[],fails=[];
    for(const x of SITES.filter(x=>x.id!==site)){
      const patch={startDate:next.startDate,startSet:true,updatedBy:S.me,updatedAt:Date.now()};
      try{await D("settings","main",x.id).update(patch)}
      catch(e){
        if(e&&e.code==="not_found"){try{await D("settings","main",x.id).set({...storable(normSettings(null)),...patch});done.push(x.name);continue}catch(e2){}}
        fails.push(x.name);continue;
      }
      done.push(x.name);
    }
    also=` Start date also set at the ${done.join(", ")}.${fails.length?` Couldn't update the ${fails.join(", ")}; try again.`:""}`;
  }
  setupDirty=false;SE=null;$("#setupMsg").textContent=`Setup saved for the ${siteOf(site).name}.${also}`;renderSetup();
}
$("#saveSetup").addEventListener("click",saveSetup);
$("#discardSetup").addEventListener("click",()=>{setupDirty=false;SE=null;$("#setupMsg").textContent="Changes discarded.";renderSetup()});
$("#addUnit").addEventListener("click",()=>{SE.units.push({id:"u"+Date.now().toString(36),name:"",kind:"fridge"});sDirty();buildSetup();const n=$("#un_"+(SE.units.length-1));if(n)n.focus()});
document.querySelectorAll("[data-addchk]").forEach(b=>b.addEventListener("click",()=>{
  const k=b.dataset.addchk;SE[k].push({id:k[0]+Date.now().toString(36),t:""});sDirty();buildSetup();
  const n=$(`#ce_${k}_${SE[k].length-1}`);if(n)n.focus();
}));

function mergeList(k,src,tgt){
  const out=[],used=new Set(),added=[],removed=[],kept=[],taken=new Set(tgt.map(x=>x.id));
  src.forEach((c,i)=>{
    const m=tgt.find(x=>!used.has(x.id)&&normT(x.t)===normT(c.t));
    if(m){used.add(m.id);out.push({id:m.id,t:c.t,...(m.off?{off:true}:{}),...(m.from?{from:m.from}:{})})}
    else{let id=c.id;if(taken.has(id)||out.some(o=>o.id===id))id=k[0]+Date.now().toString(36)+i;out.push({id,t:c.t,from:today()});added.push(c.t)}
  });
  for(const x of tgt)if(!used.has(x.id)){
    if(S.shared&&!sharedHas(k,x.t)){out.push(x);kept.push(x.t)}else removed.push(x.t);
  }
  return{list:out,added,removed,kept};
}
function pubTargets(){return $("#pubScope").value==="all"?SITES.filter(x=>x.id!==S.site).map(x=>x.id):[$("#pubSite").value].filter(id=>id&&id!==S.site)}
function planPublish(targetSettings){
  const src=S.settings;
  return SITES.filter(x=>targetSettings[x.id]).map(x=>{
    const tgt=targetSettings[x.id];const res={site:x.id,lists:{},added:0,removed:0,kept:0,detail:[]};
    for(const[k,lbl]of LISTS){
      const m=mergeList(k,src[k].map(c=>({id:c.id,t:c.t})),tgt[k]);
      res.lists[k]=m.list;res.added+=m.added.length;res.removed+=m.removed.length;res.kept+=m.kept.length;
      for(const t of m.added)res.detail.push(["Add",lbl,t]);for(const t of m.removed)res.detail.push(["Remove",lbl,t]);for(const t of m.kept)res.detail.push(["Keep (this site only)",lbl,t]);
    }
    const offN=LISTS.reduce((n,[k])=>n+res.lists[k].filter(c=>c.off).length,0);
    res.off=offN;res.fresh=!!tgt.fresh;
    return res;
  });
}
let pubArmed=false,pubNote="";
function renderPublish(){
  const R=ro(),site=curSite();
  const sel=$("#pubSite"),cur=sel.value;sel.replaceChildren(...SITES.filter(x=>x.id!==S.site).map(x=>el("option",{value:x.id},x.name)));
  if([...sel.options].some(o=>o.value===cur))sel.value=cur;
  $("#pubOneWrap").hidden=$("#pubScope").value!=="one";
  const ids=pubTargets();const tgts={};
  for(const id of ids)if(S.sum[id]&&S.sum[id].ready)tgts[id]=S.sum[id].settings;
  const plan=planPublish(tgts);
  const pv=$("#pubPreview");pv.replaceChildren();
  pv.append(el("div",{},el("strong",{text:`From: ${site.name}`}),el("span",{class:"by",text:` · ${LISTS.map(([k,l])=>`${S.settings[k].length} ${l.toLowerCase()}`).join(", ")} checks (including any turned off at the ${site.name})`})));
  pv.append(el("div",{class:"label",text:`Sites that will be updated (${ids.length})`}));
  if(!ids.length)pv.append(el("div",{class:"by",text:"Choose a site."}));
  for(const id of ids){
    const p=plan.find(x=>x.site===id);
    if(!p){pv.append(el("div",{class:"by",text:siteOf(id).name+": loading…"}));continue}
    const nochange=!p.added&&!p.removed&&!p.fresh;
    const head=el("div",{class:"row",style:"gap:8px"},el("strong",{text:siteOf(id).name}),
      nochange?el("span",{class:"pill ok",text:"Already matches"}):null,
      p.fresh?el("span",{class:"pill warn",text:"Not set up yet"}):null,
      p.added?el("span",{class:"pill",text:`${p.added} added`}):null,
      p.removed?el("span",{class:"pill bad",text:`${p.removed} removed`}):null,
      p.kept?el("span",{class:"pill",text:`${p.kept} kept (this site only)`}):null,
      p.off?el("span",{class:"pill",text:`${p.off} stay turned off`}):null);
    const det=p.detail.length?el("details",{},el("summary",{class:"by",style:"cursor:pointer",text:"Show changes"}),el("ul",{},...p.detail.map(([a,l,t])=>el("li",{text:`${a} · ${l}: ${t}`})))):null;
    pv.append(el("div",{style:"display:grid;gap:4px"},head,det));
  }
  pv.append(el("p",{class:"note",text:S.shared?"Checks a site added for itself (marked “This site only” in its setup) are kept. Other checks that aren't in the published list are removed.":"This is the first publish, so each chosen site's opening, closing and end-of-week checks will be replaced by this list. Checks a site has turned off stay off."}));
  const btn=$("#pubGo");pubArmed=false;
  const ready=ids.length&&ids.every(id=>plan.some(p=>p.site===id));
  btn.textContent=`Publish to ${ids.length===1?"the "+siteOf(ids[0]).name:ids.length+" sites"}`;
  btn.disabled=R||!ready||setupDirty;
  $("#pubMsg").textContent=setupDirty?`Save the ${site.name}'s setup first, then publish.`:pubNote;
  $("#pubPanel").hidden=!S.db;
  const sh=S.shared;
  $("#pubLast").textContent=sh&&sh.at?`Last published from the ${siteOf(sh.from).name} to ${(sh.to||[]).map(x=>siteOf(x).name).join(", ")} on ${when(sh.at)} by ${nameOf(sh.by)}.`:"Nothing published yet.";
  if(sh&&sh.by)resolveNames([sh.by]);
}
$("#pubScope").addEventListener("change",()=>{pubNote="";renderPublish()});
$("#pubSite").addEventListener("change",()=>{pubNote="";renderPublish()});
$("#pubGo").addEventListener("click",async()=>{
  const btn=$("#pubGo"),ids=pubTargets();
  if(!ids.length||ro()||setupDirty)return;
  const names=ids.map(id=>siteOf(id).name);
  if(!pubArmed){pubArmed=true;btn.textContent=`Tap again to update ${names.join(", ")}`;setTimeout(()=>{if(pubArmed)renderPublish()},4000);return}
  pubArmed=false;btn.disabled=true;pubNote="Publishing…";$("#pubMsg").textContent=pubNote;
  try{
    const tgts={};
    for(const id of ids){const snap=await D("settings","main",id).get();tgts[id]=normSettings(snap.exists?snap.data():null)}
    const plan=planPublish(tgts),now=Date.now();
    for(const p of plan){
      const next={...storable(tgts[p.site]),...p.lists,updatedBy:S.me,updatedAt:now,publishedAt:now,publishedFrom:S.site};
      if(!next.startDate)next.startDate=today();
      await D("settings","main",p.site).set(next);
    }
    const src=S.settings;
    await S.db.doc("config/shared").set({opening:src.opening.map(c=>({id:c.id,t:c.t})),closing:src.closing.map(c=>({id:c.id,t:c.t})),weekly:src.weekly.map(c=>({id:c.id,t:c.t})),from:S.site,to:ids,by:S.me,at:now});
    pubNote=`Published to ${names.join(", ")}.`;renderPublish();toast("Setup published");
  }catch(e){fail(e);pubNote="Publishing stopped part-way. Check each site's setup, then try again.";renderPublish()}
});

function renderAll(){refreshPickers();renderSites();renderNav();renderHead();renderAddBtn();renderDay();renderWeek();renderHistory();renderTasks("extras");renderTasks("cleaning");renderProve();renderTempLog();renderDeliveries();renderMaint();renderAllergenDocs();renderAllergens();renderPlansList();renderSuppliers();renderContacts();renderStaff();renderOnbList();renderInspList();renderReview();renderSetup();renderInspect()}

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
  document.title=(title?title+" · ":"")+"Kitchen Diary";
}
function applyTabs(){if(S.tab&&!canTab(S.tab))show("day",{quiet:true});else renderNav()}
window.addEventListener("hashchange",()=>{const h=location.hash.slice(1);if(TABS.includes(h))show(h)});
show((()=>{const h=location.hash.slice(1);if(TABS.includes(h))return h;try{const t=localStorage.getItem("sfbb.tab");return TABS.includes(t)?t:"day"}catch(e){return"day"}})(),{quiet:true});

/* ---------- site switching & subscriptions ---------- */
function switchSite(id){
  if(id===S.site)return;
  if((S.plan&&S.plan.dirty)||(S.insp&&S.insp.dirty)||(S.onb&&S.onb.dirty)||setupDirty){toast("Save or discard your changes before switching site.");return}
  if(S.plan)closePlan();if(S.insp)closeInsp();if(S.onb)closeOnb();
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
  sub(D("settings","main",site),x=>{S.settings=normSettings(x.exists?x.data():null);S.cfg=activeCfg(S.settings);fillProve();applyTabs();renderAll()});
  sub(C("days",site).orderBy("date","desc").limit(400),q=>{const m={};for(const d of q.docs)m[d.id]=d.data();S.days=m;renderDay();renderHistory();renderReview();renderTempLog();renderClosures()});
  sub(C("weeks",site).orderBy("week","desc").limit(120),q=>{const m={};for(const d of q.docs)m[d.id]=d.data();S.weeks=m;renderWeek()});
  list("allergens","allergens",renderAllergens);
  list("allergenDocs","allergenDocs",renderAllergenDocs);
  list("reviews","reviews",renderReview,C("reviews",site).orderBy("date","desc").limit(50));
  list("extras","extras",()=>{renderTasks("extras");renderReview()});
  list("cleaning","cleaning",()=>{renderTasks("cleaning");renderReview()});
  list("suppliers","suppliers",()=>{renderSuppliers();renderDeliveries()});
  list("deliveries","deliveries",renderDeliveries,C("deliveries",site).orderBy("at","desc").limit(400));
  list("maintenance","maintenance",renderMaint);
  list("contacts","contacts",renderContacts);
  list("plans","plans",()=>{onPlansSnapshot();renderReview()});
  list("onboarding","onboarding",onOnbSnapshot);
  list("inspections","inspections",()=>{onInspSnapshot();renderReview()});
  list("staff","staff",()=>{renderStaff();renderReview()});
  list("proveit","prove",()=>{renderProve();renderReview()},C("proveit",site).orderBy("at","desc").limit(500));
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
    C("maintenance",x.id).onSnapshot(q=>{sm.maintenance=q.docs.map(d=>({id:d.id,...d.data()}));if(S.tab==="maintenance"&&maintAll)renderMaint()},err);
  }
  S.db.doc("config/shared").onSnapshot(s=>{S.shared=s.exists?s.data():null;if(!setupDirty){SE=setupDraft();buildSetup()}renderPublish()},err);
}

/* ---------- events ---------- */
$("#dayDate").addEventListener("change",e=>{if(e.target.value){S.date=e.target.value;renderDay();renderHead()}});
$("#todayBtn").addEventListener("click",()=>{S.date=today();renderDay();renderHead()});
$("#dayPrev").addEventListener("click",()=>{S.date=addDays(S.date,-1);renderDay();renderHead()});
$("#dayNext").addEventListener("click",()=>{if(S.date<today()){S.date=addDays(S.date,1);renderDay();renderHead()}});
$("#saveProb").addEventListener("click",async()=>{await patchDay(S.date,{problems:{text:$("#problems").value.trim(),...stamp()}});toast("Note saved")});
$("#wkPrev").addEventListener("click",()=>{S.week=addDays(S.week,-7);renderWeek();renderHead()});
$("#wkNext").addEventListener("click",()=>{S.week=addDays(S.week,7);renderWeek();renderHead()});
$("#wkSaveNote").addEventListener("click",async()=>{await patchWeek(S.week,{notes:{text:$("#wkNotes").value.trim(),...stamp()}});toast("Note saved")});
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
  if(mro())return;
  if(REVIEW_QS.some(([k])=>!(S.rev[k]&&S.rev[k].a))){$("#revMsg").textContent="Answer every question before signing.";return}
  const date=today();
  if(await save(()=>D("reviews",date).set({date,answers:S.rev,notes:$("#revNotes").value.trim(),by:S.me,at:Date.now()}))){S.rev={};$("#revNotes").value="";$("#revMsg").textContent="Review signed and saved."}
});
document.querySelectorAll(".note.intro").forEach(n=>{n.setAttribute("title","Tap to read more");n.addEventListener("click",()=>n.classList.toggle("full"))});

/* ---------- boot ---------- */
inspectForm();tempLogForm();closureForm();buildAlgChecks();buildTaskForm("extras");buildTaskForm("cleaning");proveForm();delivForm();maintForm();supForm();conForm();staffForm();editStaff(null);
applyTabs();renderAll();
(async()=>{
  const[db,user,assets]=await Promise.all([window.claude?.use?.("db"),window.claude?.use?.("user"),window.claude?.use?.("assets")]);
  S.db=db||null;S.user=user||null;S.assets=assets||null;
  if(!S.db){$("#offline").hidden=false;S.canWrite=false;renderAll();return}
  if(S.user){
    const me=await S.user.me();S.me=me.id;
    const w=await S.user.can("data.write");if(w===false){S.canWrite=false;$("#readonly").hidden=false}
    S.myName=me.name||"";S.role=me.role||"staff";S.quickPin=!!me.quickPin;S.quickSwitch=!!me.quickSwitch;renderMe();
    if(!canTab(S.tab))show("day",{quiet:true});else renderNav();
    loadTeam();
  }
  subscribeSummaries();
  subscribeSite();
  renderAll();
})();
