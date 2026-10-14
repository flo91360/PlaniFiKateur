import { hashPassword } from '../../server/accounts.js';
export const testEmail = 'owner@example.test';
export const testPassword = 'owner-test-password-123';
export const testPasswordHash = await hashPassword(testPassword);
export function seedAccount(store) {
  return store.bootstrapUser({ name: 'Alice', email: testEmail }, testPasswordHash);
}
export function loginRequest(base, headers = {}) {
  return fetch(base + '/api/v1/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ email: testEmail, password: testPassword }),
  });
}
