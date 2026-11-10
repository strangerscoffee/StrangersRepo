// Offline demonstration only. Uses synthetic fixtures and never reads the database or calls Intuit.
import {previewInvoice, creationDecision, reconcileInvoice} from '../src/quickbooks/preview.ts';
import {exampleInvoice,exampleMappings,exampleLink,exampleRemote} from '../test/fixtures/quickbooks.mjs';
const prepared=await previewInvoice(exampleInvoice(),exampleMappings());
const missingVat=exampleMappings(); delete missingVat.taxCodes.zero;
const blocked=await previewInvoice(exampleInvoice(),missingVat);
console.log(JSON.stringify({
  purpose:'Synthetic QuickBooks Online integration preview; no company connected and no data transmitted.',
  prepared, creation:creationDecision(prepared),
  missingVatMapping:{state:blocked.state,blockers:blocked.blockers},
  alreadyLinked:creationDecision(prepared,exampleLink(prepared)),
  partialPayment:reconcileInvoice(prepared,exampleLink(prepared),prepared.scope,exampleRemote('60.50')),
  changedAccountingTotal:reconcileInvoice(prepared,exampleLink(prepared),prepared.scope,{...exampleRemote('0'),TotalAmt:'109.50'}),
},null,2));
