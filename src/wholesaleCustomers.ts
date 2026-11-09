// Saved locations live inside the existing versioned customer JSON record.
import type { Customer } from "./wholesaleAccounts";
import { invalid } from "./http";
import { object, text } from "./wholesaleStore";

export interface CustomerLocation {
  id: string; name: string; contact: string; phone: string;
  address: string; postcode: string; deliveryNotes: string;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const validLocationId = (id: string) => id === "primary" || UUID.test(id);

export function customerLocations(customer: Customer): CustomerLocation[] {
  const saved = Array.isArray(customer.locations) ? customer.locations : [];
  const primary = saved.find((location) => location.id === "primary");
  return [{ id: "primary", name: primary?.name || "Main location", contact: customer.contact || "", phone: customer.phone || "", address: customer.address || "", postcode: customer.postcode || "", deliveryNotes: customer.deliveryNotes || "" }, ...saved.filter((location) => location.id !== "primary").map((location) => ({ ...location }))];
}

export function locationDefaults<T extends Customer>(customer: T) {
  const locations = customerLocations(customer);
  const defaultLocationId = locations.some((location) => location.id === customer.defaultLocationId) ? customer.defaultLocationId! : "primary";
  return { ...customer, locations, defaultLocationId };
}

/** Explicit location arrays replace the address book; older clients may keep editing the flat primary fields. */
export function editedCustomerLocations(customer: Customer, body: Record<string, any>): Customer {
  let locations = customerLocations(customer);
  if (body.locations !== undefined) {
    if (!Array.isArray(body.locations) || body.locations.length < 1 || body.locations.length > 20) throw invalid("Keep between one and 20 business locations, including the main location.");
    const owned = new Set(locations.map((location) => location.id));
    const ids = new Set<string>();
    locations = body.locations.map((value: unknown): CustomerLocation => {
      const location = object(value);
      const id = location.id === undefined ? crypto.randomUUID() : text(location.id, "location ID", 36, true);
      if (!validLocationId(id) || (location.id !== undefined && !owned.has(id))) throw invalid("Choose a location saved to this business, or add a new location without an ID.");
      if (ids.has(id)) throw invalid("Each saved location must have its own ID.");
      ids.add(id);
      return { id, name: text(location.name, "location name", 80, true), contact: text(location.contact, "location contact", 120), phone: text(location.phone, "location phone", 40), address: text(location.address, "location address", 500), postcode: text(location.postcode, "location postcode", 20), deliveryNotes: text(location.deliveryNotes, "location delivery notes", 1000) };
    });
    const primary = locations.find((location) => location.id === "primary");
    if (!primary) throw invalid("Keep the main location. You can rename or edit its address.");
    locations = [primary, ...locations.filter((location) => location.id !== "primary")];
  }
  let defaultLocationId = body.defaultLocationId === undefined ? customer.defaultLocationId || "primary" : text(body.defaultLocationId, "default location", 36, true);
  if (!locations.some((location) => location.id === defaultLocationId)) {
    if (body.defaultLocationId !== undefined) throw invalid("Choose a default location saved to this business.");
    defaultLocationId = "primary";
  }
  const primary = locations[0];
  return { ...customer, contact: primary.contact, phone: primary.phone, address: primary.address, postcode: primary.postcode, deliveryNotes: primary.deliveryNotes, locations, defaultLocationId };
}
