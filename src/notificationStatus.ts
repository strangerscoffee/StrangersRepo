import type { Env } from "./http";

export async function notificationStatus(env: Env) {
  const [email, slack, legacy] = await Promise.all([
    env.DB.prepare("SELECT state,COUNT(*) AS n FROM wholesale_email_outbox WHERE state<>'sent' GROUP BY state").all<{state:string;n:number}>(),
    env.DB.prepare("SELECT COALESCE(d.state,'queued') AS state,COUNT(*) AS n FROM slack_order_posts p LEFT JOIN slack_order_delivery d ON d.order_id=p.order_id WHERE p.sent_at IS NULL GROUP BY COALESCE(d.state,'queued')").all<{state:string;n:number}>(),
    env.DB.prepare("SELECT p.id,json_extract(p.data,'$.business') AS business FROM wholesale_preview p WHERE p.kind='order' AND json_extract(p.data,'$.preview')=0 AND json_extract(p.data,'$.deletedAt') IS NULL AND json_extract(p.data,'$.status')='Dispatched' AND json_extract(p.data,'$.dispatchEmailedAt') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM wholesale_email_outbox o WHERE o.order_id=p.id) AND EXISTS(SELECT 1 FROM audit_log a WHERE a.kind='email_failed' AND a.at>=json_extract(p.data,'$.dispatchEmailedAt') AND (instr(a.text,'shipped email for '||p.id)>0 OR instr(a.text,'collected email for '||p.id)>0) AND NOT EXISTS(SELECT 1 FROM audit_log s WHERE s.kind='email_sent' AND s.at>=a.at AND (instr(s.text,'shipped email for '||p.id)>0 OR instr(s.text,'collected email for '||p.id)>0))) ORDER BY p.updated_at DESC LIMIT 20").all<{id:string;business:string}>(),
  ]);
  const counts = (rows: {state:string;n:number}[]) => rows.reduce((out, row) => {
    if (row.state === "unknown") out.unknown += row.n;
    else if (row.state === "failed" || row.state === "retry") out.failed += row.n;
    else out.pending += row.n;
    return out;
  }, { pending: 0, failed: 0, unknown: 0 });
  return { email: counts(email.results), slack: counts(slack.results), legacyDispatch: legacy.results };
}
