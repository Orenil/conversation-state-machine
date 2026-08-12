# conversation-state-machine

A deterministic dialog state machine that wraps an LLM-driven voice/chat agent so that **required disclosures, consent, and verification steps happen no matter what the model generates.**

## Problem

In regulated conversations — debt collection, healthcare intake, financial services — certain disclosures are legally required, often in a specific order, sometimes with specific wording. If an LLM is left to drive the conversation freely, it can paraphrase past a disclosure, skip it because the dialogue "flowed naturally" around it, or get derailed by the user and never come back to it. That's not a hypothetical: FDCPA debt-collection calls in the US are required to include a "mini-Miranda" warning and a validation notice, and missing either is a compliance violation with real penalties.

The fix isn't "prompt the model better." It's taking control flow away from the model entirely.

This project implements that pattern for a worked example: an FDCPA-governed debt-collection call. The domain is illustrative — the same shape applies to a healthcare intake script requiring HIPAA privacy-practice acknowledgment, or a financial-services KYC flow requiring identity verification before disclosing account details.

## Architecture

```
                    ┌─────────────────────────┐
                    │   src/config/flow.ts      │   declarative: states,
                    │   (FlowConfig)             │   disclosures, off-script
                    └────────────┬─────────────┘   intents — pure data
                                 │
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                   ▼
     ┌─────────────────┐ ┌──────────────┐  ┌────────────────────┐
     │  src/machine.ts   │ │ generator.ts  │  │  verification.ts    │
     │  compiles flow →  │ │ template-     │  │  KeywordCoverage-   │
     │  real xstate       │ │ fills the     │  │  Verifier scores    │
     │  machine; guards   │ │ per-state     │  │  candidate text     │
     │  gate transitions  │ │ utterance     │  │  against a          │
     │  on verification   │ │               │  │  DisclosureSpec     │
     └─────────┬─────────┘ └──────┬───────┘  └──────────┬─────────┘
               │                  │                     │
               └──────────────────┴──────────┬──────────┘
                                              ▼
                                   ┌─────────────────────┐
                                   │   src/engine.ts       │
                                   │   ConversationEngine   │
                                   │   orchestrates a call: │
                                   │   speak → verify →     │
                                   │   gate → transition     │
                                   └──────────┬──────────┘
                                              ▼
                                   ┌─────────────────────┐
                                   │    src/audit.ts       │
                                   │  hash-chained JSONL    │
                                   │  append-only log       │
                                   └─────────────────────┘
```

### Design decisions

**The state machine owns control flow; the LLM/generator does not.** `src/machine.ts` compiles a `FlowConfig` (states, required disclosures, off-script intents — pure data in `src/config/flow.ts`) into a real [xstate](https://stately.ai/docs/xstate) machine. The generator (`src/generator.ts`) only produces the *utterance* spoken within a state — it has no way to call `send()` or otherwise move the conversation forward. Advancing past a disclosure-bearing state requires a `SET_VERIFIED` event that only `ConversationEngine` sends, and only after the verifier has scored the actual text that was produced. There's no code path from "the model said something" to "the machine transitioned" that skips that check.

**Off-script ("mixed initiative") handling is a machine-level concern, not a UI-level `if`.** Real people don't stay on script — they say "I dispute this debt" or "stop calling me" from any point in the conversation. `FlowConfig.offScriptIntents` declares a set of regex-matched intents, each with a `targetState`. These are wired as transitions on the xstate machine's own root `on` block. XState resolves an event against the current leaf state first; if that state doesn't define a handler for the event, it bubbles to the nearest ancestor that does — the root machine — so one declaration applies from every state without being repeated per state. States listed in an intent's `excludeFrom` (e.g. you can't "dispute the debt" again once you're already in `dispute_handling`) get an explicit no-op handler that overrides the bubble, so the event is legally recognized as matched but doesn't disturb the state — see `tests/mixedInitiative.test.ts`.

**Illegal transitions are rejected by construction, not by validation after the fact.** A state node only defines `on` handlers for events that are legal from it. Sending anything else — `ADVANCE` from a state that only accepts `AFFIRM`/`DENY`, `ADVANCE` from a disclosure state whose guard hasn't passed, any event to an already-terminal machine — is simply not in that state's transition table, so xstate leaves the machine exactly where it was. See `tests/machine.test.ts`.

**Every transition, trigger, and verification result is logged to an immutable audit trail.** `src/audit.ts` implements a real append-only JSON-Lines file (opened with the `a` flag, one JSON object per line, never rewritten) where each entry's hash covers the previous entry's hash — a hash chain. Editing or deleting any historical line breaks the chain, which `verifyChain()` detects by re-walking it. `tests/audit.test.ts` includes a test that tampers with a line on disk and confirms the corruption is caught.

### Rejected tradeoffs

**Why not a Python NLP sidecar for the verification classifier?**
The spec calls for a "verification classifier" that checks generated utterances against required disclosure content, independent of the model that generated them. In production, that's genuinely a good place for a real NLP service — sentence embeddings, NLI entailment models, fuzzy paraphrase detection — because legally required language is rarely uttered verbatim by an LLM in practice. For a project this size, running a second language runtime and a process/IPC boundary just to do that would add operational surface (deployment, health checks, network failure modes) without adding engineering signal — the interesting part is the *contract*, not the model. So `Verifier` (`src/verification.ts`) is implemented in-process and fully deterministically:

1. **Required-phrase presence** — each `requiredPhrases` entry must appear (after normalization) in the candidate. Catches outright omission of legally load-bearing phrases.
2. **Keyword coverage** — the fraction of the canonical disclosure's significant (non-stopword) keywords also present in the candidate must clear `minCoverage`. Catches paraphrases that keep the required phrases but drop surrounding substance, or off-topic text that happens to contain one matched phrase.

`Verifier` is an interface with one method. A production system would implement it as:

```ts
class HttpVerifier implements Verifier {
  constructor(private baseUrl: string) {}
  async verify(candidateText: string, disclosure: DisclosureSpec) {
    const res = await fetch(`${this.baseUrl}/verify`, {
      method: "POST",
      body: JSON.stringify({ candidateText, disclosure }),
    });
    return (await res.json()) as VerificationResult; // same shape either way
  }
}
```

`ConversationEngine` depends only on the `Verifier` interface and never imports `KeywordCoverageVerifier` directly — swapping in an async, network-backed implementation (calling out to a Python service running a real NLI model) is a one-line change at the construction site, with zero changes to the machine or engine.

**Why not a real LLM for utterance generation?**
The point of this project is control flow, not language quality — calling a real, paid LLM API would add cost and non-determinism without demonstrating anything about the state machine. `TemplateGenerator` (`src/generator.ts`) fills `{{slot}}` placeholders in each state's canonical template. `UtteranceGenerator` is an interface; a production implementation could call a real model, still constrained to a state's intent:

```ts
class AnthropicGenerator implements UtteranceGenerator {
  constructor(private apiKey = process.env.ANTHROPIC_API_KEY) {}
  async generate(state: StateSpec, slots: Record<string, string>) {
    if (!this.apiKey) throw new Error("ANTHROPIC_API_KEY not set");
    // Call the model with something like:
    //   "Say the following in your own words, keeping all facts and
    //    legal language intact: <template with slots filled>"
    // Return the model's text. The engine still runs it through the
    // verifier before advancing, and the machine still owns the
    // transition — so a more creative model can't dodge a disclosure
    // by talking around it; it either includes the required content or
    // the machine holds the state and the call doesn't proceed.
  }
}
```

**Why JSON-Lines instead of Postgres?**
Running Postgres (or Docker) for a project this size is operational weight without proportional signal, and it complicates "clone and run." `AuditLog` is a two-method interface (`append`, `readAll`); the JSON-Lines implementation is genuinely append-only and tamper-evident via hash chaining, which is the property that actually matters for an audit trail. A production `PostgresAuditLog` would back the same interface with:

```sql
CREATE TABLE audit_entries (
  seq BIGSERIAL PRIMARY KEY,
  call_id TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  type TEXT NOT NULL,
  from_state TEXT, to_state TEXT, trigger TEXT NOT NULL,
  payload JSONB NOT NULL,
  hash TEXT NOT NULL, prev_hash TEXT
);
-- REVOKE UPDATE/DELETE from the application role, and ideally a
-- BEFORE UPDATE/DELETE trigger that raises, to make "append-only" a
-- database-enforced guarantee rather than just an application-level one.
```

`ConversationEngine` never changes, since it only depends on the `AuditLog` interface.

## Setup

Requires Node.js >= 18.

```bash
git clone https://github.com/Orenil/conversation-state-machine.git
cd conversation-state-machine
npm install
npm test      # runs the full suite (31 tests)
npm run demo  # runs two scripted calls end-to-end and prints the audit log
```

## Usage examples (real output)

### Running the test suite

```
$ npm test

> conversation-state-machine@1.0.0 test
> vitest run

 RUN  v3.2.7 /conversation-state-machine

 ✓ tests/audit.test.ts (3 tests) 13ms
 ✓ tests/verification.test.ts (6 tests) 3ms
 ✓ tests/machine.test.ts (5 tests) 9ms
 ✓ tests/adversarial.test.ts (3 tests) 9ms
 ✓ tests/integration.test.ts (4 tests) 10ms
 ✓ tests/mixedInitiative.test.ts (10 tests) 14ms

 Test Files  6 passed (6)
      Tests  31 passed (31)
```

(`machine.test.ts` intentionally sends an event to an already-terminated actor to prove it's rejected; xstate logs a one-line warning to stderr for that case — it's expected, not a failure.)

### Running the demo (`npm run demo`)

Scenario 1 plays the fully scripted happy path. Every disclosure-bearing utterance is verified before the machine allows the `ADVANCE` transition past it:

```
=== Scenario 1: scripted happy path ===

[greeting] agent: "Hello, this is Alex calling from Meridian Recovery Services. May I confirm I'm speaking with Jordan Rivera?"
  -> transitioned (greeting -> identity_verification)

[identity_verification] agent: "Thank you. Before we continue, can you confirm your date of birth for verification purposes?"
[identity_verification] debtor: "Yes, that's correct."
  -> transitioned (identity_verification -> mini_miranda)

[mini_miranda] agent: "Jordan Rivera, this communication is from a debt collector. This is an attempt to collect a debt, and any information obtained will be used for that purpose. This call may be recorded."
  verification: PASS (coverage=1)
  -> transitioned (mini_miranda -> purpose_statement)

[purpose_statement] agent: "I'm calling about an outstanding balance of $1,240.00 owed to Northgate Retail Card. Would you like to discuss payment options today?"
[purpose_statement] debtor: "Sure, let's discuss it."
  -> transitioned (purpose_statement -> payment_options)

[payment_options] agent: "We can offer a payment plan of $1,240.00 split over several months, or a one-time settlement. Would either of those work for you?"
  -> transitioned (payment_options -> closing_disclosure)

[closing_disclosure] agent: "Before we end this call: you have the right to dispute this debt in writing within thirty days. If you do not dispute it within that period, we will assume the debt is valid. Upon written request within that period, we will provide verification of the debt or the name of the original creditor. Thank you for your time, Jordan Rivera."
  verification: PASS (coverage=1)
  -> transitioned (closing_disclosure -> call_end)

Final state: call_end
```

Scenario 2 shows the debtor going off-script ("stop calling me") midway through the call. The off-script intent forces a transition straight out of `purpose_statement` into `cease_and_desist`, skipping the rest of the scripted flow — but the machine still requires the cease-and-desist acknowledgment to be verified before the call can end:

```
=== Scenario 2: off-script interrupt mid-call ===

[purpose_statement] agent: "I'm calling about an outstanding balance of $1,240.00 owed to Northgate Retail Card. Would you like to discuss payment options today?"
[purpose_statement] debtor: "Stop calling me, I don't want to talk about this."
  -> off-script intent "stop_calling" forced transition: purpose_statement -> cease_and_desist

[cease_and_desist] agent: "Understood. I will honor your request to stop calling you and will cease further telephone contact regarding this debt, as required by law."
  verification: PASS (coverage=1)

Final state: call_end
```

Audit log integrity, checked at the end of the demo:

```
=== Audit log integrity ===
happy-path: 17 entries, hash chain valid = true
off-script: 15 entries, hash chain valid = true
```

Sample audit entries (the tail of the off-script call — the forced transition, the resulting utterance, its verification, and the final ADVANCE into `call_end`):

```json
[
  {
    "callId": "call-off-script", "type": "transition",
    "fromState": "purpose_statement", "toState": "cease_and_desist",
    "trigger": "OFFSCRIPT_STOP_CALLING",
    "payload": { "accepted": true, "matchedIntent": "off_script", "offScriptIntentId": "stop_calling" },
    "seq": 12, "timestamp": "2026-08-12T17:45:35.397Z"
  },
  {
    "callId": "call-off-script", "type": "utterance",
    "fromState": "cease_and_desist", "toState": "cease_and_desist", "trigger": "GENERATE",
    "payload": { "utterance": "Understood. I will honor your request to stop calling you and will cease further telephone contact regarding this debt, as required by law." },
    "seq": 13
  },
  {
    "callId": "call-off-script", "type": "verification",
    "fromState": "cease_and_desist", "toState": "cease_and_desist", "trigger": "VERIFY",
    "payload": { "disclosureId": "cease_ack", "passed": true, "coverage": 1, "missingRequiredPhrases": [] },
    "seq": 14
  },
  {
    "callId": "call-off-script", "type": "transition",
    "fromState": "cease_and_desist", "toState": "call_end", "trigger": "ADVANCE",
    "payload": { "accepted": true }, "seq": 15
  }
]
```

The demo writes its own audit logs to `demo-audit-happy-path.jsonl` and `demo-audit-off-script.jsonl` in the repo root (gitignored — they're runtime output, not source).

## Testing

`npm test` runs all 31 tests across:

- **`tests/machine.test.ts`** — illegal-transition rejection at the pure xstate level: events undefined for the current state, `ADVANCE` blocked by an unmet disclosure guard, verifying the wrong disclosure ID not satisfying a different state's gate, and events sent to an already-terminal actor.
- **`tests/verification.test.ts`** — the classifier: passes canonical and on-script personalized text, and (adversarially) catches wholly off-topic text, truncated/corrupted text missing parts of a legally required disclosure, and subtly reworded text that drops a required phrase.
- **`tests/integration.test.ts`** — a full scripted conversation end-to-end via `ConversationEngine`, asserting both required disclosures are reached, verified, and PASS *before* the terminal state is entered, and that the audit trail's sequence numbers are gapless.
- **`tests/mixedInitiative.test.ts`** — off-script intents ("I dispute this debt," "stop calling me," mentioning an attorney) forcing a transition from every tested state, including the very first state and mid-branch states; plus exclusion behavior (an intent that's a no-op once you're already in its own landing state) and unrecognized input leaving the state unchanged.
- **`tests/adversarial.test.ts`** — end-to-end: feeding the engine corrupted/off-topic "generated" text via `speakCurrentState(overrideText)`, confirming the verifier flags it and the machine's guard refuses to `ADVANCE`, then confirming the gate unlocks again once a compliant utterance is supplied.
- **`tests/audit.test.ts`** — the JSON-Lines log is append-only across separate process instantiations, and tampering with a historical line is detected by `verifyChain()`.

## Project layout

```
src/
  types.ts          shared types (FlowConfig, DisclosureSpec, OffScriptIntent, ...)
  config/flow.ts     the declarative flow: states, disclosures, off-script intents
  machine.ts         compiles FlowConfig into a real xstate machine
  generator.ts       template-based utterance generator (+ LLM extension point)
  verification.ts    keyword/phrase-coverage disclosure verifier (+ sidecar extension point)
  audit.ts           hash-chained, append-only JSON-Lines audit log (+ Postgres extension point)
  engine.ts          ConversationEngine: orchestrates machine + generator + verifier + audit log
  cli.ts             demo runner (npm run demo)
  index.ts           public exports
tests/               vitest suite (31 tests, see above)
```

## Scope notes

This models one regulated flow (FDCPA-style debt collection) in depth rather than several flows shallowly. Swapping in a different regulated domain (healthcare intake, financial KYC) means editing `src/config/flow.ts` — states, disclosures, and off-script intents are pure data, not code. Not implemented, by design, per the scope of this project: a real Python verification sidecar, a real LLM integration, and a Postgres-backed audit store — each has a documented interface and a worked example above showing exactly how it plugs in.
