/**
 * API security utilities backed by @autonex/auth (Argon2id + scrypt migration + CSRF + AES-GCM QR).
 * Preserves existing import paths across NestJS modules while delegating to shared security primitives.
 */
export {
  ARGON2ID_OPTIONS,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  decryptQrToken,
  encryptQrToken,
  generateCsrfToken,
  generateOpaqueToken,
  generateQrToken,
  hashPassword,
  hashSecret,
  isValidUuid,
  needsRehash,
  REFRESH_COOKIE_NAME,
  safeEqualStrings,
  sha256Hex,
  verifyPassword,
  verifySecret,
} from '@autonex/auth';
