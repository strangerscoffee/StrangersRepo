import { ApiError, type Env } from "./http";
import { billingAddressFor } from "./quickbooks/billingReviews";
import { RoyalMailError, royalMailOrderBody, type RoyalMailOrderInput } from "./royalMail";
import { royalMailAddressReview, royalMailRecipientDraft } from "./royalMailDestination";

type BookingOrder = Parameters<typeof royalMailRecipientDraft>[0] & {
  customerId?: string | null; createdAt: number; customerSnapshot?: { address?: string; postcode?: string; contact?: string; email?: string };
};
type BookingSettings = Pick<RoyalMailOrderInput, "serviceCode" | "serviceRegisterCode" | "shippingAccountName">;
type BookingMoney = Pick<RoyalMailOrderInput, "subtotalPence" | "shippingPence" | "taxPence" | "totalPence">;
export const BILLING_REVISION_GUARD = ` AND COALESCE((SELECT id FROM wholesale_invoice_billing_reviews
  WHERE customer_id=? AND environment='production' ORDER BY id DESC LIMIT 1),0)=?`;

function addressDraft(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
}

export async function prepareRoyalMailBooking(env: Env, order: BookingOrder, settings: BookingSettings,
  money: BookingMoney, reference: string, body: Record<string, unknown>, minimumWeight: number, staff: boolean) {
  const confirmed = order.customerId ? await billingAddressFor(env, order.customerId) : null;
  const billingRevision = confirmed?.id ?? 0;
  if (body.billingRevision !== undefined && body.billingRevision !== billingRevision) {
    throw new ApiError(409, "royal_mail_billing_changed", "The confirmed billing address changed. Review the booking again.");
  }
  const destinationDraft = staff ? royalMailRecipientDraft(order) : addressDraft(body.recipient);
  const destination = royalMailAddressReview(destinationDraft, "recipient");
  const billingSource = !staff && body.billing !== undefined ? "override" : confirmed ? "confirmed" : "delivery";
  const billingDraft: Record<string, unknown> = billingSource === "override" ? addressDraft(body.billing)
    : billingSource === "confirmed" && confirmed ? royalMailRecipientDraft({ business: order.business, customerSnapshot: { address: confirmed.address, postcode: confirmed.postcode } }, true)
    : destinationDraft;
  const billing = billingSource === "delivery" ? destination : royalMailAddressReview(billingDraft, "billing");
  const issues = [...destination.issues, ...(billingSource === "delivery" ? [] : billing.issues)];
  const weight = body.weightGrams;
  if (typeof weight !== "number" || !Number.isInteger(weight) || !Number.isSafeInteger(minimumWeight) || weight < Math.max(1, minimumWeight) || weight > 30_000) {
    issues.push({ field: "parcel.weightGrams", message: "Enter the packed weight in grams. It must cover the coffee in this parcel and be at most 30 kg." });
  }
  function contact(address: typeof destination.address, deliveryUpdates: boolean) {
    return { name: address.name, companyName: order.business.slice(0, 100),
      addressLine1: address.line1, addressLine2: address.line2, city: address.city, county: address.county, postcode: address.postcode,
      ...(deliveryUpdates && order.customerSnapshot?.email ? { emailAddress: order.customerSnapshot.email } : {}) };
  }
  const date = new Date(order.createdAt);
  const input: RoyalMailOrderInput = { reference, orderDate: Number.isFinite(date.getTime()) ? date.toISOString() : "",
    recipient: contact(destination.address, true), billing: contact(billing.address, billingSource === "delivery"),
    parcel: { weightInGrams: typeof weight === "number" ? weight : 0, format: "parcel" }, ...money, ...settings };
  if (!issues.length) {
    try { royalMailOrderBody(input); }
    catch (error) {
      if (!(error instanceof RoyalMailError) || error.code !== "royal_mail_invalid_shipment") throw error;
      issues.push({ field: "order", message: error.message });
    }
  }
  // Only an admin can see the billing draft. Expose expected editable fields, not received metadata.
  const editable = Object.fromEntries(["name", "line1", "line2", "city", "county", "postcode"]
    .map(field => [field, typeof billingDraft[field] === "string" ? billingDraft[field] : ""]));
  return { input, billingRevision, review: { ready: !issues.length, issues, billingSource, billingRevision,
    ...(!staff ? { billingDraft: editable } : {}) } };
}
