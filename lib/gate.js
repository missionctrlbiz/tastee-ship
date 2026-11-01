// The gate. Pure decision logic, no I/O — the orchestration layer calls this
// after each agent output and obeys the verdict. The model never sees this
// module and cannot influence it: halting is a property of the harness, not a
// prompt instruction.
//
// Failure kinds map to halt reasons:
//   overbuild  -> 'overbuild'   (taste violations, LOC/file budget)
//   regression -> 'regression'  (green->red check transitions)
//   protocol   -> 'outputs-max' (malformed proposals / provider errors)

export function evaluateAttempt({ checks, attemptNo, outputsMax, overbuildAction }) {
  const failures = checks.failures || [];
  const regressions = failures.filter((f) => f.kind === 'regression');
  const overbuilds = failures.filter((f) => f.kind === 'overbuild');
  const flags = [];

  if (regressions.length === 0 && overbuilds.length === 0) {
    return { ship: true, halt: null, flags, failures: [] };
  }

  // Pure over-build (no functional regression): either flag-and-continue or halt.
  if (regressions.length === 0) {
    if (overbuildAction === 'flag') {
      return { ship: true, halt: null, flags: overbuilds, failures: [] };
    }
    return { ship: false, halt: 'overbuild', flags: overbuilds, failures };
  }

  // Functional regression: burn an attempt and let the agent retry — until the
  // outputs budget is exhausted, then halt and report. We never force another
  // change past the budget.
  if (attemptNo >= outputsMax) {
    return { ship: false, halt: 'regression', flags, failures };
  }
  return { ship: false, halt: null, flags, failures };
}

export function evaluateProtocolError({ attemptNo, outputsMax }) {
  if (attemptNo >= outputsMax) {
    return { ship: false, halt: 'outputs-max', flags: [], failures: [] };
  }
  return { ship: false, halt: null, flags: [], failures: [] };
}

export function gateSummary(state) {
  if (!state?.run) return { status: 'idle', label: 'IDLE' };
  const { status, haltReason, run } = state;
  if (status === 'killed') return { status, label: 'KILLED', reason: haltReason };
  if (status === 'halted') {
    const labels = {
      overbuild: 'TRIPPED — over-build',
      regression: 'TRIPPED — regression',
      'outputs-max': 'TRIPPED — outputs_max',
      crash: 'TRIPPED — crash',
    };
    return { status, label: labels[haltReason] || `TRIPPED — ${haltReason}`, reason: haltReason };
  }
  if (status === 'completed') return { status, label: 'COMPLETED', reason: null };
  return {
    status,
    label: 'ARMED',
    reason: null,
    round: run.roundIndex + 1,
    outputsUsed: run.attemptsThisRound,
    outputsMax: run.outputsMax,
  };
}
