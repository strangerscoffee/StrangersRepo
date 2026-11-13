// Setup (per site) and publishing to other sites.

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

function renderAll(){renderNotifs();refreshPickers();renderSites();renderNav();renderHead();renderAddBtn();renderDay();renderWeek();renderHistory();renderTasks("extras");renderTasks("cleaning");renderTasks("fire");renderAccidents();renderProve();renderTempLog();renderFireLog();renderDeliveries();renderMaint();renderAllergenDocs();renderAllergens();renderPlansList();renderSuppliers();renderContacts();renderStaff();renderOnbList();renderInspList();renderReview();renderSetup();renderInspect()}
