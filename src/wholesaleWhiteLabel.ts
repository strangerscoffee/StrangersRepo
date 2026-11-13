// White-label coffees and recipes (Admin → Wholesale → Coffee catalogue). A coffee can be made private to one or more
// businesses (`whiteLabel`: their customer ids): only they see and order it, at its own prices, listed first as "Your
// coffee"; everyone else never sees it, and checkout refuses it for them. Any coffee can record what it's made from
// (`recipe`: coffees or named components with whole percentages adding to 100). Wholesale staff see the recipe on
// orders and packing (snapshotted onto each order line as `recipe` text); customers never see recipes or who else a
// coffee belongs to.
import { invalid } from "./http";
import { object, text } from "./wholesaleStore";

export interface RecipePart { coffee?: string; name: string; percent: number }
type WithLabel = { id: string; name: string; whiteLabel?: string[]; customerOnly?: true; recipe?: RecipePart[] };

export function editedWhiteLabel(value: unknown): string[] | undefined {
  if (value == null || (Array.isArray(value) && !value.length)) return undefined;
  if (!Array.isArray(value) || value.length > 50 || value.some((id) => typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id))) throw invalid("Choose up to 50 businesses for a white-label coffee.");
  return [...new Set(value as string[])];
}
export function editedRecipe(value: unknown, ids: Set<string>, self: string | null): RecipePart[] | undefined {
  if (value == null || (Array.isArray(value) && !value.length)) return undefined;
  if (!Array.isArray(value) || value.length > 10) throw invalid("A recipe has up to 10 parts.");
  const parts = value.map((raw) => {
    const part = object(raw);
    const coffee = part.coffee == null || part.coffee === "" ? undefined : part.coffee;
    if (coffee !== undefined && (typeof coffee !== "string" || !ids.has(coffee) || coffee === self)) throw invalid("Choose a coffee from the catalogue for each part of the recipe.");
    if (!Number.isInteger(part.percent) || part.percent < 1 || part.percent > 100) throw invalid("Give each part of the recipe a whole percentage from 1 to 100.");
    return { ...(coffee ? { coffee } : {}), name: text(part.name, "recipe coffee", 80, true), percent: part.percent as number };
  });
  if (parts.reduce((t, p) => t + p.percent, 0) !== 100) throw invalid("The recipe's percentages need to add up to 100.");
  return parts;
}
/** "60% Campo Santo · 40% Bom Jesus", for staff. */
export const recipeText = (product: { recipe?: RecipePart[] }) => (product.recipe || []).map((p) => `${p.percent}% ${p.name}`).join(" · ");
/** Whether this business (or a staff preview, customerId null) may see and order the coffee. */
export const isCustomCoffee = (product: Pick<WithLabel, "whiteLabel" | "customerOnly">) => product.customerOnly === true || !!product.whiteLabel?.length;
export const canOrder = (product: WithLabel, customerId: string | null) => !isCustomCoffee(product) || customerId === null || !!product.whiteLabel?.includes(customerId);
/** The catalogue as a customer sees it: their own white-label coffees first (marked `yours`), the rest of the range,
 *  no one else's white-label coffees and no recipes. Staff previews see everything, white-label coffees marked. */
export function catalogueFor<T extends WithLabel>(coffees: T[], customerId: string | null) {
  if (customerId === null) return coffees.map(({ whiteLabel, customerOnly, ...c }) => ({ ...c, ...(isCustomCoffee({ whiteLabel, customerOnly }) ? { whiteLabel: true } : {}) }));
  const visible = coffees.filter((c) => canOrder(c, customerId)).map(({ whiteLabel, customerOnly, recipe, ...c }) => ({ ...c, ...(isCustomCoffee({ whiteLabel, customerOnly }) ? { yours: true } : {}) }));
  return [...visible.filter((c) => (c as any).yours), ...visible.filter((c) => !(c as any).yours)];
}
/** Order lines as a customer sees them: without the staff-only recipe. */
export const customerLines = <L extends object>(lines: L[] | undefined): L[] | undefined => lines?.map((line) => { const { recipe, ...rest } = line as L & { recipe?: string }; return rest as L; });
