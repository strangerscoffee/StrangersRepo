import { ApiError, type Env, invalid, json, readJson } from "./http";
import { audit } from "./audit";
import type { Customer } from "./wholesaleAccounts";
import { customerLocations, editedCustomerLocations, type CustomerLocation } from "./wholesaleCustomers";
import { get, object, save, text, version, type Versioned } from "./wholesaleStore";

type Snapshot = Partial<Pick<CustomerLocation, "address" | "postcode" | "contact" | "id">>;
interface OrderDestination {
  business: string;
  locationSnapshot?: Snapshot;
  customerSnapshot?: Snapshot;
}

function field(value: unknown, name: string, limit: number, required = true) {
  const cleaned = text(value, name, limit, required);
  if (/[\u0000-\u001f\u007f]/.test(cleaned)) throw invalid(`Check ${name}.`);
  return cleaned;
}

export function royalMailPostcode(value: unknown) {
  const code = field(value, "the UK postcode", 12).toUpperCase().replace(/ /g, "");
  if (!/^(?:GIR0AA|[A-Z]{1,2}[0-9][0-9A-Z]?[0-9][A-Z]{2})$/.test(code) || /^(?:BT|GY|JE|IM)/.test(code)) {
    throw invalid("Enter a valid Great Britain postcode.");
  }
  return code.slice(0, -3) + " " + code.slice(-3);
}

const embeddedPostcode = /\b(?:GIR\s*0AA|[A-Z]{1,2}[0-9][0-9A-Z]?\s*[0-9][A-Z]{2})\b/i;
const countyLine = /(?:shire$|^(?:(?:East|West|North|South) )?(?:Norfolk|Suffolk|Essex|Kent|Surrey|Sussex|Somerset|Dorset|Devon|Cornwall|Cumbria|Rutland|Middlesex|Durham|Hampshire|Isle of Wight|West Midlands|Greater London|Greater Manchester|Merseyside|Glamorgan|Gwent|Powys|Clwyd|Gwynedd|Dyfed|Antrim|Down|Armagh|Tyrone|Fermanagh|Londonderry)$)/i;
const streetLine = /\s(?:road|street|lane|close|drive|avenue|way|terrace|court|place|crescent)$/i;

// The label preview and the carrier payload use the same field boundaries and postcode formatting.
export function checkedRoyalMailRecipient(recipient: Record<string, unknown>) {
  const county = field(recipient.county, "county", 100, false);
  return {
    name: field(recipient.name, "recipient name", 100),
    line1: field(recipient.line1, "address line 1", 100),
    line2: field(recipient.line2, "address line 2", 100, false),
    city: field(recipient.city, "town or city", 100),
    postcode: royalMailPostcode(recipient.postcode),
    ...(county ? { county } : {}),
  };
}

export function royalMailRecipientDraft(order: OrderDestination) {
  const saved = order.locationSnapshot ?? order.customerSnapshot;
  const name = (typeof saved?.contact === "string" && saved.contact.trim()) || order.business;
  const parts = (typeof saved?.address === "string" ? saved.address : "").split(/[,\r\n]+/).map(line => line.trim()).filter(Boolean);
  const removeCountry = () => {
    if (/^(?:UK|United Kingdom|Great Britain|England|Scotland|Wales)$/i.test(parts.at(-1) || "")) parts.pop();
  };
  removeCountry();
  let postcode = typeof saved?.postcode === "string" ? saved.postcode.trim() : "";
  if (!postcode) postcode = parts.at(-1)?.match(embeddedPostcode)?.[0] || "";
  try {
    postcode = royalMailPostcode(postcode);
    const [outward, inward] = postcode.split(" ");
    const suffix = new RegExp(`(?:^|\\s+)${outward}\\s*${inward}$`, "i");
    if (parts.length && suffix.test(parts.at(-1)!)) {
      const last = parts.pop()!.replace(suffix, "");
      if (last) parts.push(last);
    }
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
  }
  removeCountry();
  // A second or conflicting postcode in the free text needs a human to choose the destination.
  if (parts.some(line => embeddedPostcode.test(line))) postcode = "";
  const county = countyLine.test(parts.at(-1) || "") ? parts.pop()! : "";
  const town = parts.at(-1) || "";
  const city = parts.length > 1 && /^[\p{L}][\p{L} .’'-]+$/u.test(town) && !countyLine.test(town) && !streetLine.test(town) ? parts.pop()! : "";
  return { name, line1: parts.shift() || "", line2: parts.join(", "), city, postcode, ...(county ? { county } : {}) };
}

export function savedRoyalMailRecipient(order: OrderDestination) {
  try {
    return checkedRoyalMailRecipient(royalMailRecipientDraft(order));
  } catch (error) {
    if (error instanceof ApiError) return null;
    throw error;
  }
}

// The order's frozen location selects the address-book entry. Never substitute a customer's new default.
export async function royalMailAddressBook(req: Request, env: Env, order: OrderDestination & Versioned & {
  customerId?: string | null; locationId?: string;
}, actor: string) {
  if (!["GET", "PUT"].includes(req.method)) throw new ApiError(405, "method_not_allowed", "Use GET or PUT for the saved location.");
  const customer = order.customerId && await get<Customer>(env, "customer", order.customerId);
  const locationId = order.locationId || order.locationSnapshot?.id || "primary";
  const locations = customer ? customerLocations(customer) : [];
  const location = locations.find(item => item.id === locationId);
  if (!customer || !location) throw new ApiError(404, "not_found", "This delivery location is no longer in the address book.");
  const summary = { customerId: customer.id, locationId, name: location.name, address: location.address, postcode: location.postcode, version: customer.version };
  if (req.method === "GET") return json(summary);
  const body = object(await readJson(req, 4096));
  if (body.customerId !== customer.id || body.locationId !== locationId || version(body.orderVersion) !== order.version || version(body.ifVersion) !== customer.version) {
    throw new ApiError(409, "conflict", "The order or saved location changed. Review the current address before saving.");
  }
  const recipient = checkedRoyalMailRecipient(object(body.recipient));
  const address = [recipient.line1, recipient.line2, recipient.city, recipient.county].filter(Boolean).join("\n");
  if (location.address === address && location.postcode === recipient.postcode) return json(summary);
  const { id, version: expected, updatedAt, ...fields } = customer;
  const changed = locations.map(item => item.id === locationId ? { ...item, address, postcode: recipient.postcode } : item);
  const result = await save(env, "customer", id, editedCustomerLocations(fields, { locations: changed }), expected);
  await audit(env, "wholesale_preview_customer", actor, `Updated the saved delivery address for ${customer.business} from Royal Mail parcel review.`);
  return json({ ...summary, address, postcode: recipient.postcode, version: result.version });
}
