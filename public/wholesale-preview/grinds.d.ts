export interface GrindOption { id: string; label: string; enabled: boolean }
export const defaultGrinds: GrindOption[];
export function validGrindId(id: unknown): boolean;
export function grindOptions(product?: { grindOptions?: GrindOption[] }): GrindOption[];
export function availableGrinds(product?: { grindOptions?: GrindOption[] }): GrindOption[];
export function grindLabel(product: { grindOptions?: GrindOption[] } | undefined, id: string): string;
export function isGrindAvailable(product: { grindOptions?: GrindOption[] } | undefined, id: string): boolean;
