// This capability grants only the dedicated, read-only wholesale order projection.
import type { User } from "./auth";
import { audit } from "./audit";
import { ApiError, type Env, invalid, json, readJson } from "./http";
import { version } from "./wholesaleStore";

export async function canViewStaffOrders(env: Env, user: User): Promise<boolean> {
  if (user.role === "admin") return true;
  const row=await env.DB.prepare("SELECT enabled FROM staff_order_access WHERE user_id=?").bind(user.id).first<{enabled:number}>();
  return row?.enabled===1;
}
export async function requireStaffOrders(env: Env, user: User): Promise<void> {
  if (!(await canViewStaffOrders(env,user))) throw new ApiError(403,"permission_denied","An admin needs to give you access to wholesale orders.");
}
export async function handleStaffOrderAccess(req: Request, env: Env, userId: string, actor: User): Promise<Response> {
  if(actor.role!=="admin")throw new ApiError(403,"permission_denied","Only admins can manage order dashboard access.");
  const target=await env.DB.prepare("SELECT id,name,role FROM users WHERE id=?").bind(userId).first<{id:string;name:string;role:string}>();
  if(!target)throw new ApiError(404,"not_found","No such person.");
  const current=await env.DB.prepare("SELECT enabled,version FROM staff_order_access WHERE user_id=?").bind(userId).first<{enabled:number;version:number}>();
  if(req.method==="GET")return json({userId,enabled:target.role==="admin"||current?.enabled===1,version:current?.version||0,inherited:target.role==="admin"});
  if(req.method!=="PUT")return json({code:"method_not_allowed",message:"Use GET or PUT for dashboard access."},405,{Allow:"GET, PUT"});
  if(target.role==="admin")throw invalid("Admins already have access through their role.");
  const body=await readJson<{enabled?:unknown;ifVersion?:unknown}>(req,2048),expected=version(body.ifVersion);
  if(typeof body.enabled!=="boolean")throw invalid("Choose whether this person can view wholesale orders.");
  const enabled=body.enabled?1:0,at=Date.now();
  const result=expected===0
    ?await env.DB.prepare("INSERT INTO staff_order_access(user_id,enabled,version,updated_at,updated_by) VALUES(?,?,1,?,?) ON CONFLICT(user_id) DO NOTHING").bind(userId,enabled,at,actor.id).run()
    :await env.DB.prepare("UPDATE staff_order_access SET enabled=?,version=version+1,updated_at=?,updated_by=? WHERE user_id=? AND version=?").bind(enabled,at,actor.id,userId,expected).run();
  if(!result.meta.changes)throw new ApiError(409,"conflict","This person's order access changed. Reload before saving.");
  await audit(env,"staff_orders_access",actor.name,`${actor.name} ${enabled?"enabled":"disabled"} read-only wholesale orders for ${target.name}`);
  return json({userId,enabled:!!enabled,version:expected+1,inherited:false});
}
