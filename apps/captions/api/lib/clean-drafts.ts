/** One running draft per upload. A newer request cancels its predecessor and
 * waits only for process exit/cleanup, never for obsolete rendering to finish. */
export interface DraftTicket {
  client: string;
  revision: number;
}
interface Job {
  ticket: DraftTicket;
  controller: AbortController;
  done: Promise<unknown>;
}
const cancelled = () =>
  new DOMException("Replaced by a newer adjustment.", "AbortError");
export class LatestDrafts {
  private jobs = new Map<string, Job>();
  private revisions = new Map<string, { revision: number; expires: number }>();
  private remember(id: string, ticket: DraftTicket) {
    const key = `${id}:${ticket.client}`,
      now = Date.now();
    for (const [key, value] of this.revisions)
      if (value.expires < now) this.revisions.delete(key);
    const previous = this.revisions.get(key)?.revision ?? 0;
    this.revisions.delete(key);
    this.revisions.set(key, {
      revision: Math.max(previous, ticket.revision),
      expires: now + 60 * 60_000,
    });
    while (this.revisions.size > 1024)
      this.revisions.delete(this.revisions.keys().next().value!);
    return previous;
  }
  cancel(id: string, ticket: DraftTicket) {
    // Remember cancellations even if the request has not arrived yet.
    this.remember(id, ticket);
    const job = this.jobs.get(id);
    if (
      job?.ticket.client === ticket.client &&
      job.ticket.revision <= ticket.revision
    )
      job.controller.abort(cancelled());
  }
  async stop(id: string) {
    const job = this.jobs.get(id);
    if (!job) return;
    job.controller.abort(cancelled());
    await job.done.catch(() => undefined);
  }
  async run<T>(
    id: string,
    ticket: DraftTicket,
    signal: AbortSignal,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    signal.throwIfAborted();
    if (this.remember(id, ticket) >= ticket.revision) throw cancelled();
    const previous = this.jobs.get(id);
    previous?.controller.abort(cancelled());
    const controller = new AbortController();
    const abort = () => controller.abort(cancelled());
    signal.addEventListener("abort", abort, { once: true });
    const job: Job = { ticket, controller, done: Promise.resolve() };
    this.jobs.set(id, job);
    job.done = (async () => {
      try {
        await previous?.done.catch(() => undefined);
        controller.signal.throwIfAborted();
        return await work(controller.signal);
      } finally {
        signal.removeEventListener("abort", abort);
        if (this.jobs.get(id) === job) this.jobs.delete(id);
      }
    })();
    return job.done as Promise<T>;
  }
}
