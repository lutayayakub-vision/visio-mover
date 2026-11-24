/** Small worker pool: N workers, one task at a time each, queued; terminateAll() kills every worker at once (reliable cancel). */
export class PoolError extends Error {
  code: string; details?: unknown;
  constructor(code: string, message: string, details?: unknown) { super(message); this.name = "PoolError"; this.code = code; this.details = details; }
}
type Reply = { type: string; fraction?: number; label?: string; code?: string; message?: string; details?: unknown };
type Job = { msg: unknown; transfer: Transferable[]; resolve: (v: any) => void; reject: (e: Error) => void; onProgress?: (f: number, l: string) => void };
type Slot = { worker: Worker; busy: Job | null };

export class WorkerPool {
  private slots: Slot[] = []; private queue: Job[] = []; private dead = false; private spawned = 0;
  constructor(private factory: () => Worker, readonly size: number) {}
  /** workers currently alive (0 after terminateAll) */
  get alive() { return this.slots.length; }
  get busyCount() { return this.slots.filter((s) => s.busy).length; }
  get terminated() { return this.dead; }
  get totalSpawned() { return this.spawned; }

  run<T>(msg: unknown, transfer: Transferable[] = [], onProgress?: (f: number, l: string) => void): Promise<T> {
    if (this.dead) return Promise.reject(new PoolError("cancelled", "Cancelled."));
    return new Promise<T>((resolve, reject) => { this.queue.push({ msg, transfer, resolve, reject, onProgress }); this.pump(); });
  }
  private pump() {
    while (this.queue.length && !this.dead) {
      let slot = this.slots.find((s) => !s.busy);
      if (!slot && this.slots.length < this.size) {
        const worker = this.factory(); this.spawned++;
        slot = { worker, busy: null }; this.slots.push(slot);
        const s = slot;
        worker.onmessage = (e: MessageEvent<Reply>) => {
          const r = e.data, job = s.busy; if (!job) return;
          if (r.type === "progress") { job.onProgress?.(r.fraction ?? 0, r.label ?? ""); return; }
          s.busy = null;
          if (r.type === "error") job.reject(new PoolError(r.code ?? "failed", r.message ?? "Failed.", r.details)); else job.resolve(r);
          this.pump();
        };
        worker.onerror = (ev) => { const job = s.busy; s.busy = null; job?.reject(new PoolError("failed", ev.message || "A worker crashed.")); this.pump(); };
      }
      if (!slot) return;
      const job = this.queue.shift()!; slot.busy = job;
      slot.worker.postMessage(job.msg, job.transfer);
    }
  }
  /** Kills every worker immediately and rejects everything running or queued. Safe to call twice. */
  terminateAll() {
    this.dead = true;
    for (const s of this.slots) { s.worker.terminate(); s.busy?.reject(new PoolError("cancelled", "Cancelled.")); }
    for (const j of this.queue) j.reject(new PoolError("cancelled", "Cancelled."));
    this.slots = []; this.queue = [];
  }
}
