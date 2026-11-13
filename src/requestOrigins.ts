// Cross-app requests are limited to the configured staff apps, never arbitrary sibling hosts.
import type {Env} from './http';

export function trustedOrigin(origin:string|null,url:URL,env:Pick<Env,'COOKIE_DOMAIN'|'ADMIN_HOST'|'ROTA_HOST'|'LEGACY_PREVIEW_HOST'>):boolean {
  if(!origin)return false;
  let source:URL;
  try{source=new URL(origin)}catch{return false}
  if(source.origin!==origin)return false; // No credentials, paths, queries or alternate origin spellings.
  if(source.origin===url.origin)return true;
  if(source.protocol!=='https:'||source.port)return false;
  const root=(env.COOKIE_DOMAIN||'').toLowerCase().replace(/^\./,'');
  if(!root)return false;
  const hosts=new Set([root,env.ADMIN_HOST,env.ROTA_HOST,env.LEGACY_PREVIEW_HOST].filter((v):v is string=>!!v).map(v=>v.toLowerCase()));
  return hosts.has(url.hostname.toLowerCase())&&hosts.has(source.hostname.toLowerCase());
}
