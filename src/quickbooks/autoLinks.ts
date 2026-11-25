// Automatic invoicing (src/autoInvoice.ts): before an invoice goes to QuickBooks, its business and each coffee and bag
// size are linked to a QuickBooks customer and item. An existing record with the same name is used first (the customer's
// QuickBooks name from the import, or the business name; for items, the product names Insights' QuickBooks history
// matched to that coffee and size, or the name we'd give it); otherwise one is made. Each create carries a request ID
// derived from what it's for, so a lost reply can't make two.
import { ApiError, type Env } from '../http';
import { cleanEmail } from '../email/address';
import { get } from '../wholesaleStore';
import type { InvoiceDocument } from '../wholesaleInvoices';
import { ProviderError, id, type Connection } from './connection';
import { mapping } from './mappings';
import { digest } from './crypto';
import type { Environment } from './preview';

type Read = (path: string) => Promise<any>;
type Write = (path: string, payload: unknown, contentType?: string) => Promise<any>;
interface Resources { read: Read; write: Write; check: () => Promise<void> }
interface Customer { business: string; email?: string; accountsEmail?: string; phone?: string; address?: string; postcode?: string; quickbooksName?: string }

const quote = (value: string) => "'" + value.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
/** QuickBooks names: no colons (they mark sub-items), no tabs or new lines, at most 100 characters. */
export const qbName = (value: string) => value.replace(/[:\t\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
const nameWithSuffix = (title: string, suffix: string) => qbName(title).slice(0, 100 - suffix.length).trimEnd() + suffix;
const SIZE: Record<string, { name: string; sku: string }> = { quarter: { name: '250g', sku: '250G' }, kilo: { name: '1kg', sku: '1KG' }, half: { name: '500g', sku: '500G' } };

async function query(read: Read, entity: 'Customer' | 'Item', field: 'DisplayName' | 'Name', value: string) {
  const data = await read('/query?minorversion=75&query=' + encodeURIComponent(`SELECT * FROM ${entity} WHERE ${field} = ${quote(value)} MAXRESULTS 5`));
  const rows = data.QueryResponse?.[entity] || [];
  return (Array.isArray(rows) ? rows : []).filter((row: any) => row && /^\d{1,32}$/.test(row.Id || '') && String(row[field] || '').toLowerCase() === value.toLowerCase());
}

/** The business's QuickBooks customer, found or made, saved in the company's mappings. */
export async function ensureCustomer(env: Env, mode: Environment, company: Connection, resources: Resources, customerId: string): Promise<{ id: string; created: boolean }> {
  const saved = await mapping(env, mode, company.realm_id);
  if (saved.data.customerLinks[customerId]) return { id: saved.data.customerLinks[customerId], created: false };
  if (!saved.version) throw new ApiError(409, 'quickbooks_mappings', 'Choose the QuickBooks coffee item and VAT codes (QuickBooks → Mappings) before invoices can be sent automatically.');
  const customer = await get<Customer>(env, 'customer', customerId);
  if (!customer) throw new ApiError(409, 'quickbooks_customer', 'The wholesale business was not found.');
  const names = [...new Set([customer.quickbooksName, customer.business].map((name) => qbName(name || '')).filter(Boolean))];
  if (!names.length) throw new ApiError(409, 'quickbooks_customer', 'Link a QuickBooks customer for this business in Mappings.');
  let found: any = null;
  for (const name of names) {
    const rows = await query(resources.read, 'Customer', 'DisplayName', name);
    const usable = rows.filter((row: any) => row.Active !== false && (!row.CurrencyRef?.value || row.CurrencyRef.value === 'GBP'));
    if (usable.length > 1) throw new ApiError(409, 'quickbooks_customer', `More than one QuickBooks customer is called ${name}. Link the right one in QuickBooks → Mappings.`);
    if (usable.length) { found = usable[0]; break; }
    if (rows.length) throw new ApiError(409, 'quickbooks_customer', `The QuickBooks customer called ${name} is inactive or not in GBP. Link one in QuickBooks → Mappings.`);
  }
  let created = false;
  if (!found) {
    const name = names.at(-1)!, email = cleanEmail(customer.accountsEmail || customer.email || '');
    const lines = String(customer.address || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 4);
    const body = {
      DisplayName: name, CompanyName: name,
      ...(email && email.length <= 100 ? { PrimaryEmailAddr: { Address: email } } : {}),
      ...(customer.phone ? { PrimaryPhone: { FreeFormNumber: customer.phone.slice(0, 30) } } : {}),
      ...(lines.length ? { BillAddr: { ...Object.fromEntries(lines.map((line, i) => ['Line' + (i + 1), line.slice(0, 500)])), PostalCode: String(customer.postcode || '').slice(0, 30) } } : {}),
    };
    const requestId = 'sc-cust-' + (await digest(JSON.stringify([mode, company.realm_id, customerId]))).slice(0, 40);
    try { found = (await resources.write('/customer?minorversion=75&requestid=' + requestId, body)).Customer; }
    catch (error) {
      if (error instanceof ProviderError && error.faultCode === '6240') throw new ApiError(409, 'quickbooks_customer', `QuickBooks already has a customer, supplier or employee called ${name}. Link the customer in QuickBooks → Mappings.`);
      throw error;
    }
    if (!/^\d{1,32}$/.test(found?.Id || '')) throw new ApiError(503, 'quickbooks_unavailable', 'QuickBooks did not confirm the new customer. It will be tried again.');
    created = true;
  }
  await resources.check();
  const key = '$.customerLinks.' + JSON.stringify(customerId);
  const stored = await env.DB.prepare(`UPDATE quickbooks_environment_mappings SET data=json_set(data,?,?),version=version+1,updated_at=?
    WHERE environment=? AND realm_id=? AND json_extract(data,?) IS NULL
      AND NOT EXISTS(SELECT 1 FROM json_each(quickbooks_environment_mappings.data,'$.customerLinks') WHERE value=? AND key<>?)
      AND EXISTS(SELECT 1 FROM wholesale_preview WHERE kind='customer' AND id=? AND version=?)
      AND EXISTS(SELECT 1 FROM quickbooks_connections WHERE environment=? AND generation=? AND version=? AND status='connected')
    RETURNING version`)
    .bind(key, found.Id, Date.now(), mode, company.realm_id, key, found.Id, customerId, customerId, customer.version, mode, company.generation, company.version).first();
  if (!stored) {
    const now = await mapping(env, mode, company.realm_id);
    if (Object.entries(now.data.customerLinks).some(([local, remote]) => local !== customerId && remote === found.Id)) {
      throw new ApiError(409, 'quickbooks_customer', 'This QuickBooks customer is already linked to another business. Check the customer in Mappings.');
    }
    if (now.data.customerLinks[customerId] !== found.Id) throw new ApiError(409, 'quickbooks_changed', 'The QuickBooks mappings changed while linking the customer. It will be tried again.');
  }
  return { id: found.Id, created };
}

/** Each coffee's product number (SC1001, SC1002…), given once the first time it's needed. */
export async function productNumber(env: Env, productId: string): Promise<number> {
  // Allocate and read in one D1 transaction. The outer WHERE skips an existing coffee before allocating.
  const [, selected] = await env.DB.batch<{ number: number }>([
    env.DB.prepare(`INSERT INTO wholesale_product_numbers(product_id,number,created_at)
      SELECT ?1,COALESCE((SELECT MAX(number) FROM wholesale_product_numbers),1000)+1,?2
      WHERE NOT EXISTS(SELECT 1 FROM wholesale_product_numbers WHERE product_id=?1)`).bind(productId, Date.now()),
    env.DB.prepare('SELECT number FROM wholesale_product_numbers WHERE product_id=?').bind(productId),
  ]);
  const number = selected.results[0]?.number;
  if (number !== undefined) return number;
  throw new ApiError(503, 'quickbooks_busy', 'Could not give this coffee a product number. It will be tried again.');
}

/** A QuickBooks item for each coffee and bag size on the invoice, found or made, saved for this company. */
export async function ensureItems(env: Env, mode: Environment, company: Connection, resources: Resources, invoice: InvoiceDocument): Promise<number> {
  const wanted = new Map<string, { productId: string; pack: string; title: string }>();
  for (const line of invoice.lines) if (line.kind === 'coffee' && line.productId && line.pack && SIZE[line.pack]) wanted.set(line.productId + ':' + line.pack, { productId: line.productId, pack: line.pack, title: line.description });
  if (!wanted.size) return 0;
  const known = new Set((await env.DB.prepare('SELECT product_key FROM quickbooks_product_items WHERE environment=? AND realm_id=? AND product_key IN (SELECT value FROM json_each(?))').bind(mode, company.realm_id, JSON.stringify([...wanted.keys()])).all<{ product_key: string }>()).results.map((row) => row.product_key));
  const missing = [...wanted].filter(([key]) => !known.has(key));
  if (!missing.length) return 0;
  const saved = await mapping(env, mode, company.realm_id);
  if (!saved.data.coffeeItemId) throw new ApiError(409, 'quickbooks_mappings', 'Choose the general QuickBooks coffee item (QuickBooks → Mappings): new coffee items use its income account.');
  const template = (await resources.read('/item/' + id(saved.data.coffeeItemId) + '?minorversion=75')).Item;
  if (!template?.IncomeAccountRef?.value || !['Service', 'NonInventory'].includes(template.Type)) throw new ApiError(409, 'quickbooks_mappings', 'The general QuickBooks coffee item needs to be a service or non-inventory item with an income account.');
  const history = (await env.DB.prepare("SELECT product, data FROM sales_history_products WHERE reviewed=1").all<{ product: string; data: string }>()).results.map((row) => ({ product: row.product, ...(JSON.parse(row.data) as { coffee: string | null; pack: string }) }));
  let made = 0;
  for (const [key, { productId, pack, title }] of missing) {
    const number = await productNumber(env, productId), sku = `SC${number}-${SIZE[pack].sku}`;
    const size = ` ${SIZE[pack].name}`, ours = nameWithSuffix(title, size), alternate = nameWithSuffix(title, `${size} (${sku})`);
    const names = [...new Set([...history.filter((h) => h.coffee === productId && h.pack === pack).flatMap((h) => [h.product, h.product.split(':').at(-1)!]), ours, alternate].map(qbName).filter(Boolean))];
    let found: any = null;
    let useAlternate = false;
    for (const name of names) {
      const matches = await query(resources.read, 'Item', 'Name', name);
      const rows = matches.filter((row: any) => row.Active !== false && ['Service', 'NonInventory'].includes(row.Type) && row.IncomeAccountRef?.value
        && (row.Sku === sku || (name !== alternate && !/^SC\d+-(?:250G|500G|1KG)$/i.test(row.Sku || ''))));
      if (rows.length === 1) { found = rows[0]; break; }
      if (name === ours && matches.length) useAlternate = true;
    }
    let created = false, name = found?.Name || ours;
    if (!found) {
      const attempt = async (itemName: string) => {
        const identity = itemName === qbName(`${title}${size}`) ? [mode, company.realm_id, key] : [mode, company.realm_id, key, itemName];
        const requestId = 'sc-item-' + (await digest(JSON.stringify(identity))).slice(0, 40);
        return (await resources.write('/item?minorversion=75&requestid=' + requestId, { Name: itemName, Sku: sku, Type: template.Type, IncomeAccountRef: { value: template.IncomeAccountRef.value }, Description: `${title}, ${SIZE[pack].name} bag`.slice(0, 4000) })).Item;
      };
      if (useAlternate) name = alternate;
      try { found = await attempt(name); }
      catch (error) {
        // The name is taken by something that can't be sold (an inventory item, a category): use the product number too.
        if (!(error instanceof ProviderError && error.faultCode === '6240') || name === alternate) throw error;
        name = alternate;
        found = await attempt(name);
      }
      if (!/^\d{1,32}$/.test(found?.Id || '') || found.Sku !== sku || found.Name !== name) throw new ApiError(503, 'quickbooks_unavailable', 'QuickBooks did not confirm the new item. It will be tried again.');
      created = true;
    }
    await resources.check();
    await env.DB.prepare('INSERT OR IGNORE INTO quickbooks_product_items(environment,realm_id,product_key,item_id,name,sku,created_remote,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(mode, company.realm_id, key, found.Id, String(found.Name || name).slice(0, 100), String(found.Sku || (created ? sku : '')).slice(0, 100), created ? 1 : 0, Date.now()).run();
    if (created) made++;
  }
  return made;
}
