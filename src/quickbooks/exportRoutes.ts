import type {User} from '../auth';
import {audit} from '../audit';
import {ApiError,type Env,invalid,json,readJson} from '../http';
import {object} from '../wholesaleStore';
import type {Environment} from './preview';
import {adoptExisting,exportList,operation,operationResult,processExport,queueInvoice,retryExport} from './ledger';
import {refreshObservation} from './observations';
export async function handleExportRoutes(req:Request,env:Env,action:string,mode:Environment,user:User,ctx?:ExecutionContext):Promise<Response|null>{
  const url=new URL(req.url);
  if(action==='/exports'&&req.method==='GET'){
    const invoice=url.searchParams.get('invoiceId'),invoiceId=invoice?Number(invoice):undefined;if(invoiceId!==undefined&&(!Number.isSafeInteger(invoiceId)||invoiceId<1))throw invalid('Choose a valid invoice.');
    const rawCursor=url.searchParams.get('cursor'),cursor=rawCursor?Number(rawCursor):undefined;
    if(cursor!==undefined&&(!/^\d+$/.test(rawCursor!)||!Number.isSafeInteger(cursor)||cursor<1))throw invalid('Choose a valid export page.');
    return json(await exportList(env,mode,invoiceId,cursor));
  }
  const send=/^\/invoices\/(\d+)\/export$/.exec(action);
  if(send&&req.method==='POST'){
    const row=await queueInvoice(req,env,mode,Number(send[1]),object(await readJson(req,8192)),user);
    // The browser starts processing in a separate invocation after this durable acknowledgement.
    // Scheduled recovery also picks it up if that follow-up request never arrives.
    return json({export:await operationResult(env,await operation(env,row.id))},row.state==='linked'?200:202);
  }
  const found=/^\/exports\/(\d+)(?:\/(retry|refresh|link-existing|review|process))?$/.exec(action);if(!found)return null;
  const id=Number(found[1]);if(!Number.isSafeInteger(id)||id<1)throw invalid('Choose a valid export.');
  const saved=await operation(env,id);if(saved.environment!==mode)throw new ApiError(404,'not_found','QuickBooks export not found in this environment.');
  if(!found[2]&&req.method==='GET')return json({export:await operationResult(env,saved)});
  if(found[2]==='review'&&req.method==='GET')return json({export:await operationResult(env,saved),preview:JSON.parse(saved.preview)});
  if(found[2]==='process'&&req.method==='POST'){
    await readJson(req,4096);if(ctx)ctx.waitUntil(processExport(req,env,id));else await processExport(req,env,id);
    return json({export:await operationResult(env,await operation(env,id))},202);
  }
  if(found[2]==='retry'&&req.method==='POST'){
    const row=await retryExport(req,env,id,object(await readJson(req,4096)),user);return json({export:await operationResult(env,row)},202);
  }
  if(found[2]==='refresh'&&req.method==='POST'){
    await readJson(req,4096);await refreshObservation(req,env,saved);return json({export:await operationResult(env,await operation(env,id))});
  }
  if(found[2]==='link-existing'&&req.method==='POST'){
    const row=await adoptExisting(req,env,id,object(await readJson(req,4096)),user);return json({export:await operationResult(env,row)});
  }
  return null;
}
