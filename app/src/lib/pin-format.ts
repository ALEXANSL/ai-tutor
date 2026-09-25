/** PIN format shared by client keypad and server (US-1.5 KP-5): 4–6 digits. */
export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 6;
const PIN_PATTERN = /^\d{4,6}$/;

export function isValidPinFormat(pin: unknown): pin is string {
  return typeof pin === "string" && PIN_PATTERN.test(pin);
}
