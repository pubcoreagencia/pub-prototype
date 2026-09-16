import { randomUUID } from 'node:crypto';
import type {
  PrototypeTask,
  PrototypeSession,
  PrototypeCheckpoint,
  PrototypeVerification,
  PrototypeCorrectionAttempt,
  CheckpointFile,
} from '../domain/domain.js';
import type { PrototypeRepository } from '../persistence/repository.js';
import type { AgentProvider, ProviderTaskInput } from '../../providers/types.js';
import type { PrototypeEventPublisher } from '../events/events.js';
import { VerificationGate } from '../verification/verification-gate.js';
import { TaskFinalizer, captureWorkspaceSnapshot } from '../../finalizer.js';
import { extractWorkspaceFiles } from './prototype-worker.js';

export interface VerificationRecoveryOptions {
  maxAttempts?: number;
  previewUrl?: string;
  previewRuntime?: string;
  expectedCurrentSha?: string | null;
}

export interface VerificationRecoveryResult {
  status: 'SUCCESS' | 'RETRY_EXHAUSTED' | 'FAILED' | 'CONCURRENCY_CONFLICT';
  lastCheckpoint?: PrototypeCheckpoint;
  lastVerification?: PrototypeVerification;
  attempt?: PrototypeCorrectionAttempt;
  error?: string;
}

export class VerificationRecoveryOrchestrator {
  static readonly MAX_VERIFICATION_CORRECTION_ATTEMPTS = 2;

  constructor(
    private readonly repository: PrototypeRepository,
    private readonly provider: AgentProvider,
    private readonly events: PrototypeEventPublisher,
  ) {}

  /**
   * Builds targeted instructions summarizing the verification failure evidence
   */
  private formatRecoveryPrompt(
    originalPrompt: string,
    verification: PrototypeVerification,
    attemptNumber: number
  ): string {
    const errorType = verification.evidence.error_type || 'UNKNOWN_VERIFICATION_FAILURE';
    const errorSummary = verification.evidence.error_summary || 'Verification gate failed';
    const failedSteps = (verification.evidence.steps || []).filter(s => s.status === 'FAIL');

    let stepDetails = '';
    for (const step of failedSteps) {
      stepDetails += `\n- Step [${step.name}]: ${step.error_summary || step.error_type || 'Failed'}`;
      if (step.stderr) {
        stepDetails += `\n  Stderr: ${step.stderr.slice(0, 1000)}`;
      }
      if (step.stdout) {
        stepDetails += `\n  Stdout: ${step.stdout.slice(0, 500)}`;
      }
      if (step.details) {
        stepDetails += `\n  Details: ${JSON.stringify(step.details)}`;
      }
    }

    return [
      `[VERIFICATION RECOVERY ATTEMPT #${attemptNumber}]`,
      `The previous implementation failed authoritative verification gate checks with status ${errorType}: ${errorSummary}.`,
      stepDetails ? `Failure breakdown:${stepDetails}` : '',
      `Original objective: ${originalPrompt}`,
      `Please analyze the verification failures and fix the code in the workspace so that all verification gates (V0..V5) pass completely.`,
      `Ensure that index.html and all referenced scripts or styles are intact, non-empty, and valid.`,
    ].filter(Boolean).join('\n\n');
  }

  /**
   * Runs the bounded verification recovery loop.
   *
   * Invariants:
   * 1. Checkpoint A remains intact.
   * 2. Verification V(A) remains immutable.
   * 3. CorrectionAttempt is persisted in Postgres with unique (source_verification_id, attempt_number).
   * 4. A NEW checkpoint B is created for the correction commit.
   * 5. VerificationGate.verify() evaluates checkpoint B.
   * 6. VerificationGate.promoteIfValid() is the SOLE authority to transition session to READY.
   * 7. Concurrency conflict or exhaustion preserves previous healthy checkpoint.
   */
  async runRecoveryLoop(
    session: PrototypeSession,
    task: PrototypeTask,
    sourceCheckpoint: PrototypeCheckpoint,
    sourceVerification: PrototypeVerification,
    workspace: string,
    options?: VerificationRecoveryOptions
  ): Promise<VerificationRecoveryResult> {
    const maxAttempts = options?.maxAttempts ?? VerificationRecoveryOrchestrator.MAX_VERIFICATION_CORRECTION_ATTEMPTS;

    // Check existing persisted attempts for this source verification
    const existingAttempts = await this.repository.getCorrectionAttemptsForVerification(sourceVerification.id);
    let attemptNumber = existingAttempts.length + 1;

    let currentCheckpoint = sourceCheckpoint;
    let currentVerification = sourceVerification;

    await this.events.emit({
      sessionId: session.id,
      type: 'verification_recovery_started',
      payload: {
        sessionId: session.id,
        taskId: task.id,
        sourceVerificationId: sourceVerification.id,
        sourceCheckpointId: sourceCheckpoint.id,
        maxAttempts,
      },
    });

    while (attemptNumber <= maxAttempts) {
      // 1. Atomically register / claim this correction attempt
      const attempt = await this.repository.createCorrectionAttempt({
        sessionId: session.id,
        taskId: task.id,
        sourceVerificationId: sourceVerification.id,
        sourceCheckpointId: currentCheckpoint.id,
        attemptNumber,
        failureEvidence: {
          error_type: currentVerification.evidence.error_type,
          error_summary: currentVerification.evidence.error_summary,
          steps: currentVerification.evidence.steps,
        },
      });

      if (!attempt) {
        // Concurrency conflict: another process/worker already claimed this attempt
        console.warn(`[VerificationRecovery] Concurrency conflict: attempt ${attemptNumber} for verification ${sourceVerification.id} already claimed`);
        return {
          status: 'CONCURRENCY_CONFLICT',
          lastCheckpoint: currentCheckpoint,
          lastVerification: currentVerification,
          error: 'CONCURRENCY_CONFLICT: attempt already claimed by another worker',
        };
      }

      await this.events.emit({
        sessionId: session.id,
        type: 'verification_recovery_attempt_started',
        payload: {
          attemptId: attempt.id,
          attemptNumber,
          sessionId: session.id,
          taskId: task.id,
          sourceVerificationId: sourceVerification.id,
        },
      });

      try {
        const baseline = captureWorkspaceSnapshot(workspace);
        const recoveryPrompt = this.formatRecoveryPrompt(task.prompt, currentVerification, attemptNumber);

        const taskInput: ProviderTaskInput = {
          ...task,
          prompt: recoveryPrompt,
        };

        // 2. Execute provider to produce fix
        const providerResult = await this.provider.execute(taskInput, workspace, {});

        // 3. Finalize workspace changes into a new git commit
        const finalizer = new TaskFinalizer(workspace, {
          commandTimeoutMs: Number(process.env.ROUTER_COMMAND_TIMEOUT_MS ?? 60000),
        });
        const finalize = await finalizer.finalize(task.objective, recoveryPrompt, {
          testCommand: process.env.TASK_TEST_COMMAND || null,
          commitMessage: `prototype(${task.project}): verification recovery attempt ${attemptNumber} for prompt ${task.id}`,
          expectChanges: false,
          allowUnexpectedFiles: false,
          baselineSnapshot: baseline,
          declaredChangedFiles: providerResult.changedFiles ?? [],
        });

        if (finalize.status !== 'COMPLETED' || !finalize.commitSha) {
          const err = finalize.errorMessage || 'Finalization failed during recovery attempt';
          await this.repository.updateCorrectionAttempt(attempt.id, {
            status: 'FAILED',
            error: err,
            finishedAt: new Date(),
          });
          attemptNumber++;
          continue;
        }

        // 4. Create a NEW Checkpoint (Checkpoint A remains intact)
        const currentPromptCount = (await this.repository.getSession(session.id))?.promptCount ?? session.promptCount;
        let newCheckpoint: PrototypeCheckpoint;
        try {
          newCheckpoint = await (this.repository.createCheckpoint as any)({
            sessionId: session.id,
            promptIndex: currentPromptCount,
            prompt: `[RECOVERY #${attemptNumber}] ${task.prompt}`,
            commitSha: finalize.commitSha,
            previewUrl: options?.previewUrl || null,
            buildPassed: true,
          });
        } catch {
          newCheckpoint = await (this.repository.createCheckpoint as any)(session.id, finalize.commitSha);
        }

        if (newCheckpoint) {
          newCheckpoint.id = newCheckpoint.id || (newCheckpoint as any).checkpointId || `cp-${randomUUID()}`;
          newCheckpoint.commitSha = newCheckpoint.commitSha || finalize.commitSha;
        }

        // Persist checkpoint files for multi-container CAS preview
        try {
          if (typeof this.repository.saveCheckpointFiles === 'function') {
            const files = await extractWorkspaceFiles(workspace, newCheckpoint.id, session.id);
            if (files.length > 0) {
              await this.repository.saveCheckpointFiles(files);
            }
          }
        } catch (fErr: any) {
          console.warn('[VerificationRecovery] Failed to save checkpoint files:', fErr.message);
        }

        await this.events.emit({
          sessionId: session.id,
          type: 'CHECKPOINT_CREATED',
          payload: newCheckpoint as unknown as Record<string, unknown>,
        });

        // 5. Run Verification Gate on NEW checkpoint
        const gate = new VerificationGate(this.repository);
        const newVerification = await gate.verify(session.id, newCheckpoint.id, workspace, {
          expectedCommitSha: newCheckpoint.commitSha || undefined,
        });

        currentCheckpoint = newCheckpoint;
        currentVerification = newVerification;

        // 6. Update CorrectionAttempt with results
        await this.repository.updateCorrectionAttempt(attempt.id, {
          resultCommitSha: finalize.commitSha,
          resultCheckpointId: newCheckpoint.id,
          resultVerificationId: newVerification.id,
          status: newVerification.status === 'PASSED' ? 'COMPLETED' : 'FAILED',
          error: newVerification.status === 'PASSED' ? null : newVerification.evidence.error_summary,
          finishedAt: new Date(),
        });

        if (newVerification.status === 'PASSED') {
          await this.events.emit({
            sessionId: session.id,
            type: 'verification_recovery_attempt_succeeded',
            payload: {
              attemptId: attempt.id,
              attemptNumber,
              checkpointId: newCheckpoint.id,
              verificationId: newVerification.id,
            },
          });

          // 7. Authoritative CAS Promotion
          const promotionResult = await gate.promoteIfValid(
            session.id,
            newCheckpoint.id,
            workspace,
            options?.previewUrl || `/prototype/sessions/${session.id}/preview/`,
            options?.previewRuntime,
            options?.expectedCurrentSha
          );

          if (promotionResult.promoted) {
            return {
              status: 'SUCCESS',
              lastCheckpoint: newCheckpoint,
              lastVerification: newVerification,
              attempt,
            };
          } else {
            console.warn(`[VerificationRecovery] CAS Promotion rejected: ${promotionResult.reason}`);
            return {
              status: 'CONCURRENCY_CONFLICT',
              lastCheckpoint: newCheckpoint,
              lastVerification: newVerification,
              attempt,
              error: promotionResult.reason,
            };
          }
        } else {
          await this.events.emit({
            sessionId: session.id,
            type: 'verification_recovery_attempt_failed',
            payload: {
              attemptId: attempt.id,
              attemptNumber,
              checkpointId: newCheckpoint.id,
              verificationId: newVerification.id,
              error: newVerification.evidence.error_summary,
            },
          });
        }
      } catch (err: any) {
        await this.repository.updateCorrectionAttempt(attempt.id, {
          status: 'FAILED',
          error: err.message,
          finishedAt: new Date(),
        });
      }

      attemptNumber++;
    }

    // All attempts exhausted
    await this.events.emit({
      sessionId: session.id,
      type: 'verification_recovery_exhausted',
      payload: {
        sessionId: session.id,
        taskId: task.id,
        sourceVerificationId: sourceVerification.id,
        attemptsExhausted: maxAttempts,
      },
    });

    return {
      status: 'RETRY_EXHAUSTED',
      lastCheckpoint: currentCheckpoint,
      lastVerification: currentVerification,
      error: `Verification recovery exhausted after ${maxAttempts} attempts: ${currentVerification.evidence.error_summary}`,
    };
  }
}
