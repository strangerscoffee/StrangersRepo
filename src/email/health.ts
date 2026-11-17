// Read-only setup and public DNS checks. Provider credentials never leave the Worker.
import { cleanEmail, senderAddress } from "./address";
import { orderSender } from "./sender";
import type { Env } from "../http";
export function emailSetup(env: Env, requestUrl: string) {
  const senders = [orderSender(env), env.EMAIL_FROM || "Strangers Rota <rota@staffstrangerscoffee.com>"];
  const domains = [...new Set(senders.map(senderAddress).filter(Boolean).map(email=>email!.split("@")[1]))];
  const reportTo = cleanEmail(env.EMAIL_DMARC_REPORT_TO || "sales@strangerscoffee.com");
  return {
    senders,reportTo,webhookUrl:new URL("/api/email/resend-webhook",env.ADMIN_HOST ? `https://${env.ADMIN_HOST}/` : requestUrl).href,
    webhookSecretName:"RESEND_WEBHOOK_SECRET",
    events:["email.sent","email.delivered","email.delivery_delayed","email.bounced","email.complained","email.failed","email.suppressed","suppression.added","suppression.removed"],
    records:domains.flatMap(domain=>[
      {name:"_dmarc."+domain,type:"TXT",value:`v=DMARC1; p=none;${reportTo ? ` rua=mailto:${reportTo};` : ""}`},
      ...(reportTo && !domain.endsWith("."+reportTo.split("@")[1]) && domain!==reportTo.split("@")[1] ? [{name:domain+"._report._dmarc."+reportTo.split("@")[1],type:"TXT",value:"v=DMARC1;"}] : []),
    ]),domains,
  };
}
async function txt(name: string, fetcher: typeof fetch) {
  try {
    const response = await fetcher("https://cloudflare-dns.com/dns-query?"+new URLSearchParams({name,type:"TXT"}),{headers:{accept:"application/dns-json"},signal:AbortSignal.timeout(5000)});
    if (!response.ok) return null;
    const bytes = await response.text();if(bytes.length>65536)return null;
    const data=JSON.parse(bytes);if(![0,3].includes(data.Status))return null;
    return (Array.isArray(data.Answer)?data.Answer:[]).filter((row:any)=>row.type===16&&typeof row.data==="string").slice(0,20).map((row:any)=>row.data.replace(/"\s*"/g,"").replace(/^"|"$/g,"")) as string[];
  } catch { return null; }
}
export async function emailDns(env: Env, requestUrl: string, fetcher: typeof fetch = fetch) {
  const setup=emailSetup(env,requestUrl);
  return {checkedAt:Date.now(),domains:await Promise.all(setup.domains.map(async domain=>{
    const [dmarc,dkim,spf]=await Promise.all([txt("_dmarc."+domain,fetcher),txt("resend._domainkey."+domain,fetcher),txt("send."+domain,fetcher)]);
    const policies=dmarc?.filter(value=>/^v=DMARC1(?:;|$)/i.test(value));
    return {domain,dmarc:dmarc===null?"unavailable":!policies?.length?"missing":policies.length!==1||!/(?:^|;)\s*p=(?:none|quarantine|reject)\s*(?:;|$)/i.test(policies[0])?"invalid":"published",dkim:dkim===null?"unavailable":dkim.some(value=>/(?:^|;)\s*p=\S+/.test(value))?"published":"not_found",bounceSpf:spf===null?"unavailable":spf.some(value=>/^v=spf1\s/.test(value))?"published":"not_found"};
  }))};
}
