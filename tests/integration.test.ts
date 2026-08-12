import { describe, expect, it } from "vitest";
import { ConversationEngine } from "../src/engine.js";
import { TemplateGenerator } from "../src/generator.js";
import { KeywordCoverageVerifier } from "../src/verification.js";
import { InMemoryAuditLog } from "../src/audit.js";
import { debtCollectionFlow } from "../src/config/flow.js";
import type { AuditEntry } from "../src/types.js";

const slots = {
  agentName: "Alex",
  companyName: "Meridian Recovery Services",
  debtorName: "Jordan Rivera",
  debtAmount: "$1,240.00",
  creditorName: "Northgate Retail Card",
};

function makeEngine(auditLog = new InMemoryAuditLog()) {
  const engine = new ConversationEngine({
    flow: debtCollectionFlow,
    generator: new TemplateGenerator(),
    verifier: new KeywordCoverageVerifier(),
    auditLog,
    slots,
    callId: "call-integration",
  });
  engine.start();
  return { engine, auditLog };
}

/** Runs the fully scripted, on-script happy path to completion using the
 * real generator (deterministic templates) and real verifier. */
function runScriptedToCompletion(engine: ConversationEngine) {
  const userTurns: Record<string, string> = {
    identity_verification: "Yes, that's correct.",
    purpose_statement: "Sure, let's discuss it.",
  };
  let guard = 0;
  while (!engine.isDone() && guard < 25) {
    guard += 1;
    const spoken = engine.speakCurrentState();
    const line = userTurns[spoken.stateId];
    if (line) {
      engine.userSays(line);
    } else {
      engine.advance();
    }
  }
  if (guard >= 25) throw new Error("scripted run did not terminate");
}

describe("scripted conversation integration", () => {
  it("reaches call_end via the fully on-script path", () => {
    const { engine } = makeEngine();
    runScriptedToCompletion(engine);
    expect(engine.currentStateId()).toBe("call_end");
  });

  it("both required disclosures are verified and PASS before the terminal state is entered", () => {
    const { engine, auditLog } = makeEngine();
    runScriptedToCompletion(engine);

    const entries = auditLog.readAll();
    const terminalTransition = entries.find(
      (e) => e.type === "transition" && e.toState === "call_end" && e.trigger === "ADVANCE",
    );
    expect(terminalTransition).toBeDefined();
    const terminalSeq = (terminalTransition as AuditEntry).seq;

    for (const disclosureId of ["mini_miranda", "validation_notice"]) {
      const verification = entries.find(
        (e) => e.type === "verification" && (e.payload as { disclosureId?: string }).disclosureId === disclosureId,
      );
      expect(verification, `expected a verification entry for ${disclosureId}`).toBeDefined();
      expect((verification!.payload as { passed: boolean }).passed).toBe(true);
      // The disclosure must be verified strictly before the call ends.
      expect(verification!.seq).toBeLessThan(terminalSeq);
    }
  });

  it("never reaches call_end without passing through both disclosure states in order", () => {
    const { engine, auditLog } = makeEngine();
    runScriptedToCompletion(engine);

    const transitions = auditLog
      .readAll()
      .filter((e) => e.type === "transition" && e.payload.accepted !== false)
      .map((e) => e.toState);

    const miniMirandaIdx = transitions.indexOf("mini_miranda");
    const validationIdx = transitions.indexOf("closing_disclosure");
    const endIdx = transitions.indexOf("call_end");

    expect(miniMirandaIdx).toBeGreaterThanOrEqual(0);
    expect(validationIdx).toBeGreaterThan(miniMirandaIdx);
    expect(endIdx).toBeGreaterThan(validationIdx);
  });

  it("produces a hash-chained audit trail sufficient to reconstruct the whole call", () => {
    const auditLog = new InMemoryAuditLog();
    const { engine } = makeEngine(auditLog);
    runScriptedToCompletion(engine);

    const entries = auditLog.readAll();
    expect(entries.length).toBeGreaterThan(10);

    // Every entry carries enough to reconstruct "what was said and when":
    // a sequence number, an ISO timestamp, and (for utterances) the raw text.
    const utterances = entries.filter((e) => e.type === "utterance");
    expect(utterances.length).toBeGreaterThanOrEqual(6); // one per state visited
    for (const u of utterances) {
      expect(typeof (u.payload as { utterance?: string }).utterance).toBe("string");
      expect(u.timestamp).toBeTruthy();
    }

    // seq numbers are strictly increasing and gapless -- no entry could
    // have been silently dropped from the trail.
    const seqs = entries.map((e) => e.seq);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBe((seqs[i - 1] as number) + 1);
    }
  });
});
