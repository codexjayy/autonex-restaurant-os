import {
  type Algorithm,
  hash as argon2Hash,
  hashSync as argon2HashSync,
  verify as argon2Verify,
  verifySync as argon2VerifySync,
} from '@node-rs/argon2';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

export const REFRESH_COOKIE_NAME = 'anx_refresh';
export const CSRF_COOKIE_NAME = 'anx_csrf';
export const CSRF_HEADER_NAME = 'x-csrf-token';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * OWASP recommended first-choice Argon2id tuning (19 MiB, 2 iterations, 1 lane).
 * Numeric literal `2` corresponds to `Algorithm.Argon2id` (avoids ambient const enum access under isolatedModules).
 */
export const ARGON2ID_OPTIONS = {
  algorithm: 2 as Algorithm,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

function verifyLegacyScrypt(plain: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') {
    return false;
  }
  const salt = parts[1];
  const expectedHex = parts[2];
  if (!salt || !expectedHex) {
    return false;
  }

  const derived = scryptSync(plain, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  if (derived.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(derived, expected);
}

export async function hashPassword(plain: string): Promise<string> {
  return argon2Hash(plain, ARGON2ID_OPTIONS);
}

export async function verifyPassword(plain: string, storedHash: string): Promise<boolean> {
  if (!storedHash) return false;
  if (storedHash.startsWith('$argon2')) {
    try {
      return await argon2Verify(storedHash, plain);
    } catch {
      return false;
    }
  }
  return verifyLegacyScrypt(plain, storedHash);
}

/**
 * Synchronous Argon2id helper retained for seed scripts and synchronous test utilities.
 */
export function hashSecret(plain: string): string {
  return argon2HashSync(plain, ARGON2ID_OPTIONS);
}

/**
 * Verifies Argon2id ($argon2id$...) hashes with transparent legacy scrypt fallback.
 */
export function verifySecret(plain: string, storedHash: string): boolean {
  if (!storedHash) return false;
  if (storedHash.startsWith('$argon2')) {
    try {
      return argon2VerifySync(storedHash, plain);
    } catch {
      return false;
    }
  }
  return verifyLegacyScrypt(plain, storedHash);
}

export function needsRehash(storedHash: string): boolean {
  return !storedHash.startsWith('$argon2id$');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function generateOpaqueToken(bytes = 48): string {
  return randomBytes(bytes).toString('base64url');
}

export function generateCsrfToken(): string {
  return randomBytes(32).toString('base64url');
}

export function safeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function generateQrToken(): string {
  return randomBytes(32).toString('base64url');
}

export function encryptQrToken(rawToken: string, secret: string): string {
  const key = createHash('sha256').update(secret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(rawToken, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptQrToken(tokenEnc: string, secret: string): string {
  const parts = tokenEnc.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Invalid encrypted QR token format');
  }
  const [, ivHex, tagHex, dataHex] = parts;
  if (!ivHex || !tagHex || !dataHex) {
    throw new Error('Malformed encrypted QR token');
  }
  const key = createHash('sha256').update(secret).digest();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
}

export function isValidUuid(value: string | null | undefined): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}
