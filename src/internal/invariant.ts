import { InvariantError } from '../errors/base.js';

/**
 * Throws `InvariantError` (code `INVARIANT`) when `condition` is falsy.
 * Used to assert programmer-side invariants — never to validate user input,
 * which has its own typed error classes.
 *
 * @param condition Boolean expression that must hold.
 * @param message Human-readable description of what was violated.
 * @throws {InvariantError} when `condition` is falsy.
 */
export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new InvariantError(message);
}
