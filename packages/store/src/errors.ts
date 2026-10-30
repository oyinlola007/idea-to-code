// Failures of the store itself. Unlike a bad plan (which is data, see core),
// these are exceptional; callers catch them so editing a plan is never blocked.
export type StoreErrorCode = 'lock-timeout' | 'unknown-session' | 'session-closed' | 'unknown-snapshot' | 'blob-missing';

export class StoreError extends Error {
  constructor(
    readonly code: StoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'StoreError';
  }
}
