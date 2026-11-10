// Reviewed UK invoice adapter. Source amounts are immutable integer pence.
import {invalid} from '../http';
import {decimalPence,type ExportPreview,type InvoiceCandidate} from './preview';
export const ADAPTER_VERSION='sc-qbo-invoice-v1';
export const vatKey=(value:string)=>value.replace(/[^A-Za-z0-9]/g,'').replace(/^GB/i,'').toUpperCase();
const pounds=(pence:number)=>pence/100;
const norm=(value:unknown)=>typeof value==='string'?value.replace(/\r\n?/g,'\n').trim():'';
export function profileKeys(candidate:InvoiceCandidate):string[]{
  return [...new Set(candidate.lines.map(line=>JSON.stringify([ADAPTER_VERSION,vatKey(candidate.supplierVat),candidate.priceBasis,line.kind,line.vatBasisPoints,line.taxable])))].sort();
}
function address(value:{name:string;address:string;postcode:string}){
  const parts=[value.name,...value.address.split(/\r?\n/)].flatMap(line=>line.match(/[\s\S]{1,500}/g)||[]);
  if(parts.length>5)throw invalid('The invoice address needs more than five QuickBooks address lines. Review it before exporting.');
  return{...Object.fromEntries(parts.map((line,index)=>['Line'+(index+1),line])),PostalCode:value.postcode};
}
export function buildPayload(preview:ExportPreview){
  const value=preview.candidate;if(preview.state==='blocked'||!value||!preview.requestId)throw invalid('Resolve the invoice review before sending it to QuickBooks.');
  const groups=new Map<string,{net:number;vat:number;percent:number}>();
  const lines=value.lines.map((line,index)=>{
    if(line.taxable&&!line.taxRateRef)throw invalid('Verify each sales VAT rate reference before exporting.');
    if(line.taxRateRef){const group=groups.get(line.taxRateRef)||{net:0,vat:0,percent:line.vatBasisPoints/100};if(group.percent!==line.vatBasisPoints/100)throw invalid('One QuickBooks tax rate has conflicting percentages.');group.net+=line.netPence;group.vat+=line.vatPence;groups.set(line.taxRateRef,group);}
    return{LineNum:index+1,Description:line.description,Amount:pounds(line.netPence),DetailType:'SalesItemLineDetail',SalesItemLineDetail:{ItemRef:{value:line.itemRef},Qty:line.quantity,UnitPrice:Math.round(line.netPence*1000/line.quantity)/100000,TaxCodeRef:{value:line.taxCodeRef},ServiceDate:value.supplyDate,...(value.priceBasis==='inclusive'?{TaxInclusiveAmt:pounds(line.grossPence)}:{})}};
  });
  const memo=['Supply date: '+value.supplyDate,'Payment terms: '+value.paymentTerms.label,value.paymentTerms.note].filter(Boolean).join('\n');
  const note=[ADAPTER_VERSION,'Strangers request: '+preview.requestId,'Strangers invoice: '+value.number,'Payment instructions:',value.paymentInstructions].join('\n');
  if(memo.length>1000||note.length>4000)throw invalid('Payment information exceeds the QuickBooks memo limits. Review it before exporting.');
  const payload={DocNumber:value.number,TxnDate:value.invoiceDate,DueDate:value.dueDate,CurrencyRef:{value:'GBP'},CustomerRef:{value:value.customerRef},GlobalTaxCalculation:value.priceBasis==='inclusive'?'TaxInclusive':'TaxExcluded',Line:lines,TxnTaxDetail:{TotalTax:pounds(value.totals.vatPence),TaxLine:[...groups].map(([ref,group])=>({Amount:pounds(group.vat),DetailType:'TaxLineDetail',TaxLineDetail:{TaxRateRef:{value:ref},PercentBased:true,TaxPercent:group.percent,NetAmountTaxable:pounds(group.net)}}))},BillAddr:address(value.billTo),ShipAddr:address(value.shipping),CustomerMemo:{value:memo},PrivateNote:note,EmailStatus:'NotSet',...(value.termRef?{SalesTermRef:{value:value.termRef}}:{})};
  return{payload,profiles:profileKeys(value)};
}
export interface InvoiceMatch {matches:boolean;reason:string}
/** Full financial identity protects lost-response recovery and explicit adoption of existing invoices. */
export function matchesInvoice(preview:ExportPreview,payload:any,remote:any,requireMarker=true):InvoiceMatch{
  const fail=(reason:string)=>({matches:false,reason});const value=preview.candidate;
  if(!value||!remote||!/^\d{1,32}$/.test(remote.Id||'')||!/^\d{1,32}$/.test(remote.SyncToken||''))return fail('The QuickBooks invoice identity or revision needs review.');
  if(remote.DocNumber!==value.number||remote.CustomerRef?.value!==value.customerRef||remote.CurrencyRef?.value!=='GBP')return fail('The QuickBooks invoice number, customer or currency differs.');
  if(remote.TxnDate!==value.invoiceDate||remote.DueDate!==value.dueDate)return fail('The QuickBooks invoice or due date differs from the issued invoice.');
  if(requireMarker&&!norm(remote.PrivateNote).includes('Strangers request: '+preview.requestId))return fail('An invoice with this number already exists. Review it before linking.');
  const tax=remote.TxnTaxDetail?.TotalTax===undefined&&value.totals.vatPence===0?0:decimalPence(remote.TxnTaxDetail?.TotalTax);
  if(decimalPence(remote.TotalAmt)!==value.totals.grossPence||tax!==value.totals.vatPence)return fail('QuickBooks net, VAT or total amounts differ from the issued invoice.');
  if(value.totals.vatPence&&remote.GlobalTaxCalculation!==payload.GlobalTaxCalculation)return fail('The QuickBooks inclusive/exclusive VAT treatment differs.');
  const rows=Array.isArray(remote.Line)?remote.Line.filter((line:any)=>line.DetailType==='SalesItemLineDetail'):[];
  if(rows.length!==value.lines.length)return fail('The QuickBooks invoice line count differs.');
  for(let index=0;index<rows.length;index++){
    const expected=value.lines[index],actual=rows[index],detail=actual.SalesItemLineDetail;
    if(decimalPence(actual.Amount)!==expected.netPence||Number(detail?.Qty)!==expected.quantity||detail?.ItemRef?.value!==expected.itemRef||detail?.TaxCodeRef?.value!==expected.taxCodeRef||norm(actual.Description)!==norm(expected.description))return fail('A QuickBooks invoice line, quantity, sales item or VAT code differs.');
    if(detail?.ServiceDate!==value.supplyDate)return fail('A QuickBooks supply date differs from the issued invoice.');
    if(detail?.TaxInclusiveAmt!==undefined&&decimalPence(detail.TaxInclusiveAmt)!==expected.grossPence)return fail('A QuickBooks VAT-inclusive line amount differs.');
  }
  const taxLines=Array.isArray(remote.TxnTaxDetail?.TaxLine)?remote.TxnTaxDetail.TaxLine:[];
  for(const expected of payload.TxnTaxDetail.TaxLine){
    const found=taxLines.filter((line:any)=>line.TaxLineDetail?.TaxRateRef?.value===expected.TaxLineDetail.TaxRateRef.value);
    if(expected.Amount!==0&&(found.length!==1||decimalPence(found[0].Amount)!==decimalPence(expected.Amount)||decimalPence(found[0].TaxLineDetail?.NetAmountTaxable)!==decimalPence(expected.TaxLineDetail.NetAmountTaxable)))return fail('The QuickBooks VAT breakdown differs from the issued invoice.');
  }
  for(const key of ['BillAddr','ShipAddr'])for(const [field,expected]of Object.entries(payload[key]))if(field!=='Country'&&norm(remote[key]?.[field])!==norm(expected))return fail('The QuickBooks billing or delivery address differs.');
  if(payload.SalesTermRef&&remote.SalesTermRef?.value!==payload.SalesTermRef.value)return fail('The QuickBooks payment terms differ.');
  return{matches:true,reason:''};
}
