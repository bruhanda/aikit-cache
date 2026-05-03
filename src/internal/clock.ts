/**
 * Pluggable clock interface. Cache TTL math reads `now()` exclusively
 * through this so deterministic tests can advance time without faking
 * `Date.now` globally.
 */
export interface Clock {
  now(): number;
}

/** Default clock — wraps `Date.now`. */
export const defaultClock: Clock = {
  now: () => Date.now(),
};
