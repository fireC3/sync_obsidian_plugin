import { exactBuffer } from './crypto';

export interface Credentials { token: string; rootKey: string }
export interface EncryptedCredentials {
  version: 1;
  kdf: 'PBKDF2-SHA256';
  iterations: 600000;
  salt: string;
  iv: string;
  ciphertext: string;
}
const iterations = 600000;
const aad = new TextEncoder().encode('obsidian-encrypted-sync/local-credentials/v1');
const encode = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const decode = (value: string): Uint8Array => Uint8Array.from(atob(value), c => c.charCodeAt(0));

export async function deriveWrappingKey(password: string, salt: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', exactBuffer(new TextEncoder().encode(password)), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: exactBuffer(decode(salt)), iterations }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function createProtection(password: string): Promise<{ key: CryptoKey; salt: string }> {
  if (password.length < 12) throw new Error('本地解锁密码至少需要 12 个字符');
  const salt = encode(crypto.getRandomValues(new Uint8Array(16)));
  return { key: await deriveWrappingKey(password, salt), salt };
}
export async function sealCredentials(credentials: Credentials, key: CryptoKey, salt: string): Promise<EncryptedCredentials> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: exactBuffer(iv), additionalData: exactBuffer(aad) }, key, exactBuffer(new TextEncoder().encode(JSON.stringify(credentials))));
  return { version: 1, kdf: 'PBKDF2-SHA256', iterations, salt, iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)) };
}
export async function openCredentials(envelope: EncryptedCredentials, password: string): Promise<{ credentials: Credentials; key: CryptoKey; salt: string }> {
  try {
    if (envelope.version !== 1 || envelope.kdf !== 'PBKDF2-SHA256' || envelope.iterations !== iterations || decode(envelope.salt).length !== 16 || decode(envelope.iv).length !== 12) throw Error('invalid format');
    const key = await deriveWrappingKey(password, envelope.salt);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: exactBuffer(decode(envelope.iv)), additionalData: exactBuffer(aad) }, key, exactBuffer(decode(envelope.ciphertext)));
    const credentials = JSON.parse(new TextDecoder().decode(plain));
    if (typeof credentials.token !== 'string' || typeof credentials.rootKey !== 'string') throw Error('invalid credentials');
    return { credentials, key, salt: envelope.salt };
  } catch { throw new Error('无法解锁：密码错误或密钥密文已损坏。原有数据未修改。'); }
}
