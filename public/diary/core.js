// The diary's core, loaded first of public/diary/*.js: constants, helpers (with those from /shared/core.js), the
// state S, sites and per-site paths, rules, writes, saving to several sites, names, list rows, forms, section cards
// and icons. The diary's scripts are classic scripts, so their top-level names share one global scope, in the order
// public/index.html loads them. The page talks to its data only through window.claude (claude-shim.js).

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
const FREQ={"after use":0,"daily":1,"weekly":7,"fortnightly":14,"monthly":30,"quarterly":91,"six-monthly":182,"yearly":365};
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
/* The 4-weekly review (SFBB "4-weekly review" page). [key, question, the answer that needs noting]: most questions
   flag a "Yes" (something changed or went wrong); the "have you done it" ones flag a "No"; null flags neither.
   Keys are stored with each review's answers: never rename or reuse one. */
const REVIEW_QS=[
  ["problems","Were there any problems recorded in the diary this period?","Yes"],
  ["repeat","Did you see any problems on a walk round the kitchen, or has the same problem come up in the diary three times or more?","Yes"],
  ["reviewed","Have you reviewed your safe methods?","No"],
  ["supplier","Have you started using a new supplier or new types of food?","Yes"],
  ["supplierContacts","Have any new suppliers been recorded with their contact details?","No"],
  ["menu","Have you added new menu items, recipes or ways of working?","Yes"],
  ["allergen","Has any allergen information changed?","Yes"],
  ["equipment","Have you got new equipment, or has any broken down?","Yes"],
  ["cleaning","Does the cleaning schedule need updating?","Yes"],
  ["staff","Have new staff started, and have they been trained on the safe methods?","Yes"],
  ["refresher","Do any existing staff need safe method refresher training?","Yes"],
  ["openClose","Are any extra opening or closing checks needed?","Yes"],
  ["complaints","Have any food complaints come in? If so, have they been investigated and the safe methods reviewed?","Yes"],
  ["probes","Have probes been calibrated in the last 4 weeks and the results recorded?","No"],
  ["extrasDone","Have the extra checks been done and recorded each week?","No"],
  ["proveIt","Are Prove it checks being done regularly and recorded?","No"],
  ["pests","Any signs of pests?","Yes"],
  ["methods","Have you updated your safe methods to reflect any changes?",null]];
/* An answer that needs noting: in the review history, the inspection PDF and to open the details box. */
const revFlagged=(q,r)=>q[2]!=null&&!!(r&&r.answers&&r.answers[q[0]]&&r.answers[q[0]].a===q[2]);
/* Sites. The Roastery's records live at the original top-level paths (they were recorded before sites existed);
   every other site keeps its own copy of each collection under sites/<id>/. */
const SITES=[
  {id:"roastery",name:"Roastery",addr:"10 Dove Street, Norwich, NR2 1DE",legacy:true},
  {id:"cafe",name:"Cafe",addr:"21 Pottergate, Norwich, NR2 1DS"},
  {id:"asg",name:"ASG",addr:"14 All Saints Green, Norwich, NR1 3NA"},
  {id:"factory",name:"Factory",addr:"122 Ber Street, Norwich, NR1 3ES"}];
const siteOf=id=>SITES.find(s=>s.id===id)||SITES[0];
const OPT_TABS=[["week","End of week"],["extras","Extra checks"],["cleaning","Cleaning schedule"],["prove","Prove it"],["allergens","Allergens"],["templog","Temperature log"],["deliveries","Deliveries"],["maintenance","Maintenance"],["fire","Fire safety log"],["accidents","Accident book"],["eho","Last EHO inspection report"],["plans","HACCP & risk"],["suppliers","Suppliers"],["contacts","Contacts"],["staff","Staff training"],["onboarding","Onboarding"],["review","4-weekly review"]];
const WEEKDAYS=[[1,"Monday"],[2,"Tuesday"],[3,"Wednesday"],[4,"Thursday"],[5,"Friday"],[6,"Saturday"],[0,"Sunday"]];
const LISTS=[["opening","Opening"],["closing","Closing"],["weekly","End-of-week"]];

// Page helpers shared with the rota and the admin section (public/shared/core.js). Dates are YYYY-MM-DD strings;
// "today", a saved time's day, and times of day are UK time on the server's clock (public/shared/core.js, "the
// time"), whatever the device's clock or time zone says. The arithmetic between dates below is time-zone free.
const {$,el,kids,svgi,initials,signOut}=SC;
const pad=n=>String(n).padStart(2,"0");
const iso=d=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const parse=s=>{const[y,m,d]=s.split("-").map(Number);return new Date(y,m-1,d)};
const addDays=(s,n)=>{const d=parse(s);d.setDate(d.getDate()+n);return iso(d)};
const today=()=>SC.londonToday();
// The UK date and time of day of a saved time (ms).
const UK="Europe/London";
const dayOf=ts=>new Intl.DateTimeFormat("en-CA",{timeZone:UK,year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(ts));
const ukHour=()=>Number(new Intl.DateTimeFormat("en-GB",{timeZone:UK,hour:"2-digit",hourCycle:"h23"}).format(new Date()));
const monday=s=>addDays(s,-((parse(s).getDay()+6)%7));
const nice=s=>s?parse(s).toLocaleDateString("en-GB",{weekday:"short",day:"numeric",month:"short"}):"";
const short=s=>s?parse(s).toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"2-digit"}):"";
const time=ts=>ts?new Date(ts).toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit",timeZone:UK}):"";
const when=ts=>ts?new Date(ts).toLocaleDateString("en-GB",{day:"numeric",month:"short",timeZone:UK})+" "+time(ts):"";
// A task's "last done" date entered by hand has no real time of day, so it shows as a date only.
const lastWhen=(ts,set)=>!ts?"":set?new Date(ts).toLocaleDateString("en-GB",{day:"numeric",month:"short",timeZone:UK,year:dayOf(ts).slice(0,4)===today().slice(0,4)?undefined:"numeric"}):when(ts);
// A short message above the tab bar. With an action (e.g. ["Undo", fn]) it stays longer and shows a button.
const toast=SC.makeToast(2400);

const S={site:(()=>{try{const s=localStorage.getItem("sfbb.site");return SITES.some(x=>x.id===s)?s:"roastery"}catch(e){return"roastery"}})(),
  cfg:null,sum:{},subs:[],allergenDocs:[],assets:null,shared:null,
  db:null,user:null,me:null,canWrite:true,settings:DEFAULT_SETTINGS,days:{},weeks:{},allergens:[],reviews:[],extras:[],cleaning:[],deliveries:[],maintenance:[],fire:[],accidents:[],suppliers:[],contacts:[],plans:[],plan:null,onboarding:[],onb:null,inspections:[],insp:null,staff:[],prove:[],
  date:today(),week:monday(today()),editAlg:null,editStaff:null,names:{},rev:{}};
S.role="";S.myName="";
const ro=()=>!S.canWrite||!S.db;
// Everyone can open the management sections (suppliers, contacts, HACCP & risk, the last inspection, training,
// onboarding, the 4-weekly review); only managers and admins can change them, as the Worker enforces.
const MANAGER_DATA=new Set(["eho","plans","suppliers","contacts","onboarding"]);
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
// Temperature boxes with a minus key. Phone number pads (the iPhone's in particular) have no "-", so freezer
// readings couldn't be typed. Each temperature box is a text box with the decimal pad plus a − button that flips the
// sign (or starts a reading with "-"). A lone "-" or "." left behind is cleared before it's saved.
function withMinus(inp){
  inp.type="text";inp.removeAttribute("step");inp.inputMode="decimal";inp.autocomplete="off";inp.setAttribute("enterkeyhint","done");
  const tidy=()=>{const v=inp.value.trim().replace(/[\u2212\u2013]/g,"-").replace(",",".");if(v!==inp.value)inp.value=v;if(/^-?\.?$/.test(v)&&v)inp.value=""};
  inp.addEventListener("input",()=>{const v=inp.value.replace(/[\u2212\u2013]/g,"-").replace(",",".");if(v!==inp.value)inp.value=v});
  inp.addEventListener("change",tidy);inp.addEventListener("blur",tidy);
  const btn=el("button",{class:"minus",type:"button","aria-label":"Minus: make this reading below zero",title:"Below zero (−)",
    onpointerdown:e=>e.preventDefault(), // keep the keyboard open
    onclick:()=>{if(inp.disabled)return;const v=inp.value.trim();
      inp.value=v.startsWith("-")?v.slice(1):"-"+v;inp.focus();
      const end=inp.value.length;try{inp.setSelectionRange(end,end)}catch(e){}
      inp.dispatchEvent(new Event("input",{bubbles:true}));
      if(isFinite(Number(inp.value))&&/\d/.test(inp.value))inp.dispatchEvent(new Event("change",{bubbles:true}))}},"−");
  return el("span",{class:"signin"},btn,inp);
}
function minusIn(sel){const inp=$(sel);if(!inp||inp.closest(".signin"))return;const ph=document.createComment("");inp.replaceWith(ph);ph.replaceWith(withMinus(inp))}
function tempState(kind,v){
  if(v==null||v===""||!isFinite(Number(v)))return "";
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
  const dueDay=addDays(dayOf(base),days),due=parse(dueDay);
  const left=Math.round((due-parse(today()))/864e5),pre=t.lastAt?"":"Not done yet · ";
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
// Resolves true once saved (or queued offline), false when refused (already shown with fail()), so callers only
// say "saved" when it was. The site is fixed when the change is made, so an Undo tapped after switching site still
// goes to the site it came from.
function patchDoc(col,id,patch,exists,base,site=S.site){
  if(ro())return Promise.resolve(false);
  const ref=D(col,id,site);
  const p=chain.then(async()=>{
    try{if(exists)await ref.update(patch);else await ref.set(Object.assign({},base||{},patch));return true}
    catch(e){if(e&&e.code==="invalid_argument"&&!exists){try{await ref.update(patch);return true}catch(e2){fail(e2);return false}}fail(e);return false}
  });
  chain=p;
  return p;
}
const patchDay=(date,p)=>patchDoc("days",date,p,!!S.days[date],{date});
const patchWeek=(wk,p)=>patchDoc("weeks",wk,p,!!S.weeks[wk],{week:wk});
async function save(fn){if(ro())return false;try{return (await fn())!==false}catch(e){fail(e);return false}}

/* ---------- saving to several sites ----------
   Extra checks, cleaning, HACCP & risk, suppliers, contacts, onboarding and allergens can be saved to more than
   one site. Every copy carries the same linkId and the list of sites it was sent to (sites). Saving again replaces
   the linked copy at each ticked site (found by linkId, or by name for items saved before linking), or adds one
   where there isn't one. Unticking a site leaves its copy alone; Remove only removes the copy at the current site. */
const MULTI_NAME={extras:"name",cleaning:"name",fire:"name",suppliers:"name",contacts:"name",allergens:"name",allergenDocs:"title",plans:"title",onboarding:"title"};
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
/* Several devices at once (docs/runtime-api.md): an editor records which version of the item it opened, and its
   save is refused with "conflict" if someone else changed the item meanwhile, rather than silently replacing their
   change. After a conflict the list shows their version; saving again (from the new version) replaces it. */
const BASE={};
function beginEdit(kind,id,site=S.site){
  const it=id&&(S[kind]||[]).find(x=>x.id===id);
  BASE[kind]=id?{path:D(kind,id,site).path,ver:D(kind,id,site).version(),orig:it?clone(it):null}:null;
}
const baseOpts=kind=>BASE[kind]&&BASE[kind].ver?{ifVersion:BASE[kind].ver}:undefined;
// Saves an edited item. If someone else saved it meanwhile, what this person changed (compared with the copy
// they opened) goes on top of the newer version by itself, unless they both changed the same thing: then the
// save stops with a message, and saving again replaces it.
const BOOKKEEPING=new Set(["id","by","at","updatedAt","updatedBy","createdAt","linkId","sites"]);
async function saveEdited(kind,ref,v,op="set"){
  try{return await(op==="set"?ref.set(v,baseOpts(kind)):ref.update(v,baseOpts(kind)))}
  catch(e){
    const b=BASE[kind];
    if(!(e&&e.code==="conflict"&&e.current&&e.current.exists&&b&&b.orig&&b.path===ref.path))throw e;
    const cur=e.current.data,orig=b.orig,norm=x=>x===""||x===undefined?null:x,same=(x,y)=>JSON.stringify(norm(x))===JSON.stringify(norm(y)); // an empty field and no field are the same
    const mine=Object.fromEntries(Object.entries(v).filter(([k,x])=>BOOKKEEPING.has(k)||!same(x,orig[k])));
    const both=Object.keys(mine).filter(k=>!BOOKKEEPING.has(k)&&!same(cur[k],orig[k])&&!same(cur[k],mine[k]));
    b.ver=e.current.ver;b.orig=clone(cur);
    if(both.length)throw e;
    return op==="set"?ref.set({...cur,...mine},{ifVersion:e.current.ver}):ref.update(mine,{ifVersion:e.current.ver});
  }
}
async function multiSave(kind,sites,data,{editId=null,old=null,patch=false,match=true}={}){
  if(ro())return null;
  const here=S.site,linkId=(old&&old.linkId)||data.linkId||newLinkId();
  sites=[...new Set([here,...(sites||[])])];
  const v={...data,linkId,sites},now=Date.now();
  const nm=MULTI_NAME[kind],names=new Set([v[nm],old&&old[nm]].filter(Boolean).map(normT));
  const ok=await save(()=>editId?(patch?D(kind,editId,here).update(v):saveEdited(kind,D(kind,editId,here),v)):C(kind,here).add(patch?{...v,createdAt:now}:v));
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
  if(e&&e.code==="conflict"){
    for(const k in BASE)if(BASE[k]&&BASE[k].path===e.path&&e.current)BASE[k].ver=e.current.ver;
    toast(e.message||"Someone else changed this on another device just now. Check it and save again.");return}
  if(e&&e.code==="invalid_argument"){S.canWrite=false;$("#readonly").hidden=false;renderAll();return}
  if(e&&e.code==="quota_exceeded"){toast("The diary is full. Ask the owner to clear old entries.");return}
  // The diary's own reason when it refused (for example, only a manager can do that); otherwise the connection.
  toast(e&&e.message&&e.code&&e.code!=="unavailable"?e.message:"Couldn't save. Check your connection and try again.");
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
  // A web:<name> id is the name already; only older u_… ids need looking up, and each only once (this was asked
  // on every redraw, so every poll of every open device sent a request).
  let local=false;
  for(const id of new Set(ids.filter(Boolean)))if(String(id).startsWith("web:")&&S.names[id]===undefined){S.names[id]=String(id).slice(4);local=true}
  ids=[...new Set(ids.filter(id=>id&&S.names[id]===undefined&&!resolveNames.asked.has(id)))];
  if(local&&!ids.length)return;
  if(!S.user||!ids.length)return;
  for(const id of ids)resolveNames.asked.add(id);
  let ps;try{ps=await S.user.profiles(ids)}catch(e){for(const id of ids)resolveNames.asked.delete(id);return}
  if(!ps){for(const id of ids)resolveNames.asked.delete(id);return}
  if(!ps)return; // offline: keep the names already shown
  let changed=false;
  for(const id of ids){const n=(ps[id]&&ps[id].name)||"";if(S.names[id]!==n){S.names[id]=n;changed=true}}
  if(changed)renderAll();
}
resolveNames.asked=new Set();
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
  fire:{panel:"#fFormPanel",add:"Add check",reset:()=>editTask("fire",null)},
  accidents:{panel:"#aFormPanel",add:"Record an accident",reset:()=>editAccident(null)},
  allergens:{panel:"#algFormPanel",add:"Add item",reset:()=>{algNewKind="drink";editAlg(null)}},
  suppliers:{panel:"#sFormPanel",add:"Add supplier",reset:()=>editSupplier(null)},
  contacts:{panel:"#cFormPanel",add:"Add contact",reset:()=>editContact(null)},
  // Staff and managers fill in their own linked training record; admins manage the team's records.
  staff:{panel:"#tFormPanel",get add(){return S.role!=="admin"?"My training record":"Add person"},reset:()=>editStaff(S.role!=="admin"?myStaff():null)},
  maintenance:{panel:"#mFormPanel",add:"Report a job",reset:()=>editMaint(null)}};
const formOpen={};
function setForm(tab,open){
  const f=FORMS[tab],p=$(f.panel);formOpen[tab]=!!open;p.hidden=ro()||(MANAGER_DATA.has(tab)&&mro())||!open;
  if(!p._x){p._x=el("button",{class:"closex",type:"button","aria-label":"Close",onclick:()=>{f.reset();setForm(tab,false)}},"Cancel");p.prepend(p._x)}
  if(tab==="staff"&&S.role!=="admin"&&$("#tMine"))renderStaff();
  if(open&&!p.hidden){p.scrollIntoView({behavior:"smooth",block:"start"});const i=p.querySelector("input[type=text],input:not([type])");if(i)i.focus({preventScroll:true})}
  renderAddBtn();
}
// Things the Add button can start in sections without an add form: one action, or a short menu.
const ADD_ACTIONS={
  plans:()=>S.plan?null:["Add",[["New HACCP plan","plans",()=>newPlan("haccp")],["New risk assessment","review",()=>newPlan("risk")]]],
  onboarding:()=>S.onb||S.role!=="admin"?null:["Add",[["New induction checklist","onboarding",()=>newOnb(true)],["New blank document","doc",()=>newOnb(false)]]],
  eho:()=>S.insp||!inspSorted().length?null:["Add",[["Add inspection","eho",manualInsp]]]};
function renderAddBtn(){
  const b=$("#addBtn");if(!b)return;
  const f=FORMS[S.tab],a=ADD_ACTIONS[S.tab]&&ADD_ACTIONS[S.tab]();
  b.hidden=ro()||(MANAGER_DATA.has(S.tab)&&mro())||(S.tab==="contacts"&&S.role!=="admin")||(f?!!formOpen[S.tab]:!a);if(b.hidden)return;
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
function secCard(card,key,done,mark,title,sub,later){
  const k=key+":"+(key==="weekly"||key==="wknotes"?S.week:S.date);
  // later: not needed yet (closing checks on a phone in the morning), so it starts folded; a tap opens it.
  const open=k in secOpen?secOpen[k]:!done&&!later;
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

const ICON={
  bell:'<path d="M6 16V11a6 6 0 0112 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 004 0"/>',
  checkc:'<circle cx="12" cy="12" r="8.5"/><path d="M8.5 12.3l2.4 2.4 4.6-4.9"/>',
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
  fire:'<path d="M12 21c-3.9 0-6.5-2.6-6.5-6.3 0-3.4 2.3-5.4 3.7-7.8.5 1.7 1.4 2.8 2.6 3.5.3-2.8 1.5-5.4 3.7-7.4.2 3.5 4 6.1 4 11.2 0 4-2.9 6.8-7.5 6.8z"/><path d="M12 21c-1.7 0-2.8-1.2-2.8-2.8 0-1.8 1.6-2.9 2.8-4.7 1.2 1.8 2.8 2.9 2.8 4.7 0 1.6-1.1 2.8-2.8 2.8z"/>',
  accidents:'<rect x="4" y="5" width="16" height="15" rx="3"/><path d="M12 9v7M8.5 12.5h7"/><path d="M9 5V3.5h6V5"/>',
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
