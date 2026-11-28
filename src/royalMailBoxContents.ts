import { invalid } from "./http";

interface PackingLine {
  productId?: string; title?: string; pack?: string; packLabel?: string; grind?: string; grindLabel?: string;
  grams: number; quantity: number; price?: number;
}
export interface PackingOrder {
  grams: number; pence: number; deliveryPence?: number; totalPence?: number; lines?: PackingLine[];
}
export interface PackedContents {
  basis: string;
  quantities: number[][];
  goodsPence: number[];
}
const validPence = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

// Keep line order significant. A re-sort changes which coffees the recorded quantities identify.
export function packingBasis(order: PackingOrder) {
  return JSON.stringify([order.pence, order.deliveryPence ?? 0, order.totalPence, (order.lines ?? []).map(line =>
    [line.productId, line.pack, line.grind, line.quantity, line.grams, line.price])]);
}

function unitPrices(order: PackingOrder): number[] | null {
  const lines = order.lines ?? [];
  if (!validPence(order.pence) || !lines.length) return null;
  const prices = lines.map(line => line.price);
  const missing = prices.flatMap((price, index) => validPence(price) ? [] : [index]);
  const known = lines.reduce((sum, line) => sum + (validPence(line.price) ? line.price * line.quantity : 0), 0);
  if (missing.length === 1) {
    const index = missing[0];
    const residual = (order.pence - known) / lines[index].quantity;
    if (validPence(residual)) { prices[index] = residual; return prices as number[]; }
  }
  if (!missing.length && known === order.pence) return prices as number[];
  return null;
}

export function packingView(order: PackingOrder, staff: boolean) {
  const manualGoodsValuesRequired = unitPrices(order) === null;
  return {
    packingLines: (order.lines ?? []).map(line => ({ title: line.title || line.productId || "Coffee", quantity: line.quantity,
      packLabel: line.packLabel || line.pack || "", grindLabel: line.grindLabel || line.grind || "", grams: line.grams })),
    manualGoodsValuesRequired,
    ...(!staff && manualGoodsValuesRequired ? { orderGoodsPence: order.pence } : {}),
  };
}

function uniqueQuantities(lines: PackingLine[], weights: number[]): number[][] | null {
  if (!lines.length) return weights.map(() => []);
  if (lines.length !== 1) return null;
  const { grams, quantity } = lines[0];
  const capacities = weights.map(weight => Math.floor(weight / grams));
  if (capacities.some(limit => limit < 1)) return null;
  if (quantity === weights.length) return weights.map(() => [1]);
  if (capacities.reduce((sum, limit) => sum + limit, 0) === quantity) return capacities.map(n => [n]);
  const room = capacities.filter(limit => limit > 1);
  if (room.length === 1 && quantity - weights.length + 1 <= room[0]) {
    return capacities.map(limit => [limit === 1 ? 1 : quantity - weights.length + 1]);
  }
  return null;
}

export function packContents(order: PackingOrder, weights: number[], input: unknown, manualValues: unknown, staff: boolean): PackedContents {
  const lines = order.lines ?? [];
  if (lines.some(line => !Number.isSafeInteger(line.grams) || line.grams < 1 || !Number.isSafeInteger(line.quantity) || line.quantity < 1)) {
    throw invalid("The order is missing a bag weight or quantity. Review the saved order before splitting its postage.");
  }
  const quantities = input === undefined ? uniqueQuantities(lines, weights) : input;
  if (!Array.isArray(quantities) || quantities.length !== weights.length) throw invalid("Enter how many bags of each coffee are packed in every box.");
  const assigned = lines.map(() => 0);
  for (let box = 0; box < weights.length; box++) {
    const row = quantities[box];
    if (!Array.isArray(row) || row.length !== lines.length || row.some((q, i) => !Number.isSafeInteger(q) || q < 0 || q > lines[i].quantity)) {
      throw invalid("Enter a whole number of bags for each coffee in each box.");
    }
    const coffeeWeight = row.reduce((grams, q, i) => grams + lines[i].grams * q, 0);
    if (lines.length && !coffeeWeight) throw invalid("Each box must contain at least one bag.");
    if (coffeeWeight > weights[box]) throw invalid("Box " + (box + 1) + " weighs less than its coffee. Check its contents and sealed weight.");
    row.forEach((q, i) => { assigned[i] += q; });
  }
  if (lines.some((line, i) => assigned[i] !== line.quantity)) throw invalid("Assign every bag on the order to one box.");
  const prices = unitPrices(order);
  let goodsPence: number[];
  if (prices) {
    if (manualValues !== undefined) throw invalid("Use the saved coffee prices for this order.");
    goodsPence = quantities.map(row => row.reduce((sum: number, q: number, i: number) => sum + prices[i] * q, 0));
  } else {
    if (staff) throw invalid("Some saved coffee prices are unavailable. Ask Admin to confirm the value of each box.");
    if (!Array.isArray(manualValues) || manualValues.length !== weights.length || !manualValues.every(validPence) ||
        !validPence(order.pence) || manualValues.reduce((sum, value) => sum + value, 0) !== order.pence) {
      throw invalid("Enter the goods value of each box. Their sum must equal the saved order subtotal.");
    }
    goodsPence = manualValues;
  }
  return { basis: packingBasis(order), quantities, goodsPence };
}
