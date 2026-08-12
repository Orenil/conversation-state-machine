/**
 * Shared type definitions for the declarative conversation flow.
 *
 * The flow itself (states, required disclosures, off-script intents) is
 * pure data (see src/config/flow.ts). Everything downstream — the xstate
 * machine, the generator, the verifier, the audit log — is built from that
 * data rather than hard-coding conversation logic. That's the point: the
 * legal/compliance shape of the conversation lives in one declarative
 * place a non-engineer could review, not scattered across control flow.
 */

/** A single legally-required disclosure that must be uttered, verbatim in
 * substance, while the machine is in a given state. */
export interface DisclosureSpec {
  /** Stable id, referenced by audit log entries. */
  id: string;
  /** The canonical/regulatory text the utterance must convey. */
  canonicalText: string;
  /** Phrases that MUST each appear (in some form) for the disclosure to be
   * considered complete. Absence of any one of these is an automatic fail,
   * independent of overall coverage score. */
  requiredPhrases: string[];
  /** Minimum fraction (0-1) of canonicalText's significant keywords that
   * must be present in the candidate utterance. */
  minCoverage: number;
}

/** A globally recognized user intent that can interrupt the scripted flow
 * from *any* state ("mixed initiative"). */
export interface OffScriptIntent {
  id: string;
  /** Human-readable description, used in audit log / README examples. */
  description: string;
  /** Patterns matched (case-insensitively) against raw user utterances. */
  patterns: RegExp[];
  /** State the machine forces a transition to when this intent fires. */
  targetState: string;
  /** States from which this intent should NOT fire (e.g. it already
   * applies, or the conversation is already over). Defaults to none. */
  excludeFrom?: string[];
}

/** A single node in the declarative flow. */
export interface StateSpec {
  id: string;
  /** Disclosure that must be verified before this state may be exited via
   * its scripted transition. Undefined = no verification gate. */
  disclosure?: DisclosureSpec;
  /** Template used by the generator to produce the agent's utterance while
   * in this state. `{{slot}}` placeholders are filled from context. */
  template: string;
  /** The state reached by the normal, on-script "advance" transition.
   * Undefined for terminal states. */
  next?: string;
  /** Scripted user-input intents recognized in this state that map to a
   * specific next state, overriding the default `next`. Useful for
   * branches like "yes/no" without introducing off-script handling. */
  branches?: Record<string, string>;
  terminal?: boolean;
  /** If true, this state is itself an off-script landing state (dispute
   * handling, cease-and-desist, etc). Purely descriptive, used in audit
   * summaries. */
  offScript?: boolean;
}

export interface FlowConfig {
  id: string;
  initial: string;
  states: StateSpec[];
  offScriptIntents: OffScriptIntent[];
}

/** Result of running a candidate utterance through the verification
 * classifier against a disclosure spec. */
export interface VerificationResult {
  disclosureId: string;
  passed: boolean;
  coverage: number;
  missingRequiredPhrases: string[];
  matchedKeywords: string[];
  missingKeywords: string[];
}

/** A single immutable audit log entry. */
export interface AuditEntry {
  seq: number;
  timestamp: string;
  callId: string;
  type: "transition" | "utterance" | "verification" | "user_input";
  fromState: string | null;
  toState: string | null;
  trigger: string;
  payload: Record<string, unknown>;
  /** SHA-256 of the previous entry's hash + this entry's own content,
   * giving the log a tamper-evident hash chain (see src/audit.ts). */
  hash: string;
  prevHash: string | null;
}
