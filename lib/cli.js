import { runInit, runAttach, runKeys, runStop, runStatus, runResume, runRollback, runReport, runDryRun, runLintRules } from './commands.js';
import { startRun } from './runner.js';
import { startDashboard } from './dashboard.js';

const HELP = `tship — recurring code-change harness with taste rules, a hard outputs gate, and an out-of-band kill switch.

Usage:
  tship init [dir]                      Detect framework, scaffold .tasteeship/config.json + rules.md
  tship attach <path|git-url>           Attach an existing repo as the change target
  tship keys add <provider>             Store a provider key in .env.local (chmod 600, never committed)
  tship keys list|remove <provider>     Inspect / remove stored keys
  tship run [options]                   Run the loop. Options:
      --rounds <n>           max rounds (default from config, 50)
      --outputs-max <n>      max agent outputs per round — the gate (default from config, 4)
      --provider <name>      mock | anthropic | openai-compat  (default: mock)
      --model <id>           provider model id      (default: mock-sonnet)
      --flag-overbuild       flag over-build rounds instead of halting on them
      --loc-cap <n>          override total-LOC overbuild cap
      --loc-delta-cap <n>    override per-round LOC growth cap
  tship stop                            KILL SWITCH: halt the run out-of-band and roll back
  tship resume [--acknowledge] [--force]  Resume from the last checkpoint (refuses dirty trees without --force)
  tship status                          Show run state + live gate status
  tship rollback --to <round|git-sha>   Manually roll the repo back to a checkpoint
  tship dry-run                         Verify the CURRENT tree against the gate (no model, no writes)
  tship lint-rules                      Calibrate taste/verification config against the baseline
  tship dashboard [--port <n>]          Serve the local dashboard (default port 4777, loopback only)
  tship report [state.json]             Print a run report / model comparison
  tship help                            This text
`;

export async function main(argv) {
  const [cmd, ...rest] = argv;
  const flags = parseFlags(rest);
  switch (cmd) {
    case 'init': return runInit(rest[0], flags);
    case 'attach': return runAttach(rest[0], flags);
    case 'keys': return runKeys(rest, flags);
    case 'run': return startRun(process.cwd(), flags);
    case 'stop': return runStop(flags);
    case 'resume': return runResume(flags);
    case 'status': return runStatus(flags);
    case 'rollback': return runRollback(flags);
    case 'dry-run': return runDryRun(flags);
    case 'lint-rules': return runLintRules(flags);
    case 'dashboard': return startDashboard(process.cwd(), flags);
    case 'report': return runReport(rest[0], flags);
    case 'help':
    case '--help':
    case '-h':
    case undefined: console.log(HELP); return;
    default: throw new Error(`unknown command: ${cmd} (try \`tship help\`)`);
  }
}

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = /^\d+$/.test(next) ? Number(next) : next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}
