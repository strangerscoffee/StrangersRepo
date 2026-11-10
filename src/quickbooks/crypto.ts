// Credentials use authenticated encryption and a Cloudflare secret, never the session signing key.
const enc = new TextEncoder(), dec = new TextDecoder();
export const digest = async (value: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(value)))].map(byte => byte.toString(16).padStart(2,"0")).join("");
const base64 = (value: Uint8Array) => btoa(String.fromCharCode(...value));
export function keyBytes(value: string): Uint8Array {
  const bytes = Uint8Array.from(atob(value.replace(/-/g,"+").replace(/_/g,"/")), char=>char.charCodeAt(0));
  if (bytes.length !== 32) throw new Error("Invalid encryption key configuration.");
  return bytes;
}
const aad = (realm: string, generation: string) => enc.encode(JSON.stringify(["quickbooks-sandbox-v1",realm,generation]));
export async function seal(value: unknown, secret: string, realm: string, generation: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw",keyBytes(secret),"AES-GCM",false,["encrypt"]), iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({name:"AES-GCM",iv,additionalData:aad(realm,generation)},key,enc.encode(JSON.stringify(value)));
  return JSON.stringify({v:1,iv:base64(iv),cipher:base64(new Uint8Array(cipher))});
}
export async function unseal<T>(value: string, secret: string, realm: string, generation: string): Promise<T> {
  const data=JSON.parse(value); if(data.v!==1) throw new Error("Unsupported credential version.");
  const bytes=(s:string)=>Uint8Array.from(atob(s),char=>char.charCodeAt(0)), key=await crypto.subtle.importKey("raw",keyBytes(secret),"AES-GCM",false,["decrypt"]);
  return JSON.parse(dec.decode(await crypto.subtle.decrypt({name:"AES-GCM",iv:bytes(data.iv),additionalData:aad(realm,generation)},key,bytes(data.cipher))));
}
