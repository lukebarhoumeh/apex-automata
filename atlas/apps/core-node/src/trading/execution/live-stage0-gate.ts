/**
 * Sprint 9 / Stage 0 live-readiness gate.
 *
 * Live execution is refused — fail closed — until every Stage-0 task
 * (TASK_011 … TASK_016) has landed and verifies green. This is a hard,
 * code-level constant on purpose: there is no env var, request flag or
 * runtime switch that can open it. Flipping it requires a reviewed PR.
 *
 * Flip procedure (later work, NOT this module's concern today):
 *   1. `node CURSOR_TASKS/verify/verify_sprint9.cjs` reports TASK_011–TASK_016 as DONE.
 *   2. Set `LIVE_STAGE0_COMPLETE = true` below in a PR merged by the Trading Master.
 *
 * This gate is additive: the CDP/credential checks in `adapter-factory.ts`
 * (`LIVE_REQUIRES_ADVANCED_TRADE`, `LIVE_CREDENTIALS_MISSING`) and the engine
 * wiring gate (`LIVE_EXECUTION_PATH_NOT_WIRED`) all still apply once it opens.
 *
 * Paper mode never consults this gate.
 */

/** Error code thrown when live execution is requested while Stage 0 is incomplete. */
export const LIVE_STAGE0_INCOMPLETE = 'LIVE_STAGE0_INCOMPLETE';

/** Stage-0 tasks that must verify green before live execution is permitted. */
export const LIVE_STAGE0_REQUIRED_TASKS: readonly string[] = [
  'TASK_011',
  'TASK_012',
  'TASK_013',
  'TASK_014',
  'TASK_015',
  'TASK_016',
];

/**
 * Single source of truth for Stage-0 completion. Stays `false` until
 * TASK_011–TASK_016 verify green via `verify_sprint9.cjs`.
 */
export const LIVE_STAGE0_COMPLETE: boolean = false;

/**
 * Whether live execution may proceed past the Stage-0 gate.
 *
 * @returns `true` only once `LIVE_STAGE0_COMPLETE` has been flipped in code.
 */
export function isLiveStage0Complete(): boolean {
  return LIVE_STAGE0_COMPLETE === true;
}

/**
 * Fail closed: throw `LIVE_STAGE0_INCOMPLETE` while Stage 0 is not verified green.
 *
 * Call this before constructing or starting anything that can place live orders.
 * Paper-mode call sites must not invoke it.
 *
 * @throws {Error} whose message starts with `LIVE_STAGE0_INCOMPLETE:` when the gate is closed.
 */
export function assertLiveStage0Complete(): void {
  if (isLiveStage0Complete()) {
    return;
  }
  const first = LIVE_STAGE0_REQUIRED_TASKS[0];
  const last = LIVE_STAGE0_REQUIRED_TASKS[LIVE_STAGE0_REQUIRED_TASKS.length - 1];
  throw new Error(
    `${LIVE_STAGE0_INCOMPLETE}: live execution is refused until Sprint 9 / Stage 0 is complete — ` +
      `${first}–${last} must verify green (node CURSOR_TASKS/verify/verify_sprint9.cjs). ` +
      'Flip LIVE_STAGE0_COMPLETE in trading/execution/live-stage0-gate.ts only in a reviewed PR after that ' +
      'verification. Paper mode is unaffected.',
  );
}
