/** Queues carry wake-up signals. Delivery and retries are still recorded in D1. */
export interface IntegrationSignal {
  key?: string;
  exportId?: number;
  eventKeys?: string[];
}

export async function wakeIntegration(
  queue: Queue<IntegrationSignal> | undefined, signal: IntegrationSignal, fallback: () => Promise<unknown>,
) {
  if (queue) {
    try {
      await queue.send(signal);
      return;
    } catch (error) {
      console.warn("Integration wake-up failed; checking the durable work directly", error);
    }
  }
  await fallback();
}
