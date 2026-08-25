/**
 * Await whichever file-read promise is current, then re-check. A user can pick
 * a replacement file while the caller awaits the previous one; one-shot awaits
 * otherwise proceed with a missing/stale attachment and clear the replacement.
 */
export async function awaitStablePendingRead(readCurrent) {
  for (;;) {
    const pending = readCurrent();
    if (!pending) return;
    try { await pending; } catch { /* the owning UI reports the read error */ }
    if (readCurrent() === pending) return;
  }
}
