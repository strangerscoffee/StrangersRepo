// Today: the day's checks, who's on shift (the rota), needs attention per site, and closures.

/* ---------- today ---------- */
function renderDay(){
  const ae=document.activeElement,keep=ae&&ae.id&&ae.closest&&ae.closest("#units")?{id:ae.id,v:ae.value}:null;
  try{renderDayInner()}finally{if(keep){const n=document.getElementById(keep.id);if(n){n.value=keep.v;n.focus()}}}
  updFab();
}
const stepsOf=(st,temps)=>[["Temps",temps?st.temps==="y":true],["Opening",st.open==="y"],["Closing",st.close==="y"],["Sign off",!!st.signed]];
/* ---------- the rota (rota.staffstrangerscoffee.com): who's on shift today ----------
 * When the site's week is published on the rota, Today lists today's shifts and says who opens and who closes.
 * Nothing changes on Today when there's no published rota. Data from use("rota") in claude-shim.js. */
S.rota=null;S.rotaUrl="/rota/";
async function loadRota(){
  const svc=await window.claude?.use?.("rota");if(!svc)return;
  const site=S.site,r=await svc.today(site).catch(()=>null);
  if(site!==S.site)return;
  if(r){S.rota=r;if(r.rotaUrl)S.rotaUrl=r.rotaUrl}
  renderOnShift();if(S.tab==="day")renderDay();
}
const rotaToday=()=>S.rota&&S.rota.site===S.site&&S.rota.day===today()&&S.date===today()&&S.rota.published?S.rota:null;
// "You're opening", "Priya closes", "Alex and Priya open".
function rotaWho(job){
  const r=rotaToday();if(!r)return "";
  const list=r.shifts.filter(x=>x.job===job&&!x.open);if(!list.length)return "";
  if(list.some(x=>x.me)&&list.length===1)return job==="opens"?"You're opening":"You're closing";
  const names=list.map(x=>x.me?"you":firstName(x.name));
  return names.length===1?`${names[0]} ${job==="opens"?"opens":"closes"}`:`${names.slice(0,-1).join(", ")} and ${names[names.length-1]} ${job==="opens"?"open":"close"}`;
}
function renderOnShift(){
  const box=$("#onShift"),r=rotaToday();
  box.hidden=!r||!r.shifts.length;if(box.hidden)return;
  const jobText={opens:"opening checks",closes:"closing checks and sign-off"};
  box.replaceChildren(el("div",{class:"row spread"},el("h3",{id:"onShiftTitle",text:"On shift today"}),el("a",{class:"linkbtn",href:S.rotaUrl},"Rota")),
    el("div",{class:"list"},...[...r.shifts].sort((a,b)=>a.start.localeCompare(b.start)).map(x=>el("div",{class:"lrow"},
      el("span",{class:"avatar sm",text:x.open?"?":initials(x.name),"aria-hidden":"true"}),
      el("span",{class:"t"},el("b",{text:x.open?"Open shift":x.me?"You":x.name}),el("span",{class:"s",text:[x.actualEnd?`${x.actualStart}–${x.actualEnd} (was ${x.start}–${x.end})`:`${x.start}–${x.end}`,jobText[x.job]].filter(Boolean).join(" · ")})),
      x.job?el("span",{class:"pill "+(x.job==="opens"?"acc":""),text:x.job==="opens"?"Opens":"Closes"}):null))));
}
setInterval(()=>{if(!document.hidden)loadRota()},5*60*1000);
document.addEventListener("visibilitychange",()=>{if(!document.hidden)loadRota()});

function renderDayInner(){
  needHistory(S.date);
  const d=S.days[S.date]||{},s=S.cfg,st=dayStatus(d,s,S.date),R=ro(),isToday=S.date===today();
  renderOnShift();
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
  // New maintenance notifications for this person (two at most; the bell has the rest).
  if(isToday&&S.db){const nn=unreadNotifs();
    // Coloured by what it is: done (green), assigned to you (blue), new or overdue (amber, red when urgent).
    for(const x of nn.slice(0,2))al.append(alertEl(x.title,x.text,["Open",()=>openMaintJob(x)],"notif "+x.cls,x.ic));
    if(nn.length>2)al.append(el("button",{type:"button",class:"alertmore",onclick:openNotifs},svgi(ICON.bell),el("span",{text:`${nn.length-2} more notification${nn.length-2===1?"":"s"}`}),el("span",{class:"go",text:"Show"})));
  }
  const a=isToday&&S.db?siteAttention(S.site):null;
  if(a&&a.unused){
    al.append(alertEl("Not in use yet",`Nothing is counted as missing at the ${curSite().name} until it starts.`,canTab("setup")?["Set up",()=>show("setup")]:null,""));
  }else if(a){
    const alerts=[]; // gathered, then shown below
    if(a.prevDue){const ps=a.pst,gaps=[];if(ps.open!=="y")gaps.push("opening");if(ps.tN<ps.tTot)gaps.push("temps");if(ps.close!=="y")gaps.push("closing");
      alerts.push(alertEl(`${nice(a.prev)} wasn't signed off`,gaps.length?"Still to do: "+gaps.join(", "):"Everything was ticked; it just needs signing",["Open",()=>goDay(a.prev)]))}
    if(tabOn("review")&&S.db&&!S.reviewsLoading){const{due}=reviewPeriod();
      if(due<today())alerts.push(alertEl("4-weekly review overdue",`It was due ${nice(due)}. Look back over the last four weeks and answer the questions.`,R?null:["Do it now",()=>show("review")]))}
    for(const{kind,t,ts}of a.tasks)
      alerts.push(alertEl(t.name,`${kind==="cleaning"?"Cleaning":"Extra check"} · ${(t.freq||"").replace(/^./,c=>c.toUpperCase())} · ${ts.text.toLowerCase()}`,R?null:["Done",()=>completeTask(kind,t,a.id,"")]));
    // Two reminders at most, so today's checks stay near the top; the rest fold under one row.
    const more=alerts.length-2;
    if(more>1&&!S.alertsAll){
      al.append(...alerts.slice(0,2),el("button",{type:"button",class:"alertmore",onclick:()=>{S.alertsAll=true;renderDay()}},
        svgi(ICON.warn),el("span",{text:`${more} more overdue`}),el("span",{class:"go",text:"Show"})));
    }else al.append(...alerts);
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
    const row=el("div",{class:"tf "+cls},el("label",{class:"n",for:id,text:u.name}),el("span",{class:"lim",text:(u.kind==="freezer"?"−18°C or colder":"5°C or below")+(r?` · ${time(r.at)}, ${nameOf(r.by)}`:"")}),el("span",{class:"v"},withMinus(inp),mark));
    const paint=()=>{const c=tempState(u.kind,inp.value===""?null:Number(inp.value));row.className="tf "+c;mark.replaceChildren(c==="ok"?svgi(ICON.check):c==="bad"||c==="warn"?svgi(ICON.warn):"")};
    paint();inp.addEventListener("input",paint);
    inp.addEventListener("change",()=>{
      const raw=inp.value.trim();const val=raw===""?null:Math.round(Number(raw)*10)/10;
      if(raw!==""&&!isFinite(val))return;
      if(inp.dataset.sent===String(val))return; // the − button and leaving the box both send the same reading
      inp.dataset.sent=String(val);
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
  let openDone=false;
  for(const[key,list,card,box,foot,title]of[["opening",checksOn(s.opening,S.date),"#openCard","#openList","#openFoot","Opening checks"],["closing",checksOn(s.closing,S.date),"#closeCard","#closeList","#closeFoot","Closing checks"]]){
    const part=d[key]||{};const items=part.items||{};
    checklist($(box),list,items,key,(cid,v)=>patchDay(S.date,{[key]:{items:{[cid]:v},...stamp(),...(v?{}:{allDone:null})}}));roundChecks($(box));
    if(part.by)ids.push(part.by);if(part.allDone&&part.allDone.by)ids.push(part.allDone.by);
    const n=list.filter(c=>items[c.id]).length,all=list.length>0&&n===list.length;
    checkFoot($(foot),list,items,part,()=>{const set={},back={},date=S.date;for(const c of list){set[c.id]=true;back[c.id]=!!items[c.id]}
      patchDay(date,{[key]:{items:set,...stamp(),allDone:stamp()}});toast(`All ${key} checks done`,["Undo",()=>patchDay(date,{[key]:{items:back,allDone:null}})])});
    const who=rotaWho(key==="opening"?"opens":"closes");
    // On a phone, closing checks wait folded while the opening checks are still to do in the morning.
    const later=key==="closing"&&!n&&S.date===today()&&new Date().getHours()<14&&!openDone&&matchMedia("(max-width:1023px)").matches;
    if(key==="opening")openDone=all;
    secCard($(card),key,all,all?badgeEl("done"):ringEl(n,list.length),title,
      (who?who+" · ":"")+(all?`${n} of ${n}${part.allDone||part.at?` · ${nameOf((part.allDone||part).by)}, ${time((part.allDone||part).at)}`:""}`:n?`${n} of ${list.length} ticked`:key==="closing"?`After close · ${list.length} checks`:`${list.length} checks`),later);
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
    sc.append(...kids(el("span",{class:"big"},svgi(ICON.check)),el("h2",{text:"Day signed off"}),el("span",{class:"s",text:`By ${who} at ${time(d.signed.at)}${on}`}),
      R||S.role==="staff"?null:el("button",{class:"btn ghost sm",type:"button",onclick:()=>patchDay(S.date,{signed:null})},"Undo sign-off")));
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
function alertEl(title,sub,action,cls,ic){
  return el("div",{class:"alert "+(cls==null?"":cls)},el("span",{class:"ic"},svgi(ICON[ic||"warn"])),el("span",{class:"t"},el("b",{text:title}),el("span",{class:"s",text:sub})),
    action?el("button",{class:"btn sm",type:"button",onclick:action[1]},action[0]):null);
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
        if(site===S.site){if(!(await patchDay(date,{closed})))throw new Error("refused")}
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
  // Staff can mark only today closed; reopening a day, or closing an earlier one, is for managers and admins (the Worker checks too).
  const cl=closure(d),R=ro(),staff=S.role==="staff";box.hidden=R||S.date>today()||(staff&&!cl&&S.date!==today());if(box.hidden)return;
  const date=S.date,label=date===today()?"today":nice(date);
  if(cl){box.append(staff?el("p",{class:"note",text:"Only a manager or admin can reopen a closed day."}):el("button",{class:"btn ghost sm",type:"button",onclick:async()=>{if(await save(()=>patchDay(date,{closed:null})))toast(`${nice(date)} reopened`)}},"Reopen this day"));return}
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
