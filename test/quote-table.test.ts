import { expect, test } from 'bun:test';
import { formatQuoteTable } from '../scripts/quote-table';

test('formats rows with deltas against the routed provider', () => {
  const md = formatQuoteTable([
    { model: 'nano-banana-2', provider: 'google', billing: 'metered', usd: 0.04, basis: 'list price per image', routed: true, source: 'https://ai.google.dev/pricing (2026-10-05)' },
    { model: 'nano-banana-2', provider: 'atlas', billing: 'metered', usd: 0.03, basis: '/calculate 1K 16:9', routed: false },
    { model: 'gpt-image-2', provider: 'codex', billing: 'plan', usd: 0, basis: 'plan limits', routed: false },
    { model: 'gpt-image-2', provider: 'openai', billing: 'metered', usd: null, basis: 'no price recorded', routed: true },
  ]);
  expect(md).toContain('| Model | Provider | Billing | USD | Basis | vs routed | Source |');
  expect(md).toContain('| nano-banana-2 | atlas | metered | 0.0300 | /calculate 1K 16:9 | -25% |  |');
  expect(md).toContain('| nano-banana-2 | google (routed) | metered | 0.0400 |');
  expect(md).toContain('| gpt-image-2 | codex | plan | 0 marginal (plan limits) | plan limits | n/a |  |');
});

test('cells are single-line and pipe-safe', () => {
  const md = formatQuoteTable([
    { model: 'm', provider: 'atlas', billing: 'metered', usd: null, basis: 'error: HTTP 429: <!doctype html>\n<html | x>', routed: false },
  ]);
  const row = md.split('\n')[2];
  expect(md.split('\n')).toHaveLength(3);
  expect(row).toContain('error: HTTP 429: <!doctype html> <html \\| x>');
});
