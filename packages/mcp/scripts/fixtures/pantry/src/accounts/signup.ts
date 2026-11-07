// Pantry is a fictitious app, used to test mapping a codebase into a plan. Not real code.
export interface User {
  id: number;
  email: string;
  passwordHash: string;
}

const users: User[] = [];

/** Creates an account; an email can only be used once. */
export function signUp(email: string, passwordHash: string): User {
  if (users.some((u) => u.email === email)) throw new Error('That email already has an account');
  const user = { id: users.length + 1, email, passwordHash };
  users.push(user);
  return user;
}

export function findUser(email: string): User | undefined {
  return users.find((u) => u.email === email);
}
