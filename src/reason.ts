import { MAX_REASON_LENGTH } from "@lorenzh/pulse-contract";

const MAX_QUOTE_CHARS = 80;

/** Outside data quoted in a reason: at most 80 characters, then `…`. */
export function quote(text: string): string {
  return text.length > MAX_QUOTE_CHARS ? `${text.slice(0, MAX_QUOTE_CHARS)}…` : text;
}

/**
 * Caps a result reason at the contract's 1000 UTF-16 units. A cut may split a surrogate pair;
 * the api counts the same units, so the result is still accepted.
 */
export function capReason(text: string): string {
  return text.length <= MAX_REASON_LENGTH ? text : `${text.slice(0, MAX_REASON_LENGTH - 1)}…`;
}
