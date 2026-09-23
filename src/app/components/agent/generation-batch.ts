export type BatchGeneration = {
  id: string;
  nodeId: string;
  serviceType: string;
  prompt: string;
  model: string;
};

/** One instance per user turn. Approval never escapes into the next turn.
 * Submission slots end at the durable queue acknowledgement, NOT generation
 * completion. The backend separately limits actual upstream concurrency. */
export class GenerationBatch {
  private requests = new Map<string, BatchGeneration>();
  private seenNodes = new Set<string>();
  private approvals = new Map<string, string>();
  private queue: BatchGeneration[] = [];
  private active = 0;
  private stopped = false;

  constructor(
    private readonly submit: (request: BatchGeneration) => Promise<void>,
    private readonly onError: (request: BatchGeneration, error: unknown) => void,
    private readonly submissionLimit = 3,
  ) {}

  private key(request: BatchGeneration) {
    return JSON.stringify([request.serviceType, request.model]);
  }

  register(request: BatchGeneration, automatic: boolean): 'pending' | 'confirmed' | 'duplicate' {
    if (this.stopped || this.seenNodes.has(request.nodeId)) return 'duplicate';
    this.seenNodes.add(request.nodeId);
    const approved = this.approvals.get(this.key(request));
    if (automatic || approved) {
      this.enqueue({...request, model: approved || request.model});
      return 'confirmed';
    }
    this.requests.set(request.id, request);
    return 'pending';
  }

  approve(id: string, chosenModel: string): BatchGeneration[] {
    const first = this.requests.get(id);
    if (!first || !chosenModel || this.stopped) return [];
    const key = this.key(first);
    this.approvals.set(key, chosenModel);
    const accepted: BatchGeneration[] = [];
    for (const [requestID, request] of this.requests) {
      if (this.key(request) !== key) continue;
      this.requests.delete(requestID);
      const selected = {...request, model: chosenModel};
      accepted.push(selected);
      this.enqueue(selected);
    }
    return accepted;
  }

  approvedModel(request: BatchGeneration): string {
    return this.approvals.get(this.key(request)) || request.model;
  }

  skip(id: string) { this.requests.delete(id); }

  stop() {
    this.stopped = true;
    this.requests.clear();
    this.approvals.clear();
    const cancelled = this.queue.splice(0);
    for (const request of cancelled) this.onError(request, new Error('本轮任务已停止，尚未提交的生成已取消。'));
  }

  private enqueue(request: BatchGeneration) {
    this.queue.push(request);
    this.pump();
  }

  private pump() {
    while (!this.stopped && this.active < this.submissionLimit && this.queue.length) {
      const request = this.queue.shift()!;
      this.active++;
      void Promise.resolve().then(() => {
        if (this.stopped) throw new Error('本轮任务已停止，尚未提交的生成已取消。');
        return this.submit(request);
      })
        .catch(error => this.onError(request, error))
        .finally(() => { this.active--; this.pump(); });
    }
  }
}
