// Local-test records only. No production requests or external notifications.
export const quoted = value => "'" + String(value).replaceAll("'", "''") + "'";
export async function seedOverview(srv, cookie, { history = 0 } = {}) {
  const now = Date.now(), today = new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
  const week = new Date(Date.parse(today+'T12:00:00Z')-((new Date(today+'T12:00:00Z').getUTCDay()+6)%7)*864e5).toISOString().slice(0,10);
  const next = new Date(Date.parse(week+'T12:00:00Z')+7*864e5).toISOString().slice(0,10);
  const request = async (path,body) => {const r=await fetch(srv.base+path,{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw Error(JSON.stringify(data));return data;};
  for(const [prefix,name]of [['','Roastery'],['sites/cafe/','Cafe'],['sites/asg/','ASG']]){
    await request('/api/db/set',{path:prefix+'settings/main',data:{info:{name},units:[],opening:[],closing:[{id:'close',t:'Closing checks'}],weekly:[],closedDays:[]}});
    await request('/api/db/set',{path:prefix+'days/'+today,data:{date:today,...(name==='Roastery'?{closing:{items:{close:true}},signed:{by:'web:Overview Admin',at:now}}:{})}});
  }
  const orders=[['A','New',1000,false,false],['B','Preparing',2000,false,false],['C','Ready',1000,false,false],['D','New',900000,true,false],['E','Preparing',800000,false,true]];
  for(let i=0;i<history;i++)orders.push([(i+16).toString(16).padStart(32,'0').toUpperCase(),'Dispatched',1000,false,false]);
  const statements=[];
  for(const [key,status,grams,preview,deleted]of orders){const id='WS-'+key.padStart(32,key);const order={status,grams,preview,...(deleted?{deletedAt:now}:{}),business:'Overview test customer',customerId:'overview-customer',createdAt:now-864e5,createdName:'Overview Admin',delivery:'Collect',packs:grams/1000,pence:1000,totalPence:1000,lines:[]};statements.push(`INSERT INTO wholesale_preview(kind,id,data,version,updated_at)VALUES('order',${quoted(id)},${quoted(JSON.stringify(order))},1,${now})`);}
  const customer={business:'Overview test customer',contact:'Test contact',email:'overview@example.invalid',status:'Active',phone:'',address:'',postcode:'',note:''};
  statements.push(`INSERT INTO wholesale_preview(kind,id,data,version,updated_at)VALUES('customer','overview-customer',${quoted(JSON.stringify(customer))},1,${now})`);
  statements.push(`INSERT INTO wholesale_accounts(id,customer_id,username,password_hash,password_salt,approval_status,created_at,updated_at)VALUES('overview-account','overview-customer','overview.customer','unused-test-hash','unused-test-salt','pending',${now},${now})`);
  statements.push(`INSERT INTO rota_weeks(week,published_at)VALUES(${quoted(week)},${now}) ON CONFLICT(week)DO UPDATE SET published_at=excluded.published_at`);
  statements.push(`INSERT INTO rota_shifts(id,site,day,start,end,updated_at,updated_by)VALUES('overview-open','cafe',${quoted(today)},'00:00','23:59',${now},'test-admin')`);
  statements.push("INSERT INTO rota_sites(site,opens_at,closes_at)VALUES('cafe','00:00','23:59'),('asg','00:00','00:00') ON CONFLICT(site)DO UPDATE SET opens_at=excluded.opens_at,closes_at=excluded.closes_at");
  const owner=srv.sql("SELECT id FROM users WHERE role='admin' LIMIT 1")[0].id;
  for(const [id,kind,status,from]of [['overview-annual','annual','requested',next],['overview-legacy','legacy','requested',next],['overview-approved','annual','approved',next],['overview-sick','sick','approved',next]])statements.push(`INSERT INTO rota_time_off(id,user_id,from_day,to_day,status,created_at,kind)VALUES(${quoted(id)},${quoted(owner)},${quoted(from)},${quoted(from)},${quoted(status)},${now},${quoted(kind)})`);
  const invoice={dueDate:'2020-01-01',invoiceDate:today,billTo:{name:'Overview test customer'},paymentTerms:{label:'Net 30'},totals:{grossPence:124000}};
  statements.push(`INSERT INTO wholesale_invoices(invoice_number,order_id,customer_id,request_key,data,issued_at,issued_by)VALUES('OV-1','overview-invoiced','overview-customer','overview-invoice',${quoted(JSON.stringify(invoice))},${now},'test-admin')`);
  srv.sql(statements.join(';'));
  return {today,week,next,owner};
}
