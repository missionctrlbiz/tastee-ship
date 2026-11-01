// Real Anthropic provider. Keys are loaded from the project's .env.local
// (injected context), used only for the API call, never logged or committed.
import path from 'node:path';

const API_URL = 'https://api.anthropic.com/v1/messages';
export const PROTOCOL = `You are the change agent inside a harness. Look at the site, innovate, and propose ONE bold change that improves conversions.

Respond in EXACTLY this plain-text format:

SUMMARY: <one sentence — what you changed and why it improves conversions>

FILE: <relative/path>
\`\`\`
<full new file content, verbatim>
\`\`\`

Repeat the FILE block for every file you change. Rules:
- Write the FULL new content for each file you touch (the harness writes files verbatim).
- Keep the diff focused: one section or concern per round; do not restructure everything at once.
- Use only paths inside the project. Do not invent external build steps.
- Nothing before SUMMARY and nothing after the last FILE block.
- The harness decides when to stop; you do not manage rounds.`;

export class AnthropicProvider {
  constructor(cfg, keys) {
    this.cfg = cfg;
    this.model = cfg.provider.model || 'claude-sonnet-4-5';
    this.key = keys.ANTHROPIC_API_KEY;
    if (!this.key) {
      throw new Error('no ANTHROPIC_API_KEY — run `tship keys add anthropic`');
    }
  }

  async step(ctx, { signal } = {}) {
    const userMsg = buildUserMessage(ctx);
    const res = await fetch(API_URL, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 16384,
        system: `${ctx.rules}\n\n${PROTOCOL}`,
        messages: [{ role: 'user', content: userMsg }],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`anthropic ${res.status}: ${body.slice(0, 300)}`);
      err.protocolError = true;
      throw err;
    }
    const data = await res.json();
    const text = (data.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    return {
      usage: {
        input: data.usage?.input_tokens ?? 0,
        output: data.usage?.output_tokens ?? 0,
      },
      proposal: parseProposal(text),
    };
  }
}

export function buildUserMessage(ctx) {
  const parts = [
    `Round ${ctx.round} of ${ctx.roundsMax}. Attempt ${ctx.attemptNo} of ${ctx.outputsMax} (the harness halts this step after ${ctx.outputsMax} outputs).`,
    `Current size: ${ctx.loc} LOC across ${ctx.fileCount} files. Entry page: ${ctx.entry}.`,
  ];
  if (ctx.lastFailures?.length) {
    parts.push(
      `Your previous attempt was rejected by the harness verification layer:\n${ctx.lastFailures
        .map((f) => `- [${f.kind}] ${f.message}`)
        .join('\n')}\nFix the failure with this attempt.`
    );
  }
  parts.push(`Project files: ${ctx.files.join(', ')}`);
  if (ctx.fileContents?.length) {
    parts.push(
      `Current contents of the files you are most likely to touch:\n${ctx.fileContents
        .map((f) => `--- ${f.path}${f.truncated ? ' (truncated)' : ''} ---\n${f.content}`)
        .join('\n\n')}`
    );
  }
  return parts.join('\n\n');
}

// Two-stage proposal parser. Stage 1: JSON (fenced or balanced object) — what
// well-behaved models emit. Stage 2: the SUMMARY:/FILE: block form — models
// frequently emit file contents with unescaped quotes/newlines inside JSON
// strings, which no strict JSON parser can read; the block form cannot break
// that way. Found by the live-model full test (GLM-5.3-Flash / K2-375B).
export function parseProposal(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : extractBalancedObject(text);
  if (raw) {
    try {
      return validateProposal(JSON.parse(raw));
    } catch {
      /* fall through to the block form */
    }
  }
  const blocks = parseFileBlocks(text);
  if (blocks) return blocks;
  throw protocolError('no parsable proposal (JSON or FILE blocks) in response');
}

function validateProposal(obj) {
  if (!Array.isArray(obj.files) || obj.files.length === 0) {
    throw protocolError('proposal has no files array');
  }
  for (const f of obj.files) {
    if (typeof f.path !== 'string' || f.path.includes('..') || path.isAbsolute(f.path)) {
      throw protocolError(`unsafe path in proposal: ${f.path}`);
    }
    if (typeof f.content !== 'string') {
      throw protocolError(`file ${f.path} has no content`);
    }
  }
  return { summary: String(obj.summary || ''), files: obj.files };
}

function parseFileBlocks(text) {
  const summaryMatch = text.match(/^SUMMARY:\s*(.+)\s*$/im);
  const re = /^FILE:[ \t]*(.+)[ \t]*$\n([\s\S]*?)(?=\nFILE:|$)/gm;
  const files = [];
  let m;
  while ((m = re.exec(text))) {
    const p = m[1].trim().split(/\s+/)[0];
    const content = stripFences(m[2]);
    if (!p || !content.trim()) continue;
    files.push({ path: p, content });
  }
  if (!files.length) return null;
  for (const f of files) {
    if (f.path.includes('..') || path.isAbsolute(f.path)) {
      throw protocolError(`unsafe path in proposal: ${f.path}`);
    }
  }
  return { summary: summaryMatch ? summaryMatch[1].trim() : '', files };
}

function stripFences(c) {
  const inner = c
    .replace(/^[ \t]*```[\w.-]*[ \t]*\n/, '')
    .replace(/\n?[ \t]*```[ \t]*$/, '')
    .trim();
  return inner + '\n';
}

function protocolError(msg) {
  const err = new Error(msg);
  err.protocolError = true;
  return err;
}

function extractBalancedObject(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
