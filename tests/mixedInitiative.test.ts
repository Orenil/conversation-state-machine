import { describe, expect, it } from "vitest";
import { ConversationEngine } from "../src/engine.js";
import { TemplateGenerator } from "../src/generator.js";
import { KeywordCoverageVerifier } from "../src/verification.js";
import { InMemoryAuditLog } from "../src/audit.js";
import { debtCollectionFlow } from "../src/config/flow.js";

const slots = {
  agentName: "Alex",
  companyName: "Meridian Recovery Services",
  debtorName: "Jordan Rivera",
  debtAmount: "$1,240.00",
  creditorName: "Northgate Retail Card",
};

function makeEngine() {
  const engine = new ConversationEngine({
    flow: debtCollectionFlow,
    generator: new TemplateGenerator(),
    verifier: new KeywordCoverageVerifier(),
    auditLog: new InMemoryAuditLog(),
    slots,
    callId: "call-mixed-initiative",
  });
  engine.start();
  return engine;
}

/** Scripts the engine forward, on-script, until it reaches `targetStateId`
 * (without ever triggering an off-script intent). Used to put the machine
 * in a specific mid-conversation state before testing an interrupt. */
function driveTo(engine: ConversationEngine, targetStateId: string) {
  const affirmativeBranches: Record<string, string> = {
    identity_verification: "Yes, that's correct.",
    purpose_statement: "Sure, let's discuss it.",
  };
  let guard = 0;
  while (engine.currentStateId() !== targetStateId && guard < 25) {
    guard += 1;
    engine.speakCurrentState();
    const stateId = engine.currentStateId();
    const line = affirmativeBranches[stateId];
    if (line) {
      engine.userSays(line);
    } else {
      engine.advance();
    }
  }
  if (engine.currentStateId() !== targetStateId) {
    throw new Error(`could not drive engine to ${targetStateId}, stuck at ${engine.currentStateId()}`);
  }
}

describe("mixed initiative: off-script intents preempt the script from any state", () => {
  const statesToTest = ["greeting", "identity_verification", "mini_miranda", "purpose_statement", "payment_options"];

  for (const startState of statesToTest) {
    it(`"I dispute this debt" forces a transition to dispute_handling from ${startState}`, () => {
      const engine = makeEngine();
      driveTo(engine, startState);

      const result = engine.userSays("I dispute this debt, it's not mine.");

      expect(result.matchedIntent).toBe("off_script");
      expect(result.offScriptIntentId).toBe("dispute_debt");
      expect(result.accepted).toBe(true);
      expect(engine.currentStateId()).toBe("dispute_handling");
    });
  }

  it('"stop calling me" forces a transition to cease_and_desist from a scripted mid-call state', () => {
    const engine = makeEngine();
    driveTo(engine, "payment_options");

    const result = engine.userSays("Please stop calling me, I'm done with this conversation.");

    expect(result.offScriptIntentId).toBe("stop_calling");
    expect(engine.currentStateId()).toBe("cease_and_desist");
  });

  it('mentioning an attorney forces a transition to attorney_representation from the very first state', () => {
    const engine = makeEngine();
    // No driveTo: fired from the initial state, before any script progress.
    const result = engine.userSays("Please speak to my attorney about this.");

    expect(result.offScriptIntentId).toBe("attorney_referral");
    expect(engine.currentStateId()).toBe("attorney_representation");
  });

  it("off-script intents still require their own disclosure to be verified before advancing further", () => {
    const engine = makeEngine();
    driveTo(engine, "purpose_statement");
    engine.userSays("I dispute this debt.");
    expect(engine.currentStateId()).toBe("dispute_handling");

    // Attempting to move past dispute_handling without speaking (and thus
    // verifying) its disclosure must be rejected, same as any other
    // disclosure-bearing state.
    const attempt = engine.advance();
    expect(attempt.accepted).toBe(false);
    expect(engine.currentStateId()).toBe("dispute_handling");

    engine.speakCurrentState();
    const accepted = engine.advance();
    expect(accepted.accepted).toBe(true);
    expect(engine.currentStateId()).toBe("call_end");
  });

  it("an excluded off-script intent is a no-op when already in its own landing state", () => {
    const engine = makeEngine();
    driveTo(engine, "purpose_statement");
    engine.userSays("I dispute this debt.");
    expect(engine.currentStateId()).toBe("dispute_handling");

    // dispute_handling is in dispute_debt's excludeFrom list: re-firing
    // the same intent must not re-trigger or otherwise disturb the state.
    const result = engine.userSays("I really dispute this, it's not my debt.");
    expect(result.matchedIntent).toBe("off_script");
    expect(result.accepted).toBe(false);
    expect(engine.currentStateId()).toBe("dispute_handling");
  });

  it("unrecognized user input is neither an off-script trigger nor a branch match, and leaves state unchanged", () => {
    const engine = makeEngine();
    driveTo(engine, "identity_verification");

    const result = engine.userSays("What's the weather like today?");
    expect(result.matchedIntent).toBe("unrecognized");
    expect(result.accepted).toBe(false);
    expect(engine.currentStateId()).toBe("identity_verification");
  });
});
