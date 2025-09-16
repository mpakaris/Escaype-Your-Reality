/**
 * Checks if the input exceeds 50 characters.
 * @param {string} input - The input string to check.
 * @returns {boolean} - True if input is over 50 characters, false otherwise.
 */
export function isInputTooLong(input) {
  if (!input) return false;
  return input.length > 50;
}
