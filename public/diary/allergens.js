// Allergens: menu items and what they contain, and allergen PDFs uploaded before the matrix was made on the device.

/* ---------- allergens ---------- */
const algFilter=new Set();
const ALG_SHORT={"Cereals with gluten":"Gluten","Sulphur dioxide":"Sulphites"};
const algShort=a=>ALG_SHORT[a]||a.replace(/ \(.*\)$/,"");
let algNewKind="drink";
function renderAllergens(){
  const items=[...S.allergens].sort((a,b)=>(a.name||"").localeCompare(b.name||"")),R=ro(),secOn=algSectionsOn();
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
  S.editAlg=it?it.id:null;beginEdit("allergens",S.editAlg);
  $("#algFormTitle").textContent=it?"Edit "+it.name:"Add a menu item";
  $("#algName").value=it?it.name:"";$("#algSupplier").value=it?(it.source||""):"";$("#algNotes").value=it?(it.notes||""):"";
  const has=new Set(it?it.contains||[]:[]);
  document.querySelectorAll("#algChecks input").forEach(cb=>cb.checked=has.has(cb.value));
  $("#algCancel").hidden=true;$("#algDelete").hidden=!it;algPick.set(it&&it.sites);
  $("#algKindRow").hidden=!algSectionsOn();setAlgKind(it?algKind(it):(algNewKind||"drink"));
  setForm("allergens",!!it);
}

const algPick=sitePicker("alg_sites");$("#algSites").replaceWith(algPick.el);

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
