import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { getEnv } from '../env.js';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function keyBuf(): Buffer {
    return Buffer.from(getEnv().ENCRYPTION_KEY, 'hex');
}

export function encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALGO, keyBuf(), iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    // format: <iv_hex>:<tag_hex>:<ciphertext_hex>
    return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decrypt(encoded: string): string {
    const parts = encoded.split(':');
    if (parts.length !== 3) throw new Error('Invalid encrypted value format');
    const [ivHex, tagHex, ctHex] = parts as [string, string, string];
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const ct = Buffer.from(ctHex, 'hex');
    const decipher = createDecipheriv(ALGO, keyBuf(), iv);
    decipher.setAuthTag(tag);
    return decipher.update(ct) + decipher.final('utf8');
}

export function isEncrypted(value: string): boolean {
    return /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/.test(value);
}
