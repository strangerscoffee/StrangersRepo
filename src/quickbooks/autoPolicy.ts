/** SQL shared by automatic preparation, export and email. The arguments are internal column expressions or binds. */
export function automaticAllowed(invoice: string, actor: string, email = false) {
  return `EXISTS(SELECT 1 FROM wholesale_auto_invoices a JOIN wholesale_auto_invoicing s ON s.id=1
    WHERE a.invoice_id=${invoice} AND a.state IN ('issued','exporting','held')
      AND json_extract(s.data,'$.issue')=1 AND json_extract(s.data,'$.quickbooks')=1
      AND json_extract(s.data,'$.enabledBy')=${actor}
      ${email ? "AND json_extract(s.data,'$.email')=1" : ""}
      AND NOT EXISTS(SELECT 1 FROM wholesale_preview WHERE kind='customer' AND id=a.customer_id AND json_extract(data,'$.hidePrices')=1))`;
}
