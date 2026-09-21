const encoder = new TextEncoder();
const decoder = new TextDecoder();
const VERSION_SALT = encoder.encode("obsidian-encrypted-sync/v1");

export interface VaultCrypto {
  contentKey: CryptoKey;
  indexKey: CryptoKey;
}

export function generateRootKey(): string {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
}

export async function createVaultCrypto(rootKeyBase64: string): Promise<VaultCrypto> {
  const rootBytes = base64ToBytes(rootKeyBase64.trim());
  if (rootBytes.length !== 32) {
    throw new Error("Vault 根密钥必须是32字节的 Base64 数据");
  }
  const root = await crypto.subtle.importKey("raw", exactBuffer(rootBytes), "HKDF", false, [
    "deriveKey"
  ]);
  const contentKey = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: exactBuffer(VERSION_SALT),
      info: exactBuffer(encoder.encode("content-key"))
    },
    root,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
  const indexKey = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: exactBuffer(VERSION_SALT),
      info: exactBuffer(encoder.encode("index-key"))
    },
    root,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"]
  );
  return { contentKey, indexKey };
}

export async function hashBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", exactBuffer(bytes));
  return bytesToHex(new Uint8Array(digest));
}

export async function keyedId(key: CryptoKey, bytes: Uint8Array): Promise<string> {
  const signature = await crypto.subtle.sign("HMAC", key, exactBuffer(bytes));
  return bytesToHex(new Uint8Array(signature));
}

export async function pathKey(keys: VaultCrypto, path: string): Promise<string> {
  return keyedId(keys.indexKey, encoder.encode(normalizePathIdentity(path)));
}

export async function encryptPath(keys: VaultCrypto, path: string): Promise<string> {
  const key = await pathKey(keys, path);
  const encrypted = await encryptBytes(keys.contentKey, encoder.encode(path), encoder.encode(key));
  return bytesToBase64(encrypted);
}

export async function decryptPath(
  keys: VaultCrypto,
  encryptedPath: string,
  expectedPathKey: string
): Promise<string> {
  const plain = await decryptBytes(
    keys.contentKey,
    base64ToBytes(encryptedPath),
    encoder.encode(expectedPathKey)
  );
  const path = decoder.decode(plain);
  if ((await pathKey(keys, path)) !== expectedPathKey) {
    throw new Error("远端路径校验失败");
  }
  return path;
}

export async function encryptChunk(
  keys: VaultCrypto,
  plain: Uint8Array,
  chunkId: string
): Promise<Uint8Array> {
  return encryptBytes(keys.contentKey, plain, encoder.encode(chunkId));
}

export async function decryptChunk(
  keys: VaultCrypto,
  encrypted: Uint8Array,
  chunkId: string
): Promise<Uint8Array> {
  const plain = await decryptBytes(keys.contentKey, encrypted, encoder.encode(chunkId));
  if ((await keyedId(keys.indexKey, plain)) !== chunkId) {
    throw new Error(`块 ${chunkId.slice(0, 8)} 的内容校验失败`);
  }
  return plain;
}

async function encryptBytes(
  key: CryptoKey,
  plain: Uint8Array,
  additionalData: Uint8Array
): Promise<Uint8Array> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: exactBuffer(nonce), additionalData: exactBuffer(additionalData) },
    key,
    exactBuffer(plain)
  );
  return concatBytes([nonce, new Uint8Array(ciphertext)]);
}

async function decryptBytes(
  key: CryptoKey,
  encrypted: Uint8Array,
  additionalData: Uint8Array
): Promise<Uint8Array> {
  if (encrypted.length < 28) {
    throw new Error("无效的加密数据");
  }
  const nonce = encrypted.slice(0, 12);
  const ciphertext = encrypted.slice(12);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: exactBuffer(nonce), additionalData: exactBuffer(additionalData) },
    key,
    exactBuffer(ciphertext)
  );
  return new Uint8Array(plain);
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

export function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function normalizePathIdentity(path: string): string {
  return path.replace(/\\/g, "/").normalize("NFC").toLocaleLowerCase("en-US");
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error("Vault 根密钥不是有效的 Base64");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
