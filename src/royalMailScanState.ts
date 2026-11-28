// Tracking V2 summaries can describe pre-advice before a physical parcel scan.
export type RoyalMailScanState = "awaiting" | "in_transit" | "exception" | "delivered" | "unknown";

export function royalMailScanState(description: string | null, category?: string | null): RoyalMailScanState {
  const normalise = (text: string | null | undefined) => (text || "").trim().toLowerCase().replace(/[_-]/g, " ");
  const text = normalise(description);
  const group = normalise(category);
  if (/\b(?:delivery attempted|attempted delivery|delivery exception|unable to deliver|could not deliver|couldn't deliver|not (?:yet )?delivered|delivery not successful|tried to deliver|delivered (?:back |returned )?to (?:the )?sender|delivery refused|address (?:incomplete|inaccessible)|returned to sender|returning to sender|delivery failed|addressee gone away|no answer)\b/.test(text)) return "exception";
  if (/^delivered[.!]?$|^delivered (?:to (?:recipient|addressee|neighbou?r|a? ?safe ?place)|and signed for)(?:\b|$)/.test(text)) return "delivered";
  if (/\b(?:sender (?:has |is )?(?:prepar\w*|dispatched|despatched|dispatching|despatching)|we.re expecting|we.re waiting|pre advice|advised|label (?:created|generated)|electronic notification|information received)\b/.test(text)) return "awaiting";
  if (group === "delivered") return "delivered";
  if (["exception", "delivery exception", "delivery attempted", "attempted delivery", "undeliverable", "returned to sender"].includes(group)) return "exception";
  if (["pre advice", "pre transit", "advised", "label created"].includes(group)) return "awaiting";
  if (["in transit", "out for delivery", "ready for collection"].includes(group) ||
      /\b(?:accepted at|received at|item received|arrived at|in transit|out for delivery|due to be delivered today|ready for collection)\b/.test(text)) return "in_transit";
  return "unknown";
}
