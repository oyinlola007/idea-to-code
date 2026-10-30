// @idea-to-code/store: history outside the project folder, shared by the
// extension in every editor and the MCP server, and ProjectService, which
// connects the pure core to real files and history.
export * from './appData.js';
export { StoreError, type StoreErrorCode } from './errors.js';
export { SnapshotSource, type Session, type Snapshot } from './events.js';
export * from './history.js';
export * from './nodePlanFiles.js';
export * from './paths.js';
export type { PlanFiles } from './planFiles.js';
export * from './projectService.js';
