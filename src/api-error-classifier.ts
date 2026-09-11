// src/api-error-classifier.ts
// Menor correção (P0 audit 400): classificar 400 capability vs payload.
export interface ClassificationResult {
  retryable: boolean;
  shouldFallback: boolean;
  reason: string;
}

/**
 * Classifica erro OpenRouter 400.
 * Regra: se a resposta contém indício de 'tool message unsupported',
 * trata como CAPABILITY_ERROR (fallback), não PAYLOAD_ERROR (abort).
 */
export function classifyApiError(
  status: number,
  message?: string,
  providerName?: string,
  hasToolMessageInPayload?: boolean,
): ClassificationResult {
  // Padrão: 4xx = não-retry, não-fallback (payload ruim)
  let retryable = false;
  let shouldFallback = false;
  let reason = `HTTP ${status}`;

  if (status >= 500) {
    retryable = true;
    shouldFallback = true;
    reason = `server_error`;
  } else if (status === 429) {
    retryable = true;
    shouldFallback = false;
    reason = `rate_limited`;
  } else if (status === 400) {
    const msgLower = (message || '').toLowerCase();
    const isNvidia = providerName === 'Nvidia';
    const isToolMessageSchemaError =
      msgLower.includes('chatcompletionrequesttoolmessagecontent') ||
      msgLower.includes('untagged enum') ||
      msgLower.includes('tool message') ||
      msgLower.includes('variant of untagged');
    const capabilityMismatch = isNvidia && hasToolMessageInPayload;

    if (isToolMessageSchemaError || capabilityMismatch) {
      retryable = false; // não reenviar o MESMO payload
      shouldFallback = true; // outro provider pode aceitar
      reason = `capability_error: ${isNvidia ? 'Nvidia' : 'unknown'} tool-message unsupported (400 schema mismatch)`;
    } else {
      retryable = false;
      shouldFallback = false;
      reason = `payload_error: ${message || 'bad request'}`;
    }
  } else {
    retryable = false;
    shouldFallback = false;
    reason = `client_error_${status}`;
  }
  return { retryable, shouldFallback, reason };
}
