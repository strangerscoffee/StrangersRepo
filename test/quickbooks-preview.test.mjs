import {test} from 'node:test';
import assert from 'node:assert/strict';
import {previewInvoice, creationDecision, decimalPence, reconcileInvoice} from '../src/quickbooks/preview.ts';
import {exampleInvoice,exampleMappings,exampleLink,exampleRemote} from './fixtures/quickbooks.mjs';
const has = (preview, code) => preview.blockers.some(item=>item.code===code);
const preview = (invoice=exampleInvoice(), mappings=exampleMappings()) => previewInvoice(invoice,mappings);

test('QuickBooks preparation preserves exact mixed VAT, pack/grind, dates and terms without changing source or transmitting',async()=>{
  const invoice=exampleInvoice(), mappings=exampleMappings(), original=structuredClone({invoice,mappings});
  const result=await preview(invoice,mappings); assert.equal(result.state,'ready-for-sandbox-review'); assert.equal(result.canTransmit,false);
  assert.deepEqual(result.candidate.totals,{netPence:9734,vatPence:1316,grossPence:11050});
  assert.equal(result.candidate.lines[0].description,'Example standard coffee · 1 kg bag · Beans');
  assert.equal(result.candidate.lines[2].itemRef,'51'); assert.equal(result.candidate.lines[1].taxCodeRef,'4');
  assert.equal(result.candidate.dueDate,'2026-12-10'); assert.deepEqual(result.candidate.paymentTerms,invoice.paymentTerms);
  assert.deepEqual({invoice,mappings},original); assert.ok(!JSON.stringify(result).includes(invoice.issuedBy));
  assert.ok(!('payment' in result.candidate)); assert.ok(!('seller' in result.candidate),'do not export unnecessary supplier metadata');
});
test('QuickBooks preparation honours an exclusive VAT invoice without floating point recalculation',async()=>{
  const invoice=exampleInvoice(); invoice.priceBasis='exclusive';
  Object.assign(invoice.lines[0],{netPence:7400,vatPence:1480,grossPence:8880}); Object.assign(invoice.lines[2],{netPence:500,vatPence:100,grossPence:600});
  invoice.totals={netPence:11050,vatPence:1580,grossPence:12630}; Object.assign(invoice.vatBreakdown[0],{netPence:7900,vatPence:1580,grossPence:9480});
  const result=await preview(invoice); assert.equal(result.state,'ready-for-sandbox-review'); assert.deepEqual(result.candidate.totals,invoice.totals);
});
test('QuickBooks preparation blocks drafts, missing due dates, invalid days and long numbers',async()=>{
  for(const [patch,code] of [[{id:null},'issued_invoice'],[{number:'X'.repeat(22)},'invoice_number'],[{dueDate:null},'invoice_dates'],[{supplyDate:'2026-02-30'},'invoice_dates'],[{dueDate:'2026-11-09'},'due_date']]) {
    const result=await preview({...exampleInvoice(),...patch}); assert.equal(result.candidate,null); assert.ok(has(result,code));
  }
});
test('Production preparation is a side-effect-free review with environment-matching references',async()=>{
  const mappings=exampleMappings();mappings.environment='production';mappings.customer.environment='production';
  for(const value of Object.values(mappings.items))value.environment='production';
  for(const value of Object.values(mappings.taxCodes))value.environment='production';
  const result=await preview(exampleInvoice(),mappings);assert.equal(result.state,'ready-for-live-review');assert.equal(result.canTransmit,false);assert.equal(creationDecision(result),'review-create');
});
test('QuickBooks preparation requires matching UK GBP supplier and exact business mapping',async()=>{
  for(const change of [m=>m.company.country='US',m=>m.company.currency='EUR',m=>m.company.reviewed=false,m=>m.company.vatNumber='GB999999999',m=>m.customer.localCustomerId='another-business',m=>m.customer.active=false]) {
    const mappings=exampleMappings(); change(mappings); const result=await preview(exampleInvoice(),mappings); assert.equal(result.state,'blocked'); assert.equal(result.candidate,null);
  }
});
test('QuickBooks item, customer and tax references cannot cross a company or environment boundary',async()=>{
  for(const key of ['customer','item','tax']) for(const field of ['realmId','environment']) {
    const mappings=exampleMappings(), ref=key==='customer'?mappings.customer:key==='item'?mappings.items.coffee:mappings.taxCodes.standard;
    ref[field]=field==='realmId'?'9999':'production'; assert.equal((await preview(exampleInvoice(),mappings)).state,'blocked');
  }
});
test('QuickBooks VAT mapping cannot infer exempt from zero rated or reuse a changed percentage',async()=>{
  const mappings=exampleMappings(); mappings.taxCodes.standard.basisPoints=500;
  assert.ok(has(await preview(exampleInvoice(),mappings),'vat_mapping'));
  const invoice=exampleInvoice(); invoice.lines[1].rateId='exempt'; invoice.vatBreakdown[1].rateId='exempt';
  assert.ok(has(await preview(invoice),'vat_mapping'),'same zero percentage does not prove the same tax treatment');
});
test('QuickBooks preparation rejects line, VAT-breakdown and total inconsistencies',async()=>{
  for(const change of [i=>i.lines[0].vatPence++,i=>i.totals.grossPence++,i=>i.vatBreakdown[0].netPence++,i=>i.vatBreakdown.push({...i.vatBreakdown[0]}),i=>i.lines[0].unitPricePence=3700.1]) {
    const invoice=exampleInvoice(); change(invoice); assert.equal((await preview(invoice)).candidate,null);
  }
});
test('QuickBooks request IDs stay stable across payment metadata and mapping changes while fingerprints catch changed export content',async()=>{
  const first=await preview(), changed=exampleInvoice(); changed.payment.paid=true; changed.payment.reference='manual note'; changed.issuedBy='another-employee';
  const second=await preview(changed); assert.equal(first.requestId,second.requestId); assert.equal(first.fingerprint,second.fingerprint);
  const mappings=exampleMappings(); mappings.taxCodes.standard.id='12'; const remapped=await preview(exampleInvoice(),mappings);
  assert.equal(remapped.requestId,first.requestId); assert.notEqual(remapped.fingerprint,first.fingerprint);
  assert.equal(creationDecision(remapped,exampleLink(first)),'conflict','never mint a new request ID after remapping an uncertain operation');
  assert.ok(first.requestId.length<=50); assert.match(first.requestId,/^sc-inv-[a-f0-9]{40}$/);
});
test('QuickBooks creation planning detects existing links and mismatched remote IDs or local snapshots',async()=>{
  const plan=await preview(), link=exampleLink(plan); assert.equal(creationDecision(plan),'review-create'); assert.equal(creationDecision(plan,link),'already-linked');
  for(const patch of [{realmId:'999'},{environment:'production'},{localInvoiceId:43},{number:'OTHER'},{customerRef:'2'},{remoteInvoiceId:''},{fingerprint:'wrong'}]) assert.equal(creationDecision(plan,{...link,...patch}),'conflict');
});
test('QuickBooks request IDs are isolated by installation and target company',async()=>{
  const first=await preview(), another=exampleMappings(); another.installationId='different-installation'; assert.notEqual((await preview(exampleInvoice(),another)).requestId,first.requestId);
  for(const ref of [another,another.customer,...Object.values(another.items),...Object.values(another.taxCodes)]) ref.realmId='22222';
  assert.notEqual((await preview(exampleInvoice(),another)).requestId,first.requestId);
});
test('QuickBooks money parser accepts exact GBP amounts and rejects sub-penny, negative or invalid numbers',()=>{
  for(const [value,pence] of [['0',0],['110.50',11050],[110.5,11050],['0.01',1],['1.2',120]]) assert.equal(decimalPence(value),pence);
  for(const value of [null,undefined,true,'',-1,'-0.01','1.001','1e2',Infinity,NaN,'9'.repeat(40),{}]) assert.equal(decimalPence(value),null);
});
test('QuickBooks balance observations distinguish unpaid, part-paid and paid without changing the invoice',async()=>{
  const invoice=exampleInvoice(), original=structuredClone(invoice), plan=await preview(invoice), link=exampleLink(plan);
  for(const [balance,status,paid] of [['110.50','unpaid',0],['60.50','part-paid',5000],['0','paid',11050]]) {
    const result=reconcileInvoice(plan,link,plan.scope,exampleRemote(balance)); assert.equal(result.status,status); assert.equal(result.paidPence,paid);
  }
  assert.deepEqual(invoice,original);
});
test('QuickBooks reconciliation rejects another invoice, currency, company or customer',async()=>{
  const plan=await preview(), link=exampleLink(plan);
  for(const patch of [{Id:'78'},{DocNumber:'OTHER'},{CustomerRef:{value:'100'}},{CurrencyRef:{value:'EUR'}},{SyncToken:''}]) assert.equal(reconcileInvoice(plan,link,plan.scope,{...exampleRemote(),...patch}).status,'review');
  assert.equal(reconcileInvoice(plan,link,{...plan.scope,realmId:'999'},exampleRemote()).status,'review');
  assert.equal(reconcileInvoice(plan,link,{...plan.scope,environment:'production'},exampleRemote()).status,'review');
});
test('QuickBooks reconciliation does not mark voided, mismatched or missing invoices paid',async()=>{
  const plan=await preview(), link=exampleLink(plan);
  for(const remote of [null,{...exampleRemote('0'),TotalAmt:0},{...exampleRemote('0'),TxnTaxDetail:{TotalTax:0}},{...exampleRemote(),Balance:undefined},exampleRemote('-0.01'),exampleRemote('120.00'),exampleRemote('0.001')]) assert.equal(reconcileInvoice(plan,link,plan.scope,remote).status,'review');
});

test('QuickBooks preparation rejects absent installation IDs and loosely typed approval flags',async()=>{
  for(const change of [m=>m.installationId=undefined,m=>m.installationId=null,m=>m.company.reviewed='yes',m=>m.taxCodes.standard.reviewed='yes',m=>m.taxCodes.standard.sales='yes']) {
    const mappings=exampleMappings(); change(mappings); assert.equal((await preview(exampleInvoice(),mappings)).state,'blocked');
  }
});
