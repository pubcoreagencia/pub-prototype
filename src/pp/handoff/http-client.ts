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
        const timeoutErr = new Error(`PDL_HANDOFF_TIMEOUT: Request to PDL timed out after ${this.timeoutMs}ms`);
        (timeoutErr as any).status = 504;
        throw timeoutErr;
      }
      if (err.message?.startsWith('PDL_HANDOFF_')) {
        throw err;
      }
      const netErr = new Error(`PDL_HANDOFF_FAILED: Network error communicating with PDL API: ${err.message}`);
      (netErr as any).status = 502;
      (netErr as any).cause = err;
      throw netErr;
    } finally {
      clearTimeout(timer);
    }
  }
}

export class FailClosedPdlTaskIngestionPort implements PdlTaskIngestionPort {
  async ingest(_request: PdlTaskIngestionRequest): Promise<PdlTaskIngestionResult> {
    const error = new Error('PDL_HANDOFF_NOT_CONFIGURED: PDL_API_URL environment variable is not set. Standalone PP cannot hand off tasks to PDL.');
    (error as any).status = 503;
    throw error;
  }
}

export class StubPdlTaskIngestionPort implements PdlTaskIngestionPort {
  async ingest(req: PdlTaskIngestionRequest): Promise<PdlTaskIngestionResult> {
    return {
      id: `pdl-promoted-${Date.now()}`,
      taskId: `pdl-promoted-${Date.now()}`,
      status: 'QUEUED',
      branch: req.branch,
      repository: req.repository,
      prototypeSessionId: req.prototypeSessionId,
      note: 'Standalone PP mode: task accepted by boundary stub',
    };
  }
}
