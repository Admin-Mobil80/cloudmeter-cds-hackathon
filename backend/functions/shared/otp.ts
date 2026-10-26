import { createHash, randomInt } from 'crypto';

export function generateOtp(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

export function hashOtp(code: string, email: string): string {
  return createHash('sha256').update(`${email}:${code}`).digest('hex');
}
