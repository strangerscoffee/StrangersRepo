type Address = Partial<Record<'Line1' | 'Line2' | 'Line3' | 'Line4' | 'Line5' | 'City' | 'CountrySubDivisionCode' | 'Country' | 'PostalCode', unknown>>;

const fields = ['Line1', 'Line2', 'Line3', 'Line4', 'Line5'] as const;
const ukPostcodeAtEnd = /(?:^| )((?:[a-z]{1,2}\d[a-z\d]?|gir) ?\d[a-z]{2})$/;
const ukCountry = /^(?:uk|gb|gbr|united kingdom|great britain|england|scotland|wales|northern ireland)$/;
const addressText = (value: unknown) => typeof value === 'string'
  ? value.normalize('NFC').toLowerCase().replace(/[‘’]/g, "'").replace(/[,\s]+/g, ' ').trim()
  : '';
const postcodeText = (value: unknown) => addressText(value).replaceAll(' ', '');
const endsWith = (value: string, part: string) => value === part || value.endsWith(' ' + part);

function postalDetails(address: Address) {
  let text = fields.map(field => addressText(address[field])).filter(Boolean).join(' ');
  const country = addressText(address.Country);
  const declaredCode = postcodeText(address.PostalCode);
  // QuickBooks can put the postcode at the end of a free-form line, with or without a separate PostalCode.
  const withoutCountry = text.replace(/ (?:uk|gb|gbr|united kingdom|great britain)$/, '');
  const embeddedCode = withoutCountry.match(ukPostcodeAtEnd);
  const parsedCode = postcodeText(embeddedCode?.[1]);
  if (embeddedCode) text = withoutCountry.slice(0, embeddedCode.index).trimEnd();

  const city = addressText(address.City), county = addressText(address.CountrySubDivisionCode);
  const locality = [city, county].filter(Boolean).join(' ');
  if (locality && !endsWith(text, locality)) {
    for (const part of [city, county]) {
      if (part && !endsWith(text, part)) text = [text, part].filter(Boolean).join(' ');
    }
  }
  const postcode = declaredCode || parsedCode;
  return { text, postcode, conflictingPostcodes: !!declaredCode && !!parsedCode && declaredCode !== parsedCode,
    country: ukCountry.test(country) || (!country && ukPostcodeAtEnd.test(postcode)) ? 'uk' : country };
}

function withoutRecipient(address: string, recipient: string) {
  if (recipient && address === recipient) return '';
  return recipient && address.startsWith(recipient + ' ') ? address.slice(recipient.length + 1) : address;
}

/** Compare the address on the issued invoice with both QuickBooks address representations. */
export function invoiceAddressDifference(saved: Address | undefined, remote: Address | undefined, recipient: string, customerName: unknown): 'address' | 'postcode' | null {
  if (!saved || !remote) return 'address';
  const expected = postalDetails(saved), observed = postalDetails(remote);
  if (expected.conflictingPostcodes || observed.conflictingPostcodes || expected.postcode !== observed.postcode) return 'postcode';
  if (expected.country && observed.country && expected.country !== observed.country) return 'address';

  const name = addressText(recipient), customer = addressText(customerName);
  const names = [name, customer].sort((left, right) => right.length - left.length);
  const address = withoutRecipient(expected.text, name);
  if (!address) return 'address';
  let formatted = observed.text;
  // Intuit may prepend the linked customer and company names to the original address lines.
  for (let prefix = 0; prefix < 3; prefix++) {
    if (formatted === address) return null;
    let next = withoutRecipient(formatted, names[0]);
    if (next === formatted) next = withoutRecipient(formatted, names[1]);
    if (next === formatted) break;
    formatted = next;
  }
  return formatted === address ? null : 'address';
}
