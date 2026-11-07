// Pantry is a fictitious app, used to test mapping a codebase into a plan. Not real code.
import { findUser, type User } from './signup.js';

/** Checks the password and starts a session. */
export function logIn(email: string, passwordHash: string): { user: User; token: string } {
  const user = findUser(email);
  if (user?.passwordHash !== passwordHash) throw new Error('Wrong email or password');
  return { user, token: `session-${String(user.id)}-${String(Date.now())}` };
}
