/**
 * Mirrors GantryCore._validateHandle exactly:
 * 1–32 bytes of [a-z0-9-], no leading or trailing hyphen.
 */
export const HANDLE_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export function isValidHandle(handle: string): boolean {
  return HANDLE_REGEX.test(handle);
}
