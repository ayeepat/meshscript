import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A temporary directory that is removed when the process exits, however it
 * exits — success, thrown error, or rejected top-level await.
 *
 * The motion checks used to mkdtemp and never clean up. Repeated audit runs
 * left more than 300 MiB of orphaned output in the system temp directory,
 * including several 45–50 MiB Remotion bundles, because every failed run also
 * abandoned its workspace.
 *
 * Cleanup is deliberately synchronous and registered on 'exit': an async
 * `finally` cannot run once a top-level await has rejected the module, which is
 * exactly the case that leaked most.
 *
 * Set MOTION_KEEP_ARTIFACTS=1 to retain the directory when a failure needs
 * inspecting; the path is printed so it can be found.
 */
const KEEP_ARTIFACTS = process.env.MOTION_KEEP_ARTIFACTS === '1';

export function createTempWorkspace(prefix) {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  process.once('exit', () => {
    if (KEEP_ARTIFACTS) {
      console.log(`motion: kept artifacts in ${directory} (MOTION_KEEP_ARTIFACTS=1)`);
      return;
    }
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Best effort: a leaked temp directory must never fail an otherwise
      // passing check.
    }
  });
  return directory;
}
