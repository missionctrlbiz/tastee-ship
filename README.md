# tasteeship ☕🚢

**A local Node CLI harness that runs a recurring "make it better" code-change
loop — with your taste, a hard stop condition, and a dashboard with the kill
button the reference video didn't have.**

Inspired by Nate Herk, *"I Told Claude to 'Make it better' 100 Times"*
([watch the video](https://www.youtube.com/watch?v=DByAR5Su1Yw)): give a coding
agent an ugly coffee-shop site and the prompt *"look at the site, innovate,
make one bold change that improves conversions, you must ship a change every
time"* — 100 rounds. The loop works, but *"must ship a change"* forces
over-engineering (round-100 Opus: ~21k LOC, broken forms, a pumpkin-carving
feature, a language toggle that didn't work), and the gate — not the model —
should decide when to stop.

The one-liner:

> Each project attaches its own repo, keys, and a `rules.md` of taste; every
> step runs a bounded number of agent outputs, then halts and reports —
> halting on regression, over-build, or user rejection — rather than forcing
> another change.

Zero runtime dependencies. Node ≥ 18. Single user, local machine.

---

## Quick start

```bash
npm link                      # or run everything via `node bin/tship.js`

tship init                    # detect framework, scaffold .tasteeship/config.json + rules.md
tship keys add anthropic      # your key → .env.local (chmod 600, gitignored, never committed)
tship run --rounds 50         # the loop (mock provider by default — no key needed)
tship dashboard               # http://localhost:4777 — rounds, trends, scrubber, KILL button
```

Point it at any repo with `tship attach <path|git-url>`; edit
`.tasteeship/config.json` (or the scaffolded `rules.md`) to inject your taste.

## The gate (`outputs_max`) — how stopping actually works

Every round is a **step**. Within a step the runner will send at most
`runner.outputsMax` agent messages. What happens after each message is decided
by the **verification layer** — Node code the model never sees and cannot
influence:

1. **Check types** (`verify` in config): required/critical selectors must exist
   in the shipped HTML; forbidden strings (your taste's "no" list) must not
   appear; every `getElementById`/`querySelector('#…')` in your JS must resolve
   to a real DOM id (this is what catches *broken forms* and *language toggles
   that don't work*); total LOC cap, per-round LOC-delta cap, file-count cap.
2. **Latch semantics**: a check becomes enforced the first time it passes.
   Green→red is a **regression**. A check that has never been green (the
   fixture's deliberately broken order form) is a *gap* — reported, not
   halting — until the agent fixes it once.
3. **Verdicts** (`lib/gate.js`): ship · retry (burns one of the
   `outputs_max` outputs) · **halt**. Halts: `overbuild` (taste/budget
   violations — or flag them instead with `--flag-overbuild`),
   `regression` (budget exhausted while checks fail), `outputs-max`
   (malformed proposals / provider errors exhausting the budget), and
   `user-rejection` (the kill switch). A halt **rolls back** the round and
   reports — it never forces another change.

The budget is not a prompt instruction ("please stop when asked"); it is the
orchestration layer declining to send message N+1.

## Stop & recovery — enforced outside the model's reasoning path

Layered stop states (research: see [docs/RESEARCH.md](docs/RESEARCH.md)):

| layer | mechanism |
| --- | --- |
| process | `tship stop` (or the dashboard KILL button) writes a stop flag + SIGTERM to the runner pid |
| in-flight | `AbortController` cancels an in-flight provider API call |
| orchestration | the gate checks the flag before every agent message — nothing further is dispatched |
| repo | `git reset --hard` + `clean` to the **last good checkpoint** (one commit per shipped round); the in-flight attempt is discarded |
| state | run marked `killed / user-rejection`; resuming requires explicit `tship resume --acknowledge` |

Recovery: **checkpoint resume** (atomic `state.json` every step, git commit
every shipped round), **idempotent steps** (full-content proposal writes onto a
checkpointed tree — re-running an attempt has no side effects), and
**verified resume** (`tship resume` refuses if repo HEAD ≠ recorded
checkpoint, so out-of-band edits are surfaced, not silently continued).

## CLI

```
tship init [dir]                     detect framework, scaffold config + rules.md
tship attach <path|git-url>          attach an existing repo as the change target
tship keys add|list|remove <p>       keys → .env.local (600, gitignored, untracked)
tship run [--rounds N] [--outputs-max N] [--provider mock|anthropic] [--model M]
          [--flag-overbuild] [--loc-cap N] [--loc-delta-cap N]
tship stop                           KILL SWITCH — halt + rollback, out-of-band
tship resume [--acknowledge] [--force]   continue from the last checkpoint
tship status                         run state + live gate status
tship rollback --to <round|sha>      manual rollback to a checkpoint
tship dashboard [--port 4777]        local dashboard (SSE live updates)
tship report [state.json]            per-run report (rounds, gate events, cost)
```

## Dashboard

`node bin/tship.js dashboard` → <http://localhost:4777> (open another project
with `?project=path/relative/to/root`). Keeps everything the reference
dashboard showed and adds the stop button:

- **gate status chip** — ARMED / TRIPPED (over-build, regression, outputs-max) / KILLED
- **rounds table** — attempts, LOC, ΔLOC, cost, verdict, gate flags per round
- **milestones** — first image / working form / video / canvas / responsive, harness-detected from the shipped tree
- **trends** — LOC per round and cumulative spend (SVG, live via SSE)
- **site-preview scrubber** — iframe through every shipped round's snapshot
- **gate log** — every enforcement decision the model never saw
- **⏻ KILL** — same code path as `tship stop`

## Validation on the case study

`npm run validate` reproduces the coffee-shop study: 50 rounds of
sonnet-class vs opus-class behavior, the over-build halt, the flag-mode
trajectory, and the kill-switch drill. Full write-up with numbers:
**[docs/VALIDATION.md](docs/VALIDATION.md)** — headline findings:

- sonnet-class: 50/50 rounds clean, final site 425 LOC, ~$1.01 — never needed
  stopping.
- opus-class with the gate: **halted at round 12/13** when it tried to ship a
  pumpkin-carving configurator ($1.92, 2,173 LOC). The gate decided.
- opus-class without the halt (flag mode, the video's regime): 38/50 flagged
  rounds, broken language toggle and form rename caught and retried, final
  site 12,290 LOC, ~$8.14 — the over-engineering pathology, reproduced.
- kill switch: killed mid-round → repo verified rolled back → resumed from
  checkpoint → completed 50/50 with usage accumulating across both phases.

> **Model disclosure**: this repo validates with a deterministic mock provider
> (no API keys in the build environment) calibrated to the video's findings —
> the harness mechanics under test (gate, verification, kill, checkpoints,
> cost accounting) are the real code paths. Run `tship keys add anthropic &&
> tship run --provider anthropic --model claude-sonnet-5-5` for live models.
> See docs/VALIDATION.md for the full rationale.

## Project layout

```
bin/tship.js              CLI entry
lib/runner.js             orchestration: the loop, the gate, kill/resume/rollback
lib/gate.js               verdict logic (ship / retry / halt) — pure
lib/checks.js             verification layer (selectors, js-refs, taste, budgets)
lib/state.js              state.json + events.jsonl (operations layer)
lib/gitops.js             checkpoints, rollback, snapshots
lib/keys.js               .env.local storage (600, gitignored, untracked)
lib/providers/            anthropic (live) + mock (deterministic, calibrated)
lib/dashboard.js          http server + SSE + kill endpoint
dashboard/                vanilla JS UI (charts, scrubber, kill button)
examples/coffee-shop/     the case-study fixture + rules.md
test/smoke.js             end-to-end mechanics (gate, kill, resume, flag mode)
test/run-validation.js    the case-study validation (npm run validate)
docs/RESEARCH.md          sources & how they shaped the design
docs/VALIDATION.md        case-study write-up + evidence
docs/evidence/            raw run states + validation log
```

## Out of scope for v1

No hosted/multi-user, no plugin step system, no web-search auto-injection
(that's the "teach" step, next version), no CI integration.

## License

MIT — see [LICENSE](LICENSE).
