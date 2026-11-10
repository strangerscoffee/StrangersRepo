// Deterministic loopback provider. Used only by local tests; contains synthetic credentials and records.
import {createServer} from 'node:http';
export async function startQuickBooksProvider(){
  const state={calls:[],country:'GB',currency:'GBP',expires:3600,refreshes:0,sequence:0,refreshGate:null,readGate:null,fail:null,code:'test-code'};
  const customers=Array.from({length:101},(_,i)=>({Id:String(i+1),DisplayName:'Example customer '+(i+1),Active:true,CurrencyRef:{value:i===99?'EUR':'GBP'},PrivateNotes:'DO-NOT-RETURN',PrimaryEmailAddr:{Address:'private@example.test'}}));
  const items=[{Id:'50',Name:'Wholesale coffee',Type:'Service',Active:true,IncomeAccountRef:{value:'1'}},{Id:'51',Name:'Delivery',Type:'NonInventory',Active:true,IncomeAccountRef:{value:'1'}},{Id:'52',Name:'Inventory coffee',Type:'Inventory',Active:true,IncomeAccountRef:{value:'1'}}];
  const taxes=[{Id:'3',Name:'Standard sales VAT',Active:true,Taxable:true,SalesTaxRateList:{TaxRateDetail:[{TaxRateRef:{value:'7'}}]}},{Id:'4',Name:'Zero-rated sales',Active:true,Taxable:true,SalesTaxRateList:{TaxRateDetail:[{TaxRateRef:{value:'8'}}]}},{Id:'5',Name:'Exempt',Active:true,Taxable:false}];
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url,'http://127.0.0.1');let body='';for await(const chunk of req)body+=chunk;
    state.calls.push({method:req.method,path:url.pathname,query:url.search,body,authorization:req.headers.authorization||''});
    const reply=(code,data)=>{res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify(data));};
    if(state.fail&&url.pathname.includes(state.fail.path)){if(state.fail.location)res.setHeader('location',state.fail.location);reply(state.fail.status,{secret:'FAKE-PROVIDER-SECRET-DO-NOT-EXPOSE'});return;}
    if(url.pathname==='/authorize'){const target=new URL(url.searchParams.get('redirect_uri'));target.searchParams.set('state',url.searchParams.get('state'));target.searchParams.set('code',state.code);target.searchParams.set('realmId','1234567890');res.writeHead(302,{location:target.href});res.end();return;}
    if(url.pathname==='/token'){
      const form=new URLSearchParams(body);if(form.get('grant_type')==='refresh_token'){state.refreshes++;if(state.refreshGate)await state.refreshGate;}
      state.sequence++;reply(200,{access_token:'fake-access-'+state.sequence,refresh_token:'fake-refresh-'+state.sequence,expires_in:form.get('grant_type')==='refresh_token'?3600:state.expires,x_refresh_token_expires_in:8640000});return;
    }
    if(url.pathname==='/revoke'){reply(200,{});return;}
    if(!/^Bearer fake-access-\d+$/.test(req.headers.authorization||'')){reply(401,{});return;}
    if(state.readGate&&url.pathname.includes(state.readGate.path))await state.readGate.wait;
    if(url.pathname.endsWith('/companyinfo/1234567890')){reply(200,{CompanyInfo:{Id:'1234567890',CompanyName:'Example UK sandbox',LegalName:'Example UK Sandbox Ltd',Country:state.country}});return;}
    if(url.pathname.endsWith('/preferences')){reply(200,{Preferences:{CurrencyPrefs:{HomeCurrency:{value:state.currency}}}});return;}
    if(url.pathname.endsWith('/query')){const query=url.searchParams.get('query'),name=/FROM (Customer|Item|TaxCode)/.exec(query)?.[1],position=Number(/STARTPOSITION (\d+)/.exec(query)?.[1]||1),rows=name==='Customer'?customers:name==='Item'?items:taxes;reply(200,{QueryResponse:{[name]:rows.slice(position-1,position+99)}});return;}
    const found=/\/(customer|item|taxcode|taxrate)\/(\d+)$/.exec(url.pathname);
    if(found){const [_,kind,id]=found,key={customer:'Customer',item:'Item',taxcode:'TaxCode',taxrate:'TaxRate'}[kind],row=(kind==='customer'?customers:kind==='item'?items:kind==='taxcode'?taxes:[{Id:'7',Active:true,RateValue:20},{Id:'8',Active:true,RateValue:0}]).find(row=>row.Id===id);reply(row?200:404,row?{[key]:row}:{});return;}
    reply(404,{});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return{state,origin:'http://127.0.0.1:'+server.address().port,async stop(){await new Promise(resolve=>server.close(resolve));}};
}
export const quickBooksVars=origin=>({QUICKBOOKS_CLIENT_ID:'test-client',QUICKBOOKS_CLIENT_SECRET:'test-secret',QUICKBOOKS_TOKEN_KEY:Buffer.from('01234567890123456789012345678901').toString('base64'),QUICKBOOKS_TEST_ORIGIN:origin});
