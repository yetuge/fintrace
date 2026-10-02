export function assertPayloadLimit(payload: unknown, cap: number) {
  const body = payload as { max_tokens?: number; thinking?: { type?: string } };
  if (
    body.max_tokens !== cap ||
    (body.thinking && body.thinking.type !== 'disabled')
  )
    throw new Error('BENCHMARK_UNSUPPORTED_TOKEN_BOUNDARY');
}
/** Reserve the maximum before dispatch. Unknown usage keeps the reservation. */
export class RequestBudget {
  requests = 0;
  chargedOutput = 0;
  output = 0;
  input = 0;
  cacheRead = 0;
  cacheWrite = 0;
  unavailable = false;
  private reserved = 0;
  constructor(
    readonly requestLimit = 24,
    readonly outputLimit = 18_000,
    readonly perRequest = 1_600,
  ) {}
  beforeRequest() {
    if (
      this.requests >= this.requestLimit ||
      this.chargedOutput >= this.outputLimit
    )
      throw new Error('BENCHMARK_BUDGET_EXHAUSTED');
    this.reserved = Math.min(
      this.perRequest,
      this.outputLimit - this.chargedOutput,
    );
    this.chargedOutput += this.reserved;
    this.requests++;
    return { maxOutputTokens: this.reserved };
  }
  onMessage(message: unknown) {
    const u = (message as { usage?: Record<string, unknown> }).usage;
    if (
      u &&
      ['input', 'output', 'cacheRead', 'cacheWrite'].every(
        (k) =>
          typeof u[k] === 'number' &&
          Number.isFinite(u[k]) &&
          (u[k] as number) >= 0,
      )
    ) {
      this.input += u.input as number;
      this.output += u.output as number;
      this.cacheRead += u.cacheRead as number;
      this.cacheWrite += u.cacheWrite as number;
      // Zero usage on an error is not proof that the upstream consumed nothing.
      if (
        (message as { stopReason?: string }).stopReason !== 'error' &&
        (message as { stopReason?: string }).stopReason !== 'aborted'
      )
        this.chargedOutput += (u.output as number) - this.reserved;
      else this.unavailable = true;
    } else this.unavailable = true;
    this.reserved = 0;
  }
  get exhausted() {
    return (
      this.requests >= this.requestLimit ||
      this.chargedOutput >= this.outputLimit
    );
  }
}
