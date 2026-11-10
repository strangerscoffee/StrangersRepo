// Synthetic invoice and mappings only. No production company or personal data.
const scope = { environment: 'sandbox', realmId: '1234567890' };
export function exampleInvoice() {
  return {
    id: 42, number: 'SC-0042', issuedAt: Date.parse('2026-11-10T12:00:00Z'), issuedBy: 'private-employee-id-not-for-export',
    orderId: 'WS-EXAMPLE', orderReference: 'DEMO-PO', customerId: 'example-business', invoiceDate: '2026-11-10', supplyDate: '2026-11-10', dueDate: '2026-12-10',
    seller: {legalName:'Example Roastery Ltd',address:'Example business address',vatNumber:'GB123456789',companyNumber:'00000000',email:'',phone:''},
    billTo:{name:'Example Cafe Ltd',address:'Example customer address',postcode:'NR1 1AA',vatNumber:''}, deliveryLocation:null,
    priceBasis:'inclusive', lines:[
      {kind:'coffee',description:'Example standard coffee',packLabel:'1 kg bag',grindLabel:'Beans',quantity:2,unitPricePence:3700,rateId:'standard',rateLabel:'Standard VAT',vatBasisPoints:2000,netPence:6167,vatPence:1233,grossPence:7400},
      {kind:'coffee',description:'Example zero-rated item',packLabel:'250 g bag',grindLabel:'Filter / Medium',quantity:3,unitPricePence:1050,rateId:'zero',rateLabel:'Zero rated',vatBasisPoints:0,netPence:3150,vatPence:0,grossPence:3150},
      {kind:'delivery',description:'Delivery',quantity:1,unitPricePence:500,rateId:'standard',rateLabel:'Standard VAT',vatBasisPoints:2000,netPence:417,vatPence:83,grossPence:500},
    ], totals:{netPence:9734,vatPence:1316,grossPence:11050},
    vatBreakdown:[{rateId:'standard',label:'Standard VAT',basisPoints:2000,netPence:6584,vatPence:1316,grossPence:7900},{rateId:'zero',label:'Zero rated',basisPoints:0,netPence:3150,vatPence:0,grossPence:3150}],
    paymentTerms:{id:'net-30',label:'30 days from invoice',note:'Quote invoice number'},paymentInstructions:'Synthetic payment instructions only.',orderVersion:1,settingsVersion:1,
    payment:{status:'unpaid',paid:false,paidDate:null,reference:'',version:0,outstandingPence:11050},
  };
}
export function exampleMappings() {
  const ref = id => ({...scope,id,active:true});
  return {...scope,installationId:'strangers-demo-installation',company:{country:'GB',currency:'GBP',vatNumber:'123456789',reviewed:true},customer:{...ref('99'),localCustomerId:'example-business'},items:{coffee:ref('50'),delivery:ref('51')},taxCodes:{standard:{...ref('3'),basisPoints:2000,sales:true,reviewed:true},zero:{...ref('4'),basisPoints:0,sales:true,reviewed:true}}};
}
export function exampleLink(preview) {return {...preview.scope,localInvoiceId:42,remoteInvoiceId:'77',customerRef:'99',number:'SC-0042',requestId:preview.requestId,fingerprint:preview.fingerprint};}
export function exampleRemote(balance='110.50') {return {Id:'77',DocNumber:'SC-0042',SyncToken:'0',CustomerRef:{value:'99'},CurrencyRef:{value:'GBP'},TotalAmt:'110.50',Balance:balance,TxnTaxDetail:{TotalTax:'13.16'}};}
