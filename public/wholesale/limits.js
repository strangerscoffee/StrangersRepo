// Bags of one coffee, size and grind a customer can order in one go (typed in, or with + and −). Shared by the
// server, invoices, the QuickBooks preview and the ordering page.
export const MAX_QUANTITY = 999;

// The smallest order, by weight of coffee (any mix of 250 g and 1 kg bags and coffees): 6 kg. Admin can exempt a
// business ("No minimum order" on its customer profile); customers never see the exemption, only whether a minimum
// applies to them.
export const MINIMUM_ORDER_GRAMS = 6000;
