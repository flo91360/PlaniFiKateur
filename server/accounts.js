import { scrypt, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const derive = promisify(scrypt);
export const tokenHash = value => createHash('sha256').update(value).digest('hex');
export const publicUser = row => row ? { id: row.id, name: row.name, email: row.email, role: row.role, active: !!row.active, pending: !row.password_hash, createdAt: row.created_at } : null;
export function accountFields(data) {
  const name = typeof data?.name === 'string' ? data.name.trim() : '';
  const email = typeof data?.email === 'string' ? data.email.trim().toLowerCase() : '';
  if (!name || name.length > 80) throw new Error('Indiquez un nom de 1 à 80 caractères.');
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Indiquez une adresse e-mail valide.');
  return { name, email };
}
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) throw new Error('Le mot de passe doit contenir entre 12 et 256 caractères.');
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt, 64);
  return `scrypt:${salt}:${key.toString('hex')}`;
}
export async function verifyPassword(password, encoded) {
  const valid = typeof encoded === 'string' && /^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(encoded);
  const [, salt, hash] = valid ? encoded.split(':') : ['scrypt', '0'.repeat(32), '0'.repeat(128)];
  const key = await derive(typeof password === 'string' && password.length <= 256 ? password : '', salt, 64);
  return valid && timingSafeEqual(key, Buffer.from(hash, 'hex'));
}
