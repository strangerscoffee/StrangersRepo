/** SQL shared by automatic preparation, export and email. The arguments are internal column expressions or binds. */
export function automaticAllowed(invoice: string, actor: string, email = false) {
  return `EXISTS(SELECT 1 FROM wholesale_auto_invoices a
    LEFT JOIN wholesale_auto_invoicing s ON s.id=1
    LEFT JOIN wholesale_invoice_batch_items j ON a.source='batch:'||j.id AND j.invoice_id=a.invoice_id AND j.state='issued'
    LEFT JOIN wholesale_invoice_batches b ON b.id=j.batch_id AND b.state='approved'
    WHERE a.invoice_id=${invoice} AND a.state IN ('issued','exporting','held')
      AND COALESCE(b.by_id,json_extract(s.data,'$.enabledBy'))=${actor}
      AND ((substr(a.source,1,6)<>'batch:' AND json_extract(s.data,'$.issue')=1 AND json_extract(s.data,'$.quickbooks')=1
        ${email ? "AND json_extract(s.data,'$.email')=1" : ""})
        OR (b.delivery IN (${email ? "'email'" : "'export','email'"}) AND
          EXISTS(SELECT 1 FROM quickbooks_settings q JOIN quickbooks_connections c ON c.environment=q.active_environment
            WHERE q.id=1 AND c.environment=b.environment AND c.realm_id=b.realm_id AND c.generation=b.generation AND c.status='connected')))
      AND NOT EXISTS(SELECT 1 FROM wholesale_preview WHERE kind='customer' AND id=a.customer_id AND (json_extract(data,'$.hidePrices')=1 OR json_extract(data,'$.noInvoice')=1)))`;
}
