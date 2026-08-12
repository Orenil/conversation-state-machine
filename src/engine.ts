import { createActor, type Actor } from "xstate";
import { buildMachine, offscriptEventName, type FlowMachine } from "./machine.js";
import type { UtteranceGenerator } from "./generator.js";
import type { Verifier } from "./verification.js";
import type { AuditLog } from "./audit.js";
import type { FlowConfig, StateSpec, VerificationResult } from "./types.js";

const AFFIRM_PATTERN = /^(yes|yeah|yep|sure|correct|confirm|confirmed|ok|okay|that's right|affirmative)\b/i;
const DENY_PATTERN = /^(no|nope|nah|wrong|incorrect|negative|not (me|right))\b/i;

export interface SpeakResult {
  stateId: string;
  utterance: string;
  verification?: VerificationResult;
}

export interface TransitionAttemptResult {
  trigger: string;
  fromState: string;
  toState: string;
  accepted: boolean;
}

export interface UserInputResult extends TransitionAttemptResult {
  matchedIntent: "off_script" | "affirm" | "deny" | "unrecognized";
  offScriptIntentId?: string;
}

/**
 * Orchestrates one conversation: owns the xstate actor, calls the
 * generator to produce utterances, runs the verifier against
 * disclosure-bearing states, and writes every transition/utterance/
 * verification event to the audit log. This is the only place that talks
 * to all four collaborators — the machine itself never imports the
 * generator or verifier, and the generator/verifier never know the
 * machine exists.
 */
export class ConversationEngine {
  private readonly flow: FlowConfig;
  private readonly generator: UtteranceGenerator;
  private readonly verifier: Verifier;
  private readonly auditLog: AuditLog;
  private readonly slots: Record<string, string>;
  private readonly callId: string;
  private readonly machine: FlowMachine;
  private readonly actor: Actor<FlowMachine>;
  private readonly stateById: Map<string, StateSpec>;

  constructor(opts: {
    flow: FlowConfig;
    generator: UtteranceGenerator;
    verifier: Verifier;
    auditLog: AuditLog;
    slots: Record<string, string>;
    callId: string;
  }) {
    this.flow = opts.flow;
    this.generator = opts.generator;
    this.verifier = opts.verifier;
    this.auditLog = opts.auditLog;
    this.slots = opts.slots;
    this.callId = opts.callId;
    this.stateById = new Map(opts.flow.states.map((s) => [s.id, s]));

    this.machine = buildMachine(opts.flow);
    this.actor = createActor(this.machine);
  }

  start(): void {
    this.actor.start();
    this.auditLog.append({
      callId: this.callId,
      type: "transition",
      fromState: null,
      toState: this.currentStateId(),
      trigger: "START",
      payload: {},
    });
  }

  currentStateId(): string {
    return String(this.actor.getSnapshot().value);
  }

  currentStateSpec(): StateSpec {
    const spec = this.stateById.get(this.currentStateId());
    if (!spec) throw new Error(`Unknown state: ${this.currentStateId()}`);
    return spec;
  }

  isDone(): boolean {
    return this.actor.getSnapshot().status === "done";
  }

  /** Generates (or, for tests, accepts an override for) the utterance for
   * the current state and — if that state has a required disclosure —
   * runs it through the verifier and records the result in machine
   * context via SET_VERIFIED. This does NOT attempt any transition. */
  speakCurrentState(overrideText?: string): SpeakResult {
    const state = this.currentStateSpec();
    const utterance = overrideText ?? this.generator.generate(state, this.slots);

    this.auditLog.append({
      callId: this.callId,
      type: "utterance",
      fromState: state.id,
      toState: state.id,
      trigger: overrideText ? "GENERATE_OVERRIDE" : "GENERATE",
      payload: { utterance },
    });

    let verification: VerificationResult | undefined;
    if (state.disclosure) {
      verification = this.verifier.verify(utterance, state.disclosure);
      this.auditLog.append({
        callId: this.callId,
        type: "verification",
        fromState: state.id,
        toState: state.id,
        trigger: "VERIFY",
        payload: { ...verification },
      });
      this.actor.send({ type: "SET_VERIFIED", stateId: state.id, passed: verification.passed });
    }

    return { stateId: state.id, utterance, verification };
  }

  /** Attempts the state's on-script forward transition (`ADVANCE`). If the
   * state has an unmet disclosure requirement, the machine's guard
   * rejects it and the machine stays put — that rejection is itself
   * logged, since "the system correctly refused to move on" is part of
   * the audit trail. */
  advance(): TransitionAttemptResult {
    const from = this.currentStateId();
    this.actor.send({ type: "ADVANCE" });
    const to = this.currentStateId();
    const accepted = to !== from;
    this.auditLog.append({
      callId: this.callId,
      type: "transition",
      fromState: from,
      toState: to,
      trigger: "ADVANCE",
      payload: { accepted },
    });
    return { trigger: "ADVANCE", fromState: from, toState: to, accepted };
  }

  /** Feeds raw user text through: (1) the global off-script intent
   * matcher, which can fire from any non-excluded state, then (2) if
   * nothing off-script matched, a simple affirm/deny matcher against the
   * current state's branches, if any. Every attempt — matched or not,
   * accepted or rejected by the machine — is written to the audit log. */
  userSays(text: string): UserInputResult {
    const from = this.currentStateId();
    this.auditLog.append({
      callId: this.callId,
      type: "user_input",
      fromState: from,
      toState: from,
      trigger: "USER_INPUT",
      payload: { text },
    });

    const offScriptIntent = this.flow.offScriptIntents.find((intent) =>
      intent.patterns.some((pattern) => pattern.test(text)),
    );

    let matchedIntent: UserInputResult["matchedIntent"] = "unrecognized";
    let eventType: string | undefined;
    let offScriptIntentId: string | undefined;

    if (offScriptIntent) {
      matchedIntent = "off_script";
      offScriptIntentId = offScriptIntent.id;
      eventType = offscriptEventName(offScriptIntent.id);
    } else if (AFFIRM_PATTERN.test(text)) {
      matchedIntent = "affirm";
      eventType = "AFFIRM";
    } else if (DENY_PATTERN.test(text)) {
      matchedIntent = "deny";
      eventType = "DENY";
    }

    if (eventType) {
      this.actor.send({ type: eventType, intentId: offScriptIntentId, matchedText: text });
    }

    const to = this.currentStateId();
    const accepted = to !== from;

    this.auditLog.append({
      callId: this.callId,
      type: "transition",
      fromState: from,
      toState: to,
      trigger: eventType ?? "UNRECOGNIZED",
      payload: { accepted, matchedIntent, offScriptIntentId },
    });

    return { trigger: eventType ?? "UNRECOGNIZED", fromState: from, toState: to, accepted, matchedIntent, offScriptIntentId };
  }
}
