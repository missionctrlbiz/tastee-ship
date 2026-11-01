CODEX REVIEW

# tastee-ship — Senior Review & Hardening Plan

I reviewed the current `main` branch source, including the runner, gate, verification layer, state persistence, Git operations, providers, dashboard, CLI, and validation documentation.

The most important findings are not cosmetic. The dashboard's preview can execute generated project code with the dashboard's origin privileges, the resume guard misses dirty working trees, and the event history loses information needed to reconstruct decisions. These should take precedence over the more elaborate dashboard features.

The review below distinguishes existing functionality from proposed changes and keeps enforcement entirely in the Node orchestration layer.

## Executive summary

**Recommended order of work:**

| Priority | Change | Why it comes first |
|---|---|---|
| P0 | Secure the dashboard, preview iframe, and proposal filesystem boundary | Protects the kill endpoint, local files, and rollback assumptions. |
| P1 | Harden resume against uncommitted and untracked changes | Prevents accidental work from being silently incorporated into a resumed run. |
| P1 | Persist structured gate decisions and causal check results | Makes halts explainable from evidence rather than just event messages. |
| P1 | Introduce per-run manifests and a canonical append-only event schema | Makes runs traceable and preserves their identity across subsequent runs. |
| P1 | Add a filterable audit log and Git-backed diff drawer | Makes the important evidence available in the dashboard. |
| P2 | Add per-check trends, chart interactions, A/B previews, latency visualization, and exports | Useful once the data model is trustworthy. |

A few corrections to the initial feature brief are important:

- The dashboard already has a responsive breakpoint at 900px. It needs better small-screen behavior rather than its first responsive breakpoint.
- The gate chip and KILL button already contain text labels. The remaining accessibility work is primarily live announcements, explicit accessible labels, and keyboard interaction.
- `state.gateEvents` is capped at 500 entries, the dashboard displays only 120, and `/api/events` returns at most 300. Removing `.slice(-120)` alone does not produce a complete historical log.
- `rounds[i]` already has `tokens` and `usd`, but those values describe the successful output that shipped—not all the outputs consumed by that round. The cumulative-cost chart consequently undercounts rounds that needed retries.
- There is no existing Git diff API in `lib/gitops.js`, but it already exposes a Git command helper. A read-only diff endpoint is straightforward without adding a dependency.

The most relevant source files are [`lib/dashboard.js`](https://github.com/missionctrlbiz/tastee-ship/blob/main/lib/dashboard.js), [`dashboard/index.html`](https://github.com/missionctrlbiz/tastee-ship/blob/main/dashboard/index.html), [`lib/runner.js`](https://github.com/missionctrlbiz/tastee-ship/blob/main/lib/runner.js), and [`lib/state.js`](https://github.com/missionctrlbiz/tastee-ship/blob/main/lib/state.js).

---

# Area 1 — Dashboard UI

## Prioritized triage

### P0 — Secure the dashboard's authority boundary

**Files:** `lib/dashboard.js`, `dashboard/index.html`

The dashboard is described as local, but `server.listen(port)` does not explicitly restrict the listening interface. The dashboard also exposes `POST /api/kill` without an Origin check, while `/api/pf` serves files from the selected project—including hidden files when their paths are known.

The most concerning combination is the site-preview iframe. It has no `sandbox` attribute, and its document is served from the dashboard's own origin. Generated project JavaScript can therefore execute with same-origin privileges.

In that configuration, code introduced by a model proposal could potentially request the dashboard's kill endpoint or read project files through `/api/pf`. That creates an indirect route through which model-generated content could interfere with the stopping mechanism or expose sensitive files.

**Change:** Bind the server to loopback, validate the request origin for the kill endpoint, sandbox the preview without granting `allow-same-origin`, and deny access to private paths such as `.env.local`, `.git`, `.tasteeship`, and `node_modules`.

**Rationale:** The dashboard displays generated code, but displaying that code must not give it authority over the harness.

Retain the preview's required asset loading and test form interactions under the sandbox. Do not grant top-level navigation or same-origin access to make the preview work.

### P1 — Make the gate log filterable and historically complete

**Files:** `lib/state.js`, `lib/dashboard.js`, `dashboard/app.js`, `dashboard/index.html`, `dashboard/style.css`

The current implementation has three separate limitations:

- `renderLog()` truncates the displayed list to the latest 120 entries.
- `state.gateEvents` retains at most 500 entries.
- `/api/events` returns at most 300 records and is not currently the dashboard's source for the gate log.

There is also a concrete timestamp bug. `gateEvent()` adds `{type, round, message}` to the in-memory array without a `ts` field. Although `appendEvent()` writes a timestamp to `events.jsonl`, the dashboard renders `state.gateEvents` directly. Consequently, the displayed event times are blank.

**Change:** Make `events.jsonl` the canonical historical event source, expose bounded filtering and pagination through the existing HTTP API, and retain only a recent event window in live state where appropriate.

The UI should offer the five requested filters: overbuild, regression, outputs-max, user-rejection, and shipped. Filter by explicit event type and halt reason, not substring matching against display messages. A successful ordinary shipment must also produce a `ship` event; currently, cleanly shipped rounds do not produce a corresponding gate-log entry.

Add a validated tail-size control and click-to-jump behavior. When an event refers to a rejected or halted round that has no shipped table row, the UI should communicate that fact and navigate to the nearest relevant checkpoint rather than silently doing nothing.

**Rationale:** A reviewer's evidence must include the decisions that did not result in a shipped snapshot, not merely the visible successful rounds.

### P1 — Add a Git-backed round diff drawer

**Files:** `lib/gitops.js`, `lib/runner.js`, `lib/dashboard.js`, `dashboard/app.js`, `dashboard/index.html`, `dashboard/style.css`

The harness already records a commit on each shipped round and has `git()` in `lib/gitops.js`. However, it does not persist the baseline commit in `state.baseline`, and the snapshots currently store HTML rather than full repository diffs.

**Change:** Persist the baseline commit, then add a read-only `/api/snapshot-diff` endpoint that resolves the before and after commits from recorded state.

Use Git's `--numstat` and unified diff output to return each changed path, additions, deletions, and a bounded patch. A selected round is compared with its preceding shipped checkpoint. Round 1 uses the recorded baseline commit.

Derive both commits from trusted state and a validated round number. Do not accept arbitrary Git references supplied by the browser.

The drawer should escape returned patch text before rendering it and impose a response-size limit.

**Rationale:** Reviewers need to verify what actually changed, rather than infer a change from its summary or the final HTML alone.

### P2 — Add chart crosshairs, tooltips, and halt markers

**Files:** `dashboard/app.js`, `dashboard/index.html`, `dashboard/style.css`

Extend the existing SVG renderer with pointer-based crosshairs and tooltips containing the round number, LOC, ΔLOC, cost, and verdict. Use the same round data as the table.

Add a marker for the actual halt round using structured gate events. A halted round may have no shipped data point, so the chart's x-axis must accommodate a halt marker beyond the last successful point.

**Important dependency:** Fix round-wide usage accounting before treating the cumulative-cost line as authoritative. At present, summing `rounds[i].usd` omits costs consumed by rejected attempts.

**Rationale:** A halt should be visible as part of the run's trajectory, not something a reviewer must discover by scrolling through the event log.

### P2 — Harden SSE reconnection and show connection freshness

**Files:** `dashboard/app.js`, `lib/state.js`, `dashboard/index.html`

Replace the fixed two-second reconnection timer with exponential backoff, capped at a reasonable maximum. Reset the backoff when the connection is restored.

Display a `RECONNECTING` status without replacing the actual gate verdict, and show the last-event timestamp. The timestamp must come from the corrected event records.

**Rationale:** A lost dashboard connection must not look like a halted run or silently conceal stale data.

### P2 — Improve A/B comparison, accessibility, and mobile behavior

**Files:** `dashboard/index.html`, `dashboard/app.js`, `dashboard/style.css`

Add a pinned “before” snapshot and a scrub-controlled “after” snapshot in adjacent iframes. Give both frames descriptive titles.

Add `aria-live` to the gate status, an accessible name to the KILL button, `aria-valuetext` to the scrubber, and keyboard-operable round-selection controls. Keep the status meaning in text, not color alone.

The existing 900px breakpoint already stacks the main panels and charts. Add a narrower breakpoint for phone-sized layouts, allow the rounds table to scroll horizontally, and reduce iframe height where appropriate.

**Rationale:** These are worthwhile usability improvements, but they should follow the security and auditability work rather than block it.

## Area 1 — First two diff sketches

### Sketch 1: Contain the dashboard's authority

```diff
--- a/lib/dashboard.js
+++ b/lib/dashboard.js
@@
-      else if (req.method === 'POST' && url.pathname === '/api/kill')
-        handleKill(req, res, project);
+      else if (req.method === 'POST' && url.pathname === '/api/kill') {
+        if (!isAllowedDashboardOrigin(req, port)) {
+          res.writeHead(403);
+          return res.end('forbidden');
+        }
+        return handleKill(req, res, project);
+      }

@@
-  server.listen(port, () => {
-    console.log(`tship dashboard: http://localhost:${port}`);
+  server.listen(port, '127.0.0.1', () => {
+    console.log(`tship dashboard: http://127.0.0.1:${port}`);
   });
```

`isAllowedDashboardOrigin()` is a small new helper using the expected loopback origin and configured port. Reject missing or unexpected origins for browser-originated kill requests; update the displayed dashboard URL to match the bind address.

In `dashboard/index.html`:

```diff
- <iframe id="preview" title="site preview at round"></iframe>
+ <iframe id="preview"
+         title="site preview at round"
+         sandbox="allow-scripts allow-forms"></iframe>
```

Do **not** add `allow-same-origin` or top-level-navigation privileges. Pair this with an explicit denylist in `serveProjectFile()` for sensitive project paths. The Origin guard on `/api/kill` remains necessary even when the iframe is sandboxed.

### Sketch 2: Give the gate log a real historical data source

```diff
--- a/lib/state.js
+++ b/lib/state.js
@@
 export function gateEvent(root, state, type, round, message) {
-  const e = { type, round, message };
+  const ts = new Date().toISOString();
+  const e = { ts, type, round, message, run: state.run?.id ?? null };
   state.gateEvents.push(e);
   if (state.gateEvents.length > 500) state.gateEvents = state.gateEvents.slice(-500);
-  appendEvent(root, e);
+  appendEvent(root, e);
 }
```

This fixes the immediate timestamp issue, while `events.jsonl` should become the canonical source for historical queries. The final version should serialize the common event schema described in Area 3.

Extend `/api/events` with validated query parameters such as `type`, `limit`, and `cursor`, backed by the append-only log. The dashboard can then apply the five filters and tail-size control without assuming that the last 120 in-memory entries represent the full run.

---

# Area 2 — Harness Engineering and More Aligned Runs

## Prioritized triage

### P0 — Prevent proposal writes from escaping the repository

**File:** `lib/runner.js`, `applyProposal()`

The current path check rejects absolute paths and paths containing `..`, but that does not prevent a path from traversing an existing symbolic link. For example, if a directory inside the target repository links to an outside location, a proposed write beneath that directory can modify a file outside the repository.

That modification cannot necessarily be undone by `resetHard()`. The harness's rollback guarantee therefore depends on an assumption that the current path validation does not enforce.

**Change:** Before writing any files, validate every proposed path against the real project root and reject existing symbolic-link components. Use temporary files and atomic replacement where appropriate to avoid following a symbolic link or modifying an existing hard-linked file in place.

Validate all proposal paths before performing the first write.

**Rationale:** A model proposal must not gain filesystem authority outside the tree that the harness checkpoints and can roll back.

### P1 — Check the entire working tree before resuming

**Files:** `lib/runner.js`, `lib/gitops.js`

`resumeRun()` checks whether `HEAD` matches `state.run.lastGoodCommit`. It does not check whether the working tree is dirty.

This matters because `executeRun()` subsequently performs a baseline commit whenever `isClean(target)` is false. A user can therefore modify a tracked file or add an untracked file without changing `HEAD`, then resume the run and have those changes committed automatically.

**Change:** Before resuming, inspect `git status --porcelain --untracked-files=all`. Refuse to continue if changes are present and report the affected paths. Permit destructive cleanup only when the user explicitly supplies `--force` and a valid checkpoint exists.

Ignored files are not included by that Git status command; document that boundary rather than claiming that every filesystem change is detected.

**Rationale:** A recovery operation must surface out-of-band edits instead of treating them as part of the harness's approved history.

### P1 — Persist structured reasoning for each gate verdict

**Files:** `lib/checks.js`, `lib/gate.js`, `lib/runner.js`, `lib/state.js`

The source already contains much of the information needed for an audit. `runChecks()` returns failure records with IDs, kinds, criticality, and messages, plus green-check and gap lists. `evaluateAttempt()` returns the shipping decision and relevant failure records.

However, the runner currently reduces rejected failures to `{kind, message}` before logging them. The `halt()` function also accepts `attemptLog` but does not use it.

**Change:** Preserve the structured result without changing the decision logic. Each attempted output should retain its check results, prior latch state, current status, LOC measurements, relevant caps, verdict, and halt reason.

An auditable check record should include at least:

- Check ID, failure kind, status, and message.
- Whether the check had previously been green.
- The transition that matters: `gap → green`, `green → regression`, or continued gap.
- Current LOC, previous LOC, ΔLOC, and applicable limits.
- Attempt number, output budget, and the final `ship`, `retry`, or `halt` verdict.

The event log should link these records to the verdict with a common `causalityId`. Keep this evidence in Node-managed state and logs; do not append it to model context or turn it into a model-generated stop decision.

**Rationale:** An auditor should be able to reconstruct the decision from recorded check results and the pure gate verdict.

### P1 — Make per-round usage represent actual spend

**Files:** `lib/runner.js`, `lib/state.js`, `dashboard/app.js`, `dashboard/index.html`

There is already global accounting in `state.usage` and per-shipped-round `tokens` and `usd` fields. The problem is that the per-round fields are populated from the single output that ultimately ships.

A round that uses three outputs, including two rejected proposals, is therefore charged globally but appears cheaper in the rounds table and cumulative-cost chart than it really was.

**Change:** Accumulate `{calls, inputTokens, outputTokens, usd}` for every round, across all successful provider responses, and write the total to `rounds[i].usage` for shipped rounds. Also persist usage for an active or halted round so that a reviewer can see the cost of a round that never shipped.

Do not make the rounds array contain failed rounds without first updating the code that assumes its final entry represents the last shipped checkpoint. A separate per-round usage record is a safer initial change.

**Rationale:** Costs need to be attributable to the work that consumed them, including retries and rejected proposals.

### P2 — Add `tship lint-rules`

**Files:** `lib/cli.js`, `lib/commands.js`, `lib/checks.js`

Add a read-only validator for `requiredSelectors`, `criticalSelectors`, and `forbiddenStrings`.

Warn when a configured selector is missing from the baseline tree or a forbidden string is already present there. The latter is especially useful because baseline forbidden strings are tracked specially: the current latch behavior does not provide a clear, durable baseline-gap report to the dashboard.

Use the recorded baseline commit when available, rather than assuming that the current working tree still represents the original baseline.

**Rationale:** Poorly calibrated rules should be visible before they are confused with a successful enforcement policy.

### P2 — Add a read-only gate dry run

**Files:** `lib/cli.js`, `lib/commands.js`, `lib/checks.js`, `lib/gate.js`

Add `tship dry-run` to execute the current verification logic and report the applicable verdict, failures, gaps, limits, and proposed halt reason.

It must not call a model, spend tokens, commit, roll back, write events, or change the persisted latch state. Pass a copy of the current latch into the check layer.

One qualification is important: this evaluates the **current tree**, not a future model proposal. It cannot predict the next proposal's LOC delta or verdict before that proposal exists.

**Rationale:** Developers can calibrate verification rules against a known tree without spending an output or mutating the repository.

### P2 — Add a provider contract test, not a hypothetical tool-call test

**Files:** `lib/providers/mock.js`, `lib/providers/anthropic.js`, `lib/providers/openai.js`, `test/`

The current providers normalize their results into the shape consumed by `runner.js`:

```js
{
  usage: { input, output },
  proposal: { summary, files }
}
```

The mock returns that object directly. Anthropic and OpenAI-compatible providers parse text responses into the same general shape.

The implementation does **not** currently use an Anthropic tool-call protocol or a shared JSON schema for tool arguments. A test claiming to compare those raw interfaces would not describe the actual architecture.

**Change:** Test the common normalized `step()` contract, including valid usage fields, proposal structure, malformed responses, and the two supported text-proposal formats.

**Rationale:** The deterministic mock and live adapters should exercise the same runner contract even though their raw API responses differ.

## Area 2 — First two diff sketches

### Sketch 1: Validate paths before proposal writes

```diff
--- a/lib/runner.js
+++ b/lib/runner.js
@@
 function applyProposal(root, proposal) {
   if (!proposal || !Array.isArray(proposal.files) || proposal.files.length === 0) {
     return 'proposal contained no files';
   }

   for (const f of proposal.files) {
     if (typeof f.path !== 'string' || !f.path ||
         f.path.includes('..') || path.isAbsolute(f.path)) {
       return `unsafe path in proposal: ${f.path}`;
     }
     if (typeof f.content !== 'string') return `file ${f.path} has no content`;
+
+    // New helper: validate against the real project root and reject
+    // existing symlink components before ANY proposal file is written.
+    assertNoSymlinkEscape(root, f.path);
   }

   for (const f of proposal.files) {
     const abs = path.join(root, f.path);
     fs.mkdirSync(path.dirname(abs), { recursive: true });
-    fs.writeFileSync(abs, f.content);
+    // Write a temporary sibling, then atomically replace the destination.
+    // Clean up the temporary file on failure.
+    writeProposalFileAtomically(abs, f.content);
   }
   return null;
 }
```

The helper implementations are new Node-only functions, not existing APIs. Path containment and symlink validation must be real checks, not just another string test. Ensure a failed write still reaches the existing orchestration rollback path.

### Sketch 2: Refuse unsafe resume state

```diff
--- a/lib/runner.js
+++ b/lib/runner.js
@@
   const target = targetRoot(root, cfg);
+  const dirty = git(target, [
+    'status', '--porcelain', '--untracked-files=all'
+  ]);
+
+  if (dirty) {
+    if (!flags.force || !state.run.lastGoodCommit) {
+      throw new Error(
+        `working tree has out-of-band changes:\n${dirty}\n` +
+        'Commit or remove them before resuming, or use --force to reset.'
+      );
+    }
+    resetHard(target, state.run.lastGoodCommit);
+  }
+
   const h = head(target);
   if (state.run.lastGoodCommit && h !== state.run.lastGoodCommit) {
```

The sketch assumes `git` is imported from `lib/gitops.js`, where it already exists as an exported helper. Keep `--force` explicitly destructive: it resets the target to the recorded checkpoint. Do not silently auto-commit dirty changes during resume.

The structured-rationale implementation should be made alongside the event-schema work in Area 3, so the same causal records serve the gate log, check trends, incident artifacts, and export.

---

# Area 3 — Observability and Reproducibility

## Prioritized triage

### P1 — Establish one causal event schema

**Files:** `lib/state.js`, `lib/runner.js`, `lib/checks.js`, `lib/gate.js`

Standardize newly written event records around:

```js
{
  ts,
  run,
  round,
  type,
  payload,
  causalityId
}
```

Use the core event types requested:

`agent-output`, `check-run`, `gate-verdict`, `halt`, `ship`, `kill`, `resume`, and `cost`.

Generate a `causalityId` for each attempt. The check-run records and the resulting gate-verdict record share it, letting a reviewer trace exactly which check results informed that verdict.

Some current lifecycle events—such as `milestone`, `manual-rollback`, and run start/completion—do not fit naturally into that closed list. Do not mislabel them as gate verdicts merely to satisfy an enum. Either explicitly permit additional lifecycle types or define a semantically appropriate lifecycle event type with a `payload.action`.

New event records should carry a run ID and timestamp. Historical records will lack some of these fields, so the dashboard should support the existing flat format as a legacy version rather than assuming all old JSONL lines already have `payload` and `causalityId`.

**Rationale:** The JSONL log needs to explain which run and attempt an event belongs to and how a particular failure led to a halt.

### P1 — Write a manifest for every run

**Files:** `lib/runner.js`, `lib/config.js`, optionally a new `lib/manifest.js`

Write a per-run manifest when a run starts. Store it separately for each run, for example:

```text
.tasteeship/
  runs/
    <run-id>/
      manifest.json
```

Include:

- Run ID and start time.
- Target repository's initial HEAD and baseline checkpoint commit.
- Hash of the `rules.md` contents actually injected into the provider context.
- Hash of the raw configuration and of the effective configuration after CLI overrides.
- Provider, model, and relevant non-secret request parameters.
- `outputsMax`, round limit, LOC cap, LOC-delta cap, and file cap.
- Node version and harness version or source revision where available.

Use Node's built-in `crypto` module for SHA-256. Do not copy API keys or credentials into the manifest.

The manifest should distinguish the **original HEAD** from the **baseline checkpoint** when a fresh run starts with uncommitted user work and the harness commits that work before proceeding.

**Rationale:** Reproducibility requires knowing the exact rules, limits, runtime, provider configuration, and repository checkpoint used by a run.

A manifest alone does not guarantee an identical result from a live model: an external provider may be stochastic or change behavior. For replayability, also preserve the actual proposal artifacts and their resulting gate decisions.

### P1 — Add per-check lifecycle trends

**Files:** `lib/checks.js`, `lib/state.js`, `lib/dashboard.js`, `dashboard/app.js`, `dashboard/index.html`

Use the standardized check-run records to populate a dashboard table showing each check's status across rounds.

It should distinguish:

- `gap`: failing before it has ever been green.
- `green`: passing.
- `regression`: a previously green check has become red.
- `overbuild`: an applicable budget or taste limit is violated.

Preserve the latch behavior already implemented in `checks.js`. In particular, do not treat every failure as a regression, and do not introduce new halt conditions just to populate the chart.

There is one implementation detail to address: `loc-delta-cap` is not currently included in `currentlyGreen` in `runChecks()`. Its per-round status can be recorded without changing its enforcement semantics into a latched functional check.

**Rationale:** The latch lifecycle is a core differentiator of the harness and should be inspectable, not merely described in documentation.

### P2 — Add a token/cost waterfall and latency metrics

**Files:** `lib/runner.js`, `lib/state.js`, `lib/providers/anthropic.js`, `lib/providers/openai.js`, `lib/providers/mock.js`, `dashboard/app.js`

Start with per-round input tokens, output tokens, calls, and actual cost, including rejected attempts.

Record elapsed provider-request time separately. The live providers currently await the complete response and parse JSON; they do not stream tokens. Therefore, genuine time-to-first-token is not currently available.

To measure actual TTFT, the live providers would need a streaming response path that records when the first token arrives. That can be implemented using the built-in `fetch` and response stream APIs, but it should be a separate change with its own contract tests.

The mock can provide deterministic simulated timings, but simulated TTFT should not be presented as a live-provider measurement.

**Rationale:** Separating token usage, total request time, and TTFT prevents the dashboard from presenting estimates as observed timings.

### P2 — Save an incident artifact on halt

**Files:** `lib/runner.js`, `lib/gitops.js`, `lib/state.js`

When a gate halts, create a run-local incident artifact containing the offending proposal diff, structured check results, the verdict, and the nearby event history.

This requires a deliberate ordering change. In the current loop, a rejected proposal is rolled back before `halt()` is called. After that reset, a Git diff against the failed attempt is no longer available.

Capture the proposal evidence before rollback, then persist the artifact after rollback in a location protected from the cleanup operation—for example, a run-local directory under the harness metadata.

Do not write incidents into `docs/evidence/` by default. That would modify the target project, could make evidence visible to later model rounds, and would mix run artifacts with project source.

The one-line root cause should be derived deterministically from the recorded halt reason and check results, not generated by the model.

**Rationale:** Every halt becomes a reusable, citable example without compromising the repository rollback.

### P2 — Add a read-only JSON export endpoint

**Files:** `lib/dashboard.js`, `lib/state.js`

Add `GET /api/export` to package the selected run's state, relevant event history, manifest, and associated evidence into downloadable JSON.

Use the existing HTTP server and filesystem functions. Validate the selected project and avoid including `.env.local`, keys, or other secrets. A JSON export is sufficient for the first implementation.

**Rationale:** A reviewer should be able to share the decision record without needing access to the original running machine.

A `.tar` export is not necessary for v1. If implemented later, it must be done without adding a runtime package, but implementing a custom archive format brings complexity without solving a higher-priority problem than the JSON export.

## Area 3 — First two diff sketches

### Sketch 1: Persist causal check runs and verdicts

The event writer should assign the timestamp and serialize a single schema. The runner supplies the run and round identity.

```diff
--- a/lib/state.js
+++ b/lib/state.js
@@
 export function appendEvent(root, event) {
   const file = eventsPath(root);
   fs.mkdirSync(path.dirname(file), { recursive: true });
-  fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
+  const record = {
+    ts: event.ts || new Date().toISOString(),
+    run: event.run ?? null,
+    round: event.round ?? null,
+    type: event.type,
+    payload: event.payload ?? {},
+    causalityId: event.causalityId ?? null,
+  };
+  fs.appendFileSync(file, JSON.stringify(record) + '\n');
 }
```

Then, around the existing check/gate evaluation in `lib/runner.js`:

```diff
+ const causalityId = randomUUID();
  const checks = runChecks(target, cfg, prevLoc, state.latched);
  const verdict = evaluateAttempt({
    checks,
    attemptNo,
    outputsMax,
    overbuildAction: state.run.overbuildAction,
  });

+ // Append check-run records derived from checks, including gaps,
+ // green status, failure IDs, and relevant LOC/cap measurements.
+ // Append one gate-verdict record with the same causalityId.
+ // Persist the halt/ship action separately when it actually occurs.
```

Use `randomUUID()` from Node's built-in `crypto` module. This sketch shows where to integrate the records; it is not a complete `checkResults` implementation.

The check-result serializer must preserve the gate's current behavior. It should not alter `evaluateAttempt()` or move the decision into the dashboard.

### Sketch 2: Record the effective run manifest

```diff
--- a/lib/runner.js
+++ b/lib/runner.js
@@
   state.run.lastGoodCommit = head(target);
+  if (fresh) {
+    state.baseline.commit = state.run.lastGoodCommit;
+
+    // New helper implemented with node:crypto and node:fs.
+    // Record the effective limits, provider/model, initial HEAD,
+    // baseline checkpoint, rules/config hashes, and Node version.
+    writeRunManifest(root, target, cfg, state);
+  }
   state.status = 'running';
```

The actual manifest writer needs to account for the current baseline creation flow: in a fresh run, `state.baseline` is first created from `baselineScan()`, while `state.run.lastGoodCommit` is set to the current HEAD immediately before the run enters the loop.

The manifest should be written only after the effective configuration, rules, and baseline checkpoint are known. On resume, keep the original manifest intact rather than replacing it with a manifest of the resumed environment.

---

# Invariant Review — Changes to Drop or Constrain

These constraints are non-negotiable for this repository.

### 1. No runtime dependency expansion

The current `package.json` has no runtime dependencies, and the implementation already has the primitives needed for the proposed work.

Use:

- `node:fs` and `node:path` for state, manifests, and artifacts.
- `node:crypto` for hashes and causal IDs.
- `node:child_process` through the existing Git helper for diffs and checkpoint queries.
- `node:http` for read-only APIs and the dashboard.
- Native SVG, HTML, CSS, and JavaScript for chart interaction and the UI.
- Native `fetch`, `AbortController`, and streams for provider transport work.

**Drop proposals to add charting libraries, diff packages, framework dependencies, or an npm archive package.** None is necessary to ship the priorities above.

### 2. No stop decision moves into the model

`evaluateAttempt()` and `evaluateProtocolError()` must remain the decision logic. `runner.js` continues to own dispatching, retry budgets, halt handling, rollback, and kill behavior.

The following are safe because they are read-only or observational:

- A dry run that invokes the existing Node checks and gate.
- A lint command that warns about rule calibration.
- A structured explanation persisted after Node has made the decision.
- A dashboard that displays recorded decisions.
- A deterministic incident summary derived from check IDs and halt reasons.

The following should be dropped:

- Asking the model whether a run should halt.
- Allowing model-written root-cause text to determine the verdict.
- Moving stop rules into `rules.md` or the provider prompt.
- Letting dashboard filters, chart interaction, or client-supplied diff references influence enforcement.
- Sending new observability records back into the model context as an authority over stop decisions.

The log can explain the gate's decision; it must never become the mechanism that makes the decision.

### 3. Do not invent a nonexistent provider protocol

There is no current Anthropic tool-call contract or shared JSON schema for tool arguments in this codebase. The providers parse responses into the shared `{usage, proposal}` envelope.

**Drop the proposed parity test if it assumes the current mock emits tool-call responses or uses the same raw API envelope as Anthropic.** Test the normalized provider output consumed by the runner instead.

### 4. Keep historical records compatible

The current JSONL event format is already deployed in existing evidence. A new event schema should not make that evidence unreadable.

Normalize legacy records when displaying or exporting them, and make it clear when older records lack a run ID, causality ID, or structured payload.

---

# Consolidated “Ship Now” Checklist

The minimal release should prioritize a secure and auditable harness over implementing every dashboard feature immediately.

## P0 — Protect the execution boundary

- [ ] Bind the dashboard to loopback by default.
- [ ] Validate request origins for the KILL endpoint.
- [ ] Sandbox the preview iframe without same-origin privileges.
- [ ] Prevent `/api/pf` from serving secrets and harness-private directories.
- [ ] Reject proposal paths that traverse symbolic links outside the target tree.
- [ ] Validate all proposal writes before applying the first write.
- [ ] Add tests for filesystem-boundary violations and preview isolation.

## P1 — Make recovery safe

- [ ] Check `git status --porcelain --untracked-files=all` before resuming.
- [ ] Refuse to resume over uncommitted or untracked changes without explicit user action.
- [ ] Preserve the recorded checkpoint as the authoritative recovery target.
- [ ] Test both a modified tracked file and an untracked file with an unchanged HEAD.

## P1 — Make gate decisions auditable

- [ ] Add timestamps and run IDs to event records.
- [ ] Introduce the canonical event schema and `causalityId`.
- [ ] Record check IDs, failure kinds, latch transitions, LOC values, limits, and gate verdicts.
- [ ] Preserve every attempt's decision record, including rejected proposals and the final halted attempt.
- [ ] Add an explicit shipment event for every shipped round.
- [ ] Keep older event records readable.

## P1 — Make each run identifiable and reproducible

- [ ] Persist the baseline checkpoint commit in state.
- [ ] Write one manifest per run, containing effective configuration and rules hashes, provider/model identity, run limits, and Node version.
- [ ] Do not persist credentials in manifests or event records.
- [ ] Preserve the original manifest through resume.
- [ ] Record proposal artifacts or their retrievable equivalents so a run can be explored without repeating provider calls.

## P1 — Make the dashboard useful for an audit

- [ ] Populate the gate log from the append-only event log rather than the capped in-memory array.
- [ ] Add event-type filters, a bounded tail-size control, timestamps, and round-jump behavior.
- [ ] Add the read-only snapshot-diff endpoint using commits derived from recorded state.
- [ ] Display actual per-round usage, including rejected attempts and halted rounds.
- [ ] Add accessible status announcements and keyboard-operable review controls.

## P2 — Add the richer observability layer

- [ ] Add per-check trends that accurately represent gap, green, regression, and overbuild states.
- [ ] Add SVG crosshairs, cost/LOC tooltips, and a halt marker.
- [ ] Add the before/after split preview.
- [ ] Implement exponential SSE reconnection and a visible connection state.
- [ ] Add latency metrics; implement true TTFT only when provider streaming is supported.
- [ ] Persist halt incidents after capturing the rejected proposal's evidence and before losing that evidence to rollback.
- [ ] Add read-only JSON export, excluding secrets.
- [ ] Refine phone-sized layouts and accessibility without introducing a framework.

## Final recommendation

**Ship the security boundary fixes, resume hardening, causal event records, and per-run manifest first.** Those changes strengthen the guarantees on which the rest of the harness depends.

Then implement the filterable log and Git-backed diff drawer. Together, those give a reviewer a meaningful path from a halted run to the exact attempt, the checks that failed, the gate's decision, the relevant repository changes, and the configuration under which the decision occurred.

The remaining UI improvements are valuable, but they should be built on that trustworthy record—not ahead of it.







# tastee-ship review & hardening

Read before judging: `package.json`, `lib/runner.js`, `gate.js`, `checks.js`, `state.js`, `gitops.js`, `dashboard.js`, `milestones.js`, `costs.js`, `config.js`, `loc.js`, `cli.js`, `commands.js`, `lib/providers/{anthropic,openai,mock,index}.js`, `dashboard/{index.html,app.js,style.css}`, `test/{smoke.js,helpers.js}`, `README.md`, `docs/VALIDATION.md`. The clone is in the workspace at `tastee-ship/` if you want to diff against live code.

**Two premises in the brief corrected against the code** (matters for how Area 1 / Area 3 items are built):

1. **There is no "full gateEvents array."** `gateEvent()` trims `state.gateEvents` to the last 500 ([state.js:60](tastee-ship/lib/state.js#L60)) and `/api/events` caps at 300 ([dashboard.js:67](tastee-ship/lib/dashboard.js#L67)). The only complete log is `events.jsonl` itself — so log filtering needs a full read *endpoint change*, not just UI work.
2. **`state.gateEvents` entries have no `ts`.** `gateEvent()` pushes `{type, round, message}` and only stamps `ts` into events.jsonl, so the in-page log renders blank timestamps today (`(e.ts || '').slice(11,19)` in [app.js:84](tastee-ship/dashboard/app.js#L84)). One-line fix folded into the P0 below.

Bonus findings from reading (folded into triage): the loop's state and gate code match the brief accurately (gate is pure, enforcement is Node-side, kill is out-of-band) — no invariant violations found in the *existing* code.

---

## Area 1 — Dashboard UI

| P | Change | File(s) | Rationale |
|---|--------|---------|-----------|
| **P0** | Gate log: full-event read path + type filters + tail-N + click-to-jump. Filters keyed to *actual* event types (`attempt-rejected`, `overbuild-flag`, `halt`, `protocol-error`, `killed`, `milestone`, lifecycle) — the brief's labels (`overbuild/regression/outputs-max`) are halt *reasons*, not log types. Also stamp `ts` on state-side events. | [state.js](tastee-ship/lib/state.js), [dashboard.js](tastee-ship/lib/dashboard.js), [app.js](tastee-ship/dashboard/app.js) | Today filtering is impossible (both arrays trimmed) and timestamps render blank; the log is the audit surface, it should be first. |
| **P0** | SSE: exponential backoff + jitter, `RECONNECTING` chip state, last-event age. | [app.js](tastee-ship/dashboard/app.js), [index.html](tastee-ship/dashboard/index.html), [style.css](tastee-ship/dashboard/style.css) | The KILL button is a safety control operated off this stream; a fixed 2s retry hides outages from the operator. |
| **P1** | Rounds **diff drawer**: new read-only `GET /api/snapshot-diff?project&round=N` → `git diff --numstat <sha>^ <sha>` rows (file, +, −). Note: `lib/gitops.js` has **no diff helper** (the brief said "if present") — add `diffStat()` on top of the existing `git()` wrapper rather than raw `child_process`. Per-round checkpoints are clean diff units because rejected attempts are `resetHard`-discarded *before* commit. | [gitops.js](tastee-ship/lib/gitops.js), [dashboard.js](tastee-ship/lib/dashboard.js), [app.js](tastee-ship/dashboard/app.js) | Verdicts without the change behind them aren't auditable; numstat is one git call, zero deps. |
| **P1** | Chart crosshair + tooltip (round, LOC, ΔLOC, cost, verdict) + **halt marker**. `drawLine()` is index-based (`x(i)`), so a halt in `rounds.length + 1` would clip — switch the x-domain to round numbers and mark the halt round from the `halt` event. | [app.js](tastee-ship/dashboard/app.js#L102-L118) | Makes the over-build halt legible without scrolling the log; coords map trivially via `getBoundingClientRect` (viewBox is stretched, not uniform). |
| **P1** | A/B split view: second iframe + a "before" select pinned to a chosen round; both frames use the existing `/api/snapshot`. | [index.html](tastee-ship/dashboard/index.html), [app.js](tastee-ship/dashboard/app.js), [style.css](tastee-ship/dashboard/style.css) | Comparing N vs M today means scrubbing back and forth; reuses an existing endpoint untouched. |
| **P2** | A11y: chip gets `role="status" aria-live="polite"`; scrubber gets `aria-valuetext` (native range supports it) with the round label; tables get roving-tabindex row selection (Enter = select → diff drawer); KILL keeps icon **and** text (already has both — add `aria-label` spelling out the rollback consequence). | [index.html](tastee-ship/dashboard/index.html), [app.js](tastee-ship/dashboard/app.js), [style.css](tastee-ship/dashboard/style.css) | Colour-only states fail screen readers and colour-blind operators on the most dangerous control in the app. |
| **P2** | KILL error path: `if (res.ok)` silently ignores failure (e.g. `stopRun` throws "no run to stop" → 500). Show `KILL FAILED` + the error text. | [app.js](tastee-ship/dashboard/app.js#L152-L159) | A failed kill being visually identical to no click is a safety hole. |
| **P2** | Responsive refinement (don't build from scratch — a `@media (max-width: 900px)` already exists): add ≤560px rules (narrow `#project`, table horizontal scroll, 300px iframe), let the A/B split stack. | [style.css](tastee-ship/dashboard/style.css#L159-L162) | Statbar/charts already reflow via `auto-fit`; only small-viewport overflow is broken. |

### Sketch 1 — gate log: full read + filters + jump (P0)

```js
// state.js — full read path (events.jsonl is the durable log; state copy stays trimmed)
export function readEvents(root, n = Infinity) {
  const file = eventsPath(root);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return { ts: null, type: 'corrupt', message: l }; } });
}

// state.js — gateEvent gains ts + optional structured payload (Area 2/3 reuse this)
export function gateEvent(root, state, type, round, message, payload = null) {
  const e = { ts: new Date().toISOString(), type, round, message, ...(payload ? { payload } : {}) };
  state.gateEvents.push(e);                                    // appendEvent already adds ts to the file
  if (state.gateEvents.length > 500) state.gateEvents = state.gateEvents.slice(-500);
  appendEvent(root, e);
}
```

```js
// dashboard.js
case '/api/events': return json(res, readEvents(project, Number(url.searchParams.get('n')) || 2000));
```

```js
// app.js — filters derive from the endpoint result, not state.gateEvents
const LOG_TYPES = ['attempt-rejected', 'overbuild-flag', 'halt', 'protocol-error', 'killed', 'milestone', 'lifecycle'];
let logFilter = new Set(), logTail = 150, allEvents = [];
function renderLog() {
  const shown = allEvents.filter((e) => !logFilter.size || logFilter.has(e.type)).slice(-logTail).reverse();
  $('log').innerHTML = shown.map((e) => `
    <li class="ev-${e.type}" data-round="${e.round ?? ''}" tabindex="0">
      <span class="t">${e.type}</span><span class="r">r${e.round ?? '-'} ${(e.ts || '').slice(11, 19)}</span>${escapeHtml(e.message || '')}
    </li>`).join('');
}
// click-to-jump: scroll the rounds table to the event's round
$('log').addEventListener('click', (ev) => {
  const li = ev.target.closest('li[data-round]'); if (!li || !li.dataset.round) return;
  document.querySelector(`#rounds tbody tr[data-round="${li.dataset.round}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
});
// renderRounds(): add data-round="${r.round}" to each <tr>; refresh allEvents via api('/api/events')
```

UI: one checkbox-chip per `LOG_TYPES` toggle in `logFilter`, plus a `Tail <select>` (50/150/500/all) bound to `logTail`. HTML: `<fieldset id="log-filters" aria-label="filter gate log">`.

### Sketch 2 — SSE backoff + RECONNECTING (P0)

```js
// app.js — replace connect() entirely
let attempt = 0;
function connect() {
  const es = new EventSource(`/api/stream?project=${encodeURIComponent(projectInput.value)}`);
  es.onopen = () => { attempt = 0; /* chip renders from next state event */ };
  es.addEventListener('state', (ev) => { attempt = 0; render(JSON.parse(ev.data)); });
  es.onerror = () => {
    es.close();
    attempt++;
    const delay = Math.min(30_000, 500 * 2 ** (attempt - 1)) + Math.random() * 250; // exp + jitter
    const chip = $('gate-chip');
    chip.className = 'chip reconnecting';
    chip.textContent = `RECONNECTING (${attempt})`;
    setTimeout(connect, delay);
  };
}
```

```css
/* style.css */
.chip.reconnecting { background: #33290f; color: var(--warn); box-shadow: 0 0 0 1px #6e4c1c; }
```

Chip while streaming stays gate-driven; add `data-last-event` span fed from `state.updatedAt` → "last update 4s ago" in the statbar. Chip becomes `role="status" aria-live="polite"` (P2 a11y item folds in here).

---

## Area 2 — Harness engineering niceties

| P | Change | File(s) | Rationale |
|---|--------|---------|-----------|
| **P0** | **Reasoning trace**: attach structured `payload` to verdict events — tripped check ids + kinds, `gaps`, `green`, `loc` vs `locCap`, `locDelta` vs `locDeltaCap`, `attemptNo/outputsMax`. Composition happens in the *runner* (it owns `cfg` + `checks` + `verdict`); `gate.js` stays pure. Emits already exist at the exact points ([runner.js:322-334](tastee-ship/lib/runner.js#L322-L334)). | [state.js](tastee-ship/lib/state.js), [runner.js](tastee-ship/lib/runner.js) | Today the log line is `[overbuild] total LOC 4213 exceeds cap 4000` — one message, no gaps/green/budget context; the sketch in Area 1 already extends `gateEvent` to carry payload. |
| **P0** | **Per-round usage first-class**: `rounds[i].usage = {calls, inputTokens, outputTokens, usd}` summed across *all attempts in the round*. Found while reading: today `rounds[i].usd/tokens` is only the **single shipping attempt's** cost ([runner.js:277](tastee-ship/lib/runner.js#L277), [314-315](tastee-ship/lib/runner.js#L314-L315)) — rejected attempts' spend exists only in the global counter, so global vs per-round numbers don't reconcile. Keep legacy fields; teach `runReport` and the rounds table to prefer `r.usage?.usd ?? r.usd`. | [runner.js](tastee-ship/lib/runner.js), [commands.js](tastee-ship/lib/commands.js), [app.js](tastee-ship/dashboard/app.js) | It's an actual accounting bug, not just visibility; "which round blew the budget" is unanswerable today (max 1 attempt of cost per round is recorded). |
| **P1** | `tship dry-run` (also `--explain`-able later): load config + `baselineScan`/`runChecks` on the current tree with a **fresh latch**, call the existing pure `evaluateAttempt`, print verdict + tripped ids, exit non-zero on would-halt. **No provider step, no writes, no `saveState`** — it's pure composition of exported functions. | [cli.js](tastee-ship/lib/cli.js), [commands.js](tastee-ship/lib/commands.js) (+ small `lib/dryrun.js`) | Calibrating `rules.md` today costs a full round of provider calls; every input this needs (`runChecks`, `evaluateAttempt`, `readRules`) is already exported. |
| **P1** | **Resume hardening**: in `resumeRun`, alongside the existing HEAD-vs-checkpoint check, also refuse when `!isClean(target)` (untracked + uncommitted) unless `--force`. Important detail found reading: `resetHard()` runs `git clean -fd` ([gitops.js:56-59](tastee-ship/lib/gitops.js#L56-L59)) — so a dirty tree today isn't just mis-resumed, the `--force` path *deletes* out-of-band files; and a *clean-HEAD*-but-dirty resume would otherwise get silently absorbed into the next baseline checkpoint by `executeRun`'s `commitAll`. | [runner.js](tastee-ship/lib/runner.js#L146-L163) | SHA equality ≠ same work; a human's uncommitted afternoon can vanish via `clean -fd`. |
| **P2** | `tship lint-rules`: warn when `verify.requiredSelectors/criticalSelectors` don't match anything in the baseline HTML (`selectorPresent` over the entry tree), when a `forbiddenStrings` entry is already present at baseline (it will latch as a *gap until fixed* — say so explicitly), missing `rules.md`, missing `costs` entry for the configured model, `locDeltaCap ≤ 0`, etc. | [commands.js](tastee-ship/lib/commands.js) | Misconfigured taste currently only surfaces as surprising gate behavior at round N; all inputs are already computed by `baselineScan`. |
| **P2** | **Mock↔live parity contract test** (`test/contract.js`, offline): assert every provider's `step` result shape ≡ `{usage:{input, output}, proposal:{summary, files:[{path, content}]}}` (mock directly; anthropic/openai via `parseProposal` fixtures + envelope assertion around a stubbed fetch) — plus `err.protocolError` set on unparseable output. | `test/contract.js`, [providers/*](tastee-ship/lib/providers) | `docs/evidence/` was produced with the mock; nothing today fails if a real provider's envelope drifts. Matches the repo's hand-rolled `ok()` test style — no test framework dep. |
| P2 (drive-by) | `openai.js` has a duplicated empty-content / reasoning-only block ([openai.js:50-59](tastee-ship/lib/providers/openai.js#L50-L59)); `docs/VALIDATION.md` says `npm run validate:live` but the script is `npm run live` ([package.json](tastee-ship/package.json)). | [openai.js](tastee-ship/lib/providers/openai.js), [VALIDATION.md](tastee-ship/docs/VALIDATION.md) | Dead code + a doc command that fails when followed. |

### Sketch 1 — reasoning trace on verdict events (P0)

```js
// runner.js — in the loop, after runChecks/evaluateAttempt (before the ship branch)
const attemptId = `${state.run.id}-r${round}-a${attemptNo}`;   // hoist: already used for commits on ship
const failureTrace = () => ({
  tripped: verdict.failures.map((f) => ({ id: f.id, kind: f.kind, critical: !!f.critical, message: f.message })),
  gaps: checks.gaps, green: checks.green,
  loc: checks.loc, locCap: cfg.verify.locCap ?? null,
  locDelta: checks.locDelta, locDeltaCap: cfg.verify.locDeltaCap ?? null,
  attemptNo, outputsMax, overbuildAction: state.run.overbuildAction,
});

if (verdict.ship) {
  // ...existing ship path unchanged; add:
  gateEvent(root, state, 'verdict-shipped', round, flags.length ? flags.join('; ') : 'all checks green', failureTrace());
} else {
  resetHard(target, preHead);
  // ...existing attemptLog/rollback code; the existing event gains the trace:
  gateEvent(root, state, 'attempt-rejected', round, failures.map((f) => `[${f.kind}] ${f.message}`).join('; '), failureTrace());
}
```

Note what this deliberately **doesn't** do: nothing new from `gate.js` moves toward the model. The only model-visible feedback stays the existing bounded `lastFailures` list in `buildUserMessage` ([anthropic.js:77-83](tastee-ship/lib/providers/anthropic.js#L77-L83)).

### Sketch 2 — per-round usage (P0)

```js
// runner.js — top of each round iteration
let roundUsage = { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 };
const bump = (u, usd) => { roundUsage.calls++; roundUsage.inputTokens += u.input || 0;
                           roundUsage.outputTokens += u.output || 0; roundUsage.usd += usd; };

// existing accumulation site becomes:
const usd = costOf(state.run.model, out.usage, cfg.costs);
state.usage.calls += 1; state.usage.inputTokens += out.usage.input || 0;
state.usage.outputTokens += out.usage.output || 0; state.usage.usd += usd;
bump(out.usage, usd);                              // NEW — same numbers, per-round scope

// on ship (rounds.push — legacy keys kept for report/dashboard back-compat):
state.rounds.push({ round, attempts: attemptNo, shipped: true, loc: checks.loc,
  locDelta: checks.loc - prevLoc, tokens: (out.usage.input || 0) + (out.usage.output || 0), usd,
  usage: { ...roundUsage },                        // NEW — first-class per-round totals
  verdict, flags, failures: [], summary: out.proposal.summary, commit });

// on halt / outputs-max exhaustion, right before returning from halt():
gateEvent(root, state, 'round-cost', round, `${roundUsage.calls} calls · ${roundUsage.usd.toFixed(4)} USD`, { usage: roundUsage });
```

Dashboard/statbar: `$('st-round-cost')` cell = `fmtUsd(currentRound.runningUsage)` (sent via SSE state), rounds table `$` column prefers `r.usage?.usd`. `runReport` header line unchanged, per-round line uses `fmtUsd(r.usage?.usd ?? r.usd)`.

---

## Area 3 — Observability

| P | Change | File(s) | Rationale |
|---|--------|---------|-----------|
| **P0** | **Run manifest**: at `executeRun` start (fresh runs; rewritten with `resumedAt` on resume) write `.tasteeship/manifest.json` — git HEAD, sha256 of `rules.md` and `config.json` (`node:crypto`), provider/model, `outputsMax/roundsMax/locCap/locDeltaCap/maxFiles`, `process.version`, `startedAt`. Never hash `.env.local` (keys live there). | new `lib/manifest.js`, [runner.js](tastee-ship/lib/runner.js), [state.js](tastee-ship/lib/state.js) (expose path via `config.js`) | Same-manifest ⇒ same expected outcome; makes every `docs/evidence/*.json` entry reproducible and diffable. |
| **P0** | **Structured events**: standardise jsonl records to `{ts, run, round, type, payload, causalityId}`; emit `check-run` + `gate-verdict` per attempt keyed by the **same `attemptId` already embedded in commit messages** ([runner.js:302](tastee-ship/lib/runner.js#L302)) — that's the causality link, and it's why P0 #1's trace and this share one schema. | [state.js](tastee-ship/lib/state.js), [runner.js](tastee-ship/lib/runner.js) | `events.jsonl` is already the seam; today it's `{ts, type, round, message}` — a halt cannot be reconstructed from it. |
| **P1** | **Halt incident artifact**: `halt()` (signature gains the last `proposal`) writes `.tasteeship/incidents/halt-r{round}-{ts8}.json` — root cause (first tripped failure), tripped checks w/ numbers, offending proposal, `gateEvents` window (~12 events). Auto-minor: `killNow` deliberately gets no proposal — the kill artifact is just state + window. | [runner.js](tastee-ship/lib/runner.js#L428-L440) | Every halt becomes a citable `README`/validation example; costs ~20 lines; harness-side only. |
| **P1** | **Per-check latch trend panel**: derive client-side from `check-run` events — one row per check id, one cell per round (gap ▢ · green ✓ · red ✕ · halt ⛔), states from `payload.green/gaps/failures`. Note for the implementer: `loc-delta-cap` never enters the latch today (`currentlyGreen` in [checks.js:141-148](tastee-ship/lib/checks.js#L141-L148) omits it — it's always blocking as an overbuild) — document that in the panel legend rather than changing latch semantics. | [dashboard.js](tastee-ship/lib/dashboard.js) (event feed), [app.js](tastee-ship/dashboard/app.js) | Makes `checks.js`' gap→green→regression lifecycle (the repo's core mechanism) visible without reading state. |
| **P1** | **`/api/export`**: read-only GET → single JSON `{manifest, state, events}` with `content-disposition: attachment`, reusing `readEvents` + `loadState` + `manifest.json`. Keep a `?format=tar` as a later option — hand-rolled tar is stdlib-only (~50 lines of 512-byte headers) but not worth it first. | [dashboard.js](tastee-ship/lib/dashboard.js) | A completed run becomes shareable as one file; **no** external archiver dep (that's the line the invariant draws). |
| **P2** | **Cost & token waterfall**: providers timestamp request→headers (`ttfbMs`) and completion (`tookMs`), added to the envelope; mock simulates latency from its profile (deterministic, keep tiny); runner emits per-attempt token/latency into the round-cost payload; dashboard histogram. | [anthropic.js](tastee-ship/lib/providers/anthropic.js), [openai.js](tastee-ship/lib/providers/openai.js), [mock.js](tastee-ship/lib/providers/mock.js), [runner.js](tastee-ship/lib/runner.js) | Separates "model over-thinking" from over-build halts. Ship **after** the parity contract test since it touches the shared envelope. |

### Sketch 1 — run manifest (P0)

```js
// lib/manifest.js (new)
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { harnessPath } from './config.js';
import { head, isRepo } from './gitops.js';

export function writeManifest(root, cfg, state, target) {
  const sha = (p) => fs.existsSync(p) ? createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16) : null;
  const manifest = {
    run: state.run?.id ?? null,
    gitHead: isRepo(target) ? head(target) : null,
    rulesSha256: sha(path.resolve(root, cfg.taste?.rulesFile || 'rules.md')),
    configSha256: sha(harnessPath(root, 'config.json')),
    provider: `${cfg.provider.name}/${cfg.provider.model}`,
    caps: { outputsMax: cfg.runner.outputsMax, roundsMax: cfg.runner.roundsMax,
            locCap: cfg.verify.locCap ?? null, locDeltaCap: cfg.verify.locDeltaCap ?? null,
            maxFiles: cfg.verify.maxFiles ?? null },
    node: process.version,
    startedAt: state.run?.startedAt ?? new Date().toISOString(),
  };
  fs.writeFileSync(harnessPath(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
```

```js
// runner.js — executeRun, right after `writePid(root, process.pid);`
writeManifest(root, cfg, state, target);          // and gateEvent(root, state, 'manifest', 0, head(target))
```

### Sketch 2 — structured events with causalityId (P0)

```js
// state.js — new emitter; append-only file is authoritative, state keeps a compact mirror
export function emit(root, state, { type, round, message = '', payload = null, causalityId = null }) {
  const e = { ts: new Date().toISOString(), run: state.run?.id ?? null, round,
              type, message, payload, causalityId };
  appendEvent(root, e);                            // appendEvent already stamps ts; spread order keeps the richer record
  state.gateEvents.push({ ts: e.ts, type, round, message });   // trimmed mirror, unchanged budget
  if (state.gateEvents.length > 500) state.gateEvents = state.gateEvents.slice(-500);
  return e;
}
```

```js
// runner.js — inside the loop, immediately after runChecks/evaluateAttempt
const attemptId = `${state.run.id}-r${round}-a${attemptNo}`;      // hoisted from the ship branch — same id as the commit msg
emit(root, state, { type: 'check-run', round, causalityId: attemptId,
  payload: { attemptNo, pass: checks.pass, failures: checks.failures, gaps: checks.gaps,
             green: checks.green, loc: checks.loc, locDelta: checks.locDelta } });
emit(root, state, { type: 'gate-verdict', round, causalityId: attemptId,
  payload: { attemptNo, ship: verdict.ship, halt: verdict.halt,
             flags: verdict.flags.map((f) => f.message) } });
```

Cost: ~15 lines. Causality reconstruction is then trivial: `grep causalityId events.jsonl` → the check-runs that produced a verdict that produced a halt. `kill`/`resume`/`cost` emit at their already-existing `gateEvent` sites with `type` swapped.

---

## Invariant violations — call-outs and drops

- **No new runtime dependencies required by anything above.** Everything proposed uses `node:fs`, `node:http`, `node:crypto`, `node:child_process` (via the existing `git()` wrapper), `AbortController`, and vanilla DOM. The one borderline ask — "downloadable **.tar**" — is deliberately downgraded to a JSON bundle; if a tar is later required, hand-roll it (~50 lines, stdlib only). **Drop the archiver/tar-package version of that idea.**
- **No stop-decisions drift toward the model.** `dry-run` and `lint-rules` are pre-run, Node-side composition of existing exported checks; the reasoning trace, structured events, and incident artifacts are written *after* verdicts by the loop. Hard rule for implementation: **do not** feed the new payload/trace/latch internals into `buildUserMessage` — the model keeps receiving only the existing bounded `lastFailures` feedback. The halt-incident artifact is evidence for humans, never model context.
- **Adjusted, not dropped**: "derive log state from the full `gateEvents` array" → the array is capped at 500; the endpoint reads `events.jsonl` instead (events file remains the authoritative, unbounded log).
- **Corrected**: "reuse lib/gitops diff if present" → not present; `diffStat()` is a 6-line addition on top of the existing `git()` helper.

---

## "Ship now" checklist

Minimal set; every line is zero-dep, Node-side, and leaves `gate.js`'s verdict logic untouched. Roughly a day of work, ordered by dependency:

1. **[state.js]** `gateEvent` gains `ts` + optional `payload`; add `readEvents(root, n)`. *(foundation for items 2, 4, 5)*
2. **[runner.js]** Emit reasoning traces on `verdict-shipped`/`attempt-rejected`; add per-round `usage` accounting (+ legacy fields kept); hoist `attemptId` for causality.
3. **[runner.js + lib/manifest.js]** Write `manifest.json` at run start / resume (git HEAD, rules+config hashes, caps, Node version).
4. **[dashboard.js]** `/api/events` → full read with `?n=`; add read-only `/api/snapshot-diff` (numstat via new `gitops.diffStat`); add `/api/export` (JSON bundle).
5. **[dashboard/app.js + index.html + style.css]** SSE backoff + `RECONNECTING` chip + last-update display; gate-log type filters, tail-N, click-to-jump (fixes blank timestamps too); halt marker + crosshair on the charts; `role="status" aria-live` on the chip; `aria-valuetext` on the scrubber; KILL-failure surfacing.
6. **[tests]** Extend `test/smoke.js` conventions: assert manifest contents, structured-event schema (`causalityId` present on `check-run`/`gate-verdict`), `rounds[i].usage.calls === sum of attempts`; add `test/contract.js` for provider envelope parity + `parseProposal` fixtures.
7. **[docs]** One-line fix: `npm run validate:live` → `npm run live` in `<docs/VALIDATION.md>`.

Deliberately *not* in the first ship (P1/P2 backlog): A/B scrubber, diff drawer UI polish, per-check trend panel, halt incident snapshots, token waterfall, lint-rules — all specified above with file targets, none blocked architecturally once items 1–4 land.



