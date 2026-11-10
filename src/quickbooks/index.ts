// Admin-only QuickBooks Online sandbox connection, verified references and invoice previews.
// No QuickBooks accounting writes are available in this milestone.
import type {User} from "../auth";
import {audit} from "../audit";
import {ApiError,type Env,invalid,json,readJson} from "../http";
import {get,object,text,version} from "../wholesaleStore";
import {issuedInvoice} from "../wholesaleInvoices";
import {previewInvoice,type QuickBooksMappings} from "./preview";
import {connection,configuration,configured,exchange,id,qbError,QB_ROOT,readCompany,readResource,resourceReader,revoke} from "./connection";
import {digest,seal} from "./crypto";
interface MappingData {customerLinks:Record<string,string>;coffeeItemId:string;deliveryItemId:string;taxMappings:{rateId:string;basisPoints:number;taxCodeId:string}[]}
interface MappingRow {data:string;version:number}
const emptyMappings=():MappingData=>({customerLinks:{},coffeeItemId:"",deliveryItemId:"",taxMappings:[]});
async function mapping(env:Env,realm:string){const row=await env.DB.prepare("SELECT data,version FROM quickbooks_mappings WHERE realm_id=?").bind(realm).first<MappingRow>();return{data:row?JSON.parse(row.data) as MappingData:emptyMappings(),version:row?.version||0};}
const sessionHash=(req:Request)=>digest((/(?:^|;\s*)sfbb_session=([^;]+)/.exec(req.headers.get("cookie")||"")||[])[1]||"");
const changed=()=>new ApiError(409,"quickbooks_changed","The QuickBooks settings changed. Reopen them before saving.");
const entityNames={customer:"Customer",item:"Item",taxcode:"TaxCode"} as const;
type ReadResource=(path:string)=>Promise<any>;
async function entity(req:Request,env:Env,kind:keyof typeof entityNames,ref:string,read:ReadResource=path=>readResource(req,env,path)){const data=await read("/"+kind+"/"+id(ref)+"?minorversion=75"),row=data[entityNames[kind]];if(!row||row.Id!==ref||row.Active!==true)throw invalid("Choose an active QuickBooks "+kind+".");return row;}
async function itemReference(req:Request,env:Env,ref:string,read?:ReadResource){const item=await entity(req,env,"item",ref,read);if(!["Service","NonInventory"].includes(item.Type)||!item.IncomeAccountRef?.value)throw invalid("Choose a service or non-inventory sales item with an income account.");return item;}
async function salesTax(req:Request,env:Env,ref:string,basisPoints:number,read:ReadResource=path=>readResource(req,env,path)){
  const code=await entity(req,env,"taxcode",ref,read),details=code.SalesTaxRateList?.TaxRateDetail,rows=details?(Array.isArray(details)?details:[details]):[];
  if(!rows.length&&code.Taxable===false&&basisPoints===0)return;
  if(rows.length!==1||!rows[0].TaxRateRef?.value)throw invalid("Choose a simple sales VAT code. This sandbox preview does not support compound VAT.");
  const rateRef=id(rows[0].TaxRateRef.value),rate=(await read("/taxrate/"+rateRef+"?minorversion=75")).TaxRate;
  const value=Number(rate?.RateValue);
  if(rate?.Id!==rateRef||rate.Active!==true||!Number.isFinite(value)||Math.abs(value*100-Math.round(value*100))>0.00000001||value<0||value>100||Math.round(value*100)!==basisPoints)throw invalid("The chosen QuickBooks sales VAT percentage does not match the saved invoice rate.");
}
async function verifiedMapping(req:Request,env:Env,localId:string,invoiceRates:{rateId:string;vatBasisPoints:number}[]){
  const row=await connection(env);if(row.status!=="connected")throw changed();
  const {read,check}=await resourceReader(req,env,row),saved=await mapping(env,row.realm_id),data=saved.data,scope={environment:"sandbox" as const,realmId:row.realm_id},reference=(value:string)=>({...scope,id:value,active:true});
  const customerRef=data.customerLinks[localId];
  const result:QuickBooksMappings={...scope,installationId:(await env.DB.prepare("SELECT namespace FROM quickbooks_installation WHERE id=1").first<{namespace:string}>())!.namespace,company:{country:row.country,currency:row.currency,vatNumber:row.vat_number,reviewed:true},items:{},taxCodes:{}};
  if(customerRef){const customer=await entity(req,env,"customer",customerRef,read);if(customer.CurrencyRef?.value&&customer.CurrencyRef.value!=="GBP")throw invalid("Choose a customer using GBP.");result.customer={...reference(customerRef),localCustomerId:localId};}
  if(data.coffeeItemId){await itemReference(req,env,data.coffeeItemId,read);result.items.coffee=reference(data.coffeeItemId);}
  if(data.deliveryItemId){await itemReference(req,env,data.deliveryItemId,read);result.items.delivery=reference(data.deliveryItemId);}
  for(const rate of new Map(invoiceRates.map(rate=>[rate.rateId+":"+rate.vatBasisPoints,rate])).values()){const found=data.taxMappings.find(item=>item.rateId===rate.rateId&&item.basisPoints===rate.vatBasisPoints);if(found){await salesTax(req,env,found.taxCodeId,found.basisPoints,read);result.taxCodes[rate.rateId]={...reference(found.taxCodeId),basisPoints:found.basisPoints,sales:true,reviewed:true};}}
  await check();return result;
}
export async function handleQuickBooks(req:Request,env:Env,route:string,user:User):Promise<Response|null>{
  if(route!=="quickbooks"&&!route.startsWith("quickbooks/"))return null;
  if(user.role!=="admin")throw new ApiError(403,"permission_denied","Only admins can manage QuickBooks.");
  const action=route.slice("quickbooks".length),url=new URL(req.url);
  if((!action||action==="/status")&&req.method==="GET"){
    const setup=configuration(req,env),row=await connection(env);
    return json({environment:"sandbox",mode:"read-only-preview",configured:!!setup.config,missing:setup.missing,connection:{status:row.status,version:row.version,realmId:row.realm_id,name:row.company_name,country:row.country,currency:row.currency,vatNumber:row.vat_number,updatedAt:row.updated_at},capabilities:{references:!!setup.config&&row.status==="connected",invoicePreview:!!setup.config&&row.status==="connected",invoiceExport:false,paymentWrites:false}});
  }
  if(action==="/connect"&&req.method==="POST"){
    const config=configured(req,env),row=await connection(env),state=crypto.randomUUID().replace(/-/g,"")+crypto.randomUUID().replace(/-/g,"");
    await env.DB.batch([env.DB.prepare("DELETE FROM quickbooks_oauth_states WHERE expires_at<?").bind(Date.now()),env.DB.prepare("INSERT INTO quickbooks_oauth_states VALUES(?,?,?,?,?)").bind(await digest(state),user.id,await sessionHash(req),row.version,Date.now()+600000)]);
    const target=new URL(config.authorize);for(const [key,value]of Object.entries({client_id:config.clientId,redirect_uri:config.redirect,response_type:"code",scope:"com.intuit.quickbooks.accounting",state}))target.searchParams.set(key,value);
    return json({authorizeUrl:target.href});
  }
  if(action==="/callback"&&req.method==="GET"){
    const config=configured(req,env),state=url.searchParams.get("state")||"";
    if(!/^[a-f0-9]{64}$/.test(state))throw invalid("The QuickBooks sign-in state is invalid. Start again.");
    const pending=await env.DB.prepare("DELETE FROM quickbooks_oauth_states WHERE state_hash=? RETURNING *").bind(await digest(state)).first<{admin_id:string;session_hash:string;connection_version:number;expires_at:number}>();
    if(!pending||pending.expires_at<Date.now()||pending.admin_id!==user.id||pending.session_hash!==await sessionHash(req))throw invalid("This QuickBooks sign-in expired or belongs to another session. Start again.");
    if(url.searchParams.has("error"))throw invalid("QuickBooks sign-in was not completed. You can connect again when ready.");
    const realm=id(url.searchParams.get("realmId")),code=url.searchParams.get("code")||"";
    if(!code||code.length>2048||/[\u0000-\u001f\u007f]/.test(code))throw invalid("QuickBooks did not return a valid sign-in code.");
    const old=await connection(env);if(old.version!==pending.connection_version)throw changed();
    const tokens=await exchange(config,{grant_type:"authorization_code",code,redirect_uri:config.redirect}),company=await readCompany(config,realm,tokens.access);
    if(company.country!=="GB"||company.currency!=="GBP")throw invalid("Connect a UK sandbox company with GBP as its home currency.");
    const generation=crypto.randomUUID(),encrypted=await seal(tokens,config.key,realm,generation);
    const saved=await env.DB.prepare("UPDATE quickbooks_connection SET status='pending',generation=?,version=version+1,realm_id=?,company_name=?,country=?,currency=?,vat_number='',token_data=?,token_version=1,lease_owner=NULL,lease_until=0,connected_by=?,updated_at=? WHERE id=1 AND version=?").bind(generation,realm,company.name,company.country,company.currency,encrypted,user.id,Date.now(),pending.connection_version).run();
    if(!saved.meta.changes)throw changed();
    await audit(env,"quickbooks_connect",user.name,`${user.name} connected a QuickBooks sandbox company for confirmation.`);
    const target=new URL(config.redirect);target.pathname=env.ADMIN_HOST?"/":"/admin";target.search="?quickbooks=review";target.hash="wholesale";
    return new Response(null,{status:303,headers:{location:target.href,"cache-control":"no-store","referrer-policy":"no-referrer"}});
  }
  if(action==="/confirm"&&req.method==="POST"){
    configured(req,env);const body=object(await readJson(req,4096)),row=await connection(env),expected=version(body.ifVersion),vat=text(body.vatNumber,"VAT registration",40,true);
    if(body.confirmed!==true||row.status!=="pending"||row.country!=="GB"||row.currency!=="GBP")throw invalid("Review and confirm the connected UK sandbox company first.");
    const saved=await env.DB.prepare("UPDATE quickbooks_connection SET status='connected',vat_number=?,version=version+1,updated_at=? WHERE id=1 AND version=? AND generation=? AND status='pending'").bind(vat,Date.now(),expected,row.generation).run();if(!saved.meta.changes)throw changed();
    await audit(env,"quickbooks_confirm",user.name,`${user.name} confirmed the QuickBooks sandbox connection.`);return json({confirmed:true});
  }
  if(action==="/disconnect"&&req.method==="POST"){
    const body=object(await readJson(req,4096)),row=await connection(env),setup=configuration(req,env);
    const saved=await env.DB.prepare("UPDATE quickbooks_connection SET status='disconnected',generation=?,version=version+1,token_data=NULL,lease_owner=NULL,lease_until=0,updated_at=? WHERE id=1 AND version=?").bind(crypto.randomUUID(),Date.now(),version(body.ifVersion)).run();if(!saved.meta.changes)throw changed();
    await env.DB.prepare("DELETE FROM quickbooks_oauth_states").run();
    const revoked=setup.config?await revoke(setup.config,row.token_data,row.realm_id,row.generation):false;
    await audit(env,"quickbooks_disconnect",user.name,`${user.name} disconnected QuickBooks. Local credentials were removed.`);return json({disconnected:true,revoked});
  }
  if(action==="/references"&&req.method==="GET"){
    const kind=url.searchParams.get("kind") as keyof typeof entityNames;if(!Object.hasOwn(entityNames,kind))throw invalid("Choose customers, items or VAT codes.");
    const raw=url.searchParams.get("cursor")||"1",position=Number(raw);if(!/^\d+$/.test(raw)||!Number.isSafeInteger(position)||position<1||position>500000)throw invalid("Choose a valid reference page.");
    const name=entityNames[kind],data=await readResource(req,env,"/query?minorversion=75&query="+encodeURIComponent(`SELECT * FROM ${name} WHERE Active = true STARTPOSITION ${position} MAXRESULTS 100`));
    const rows=data.QueryResponse?.[name]||[];if(!Array.isArray(rows)||rows.length>100)throw qbError();
    const items=rows.map(row=>({id:id(row.Id),name:typeof(row.DisplayName||row.Name)==="string"?(row.DisplayName||row.Name).slice(0,180):"Unnamed",active:row.Active===true,type:kind==="item"?row.Type||"":"",currency:kind==="customer"?row.CurrencyRef?.value||null:null}));
    return json({items,nextCursor:rows.length===100?String(position+100):null});
  }
  if(action==="/mappings"&&req.method==="GET"){
    const row=await connection(env);if(row.status!=="connected")throw changed();return json({...await mapping(env,row.realm_id),connectionVersion:row.version,realmId:row.realm_id});
  }
  if(action==="/mappings"&&req.method==="PUT"){
    const body=object(await readJson(req,32768)),row=await connection(env),expected=version(body.ifVersion),old=await mapping(env,row.realm_id);
    if(row.status!=="connected"||row.version!==version(body.connectionVersion)||old.version!==expected)throw changed();
    if(body.reviewed!==true)throw invalid("Review the customer, items and VAT treatment before saving mappings.");
    const {read,check}=await resourceReader(req,env,row);
    const data:MappingData={...old.data,customerLinks:{...old.data.customerLinks},coffeeItemId:id(body.coffeeItemId),deliveryItemId:body.deliveryItemId?id(body.deliveryItemId):"",taxMappings:[]};
    if(body.customer){const customer=object(body.customer),localId=text(customer.localId,"business",80,true);if(!/^[a-f0-9-]{36}$/.test(localId)||!await get(env,"customer",localId))throw invalid("Choose a saved wholesale business.");const remote=await entity(req,env,"customer",id(customer.quickbooksId),read);if(remote.CurrencyRef?.value&&remote.CurrencyRef.value!=="GBP")throw invalid("Choose a customer using GBP.");data.customerLinks[localId]=remote.Id;}
    await itemReference(req,env,data.coffeeItemId,read);if(data.deliveryItemId)await itemReference(req,env,data.deliveryItemId,read);
    if(!Array.isArray(body.taxMappings)||body.taxMappings.length>100)throw invalid("Choose at most 100 VAT mappings.");
    const seen=new Set<string>();for(const entry of body.taxMappings){const value=object(entry),rateId=text(value.rateId,"VAT rate",40,true),basisPoints=value.basisPoints,code=id(value.taxCodeId),key=rateId+":"+basisPoints;if(!Number.isSafeInteger(basisPoints)||basisPoints<0||basisPoints>10000||seen.has(key))throw invalid("Choose unique, valid VAT rate mappings.");seen.add(key);await salesTax(req,env,code,basisPoints,read);data.taxMappings.push({rateId,basisPoints,taxCodeId:code});}
    await check();
    const exists="EXISTS(SELECT 1 FROM quickbooks_connection WHERE id=1 AND generation=? AND version=? AND status='connected')";
    const saved=expected===0?await env.DB.prepare(`INSERT INTO quickbooks_mappings(realm_id,data,version,updated_at) SELECT ?,?,1,? WHERE ${exists} ON CONFLICT(realm_id) DO NOTHING RETURNING version`).bind(row.realm_id,JSON.stringify(data),Date.now(),row.generation,row.version).first():await env.DB.prepare(`UPDATE quickbooks_mappings SET data=?,version=version+1,updated_at=? WHERE realm_id=? AND version=? AND ${exists} RETURNING version`).bind(JSON.stringify(data),Date.now(),row.realm_id,expected,row.generation,row.version).first();
    if(!saved)throw changed();await audit(env,"quickbooks_mapping",user.name,`${user.name} reviewed QuickBooks sandbox mappings.`);return json({...await mapping(env,row.realm_id),connectionVersion:row.version,realmId:row.realm_id});
  }
  const preview=/^\/invoices\/(\d+)\/preview$/.exec(action);
  if(preview&&req.method==="GET"){
    const invoice=await issuedInvoice(env,Number(preview[1])),mappings=await verifiedMapping(req,env,invoice.customerId,invoice.lines);
    return json({preview:await previewInvoice(invoice,mappings)});
  }
  throw new ApiError(404,"not_found","Unknown QuickBooks sandbox operation.");
}
