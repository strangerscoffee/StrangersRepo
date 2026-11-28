import "../public/shared/wholesale-preparation.js";
import { ApiError, readBytes } from "./http";

const CLICK_DROP = "https://api.parcel.royalmail.com/api/v1";
const TRACKING_V2 = "https://api.royalmail.net/mailpieces/v2";
const TIMEOUT_MS = 12000;
const JSON_LIMIT = 128 * 1024;
const LIST_LIMIT = 512 * 1024;
const LIST_PAGE_SIZE = 50;
const LIST_MAX_PAGES = 20;
const LIST_INTERVAL_MS = 225;
const LOOKUP_BUDGET_MS = 25_000;
const FIRST_BOOKING_CLOCK_MARGIN_MS = 15 * 60_000;
const ORDER_ID_BATCH_SIZE = 25;
const MAX_ORDER_ID_BATCHES = 2;
const REQUESTED_LABEL = { includeLabelInResponse: true, includeReturnsLabel: false, includeCN: false } as const;
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
  | "royal_mail_order_mismatch"
  | "royal_mail_label_unavailable";

export class RoyalMailError extends Error {
  constructor(public code: RoyalMailCode, message: string, public status?: number, public uncertain = false, readonly candidateId?: number) {
    super(message);
    this.name = "RoyalMailError";
  }
}

const manualLookupReasons = {
  capacity: "This account has more order history than can be checked in one search.",
  unreferenced: "Some Click & Drop orders have no order reference. Check for a hand-booked parcel by recipient, postcode and date.",
  oversized: "A Click & Drop order-list page exceeded the safe size limit.",
  pagination: "Click & Drop reported more orders but did not supply a usable next page.",
  envelope: "Click & Drop returned an empty response without its order list.",
};

/** Only meaningful before a first postage request, subject to the administrator's own verification. */
export class RoyalMailManualLookupError extends RoyalMailError {
  constructor(readonly reason: keyof typeof manualLookupReasons) {
    super("royal_mail_rejected", "Royal Mail rejected the order-reference lookup. " + manualLookupReasons[reason] +
      " Search for the full order reference in Click & Drop.");
    this.name = "RoyalMailManualLookupError";
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
  labelProblem?: string;
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

function unconfirmedReceipt(message: string, status?: number, candidateId?: number) {
  return new RoyalMailError("royal_mail_invalid_response", message, status, true, candidateId);
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

// Accept an unzoned carrier timestamp as proof of an event only. Never use it as a UTC instant.
function isRoyalMailEventTime(value: unknown): value is string {
  return dateValue(value) || typeof value === "string" && dateValue(value + "Z");
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
    label: REQUESTED_LABEL,
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

const refusalFields = new Set(["code", "errorCode", "status", "statusCode", "httpStatus", "httpStatusCode", "success", "isSuccess",
  "message", "errorMessage", "detail", "title", "description", "details", "field", "fieldName", "propertyName",
  "fields", "errors", "orderReference", "type", "traceId", "instance"]);

function conflictingPurchaseEvidence(entry: Record<string, unknown>, reference: string | undefined) {
  if (Object.entries(entry).some(([key, value]) => !refusalFields.has(key) ||
      (value !== null && typeof value === "object" && key !== "errors" && key !== "fields"))) return true;
  if (entry.fields != null && (!Array.isArray(entry.fields) || entry.fields.some(value => {
    const field = record(value);
    return !field || Object.keys(field).some(key => key !== "fieldName" && key !== "value") ||
      typeof field.fieldName !== "string" || (field.value != null && typeof field.value === "object");
  }))) return true;
  return entry.success === true || entry.isSuccess === true ||
    [entry.status, entry.statusCode, entry.httpStatus, entry.httpStatusCode].some(status =>
      status != null && !/^(?:400|422|error|failed|invalid|rejected|bad request)$/i.test(String(status))) ||
    [entry.code, entry.errorCode].some(code => /^(?:2\d\d|OK|Success|Created|Accepted|Pending|Processing)$/i.test(String(code))) ||
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

const bookingResultFields = new Set(["orderId", "orderIdentifier", "accountOrderNumber", "trackingNumber", "createdOn",
  "generatedDocuments", "printedOn", "manifestedOn", "shippedOn", "labelErrors", "success", "isSuccess", "successCount",
  "createdOrders", "failedOrders", "bookingId", "orderStatus", "status"]);

function hasBookingResultInEcho(echo: Record<string, unknown>) {
  let remaining = 512;
  function inspect(node: object, depth: number): boolean {
    return Object.entries(node).some(([field, value]) => --remaining < 0 || depth > 12 ||
      bookingResultFields.has(field) || depth > 0 && (field === "label" || field === "orderReference") ||
      value !== null && typeof value === "object" && inspect(value, depth + 1));
  }
  return inspect(echo, 0);
}

// A carrier may add defaults to the echoed request. Every value we actually sent
// must still agree before a sparse refusal can release this local reservation.
function containsSubmittedOrder(echo: unknown, sent: unknown): boolean {
  if (Array.isArray(sent)) return Array.isArray(echo) && sent.length === echo.length &&
    sent.every((item, index) => containsSubmittedOrder(echo[index], item));
  const expected = record(sent);
  if (!expected) return sent === echo;
  const actual = record(echo);
  return !!actual && Object.entries(expected).every(([field, value]) => value === undefined || containsSubmittedOrder(actual[field], value));
}

/** Only one explicitly failed order can explain the outcome of a one-order purchase. */
function exactRejection(result: Record<string, unknown>, reference: string | undefined, submitted: unknown) {
  const bothCounts = result.successCount === 0 && result.errorsCount === 1;
  if (!reference || (result.successCount !== undefined && result.successCount !== 0) ||
      (result.errorsCount !== undefined && result.errorsCount !== 1) || (!bothCounts && !Array.isArray(result.createdOrders)) ||
      (result.createdOrders !== undefined && !(Array.isArray(result.createdOrders) && !result.createdOrders.length)) ||
      !Array.isArray(result.failedOrders) || result.failedOrders.length !== 1) return null;
  const failure = record(result.failedOrders[0]);
  const echo = record(failure?.order);
  // FailedOrderResponse.order echoes CreateOrderRequest. Its label holds the request's
  // boolean options. A PDF, booking ID or different options cannot establish a refusal.
  if (echo && Object.hasOwn(echo, "label")) {
    const options = record(echo.label);
    if (options?.includeLabelInResponse !== true || Object.entries(options).some(([field, value]) =>
      !Object.hasOwn(REQUESTED_LABEL, field) || value !== REQUESTED_LABEL[field as keyof typeof REQUESTED_LABEL])) return null;
  }
  if (!failure || !echo || echo.orderReference !== reference || !Array.isArray(failure.errors) || hasBookingResultInEcho(echo)) return null;
  // Validate envelope metadata separately from its expected echoed order and documented counts.
  const { successCount, errorsCount, createdOrders, failedOrders, ...metadata } = result;
  const { order, errors, ...failureMetadata } = failure;
  if (Object.hasOwn(metadata, "errors") || conflictingPurchaseEvidence(metadata, reference) ||
      conflictingPurchaseEvidence(failureMetadata, reference)) return null;
  const entries = refusalEntries(errors, reference);
  if (!bothCounts && (!submitted || !containsSubmittedOrder(echo, submitted) ||
      !entries?.some(entry => diagnosticFields(entry).some(safeFieldPath) && diagnosticText(entry).length > 0))) return null;
  return entries && [failureMetadata, ...entries];
}

function messagesIndicateSuccess(error: Record<string, unknown>) {
  return diagnosticText(error).some(text =>
    /^(?:(?:20[012]|successfully) )?(?:accepted|created|booked|submitted|processed|success)(?:[.!]|$)/i.test(text.trim()) ||
    /\b(?:accepted|created|booked|processed) (?:the |this |your )?(?:order|shipment|booking)\b/i.test(text));
}

// This helper can return only the fixed guidance from bookingFields, never provider-supplied text.
function addBookingGuidance(guidance: Set<string>, fields: string[], message: string) {
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

function bookingRejection(errors: unknown[], status: number, serviceCode?: string, correlated = false): RoyalMailError {
  const reasons = new Set<string>();
  const guidance = new Set<string>();
  const codes = new Set<string>();
  let confirmed = correlated;
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
    const issue = [message, error.code, error.errorCode, ...fields]
      .filter((v): v is string => typeof v === "string").join(" ")
      .replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase();
    const paidOrLabelled = /\b(?:label|postage|payment|charge)\b/.test(issue) &&
      /\b(?:generated|issued|printed|purchased|bought|paid|charged|debited|taken|captured)\b/.test(issue);
    if (paidOrLabelled || messagesIndicateSuccess(error) || /\bduplicat(?:e|ed)\b|\b(?:order|booking|shipment) (?:was |is |has been |successfully )*(?:created|booked|accepted)\b/.test(issue) ||
        /\b(?:not unique|must be unique|already in use|already exists?|(?:already|previously) (?:been )?(?:created|used|submitted|processed|booked|taken|registered|assigned|received))\b/.test(issue)) {
      return new RoyalMailError("royal_mail_rejected", "Royal Mail may already have this booking. Checking the original order reference.", status, true);
    }
    if (/\b(?:uncertain|ambiguous|pending|processing|time[ -]?out|timed out|disconnect\w*|gateway|unknown (?:outcome|status)|outcome unknown|unable to confirm|(?:may|might) have|failed to generate (?:the )?label|label generation failed)\b/.test(issue)) return invalidResponse(true);
    const reason = carrierReason(error, serviceCode);
    if (reason) reasons.add(reason);
    if (trustedCode || reason || fields.some(safeFieldPath) || /\binvalid (?:shipping account name|service code|service register code|postcode|parcel format|parcel weight)\b/.test(issue)) confirmed = true;
    addBookingGuidance(guidance, fields, message);
  }
  if (!confirmed) return invalidResponse(true);
  const instruction = [...guidance].slice(0, 3).join(" ") || "Check the order and configured service in Click & Drop.";
  const identifier = codes.size ? " Carrier code " + [...codes].slice(0, 3).join(", ") + "." : "";
  const detail = reasons.size ? " Royal Mail said: " + [...reasons].slice(0, 3).join("; ") : "";
  return new RoyalMailError("royal_mail_rejected", "Royal Mail rejected the label request. " + instruction + identifier + detail, status);
}

async function rejectedBooking(response: Response, reference: string | undefined, serviceCode: string | undefined, submitted: unknown) {
  if (!/^application\/(?:json|problem\+json)(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) {
    void response.body?.cancel().catch(() => {});
    return invalidResponse(true);
  }
  try {
    const bytes = await readBytes(response, 32 * 1024, "Carrier rejection exceeds the diagnostic limit.");
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    const result = record(value);
    if (result && ["failedOrders", "createdOrders", "successCount", "errorsCount"].some(field => Object.hasOwn(result, field))) {
      const errors = exactRejection(result, reference, submitted);
      return errors ? bookingRejection([result, ...errors], response.status, serviceCode, true) : invalidResponse(true);
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
function sameReference(given: unknown, reference: string, ignoreCase = false): boolean {
  if (typeof given !== "string") return false;
  let text = given.trim();
  for (let i = 0; i < 2 && /%[0-9a-f]{2}/i.test(text); i++) {
    try { text = decodeURIComponent(text).trim(); } catch { break; }
  }
  const quoted = /^(["'])(.*)\1$/.exec(text);
  const normalized = quoted ? quoted[2].trim() : text;
  return ignoreCase ? normalized.toUpperCase() === reference.toUpperCase() : normalized === reference;
}

function namedMissingReference(message: string): string | undefined {
  const after = /^no (?:matching )?orders? (?:were |was )?found (?:for|with) (?:the )?(?:(?:order )?reference[: ]+)?(["']?)([a-z0-9_-]{1,40})\1\.?$/i.exec(message);
  const before = /^(?:the )?order (?:(?:with (?:the )?(?:order )?)?reference )?(["']?)([a-z0-9_-]{1,40})\1 (?:was not found|not found|does not exist|could not be found)\.?$/i.exec(message);
  const noOrder = /^no order with (?:the )?reference (["']?)([a-z0-9_-]{1,40})\1 was found\.?$/i.exec(message);
  return (after || before || noOrder)?.[2];
}

function namesMissingOrder(message: string, reference: string): boolean {
  return /^(?:(?:the )?order(?: reference)? (?:was not found|not found|does not exist|could not be found)|unknown order|no (?:matching )?orders? (?:were |was )?found)\.?$/i.test(message) ||
    namedMissingReference(message) === reference;
}

type LookupFinding = "missing" | "unscoped-miss" | "invalid-selector";
class RoyalMailLookupSelectorError extends RoyalMailError {
  said = "";
  manualReviewAllowed = false;
  accessProblem = false;
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

// Error codes are free text in the carrier schema. Only these known, public values may reach operators.
const publicLookupCodes = new Set([
  "InvalidOrderIdentifier", "InvalidOrderIdentifiers", "OrderNotFound", "OrderReferenceNotFound", "NotFound",
  "BadRequest", "Unauthorized", "Unauthorised", "Forbidden", "AccessDenied", "PermissionDenied", "AccountUnavailable",
]);

function lookupCodes(values: unknown[]): string {
  const codes = new Set<string>();
  for (const value of values) {
    const entry = record(value);
    for (const field of lookupCodeFields) {
      const code = entry?.[field];
      if (typeof code === "string" && publicLookupCodes.has(code)) codes.add(code);
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
    const text = isCode ? value.trim().replace(/[_-]/g, "") : value.trim();
    let current: LookupFinding;
    if (isCode ? /^(?:OrderNotFound|OrderReferenceNotFound)$/i.test(text) : namesMissingOrder(text, reference)) {
      orderScoped = true;
      current = "missing";
    } else if (/^not ?found\.?$/i.test(text)) {
      current = "missing";
    } else if (isCode ? /^InvalidOrderIdentifiers?$/i.test(text) :
      /^(?:order identifiers? (?:is|are) invalid|invalid order identifiers?|(?:cannot|unable to) resolve (?:the )?order (?:reference|identifier)|(?:the )?order (?:reference|identifier) could not be resolved)\.?$/i.test(text)) {
      orderScoped = true;
      current = "invalid-selector";
    } else return null;
    if (finding && finding !== current) return null;
    finding = current;
  }
  return !orderScoped && finding === "missing" ? "unscoped-miss" : finding;
}

function unreadableLookupRefusal(status: number): RoyalMailError {
  return new RoyalMailError("royal_mail_rejected", "Royal Mail rejected the order-reference lookup. The reply could not be checked safely. Check the original order in Click & Drop.", status);
}

function checkLookupRefusalPointers(value: unknown, reference: string, status: number): boolean {
  let remaining = 256, accessProblem = false;
  function conflictingBooking(): never {
    throw new RoyalMailError("royal_mail_rejected", "Royal Mail rejected the order-reference lookup. The carrier indicated an existing or ambiguous booking. Check the original order in Click & Drop.", status);
  }
  function inspect(node: unknown, depth: number): void {
    if (--remaining < 0 || depth > 12) throw unreadableLookupRefusal(status);
    if (typeof node === "string" && !namesMissingOrder(node.trim(), reference)) {
      const wording = node.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase();
      if (namedMissingReference(node.trim()) || [...node.matchAll(/\bWS-[A-Z0-9_-]+/gi)].some(([given]) => given !== reference) ||
          /\b(?:duplicat(?:e|ed|es)|ambigu(?:ous|ity)|not unique|must be unique|already (?:in use|exist\w*|used|booked|created|accepted|submitted|registered|processed)|(?:multiple|several) (?:orders?|match(?:es)?)|success(?:ful|fully)?|previously (?:created|booked)|(?:order|booking|shipment|reference) (?:exists?|found|created|booked|accepted|in use)|(?:was|were) found)\b/.test(wording)) {
        conflictingBooking();
      }
      if (/auth|forbidden|denied|permission|access|credential|api.?key|invalid.?token|token.?expired|unavailable|rate.?limit|too.?many.?requests|throttl|time.?out|timed.?out|server.?error|\b(?:401|403|429|5\d\d)\b/.test(wording)) accessProblem = true;
    }
    if (!node || typeof node !== "object") return;
    const entry = record(node);
    if (entry) {
      if (entry.success === true || entry.exists === true || entry.isDuplicate === true || entry.ambiguous === true ||
          (typeof entry.successCount === "number" && entry.successCount > 0) || messagesIndicateSuccess(entry)) conflictingBooking();
      for (const field of ["status", "statusCode", "httpStatus", "httpStatusCode"]) {
        if (typeof entry[field] === "number" && /^(401|403|429|5\d\d)$/.test(String(entry[field]))) accessProblem = true;
      }
    }
    const pointer = pointsAtAnOrder(node, reference);
    if (pointer) {
      // Only the known field name is safe to expose, never the field value or its parent key.
      throw new RoyalMailError("royal_mail_rejected", "Royal Mail rejected the order-reference lookup. Check the order reference in Click & Drop." +
        " (Royal Mail's reply named another order in " + pointer + ".)", status);
    }
    for (const child of Object.values(node)) inspect(child, depth + 1);
  }
  inspect(value, 0);
  return accessProblem;
}

async function lookupRefusal(response: Response, reference: string): Promise<typeof MISSING_ORDER> {
  const status = response.status;
  let bytes: Uint8Array;
  try {
    bytes = await readBytes(response, 16 * 1024, "Royal Mail lookup reply exceeded its limit.");
  } catch {
    void response.body?.cancel().catch(() => {});
    throw unreadableLookupRefusal(status);
  }
  let value: unknown;
  let diagnostic = "";
  try {
    diagnostic = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    value = JSON.parse(diagnostic);
  } catch {
    // A short non-JSON refusal can only be settled through a separate account list check.
  }
  const accessProblem = checkLookupRefusalPointers(value ?? diagnostic, reference, status);
  const wrapper = record(value);
  let entries = Array.isArray(value) ? value : [value];
  if (wrapper && Array.isArray(wrapper.errors)) {
    // A sibling identifier, diagnostic or result must never be silently dropped.
    const pure = Object.keys(wrapper).every(key => key === "errors" || key === "status" && wrapper.status === status);
    entries = pure ? wrapper.errors : [];
  }
  const findings = entries.length > 0 && entries.length <= 12 ? entries.map(entry => lookupFinding(entry, reference)) : [];
  if (findings.length && findings.every(finding => finding === "missing")) return MISSING_ORDER;
  const all = Array.isArray(value) ? value : [value, ...(Array.isArray(wrapper?.errors) ? wrapper.errors : [])];
  // Any other refusal says nothing either way about whether postage exists (28 Nov 2026: Click & Drop
  // refused the lookup for a first booking in a way none of the patterns above recognised). Only a
  // separate, complete, read-only scan of the order list can settle it; if that can't, booking stays blocked.
  const selector = new RoyalMailLookupSelectorError("royal_mail_rejected",
    "Royal Mail rejected the order-reference lookup. Click & Drop could not resolve the reference.", status);
  selector.said = lookupCodes(all);
  // An account, service or access refusal must not turn into a manual first-booking exception.
  selector.accessProblem = accessProblem;
  selector.manualReviewAllowed = !accessProblem && findings.length > 0 && findings.every(finding => finding !== null && finding === findings[0]);
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
  return new RoyalMailError("royal_mail_unavailable", posting
    ? "Click & Drop returned HTTP " + status + " before the postage booking could be confirmed."
    : "Royal Mail did not confirm this request.", status, posting);
}

async function clickDrop(
  key: string,
  path: string,
  { body, reference, serviceCode, label = false, missingOkay = false, listing = false, signal }: { body?: ReturnType<typeof orderBody>; reference?: string; serviceCode?: string; label?: boolean; missingOkay?: boolean; listing?: boolean; signal?: AbortSignal },
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
  } catch (error) {
    const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    const message = posting
      ? timeout ? "The postage request timed out before Click & Drop returned its booking result."
        : "The connection ended before Click & Drop returned its postage booking result."
      : "Royal Mail did not confirm this request.";
    throw new RoyalMailError("royal_mail_unavailable", message, undefined, posting);
  }
  if (posting && (response.headers.has("content-range") || (response.ok && response.status !== 200))) {
    void response.body?.cancel().catch(() => {});
    throw unconfirmedReceipt("Click & Drop did not return a completed postage booking receipt (HTTP " + response.status + ").", response.status);
  }
  if (!response.ok) {
    if (posting && (response.status === 400 || response.status === 422)) {
      const error = await rejectedBooking(response, reference, serviceCode, body?.items[0]);
      if (error.code === "royal_mail_invalid_response") throw unconfirmedReceipt(
        "Click & Drop returned HTTP " + response.status + ", but the reply did not establish whether postage was created.", response.status);
      throw error;
    }
    if (missingOkay && reference && (response.status === 400 || response.status === 422)) return lookupRefusal(response, reference);
    void response.body?.cancel().catch(() => {});
    if (response.status === 404 && missingOkay) return MISSING_ORDER;
    throw responseError(response.status, posting, label);
  }

  if (listing && (response.status !== 200 || response.headers.has("content-range"))) {
    void response.body?.cancel().catch(() => {});
    throw invalidResponse();
  }
  return readProviderResponse(response, label, posting, listing);
}

async function readProviderResponse(response: Response, label = false, posting = false, listing = false): Promise<unknown> {
  const type = response.headers.get("content-type") || "";
  const validType = label ? /^(?:application\/pdf|application\/octet-stream)(?:\s*;|$)/i : /^application\/json(?:\s*;|$)/i;
  if (!validType.test(type)) {
    void response.body?.cancel().catch(() => {});
    if (posting) throw unconfirmedReceipt("Click & Drop's booking receipt was not in the expected JSON format.", response.status);
    throw invalidResponse();
  }
  try {
    const bytes = await readBytes(response, label ? PDF_LIMIT : posting ? CREATE_LIMIT : listing ? LIST_LIMIT : JSON_LIMIT, "Royal Mail response exceeded its limit.");
    if (label) {
      const decoder = new TextDecoder();
      const header = decoder.decode(bytes.subarray(0, 9));
      const trailer = decoder.decode(bytes.subarray(Math.max(0, bytes.length - 1024)));
      if (pdfEdges(header, trailer)) return bytes;
      throw invalidResponse();
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch (error) {
    void response.body?.cancel().catch(() => {});
    if (posting) throw unconfirmedReceipt(error instanceof ApiError && error.status === 413
      ? "Click & Drop's booking receipt exceeded the response size limit."
      : "Click & Drop's booking receipt could not be read completely.", response.status);
    if (listing && error instanceof ApiError && error.status === 413) throw new RoyalMailManualLookupError("oversized");
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

// Click & Drop can accept the order and separately return labelErrors when generating
// its documents. Preserve the accepted booking and display only recognised field guidance.
function labelGenerationProblem(value: unknown): string | undefined {
  if (!Array.isArray(value) || !value.length) return undefined;
  const guidance = new Set<string>();
  for (const raw of value.slice(0, 12)) {
    const error = record(raw);
    if (!error) continue;
    const message = typeof error.message === "string" ? error.message.slice(0, 4096) : "";
    const code = typeof error.code === "string" ? error.code.slice(0, 100).replace(/([a-z])([A-Z])/g, "$1 $2") : "";
    addBookingGuidance(guidance, [], message + " " + code);
  }
  return "Royal Mail accepted this order but could not generate its label. " +
    ([...guidance].slice(0, 3).join(" ") || "Check the existing order in Click & Drop.");
}

function publicOrder(value: unknown, reference: string, posting = false): RoyalMailOrder {
  const item = record(value);
  if (!item || item.orderReference !== reference || typeof item.orderIdentifier !== "number" ||
      !Number.isSafeInteger(item.orderIdentifier) || item.orderIdentifier <= 0) {
    throw posting ? unconfirmedReceipt("Click & Drop's postage receipt did not identify the submitted order and its booking number.") : invalidResponse();
  }
  const packages = Array.isArray(item.packages) ? item.packages : [];
  if (item.packages != null && !Array.isArray(item.packages) || packages.length > 1 || (packages.length === 1 && !record(packages[0]))) {
    throw posting ? unconfirmedReceipt("Click & Drop's postage receipt did not identify one parcel.") : invalidResponse();
  }
  const packageItem = record(packages[0]);
  const orderTracking = royalMailTrackingNumber(item.trackingNumber);
  const packageTracking = royalMailTrackingNumber(packageItem?.trackingNumber);
  if (orderTracking && packageTracking && orderTracking !== packageTracking &&
      (orderTracking.length === packageTracking.length || !royalMailTrackingV2Number(orderTracking) || !royalMailTrackingV2Number(packageTracking))) {
    throw posting ? unconfirmedReceipt("Click & Drop's postage receipt contained conflicting tracking numbers.") : invalidResponse();
  }
  const labelled = isRoyalMailEventTime(item.printedOn) || isRoyalMailEventTime(item.manifestedOn) || (posting && inlineLabel(item.label));
  const providerState = isRoyalMailEventTime(item.shippedOn) ? "dispatched" : labelled ? "labelled" : "created";
  const labelProblem = posting && providerState === "created" ? labelGenerationProblem(item.labelErrors) : undefined;
  return {
    orderId: item.orderIdentifier,
    reference,
    trackingNumber: orderTracking ?? packageTracking,
    providerState,
    ...(labelProblem ? { labelProblem } : {}),
  };
}

/** Create once. An uncertain result must be reconciled by reference by the caller. */
export async function createRoyalMailOrder(key: string, input: RoyalMailOrderInput, fetcher = fetch): Promise<RoyalMailOrder> {
  const body = orderBody(input);
  const result = record(await clickDrop(key, "/orders", { body, reference: input.reference, serviceCode: input.serviceCode }, fetcher));
  const failures = result && exactRejection(result, input.reference, body.items[0]);
  if (failures) {
    const refusal = bookingRejection([result, ...failures], 400, input.serviceCode, true);
    if (refusal.code === "royal_mail_invalid_response") throw unconfirmedReceipt("Click & Drop reported an order error without confirming the postage outcome.");
    throw refusal;
  }
  const completeCounts = result?.successCount === 1 && result.errorsCount === 0;
  // Both counters are optional in CreateOrdersResponse. If one is omitted, confirm
  // a single documented receipt by numeric ID before trusting its label or tracking.
  if (!result || (result.successCount !== undefined && result.successCount !== 1) ||
      (result.errorsCount !== undefined && result.errorsCount !== 0) ||
      (!completeCounts && Object.keys(result).some(field => !["successCount", "errorsCount", "createdOrders", "failedOrders"].includes(field))) ||
      (result.failedOrders !== undefined && !(Array.isArray(result.failedOrders) && !result.failedOrders.length)) || !Array.isArray(result.createdOrders) || result.createdOrders.length !== 1) {
    throw unconfirmedReceipt("Click & Drop's receipt did not identify one successful booking or one confirmed refusal.");
  }
  const created = record(result.createdOrders[0]);
  if (!created) throw unconfirmedReceipt("Click & Drop's receipt did not include readable booking details.");
  const reference = created.orderReference;
  if (completeCounts && reference === input.reference) return publicOrder(created, input.reference, true);
  if (reference !== input.reference && reference != null && (typeof reference !== "string" || reference.trim() !== "")) {
    throw unconfirmedReceipt("Click & Drop's receipt named a different order reference.");
  }
  const id = created.orderIdentifier;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) {
    throw unconfirmedReceipt("Click & Drop's receipt did not include a valid booking number.");
  }
  if (!completeCounts && !isRoyalMailEventTime(created.createdOn)) {
    throw unconfirmedReceipt("Click & Drop's receipt was missing its booking totals and a valid creation time.");
  }
  const accepted = publicOrder({ ...created, orderReference: input.reference }, input.reference, true);
  const candidateId = isRoyalMailEventTime(created.createdOn) ? id : undefined;

  // The reference echo on a successful POST is optional. Only use its label or
  // tracking after an independent numeric read proves the original reference.
  let confirmed: RoyalMailOrder | null;
  try {
    confirmed = await findRoyalMailOrderById(key, id, input.reference, fetcher);
  } catch (error) {
    // A transport interruption can be retried by ID under this credential. Never
    // retain a candidate from a conflicting, ambiguous or malformed identity check.
    const transient = error instanceof RoyalMailError && (error.code === "royal_mail_rate_limited" ||
      (error.code === "royal_mail_unavailable" && (error.status === undefined || error.status === 408 || error.status >= 500)));
    throw unconfirmedReceipt(transient
      ? "Click & Drop returned a booking number, but its confirmation lookup was interrupted."
      : "Click & Drop returned a booking number, but its lookup did not verify the original order.",
      undefined, transient ? candidateId : undefined);
  }
  if (!confirmed) throw unconfirmedReceipt("Click & Drop returned a booking number that is not yet visible in its order lookup.", undefined, candidateId);
  if (confirmed.trackingNumber && accepted.trackingNumber && confirmed.trackingNumber !== accepted.trackingNumber) {
    throw unconfirmedReceipt("Click & Drop returned different tracking details for the booking number.");
  }
  const trackingNumber = confirmed.trackingNumber ?? accepted.trackingNumber;
  if (confirmed.providerState === "dispatched" || (confirmed.providerState === "labelled" && accepted.providerState !== "dispatched")) {
    return { ...confirmed, trackingNumber };
  }
  return { ...accepted, trackingNumber };
}

async function readOrderReference(key: string, reference: string, fetcher: typeof fetch, validateIdentity = false): Promise<RoyalMailOrder | null> {
  const path = "/orders/" + encodeURIComponent('"' + reference + '"');
  const result = await clickDrop(key, path, { missingOkay: true, reference }, fetcher);
  if (result === MISSING_ORDER || (Array.isArray(result) && result.length === 0)) return null;
  if (!Array.isArray(result) || result.length !== 1) throw invalidResponse();
  if (validateIdentity) listedOrder(result[0], true);
  return publicOrder(result[0], reference);
}

/** The provider accepts a quoted, encoded order reference. Ambiguous matches are unsafe. */
export async function findRoyalMailOrder(key: string, reference: string, fetcher = fetch, context?: { firstOrderCreatedAt: number | null }): Promise<RoyalMailOrder | null> {
  const knownReference = orderReference(reference);
  const started = Date.now();
  try {
    return await readOrderReference(key, knownReference, fetcher);
  } catch (error) {
    if (!(error instanceof RoyalMailLookupSelectorError)) throw error;
    try {
      const created = context?.firstOrderCreatedAt;
      const cutoff = typeof created === "number" && Number.isSafeInteger(created) && created >= Date.UTC(2000, 0, 1) && created <= started
        ? created - FIRST_BOOKING_CLOCK_MARGIN_MS : null;
      const match = await findInOrderList(key, knownReference, started, cutoff, !!context, fetcher);
      if (!match && error.accessProblem) throw new RoyalMailError("royal_mail_denied", "The original order lookup reported an account or service problem.");
      return match;
    } catch (listError) {
      if (!(listError instanceof RoyalMailError)) throw listError;
      if (listError instanceof RoyalMailManualLookupError && error.manualReviewAllowed) throw listError;
      const detail = listFailureGuidance(listError);
      const said = error.said ? " (Royal Mail's code: " + error.said + ")" : "";
      const code = listError.code === "royal_mail_invalid_response" ? "royal_mail_rejected" : listError.code;
      throw new RoyalMailError(code, "Royal Mail rejected the order-reference lookup. " + detail + said, listError.status ?? error.status);
    }
  }
}

const RECOVERY_WINDOW = 2 * 60 * 60_000;
type OrderWindow = { from: number; to: number };

function recoveryWindows(submittedAt: number, orderDate: number | null, now: number): OrderWindow[] {
  const valid = (time: number | null): time is number => typeof time === "number" && Number.isSafeInteger(time) && time >= Date.UTC(2000, 0, 1) && time <= now;
  if (!valid(submittedAt)) throw invalidResponse();
  const window = (time: number) => ({ from: time - RECOVERY_WINDOW, to: Math.min(now, time + RECOVERY_WINDOW) });
  const sent = window(submittedAt);
  if (!valid(orderDate)) return [sent];
  const placed = window(orderDate);
  if (placed.from <= sent.to && sent.from <= placed.to) {
    return [{ from: Math.min(sent.from, placed.from), to: Math.max(sent.to, placed.to) }];
  }
  return [sent, placed];
}

/** Only identifies an already submitted parcel. A negative result cannot release a purchase. */
export async function findSubmittedRoyalMailOrder(key: string, reference: string, submittedAt: number, orderDate: number | null, fetcher = fetch) {
  const expected = orderReference(reference), started = Date.now();
  try {
    const direct = await readOrderReference(key, expected, fetcher, true);
    if (direct) return direct;
  } catch (error) {
    if (!(error instanceof RoyalMailLookupSelectorError)) throw error;
    if (error.accessProblem) throw new RoyalMailError("royal_mail_denied", "Click & Drop did not authorise the order search.", error.status);
  }

  // C&D's date-range contract does not specify orderDate vs. createdOn. Search the
  // actual submitted order date and the local send time, never an entire account.
  // Only a numeric lookup which returns this exact wholesale reference can succeed.
  let found: RoyalMailOrder | null = null;
  for (const window of recoveryWindows(submittedAt, orderDate, started)) {
    const current = await findInOrderList(key, expected, started, null, false, fetcher, window);
    if (!current) continue;
    if (found && (found.orderId !== current.orderId || found.trackingNumber && current.trackingNumber &&
        found.trackingNumber !== current.trackingNumber)) throw invalidResponse();
    found = current;
  }
  return found;
}

/** Read an already pinned booking by its numeric identifier. Never scan the account or create an order. */
export async function findRoyalMailOrderById(key: string, orderId: number, reference: string, fetcher = fetch): Promise<RoyalMailOrder | null> {
  if (!Number.isSafeInteger(orderId) || orderId <= 0) invalidShipment("Use a valid Royal Mail order identifier.");
  const expected = orderReference(reference);
  const result = await clickDrop(key, "/orders/" + orderId, { missingOkay: true }, fetcher);
  if (result === MISSING_ORDER || (Array.isArray(result) && !result.length)) return null;
  if (!Array.isArray(result) || result.length !== 1) throw invalidResponse();
  const item = record(result[0]);
  if (!item) throw invalidResponse();
  if ((typeof item.orderIdentifier === "number" && Number.isSafeInteger(item.orderIdentifier) && item.orderIdentifier > 0 && item.orderIdentifier !== orderId) ||
      (typeof item.orderReference === "string" && item.orderReference.trim() && item.orderReference !== expected)) {
    throw new RoyalMailError("royal_mail_order_mismatch", "Royal Mail returned a different booking for the saved order.");
  }
  if (item.orderIdentifier !== orderId || item.orderReference !== expected ||
      (item.createdOn !== undefined && !isRoyalMailEventTime(item.createdOn)) ||
      (item.packages != null && !Array.isArray(item.packages))) throw invalidResponse();
  return publicOrder(item, expected);
}

const listMetadataFields = new Set(["requestId", "correlationId", "timestamp", "generatedAt", "apiVersion", "version"]);
const submittedListMetadata = new Set(["traceId", "responseId", "serverTime", "serverDateTime", "responseTimestamp", "processingTimeMs", "durationMs"]);

function listFailureGuidance(error: RoyalMailError): string {
  if (error instanceof RoyalMailManualLookupError) return "The carrier did not give a clear reason for refusing the original lookup. Check the original order in Click & Drop.";
  if (error.code === "royal_mail_denied" && !error.status) return error.message + " Check Click & Drop before retrying.";
  switch (error.status) {
    case 400: case 422: return "Click & Drop rejected the read-only order list request (HTTP " + error.status + "). Check the order in Click & Drop.";
    case 401: return "Click & Drop did not authenticate the order list request (HTTP 401). Check the integration key.";
    case 403: return "Click & Drop denied access to the order list (HTTP 403). Check the account's order access.";
    case 404: return "Click & Drop did not return its order list (HTTP 404). Check the order in Click & Drop.";
    case 429: return "Click & Drop is rate limiting order list checks (HTTP 429). Try again later.";
  }
  if (error.status && error.status >= 500) return "Click & Drop's order list is unavailable (HTTP " + error.status + "). Try again later.";
  if (error.code === "royal_mail_unavailable") return "The order list request did not complete. Try again later.";
  return "The order list could not confirm this reference because it contained unreadable or conflicting booking details. Check the original order in Click & Drop.";
}

function benignListMetadata(key: string, value: unknown, submitted = false): boolean {
  const known = (field: string) => listMetadataFields.has(field) || submitted && submittedListMetadata.has(field);
  if (key === "meta" || key === "metadata") {
    const metadata = record(value);
    return !!metadata && Object.entries(metadata).every(([field, item]) => known(field) &&
      (item === null || typeof item === "string" || typeof item === "number"));
  }
  return known(key) && (value === null || typeof value === "string" || typeof value === "number");
}

function incompleteList(match: RoyalMailOrder | null, reason: keyof typeof manualLookupReasons): never {
  if (match) throw invalidResponse();
  throw new RoyalMailManualLookupError(reason);
}

const nestedOrderFields = new Set([
  "orderIdentifier", "orderId", "orderReference", "accountOrderNumber", "channelOrderReference",
  "orders", "createdOrders", "failedOrders", "errors",
]);

function checkNestedOrderFields(row: Record<string, unknown>): void {
  let remaining = 1024;
  function inspect(value: unknown, depth: number): void {
    if (!value || typeof value !== "object") return;
    if (depth > 12) throw invalidResponse();
    for (const [field, child] of Object.entries(value)) {
      if (--remaining < 0 || nestedOrderFields.has(field)) throw invalidResponse();
      inspect(child, depth + 1);
    }
  }
  for (const value of Object.values(row)) inspect(value, 1);
}

function listedOrder(value: unknown, identityOnly = false) {
  const row = record(value);
  if (!row || typeof row.orderIdentifier !== "number" || !Number.isSafeInteger(row.orderIdentifier) ||
      row.orderIdentifier < 1 || !identityOnly && !dateValue(row.createdOn) ||
      (row.orderReference != null && typeof row.orderReference !== "string") ||
      (row.packages != null && (!Array.isArray(row.packages) || row.packages.some(item => !record(item))))) throw invalidResponse();
  if (row.orderId != null && row.orderId !== row.orderIdentifier ||
      row.accountOrderNumber != null && row.accountOrderNumber !== 0 && row.accountOrderNumber !== row.orderIdentifier ||
      row.channelOrderReference != null && row.channelOrderReference !== "" && row.channelOrderReference !== row.orderReference ||
      ["orders", "createdOrders", "failedOrders", "errors"].some(field => Object.hasOwn(row, field))) throw invalidResponse();
  checkNestedOrderFields(row);
  return {row, id:row.orderIdentifier, createdOn:typeof row.createdOn === "string" ? row.createdOn : "", ref:row.orderReference};
}

// Only an exhausted, coherent list can establish absence. Whenever identity or
// pagination evidence conflicts, keep both automatic and manual purchases blocked.
async function findInOrderList(key: string, reference: string, started: number, oldBefore: number | null, firstBooking: boolean, fetcher: typeof fetch, window?: OrderWindow): Promise<RoyalMailOrder | null> {
  const query = new URLSearchParams({ pageSize: String(LIST_PAGE_SIZE) });
  if (window) {
    query.set("startDateTime", new Date(window.from).toISOString());
    query.set("endDateTime", new Date(window.to).toISOString());
  }
  const tokens = new Set<string>(), identifiers = new Set<number>();
  const deadline = started + LOOKUP_BUDGET_MS;
  const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  let previousRequest = window ? Date.now() : started, total: number | null = null;
  let match: RoyalMailOrder | null = null;
  const anonymous = new Map<number, string>();
  function consider(item: ReturnType<typeof listedOrder>) {
    if (!sameReference(item.ref, reference, true)) return;
    if (item.ref !== reference || match) throw invalidResponse();
    match = publicOrder(item.row, reference);
  }
  function limited(reason: keyof typeof manualLookupReasons): never {
    // A staff-entered or imported order might already have been hand booked. Requiring
    // a complete snapshot also prevents an oversized account list being used as a shortcut.
    if (firstBooking && oldBefore === null) throw invalidResponse();
    return incompleteList(match, reason);
  }
  async function read(path: string, byId = false) {
    const delay = Math.max(0, LIST_INTERVAL_MS - (Date.now() - previousRequest));
    if (Date.now() + delay >= deadline) {
      if (byId) throw invalidResponse();
      limited("capacity");
    }
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    previousRequest = Date.now();
    try {
      return await clickDrop(key, path, {signal, listing:true}, fetcher);
    } catch (error) {
      if (error instanceof RoyalMailManualLookupError && (match || byId || firstBooking && oldBefore === null)) throw invalidResponse();
      throw error;
    }
  }
  for (let index = 0; index < LIST_MAX_PAGES; index++) {
    const reply = await read("/orders?" + query);
    if (Array.isArray(reply) && !reply.length) limited("envelope");
    const page = record(reply);
    if (page && page.orders == null && Object.entries(page).every(([field, value]) =>
      field === "orders" || field === "continuationToken" && (value == null || value === "") || benignListMetadata(field, value, !!window))) {
      limited("envelope");
    }
    if (!page || !Array.isArray(page.orders) || page.orders.length > LIST_PAGE_SIZE) throw invalidResponse();
    for (const [field, value] of Object.entries(page)) {
      if (field === "orders" || field === "continuationToken" || field === "hasMore" || field === "totalCount") continue;
      if (field === "count" && value === page.orders.length || field === "pageSize" && value === LIST_PAGE_SIZE) continue;
      if (!benignListMetadata(field, value, !!window)) throw invalidResponse();
    }
    if (page.hasMore !== undefined && typeof page.hasMore !== "boolean") throw invalidResponse();
    if (page.totalCount !== undefined) {
      if (typeof page.totalCount !== "number" || !Number.isSafeInteger(page.totalCount) || page.totalCount < 0 ||
          (total !== null && total !== page.totalCount)) throw invalidResponse();
      total = page.totalCount;
    }
    for (const value of page.orders) {
      const item = listedOrder(value, !!window);
      if (identifiers.has(item.id)) throw invalidResponse();
      identifiers.add(item.id);
      if (item.ref?.trim()) consider(item);
      // A provider-generated creation time can only exclude an anonymous order for a
      // confirmed first booking; an explicit matching reference always takes precedence.
      else if (oldBefore === null || Date.parse(item.createdOn) >= oldBefore) anonymous.set(item.id, item.createdOn);
    }
    if (total !== null && total < identifiers.size) throw invalidResponse();
    const next = page.continuationToken;
    if (next == null || next === "") {
      if (page.hasMore === true || total !== null && identifiers.size < total) limited("pagination");
      if (window) return corroborateListedOrder(match, anonymous, reference, read);
      if (!firstBooking) {
        if (!match && anonymous.size) incompleteList(match, "unreferenced");
        return match;
      }
      // The pageable projection may omit a reference which the numeric endpoint supplies.
      // Recheck only original IDs, within the same request budget and account credentials.
      const ids = [...anonymous.keys()];
      let unresolved = false;
      for (let pos = 0; pos < ids.length; pos += ORDER_ID_BATCH_SIZE) {
        if (pos >= ORDER_ID_BATCH_SIZE * MAX_ORDER_ID_BATCHES) throw invalidResponse();
        const expected = new Set(ids.slice(pos, pos + ORDER_ID_BATCH_SIZE));
        const records = await read("/orders/" + [...expected].join(";"), true);
        if (!Array.isArray(records) || records.length !== expected.size) throw invalidResponse();
        for (const value of records) {
          const item = listedOrder(value);
          if (!expected.delete(item.id) || anonymous.get(item.id) !== item.createdOn) throw invalidResponse();
          if (item.ref?.trim()) consider(item);
          else unresolved = true;
        }
      }
      if (unresolved) incompleteList(match, "unreferenced");
      return match;
    }
    if (page.hasMore === false || typeof next !== "string" || !next.trim() || next.length > 2048 ||
        /[\u0000-\u001f\u007f]/.test(next) || tokens.has(next)) throw invalidResponse();
    tokens.add(next);
    query.set("continuationToken", next);
  }
  limited("capacity");
}

// The list may omit an orderReference even when the numeric read supplies it.
async function corroborateListedOrder(listed: RoyalMailOrder | null, anonymous: Map<number, string>, reference: string,
  read: (path: string, byId: boolean) => Promise<unknown>): Promise<RoyalMailOrder | null> {
  const ids = [...anonymous.keys()];
  if (listed) ids.unshift(listed.orderId);
  if (ids.length > ORDER_ID_BATCH_SIZE * MAX_ORDER_ID_BATCHES) throw new RoyalMailManualLookupError("capacity");
  let verified: RoyalMailOrder | null = null;
  let unresolved = false;
  for (let start = 0; start < ids.length; start += ORDER_ID_BATCH_SIZE) {
    const remaining = new Set(ids.slice(start, start + ORDER_ID_BATCH_SIZE));
    const rows = await read("/orders/" + [...remaining].join(";"), true);
    if (!Array.isArray(rows) || rows.length !== remaining.size) throw invalidResponse();
    for (const value of rows) {
      const item = listedOrder(value, true);
      if (!remaining.delete(item.id)) throw invalidResponse();
      if (item.ref !== reference) {
        if (item.id === listed?.orderId || sameReference(item.ref, reference, true)) throw invalidResponse();
        if (!item.ref?.trim()) unresolved = true;
        continue;
      }
      if (verified || listed && listed.orderId !== item.id) throw invalidResponse();
      verified = publicOrder(item.row, reference);
      if (listed?.trackingNumber && verified.trackingNumber && listed.trackingNumber !== verified.trackingNumber) throw invalidResponse();
    }
  }
  if (!verified && unresolved) throw new RoyalMailManualLookupError("unreferenced");
  return verified;
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
