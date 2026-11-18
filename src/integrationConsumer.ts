import { deliverDispatchEmails } from "./email/outbox";
import type { Env } from "./http";
import type { IntegrationSignal } from "./integrationSignals";
import { machineRequest, processEvents } from "./quickbooks/jobs";
import { processExport } from "./quickbooks/ledger";
import { ensureSchema } from "./schema";
import { deliverSlackPosts } from "./slackOrders";

export async function deliverIntegrationBatch(batch: MessageBatch<IntegrationSignal>, env: Env) {
  await ensureSchema(env);
  for (const message of batch.messages) {
    const signal = message.body;
    try {
      switch (batch.queue) {
        case "strangers-dispatch-email":
          await deliverDispatchEmails(env, signal.key);
          break;
        case "strangers-slack-orders":
          await deliverSlackPosts(env, signal.key);
          break;
        case "strangers-quickbooks": {
          const req = machineRequest(env);
          if (signal.exportId !== undefined) await processExport(req, env, signal.exportId);
          else await processEvents(req, env, 3, signal.eventKeys);
          break;
        }
        default:
          throw new Error("Unknown integration queue");
      }
      message.ack();
    } catch (error) {
      console.error("Integration queue processing failed", batch.queue, error);
      message.retry({ delaySeconds: 30 });
    }
  }
}
