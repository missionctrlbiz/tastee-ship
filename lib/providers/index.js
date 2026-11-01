import { MockProvider } from './mock.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAICompatProvider } from './openai.js';

export function createProvider(cfg, keys, runId) {
  switch (cfg.provider.name) {
    case 'mock':
      return new MockProvider(cfg, runId);
    case 'anthropic':
      return new AnthropicProvider(cfg, keys);
    case 'openai-compat':
      return new OpenAICompatProvider(cfg, keys);
    default:
      throw new Error(`unknown provider: ${cfg.provider.name}`);
  }
}
