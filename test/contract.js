import { MockProvider } from '../lib/providers/mock.js';
import { AnthropicProvider } from '../lib/providers/anthropic.js';
import { OpenAICompatProvider } from '../lib/providers/openai.js';
import { parseProposal, finalizeProposal, REPAIR_INSTRUCTION } from '../lib/providers/anthropic.js';
import { defaultConfig } from '../lib/config.js';
import { ok, done, section } from './helpers.js';

// Provider contract test (offline): every provider normalizes to the envelope
// the runner consumes — { usage: {input, output}, proposal: {summary, files} } —
// and malformed output surfaces as err.protocolError. No live calls.

function assertEnvelope(p, label) {
  ok(p && typeof p === 'object', `${label}: envelope is an object`);
  ok(Number.isFinite(p.usage?.input) && Number.isFinite(p.usage?.output), `${label}: usage {input, output} numeric`);
  ok(typeof p.proposal?.summary === 'string', `${label}: proposal.summary is a string`);
  ok(Array.isArray(p.proposal?.files) && p.proposal.files.length > 0, `${label}: proposal.files non-empty`);
  for (const f of p.proposal.files) {
    ok(typeof f.path === 'string' && !f.path.includes('..') && typeof f.content === 'string', `${label}: file ${f.path} well-formed`);
  }
}

section('mock provider — normalized step() envelope');
{
  const cfg = defaultConfig('static-site');
  cfg.provider = { name: 'mock', model: 'mock-sonnet' };
  const provider = new MockProvider(cfg, 'contract-test');
  const out = await provider.step(
    { root: process.cwd(), round: 1, attemptNo: 1, outputsMax: 4, roundsMax: 50, entry: 'index.html', rules: '', files: [], fileContents: [] },
    {}
  );
  assertEnvelope(out, 'mock');
}

section('anthropic provider — constructor + parse path (no network)');
{
  const cfg = defaultConfig('static-site');
  cfg.provider = { name: 'anthropic', model: 'claude-sonnet-5-5' };
  let threw = null;
  try {
    new AnthropicProvider(cfg, {});
  } catch (e) {
    threw = e;
  }
  ok(threw && /ANTHROPIC_API_KEY/.test(threw.message), 'missing key surfaces a clear error');

  const provider = new AnthropicProvider(cfg, { ANTHROPIC_API_KEY: 'sk-test' });
  ok(typeof provider.step === 'function', 'anthropic: step exists (envelope asserted via finalizeProposal below)');
}

section('openai-compat provider — constructor contract (no network)');
{
  const cfg = defaultConfig('static-site');
  cfg.provider = { name: 'openai-compat', model: 'test-model' };
  let threw = null;
  try {
    new OpenAICompatProvider(cfg, {});
  } catch (e) {
    threw = e;
  }
  ok(threw && /baseUrl/.test(threw.message), 'missing baseUrl surfaces a clear error');

  cfg.provider.baseUrl = 'https://example.invalid/v1';
  cfg.provider.apiKeyEnv = 'TEST_API_KEY';
  threw = null;
  try {
    new OpenAICompatProvider(cfg, {});
  } catch (e) {
    threw = e;
  }
  ok(threw && /TEST_API_KEY/.test(threw.message), 'missing keyEnv surfaces a clear error');
}

section('parseProposal — the two supported text formats + malformed cases');
{
  const jsonForm = '```json\n{"summary":"s","files":[{"path":"a.html","content":"<html>ok</html>"}]}\n```';
  const p1 = parseProposal(jsonForm);
  assertEnvelope({ usage: { input: 0, output: 0 }, proposal: p1 }, 'json form');

  const blockForm = [
    'SUMMARY: make it bold',
    '',
    'FILE: index.html',
    '```html',
    '<!doctype html>',
    '<div id="order-form">say "hi"</div>',
    '```',
    '',
    'FILE: css/style.css',
    'body { color: #000; }',
  ].join('\n');
  const p2 = parseProposal(blockForm);
  assertEnvelope({ usage: { input: 0, output: 0 }, proposal: p2 }, 'FILE-block form');
  ok(p2.proposal === undefined, 'parseProposal returns the bare proposal');
  ok(p2.files[0].content.includes('<div id="order-form">say "hi"</div>'), 'FILE block keeps multi-line content with quotes');

  // malformed JSON with blocks present → blocks win
  const brokenJsonThenBlocks = '```json\n{"summary":"s","files":[{"path":"x","content":"html\n<div id="oops">"}]}\n```\nSUMMARY: fallback\nFILE: index.html\n<html>fixed</html>\n';
  const p3 = parseProposal(brokenJsonThenBlocks);
  ok(p3.files[0].path === 'index.html', 'unparseable JSON falls back to FILE blocks');

  for (const bad of ['no proposal here at all', '{"summary":"no files"}']) {
    let err = null;
    try {
      parseProposal(bad);
    } catch (e) {
      err = e;
    }
    ok(err?.protocolError === true, `malformed input raises protocolError: "${bad.slice(0, 24)}…"`);
  }

  let unsafe = null;
  try {
    parseProposal('SUMMARY: s\nFILE: ../secrets.txt\nboom\n');
  } catch (e) {
    unsafe = e;
  }
  ok(unsafe?.protocolError && /unsafe path/.test(unsafe.message), 'path traversal rejected with protocolError');
}

section('finalizeProposal — one repair turn, tokens accumulated');
{
  const good = 'SUMMARY: s\nFILE: a.html\n<html></html>\n';
  const repaired = await finalizeProposal({
    text: ' prose, no proposal ',
    usage: { input: 10, output: 5 },
    repair: async (prev, instruction) => {
      ok(prev === ' prose, no proposal ', 'repair receives the original reply');
      ok(instruction === REPAIR_INSTRUCTION, 'repair uses the canonical instruction');
      return { text: good, usage: { input: 7, output: 3 } };
    },
  });
  assertEnvelope(repaired, 'repair turn');
  ok(repaired.usage.input === 17 && repaired.usage.output === 8, 'repair-turn tokens accumulate into one output');

  let err = null;
  try {
    await finalizeProposal({
      text: 'still nothing',
      usage: { input: 1, output: 1 },
      repair: async () => ({ text: 'and nothing again', usage: { input: 1, output: 1 } }),
    });
  } catch (e) {
    err = e;
  }
  ok(err?.protocolError === true, 'unparseable after repair still raises protocolError');
}

done('provider contract');
