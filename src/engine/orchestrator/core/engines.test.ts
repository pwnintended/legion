import { describe, expect, it } from 'vitest';
import { fallbackReviewModel, finalizerEngineFor, modelFamily, reviewerEngineFor } from './engines';

describe('engine per role', () => {
  it('reviews with the other engine, or the same one when the other is unavailable', () => {
    expect(reviewerEngineFor('claude')).toBe('codex');
    expect(reviewerEngineFor('codex')).toBe('claude');
    expect(reviewerEngineFor('claude', { claude: true, codex: false })).toBe('claude');
    expect(finalizerEngineFor(['claude', 'claude', 'codex'], { claude: true, codex: false })).toBe('claude');
  });
});

describe('same-engine fallback review model', () => {
  it('compares Claude models by family', () => {
    expect(modelFamily('claude', 'claude-opus-5-5')).toBe('opus');
    expect(modelFamily('claude', 'sonnet[1m]')).toBe('sonnet');
    expect(modelFamily('codex', 'GPT-6.1-sol')).toBe('gpt-6.1-sol');
    expect(modelFamily('claude', null)).toBeNull();
  });

  it('uses the configured model unless the coder used it, then swaps opus and sonnet', () => {
    expect(fallbackReviewModel('claude', 'sonnet', 'opus')).toBe('opus');
    expect(fallbackReviewModel('claude', null, 'opus')).toBe('opus');
    expect(fallbackReviewModel('claude', 'claude-opus-5-5', 'opus')).toBe('sonnet');
    expect(fallbackReviewModel('claude', 'opus', null)).toBe('sonnet');
    expect(fallbackReviewModel('claude', 'haiku', 'haiku')).toBe('sonnet');
  });

  it('falls back to another probed model for engines without known siblings', () => {
    expect(fallbackReviewModel('codex', 'gpt-6.1-sol', null, ['gpt-6.1-sol', 'gpt-6.1-mini'])).toBe('gpt-6.1-mini');
    expect(fallbackReviewModel('codex', 'gpt-6.1-sol', 'gpt-6.1-sol', ['gpt-6.1-sol'])).toBe('gpt-6.1-sol');
    expect(fallbackReviewModel('codex', null, null, [])).toBeNull();
    expect(fallbackReviewModel('codex', 'a', 'b', ['a'])).toBe('b');
  });
});
