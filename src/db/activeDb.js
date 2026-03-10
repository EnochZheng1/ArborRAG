/**
 * AsyncLocalStorage-based request-scoped DB context.
 * Every HTTP request runs inside runWithDb(), so all downstream
 * code that calls getActiveDb() gets the correct dataset connection.
 */
import { AsyncLocalStorage } from "async_hooks";

const storage = new AsyncLocalStorage();
let defaultDb = null;

/** Called once at startup with the default dataset's connection. */
export function setDefaultDb(db) {
  defaultDb = db;
}

/**
 * Returns the DB connection for the current async context,
 * or falls back to the default dataset connection.
 * Returns null only before initDb() has completed.
 */
export function getActiveDb() {
  return storage.getStore()?.db ?? defaultDb;
}

/**
 * Returns the dataset ID for the current async context, or null.
 */
export function getActiveDatasetId() {
  return storage.getStore()?.datasetId ?? null;
}

/**
 * Runs fn() inside an AsyncLocalStorage context bound to the given connection.
 * All synchronous and async code inside fn() will see this connection via getActiveDb().
 */
export function runWithDb(db, fn, datasetId = null) {
  return storage.run({ db, datasetId }, fn);
}
