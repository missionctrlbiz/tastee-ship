import { PROTOCOL, parseProposal, buildUserMessage } from './anthropic.js';

// OpenAI-compatible chat-completions provider. Lets the user attach ANY
// endpoint they own — z.ai (GLM), OpenRouter, a local router — with their own
// key stored via `tship keys add`. The harness never ships a key.
export class OpenAICompatProvider {
  constructor(cfg, keys) {
    this.cfg = cfg;
    this.baseUrl = (cfg.provider.baseUrl || '').replace(/\/$/, '');
    this.model = cfg.provider.model;
    this.keyEnv = cfg.provider.apiKeyEnv || 'OPENAI_API_KEY';
    this.maxTokens = cfg.provider.maxTokens || 32768;
    this.extraBody = cfg.provider.extraBody || {};
    this.key = keys[this.keyEnv];
    if (!this.baseUrl) throw new Error('provider.baseUrl is required for the openai-compat provider');
    if (!this.key) throw new Error(`no ${this.keyEnv} — \`tship keys add\` it first`);
  }

  async step(ctx, { signal } = {}) {
    const timeoutMs = this.cfg.provider.timeoutMs || 240000;
    const signals = signal ? [signal, AbortSignal.timeout(timeoutMs)] : [AbortSignal.timeout(timeoutMs)];
    const abort = typeof AbortSignal.any === 'function' ? AbortSignal.any(signals) : signals[0];
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: abort,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.key}`,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: this.maxTokens,
        temperature: 0.4,
        ...this.extraBody,
        messages: [
          { role: 'system', content: `${ctx.rules}\n\n${PROTOCOL}` },
          { role: 'user', content: buildUserMessage(ctx) },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`${this.model} ${res.status}: ${body.slice(0, 300)}`);
      err.protocolError = true;
      throw err;
    }
    const data = await res.json();
    const msg = data.choices?.[0]?.message;
    let text = stripThink(msg?.content || '');
    if (!text.trim() && msg?.reasoning_content) {
      // Thinking model burned its whole budget reasoning and returned empty
      // content — last resort: parse the proposal out of its reasoning trace.
      text = stripThink(msg.reasoning_content);
      console.error(`[provider] ${this.model}: empty content, falling back to reasoning trace (finish: ${data.choices?.[0]?.finish_reason})`);
    }
    if (!text.trim() && msg?.reasoning_content) {
      // thinking models can spend the whole budget reasoning and return empty content
      console.error(`[provider] ${this.model} returned reasoning only (${(msg.reasoning_content || '').length} chars, finish: ${data.choices?.[0]?.finish_reason})`);
    }
    try {
      return {
        usage: {
          input: data.usage?.prompt_tokens ?? 0,
          output: data.usage?.completion_tokens ?? 0,
        },
        proposal: parseProposal(text),
      };
    } catch (err) {
      if (err.protocolError) {
        err.message += ` — response: ${JSON.stringify(text.slice(0, 240))}`;
      }
      throw err;
    }
  }
}

// GLM-family models sometimes emit a <think>…</think> block before the answer.
function stripThink(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}
