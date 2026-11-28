import "../public/shared/wholesale-preparation.js";
import { readBytes } from "./http";

const CLICK_DROP = "https://api.parcel.royalmail.com/api/v1";
const TRACKING_V2 = "https://api.royalmail.net/mailpieces/v2";
const TIMEOUT_MS = 12000;
const JSON_LIMIT = 128 * 1024;
const CREATE_LIMIT = 1024 * 1024;
const PDF_LIMIT = 4 * 1024 * 1024;
const MISSING_ORDER = Symbol("missing-order");
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const UK_POSTCODE = /^(?:GIR0AA|[A-Z]{1,2}\d[\dA-Z]?\d[A-Z]{2})$/;
export const { royalMailTrackingNumber, royalMailTrackingV2Number } = globalThis.SCWholesalePreparation;
const PROVIDER_DATE = /^(20\d{2}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i;

type RoyalMailCode =
  | "royal_mail_configuration"
  | "royal_mail_invalid_shipment"
  | "royal_mail_auth"
  | "royal_mail_denied"
  | "royal_mail_rejected"
  | "royal_mail_rate_limited"
  | "royal_mail_unavailable"
  | "royal_mail_invalid_response"
  | "royal_mail_label_unavailable";

export class RoyalMailError extends Error {
  constructor(public code: RoyalMailCode, message: string, public status?: number, public uncertain = false) {
    super(message);
    this.name = "RoyalMailError";
  }
}

export interface RoyalMailOrderInput {
  reference: string;
  orderDate: string;
  recipient: {
    name: string;
    companyName?: string;
    addressLine1: string;
    addressLine2?: string;
    addressLine3?: string;
    city: string;
    county?: string;
    postcode: string;
    /** For delivery updates: tracked Parcelforce and Royal Mail services need a phone number or an email. */
    phoneNumber?: string;
    emailAddress?: string;
  };
  parcel: {
    weightInGrams: number;
    format: "parcel" | "smallParcel" | "mediumParcel";
  };
  serviceCode: string;
  serviceRegisterCode?: string;
  shippingAccountName?: string;
  subtotalPence: number;
  shippingPence: number;
  totalPence: number;
  taxPence?: number;
}

export interface RoyalMailOrder {
  orderId: number;
  reference: string;
  trackingNumber: string | null;
  providerState: "created" | "labelled" | "dispatched";
}

export function validRoyalMailCredential(value: unknown): value is string {
  return typeof value === "string" && /^[!-~]{1,512}$/.test(value);
}

export function validRoyalMailService(code: unknown, register: string | undefined, account: string | undefined): code is string {
  return typeof code === "string" && /^[A-Z0-9]{1,10}$/.test(code) &&
    (register === undefined || /^(?!00)\d{2}$/.test(register)) &&
    (account === undefined || typeof account === "string" && !!account.trim() &&
      account.length <= 50 && !/[\u0000-\u001f\u007f]/.test(account));
}

function invalidShipment(message: string): never {
  throw new RoyalMailError("royal_mail_invalid_shipment", message);
}

function invalidResponse(uncertain = false): RoyalMailError {
  return new RoyalMailError("royal_mail_invalid_response", "Royal Mail returned an unexpected response.", undefined, uncertain);
}

function orderReference(reference: string): string {
  if (typeof reference !== "string" || !REFERENCE.test(reference)) invalidShipment("Use a valid Royal Mail order reference.");
  return reference;
}

function addressPart(value: string | undefined, limit: number, required = false): string | undefined {
  if (typeof value === "string") {
    const cleaned = value.trim();
    if (cleaned && cleaned.length <= limit && !/[\u0000-\u001f\u007f]/.test(value)) return cleaned;
    if (cleaned || /[\u0000-\u001f\u007f]/.test(value)) {
      invalidShipment("Check the names and lines in the Royal Mail delivery address.");
    }
  }
  if (required || (value !== undefined && typeof value !== "string")) {
    invalidShipment("Check the required fields in the Royal Mail delivery address.");
  }
  return undefined;
}

function dateValue(value: unknown): value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return false;
  const date = PROVIDER_DATE.exec(value)?.[1];
  if (!date) return false;
  const calendarDay = new Date(date + "T00:00:00Z");
  return Number.isFinite(calendarDay.getTime()) && calendarDay.toISOString().startsWith(date + "T");
}

/** The recipient's phone number and email for Royal Mail's delivery updates, only when they look valid. */
function contactFor(recipient: RoyalMailOrderInput["recipient"]) {
  const phone = typeof recipient.phoneNumber === "string" ? recipient.phoneNumber.replace(/[^\d+ ]/g, "").replace(/\s+/g, " ").trim() : "";
  const email = typeof recipient.emailAddress === "string" ? recipient.emailAddress.trim() : "";
  return {
    ...(/^\+?\d[\d ]{6,23}$/.test(phone) ? { phoneNumber: phone } : {}),
    ...(email.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) ? { emailAddress: email } : {}),
  };
}

function orderBody(input: RoyalMailOrderInput) {
  const { reference, orderDate, recipient, parcel, serviceCode, serviceRegisterCode, shippingAccountName } = input;
  const orderRef = orderReference(reference);
  if (!dateValue(orderDate)) invalidShipment("Use a valid Royal Mail order date.");
  const postcode = addressPart(recipient.postcode, 20, true)!.toUpperCase().replace(/ /g, "");
  if (!UK_POSTCODE.test(postcode) || /^(?:BT|GY|JE|IM)/.test(postcode)) {
    invalidShipment("Enter a valid Great Britain postcode for this Royal Mail shipment.");
  }
  const { format, weightInGrams } = parcel;
  if (!["parcel", "smallParcel", "mediumParcel"].includes(format) ||
      !Number.isSafeInteger(weightInGrams) || weightInGrams < 1 || weightInGrams > 30000) {
    invalidShipment("Choose a parcel format and enter its packed weight in grams.");
  }
  if (!validRoyalMailService(serviceCode, serviceRegisterCode, shippingAccountName)) {
    invalidShipment("Choose a Royal Mail service configured for this account.");
  }

  const { subtotalPence, shippingPence, totalPence } = input;
  const taxPence = input.taxPence ?? totalPence - subtotalPence - shippingPence;
  if (![subtotalPence, shippingPence, taxPence, totalPence].every(value =>
      Number.isSafeInteger(value) && value >= 0 && value <= 99_999_900) ||
      subtotalPence + shippingPence + taxPence !== totalPence) {
    invalidShipment("Check the order totals before creating the Royal Mail shipment.");
  }

  return { items: [{
    orderReference: orderRef,
    orderDate: new Date(orderDate).toISOString(),
    isRecipientABusiness: true,
    recipient: { address: {
      fullName: addressPart(recipient.name, 210, true),
      companyName: addressPart(recipient.companyName, 100),
      addressLine1: addressPart(recipient.addressLine1, 100, true),
      addressLine2: addressPart(recipient.addressLine2, 100),
      addressLine3: addressPart(recipient.addressLine3, 100),
      city: addressPart(recipient.city, 100, true),
      county: addressPart(recipient.county, 100),
      postcode: postcode.slice(0, -3) + " " + postcode.slice(-3),
      countryCode: "GBR",
    }, ...contactFor(recipient) },
    packages: [{ weightInGrams, packageFormatIdentifier: format }],
    currencyCode: "GBP",
    subtotal: subtotalPence / 100,
    shippingCostCharged: shippingPence / 100,
    orderTax: taxPence / 100,
    total: totalPence / 100,
    postageDetails: { serviceCode, serviceRegisterCode, shippingAccountName },
    label: { includeLabelInResponse: true, includeReturnsLabel: false, includeCN: false },
  }] };
}

// Only recognised diagnostic phrases, known field names and recognised carrier codes may be stored on a shipment.
// Click & Drop can echo the entire submitted order and customer values in its errors.
const bookingFields: Record<string, string> = {
  fullname: "Check the recipient name.", companyname: "Check the recipient company name.",
  phonenumber: "Check the business contact phone number.", emailaddress: "Check the business order email address.",
  address: "Check the delivery address.", addressline1: "Check delivery address line 1.",
  addressline2: "Check delivery address line 2.", addressline3: "Check delivery address line 3.",
  city: "Check the delivery town or city.", postcode: "Check the delivery postcode.",
  county: "Check the delivery county.", countrycode: "Check the destination country.",
  servicecode: "Check that the configured service is available on this Royal Mail account for this parcel.",
  serviceregistercode: "Check the service register code in Royal Mail settings.",
  shippingaccountname: "Check the shipping account name in Royal Mail settings.",
  packageformatidentifier: "Check that the service accepts this parcel format.",
  weightingrams: "Check the sealed weight against the limit for the selected service.",
  includelabelinresponse: "Check that this Royal Mail account supports label generation by API.",
  subtotal: "Check the order subtotal.", total: "Check the order total.",
  orderdate: "Check the order date.", orderreference: "Check the order reference in Click & Drop.",
};

// Carrier error text can contain partial addresses, credentials or other customers' details, even when the
// documented field value is omitted. Quote only recognised diagnostic wording and safe field paths.
function diagnosticText(error: Record<string, unknown>) {
  return [error.errorMessage, error.message, error.detail, error.title, error.description, error.details]
    .filter((value): value is string => typeof value === "string" && !!value.trim());
}

function diagnosticFields(error: Record<string, unknown>) {
  const fields = Array.isArray(error.fields) ? error.fields.map(field => record(field)?.fieldName) : [];
  return [...fields, error.field, error.fieldName, error.propertyName].filter((field): field is string => typeof field === "string" && !!field.trim());
}

function safeFieldPath(path: string) {
  if (path.length > 80 || !/^(?:items\[0\]\.)?(?:(?:recipient(?:\.address)?|postageDetails|packages\[0\]|label)\.)?[a-z0-9]+$/i.test(path)) return false;
  return Object.hasOwn(bookingFields, path.slice(path.lastIndexOf(".") + 1).toLowerCase());
}

function safeCode(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const code = String(value);
  return /^(?:\d{1,8}|BadRequest|ValidationError|ValidationFailed|Invalid(?:Postcode|ServiceCode|ServiceRegisterCode|ParcelWeight))$/.test(code) ? code : "";
}

function recognisedReason(message: string, configuredService?: string): string {
  if (message.length > 4096) return "";
  const service = /^service code ([A-Z0-9]{1,10}) is not valid for (.+)$/i.exec(message);
  if (service && (service[1] === configuredService || ["NDB", "TPS24", "TPS48"].includes(service[1]))) {
    return "Service code " + service[1] + " is not valid for " + (service[2].includes(",") ? "…, …" : "…");
  }
  if (/^service (?:is )?not available on .+$/i.test(message)) return "Service not available on …";
  if (/^weight too high for .+$/i.test(message)) return "Weight too high for …";
  if (/^one or more validation errors occurred\.?$/i.test(message) ||
      /^invalid (?:service register code|service code|shipping account name|postcode|parcel weight|parcel format)\.?$/i.test(message) ||
      /^(?:(?:recipient|delivery|sender) )?(?:phone number|telephone number|email address|postcode|post code|service code|service register code|shipping account name|parcel weight|parcel format) (?:is (?:required|missing|invalid|not valid|not available)|must be (?:provided|specified|valid))\.?$/i.test(message)) {
    return message;
  }
  return "";
}

function carrierReason(error: Record<string, unknown>, configuredService?: string): string {
  const reason = diagnosticText(error).map(message => recognisedReason(message.trim(), configuredService)).find(Boolean);
  if (!reason) return "";
  const code = safeCode(error.errorCode ?? error.code);
  const parts = code ? ["code " + code] : [];
  const paths = [...new Set(diagnosticFields(error).filter(safeFieldPath))].slice(0, 3);
  if (paths.length) parts.push("field " + paths.join(", "));
  return reason + (parts.length ? " (" + parts.join(", ") + ")" : "");
}

function conflictingPurchaseEvidence(entry: Record<string, unknown>, reference: string | undefined) {
  const status = typeof entry.status === "number" || typeof entry.status === "string" ? String(entry.status).toLowerCase() : "";
  return entry.success === true || entry.isSuccess === true || ["200", "201", "202", "ok", "success", "accepted", "created"].includes(status) ||
    (typeof entry.code === "string" && /^(?:OK|Success|Created|Accepted)$/i.test(entry.code)) ||
    ["order", "orders", "items", "orderIdentifier", "orderId", "createdOn", "trackingNumber", "label",
    "createdOrders", "failedOrders", "successCount", "errorsCount"].some(field => Object.hasOwn(entry, field)) ||
    (Object.hasOwn(entry, "orderReference") && entry.orderReference !== reference);
}

// Separate recognising a refusal from displaying its wording. Every nested diagnostic must be accounted
// for before enabling another purchase, even when an earlier entry already gives a useful explanation.
function refusalEntries(value: unknown, reference: string | undefined): Record<string, unknown>[] | null {
  const entries: Record<string, unknown>[] = [];
  function collect(node: unknown, depth: number): boolean {
    if (depth > 4 || entries.length >= 16) return false;
    if (Array.isArray(node)) return node.length > 0 && node.length <= 12 && node.every(item => collect(item, depth + 1));
    const entry: Record<string, unknown> | null = typeof node === "string" ? { message: node } : record(node);
    if (!entry || conflictingPurchaseEvidence(entry, reference)) return false;
    const messages = diagnosticText(entry);
    if (messages.some(text => text.length > 4096 ||
        [...text.matchAll(/\bWS-[A-Z0-9_-]+/gi)].some(match => match[0].toUpperCase() !== reference?.toUpperCase()))) return false;
    // Bare success text is not a structured validation failure. Free text in a field map has independent field context.
    if (typeof node === "string" && !recognisedReason(node.trim()) && !/\b(?:duplicate|already (?:exists|booked|created))\b/i.test(node)) return false;
    const evidence = [entry.errorMessage, entry.message].some(text => typeof text === "string" && !!text.trim()) ||
      messages.some(text => /\b(?:invalid|validation|error|errors|required|missing|rejected|refused|duplicate|too high|not available|bad request)\b/i.test(text)) ||
      diagnosticFields(entry).some(safeFieldPath) ||
      [entry.code, entry.errorCode].some(code => typeof code === "number" && Number.isSafeInteger(code) || typeof code === "string" && !!code.trim());
    if (messages.length || evidence) entries.push(entry);
    if (entry.errors === undefined) return evidence;
    if (Array.isArray(entry.errors)) return collect(entry.errors, depth + 1);
    const map = record(entry.errors);
    if (!map) return false;
    const fields = Object.entries(map);
    if (!fields.length || fields.length > 12) return false;
    return fields.every(([field, raw]) => {
      const list = Array.isArray(raw) ? raw : [raw];
      return safeFieldPath(field) && list.length > 0 && list.length <= 12 &&
        list.every(message => typeof message === "string" && !!message.trim() && collect({ message, field }, depth + 1));
    });
  }
  return collect(value, 0) && entries.length ? entries : null;
}

/** Only one explicitly failed order can explain the outcome of a one-order purchase. */
function exactRejection(result: Record<string, unknown>, reference: string | undefined) {
  if (!reference || result.successCount !== 0 || result.errorsCount !== 1 ||
      (result.createdOrders !== undefined && !(Array.isArray(result.createdOrders) && !result.createdOrders.length)) ||
      !Array.isArray(result.failedOrders) || result.failedOrders.length !== 1) return null;
  const failure = record(result.failedOrders[0]);
  if (!failure || record(failure.order)?.orderReference !== reference || !Array.isArray(failure.errors)) return null;
  // Validate envelope metadata separately from its expected echoed order and documented counts.
  const { successCount, errorsCount, createdOrders, failedOrders, ...metadata } = result;
  const { order, errors, ...failureMetadata } = failure;
  if (Object.hasOwn(metadata, "errors") || conflictingPurchaseEvidence(metadata, reference) ||
      conflictingPurchaseEvidence(failureMetadata, reference)) return null;
  const entries = refusalEntries(errors, reference);
  return entries && [failureMetadata, ...entries];
}

function messagesIndicateSuccess(error: Record<string, unknown>) {
  return diagnosticText(error).some(text =>
    /^(?:(?:20[012]|successfully) )?(?:accepted|created|booked|submitted|processed|success)(?:[.!]|$)/i.test(text.trim()) ||
    /\b(?:accepted|created|booked|processed) (?:the |this |your )?(?:order|shipment|booking)\b/i.test(text));
}

function bookingRejection(errors: unknown[], status: number, serviceCode?: string): RoyalMailError {
  const reasons = new Set<string>();
  const guidance = new Set<string>();
  const codes = new Set<string>();
  for (const raw of errors) {
    const error = record(raw);
    if (!error) continue;
    const code = error.errorCode ?? error.code;
    const trustedCode = safeCode(code);
    if (trustedCode) codes.add(trustedCode);
    const message = diagnosticText(error).join(" ");
    const fields = diagnosticFields(error);
    if (message.length > 4096 || fields.length > 24) return invalidResponse(true);
    // Carriers use free text, symbolic codes and field paths to report duplicate references.
    const issue = [message, typeof code === "string" ? code : "", ...fields]
      .filter((v): v is string => typeof v === "string").join(" ")
      .replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase();
    if (messagesIndicateSuccess(error) || /\bduplicat(?:e|ed)\b|\b(?:order|booking|shipment) (?:was |is |has been |successfully )*(?:created|booked|accepted)\b/.test(issue) ||
        (/\b(?:order|reference|booking|shipment)\b/.test(issue) &&
         /\b(?:not unique|must be unique|already in use|already exists?|(?:already|previously) (?:been )?(?:created|used|submitted|processed|booked|taken|registered|assigned|received))\b/.test(issue))) {
      return new RoyalMailError("royal_mail_rejected", "Royal Mail may already have this booking. Checking the original order reference.", status, true);
    }
    const reason = carrierReason(error, serviceCode);
    if (reason) reasons.add(reason);
    for (const path of fields) {
      const name = path.match(/[a-zA-Z][a-zA-Z0-9]*$/)?.[0].toLowerCase();
      if (name && Object.hasOwn(bookingFields,name)) guidance.add(bookingFields[name]);
    }
    // Some responses contain only a message. Report the area the carrier named,
    // without exposing free text or inferring a specific corrected value.
    if (!fields.length) {
      if (/shipping account|shippingAccountName/i.test(message)) guidance.add(bookingFields.shippingaccountname);
      if (/service register|serviceRegisterCode/i.test(message)) guidance.add(bookingFields.serviceregistercode);
      else if (/service code|serviceCode|service (?:is )?(?:unavailable|not available|not valid)/i.test(message)) guidance.add(bookingFields.servicecode);
      if (/phone number|phoneNumber|telephone number/i.test(message)) guidance.add(bookingFields.phonenumber);
      if (/e-?mail address|emailAddress/i.test(message)) guidance.add(bookingFields.emailaddress);
      if (/post\s?code/i.test(message)) guidance.add(bookingFields.postcode);
      if (/parcel weight|package weight|weightInGrams/i.test(message)) guidance.add(bookingFields.weightingrams);
      if (/package format|packageFormatIdentifier/i.test(message)) guidance.add(bookingFields.packageformatidentifier);
      if (/OBA (?:customers|accounts) only|Online Business Account/i.test(message)) guidance.add(bookingFields.includelabelinresponse);
    }
  }
  const instruction = [...guidance].slice(0, 3).join(" ") || "Check the order and configured service in Click & Drop.";
  const identifier = codes.size ? " Carrier code " + [...codes].slice(0, 3).join(", ") + "." : "";
  const detail = reasons.size ? " Royal Mail said: " + [...reasons].slice(0, 3).join("; ") : "";
  return new RoyalMailError("royal_mail_rejected", "Royal Mail rejected the label request. " + instruction + identifier + detail, status);
}

async function rejectedBooking(response: Response, reference?: string, serviceCode?: string) {
  try {
    const bytes = await readBytes(response, 32 * 1024, "Carrier rejection exceeds the diagnostic limit.");
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    const result = record(value);
    if (result && ["failedOrders", "createdOrders", "successCount", "errorsCount"].some(field => Object.hasOwn(result, field))) {
      const errors = exactRejection(result, reference);
      return errors ? bookingRejection([result, ...errors], response.status, serviceCode) : invalidResponse(true);
    }
    // HTTP status alone, a raw string body or an uncorrelated order cannot prove this purchase failed.
    const entries = (result || Array.isArray(value)) && refusalEntries(value, reference);
    return entries ? bookingRejection(entries, response.status, serviceCode) : invalidResponse(true);
  } catch {
    void response.body?.cancel().catch(() => {});
    return invalidResponse(true);
  }
}

// A false miss here can cause a second postage purchase. A 400 is documented as a
// validation failure, so allow only a complete, order-specific absence diagnostic.
const lookupMessageFields = new Set(["message", "errorMessage", "detail", "title", "description", "details"]);
const lookupCodeFields = new Set(["code", "errorCode"]);
const lookupReferenceFields = new Set(["orderReference", "channelOrderReference"]);

// Click & Drop may echo the selector it was sent, quotes and percent-encoding included
// ("%22WS-…%22" or "\"WS-…\""), when it describes the order a lookup failed for.
function sameReference(given: unknown, reference: string): boolean {
  if (typeof given !== "string") return false;
  let text = given.trim();
  for (let i = 0; i < 2 && /%[0-9a-f]{2}/i.test(text); i++) {
    try { text = decodeURIComponent(text).trim(); } catch { break; }
  }
  const quoted = /^(["'])(.*)\1$/.exec(text);
  return (quoted ? quoted[2].trim() : text) === reference;
}

function namesMissingOrder(message: string, reference: string): boolean {
  if (/^(?:(?:the )?order(?: reference)? (?:was not found|not found|does not exist|could not be found)|unknown order|no (?:matching )?orders? (?:were |was )?found)\.?$/i.test(message)) return true;
  const after = /^no (?:matching )?orders? (?:were |was )?found (?:for|with) (?:the )?(?:(?:order )?reference[: ]+)?(["']?)([a-z0-9_-]{1,40})\1\.?$/i.exec(message);
  const before = /^(?:the )?order (?:(?:with (?:the )?(?:order )?)?reference )?(["']?)([a-z0-9_-]{1,40})\1 (?:was not found|not found|does not exist|could not be found)\.?$/i.exec(message);
  const noOrder = /^no order with (?:the )?reference (["']?)([a-z0-9_-]{1,40})\1 was found\.?$/i.exec(message);
  return (after || before || noOrder)?.[2] === reference;
}

type LookupFinding = "missing" | "unscoped-miss" | "invalid-selector";
class RoyalMailLookupSelectorError extends RoyalMailError {
  said = "";
}

// Signs in a refusal that some order, ours or another, is being described: those keep booking blocked
// without a list scan, because a scan can't settle which order Royal Mail meant.
// Returns the field that did it (a field name, never its value), or "".
function pointsAtAnOrder(value: unknown, reference: string): string {
  const entry = record(value);
  if (!entry) return "";
  for (const field of ["orders", "createdOrders"]) if (field in entry) return field;
  for (const field of ["orderReference", "channelOrderReference"]) {
    const given = entry[field];
    if (given !== undefined && given !== null && given !== "" && !sameReference(given, reference)) return field;
  }
  for (const field of ["accountOrderNumber", "orderIdentifier"]) {
    const given = entry[field];
    if (given !== undefined && given !== null && given !== 0) return field;
  }
  return "";
}

// Royal Mail's own error codes, when they look like codes (CamelCase words naming a kind of fault).
// Free text is never shown: it can carry names and addresses.
function lookupCodes(values: unknown[]): string {
  const codes = new Set<string>();
  for (const value of values) {
    const entry = record(value);
    for (const field of lookupCodeFields) {
      const code = entry?.[field];
      if (typeof code === "string" && /^[A-Z][A-Za-z]{2,39}$/.test(code) &&
          /(?:Invalid|NotFound|Missing|Required|Unauthori[sz]ed|Forbidden|Format|Error|Denied|Limit|Exceeded|Bad|Malformed|Unsupported)/.test(code)) {
        codes.add(code);
      }
    }
  }
  return [...codes].slice(0, 3).join(", ");
}

function lookupFinding(value: unknown, reference: string): LookupFinding | null {
  const entry = record(value);
  if (!entry) return null;
  let orderScoped = false;
  let finding: LookupFinding | null = null;
  for (const [key, value] of Object.entries(entry)) {
    if (lookupReferenceFields.has(key)) {
      if (value === null || value === "") continue;
      if (!sameReference(value, reference)) return null;
      orderScoped = true;
      continue;
    }
    if (key === "accountOrderNumber") {
      // This is the provider's numeric order ID. A positive ID needs reconciliation.
      if (value !== null && value !== 0) return null;
      continue;
    }
    const isCode = lookupCodeFields.has(key);
    if (!(isCode || lookupMessageFields.has(key))) return null;
    if (value === null || value === "") continue;
    if (typeof value !== "string" || !value.trim()) return null;
    const text = value.trim();
    let current: LookupFinding;
    if (isCode ? /^(?:OrderNotFound|OrderReferenceNotFound)$/i.test(text) : namesMissingOrder(text, reference)) {
      orderScoped = true;
      current = "missing";
    } else if (/^not ?found\.?$/i.test(text)) {
      current = "missing";
    } else if (isCode ? /^InvalidOrderIdentifiers?$/i.test(text) :
      /^(?:order identifiers? (?:is|are) invalid|invalid order identifiers?)\.?$/i.test(text)) {
      orderScoped = true;
      current = "invalid-selector";
    } else return null;
    if (finding && finding !== current) return null;
    finding = current;
  }
  return !orderScoped && finding === "missing" ? "unscoped-miss" : finding;
}

async function lookupRefusal(response: Response, reference: string): Promise<typeof MISSING_ORDER> {
  const status = response.status;
  let value: unknown;
  try {
    const bytes = await readBytes(response, 16 * 1024, "Royal Mail lookup reply exceeded its limit.");
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    void response.body?.cancel().catch(() => {});
  }
  const wrapper = record(value);
  let entries = Array.isArray(value) ? value : [value];
  if (wrapper && Array.isArray(wrapper.errors)) {
    // A sibling identifier, diagnostic or result must never be silently dropped.
    const pure = Object.keys(wrapper).every(key => key === "errors" || key === "status" && wrapper.status === status);
    entries = pure ? wrapper.errors : [];
  }
  if (entries.length > 0 && entries.length <= 12) {
    const findings = entries.map(entry => lookupFinding(entry, reference));
    if (findings.every(finding => finding === "missing")) return MISSING_ORDER;
  }
  const all = Array.isArray(value) ? value : [value, ...(Array.isArray(wrapper?.errors) ? wrapper.errors : [])];
  const pointer = all.map(entry => pointsAtAnOrder(entry, reference)).find(Boolean);
  if (pointer) {
    // The carrier can include names, addresses and credentials even in a read-only lookup error:
    // only the name of the field that pointed elsewhere is shown, never its value.
    throw new RoyalMailError("royal_mail_rejected", "Royal Mail rejected the order-reference lookup. Check the order reference in Click & Drop." +
      " (Royal Mail's reply named another order in " + pointer + ".)", status);
  }
  // Any other refusal says nothing either way about whether postage exists (28 Nov 2026: Click & Drop
  // refused the lookup for a first booking in a way none of the patterns above recognised). Only a
  // separate, complete, read-only scan of the order list can settle it; if that can't, booking stays blocked.
  const selector = new RoyalMailLookupSelectorError("royal_mail_rejected",
    "Royal Mail rejected the order-reference lookup. Click & Drop could not resolve the reference.", status);
  selector.said = lookupCodes(all);
  throw selector;
}

function responseError(status: number, posting: boolean, label = false): RoyalMailError {
  if (status === 401) return new RoyalMailError("royal_mail_auth", "Royal Mail did not accept the Click & Drop key.", status);
  if (status === 403) return new RoyalMailError("royal_mail_denied", label
    ? "This Click & Drop account cannot retrieve labels by API."
    : "This Click & Drop account does not have access to this operation.", status);
  if (status === 429) return new RoyalMailError("royal_mail_rate_limited", "Royal Mail is rate limiting requests. Try again shortly.", status, posting);
  if (label && status === 404) return new RoyalMailError("royal_mail_label_unavailable", "Royal Mail does not have a label ready for this order.", status);
  if (label && (status === 400 || status === 422)) return new RoyalMailError("royal_mail_label_unavailable",
    "Royal Mail could not generate this label. Check the order in Click & Drop.", status);
  if (status === 400 || status === 422) return new RoyalMailError("royal_mail_rejected", "Royal Mail rejected the shipment details. Check the address, parcel and service.", status);
  return new RoyalMailError("royal_mail_unavailable", "Royal Mail did not confirm this request.", status, posting);
}

async function clickDrop(
  key: string,
  path: string,
  { body, reference, serviceCode, label = false, missingOkay = false, signal }: { body?: unknown; reference?: string; serviceCode?: string; label?: boolean; missingOkay?: boolean; signal?: AbortSignal },
  fetcher: typeof fetch,
): Promise<unknown> {
  const token = typeof key === "string" ? key.trim() : "";
  if (!validRoyalMailCredential(token)) throw new RoyalMailError("royal_mail_configuration", "Configure a valid Royal Mail Click & Drop key.");
  const posting = body !== undefined;
  const headers = new Headers({ Authorization: "Bearer " + token, Accept: label ? "application/pdf" : "application/json" });
  if (posting) headers.set("Content-Type", "application/json");
  let response: Response;
  try {
    response = await fetcher(CLICK_DROP + path, {
      method: posting ? "POST" : "GET", body: posting ? JSON.stringify(body) : undefined, headers,
      redirect: "manual", signal: signal ?? AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new RoyalMailError("royal_mail_unavailable", "Royal Mail did not confirm this request.", undefined, posting);
  }
  if (!response.ok) {
    if (posting && (response.status === 400 || response.status === 422)) throw await rejectedBooking(response, reference, serviceCode);
    if (missingOkay && reference && (response.status === 400 || response.status === 422)) return lookupRefusal(response, reference);
    void response.body?.cancel().catch(() => {});
    if (response.status === 404 && missingOkay) return MISSING_ORDER;
    throw responseError(response.status, posting, label);
  }

  return readProviderResponse(response, label, posting);
}

async function readProviderResponse(response: Response, label = false, posting = false): Promise<unknown> {
  const type = response.headers.get("content-type") || "";
  const validType = label ? /^(?:application\/pdf|application\/octet-stream)(?:\s*;|$)/i : /^application\/json(?:\s*;|$)/i;
  if (!validType.test(type)) {
    void response.body?.cancel().catch(() => {});
    throw invalidResponse(posting);
  }
  try {
    const bytes = await readBytes(response, label ? PDF_LIMIT : posting ? CREATE_LIMIT : JSON_LIMIT, "Royal Mail response exceeded its limit.");
    if (label) {
      const decoder = new TextDecoder();
      const header = decoder.decode(bytes.subarray(0, 9));
      const trailer = decoder.decode(bytes.subarray(Math.max(0, bytes.length - 1024)));
      if (pdfEdges(header, trailer)) return bytes;
      throw invalidResponse();
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    void response.body?.cancel().catch(() => {});
    throw invalidResponse(posting);
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function pdfEdges(header: string, trailer: string): boolean {
  return /^%PDF-\d\.\d[\r\n]/.test(header) && /%%EOF\s*$/.test(trailer);
}

function inlineLabel(value: unknown): boolean {
  if (typeof value !== "string" || !value.startsWith("JVBERi0")) return false;
  try {
    const pdf = atob(value);
    return pdfEdges(pdf.slice(0, 9), pdf.slice(-1024));
  } catch {
    return false;
  }
}

function publicOrder(value: unknown, reference: string, posting = false): RoyalMailOrder {
  const item = record(value);
  if (!item || item.orderReference !== reference || typeof item.orderIdentifier !== "number" ||
      !Number.isSafeInteger(item.orderIdentifier) || item.orderIdentifier <= 0) {
    throw invalidResponse(posting);
  }
  const packages = Array.isArray(item.packages) ? item.packages : [];
  if (packages.length > 1 || (packages.length === 1 && !record(packages[0]))) throw invalidResponse(posting);
  const packageItem = record(packages[0]);
  const orderTracking = royalMailTrackingNumber(item.trackingNumber);
  const packageTracking = royalMailTrackingNumber(packageItem?.trackingNumber);
  if (orderTracking && packageTracking && orderTracking !== packageTracking &&
      (orderTracking.length === packageTracking.length || !royalMailTrackingV2Number(orderTracking) || !royalMailTrackingV2Number(packageTracking))) {
    throw invalidResponse(posting);
  }
  const labelled = dateValue(item.printedOn) || dateValue(item.manifestedOn) || (posting && inlineLabel(item.label));
  return {
    orderId: item.orderIdentifier,
    reference,
    trackingNumber: orderTracking ?? packageTracking,
    providerState: dateValue(item.shippedOn) ? "dispatched" : labelled ? "labelled" : "created",
  };
}

/** Create once. An uncertain result must be reconciled by reference by the caller. */
export async function createRoyalMailOrder(key: string, input: RoyalMailOrderInput, fetcher = fetch): Promise<RoyalMailOrder> {
  const result = record(await clickDrop(key, "/orders", { body: orderBody(input), reference: input.reference, serviceCode: input.serviceCode }, fetcher));
  const failures = result && exactRejection(result, input.reference);
  if (failures) throw bookingRejection([result, ...failures], 400, input.serviceCode);
  if (result?.successCount !== 1 || result.errorsCount !== 0 ||
      (result.failedOrders !== undefined && !(Array.isArray(result.failedOrders) && !result.failedOrders.length)) || !Array.isArray(result.createdOrders) || result.createdOrders.length !== 1) {
    throw invalidResponse(true);
  }
  return publicOrder(result.createdOrders[0], input.reference, true);
}

/** The provider accepts a quoted, encoded order reference. Ambiguous matches are unsafe. */
export async function findRoyalMailOrder(key: string, reference: string, fetcher = fetch): Promise<RoyalMailOrder | null> {
  const knownReference = orderReference(reference);
  const path = "/orders/" + encodeURIComponent('"' + knownReference + '"');
  let result: unknown;
  try {
    result = await clickDrop(key, path, { missingOkay: true, reference: knownReference }, fetcher);
  } catch (error) {
    if (!(error instanceof RoyalMailLookupSelectorError)) throw error;
    try {
      return await findInOrderList(key, knownReference, fetcher);
    } catch (listError) {
      if (!(listError instanceof RoyalMailError)) throw listError;
      const detail = listError.code === "royal_mail_rate_limited" ? "Royal Mail is rate limiting order checks. Try again later."
        : "The order list could not confirm this reference. Check the original order in Click & Drop.";
      const said = error.said ? " (Royal Mail's code: " + error.said + ")" : "";
      const code = listError.code === "royal_mail_invalid_response" ? "royal_mail_rejected" : listError.code;
      throw new RoyalMailError(code, "Royal Mail rejected the order-reference lookup. " + detail + said, listError.status ?? error.status);
    }
  }
  if (result === MISSING_ORDER || (Array.isArray(result) && result.length === 0)) return null;
  if (!Array.isArray(result) || result.length !== 1) throw invalidResponse();
  return publicOrder(result[0], knownReference);
}

// An inconclusive identifier response says nothing about whether postage already exists.
// Read the entire order list before reporting an absence or accepting a unique match.
async function findInOrderList(key: string, reference: string, fetcher: typeof fetch): Promise<RoyalMailOrder | null> {
  const query = new URLSearchParams({ pageSize: "100" });
  const tokens = new Set<string>(), identifiers = new Set<number>();
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let match: RoyalMailOrder | null = null;
  for (let index = 0; index < 3; index++) {
    const page = record(await clickDrop(key, "/orders?" + query, { signal }, fetcher));
    if (!page || Object.keys(page).some(field => field !== "orders" && field !== "continuationToken") ||
        !Array.isArray(page.orders) || page.orders.length > 100) throw invalidResponse();
    for (const value of page.orders) {
      const row = record(value);
      if (!row || typeof row.orderIdentifier !== "number" || !Number.isSafeInteger(row.orderIdentifier) ||
          row.orderIdentifier < 1 || identifiers.has(row.orderIdentifier) || !dateValue(row.createdOn) ||
          typeof row.orderReference !== "string" || !row.orderReference.trim()) throw invalidResponse();
      identifiers.add(row.orderIdentifier);
      if (row.orderReference.trim().toUpperCase() !== reference.toUpperCase()) continue;
      if (row.orderReference !== reference || match) throw invalidResponse();
      match = publicOrder(row, reference);
    }
    const next = page.continuationToken;
    if (next == null || next === "") return match;
    if (!page.orders.length || typeof next !== "string" || !next.trim() || next.length > 2048 ||
        /[\u0000-\u001f\u007f]/.test(next) || tokens.has(next)) throw invalidResponse();
    tokens.add(next);
    query.set("continuationToken", next);
  }
  throw invalidResponse();
}

/** Retrieve the label for an existing order. Never make another shipment to reprint. */
export async function fetchRoyalMailLabel(key: string, orderId: number, fetcher = fetch): Promise<Uint8Array> {
  if (!Number.isSafeInteger(orderId) || orderId <= 0) invalidShipment("Use a valid Royal Mail order identifier.");
  const path = "/orders/" + orderId + "/label?documentType=postageLabel&includeReturnsLabel=false&includeCN=false";
  return await clickDrop(key, path, { label: true }, fetcher) as Uint8Array;
}

export interface RoyalMailTrackingCredentials {
  clientId: string;
  clientSecret: string;
  acceptTerms: true;
}

export interface RoyalMailTrackingSummary {
  trackingNumber: string;
  status: "available" | "not-found";
  statusCategory: string | null;
  lastEventCode: string | null;
  lastEventName: string | null;
  lastEventAt: string | null;
}

function trackingText(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(value)
    ? value.trim() || null : null;
}

function trackingSummary(value: unknown): RoyalMailTrackingSummary {
  const item = record(value);
  const trackingNumber = royalMailTrackingV2Number(item?.mailPieceId);
  if (!trackingNumber || (item?.status !== "200" && item?.status !== "404")) throw invalidResponse();
  const summary = item.status === "200" ? record(item.summary) : null;
  const eventAt = summary?.lastEventDateTime;
  return {
    trackingNumber,
    status: item.status === "200" ? "available" : "not-found",
    statusCategory: trackingText(summary?.statusCategory, 80),
    lastEventCode: trackingText(summary?.lastEventCode, 20),
    lastEventName: trackingText(summary?.lastEventName, 120),
    lastEventAt: dateValue(eventAt) ? new Date(eventAt).toISOString() : null,
  };
}

/** Tracking V2 is separately provisioned. The caller must use approved credentials and terms. */
export async function fetchRoyalMailTracking(
  { clientId, clientSecret, acceptTerms }: RoyalMailTrackingCredentials, trackingNumbers: readonly string[], fetcher = fetch,
): Promise<RoyalMailTrackingSummary[]> {
  if (!validRoyalMailCredential(clientId) || !validRoyalMailCredential(clientSecret) || acceptTerms !== true) {
    throw new RoyalMailError("royal_mail_configuration", "Configure approved Royal Mail Tracking API credentials.");
  }
  if (!Array.isArray(trackingNumbers) || trackingNumbers.length < 1 || trackingNumbers.length > 30) {
    invalidShipment("Check the Royal Mail tracking references.");
  }
  const numbers = new Set<string>();
  for (const reference of trackingNumbers) {
    const number = royalMailTrackingV2Number(reference);
    if (!number) invalidShipment("Check the Royal Mail tracking references.");
    numbers.add(number);
  }
  const query = new URLSearchParams({ mailPieceId: [...numbers].join(",") });
  const headers = new Headers({
    "X-IBM-Client-Id": clientId,
    "X-IBM-Client-Secret": clientSecret,
    "X-Accept-RMG-Terms": "yes",
    Accept: "application/json",
  });
  let response: Response;
  try {
    response = await fetcher(TRACKING_V2 + "/summary?" + query, {
      method: "GET", headers, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new RoyalMailError("royal_mail_unavailable", "Royal Mail Tracking is temporarily unavailable.");
  }
  const noScans = response.status === 404;
  if (!response.ok && !noScans) {
    void response.body?.cancel().catch(() => {});
    if (response.status === 401 || response.status === 403) {
      throw new RoyalMailError("royal_mail_auth", "Royal Mail did not accept the Tracking API credentials.", response.status);
    }
    throw responseError(response.status, false);
  }
  const data = record(await readProviderResponse(response));
  if (noScans && data?.httpCode !== "404") throw invalidResponse();
  const pieces = data?.mailPieces;
  if (!Array.isArray(pieces) || pieces.length !== numbers.size) throw invalidResponse();
  const results = new Map<string, RoyalMailTrackingSummary>();
  for (const piece of pieces) {
    const summary = trackingSummary(piece);
    if (!numbers.has(summary.trackingNumber) || results.has(summary.trackingNumber) ||
        (noScans && summary.status !== "not-found")) throw invalidResponse();
    results.set(summary.trackingNumber, summary);
  }
  return [...numbers].map(number => results.get(number)!);
}

/** Names must match exactly when passed to Click & Drop for booking. */
export async function listRoyalMailShippingAccounts(key: string, fetcher = fetch): Promise<string[]> {
  const accounts = await clickDrop(key, "/carriers", {}, fetcher);
  if (!Array.isArray(accounts)) throw invalidResponse();
  return accounts.map(account => {
    const name = record(account)?.shippingAccountName;
    if (typeof name !== "string" || !name.trim() || name.length > 50 || /[\u0000-\u001f\u007f]/.test(name)) throw invalidResponse();
    return name;
  });
}

export async function listRoyalMailParcelServices(
  key: string, serviceCode: string, shippingAccountName: string | undefined,
  postcode: string, weightGrams: number, fetcher = fetch,
): Promise<{ accounts: string[]; matches: number }> {
  const query = new URLSearchParams({ destinationCountryCode: "GBR", destinationPostcode: postcode, packagingFormat: "Parcel", packageWeight: String(weightGrams) });
  if (shippingAccountName) query.set("shippingAccountName", shippingAccountName);
  const groups = await clickDrop(key, "/services?" + query, {}, fetcher);
  if (!Array.isArray(groups)) throw invalidResponse();
  let matches = 0;
  const accounts = groups.map(item => {
    const group = record(item);
    if (!group || typeof group.shippingAccountName !== "string" || !Array.isArray(group.services)) throw invalidResponse();
    if (shippingAccountName && group.shippingAccountName !== shippingAccountName) throw invalidResponse();
    for (const item of group.services) {
      const entry = record(item);
      if (!entry || typeof entry.serviceCode !== "string" || !entry.serviceCode.trim()) throw invalidResponse();
      if (entry.serviceCode.toUpperCase() === serviceCode) matches++;
    }
    return group.shippingAccountName;
  });
  return { accounts, matches };
}

/** Click & Drop service discovery is read-only; it does not validate a register or OBA label entitlement. */
export async function checkRoyalMailParcelService(
  key: string, service: { serviceCode: string; serviceRegisterCode?: string; shippingAccountName?: string },
  postcode: string, weightGrams: number, fetcher: typeof fetch = fetch,
): Promise<{ bookingService: string; available: boolean | null; message: string }> {
  const { serviceCode, serviceRegisterCode, shippingAccountName } = service;
  const result = (available: boolean | null, message: string) => ({ bookingService: serviceCode, available, message });
  const ambiguous = () => result(null, "This Click & Drop account has multiple shipping accounts. Set the shipping account name in Royal Mail settings and check again.");
  try {
    const { accounts: serviceAccounts, matches } = await listRoyalMailParcelServices(key, serviceCode, shippingAccountName, postcode, weightGrams, fetcher);
    if (!matches) return result(false, `Royal Mail did not list ${serviceCode} for this postcode, packed weight and parcel format. Check the service and shipping account in Royal Mail settings.`);
    if (!shippingAccountName) {
      if (serviceAccounts.length > 1) return ambiguous();
      // Filtered /services may omit other accounts. Order creation requires a name if multiple accounts are configured.
      const accounts = await listRoyalMailShippingAccounts(key, fetcher);
      if (!accounts.length) throw invalidResponse();
      if (accounts.length > 1) return ambiguous();
      if (accounts[0] !== serviceAccounts[0]) throw invalidResponse();
    }
    if (serviceRegisterCode) return result(null, `Royal Mail lists ${serviceCode} for this parcel. The service list does not confirm register ${serviceRegisterCode}. Check it in Click & Drop.`);
    if (matches > 1) return result(null, `Royal Mail lists several entries for ${serviceCode}. Check the account and service register in Click & Drop.`);
    return result(true, `Royal Mail lists ${serviceCode} for this postcode, packed weight and parcel format. Downloading a label through the API requires an Online Business Account.`);
  } catch (error) {
    if (!(error instanceof RoyalMailError)) throw error;
    if (error.status === 401 || error.status === 403) return result(null, "Click & Drop did not authorise the service check. Check the connection and account permissions in Royal Mail settings.");
    if (error.status === 400 || error.status === 422) return result(null, "Click & Drop could not check these parcel details. Check the postcode, weight and configured shipping account name.");
    if (error.status === 429) return result(null, "Royal Mail’s request limit was reached. Try the service check again later.");
    return result(null, "Royal Mail could not confirm service availability. Try the service check again later.");
  }
}
