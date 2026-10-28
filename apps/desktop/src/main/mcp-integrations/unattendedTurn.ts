/**
 * Marks one agent turn whose only requester is a timer.
 *
 * A scheduled fire has nobody in the loop, and the interaction layer is
 * deliberately unbounded for human decisions: ask_user_question / plan_review
 * cards get no timeout (see PERMISSION_INTERACTION_TIMEOUT_MS) and the session
 * turn watchdog suspends while `pendingInteractions > 0`. A question asked from
 * a scheduled turn therefore waits forever, and the only backstop left is the
 * 60min run-level stall guard, which kills the run and leaves the turn with no
 * final answer at all.
 *
 * Turn-scoped and ref-counted for the same reason as
 * beginHeadlessGhostSetupTurn: scheduler runs reuse live Desktop and teammate
 * sessions, and later user-driven turns must go back to interactive.
 */
const unattendedDepthBySession = new Map<string, number>();

export function beginUnattendedTurn(sessionId: string): () => void {
  unattendedDepthBySession.set(
    sessionId,
    (unattendedDepthBySession.get(sessionId) ?? 0) + 1,
  );
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = (unattendedDepthBySession.get(sessionId) ?? 1) - 1;
    if (next > 0) unattendedDepthBySession.set(sessionId, next);
    else unattendedDepthBySession.delete(sessionId);
  };
}

export function isUnattendedTurn(sessionId: string): boolean {
  return (unattendedDepthBySession.get(sessionId) ?? 0) > 0;
}
