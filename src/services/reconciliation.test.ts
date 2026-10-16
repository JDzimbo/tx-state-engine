import { describe, it, expect } from 'vitest';
import { computeState } from './reconciliation';
import type { TransactionEvent } from '../types';

function evt(
  source: 'bank_webhook' | 'ledger' | 'processor',
  event_type: string,
  minutesAgo = 0
): TransactionEvent {
  return {
    id: crypto.randomUUID(),
    tenant_id: 'test-tenant',
    transaction_id: 'test-tx',
    source,
    source_event_id: crypto.randomUUID(),
    event_type,
    payload: {},
    occurred_at: new Date(Date.now() - minutesAgo * 60000),
    received_at: new Date(),
  };
}

describe('computeState', () => {
  it('returns pending, low confidence, no case when there are no events', () => {
    const result = computeState([]);
    expect(result.status).toBe('pending');
    expect(result.confidence).toBe('low');
    expect(result.open_case).toBe(false);
    expect(result.evidence).toEqual([]);
  });

  it('resolves to settled when the bank sends payment.settled', () => {
    const result = computeState([evt('bank_webhook', 'payment.settled')]);
    expect(result.status).toBe('settled');
    expect(result.confidence).toBe('high');
    expect(result.open_case).toBe(false);
  });

  it('resolves to pending when only a pending event has arrived', () => {
    const result = computeState([evt('bank_webhook', 'payment.pending')]);
    expect(result.status).toBe('pending');
    expect(result.confidence).toBe('medium');
  });

  it('resolves to failed when the bank sends payment.failed', () => {
    const result = computeState([evt('bank_webhook', 'payment.failed')]);
    expect(result.status).toBe('failed');
    expect(result.confidence).toBe('high');
  });

  it('sorts by occurred_at and reaches the same conclusion regardless of arrival order', () => {
    const pending = evt('bank_webhook', 'payment.pending', 5);
    const settled = evt('bank_webhook', 'payment.settled', 0);
    const result = computeState([settled, pending]);
    expect(result.status).toBe('settled');
  });

  it('settled overrides pending when sources agree on the money movement', () => {
    const result = computeState([
      evt('bank_webhook', 'payment.pending'),
      evt('bank_webhook', 'payment.settled'),
    ]);
    expect(result.status).toBe('settled');
    expect(result.confidence).toBe('high');
  });

  it('resolves to inconsistent when bank says settled and ledger says reversed', () => {
    const result = computeState([
      evt('bank_webhook', 'payment.settled'),
      evt('ledger', 'entry.reversed'),
    ]);
    expect(result.status).toBe('inconsistent');
    expect(result.confidence).toBe('low');
    expect(result.open_case).toBe(true);
    expect(result.reason).toMatch(/disagree/i);
  });

  it('opens a case only for inconsistent outcomes', () => {
    const inconsistent = computeState([
      evt('bank_webhook', 'payment.settled'),
      evt('ledger', 'entry.reversed'),
    ]);
    const settled = computeState([evt('bank_webhook', 'payment.settled')]);

    expect(inconsistent.open_case).toBe(true);
    expect(settled.open_case).toBe(false);
  });

  it('ignores unknown event types and falls back to pending', () => {
    const result = computeState([evt('bank_webhook', 'something.unknown')]);
    expect(result.status).toBe('pending');
    expect(result.confidence).toBe('low');
  });

  it('prefers the higher-weight source when two agree on terminal state', () => {
    const result = computeState([
      evt('processor', 'charge.succeeded'),
      evt('bank_webhook', 'payment.settled'),
    ]);
    expect(result.status).toBe('settled');
    expect(result.confidence).toBe('high');
  });

  it('includes the events used in the decision as evidence', () => {
    const events = [
      evt('bank_webhook', 'payment.settled'),
      evt('bank_webhook', 'payment.pending', 1),
    ];
    const result = computeState(events);
    expect(result.evidence.length).toBeGreaterThan(0);
  });
});