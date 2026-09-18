// Pure PII-masking helpers for the read-only Agent API (/api/agent/*).
// No DB access, no Express types — kept separate so it's trivially unit
// testable and reusable from both the route handlers and the featured-
// orders scoring pipeline (which scores on the MASKED fault_description).

const MASK_TOKEN = '[đã ẩn]';

// Matches email addresses.
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// Matches Vietnamese phone-number-like sequences: a leading +84/84/0 marker
// followed by 7-14 more digits/spaces/dots/dashes, ending in a digit. This
// intentionally covers common formats — 0912345678, 0912 345 678,
// 0912.345.678, 0912-345-678, +84 912 345 678 — as a single candidate regex;
// the actual decision to mask is made in the replace callback below, which
// strips separators and checks the resulting digit count is phone-length
// (9-11 digits), so short unrelated numbers (e.g. "84 tuổi") aren't masked.
const PHONE_CANDIDATE_REGEX = /(?:\+?84|0)[\d\s.-]{7,14}\d/g;

function isPhoneLength(digits: string): boolean {
  return digits.length >= 9 && digits.length <= 11;
}

/**
 * Masks phone-number-like sequences and email addresses in `text` with the
 * literal token `[đã ẩn]`. Used exclusively on `fault_description` before
 * any Agent API response leaves the backend (FR-17.8). Emails are masked
 * first so a phone-shaped digit run inside an email's local part can never
 * survive as an unmasked fragment after the email itself is replaced.
 */
export function maskFaultDescription(text: string | null | undefined): string {
  if (!text) return '';
  const withoutEmails = text.replace(EMAIL_REGEX, MASK_TOKEN);
  return withoutEmails.replace(PHONE_CANDIDATE_REGEX, (match) => {
    const digits = match.replace(/\D/g, '');
    return isPhoneLength(digits) ? MASK_TOKEN : match;
  });
}
