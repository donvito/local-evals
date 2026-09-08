import { DatabaseStore } from "./db.js";

export { DatabaseStore } from "./db.js";
export type { StoredCaseResult, StoredRun } from "./db.js";

/** Compatibility wrapper for callers that prefer a repository-named instance. */
export class RunRepository extends DatabaseStore {}

export class Repositories extends RunRepository {}
