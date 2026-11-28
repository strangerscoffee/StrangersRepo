// Parcel estimates are shared with the classic scripts on the Admin and Staff packing desks.
export {};
declare global {
  var SCWholesalePreparation: Readonly<{
    royalMailRecoverySchedule(recovery: { status: string; nextCheckAt?: number | null; lastCheckedAt?: number | null } | null, formatDate: (time: number) => string): string;
    royalMailTrackingNumber(value: unknown): string | null;
    royalMailTrackingV2Number(value: unknown): string | null;
    royalMailTrackingUrl(value: unknown): string | null;
    numberFromRoyalMailLink(value: unknown): string | null;
    isRoyalMailTrackingHost(hostname: unknown): boolean;
    tooHeavyForOneParcel(order: { grams: number; lines?: readonly { grams: number; quantity: number; pack: string }[] }): boolean;
  }>;
}
