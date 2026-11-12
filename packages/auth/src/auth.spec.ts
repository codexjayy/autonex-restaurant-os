import assert from 'node:assert/strict';
import test from 'node:test';
import {
  generateCsrfToken,
  hashPassword,
  hashSecret,
  needsRehash,
  safeEqualStrings,
  verifyPassword,
  verifySecret,
} from './index';

test('Argon2id hashes passwords with $argon2id$ PHC prefix and verifies cleanly', async () => {
  const hash = await hashPassword('AutoNexStrongPass!2026');
  assert.ok(hash.startsWith('$argon2id$'));
  assert.equal(needsRehash(hash), false);
  assert.equal(await verifyPassword('AutoNexStrongPass!2026', hash), true);
  assert.equal(await verifyPassword('WrongPass', hash), false);
});

test('sync Argon2id hashSecret & verifySecret work cleanly and flag legacy scrypt for rehash', () => {
  const hash = hashSecret('1234');
  assert.ok(hash.startsWith('$argon2id$'));
  assert.equal(verifySecret('1234', hash), true);
  assert.equal(verifySecret('9999', hash), false);
  assert.equal(needsRehash('scrypt:abc:def'), true);
});

test('CSRF token generation and constant-time comparison work reliably', () => {
  const t1 = generateCsrfToken();
  const t2 = generateCsrfToken();
  assert.notEqual(t1, t2);
  assert.equal(safeEqualStrings(t1, t1), true);
  assert.equal(safeEqualStrings(t1, t2), false);
});

