import assert from "node:assert/strict";
import test from "node:test";
import { chunkRanges } from "../src/chunker";
import {
  createVaultCrypto,
  decryptChunk,
  decryptPath,
  encryptChunk,
  encryptPath,
  generateRootKey,
  hashBytes,
  keyedId,
  pathKey
} from "../src/crypto";

test("content-defined chunks are contiguous, bounded and reusable after insertion", async () => {
  const original = pseudoRandomBytes(12 * 1024 * 1024);
  const inserted = new Uint8Array(original.length + 4096);
  inserted.set(original.subarray(0, 5 * 1024 * 1024), 0);
  inserted.fill(0x5a, 5 * 1024 * 1024, 5 * 1024 * 1024 + 4096);
  inserted.set(original.subarray(5 * 1024 * 1024), 5 * 1024 * 1024 + 4096);

  const originalRanges = chunkRanges(original);
  assert.equal(originalRanges[0].start, 0);
  assert.equal(originalRanges.at(-1)?.end, original.length);
  for (let index = 0; index < originalRanges.length; index += 1) {
    const range = originalRanges[index];
    assert.equal(range.start, index === 0 ? 0 : originalRanges[index - 1].end);
    assert.ok(range.end - range.start <= 4 * 1024 * 1024);
  }

  const originalHashes = new Set(
    await Promise.all(
      originalRanges.map((range) => hashBytes(original.slice(range.start, range.end)))
    )
  );
  const insertedHashes = await Promise.all(
    chunkRanges(inserted).map((range) => hashBytes(inserted.slice(range.start, range.end)))
  );
  const reused = insertedHashes.filter((hash) => originalHashes.has(hash));
  assert.ok(reused.length >= 2, "a local insertion should preserve multiple distant chunks");
});

test("vault crypto round-trips paths and chunks", async () => {
  const keys = await createVaultCrypto(generateRootKey());
  const plain = new TextEncoder().encode("private note contents");
  const id = await keyedId(keys.indexKey, plain);
  assert.equal(id.length, 64);

  const first = await encryptChunk(keys, plain, id);
  const second = await encryptChunk(keys, plain, id);
  assert.notDeepEqual(first, second, "random nonces should produce different ciphertext");
  assert.deepEqual(await decryptChunk(keys, first, id), plain);

  const path = "私人/日记.md";
  const identity = await pathKey(keys, path);
  const encrypted = await encryptPath(keys, path);
  assert.equal(await decryptPath(keys, encrypted, identity), path);
});

function pseudoRandomBytes(length: number): Uint8Array {
  const result = new Uint8Array(length);
  let state = 0x12345678;
  for (let index = 0; index < length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    result[index] = state & 0xff;
  }
  return result;
}


test("local credentials are authenticated ciphertext, with random salt/nonce and nonexportable keys", async () => {
  const { createProtection, sealCredentials, openCredentials } = await import('../src/credentials');
  const credentials = { token: 'test-only-token', rootKey: generateRootKey() };
  const password = 'test-only-local-password';
  const protection = await createProtection(password);
  assert.equal(protection.key.extractable, false);
  const first = await sealCredentials(credentials, protection.key, protection.salt);
  const second = await sealCredentials(credentials, protection.key, protection.salt);
  assert.notEqual(first.iv, second.iv); assert.notEqual(first.ciphertext, second.ciphertext);
  assert.ok(!JSON.stringify(first).includes(credentials.token));
  assert.ok(!JSON.stringify(first).includes(credentials.rootKey));
  assert.ok(!JSON.stringify(first).includes(password));
  assert.deepEqual((await openCredentials(first, password)).credentials, credentials);
  await assert.rejects(openCredentials(first, 'wrong-password'));
  await assert.rejects(openCredentials({ ...first, ciphertext: (first.ciphertext[0] === 'A' ? 'B' : 'A') + first.ciphertext.slice(1) }, password));
  await assert.rejects(openCredentials({ ...first, iterations: 1 } as any, password));
  await assert.rejects(createProtection('short'));
});
