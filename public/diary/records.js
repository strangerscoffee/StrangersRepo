// Records: extra checks and cleaning (task lists), prove it, the temperature log and deliveries.

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
      const dateIn=el("input",{type:"date",id:dateId,max:today(),value:t.lastAt?dayOf(t.lastAt):""});
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

// Logs change one entry at a time on the server (list operations, docs/runtime-api.md), so two devices ticking
// the same task, or a change sent later from offline, both keep their entries.
const logAdd=(...items)=>({$op:"prepend",items,key:"at",order:"desc",max:30});
const logDrop=(...ats)=>({$op:"remove",key:"at",values:ats});
async function completeTask(kind,t,site,note){
  const entry={at:Date.now(),by:S.me,note:note||""};
  const before={lastAt:t.lastAt||null,lastBy:t.lastBy||null,lastSet:!!t.lastSet};
  if(await save(()=>D(kind,t.id,site).update({lastAt:{$op:"max",value:entry.at},lastBy:entry.by,lastSet:false,log:logAdd(entry)})))
    toast(`${t.name}: done${site!==S.site?" at "+siteOf(site).name:""}`,["Undo",()=>save(()=>D(kind,t.id,site).update({...before,log:logDrop(entry.at)}))]);
}

// Delete one entry from a task's history (ticked by mistake, or the wrong date). If it was the latest, the
// task's last-done date goes back to the entry before it, so the next due date is worked out from that.
async function deleteTaskEntry(kind,t,site,i){
  const log=[...(t.log||[])],[gone]=log.splice(i,1);if(!gone)return;
  const before={lastAt:t.lastAt||null,lastBy:t.lastBy||null,lastSet:!!t.lastSet};
  const patch={log:logDrop(gone.at)};
  if(t.lastAt===gone.at||!log.length){const prev=log[0];patch.lastAt=prev?prev.at:null;patch.lastBy=prev?prev.by:null;patch.lastSet=!!(prev&&prev.set)}
  if(await save(()=>D(kind,t.id,site).update(patch)))
    toast(`${t.name}: entry for ${lastWhen(gone.at,gone.set)} deleted`,["Undo",()=>save(()=>D(kind,t.id,site).update({...before,log:logAdd(gone)}))]);
}
// Set the date a task was last carried out by hand, e.g. when it was done but not ticked off at the time.
// Stored at midday on that date (now, if it's today) and marked lastSet so it shows without a time.
async function setTaskDate(kind,t,site,value){
  const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(value||"");
  if(!m){toast("Choose a date first");return}
  const d=new Date(Date.UTC(+m[1],+m[2]-1,+m[3],12)); // midday (UK time is UTC or an hour ahead: the same day)
  const isToday=today()===value;
  if(!isToday&&d>new Date()){toast("That date is in the future");return}
  const at=isToday?Date.now():d.getTime();
  const entry={at,by:S.me,note:"Date entered by hand",set:true};
  const before={lastAt:t.lastAt||null,lastBy:t.lastBy||null,lastSet:!!t.lastSet};
  // A date entered by hand is the task's last-done date, so it goes to the top of the history whatever its date.
  if(await save(()=>D(kind,t.id,site).update({lastAt:at,lastBy:S.me,lastSet:true,log:{$op:"prepend",items:[entry],key:"at",max:30}})))
    toast(`${t.name}: last done ${lastWhen(at,true)}`,["Undo",()=>save(()=>D(kind,t.id,site).update({...before,log:logDrop(entry.at)}))]);
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
  // The same value again a moment later (the − button and leaving the box both send it) is already on its way.
  const key=date+":"+u.id,last=saveReading.last||{};
  if(last.key===key&&last.v===v&&Date.now()-last.at<3000)return true;
  saveReading.last={key,v,at:Date.now()};
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
  needHistory(from);
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
        el("span",{class:"v"},withMinus(inp)),
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
  if([chilled,frozen].some(v=>v!=null&&!isFinite(v))){msg.textContent="Check the temperature: use numbers only, with − for below zero.";return}
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
