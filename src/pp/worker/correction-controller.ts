import type { PrototypeTask } from '../domain/domain.js';
import type { AgentProvider, ProviderTaskResult } from '../../providers/types.js';
import type { PrototypeEventPublisher } from '../events/events.js';
import { TaskFinalizer, type WorkspaceSnapshot } from '../../finalizer.js';

/**
 * Orchestrates in‑process correction attempts when a task finalization fails.
 *
 * Guarantees:
 * - Same task, workspace, leaseOwner, prototypeSessionId, branch are preserved.
 * - Heartbeat continues because the loop `await`s within the existing `executeOnce`.
 * - At most `MAX_CORRECTION_ATTEMPTS` attempts (hard‑coded to 2).
 * - Only the approved failure classifications are handled.
 */
export class CorrectionController {
  /** Hard‑coded maximum correction attempts as per contract */
  static readonly MAX_CORRECTION_ATTEMPTS = 2;

  private attempt = 0;

  constructor(private readonly provider: AgentProvider, private readonly events: PrototypeEventPublisher) {}

  /** Map finalize errorCode to a decision category */
  private classify(errorCode: string | null): 'CORRECTABLE' | 'RETRYABLE' | 'ESCALATE' {
    switch (errorCode) {
      case 'TASK_TESTS_FAILED':
      case 'FAILED_UNEXPECTED_CHANGES':
        return 'CORRECTABLE';
      case 'COMMIT_FAILED':
        // Retryable – we may attempt another correction before escalation.
        return 'RETRYABLE';
      case 'PUSH_FAILED':
        return 'ESCALATE';
      default:
        return 'ESCALATE';
    }
  }

  /** Redact secrets using the same logic as TaskFinalizer */
  private redact(value: string | null | undefined): string | null {
    if (!value) return null;
    let result = value;
    for (const [key, secret] of Object.entries(process.env)) {
      if (
        secret &&
        /(api[_-]?key|token|password|secret|credential|private[_-]?key)/i.test(key) &&
        secret.length >= 4
      ) {
        result = result.split(secret).join('[REDACTED]');
      }
    }
    // Redact Bearer tokens
    result = result.replace(/Bearer [A-Za-z0-9_-]{8,}/g, 'Bearer [REDACTED]');
    return result;
  }

  /**
   * Run the correction loop.
   *
   * @param task The original task (must remain unchanged).
   * @param workspace Path to the workspace where the provider runs.
   * @param baseline Snapshot captured before the first provider execution.
   * @param providerResult Result of the initial provider run (unused except for logging).
   * @param finalizeResult Result of the initial finalizer run that indicated failure.
   * @returns 'SUCCESS' if a correction succeeded, otherwise 'ESCALATED'.
   */
  async runCorrectionLoop(
    task: PrototypeTask | any,
    workspace: string,
    baseline: WorkspaceSnapshot,
    providerResult: ProviderTaskResult,
    finalizeResult: {
      status: 'COMPLETED' | 'FAILED';
      errorCode: string | null;
      errorMessage: string | null;
      testOutput: string;
      gitStatus: string;
      changedFiles: string[];
    },
  ): Promise<'SUCCESS' | 'ESCALATED'> {
    let lastFinalize = finalizeResult;

    while (this.attempt < CorrectionController.MAX_CORRECTION_ATTEMPTS) {
      this.attempt++;
      const attempt = this.attempt;

      // Emit start event with redacted context
      await this.events.emit({
        sessionId: task.prototypeSessionId!,
        type: 'correction_started',
        payload: {
          attempt,
          errorCode: lastFinalize.errorCode,
          errorMessage: this.redact(lastFinalize.errorMessage),
          testOutput: this.redact(lastFinalize.testOutput),
        },
      });

      // Re‑execute the provider (no consumer sink – simple fire‑and‑wait)
      const newProviderResult = await this.provider.execute(task, workspace, {});

      // Re‑run the finalizer with the same baseline snapshot
      const finalizer = new TaskFinalizer(workspace, {
        commandTimeoutMs: Number(process.env.ROUTER_COMMAND_TIMEOUT_MS ?? 60000),
      });
      const newFinalize = await finalizer.finalize(task.objective, task.prompt, {
        testCommand: process.env.TASK_TEST_COMMAND || null,
        commitMessage: `prototype(${task.project}): correction attempt ${attempt}`,
        expectChanges: false,
        allowUnexpectedFiles: false,
        baselineSnapshot: baseline,
        declaredChangedFiles: newProviderResult.changedFiles ?? [],
      });

      if (newFinalize.status === 'COMPLETED') {
        await this.events.emit({
          sessionId: task.prototypeSessionId!,
          type: 'correction_succeeded',
          payload: { attempt, commitSha: newFinalize.commitSha },
        });
        return 'SUCCESS';
      }

      // Determine what to do next based on classification
      const decision = this.classify(newFinalize.errorCode);

      if ((decision === 'CORRECTABLE' || decision === 'RETRYABLE') && this.attempt < CorrectionController.MAX_CORRECTION_ATTEMPTS) {
        // Emit a failed‑attempt event and continue the loop
        await this.events.emit({
          sessionId: task.prototypeSessionId!,
          type: 'correction_failed',
          payload: {
            attempt,
            errorCode: newFinalize.errorCode,
            errorMessage: this.redact(newFinalize.errorMessage),
          },
        });
        lastFinalize = {
          status: newFinalize.status,
          errorCode: newFinalize.errorCode,
          errorMessage: newFinalize.errorMessage,
          testOutput: newFinalize.testOutput,
          gitStatus: newFinalize.gitStatus,
          changedFiles: newFinalize.changedFiles,
        };
        // loop continues for another attempt
        continue;
      }

      // Escalation path (no more attempts or non‑correctable error)
      await this.events.emit({
        sessionId: task.prototypeSessionId!,
        type: 'correction_escalated',
        payload: {
          attempt,
          errorCode: newFinalize.errorCode,
          errorMessage: this.redact(newFinalize.errorMessage),
        },
      });
      return 'ESCALATED';
    }

    // Exhausted attempts – final escalation
    await this.events.emit({
      sessionId: task.prototypeSessionId!,
      type: 'correction_escalated',
      payload: {
        attempt: this.attempt,
        errorCode: lastFinalize.errorCode,
        errorMessage: this.redact(lastFinalize.errorMessage),
      },
    });
    return 'ESCALATED';
  }
}
