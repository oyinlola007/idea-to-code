// @idea-to-code/store: history outside the project folder, shared by the
// extension in every editor and the MCP server. ProjectService arrives in ITC-8.
export * from './appData.js';
export { StoreError, type StoreErrorCode } from './errors.js';
export { SnapshotSource, type Session, type Snapshot } from './events.js';
export * from './history.js';
