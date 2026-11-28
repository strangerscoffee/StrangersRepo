// Only the booking adapter, after a definite refusal of this operation, may write
// this marker. Earlier Workers classified some ambiguous carrier replies as failed.
export const DECLINED_POSTAGE = "Postage request declined. ";
const explicitConflicts = ["named another order in", "indicated an existing or ambiguous booking", "may already have this booking"];
const deniedRequests = ["Royal Mail did not accept the Click & Drop key.", "This Click & Drop account does not have access to this operation."];

export interface LocalRoyalMailShipment {
  state: string;
  requested_at: number | null;
  provider_id: number | null;
  candidate_provider_id: number | null;
  review_required: number;
  tracking_number: string | null;
  carrier_status: string | null;
  carrier_event_at: string | null;
  booking_account_scope: string | null;
  label_downloaded_at: number | null;
  problem: string | null;
}

export function canRequestRoyalMailPostage(row: LocalRoyalMailShipment | null): boolean {
  if (!row) return true;
  if (row.state !== "failed" || row.provider_id !== null || row.candidate_provider_id !== null ||
      row.review_required !== 0 || row.tracking_number !== null || row.carrier_status !== null || row.carrier_event_at !== null ||
      row.booking_account_scope !== null || row.label_downloaded_at !== null) return false;
  const problem = row.problem ?? "";
  if (explicitConflicts.some(message => problem.toLowerCase().includes(message))) return false;
  if (row.requested_at === 0) return true;
  return row.requested_at !== null && row.requested_at > 0 && (problem.startsWith(DECLINED_POSTAGE) || deniedRequests.includes(problem));
}

// Protect the same states in the recovery lease and handover compare-and-swap.
// Every SQL literal below is a source constant.
const literal = (s: string) => "'" + s.replaceAll("'", "''") + "'";
const contrary = explicitConflicts.map(text => "instr(lower(COALESCE(problem,'')), " + literal(text) + ") > 0").join(" OR ");
const declined = "(instr(COALESCE(problem,''), " + literal(DECLINED_POSTAGE) + ")=1 OR COALESCE(problem,'') IN (" + deniedRequests.map(literal).join(",") + "))";
export const HELD_FAILED_SHIPMENT = "(state='failed' AND (provider_id IS NOT NULL OR candidate_provider_id IS NOT NULL OR review_required<>0 " +
  "OR tracking_number IS NOT NULL OR carrier_status IS NOT NULL OR carrier_event_at IS NOT NULL OR booking_account_scope IS NOT NULL " +
  "OR label_downloaded_at IS NOT NULL OR " + contrary + " OR requested_at IS NULL OR requested_at<0 " +
  "OR (requested_at>0 AND NOT " + declined + ")))";
