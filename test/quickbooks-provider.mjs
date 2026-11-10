// Loopback simulator. It exercises transport and state handling; it does not prove real Intuit VAT behaviour.
import {createServer} from 'node:http';
export async function startQuickBooksProvider(){
  const state={calls:[],country:'GB',currency:'GBP',expires:3600,refreshes:0,sequence:0,refreshGate:null,readGate:null,fail:null,code:'test-code',customNumbers:true,serviceDates:true,invoices:{sandbox:new Map(),production:new Map()},payments:{sandbox:new Map(),production:new Map()},requests:{sandbox:new Map(),production:new Map()},dropCreateResponse:false,createTransform:null,rateLimitNext:false};
  const tokenEnvironment=new Map(),revoked=new Set();
  const customers=Array.from({length:101},(_,i)=>({Id:String(i+1),DisplayName:'Example customer '+(i+1),Active:true,CurrencyRef:{value:i===99?'EUR':'GBP'},PrivateNotes:'DO-NOT-RETURN',PrimaryEmailAddr:{Address:'private@example.test'}}));
  const items=[{Id:'50',Name:'Wholesale coffee',Type:'Service',Active:true,IncomeAccountRef:{value:'1'}},{Id:'51',Name:'Delivery',Type:'NonInventory',Active:true,IncomeAccountRef:{value:'1'}},{Id:'52',Name:'Inventory coffee',Type:'Inventory',Active:true,IncomeAccountRef:{value:'1'}}];
  const taxes=[{Id:'3',Name:'Standard sales VAT',Active:true,Taxable:true,SalesTaxRateList:{TaxRateDetail:[{TaxRateRef:{value:'7'}}]}},{Id:'4',Name:'Zero-rated sales',Active:true,Taxable:true,SalesTaxRateList:{TaxRateDetail:[{TaxRateRef:{value:'8'}}]}},{Id:'5',Name:'Exempt',Active:true,Taxable:false}];
  const terms=[{Id:'30',Name:'Net 30',Active:true,Type:'STANDARD',DueDays:30},{Id:'14',Name:'Net 14',Active:true,Type:'STANDARD',DueDays:14}];
  state.pay=(environment,id,balance)=>{const invoice=state.invoices[environment].get(id);invoice.Balance=balance;invoice.SyncToken=String(Number(invoice.SyncToken)+1);invoice.MetaData={LastUpdatedTime:new Date().toISOString()};return invoice;};
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url,'http://127.0.0.1');let body='';for await(const chunk of req)body+=chunk;
    state.calls.push({method:req.method,path:url.pathname,query:url.search,body,authorization:req.headers.authorization||''});
    const reply=(code,data)=>{res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify(data));};
    if(state.fail&&url.pathname.includes(state.fail.path)){if(state.fail.location)res.setHeader('location',state.fail.location);if(state.fail.retryAfter)res.setHeader('retry-after',state.fail.retryAfter);reply(state.fail.status,state.fail.faultCode?{Fault:{Error:[{code:state.fail.faultCode,Message:'FAKE-PROVIDER-SECRET-DO-NOT-EXPOSE'}]}}:{secret:'FAKE-PROVIDER-SECRET-DO-NOT-EXPOSE'});return;}
    if(url.pathname==='/authorize'){const target=new URL(url.searchParams.get('redirect_uri'));target.searchParams.set('state',url.searchParams.get('state'));target.searchParams.set('code',state.code);target.searchParams.set('realmId','1234567890');res.writeHead(302,{location:target.href});res.end();return;}
    if(url.pathname==='/token'){
      const client=Buffer.from((req.headers.authorization||'').slice(6),'base64').toString(),environment=client.startsWith('test-production-client:')?'production':'sandbox';
      const form=new URLSearchParams(body);if(form.get('grant_type')==='refresh_token'){state.refreshes++;if(tokenEnvironment.get(form.get('refresh_token'))!==environment){reply(400,{error:'invalid_grant'});return;}if(state.refreshGate)await state.refreshGate;}
      state.sequence++;const access='fake-access-'+state.sequence,refresh='fake-refresh-'+state.sequence;tokenEnvironment.set(access,environment);tokenEnvironment.set(refresh,environment);
      reply(200,{access_token:access,refresh_token:refresh,expires_in:form.get('grant_type')==='refresh_token'?3600:state.expires,x_refresh_token_expires_in:8640000});return;
    }
    if(url.pathname==='/revoke'){const value=JSON.parse(body).token;revoked.add(value);reply(200,{});return;}
    const environment=url.pathname.startsWith('/production/')?'production':'sandbox',access=(req.headers.authorization||'').replace(/^Bearer /,'');
    if(!/^fake-access-\d+$/.test(access)||tokenEnvironment.get(access)!==environment||revoked.has(access)){reply(401,{});return;}
    if(state.readGate&&url.pathname.includes(state.readGate.path)){const gate=state.readGate;if(gate.once)state.readGate=null;await gate.wait;if(gate.response){reply(200,gate.response);return;}}
    if(url.pathname.endsWith('/companyinfo/1234567890')){reply(200,{CompanyInfo:{Id:'1234567890',CompanyName:'Example UK '+environment,LegalName:environment==='sandbox'?'Example UK Sandbox Ltd':'Example UK Live Ltd',Country:state.country}});return;}
    if(url.pathname.endsWith('/preferences')){reply(200,{Preferences:{CurrencyPrefs:{HomeCurrency:{value:state.currency}},SalesFormsPrefs:{CustomTxnNumbers:state.customNumbers,AllowServiceDate:state.serviceDates}}});return;}
    if(url.pathname.endsWith('/cdc')){reply(200,{CDCResponse:[{QueryResponse:[{Invoice:[...state.invoices[environment].values()]}]}],time:new Date().toISOString()});return;}
    const payment=/\/payment\/(\d+)$/.exec(url.pathname);if(payment){const row=state.payments[environment].get(payment[1]);reply(row?200:404,row?{Payment:row}:{});return;}
    if(url.pathname.endsWith('/query')){
      const query=url.searchParams.get('query'),name=/FROM (Customer|Item|TaxCode|Term|Invoice)/.exec(query)?.[1],position=Number(/STARTPOSITION (\d+)/.exec(query)?.[1]||1),document=/DocNumber\s*=\s*'([^']*)'/.exec(query)?.[1];
      const rows=name==='Customer'?customers:name==='Item'?items:name==='TaxCode'?taxes:name==='Term'?terms:[...state.invoices[environment].values()].filter(invoice=>!document||invoice.DocNumber===document);
      reply(200,{QueryResponse:{[name]:rows.slice(position-1,position+99)}});return;
    }
    if(url.pathname.endsWith('/invoice')&&req.method==='POST'){
      if(state.rateLimitNext){state.rateLimitNext=false;res.setHeader('retry-after','1');reply(429,{});return;}
      const value=JSON.parse(body),request=url.searchParams.get('requestid'),known=state.requests[environment].get(request);
      if(known){if(state.dropCreateResponse){req.socket.destroy();return;}reply(200,{Invoice:state.invoices[environment].get(known)});return;}
      if([...state.invoices[environment].values()].some(row=>row.DocNumber===value.DocNumber)){reply(400,{Fault:{Error:[{code:'6140'}]}});return;}
      if(!state.customNumbers||!state.serviceDates||!request||request.length>50||value.DocNumber.length>21){reply(400,{Fault:{Error:[{code:'2010'}]}});return;}
      const invoice={...value,Id:String(1000+state.invoices[environment].size),SyncToken:'0',MetaData:{LastUpdatedTime:new Date().toISOString()},TotalAmt:Math.round((value.Line.reduce((sum,line)=>sum+line.Amount,0)+value.TxnTaxDetail.TotalTax)*100)/100};invoice.Balance=invoice.TotalAmt;
      if(state.createTransform)state.createTransform(invoice,environment);state.invoices[environment].set(invoice.Id,invoice);state.requests[environment].set(request,invoice.Id);
      if(state.dropCreateResponse){req.socket.destroy();return;}reply(200,{Invoice:invoice});return;
    }
    const invoice=/\/invoice\/(\d+)$/.exec(url.pathname);if(invoice){const row=state.invoices[environment].get(invoice[1]);reply(row?200:404,row?{Invoice:row}:{});return;}
    const found=/\/(customer|item|taxcode|taxrate|account|term)\/(\d+)$/.exec(url.pathname);
    if(found){const [_,kind,id]=found,key={customer:'Customer',item:'Item',taxcode:'TaxCode',taxrate:'TaxRate',account:'Account',term:'Term'}[kind],rows=kind==='customer'?customers:kind==='item'?items:kind==='taxcode'?taxes:kind==='term'?terms:kind==='account'?[{Id:'1',Active:true,AccountType:'Income'}]:[{Id:'7',Active:true,RateValue:20},{Id:'8',Active:true,RateValue:0}],row=rows.find(row=>row.Id===id);reply(row?200:404,row?{[key]:row}:{});return;}
    reply(404,{});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return{state,origin:'http://127.0.0.1:'+server.address().port,async stop(){await new Promise(resolve=>server.close(resolve));}};
}
export const quickBooksVars=origin=>({QUICKBOOKS_CLIENT_ID:'test-client',QUICKBOOKS_CLIENT_SECRET:'test-secret',QUICKBOOKS_PRODUCTION_CLIENT_ID:'test-production-client',QUICKBOOKS_PRODUCTION_CLIENT_SECRET:'test-production-secret',QUICKBOOKS_TOKEN_KEY:Buffer.from('01234567890123456789012345678901').toString('base64'),QUICKBOOKS_TEST_ORIGIN:origin});
