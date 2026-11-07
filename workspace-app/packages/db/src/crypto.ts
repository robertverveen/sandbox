/**
 * Envelope-versleuteling voor koppel-tokens (HZW-006, HZW-014).
 * Per token een eigen datasleutel (DEK, AES-256-GCM); de DEK wordt versleuteld met de hoofdsleutel
 * uit HZ_TOKEN_KEY (32 bytes, base64). Het token is gebonden aan gebruiker en bron (AAD), zodat een
 * versleuteld token niet naar een andere rij te kopiëren is. Tokens komen nooit in de browser of in logs.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface SealedToken {
  tokenCiphertext: string;
  tokenIv: string;
  tokenTag: string;
  dekWrapped: string;
  keyVersion: number;
}

export function parseMasterKey(b64: string | undefined): Buffer {
  if (!b64) throw new Error('HZ_TOKEN_KEY ontbreekt (32 bytes, base64)');
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) throw new Error('HZ_TOKEN_KEY moet precies 32 bytes zijn (base64)');
  return key;
}

const gcm = (key: Buffer, iv: Buffer, data: Buffer, aad: Buffer) => {
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(data), c.final()]);
  return { ct, tag: c.getAuthTag() };
};
const ungcm = (key: Buffer, iv: Buffer, ct: Buffer, tag: Buffer, aad: Buffer) => {
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAAD(aad);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
};

const aadFor = (userId: string, provider: string) => Buffer.from(`hz-token:v1:${userId}:${provider}`);

export function sealToken(
  plaintext: string,
  masterKey: Buffer,
  userId: string,
  provider: string,
  keyVersion = 1,
): SealedToken {
  const aad = aadFor(userId, provider);
  const dek = randomBytes(32);
  const iv = randomBytes(12);
  const { ct, tag } = gcm(dek, iv, Buffer.from(plaintext, 'utf8'), aad);
  const wiv = randomBytes(12);
  const w = gcm(masterKey, wiv, dek, aad);
  dek.fill(0);
  return {
    tokenCiphertext: ct.toString('base64'),
    tokenIv: iv.toString('base64'),
    tokenTag: tag.toString('base64'),
    dekWrapped: Buffer.concat([wiv, w.tag, w.ct]).toString('base64'),
    keyVersion,
  };
}

export function openToken(s: SealedToken, masterKey: Buffer, userId: string, provider: string): string {
  const aad = aadFor(userId, provider);
  const wrapped = Buffer.from(s.dekWrapped, 'base64');
  const dek = ungcm(masterKey, wrapped.subarray(0, 12), wrapped.subarray(28), wrapped.subarray(12, 28), aad);
  try {
    return ungcm(
      dek,
      Buffer.from(s.tokenIv, 'base64'),
      Buffer.from(s.tokenCiphertext, 'base64'),
      Buffer.from(s.tokenTag, 'base64'),
      aad,
    ).toString('utf8');
  } finally {
    dek.fill(0);
  }
}
