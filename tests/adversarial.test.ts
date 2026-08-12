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
  const auditLog = new InMemoryAuditLog();
  const engine = new ConversationEngine({
    flow: debtCollectionFlow,
    generator: new TemplateGenerator(),
    verifier: new KeywordCoverageVerifier(),
    auditLog,
    slots,
    callId: "call-adversarial",
  });
  engine.start();
  return { engine, auditLog };
}

/**
 * End-to-end adversarial test: simulates what happens when the utterance
 * generator (standing in for an LLM in production) produces corrupted or
 * off-topic text instead of the required disclosure. The verifier must
 * catch it, and — because the state machine's guard is wired to the
 * verifier's result, not to "an utterance was produced" — the machine
 * must refuse to advance past the disclosure state.
 */
describe("adversarial: corrupted/off-topic generated text is caught end-to-end", () => {
  it("refuses to leave mini_miranda when the generated utterance is off-topic garbage", () => {
    const { engine, auditLog } = makeEngine();
    engine.advance(); // greeting -> identity_verification
    engine.userSays("Yes, that's correct."); // -> mini_miranda

    const corrupted = "So anyway, did you catch the game last night? Great weather we're having.";
    const spoken = engine.speakCurrentState(corrupted);

    expect(spoken.verification).toBeDefined();
    expect(spoken.verification!.passed).toBe(false);

    const attempt = engine.advance();
    expect(attempt.accepted).toBe(false);
    expect(engine.currentStateId()).toBe("mini_miranda");

    const verificationEntries = auditLog.readAll().filter((e) => e.type === "verification");
    expect(verificationEntries).toHaveLength(1);
    expect((verificationEntries[0]!.payload as { passed: boolean }).passed).toBe(false);
  });

  it("refuses to leave closing_disclosure when the generated text truncates the legally required content", () => {
    const { engine } = makeEngine();
    engine.advance();
    engine.userSays("Yes, that's correct.");
    engine.speakCurrentState(); // mini_miranda, on-script -> passes
    engine.advance();
    engine.userSays("Sure, let's discuss it."); // purpose_statement -> payment_options
    engine.speakCurrentState();
    engine.advance(); // -> closing_disclosure

    // A garbled/cut-off model response that drops the dispute window and
    // verification-of-debt clause -- exactly the failure mode this whole
    // project exists to prevent.
    const corrupted = "Okay, thanks for your time today, goodbye!";
    engine.speakCurrentState(corrupted);

    const attempt = engine.advance();
    expect(attempt.accepted).toBe(false);
    expect(engine.currentStateId()).toBe("closing_disclosure");
  });

  it("recovers once a compliant utterance is (re-)generated for the same state", () => {
    const { engine } = makeEngine();
    engine.advance();
    engine.userSays("Yes, that's correct.");

    engine.speakCurrentState("This is definitely not a legal disclosure of any kind.");
    expect(engine.advance().accepted).toBe(false);

    // Re-speaking the state with the real (on-script) template should
    // re-verify and unlock the gate -- the block is on unmet content, not
    // a one-shot penalty.
    engine.speakCurrentState();
    const retried = engine.advance();
    expect(retried.accepted).toBe(true);
    expect(engine.currentStateId()).toBe("purpose_statement");
  });
});
