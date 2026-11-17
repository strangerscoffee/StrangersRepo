const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[A-Za-z]{2,}$/;
/** A cleaned email address, empty to remove it, or null if invalid. */
export function cleanEmail(value: unknown): string | null {
  if (value === null || value === "") return "";
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email === "" ? "" : email.length <= 254 && EMAIL_RE.test(email) ? email : null;
}
export function senderAddress(value: string): string | null {
  return cleanEmail(value.match(/<([^<>]+)>\s*$/)?.[1] || value);
}
