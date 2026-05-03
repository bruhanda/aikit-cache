/**
 * Identity mapped type that flattens an intersection / interface in editor
 * hover popups so users see the resolved shape instead of `A & B & C`.
 * Pure compile-time helper — erased at runtime.
 */
export type Prettify<T> = { [K in keyof T]: T[K] } & {};
