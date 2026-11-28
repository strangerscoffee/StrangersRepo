import { ApiError, type Env, invalid } from "./http";
import type { User } from "./auth";
import { HELD_FAILED_SHIPMENT, HELD_ROYAL_MAIL_OPERATION } from "./royalMailBookingState";
import { version } from "./wholesaleStore";
import { packContents, type PackedContents, type PackingOrder } from "./royalMailBoxContents";

export interface RoyalMailBoxPlan {
  revision: string;
  weights: number[];
  fingerprint: string;
  packed: PackedContents | null;
}
export interface RoyalMailBox {
  number: number;
  count: number;
  weightGrams: number;
  reference: string;
  planVersion: string;
  contents: number[];
  goodsPence: number;
  beforeGrams: number;
  totalGrams: number;
}

const MAX_BOXES = 50;

export function boxPlanConflict() {
  return new ApiError(409, "royal_mail_box_plan_changed", "The box plan or booking changed. Reopen the order and review its boxes.");
}
function validWeights(weights: unknown): weights is number[] {
  return Array.isArray(weights) && weights.length >= 2 && weights.length <= MAX_BOXES &&
    weights.every(weight => Number.isSafeInteger(weight) && weight >= 1 && weight <= 30_000);
}

export async function readRoyalMailBoxPlan(env: Env, orderId: string): Promise<RoyalMailBoxPlan | null> {
  const plan = await env.DB.prepare("SELECT revision,weights,shipping_fingerprint,contents FROM wholesale_royal_mail_box_plans WHERE order_id=?")
    .bind(orderId).first<{ revision: string; weights: string; shipping_fingerprint: string; contents: string | null }>();
  if (!plan) return null;
  const weights: unknown = JSON.parse(plan.weights);
  if (!validWeights(weights)) throw boxPlanConflict();
  const packed: PackedContents | null = plan.contents ? JSON.parse(plan.contents) : null;
  if (packed && (typeof packed.basis !== "string" || !Array.isArray(packed.quantities) || packed.quantities.length !== weights.length ||
    !packed.quantities.every(row => Array.isArray(row) && row.every(q => Number.isSafeInteger(q) && q >= 0)) ||
    !Array.isArray(packed.goodsPence) || packed.goodsPence.length !== weights.length || !packed.goodsPence.every(p => Number.isSafeInteger(p) && p >= 0))) throw boxPlanConflict();
  return { revision: plan.revision, weights, fingerprint: plan.shipping_fingerprint, packed };
}

export function royalMailBoxes(id: string, plan: RoyalMailBoxPlan): RoyalMailBox[] {
  const totalGrams = plan.weights.reduce((sum, grams) => sum + grams, 0);
  let beforeGrams = 0;
  return plan.weights.map((weightGrams,index) => {
    const number = index + 1;
    const box = { number, reference: id + "-B" + number, weightGrams, count: plan.weights.length, planVersion: plan.revision, contents:plan.packed?.quantities[index] ?? [], goodsPence:plan.packed?.goodsPence[index] ?? 0, beforeGrams, totalGrams };
    beforeGrams += weightGrams;
    return box;
  });
}

// Allocate only order-level shipping charges and tax. Goods values come from the bags packed in each box.
export function parcelValue(pence: number, box: RoyalMailBox | null): number {
  if (!box || !Number.isSafeInteger(pence) || pence < 0) return pence;
  const total = BigInt(box.totalGrams);
  const share = (grams: number) => (BigInt(pence) * BigInt(grams) * 2n + total) / (2n * total);
  return Number(share(box.beforeGrams + box.weightGrams) - share(box.beforeGrams));
}

export function checkBoxReview(box: RoyalMailBox | null, body: Record<string, unknown>) {
  if (box && (body.planVersion !== box.planVersion || body.weightGrams !== box.weightGrams)) throw boxPlanConflict();
}

export function bookingPlanGuard(orderId: string, box: RoyalMailBox | null) {
  return box ? {
    sql: " AND EXISTS (SELECT 1 FROM wholesale_royal_mail_box_plans WHERE order_id=? AND revision=?)",
    args: [orderId, box.planVersion],
  } : {
    sql: " AND NOT EXISTS (SELECT 1 FROM wholesale_royal_mail_box_plans WHERE order_id=?)",
    args: [orderId],
  };
}

export function shippingAccessGuard(actor: User, staff: boolean) {
  const grantRequired = staff && actor.role !== "admin";
  return {
    sql: " AND EXISTS (SELECT 1 FROM users WHERE id=? AND role=? AND active=1 AND must_change=0)" +
      (grantRequired ? " AND EXISTS (SELECT 1 FROM staff_order_access WHERE user_id=? AND enabled=1)" : ""),
    args: [actor.id, actor.role, ...(grantRequired ? [actor.id] : [])],
  };
}

export async function changeRoyalMailBoxPlan(env: Env, order: PackingOrder & {id:string;version:number}, fingerprint: string,
  body: Record<string,unknown>, staffGuard: {sql:string;args:(string|number|null)[]}, actor: User, staff: boolean) {
  if (version(body.ifVersion) !== order.version || !(body.planVersion === null || typeof body.planVersion === "string")) throw boxPlanConflict();
  if (Object.keys(body).some(key => !["ifVersion","planVersion","weights","contents", ...(staff ? [] : ["goodsPence"])].includes(key))) throw invalid("Send the reviewed box weights and contents.");
  const weights = body.weights;
  if (!(Array.isArray(weights) && !weights.length) && !validWeights(weights)) throw invalid("Enter 2 to 50 sealed boxes, each weighing between 1 g and 30 kg.");
  if (weights.length && (!Number.isSafeInteger(order.grams) || weights.reduce((sum, grams) => sum + grams, 0) < order.grams)) {
    throw invalid("The combined sealed box weights must cover all the coffee in the order.");
  }
  const packed = weights.length ? packContents(order, weights, body.contents, body.goodsPence, staff) : null;
  const revision = crypto.randomUUID();
  const access = shippingAccessGuard(actor, staff);
  const children = order.id + "-B*";
  const guarded = `NOT EXISTS (SELECT 1 FROM wholesale_royal_mail_shipments
    WHERE (order_id=? OR order_id GLOB ?) AND ${HELD_ROYAL_MAIL_OPERATION})`;
  // A snapshot read alone cannot decide whether a concurrent purchase has committed.
  // Claim the plan and clear obsolete, definitively refused drafts in the same transaction.
  const statements = [
    env.DB.prepare(`INSERT INTO wholesale_royal_mail_box_plans(order_id,revision,weights,shipping_fingerprint,contents)
      SELECT ?,?,?,?,? WHERE ${guarded}
      AND EXISTS (SELECT 1 FROM wholesale_preview WHERE kind='order' AND id=? AND version=? AND json_extract(data,'$.status')='Ready')
      AND (? IS NULL OR EXISTS (SELECT 1 FROM wholesale_royal_mail_box_plans WHERE order_id=? AND revision=?))
      ${access.sql}${staffGuard.sql}
      ON CONFLICT(order_id) DO UPDATE SET revision=excluded.revision,weights=excluded.weights,shipping_fingerprint=excluded.shipping_fingerprint,contents=excluded.contents
      WHERE revision=?`).bind(order.id,revision,JSON.stringify(weights),fingerprint,packed ? JSON.stringify(packed) : null,order.id,children,order.id,order.version,
        body.planVersion,order.id,body.planVersion,...access.args,...staffGuard.args,body.planVersion),
    env.DB.prepare(`DELETE FROM wholesale_royal_mail_shipments WHERE order_id GLOB ? AND state='failed' AND NOT ${HELD_FAILED_SHIPMENT}
      AND EXISTS (SELECT 1 FROM wholesale_royal_mail_box_plans WHERE order_id=? AND revision=?)`).bind(children,order.id,revision),
  ];
  if (!weights.length) statements.push(env.DB.prepare("DELETE FROM wholesale_royal_mail_box_plans WHERE order_id=? AND revision=?").bind(order.id,revision));
  const [claimed] = await env.DB.batch(statements);
  if (claimed.meta.changes !== 1) throw boxPlanConflict();
}
