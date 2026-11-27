// Parcel estimates are shared with the classic scripts on the Admin and Staff packing desks.
export {};
declare global {
  var SCWholesalePreparation: Readonly<{
    tooHeavyForOneParcel(order: { grams: number; lines?: readonly { grams: number; quantity: number; pack: string }[] }): boolean;
  }>;
}
