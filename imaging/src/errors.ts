/**
 * Shared error taxonomy for the Vault Tool Suite browser port.
 *
 * The original CLIs (xprint.c, xpress.c, xconv.c, xbind.c, xpeel.c) all shared
 * one exit-code registry (§5 of the vx-dev-guidelines this suite was built
 * against):
 *
 *   0  OK           1  I/O error        2  Constraint cannot be satisfied
 *   3  Invalid input format             4  Bad arguments    5  Out of memory
 *
 * A browser library has no process exit code to return, but callers still
 * benefit from the same *categorization* — e.g. so a UI can show "that file
 * isn't a valid image" (FORMAT) differently from "couldn't hit that target
 * size" (CONSTRAINT). VaultError carries the old exit code as `code` purely
 * as a stable, documented signal for callers; nothing here maps back to an
 * actual process exit.
 */

export type VaultErrorCode =
  | 'IO'
  | 'CONSTRAINT'
  | 'FORMAT'
  | 'ARGS'
  | 'MEMORY';

/** Legacy numeric exit codes, kept only for anyone porting log parsing / telemetry. */
export const LEGACY_EXIT_CODE: Record<VaultErrorCode, number> = {
  IO: 1,
  CONSTRAINT: 2,
  FORMAT: 3,
  ARGS: 4,
  MEMORY: 5,
};

export class VaultError extends Error {
  readonly code: VaultErrorCode;
  readonly tool: string;

  constructor(tool: string, code: VaultErrorCode, message: string) {
    super(`[${tool}] error: ${message}`);
    this.name = 'VaultError';
    this.tool = tool;
    this.code = code;
  }
}

export type Logger = (message: string) => void;

/** No-op logger used when a caller doesn't pass `verbose`/`onLog`. */
export const silentLogger: Logger = () => {};
