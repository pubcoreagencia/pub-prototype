import type {
  PdlTaskIngestionPort,
  PdlTaskIngestionRequest,
  PdlTaskIngestionResult,
} from './handoff.js';

export interface HttpPdlTaskIngestionClientOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
  fetchFn?: typeof fetch;
}

export class HttpPdlTaskIngestionPort implements PdlTaskIngestionPort {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly headers: Record<string, string>;
  private readonly fetchFn: typeof fetch;

  constructor(
    baseUrl: string,
    options: HttpPdlTaskIngestionClientOptions = {},
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 10000;
    this.headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(options.headers ?? {}),
    };
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  async ingest(request: PdlTaskIngestionRequest): Promise<PdlTaskIngestionResult> {
    const url = `${this.baseUrl}/tasks/ingest`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchFn(url, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      const text = await response.text();
      let data: any;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { raw: text };
      }

      if (!response.ok) {
        const errorMsg = data?.error || data?.message || `PDL returned HTTP ${response.status}`;
        const error = new Error(`PDL_HANDOFF_FAILED: ${errorMsg}`);
        (error as any).status = response.status;
        (error as any).details = data;
        throw error;
      }

      return data as PdlTaskIngestionResult;
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new Error(`PDL_HANDOFF_TIMEOUT: Request to PDL timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
