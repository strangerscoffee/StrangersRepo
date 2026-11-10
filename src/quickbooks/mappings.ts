import {ApiError,type Env,invalid} from '../http';
import {get,object,text,version} from '../wholesaleStore';
import type {InvoiceDocument} from '../wholesaleInvoices';
import type {Environment,QuickBooksMappings,InvoiceCandidate} from './preview';
import {connection,current,id,ProviderError,qbError,readResource,resourceReader,type Connection} from './connection';
export interface MappingData {customerLinks:Record<string,string>;coffeeItemId:string;deliveryItemId:string;taxMappings:{rateId:string;basisPoints:number;taxCodeId:string}[];termLinks:Record<string,string>}
export const changed=()=>new ApiError(409,'quickbooks_changed','The QuickBooks settings changed. Reopen them before saving.');
const empty=():MappingData=>({customerLinks:{},coffeeItemId:'',deliveryItemId:'',taxMappings:[],termLinks:{}});
export async function mapping(env:Env,mode:Environment,realm:string){
  const row=await env.DB.prepare('SELECT data,version FROM quickbooks_environment_mappings WHERE environment=? AND realm_id=?').bind(mode,realm).first<{data:string;version:number}>();
  return{data:row?{...empty(),...JSON.parse(row.data)} as MappingData:empty(),version:row?.version||0};
}
const entityNames={customer:'Customer',item:'Item',taxcode:'TaxCode',term:'Term'} as const;
export type Kind=keyof typeof entityNames;
type Read=(path:string)=>Promise<any>;
async function entity(read:Read,kind:Kind,ref:string){
  let data:any;try{data=await read('/'+kind+'/'+id(ref)+'?minorversion=75');}catch(error){if(error instanceof ProviderError&&error.providerStatus===404)throw invalid('Choose an active QuickBooks '+kind+'.');throw error;}
  const row=data[entityNames[kind]];if(!row||row.Id!==ref||row.Active!==true)throw invalid('Choose an active QuickBooks '+kind+'.');return row;
}
async function salesItem(read:Read,ref:string){
  const item=await entity(read,'item',ref);if(!['Service','NonInventory'].includes(item.Type)||!item.IncomeAccountRef?.value)throw invalid('Choose a service or non-inventory sales item with an income account.');
  const refId=id(item.IncomeAccountRef.value),account=(await read('/account/'+refId+'?minorversion=75')).Account;
  if(account?.Id!==refId||account.Active!==true||!['Income','OtherIncome'].includes(account.AccountType))throw invalid('The sales item needs an active income account.');return item;
}
async function salesTax(read:Read,ref:string,basisPoints:number){
  const code=await entity(read,'taxcode',ref),details=code.SalesTaxRateList?.TaxRateDetail,rows=details?(Array.isArray(details)?details:[details]):[];
  if(!rows.length&&code.Taxable===false&&basisPoints===0)return{taxable:false,taxRateRef:null};
  if(rows.length!==1||!rows[0].TaxRateRef?.value)throw invalid('Choose a simple sales VAT code. Compound VAT is not supported.');
  const rateRef=id(rows[0].TaxRateRef.value),rate=(await read('/taxrate/'+rateRef+'?minorversion=75')).TaxRate,value=Number(rate?.RateValue);
  if(rate?.Id!==rateRef||rate.Active!==true||!Number.isFinite(value)||Math.abs(value*100-Math.round(value*100))>0.00000001||value<0||value>100||Math.round(value*100)!==basisPoints)throw invalid('The QuickBooks VAT percentage does not match the saved invoice rate.');
  return{taxable:code.Taxable!==false,taxRateRef:rateRef};
}
async function term(read:Read,ref:string,localId:string){
  const value=await entity(read,'term',ref),days=/^net-(7|14|30|60)$/.exec(localId)?.[1];
  if(days&&(Number(value.DueDays)!==Number(days)||value.Type&&value.Type!=='STANDARD'))throw invalid('Choose payment terms with the same number of days as the saved invoice.');return value;
}
export async function browse(req:Request,env:Env,mode:Environment,url:URL){
  const kind=url.searchParams.get('kind') as Kind;if(!Object.hasOwn(entityNames,kind))throw invalid('Choose customers, sales items, VAT codes or payment terms.');
  const raw=url.searchParams.get('cursor')||'1',position=Number(raw);if(!/^\d+$/.test(raw)||!Number.isSafeInteger(position)||position<1||position>500000)throw invalid('Choose a valid reference page.');
  const name=entityNames[kind],data=await readResource(req,env,'/query?minorversion=75&query='+encodeURIComponent(`SELECT * FROM ${name} WHERE Active = true STARTPOSITION ${position} MAXRESULTS 100`),mode),rows=data.QueryResponse?.[name]||[];
  if(!Array.isArray(rows)||rows.length>100)throw qbError();
  return{items:rows.map(row=>({id:id(row.Id),name:typeof(row.DisplayName||row.Name)==='string'?(row.DisplayName||row.Name).slice(0,180):'Unnamed',active:row.Active===true,type:kind==='item'?String(row.Type||'').slice(0,40):'',currency:kind==='customer'?row.CurrencyRef?.value||null:null,...(kind==='term'?{days:Number.isInteger(row.DueDays)?row.DueDays:null}:{})})),nextCursor:rows.length===100?String(position+100):null};
}
export async function verifiedMapping(req:Request,env:Env,mode:Environment,invoice:InvoiceDocument,row?:Connection){
  row=row||await connection(env,mode);if(row.status!=='connected')throw changed();
  const resources=await resourceReader(req,env,row),saved=await mapping(env,mode,row.realm_id),data=saved.data,scope={environment:mode,realmId:row.realm_id},ref=(value:string)=>({...scope,id:value,active:true});
  const result:QuickBooksMappings={...scope,installationId:(await env.DB.prepare('SELECT namespace FROM quickbooks_installation WHERE id=1').first<{namespace:string}>())!.namespace,company:{country:row.country,currency:row.currency,vatNumber:row.vat_number,reviewed:true},items:{},taxCodes:{}};
  const customerRef=data.customerLinks[invoice.customerId];if(customerRef){const customer=await entity(resources.read,'customer',customerRef);if(customer.CurrencyRef?.value&&customer.CurrencyRef.value!=='GBP')throw invalid('Choose a customer using GBP.');result.customer={...ref(customerRef),localCustomerId:invoice.customerId};}
  if(data.coffeeItemId){await salesItem(resources.read,data.coffeeItemId);result.items.coffee=ref(data.coffeeItemId);}
  if(data.deliveryItemId){await salesItem(resources.read,data.deliveryItemId);result.items.delivery=ref(data.deliveryItemId);}
  for(const rate of new Map(invoice.lines.map(rate=>[rate.rateId+':'+rate.vatBasisPoints,rate])).values()){
    const found=data.taxMappings.find(item=>item.rateId===rate.rateId&&item.basisPoints===rate.vatBasisPoints);
    if(found){const details=await salesTax(resources.read,found.taxCodeId,found.basisPoints);result.taxCodes[rate.rateId]={...ref(found.taxCodeId),basisPoints:found.basisPoints,sales:true,reviewed:true,...details};}
  }
  const termId=data.termLinks[invoice.paymentTerms.id];if(termId){await term(resources.read,termId,invoice.paymentTerms.id);result.termRef=ref(termId);}
  const preferences=(await resources.read('/preferences?minorversion=75')).Preferences;result.company.customNumbers=preferences?.SalesFormsPrefs?.CustomTxnNumbers===true;result.company.serviceDates=preferences?.SalesFormsPrefs?.AllowServiceDate===true;
  await resources.check();return{mappings:result,mappingVersion:saved.version,connection:row,resources};
}
export async function saveMapping(req:Request,env:Env,mode:Environment,body:Record<string,any>){
  const row=await connection(env,mode),expected=version(body.ifVersion),old=await mapping(env,mode,row.realm_id);
  if(row.status!=='connected'||row.version!==version(body.connectionVersion)||old.version!==expected)throw changed();
  if(body.reviewed!==true)throw invalid('Review the customer, items, VAT and payment terms before saving.');
  const {read,check}=await resourceReader(req,env,row),data:MappingData={...old.data,customerLinks:{...old.data.customerLinks},termLinks:{...old.data.termLinks},coffeeItemId:id(body.coffeeItemId),deliveryItemId:body.deliveryItemId?id(body.deliveryItemId):'',taxMappings:[]};
  if(body.customer){const customer=object(body.customer),localId=text(customer.localId,'business',80,true);if(!/^[a-f0-9-]{36}$/.test(localId)||!await get(env,'customer',localId))throw invalid('Choose a saved wholesale business.');const remote=await entity(read,'customer',id(customer.quickbooksId));if(remote.CurrencyRef?.value&&remote.CurrencyRef.value!=='GBP')throw invalid('Choose a customer using GBP.');data.customerLinks[localId]=remote.Id;}
  await salesItem(read,data.coffeeItemId);if(data.deliveryItemId)await salesItem(read,data.deliveryItemId);
  if(!Array.isArray(body.taxMappings)||body.taxMappings.length>100)throw invalid('Choose at most 100 VAT mappings.');
  const seen=new Set<string>();for(const entry of body.taxMappings){const value=object(entry),rateId=text(value.rateId,'VAT rate',40,true),basisPoints=value.basisPoints,code=id(value.taxCodeId),key=rateId+':'+basisPoints;if(!Number.isSafeInteger(basisPoints)||basisPoints<0||basisPoints>10000||seen.has(key))throw invalid('Choose unique, valid VAT mappings.');seen.add(key);await salesTax(read,code,basisPoints);data.taxMappings.push({rateId,basisPoints,taxCodeId:code});}
  if(body.term){const value=object(body.term),localId=text(value.localId,'payment terms',40,true);if(!/^[a-z][a-z0-9-]*$/.test(localId))throw invalid('Choose saved payment terms.');if(value.quickbooksId){const remote=await term(read,id(value.quickbooksId),localId);data.termLinks[localId]=remote.Id;}else delete data.termLinks[localId];}
  await check();const exists="EXISTS(SELECT 1 FROM quickbooks_connections WHERE environment=? AND generation=? AND version=? AND status='connected')";
  const saved=expected===0?await env.DB.prepare(`INSERT INTO quickbooks_environment_mappings(environment,realm_id,data,version,updated_at) SELECT ?,?,?,1,? WHERE ${exists} ON CONFLICT(environment,realm_id) DO NOTHING RETURNING version`).bind(mode,row.realm_id,JSON.stringify(data),Date.now(),mode,row.generation,row.version).first():await env.DB.prepare(`UPDATE quickbooks_environment_mappings SET data=?,version=version+1,updated_at=? WHERE environment=? AND realm_id=? AND version=? AND ${exists} RETURNING version`).bind(JSON.stringify(data),Date.now(),mode,row.realm_id,expected,mode,row.generation,row.version).first();
  if(!saved)throw changed();return{...await mapping(env,mode,row.realm_id),connectionVersion:row.version,realmId:row.realm_id,environment:mode};
}

export function mappingStillMatches(data:MappingData,value:InvoiceCandidate){
  return data.customerLinks[value.localCustomerId]===value.customerRef&&(data.termLinks[value.paymentTerms.id]||null)===value.termRef&&value.lines.every(line=>(line.kind==='coffee'?data.coffeeItemId:data.deliveryItemId)===line.itemRef&&data.taxMappings.some(rate=>rate.rateId===line.localRateId&&rate.basisPoints===line.vatBasisPoints&&rate.taxCodeId===line.taxCodeRef));
}
export async function verifyFrozenReferences(read:Read,value:InvoiceCandidate){
  const customer=await entity(read,'customer',value.customerRef!);if(customer.CurrencyRef?.value&&customer.CurrencyRef.value!=='GBP')throw invalid('The saved QuickBooks customer no longer uses GBP.');
  for(const ref of new Set(value.lines.map(line=>line.itemRef!)))await salesItem(read,ref);
  for(const line of new Map(value.lines.map(line=>[line.taxCodeRef+':'+line.vatBasisPoints,line])).values()){const tax=await salesTax(read,line.taxCodeRef!,line.vatBasisPoints);if(tax.taxable!==line.taxable||tax.taxRateRef!==line.taxRateRef)throw invalid('A saved VAT treatment changed in QuickBooks. Review the original export.');}
  if(value.termRef)await term(read,value.termRef,value.paymentTerms.id);
}
