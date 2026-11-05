// The team (everyone with an account), Maintenance, and its notifications (the bell).

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
  editMt=m?m.id:null;beginEdit("maintenance",editMt);
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
  const ok=editMt?await save(()=>saveEdited("maintenance",D("maintenance",editMt),v,"update")):await save(()=>C("maintenance").add({...v,status:"open",reportedBy:S.me,reportedAt:Date.now(),log:[]}));
  if(ok){toast(`${editMt?"Saved":"Reported"}: ${title}`);editMaint(null)}
}
// Change who a job is assigned to straight from the list.
async function assignMaint(m,site,id){
  const p=S.team.find(x=>x.id===id),name=id?(p?p.name:nameOf(id)):null;
  const log=logAdd({at:Date.now(),by:S.me,what:id?`Assigned to ${name}`:"Unassigned",note:""});
  if(await save(()=>D("maintenance",m.id,site).update({assignee:id||null,assigneeName:name,log})))toast(id?`${m.title}: assigned to ${id===S.me?"you":name}`:`${m.title}: not assigned`);
}
async function setMaintDone(m,site,done,note){
  const log=logAdd({at:Date.now(),by:S.me,what:done?"Done":"Reopened",note:note||""});
  const v=done?{status:"done",doneBy:S.me,doneAt:Date.now(),fixNote:note||"",log}:{status:"open",doneBy:null,doneAt:null,log};
  if(await save(()=>D("maintenance",m.id,site).update(v)))toast(`${m.title}: ${done?"done":"reopened"}${site!==S.site?" at the "+siteOf(site).name:""}`);
}
/* ---------- notifications: maintenance jobs that need someone's attention ----------
   Worked out here from every site's maintenance jobs (already loaded for Maintenance → All sites), for this person:
   - a job assigned to them (until it's done);
   - managers and admins: every new job (urgent ones marked);
   - whoever reported a job, and managers: when it's done;
   - managers, and whoever it's assigned to: a job still open after a day (urgent) or a week.
   Shown by the bell (with a count), on Maintenance in the menu, and on Today. "Seen up to" is kept per person on
   the server (user.seenNotifications), so reading them on one device clears them on the others. */
const DAY_MS=864e5;
const isMgr=()=>S.role==="manager"||S.role==="admin";
function maintNotifs(){
  const out=[],now=Date.now(),since=now-14*DAY_MS,me=S.me,mgr=isMgr();
  if(!me)return out;
  for(const x of SITES){
    for(const m of (S.sum[x.id]&&S.sum[x.id].maintenance)||[]){
      const open=m.status!=="done",rep=m.reportedAt||m.at||0,urgent=m.priority==="urgent";
      const add=(kind,at,text,cls,ic)=>{if(at&&at>=since&&at<=now)out.push({key:`${kind}:${x.id}:${m.id}`,kind,at,site:x.id,id:m.id,title:m.title||"Maintenance job",text,cls,ic,ids:[m.reportedBy,m.doneBy]})};
      if(open&&m.assignee===me){
        const e=(m.log||[]).find(l=>/^Assigned to /.test(l.what||""));
        if(!e||e.by!==me)add("assigned",e?e.at:rep,`Assigned to you${e?" by "+nameOf(e.by):""} · ${x.name}`,"acc","maintenance");
      }
      if(open&&mgr&&m.reportedBy!==me)add("new",rep,`${urgent?"Urgent · ":""}Reported by ${nameOf(m.reportedBy)} · ${x.name}`,urgent?"bad":"warn","warn");
      if(!open&&m.doneBy!==me&&(m.reportedBy===me||mgr))add("done",m.doneAt,`Done by ${nameOf(m.doneBy)}${m.fixNote?": "+m.fixNote:""} · ${x.name}`,"ok","checkc");
      if(open&&(mgr||m.assignee===me)){const late=urgent?DAY_MS:7*DAY_MS;if(rep&&now-rep>late)add("late",rep+late,`${urgent?"Urgent and still open after a day":"Still open after a week"} · ${x.name}`,"bad","warn")}
    }
  }
  return out.sort((a,b)=>b.at-a.at);
}
const unreadNotifs=()=>maintNotifs().filter(n=>n.at>(S.notifSeen||0));
function renderNotifs(){
  const n=unreadNotifs().length,label=n?`Notifications, ${n} new`:"Notifications";
  const badge=()=>n?el("span",{class:"n",text:n>99?"99+":String(n)}):null;
  const bell=$("#bellBtn");if(bell){bell.replaceChildren(...kids(svgi(ICON.bell),badge()));bell.setAttribute("aria-label",label)}
  const sb=$("#sideBell");if(sb){sb.replaceChildren(...kids(svgi(ICON.bell),el("span",{text:"Notifications"}),badge()));sb.setAttribute("aria-label",label)}
  if(!$("#notifSheet").hidden)fillNotifs();
}
function fillNotifs(){
  const list=maintNotifs(),seen=S.notifSeen0||0,box=$("#notifList");
  resolveNames(list.flatMap(x=>x.ids));
  box.replaceChildren(...(list.length?list.slice(0,40).map(x=>el("button",{class:"lrow",type:"button",onclick:()=>{closeSheets();openMaintJob(x)}},
    el("span",{class:"nic "+x.cls},svgi(ICON[x.ic])),
    el("span",{class:"nt"},el("b",{text:x.title}),el("span",{class:"s",text:x.text}),el("span",{class:"w",text:when(x.at)})),
    x.at>seen?el("span",{class:"unread",role:"img","aria-label":"New"}):null)):[el("div",{class:"empty",text:"Nothing new. Maintenance jobs that need you show up here."})]));
}
function openNotifs(){
  // Show what's new with its dot, then count it as seen (here and on this person's other devices).
  S.notifSeen0=S.notifSeen||0;
  fillNotifs();
  $("#sheetVeil").hidden=false;$("#notifSheet").hidden=false;
  const f=$("#notifList button");if(f)f.focus();
  markNotifsSeen();
}
function markNotifsSeen(){
  const list=maintNotifs();if(!list.length)return;
  const at=Math.max(...list.map(x=>x.at));
  if(at<=(S.notifSeen||0))return;
  S.notifSeen=at;renderNotifs();renderNav();if(S.tab==="day")renderDay();
  if(S.user&&S.user.seenNotifications)S.user.seenNotifications(at).catch(()=>{});
}
// Open the job a notification is about: its site's list (or All sites), with the job opened.
function openMaintJob(x){
  if(x.site!==S.site)maintAll=true;
  xOpen["m"+x.site+x.id]=true;
  show("maintenance");
  requestAnimationFrame(()=>{const r=[...document.querySelectorAll("#mList .xrow.open")].pop();if(r)r.scrollIntoView({block:"center",behavior:"smooth"})});
}

function renderMaint(){
  const box=$("#mList");if(!box)return;box.replaceChildren();const ids=[],R=ro();
  if(S.tab==="maintenance"&&!document.hidden)setTimeout(markNotifsSeen,0); // looking at Maintenance counts as seeing them
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
      sub:[maintAll?siteOf(site).name:"",m.area,!isDone&&m.assignee?`→ ${m.assignee===S.me?"you":m.assigneeName||nameOf(m.assignee)}`:"",isDone?(m.doneAt?`done ${short(iso(new Date(m.doneAt)))}, ${nameOf(m.doneBy)}`:"done"):`reported ${short(iso(new Date(m.reportedAt||m.at||Date.now())))}, ${nameOf(m.reportedBy)}`].filter(Boolean).join(" · "),
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
