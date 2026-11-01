# Research: harness architecture & kill-switch/recovery patterns

Read before building (per the project brief). Sources are the brief's footnotes
plus corroborating 2026 references found while researching.

## 1. Five-layer harness architecture — harness-engineering.ai

Sources:
- <https://harness-engineering.ai/blog/agent-harness-architecture-how-the-system-works-under-the-hood>
- <https://harness-engineering.ai/blog/agent-harness-complete-guide>
- <https://harness-engineering.ai/blog/ai-agent-governance-best-practices-for-production-environments>

Key findings, and how they landed in tasteeship:

| Finding | Where it landed |
| --- | --- |
| A request flows through five layers on every step: **orchestration** (calls the model), **context management** (prepares what the model sees), **tool integration** (executes/normalizes), **verification** (validates; retries or escalates), **operations** (monitors, measures, controls) | `lib/runner.js` (orchestration), context assembly in `executeRun`/`loop`, proposal application in `applyProposal`, `lib/checks.js` (verification), usage/cost/event log in `lib/state.js` + `lib/costs.js` (operations) |
| "The harness decides what the model sees, what it can do, when it should stop, and what happens when things go wrong" — invest in the harness, not the model | The `outputs_max` gate and all halt logic live in `lib/gate.js` + `lib/runner.js`, never in the prompt |
| Governance constraints "are not prompt instructions… enforced in the harness layer, evaluated before the tool call reaches the underlying system. The agent cannot reason its way around them because the agent never sees the enforcement decision" | The stop file, the budget counter, and check verdicts are Node-side. The agent is simply *not called* once the budget is spent |
| Frameworks cover layers 1–3; **verification and operations usually require custom implementation** | `lib/checks.js` and the usage/event/state store are hand-rolled, no framework |
| User keys & taste are injected context | `rules.md` (taste) is assembled into context every round; keys are loaded from the project's `.env.local` only for the API call (`lib/keys.js`, `lib/providers/anthropic.js`) |

## 2. Kill switches, escalation, recovery — codebridge.tech

Sources:
- <https://www.codebridge.tech/articles/ai-agent-guardrails-for-production-kill-switches-escalation-paths-and-safe-recovery>
- <https://www.codebridge.tech/articles/how-to-test-agentic-ai-before-production-a-practical-framework-for-accuracy-tool-use-escalation-and-recovery>

Key findings, and how they landed:

| Finding | Where it landed |
| --- | --- |
| A kill switch must stop the agent **without the agent's cooperation**; stopping is only half the problem — you must also restore state without data loss or duplicate actions | `tship stop` / dashboard KILL write a stop flag and SIGTERM the runner; the runner aborts in-flight calls via `AbortController` and rolls back — the model is never consulted (`lib/runner.js` `killNow`) |
| Recovery mode 1: **resume from checkpoints** (state persistence + versioned environments to restore last known good configuration) | One git checkpoint commit per shipped round + atomic `state.json` write per step; `tship resume` continues from the recorded round |
| Recovery mode 2: **idempotent retries** — steps can be repeated without side effects | Proposals are full-content file writes onto a checkpointed tree; rejected/killed attempts are discarded with `git reset --hard` + `clean` to the pre-round commit, so re-running an attempt is side-effect free |
| Recovery mode 3: **compensation patterns** where direct rollback is impossible | Not needed for a local git-backed site: commit-per-round makes direct rollback total. Documented as the v1 trade-off |
| "Confirm that kill-switch, override, or deactivation controls work safely under real failure conditions" | Kill-switch drill is an asserted test (`test/smoke.js` §3, `test/run-validation.js` run 4): killed mid-round, tree rolled back, resumed to completion |

## 3. Agentic Harness Engineering (AHE) — arXiv:2604.25850

Source: <https://arxiv.org/abs/2604.25850>

| Finding | Where it landed |
| --- | --- |
| **Component observability** — every editable component gets a file-level representation; edits are revertible | Harness components are small single-purpose modules; every agent change is a revertible git checkpoint |
| **Experience observability** — raw trajectories distilled into a drillable evidence corpus | `.tasteeship/events.jsonl` + `gateEvents` in state; the dashboard's gate log renders them |
| **Decision observability** — each decision paired with a falsifiable prediction checked against outcomes | The gate logs every decision (`attempt-rejected`, `overbuild-flag`, `halt`, `killed`) with the check messages that justified it, so any halt can be audited against the verification layer |

## 4. CLI-99 textbook — cli99.github.io (dead link)

The footnote URL redirects to a personal site with no CLI-harness content
(<https://chengli.netlify.app/>). Noted per the brief's instruction to do
independent research; substituted the two 2026 references below.

## 5. Corroborating 2026 sources (found independently)

- **DigitalApplied, "Agent Rollback and Checkpoint Patterns: A Reference"** — <https://www.digitalapplied.com/blog/agent-rollback-checkpoint-patterns-2026-engineering-reference>
- **arXiv:2608.29381, "Safe to Resume? Breaking Execution Continuity of Agent Checkpoints"** — a faithfully restored checkpoint can still resume with stale assumptions → resume must *verify*, not just restore. Landed as the `tship resume` HEAD-vs-checkpoint guard (refuses or `--force`), asserted in `test/smoke.js` §3.
- **Praesidia, "What Is an AI Agent Kill Switch?"** — killing = revoking authority without the agent's cooperation; layered stops must cover process, credentials, and tools. Landed as the layered stop in `lib/runner.js`: stop flag → SIGTERM → `AbortController` on in-flight API calls → git rollback → state marked `killed` (resume requires explicit `--acknowledge`).

## Design consequences (summary)

1. **The gate is code, not a prompt.** `outputs_max`, regression, and over-build checks are enforced in the orchestration layer; the model has no vote.
2. **Checkpoint-before-write.** The tree is always clean at round start (dirty trees are committed as a baseline checkpoint first), so every attempt is idempotent and rollback is always safe.
3. **Latched verification.** A check becomes enforced the first time it passes (green→red = regression). The fixture's baseline-broken form is a *gap*, not a halt — the gate stops over-build and regressions it has actually seen green.
4. **Resume verifies assumptions.** A checkpoint whose HEAD no longer matches the repo is surfaced, not silently continued.
5. **Observability is a first-class artifact** (AHE): state.json + events.jsonl + snapshots make every gate decision auditable from the dashboard.
