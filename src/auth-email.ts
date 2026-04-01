/**
 * Email validation helper for auth flows.
 */

/** Basic email format check. Not RFC 5322 exhaustive. */
export function isValid(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
