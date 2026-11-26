/**
 * Equity module worker (W12). Every incoming message cancels the running job; a valid `EquityRequest` then
 * starts a new one (an `EquityCancel` or invalid message starts nothing). Replies are `EquityReply`: a first one
 * at 4,000 iterations, a final one at 20,000. The job waits for a macrotask between chunks so a newer message
 * is processed in time.
 */
import { isValidRequest, runEquityJob, type CancelToken, type EquityReply } from './equityJob.js';

/** The slice of the worker global scope used here (the web app compiles with the DOM lib, not "webworker"). */
interface WorkerScope {
  onmessage: ((e: MessageEvent<unknown>) => void) | null;
  postMessage(message: EquityReply): void;
}

const scope = self as unknown as WorkerScope;
let current: CancelToken | null = null;

scope.onmessage = (e) => {
  if (current) current.cancelled = true;
  current = null;
  const req: unknown = e.data;
  if (!isValidRequest(req)) return;
  const token: CancelToken = { cancelled: false };
  current = token;
  void runEquityJob(req, (reply) => scope.postMessage(reply), token)
    .catch(() => undefined) // validated input does not throw; a failure just means no reply
    .finally(() => {
    if (current === token) current = null;
  });
};
