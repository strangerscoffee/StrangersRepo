// Parcel estimates are shared with the classic scripts on the Admin and Staff packing desks.
export {};
declare global {
  var SCWholesalePreparation: Readonly<{
    royalMailTrackingNumber(value: unknown): string | null;
    royalMailTrackingV2Number(value: unknown): string | null;
    royalMailTrackingUrl(value: unknown): string | null;
    numberFromRoyalMailLink(value: unknown): string | null;
    isRoyalMailTrackingHost(hostname: unknown): boolean;
    tooHeavyForOneParcel(order: { grams: number; lines?: readonly { grams: number; quantity: number; pack: string }[] }): boolean;
  }>;
}
