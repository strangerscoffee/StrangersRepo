// Delivery charges on wholesale orders, shared by the server (which charges it) and the ordering page (which shows it).
// Sent orders under £250 of coffee pay a flat £7.44 including VAT; £250 or more is free; roastery collection is free.
// Each order keeps the charge it was placed with (deliveryPence), so changing these never changes a past order.
export const SHIPPING_PENCE = 744; // including VAT
export const FREE_SHIPPING_FROM_PENCE = 25000;
export const shippingFor = (delivery, coffeePence) => delivery === "Delivery" && coffeePence < FREE_SHIPPING_FROM_PENCE ? SHIPPING_PENCE : 0;
