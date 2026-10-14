// Transaction lifecycle states
export type TransactionStatus =
  | 'initiated'
  | 'pending'
  | 'settled'
  | 'failed'
  | 'inconsistent';

// Sources that emit events about a transaction
export type EventSource = 'bank_webhook' | 'ledger' | 'processor';

// Confidence level of a reconciliation decision
export type Confidence = 'high' | 'medium' | 'low';

// A transaction row
export interface Transaction {
  id: string;
  tenant_id: string;
  idempotency_key: string;
  external_ref: string | null;
  amount_minor: number;
  currency: string;
  direction: 'debit' | 'credit';
  status: TransactionStatus;
  status_reason: string | null;
  expected_by: Date | null;
  created_at: Date;
  updated_at: Date;
}

// A raw event row
export interface TransactionEvent {
  id: string;
  tenant_id: string;
  transaction_id: string | null;
  source: EventSource;
  source_event_id: string | null;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
  received_at: Date;
}

// The result of a reconciliation run
export interface ReconciliationResult {
  status: TransactionStatus;
  reason: string;
  confidence: Confidence;
  evidence: TransactionEvent[];
  open_case: boolean;
}

// What a rule says about an event
export interface EventRule {
  status: TransactionStatus;
  weight: number;
}