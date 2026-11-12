// Management sections: suppliers, HACCP plans & risk assessments, EHO inspections, onboarding, contacts, staff
// training and the 4-weekly review.

// Ownership uses the account's stable id. Display names and legacy personId values never grant access.
const employeeAdmin=()=>S.role==="admin";
const ownsEmployeeRecord=p=>!!S.myUserId&&p?.ownerUserId===S.myUserId;
function employeePicker(select,value=select.value){
  const people=employeeAdmin()?(S.team||[]).filter(p=>p.userId):[];
  select.replaceChildren(el("option",{value:""},"Unreviewed / not linked — admins only"),...people.map(p=>el("option",{value:p.userId},p.name+(p.active===false?" (switched off)":""))));
  if(value&&!people.some(p=>p.userId===value))select.append(el("option",{value},"Linked employee account"));
  select.value=value||"";
}
const privateRecordEditable=d=>!mro()&&(employeeAdmin()||d?.visibility==="shared-business"||d?.visibility==="employee"&&ownsEmployeeRecord(d));
const privacyLabel=d=>d?.visibility==="shared-business"?"Shared business information":d?.visibility==="employee"?"Private employee record":"Admin review needed";
function recordPrivacyFields(prefix,data,onChange=()=>{}){
  const visibility=el("select",{id:prefix+"_visibility"},el("option",{value:""},"Unreviewed — admins only"),el("option",{value:"shared-business"},"Shared business information"),el("option",{value:"employee"},"Private employee record"));
  visibility.value=data.visibility||"";
  const owner=el("select",{id:prefix+"_ownerUserId"});employeePicker(owner,data.ownerUserId);
  const ownerField=el("div",{class:"field",hidden:visibility.value!=="employee"},el("label",{class:"label",for:owner.id,text:"Employee account"}),owner);
  visibility.addEventListener("change",()=>{data.visibility=visibility.value;if(visibility.value==="shared-business")data.ownerUserId=null;else data.ownerUserId=owner.value||null;ownerField.hidden=visibility.value!=="employee";onChange()});
  owner.addEventListener("change",()=>{data.ownerUserId=owner.value||null;onChange()});
  return el("section",{class:"panel"},el("h3",{text:"Who can see this"}),el("div",{class:"fields"},el("div",{class:"field"},el("label",{class:"label",for:visibility.id,text:"Visibility"}),visibility),ownerField),el("p",{class:"note",text:"Shared business information is visible to the team. Private employee records are visible only to the chosen employee and admins. Review the content before sharing."}));
}
function validateRecordPrivacy(data){
  if(!["shared-business","employee"].includes(data.visibility))return "Choose shared business information or a private employee record.";
  if(data.visibility==="employee"&&!data.ownerUserId)return "Choose the employee account for this private record.";
  return "";
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
  editSup=s?s.id:null;beginEdit("suppliers",editSup);$("#sFormTitle").textContent=s?"Edit "+s.name:"Add a supplier";
  for(const[k]of SUP_FIELDS)$("#s_"+k).value=s?(s[k]||""):"";
  $("#sForm")._cancel.hidden=true;$("#sForm")._del.hidden=!s;$("#sForm")._pick.set(s&&s.sites);
  setForm("suppliers",!!s);
}
function renderSuppliers(){
  const box=$("#sList");box.replaceChildren();
  const list=[...S.suppliers].sort((a,b)=>(a.name||"").localeCompare(b.name||""));
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
      el("span",{class:"t"},el("b",{text:d.title||PL_NAME[d.type]||"HACCP plan"}),el("span",{class:"s",text:[PL_NAME[d.type]||"HACCP plan",summary,d.updatedAt?`updated ${when(d.updatedAt)}, ${nameOf(d.updatedBy)}`:""].filter(Boolean).join(" · ")})),
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
  const P=S.plan,d=P.doc,R=mro(),box=$("#planEditView");
  if(!PL_META[d.type])d.type="haccp"; // an older document with no type opens as a HACCP plan
  const k=d.type;
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
  box.replaceChildren(...kids(
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
     :el("div",{class:"savebar"},el("span",{class:"pill",id:"plSaveState"}),el("div",{class:"row",style:"gap:8px"},del,el("button",{class:"btn",id:"plSaveBtn",onclick:savePlan},"Save changes")))));
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
  if(mro()||!employeeAdmin())return;
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
  // Choose visibility before creating a document; unreviewed content never becomes shared by default.
  openOnb(null,d,"edit");S.onb.dirty=true;obSaveBar();
}
function renderOnbList(){
  const box=$("#obList");box.replaceChildren();const ids=[];
  const list=[...S.onboarding].sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));
  if(!list.length)box.append(el("div",{class:"empty",text:employeeAdmin()?"No onboarding documents yet. Tap Add to start a document and choose its visibility.":"No shared business documents or private documents linked to your account."}));
  for(const d of list){
    ids.push(d.updatedBy);const rs=reviewState(d);
    box.append(el("button",{class:"lrow",type:"button",onclick:()=>openOnb(d.id,null,"view")},el("span",{class:"tile indigo"},svgi(ICON.onboarding)),
      el("span",{class:"t"},el("b",{text:d.title||"Untitled document"}),el("span",{class:"s",text:[d.category,privacyLabel(d),d.audience?"for "+d.audience:"",d.updatedAt?`updated ${when(d.updatedAt)}, ${nameOf(d.updatedBy)}`:""].filter(Boolean).join(" · ")})),
      d.reviewDate?el("span",{class:"pill "+rs.cls,text:rs.text}):null,el("span",{class:"chev"},svgi(ICON.chevR))));
  }
  renderAddBtn();resolveNames(ids);
}
function openOnb(id,data,mode){
  const p=data||S.onboarding.find(x=>x.id===id);if(!p)return;
  beginEdit("onboarding",id);S.onb={id,doc:clone(p),baseAt:p.updatedAt,dirty:false,remote:false,mode:!privateRecordEditable(p)?"view":(mode||"view")};
  $("#obListView").hidden=true;$("#obEditView").hidden=false;renderOnbEditor();window.scrollTo({top:0});renderAddBtn();
}
function closeOnb(){S.onb=null;BASE.onboarding=null;$("#obEditView").hidden=true;$("#obEditView").replaceChildren();$("#obListView").hidden=false;renderOnbList()}
function obDirty(){if(S.onb&&!S.onb.dirty){S.onb.dirty=true;obSaveBar()}}
function obSaveBar(){
  const P=S.onb;if(!P)return;
  const st=$("#obSaveState"),btn=$("#obSaveBtn"),back=$("#obBack");
  if(st){st.textContent=P.dirty?"Unsaved changes":`Saved ${when(P.doc.updatedAt)}`;st.className="pill "+(P.dirty?"warn":"ok")}
  if(btn)btn.disabled=!P.dirty||!privateRecordEditable(P.doc);
  if(back&&back.dataset.armed!=="1")back.textContent="← All documents";
  const rb=$("#obRemote");if(rb)rb.hidden=!P.remote;
}
function renderOnbEditor(){
  const P=S.onb,d=P.doc,R=!privateRecordEditable(d),edit=P.mode==="edit"&&!R,box=$("#obEditView");
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
      ...(employeeAdmin()?[recordPrivacyFields("ob",d,obDirty)]:[]),
      el("section",{class:"panel"},title,d.source?el("div",{class:"by",text:"Converted from "+d.source}):null,meta,
        el("div",{class:"field"},el("label",{class:"label",for:"ob_summary",text:"Summary"}),summary)),
      el("section",{class:"panel"},el("div",{class:"row spread"},el("h2",{text:"Sections"}),el("button",{class:"btn ghost sm",onclick:()=>{d.sections.push({heading:"",body:""});obDirty();renderOnbEditor()}},"Add section")),
        el("p",{class:"note",text:"Start a line with - for a bullet point, 1. for a numbered step, or [ ] for a tick box. Leave a blank line between paragraphs."}),secs),
      el("section",{class:"panel"},el("label",{class:"label",for:"ob_notes",text:"Notes and sign-off"}),notes)];
    requestAnimationFrame(()=>secs.querySelectorAll("textarea").forEach(grow));
  }else{
    const view=el("div",{class:"docview"});
    view.append(el("div",{class:"label",text:[d.category||"Document",privacyLabel(d)].join(" · ")}),el("h2",{text:d.title||"Untitled document"}));
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
  del.hidden=!employeeAdmin()&&d.visibility!=="shared-business";
  armDelete(del,"Delete document",async()=>{if(await save(()=>D("onboarding",P.id).delete())){closeOnb();toast("Document deleted")}});
  const hist=(d.history||[]).slice(0,10);
  const pick=sitePicker("ob_sites");pick.set(d.sites);pick.onChange=()=>{d.sites=pick.get();obDirty()};P.pick=pick;
  box.replaceChildren(...kids(
    el("div",{class:"row spread"},back,el("div",{class:"row",style:"gap:8px"},el("span",{class:"pill",text:d.category||"Document"}),toggle)),
    remote,...main,
    R||!employeeAdmin()?null:el("section",{class:"panel"},pick.el),
    el("section",{class:"panel"},el("h3",{text:"History"}),
      hist.length?el("div",{},...hist.map(h=>el("div",{class:"by",text:`${when(h.at)} · ${h.what} · ${nameOf(h.by)}`}))):el("div",{class:"by",text:"No history yet."})),
    R?el("div",{class:"note",text:"You can read this document but not edit it."})
     :el("div",{class:"savebar"},el("span",{class:"pill",id:"obSaveState"}),el("div",{class:"row",style:"gap:8px"},del,el("button",{class:"btn",id:"obSaveBtn",onclick:saveOnb},"Save changes")))));
  obSaveBar();
  resolveNames(hist.map(h=>h.by));
}
async function saveOnb(){
  const P=S.onb;if(!P||!P.dirty||!privateRecordEditable(P.doc))return;
  const d=P.doc,now=Date.now();
  if(employeeAdmin()){const error=validateRecordPrivacy(d);if(error){toast(error);return}}
  d.sections=(d.sections||[]).filter(s=>(s.heading||"").trim()||(s.body||"").trim());
  d.updatedBy=S.me;d.updatedAt=now;
  d.history=[{by:S.me,at:now,what:"Edited"},...(d.history||[])].slice(0,20);
  d.linkId=d.linkId||newLinkId();d.sites=P.pick?P.pick.get():[S.site];
  const body=clone(d);
  if(JSON.stringify(body).length>250000){toast("This document is too large to save. Split it into two documents.");return}
  P.baseAt=now;
  const r=employeeAdmin()?await multiSave("onboarding",d.sites,body,{editId:P.id,old:S.onboarding.find(x=>x.id===P.id),match:false}):await save(()=>saveEdited("onboarding",D("onboarding",P.id),body));
  if(r){const isNew=!P.id;P.dirty=false;P.remote=false;obSaveBar();toast(employeeAdmin()?`Saved${r.where}.${r.warn}`:"Saved");if(isNew)closeOnb()}
}
function onOnbSnapshot(){
  renderOnbList();
  const P=S.onb;if(!P)return;
  if(!P.id)return;
  const p=S.onboarding.find(x=>x.id===P.id);
  if(!p){if(!P.dirty||!employeeAdmin()){closeOnb();toast(employeeAdmin()?"That document was deleted.":"This document is no longer available to your account.")}return}
  if(p.updatedAt!==P.baseAt){
    if(!P.dirty){S.onb={id:P.id,doc:clone(p),baseAt:p.updatedAt,dirty:false,remote:false,mode:P.mode};renderOnbEditor()}
    else{P.remote=true;obSaveBar()}
  }
}
window.addEventListener("beforeunload",e=>{if(S.onb&&S.onb.dirty){e.preventDefault();e.returnValue=""}});

/* ---------- contacts ---------- */
const CON_TYPES=["Local council / environmental health","Pest control","Fridge & freezer engineer","Coffee machine technician","Equipment repairs","Gas engineer","Electrician","Plumber","Water supplier","Electricity supplier","Waste collection","Landlord / building manager","Insurance","Doctor / NHS 111","Key holder / manager","Other"];
const CON_FIELDS=[["type","Type","select"],["name","Name or company","text","e.g. City council food safety team"],["person","Contact person","text",""],["phone","Phone","tel",""],["outOfHours","Out-of-hours / emergency number","tel",""],["email","Email","email",""],["account","Account or reference number","text","e.g. contract no. for pest control"],["notes","Notes","text","e.g. Visits monthly; call for any sighting"]];
let editCon=null,contactPrivacy={};
function conForm(){
  const box=$("#cForm");const f=el("div",{class:"fields"});
  const privacy=el("div",{id:"cPrivacy"});
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
    const old=editCon?S.contacts.find(x=>x.id===editCon):null;
    if(!employeeAdmin()&&!privateRecordEditable(old))return;
    const v={};for(const[k]of CON_FIELDS)v[k]=$("#c_"+k).value.trim();
    if(!v.name){msg.textContent="Add a name or company first.";return}
    if(!v.phone&&!v.email&&!v.outOfHours){msg.textContent="Add a phone number or email so people can reach them.";return}
    v.by=S.me;v.at=Date.now();
    if(employeeAdmin()){const error=validateRecordPrivacy(contactPrivacy);if(error){msg.textContent=error;return}Object.assign(v,contactPrivacy)}
    const r=employeeAdmin()?await multiSave("contacts",pick.get(),v,{editId:editCon,old,match:false}):await save(()=>saveEdited("contacts",D("contacts",editCon),v,"update"));
    if(r){msg.textContent="";toast(employeeAdmin()?`Saved ${v.name}${r.where}.${r.warn}`:`Saved ${v.name}`);editContact(null)}
  }},"Save contact");
  const pick=sitePicker("c_sites");
  box.append(privacy,f,pick.el,el("div",{class:"row"},saveBtn,cancel,del,msg));box._cancel=cancel;box._del=del;box._msg=msg;box._pick=pick;
}
function editContact(c,typeOnly){
  if(S.role&&S.role!=="admin"&&(!c||!privateRecordEditable(c))){editCon=null;contactPrivacy={};BASE.contacts=null;setForm("contacts",false);return}
  editCon=c?c.id:null;beginEdit("contacts",editCon);$("#cFormTitle").textContent=c?"Edit "+c.name:"Add a contact";
  contactPrivacy={visibility:c?.visibility||"",ownerUserId:c?.ownerUserId||null};
  $("#cPrivacy").replaceChildren(...(employeeAdmin()?[recordPrivacyFields("c",contactPrivacy)]:[]));
  for(const[k]of CON_FIELDS)$("#c_"+k).value=c?(c[k]||(k==="type"?"Other":"")):(k==="type"?(typeOnly||CON_TYPES[0]):"");
  $("#cForm")._cancel.hidden=true;$("#cForm")._del.hidden=!c||!employeeAdmin()&&c.visibility!=="shared-business";$("#cForm")._pick.set(c&&c.sites);
  $("#cForm")._pick.el.hidden=!employeeAdmin();
  setForm("contacts",!!(c||typeOnly));
}
function copyBtn(text){
  return el("button",{class:"btn ghost sm",onclick:async e=>{
    try{await navigator.clipboard.writeText(text);toast("Copied "+text)}
    catch(_){const r=document.createRange();r.selectNodeContents(e.target.previousSibling);const s=getSelection();s.removeAllRanges();s.addRange(r);toast("Number selected")}
  }},"Copy");
}
function renderContacts(){
  if(!employeeAdmin()&&editCon&&!S.contacts.some(c=>c.id===editCon&&privateRecordEditable(c))){
    editContact(null);for(const[k]of CON_FIELDS)$("#c_"+k).value="";
    toast("This contact is no longer available to your account.");
  }
  const box=$("#cList");box.replaceChildren();
  const order=t=>{const i=CON_TYPES.indexOf(t);return i<0?99:i};
  const list=[...S.contacts].sort((a,b)=>order(a.type)-order(b.type)||(a.name||"").localeCompare(b.name||""));
  if(!list.length)box.append(el("div",{class:"empty glass",text:employeeAdmin()?"No contacts yet. Add a contact and choose who can see it.":"No shared business contacts or private contacts linked to your account."}));
  const row=c=>xrow("c"+c.id,{
    title:c.name,sub:[c.person,c.type,privacyLabel(c)].filter(Boolean).join(" · "),
    right:[callBtn(c.outOfHours||c.phone,"Call "+c.name)],
    details:[xfacts([["Phone",c.phone?telLink(c.phone):""],["Out of hours",c.outOfHours?telLink(c.outOfHours):""],["Email",c.email?el("a",{href:"mailto:"+c.email,text:c.email}):""],["Reference",c.account],["Notes",c.notes]]),
      !privateRecordEditable(c)?null:el("div",{class:"row"},el("button",{class:"btn ghost sm",type:"button",onclick:()=>editContact(c)},"Edit contact"))]});
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
  $("#cSuggestPanel").hidden=mro()||!employeeAdmin()||!missing.length;
  $("#cFormPanel").hidden=mro()||!formOpen.contacts;
}

/* ---------- staff training ---------- */
// The training topics this site uses: Setup's trainingOff lists the ones it doesn't need.
// Dates already recorded for a switched-off topic are kept, just not shown or counted.
const siteTopics=()=>TOPICS.filter(([k])=>!S.settings.trainingOff.includes(k));
// Staff and managers fill in their own account-linked record; admins manage all records.
const isMine=ownsEmployeeRecord;
const myStaff=()=>S.staff.find(isMine)||null;
const canEditStaff=p=>!ro()&&(employeeAdmin()||isMine(p));
// The topics a signature covers: those with a date, with the date, so changing any date needs a new signature.
const signKey=topics=>Object.keys(topics||{}).filter(k=>topics[k]&&topics[k].date).sort().map(k=>k+"="+topics[k].date).join(",");
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
    const old=S.editStaff?S.staff.find(x=>x.id===S.editStaff):null;
    const name=!employeeAdmin()?(old?.name||S.myName):$("#tName").value.trim();if(!name){$("#tMsg").textContent="Add the person's name first.";return}
    if(!employeeAdmin()&&!S.myUserId)return;
    const sites=boxes().filter(b=>b.checked).map(b=>b.dataset.site);
    if(!sites.length){$("#tMsg").textContent="Tick at least one site to save to.";return}
    if(old&&!canEditStaff(old))return;
    const ownerUserId=employeeAdmin()?$("#tOwnerUserId").value||null:S.myUserId;
    const topics={};
    for(const[k]of TOPICS){const d=$("#tt_"+k).value;if(d){const prev=old&&old.topics&&old.topics[k];topics[k]=prev&&prev.date===d?prev:{date:d,by:S.me}}}
    const personId=(old&&old.personId)||("p"+Date.now().toString(36)+Math.random().toString(36).slice(2,6));
    // Signing: the person confirms the dates on their own record. A signature stays only while those dates are unchanged.
    const own=!!ownerUserId&&ownerUserId===S.myUserId,sign=own&&$("#tSign").checked;
    if(!employeeAdmin()&&Object.keys(topics).length&&!sign){$("#tMsg").textContent="Tick the box to sign your training record.";$("#tSign").focus();return}
    const signed=sign?{by:S.me,name:S.myName,at:Date.now(),topics:signKey(topics)}:(old&&old.signed&&old.signed.topics===signKey(topics)?old.signed:null);
    const v={name,role:$("#tRole").value.trim(),start:$("#tStart").value,topics,notes:$("#tNotes").value.trim(),personId,sites,signed,ownerUserId,at:Date.now()};
    const editId=S.editStaff,here=S.site;
    $("#tSave").disabled=true;$("#tMsg").textContent="Saving…";
    const done=[];
    for(const site of sites){
      const ok=await save(async()=>{
        if(site===here&&editId)return saveEdited("staff",D("staff",editId,site),v);
        const snap=await C("staff",site).get();
        const m=snap.docs.find(d=>{const x=d.data()||{};return ownerUserId?x.ownerUserId===ownerUserId:!x.ownerUserId&&x.personId===personId});
        if(m)return D("staff",m.id,site).set(v);
        return ownerUserId?D("staff","employee-"+ownerUserId,site).set(v,{ifVersion:0}):C("staff",site).add(v);
      });
      if(ok)done.push(siteOf(site).name);
    }
    $("#tSave").disabled=ro();
    if(done.length){editStaff(null);$("#tMsg").textContent="";toast(`Saved ${name} to ${done.join(", ")}`+(done.length<sites.length?". Some sites couldn't be saved; try again.":""))}
    else $("#tMsg").textContent="Couldn't save the training record. Check your connection and try again. Your changes are still here.";
  });
  $("#tCancel").addEventListener("click",()=>editStaff(null));
  $("#tMineGo").addEventListener("click",()=>{editStaff(myStaff());setForm("staff",true)});
  armDelete($("#tDelete"),"Remove person",async()=>{if(employeeAdmin()&&await save(()=>D("staff",S.editStaff).delete())){editStaff(null);toast("Removed")}});
  $("#tOwnerUserId").addEventListener("change",()=>{
    if(!employeeAdmin())return;
    const selected=(S.team||[]).find(p=>p.userId===$("#tOwnerUserId").value);
    if(!S.editStaff&&!$("#tName").value&&selected)$("#tName").value=selected.name;
    const own=$("#tOwnerUserId").value===S.myUserId;$("#tSignBox").hidden=!own;if(!own)$("#tSign").checked=false;
  });
}
function editStaff(p){
  const staff=!employeeAdmin();
  S.editStaff=p?p.id:null;beginEdit("staff",S.editStaff);$("#tFormTitle").textContent=staff?"My training record":p?"Edit "+p.name:"Add a staff member";
  $("#tName").value=p?p.name:staff?S.myName:"";$("#tName").readOnly=staff;$("#tRole").value=p?(p.role||""):"";$("#tStart").value=p?(p.start||""):"";$("#tNotes").value=p?(p.notes||""):"";
  employeePicker($("#tOwnerUserId"),p?.ownerUserId||"");$("#tOwnerField").hidden=!employeeAdmin();
  for(const[k]of TOPICS)$("#tt_"+k).value=p&&p.topics&&p.topics[k]?p.topics[k].date:"";
  $("#tAllDate").value="";
  const on=p&&Array.isArray(p.sites)&&p.sites.length?p.sites:[S.site];
  document.querySelectorAll("#tSites input[data-site]").forEach(b=>b.checked=on.includes(b.dataset.site)||b.dataset.site===S.site&&!!p);
  $("#ts_all").checked=[...document.querySelectorAll("#tSites input[data-site]")].every(b=>b.checked);
  // Sign-off is for the person themself: shown on your own record (or a new one in your name).
  const own=staff||isMine(p);$("#tSignBox").hidden=!own;
  $("#tSign").checked=!!(own&&p&&p.signed&&p.signed.topics===signKey(p.topics));
  $("#tCancel").hidden=true;$("#tDelete").hidden=!p||staff;
  setForm("staff",!!p);
}
// Record that someone was trained on one topic today.
async function trainedToday(p,k){
  if(!canEditStaff(p))return;
  const topics={...(p.topics||{}),[k]:{date:today(),by:S.me}};
  // A new date isn't covered by the person's signature: they sign again from their record.
  if(await save(()=>D("staff",p.id).update({topics,signed:null})))toast(`${p.name}: ${TOPICS.find(t=>t[0]===k)[1]} recorded`);
}
// Untick a topic and it's no longer shown or counted at this site. Saved straight to the site's settings.
async function setTopicOff(k,on){
  if(!employeeAdmin())return;
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
  const have=new Set(S.staff.map(x=>x.ownerUserId).filter(Boolean));
  const unlinkedNames=new Set(S.staff.filter(x=>!x.ownerUserId).map(x=>normT(x.name)));
  const missing=S.team.filter(p=>p.userId&&p.active!==false&&!have.has(p.userId)&&!unlinkedNames.has(normT(p.name)));
  panel.hidden=ro()||!S.db||!missing.length||!employeeAdmin();
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
      const there=new Set(existing.map(x=>x.ownerUserId).filter(Boolean));
      for(const p of people){
        if(there.has(p.userId))continue;
        const rec={name:p.name,role:"",start:"",topics:{},notes:"",personId:"p"+Date.now().toString(36)+Math.random().toString(36).slice(2,6),ownerUserId:p.userId,sites,at:Date.now()};
        try{await D("staff","employee-"+p.userId,site).set(rec,{ifVersion:0});if(site===S.site)added++}catch(e){if(!fails.includes(siteOf(site).name))fails.push(siteOf(site).name)}
      }
    }
    $("#tImpMsg").textContent=fails.length?`Couldn't add everyone at the ${fails.join(", ")}. Try again.`:"";
    toast(`Added ${people.length} ${people.length===1?"person":"people"} to the staff list${sites.length>1?" at all four sites":""}`);
  };
}
function renderStaff(){
  if(!employeeAdmin()&&S.editStaff&&!S.staff.some(p=>p.id===S.editStaff&&isMine(p))){editStaff(null);toast("This training record is no longer available to your account.")}
  renderStaffImport();
  $("#tOwnerField").hidden=!employeeAdmin();
  for(const id of ["#tOwnerUserId","#c_ownerUserId","#ob_ownerUserId"]){const select=$(id);if(select)employeePicker(select)}
  const TOPICS=siteTopics();
  for(const n of document.querySelectorAll("#tTopics [data-topic]"))n.hidden=!TOPICS.some(([k])=>k===n.dataset.topic);
  const tb0=$("#tTopicToggles");tb0.replaceChildren();
  for(const[k,lbl]of ALL_TOPICS){
    const id="tto_"+k,cb=el("input",{type:"checkbox",id,disabled:!employeeAdmin()||ro()});cb.checked=TOPICS.some(t=>t[0]===k);
    cb.addEventListener("change",()=>setTopicOff(k,cb.checked));
    tb0.append(el("label",{for:id},cb,lbl));
  }
  $("#tTopicsPanel").hidden=!employeeAdmin()||ro();
  const list=S.staff.filter(p=>employeeAdmin()||isMine(p)).sort((a,b)=>(a.name||"").localeCompare(b.name||""));
  const todo=p=>TOPICS.filter(([k])=>!(p.topics&&p.topics[k]));
  const full=list.filter(p=>!todo(p).length).length,gaps=list.length-full;
  const stat=(n,l,c)=>el("div",{class:"stat glass"},el("b",{class:c||"",text:n}),el("span",{text:l}));
  $("#tStats").replaceChildren(stat(String(list.length),list.length===1?"person":"people"),stat(String(full),"fully trained","ok"),stat(String(gaps),"training to do",gaps?"warn":"ok"));
  $("#tStats").hidden=!list.length||!employeeAdmin();
  const box=$("#tList");box.replaceChildren();
  if(!list.length)box.append(el("div",{class:"empty",text:!employeeAdmin()?"No training record is linked to your account at this site. If you already have a record, ask an admin to link it before creating another.":"No training records yet. Add and link each employee's record."}));
  const mine=myStaff(),mp=$("#tMine");
  mp.hidden=employeeAdmin()||ro()||formOpen.staff||!!(mine&&mine.signed&&mine.signed.topics===signKey(mine.topics)&&!siteTopics().some(([k])=>!(mine.topics&&mine.topics[k])));
  if(!mp.hidden)$("#tMineText").textContent=mine?"Fill in any training dates still missing, choose the sites you work at, and sign your record.":"Add your training record: the dates you were trained, the sites you work at, and your signature.";
  for(const p of list){
    const left=todo(p),done=TOPICS.length-left.length;
    box.append(xrow("t"+p.id,{
      lead:ringEl(done,TOPICS.length),title:p.name,
      sub:[p.role,!p.ownerUserId?"Unlinked — admins only":"",left.length?`${left.length} to do`:"All training done",Object.keys(p.topics||{}).length?(p.signed&&p.signed.topics===signKey(p.topics)?"Signed":"Not signed"):""].filter(Boolean).join(" · "),
      right:[left.length?el("span",{class:"pill warn",text:`${done}/${TOPICS.length}`}):el("span",{class:"pill ok",text:"Trained"})],
      details:[el("ul",{class:"topics"},...TOPICS.map(([k,l])=>{const t=p.topics&&p.topics[k];
          return el("li",{class:t?"on":""},el("span",{class:"badge "+(t?"done":"")},t?svgi(ICON.check):""),el("span",{class:"t"},el("b",{text:l}),el("span",{class:"s",text:t?"Trained "+short(t.date):"Not yet"})),
            t||!canEditStaff(p)?null:el("button",{class:"btn ghost sm",type:"button",onclick:()=>trainedToday(p,k)},"Trained today"))})),
        xfacts([["Started",p.start?short(p.start):""],["Sites",Array.isArray(p.sites)&&p.sites.length?p.sites.map(x=>siteOf(x).name).join(", "):""],
          ["Signed",p.signed&&p.signed.topics===signKey(p.topics)?`${p.signed.name||nameOf(p.signed.by)}, ${short(dayOf(p.signed.at))}`:(Object.keys(p.topics||{}).length?"Not signed yet":"")],["Notes",p.notes]]),
        canEditStaff(p)?el("div",{class:"row"},el("button",{class:"btn ghost sm",type:"button",onclick:()=>editStaff(p)},isMine(p)&&!employeeAdmin()?"Fill in and sign":"Edit record")):null]}));
  }
  const mx=$("#tMatrix");mx.replaceChildren();
  if(list.length){
    const head=el("tr",{},el("th",{text:"Name"}),...TOPICS.map(([,l])=>el("th",{class:"al",text:l})));
    const tb=el("tbody");
    for(const p of list)tb.append(el("tr",{},el("td",{},el("b",{text:p.name}),el("div",{class:"by",text:p.role||""})),
      ...TOPICS.map(([k])=>{const t=p.topics&&p.topics[k];return el("td",{class:"dt"+(t?"":" no"),text:t?short(t.date):"–"})})));
    mx.append(el("div",{class:"scroll"},el("table",{class:"matrix"},el("thead",{},head),tb)));
  }
  mx.closest("section").hidden=!list.length||!employeeAdmin();
  $("#tFormPanel").hidden=ro()||!formOpen.staff;
}

/* ---------- review ---------- */
function reviewPeriod(){
  const last=S.reviews[0];
  const start=last?last.date:(S.settings.startDate||Object.keys(S.days).sort()[0]||today());
  return{start,due:addDays(start,28)};
}
function renderReview(){
  const{start,due}=reviewPeriod();const t=today();
  if(S.tab==="review")needHistory(start); // the counts below go back to the last review
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
  for(const[k,q,flag]of REVIEW_QS){
    const cur=S.rev[k]||{};
    const seg=el("div",{class:"seg",role:"group","aria-label":q});
    for(const v of["Yes","No"])seg.append(el("button",{type:"button","aria-pressed":String(cur.a===v),disabled:ro(),onclick:()=>{S.rev[k]={...cur,a:v};renderReview()}},v));
    const det=el("input",{type:"text",id:"rq_"+k,placeholder:"Details (what changed, what you did)",value:cur.d||"",disabled:ro()});
    det.addEventListener("input",()=>{S.rev[k]={...(S.rev[k]||{}),d:det.value}});
    qs.append(el("div",{class:"qa"},el("div",{class:"row spread"},el("span",{text:q}),seg),(flag?cur.a===flag:cur.a==="Yes")||cur.d?det:null));
  }
  $("#revSave").disabled=ro();$("#revNotes").disabled=ro();

  const list=$("#revList");list.replaceChildren();
  if(!S.reviews.length)list.append(el("div",{class:"empty",text:"No reviews signed yet. Your first one is due "+nice(due)+"."}));
  for(const r of S.reviews){
    const yes=REVIEW_QS.filter(q=>revFlagged(q,r));
    list.append(el("div",{class:"qa"},
      el("div",{class:"row spread"},el("strong",{text:nice(r.date)}),el("span",{class:"by",text:"Signed by "+nameOf(r.by)})),
      el("div",{class:"note",text:yes.length?"To note: "+yes.map(([k,q])=>`${q} ${r.answers[k].a}`+(r.answers[k].d?` (${r.answers[k].d})`:"")+".").join(" "):"Nothing to note."}),
      r.notes?el("div",{class:"note",text:"Actions: "+r.notes}):null));
  }
  resolveNames(S.reviews.map(r=>r.by));
}

/* ---------- accident book ----------
   Injuries (and near misses) at this site, to staff, customers or anyone else. Private records: the Worker shows an
   entry only to admins and to whoever recorded it (ownerUserId, src/employeePrivacy.ts), saves them online only,
   and only admins remove one (kept at least 3 years). Fields follow the HSE accident book. */
const ACC_FIELDS=[["date","aDate"],["time","aTime"],["place","aPlace"],["person","aPerson"],["personType","aType"],["contact","aContact"],["what","aWhat"],["injury","aInjury"],["firstAid","aFirstAid"],["hospital","aHospital"],["timeOff","aTimeOff"],["witnesses","aWitnesses"],["action","aAction"],["riddor","aRiddor"],["riddorDate","aRiddorDate"],["riddorRef","aRiddorRef"]];
const ACC_DEFAULTS={personType:"Employee",hospital:"No",timeOff:"None",riddor:"Not reportable"};
let editAcc=null;
function accidentForm(){
  $("#aSave").addEventListener("click",saveAccident);
  $("#aRiddor").addEventListener("change",accRiddorFields);
  armDelete($("#aDelete"),"Remove entry",async()=>{if(await save(()=>D("accidents",editAcc).delete())){editAccident(null);toast("Entry removed")}});
}
function accRiddorFields(){const on=$("#aRiddor").value==="Reported to the HSE";$("#aRiddorDateF").hidden=!on;$("#aRiddorRefF").hidden=!on}
function editAccident(a){
  editAcc=a?a.id:null;beginEdit("accidents",editAcc);
  $("#aFormTitle").textContent=a?"Edit accident entry":"Record an accident";
  for(const[k,id]of ACC_FIELDS)$("#"+id).value=a?(a[k]||ACC_DEFAULTS[k]||""):(k==="date"?today():ACC_DEFAULTS[k]||"");
  if(!a)$("#aTime").value=new Date().toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit",timeZone:"Europe/London"});
  accRiddorFields();
  $("#aDelete").hidden=!a||S.role!=="admin";$("#aMsg").textContent="";
  setForm("accidents",!!a);
}
async function saveAccident(){
  const v=Object.fromEntries(ACC_FIELDS.map(([k,id])=>[k,$("#"+id).value.trim()]));
  if(!/^\d{4}-\d{2}-\d{2}$/.test(v.date)){$("#aMsg").textContent="Choose the date it happened.";return}
  if(v.date>today()){$("#aMsg").textContent="That date is in the future.";return}
  if(!v.person||!v.what){$("#aMsg").textContent="Say who was hurt and what happened.";return}
  if(v.riddor!=="Reported to the HSE"){v.riddorDate=null;v.riddorRef=""}else if(!v.riddorDate)v.riddorDate=null;
  v.at=Date.now();
  const ok=editAcc?await save(()=>saveEdited("accidents",D("accidents",editAcc),v,"update"))
    :await save(()=>C("accidents").add({...v,by:S.me,byName:S.myName,ownerUserId:S.myUserId}));
  if(ok){toast(editAcc?"Accident entry saved":"Accident recorded");editAccident(null)}
}
function renderAccidents(){
  const box=$("#aList");if(!box)return;box.replaceChildren();
  const R=ro(),admin=S.role==="admin";
  const items=[...S.accidents].sort((a,b)=>(b.date||"").localeCompare(a.date||"")||(b.time||"").localeCompare(a.time||"")||(b.at||0)-(a.at||0));
  if(!items.length)box.append(el("div",{class:"empty glass",text:(admin?"No accidents recorded at this site.":"You haven't recorded any accidents at this site.")+(R?"":" Tap Record an accident when something happens.")}));
  else{
    const list=el("div",{class:"list glass"});
    for(const a of items){
      const reported=a.riddor==="Reported to the HSE",unsure=a.riddor==="Not sure yet";
      list.append(xrow("acc"+a.id,{
        title:`${a.person||"Someone"}${a.personType?" ("+a.personType.toLowerCase()+")":""}`,
        sub:[nice(a.date)+(a.time?" "+a.time:""),a.place,a.injury].filter(Boolean).join(" · "),
        right:[reported?el("span",{class:"pill",text:"Reported to HSE"}):unsure?el("span",{class:"pill warn",text:"RIDDOR: check"}):null],
        details:[xfacts([["When",longDate(a.date)+(a.time?", "+a.time:"")],["Where",a.place],["Who",[a.person,a.personType].filter(Boolean).join(", ")],["Contact",a.contact],["What happened",a.what],["Injury",a.injury],["First aid",a.firstAid],["Hospital",a.hospital],["Time off work",a.personType==="Employee"?a.timeOff:""],["Witnesses",a.witnesses],["To stop it happening again",a.action],["RIDDOR",reported?`Reported${a.riddorDate?" "+short(a.riddorDate):""}${a.riddorRef?", reference "+a.riddorRef:""}`:a.riddor],["Recorded by",a.byName||nameOf(a.by)]]),
          R?null:el("div",{class:"row"},el("button",{class:"btn ghost sm",type:"button",onclick:()=>editAccident(a)},"Edit entry"))]}));
    }
    box.append(list);
  }
  $("#aFormPanel").hidden=R||!formOpen.accidents;
}
