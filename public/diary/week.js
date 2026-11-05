// This week, and the last 4 weeks (history).

/* ---------- week ---------- */
function renderWeek(){
  needHistory(S.week);
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
  const n=list.filter(c=>items[c.id]).length,all=n===list.length; // no end-of-week checks set up: the week can still be signed off
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
    sc.append(...kids(el("span",{class:"big"},svgi(ICON.check)),el("h2",{text:"Week signed off"}),el("span",{class:"s",text:`By ${w.signed.name||nameOf(w.signed.by)} on ${when(w.signed.at)}`}),
      R||S.role==="staff"?null:el("button",{class:"btn ghost sm",type:"button",onclick:()=>patchWeek(wk,{signed:null})},"Undo sign-off")));
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
