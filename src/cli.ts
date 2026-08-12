import { debtCollectionFlow } from "./config/flow.js";
import { ConversationEngine } from "./engine.js";
import { TemplateGenerator } from "./generator.js";
import { KeywordCoverageVerifier } from "./verification.js";
import { JsonlAuditLog } from "./audit.js";

/**
 * Demo runner: plays two conversations end-to-end against the same
 * declarative flow, printing every generated utterance, verification
 * result, and transition — then prints the resulting audit log and its
 * hash-chain integrity check.
 *
 * 1. A full happy-path call: greeting -> identity check -> disclosure ->
 *    purpose -> payment options -> closing disclosure -> end.
 * 2. A call where the debtor invokes an off-script right ("stop calling
 *    me") midway through, proving the machine forces a transition out of
 *    the scripted flow regardless of which state it was in.
 *
 * Run with: npm run demo
 */

const slots = {
  agentName: "Alex",
  companyName: "Meridian Recovery Services",
  debtorName: "Jordan Rivera",
  debtAmount: "$1,240.00",
  creditorName: "Northgate Retail Card",
};

function printSpeak(result: { stateId: string; utterance: string; verification?: { passed: boolean; coverage: number } }) {
  console.log(`\n[${result.stateId}] agent: "${result.utterance}"`);
  if (result.verification) {
    console.log(
      `  verification: ${result.verification.passed ? "PASS" : "FAIL"} (coverage=${result.verification.coverage})`,
    );
  }
}

function runHappyPath() {
  console.log("=== Scenario 1: scripted happy path ===");
  const auditLog = new JsonlAuditLog("demo-audit-happy-path.jsonl");
  const engine = new ConversationEngine({
    flow: debtCollectionFlow,
    generator: new TemplateGenerator(),
    verifier: new KeywordCoverageVerifier(),
    auditLog,
    slots,
    callId: "call-happy-path",
  });
  engine.start();

  const userTurns: Record<string, string> = {
    identity_verification: "Yes, that's correct.",
    purpose_statement: "Sure, let's discuss it.",
  };

  let guard = 0;
  while (!engine.isDone() && guard < 20) {
    guard += 1;
    const spoken = engine.speakCurrentState();
    printSpeak(spoken);

    const stateId = spoken.stateId;
    const userLine = userTurns[stateId];
    if (userLine) {
      console.log(`[${stateId}] debtor: "${userLine}"`);
      const result = engine.userSays(userLine);
      console.log(`  -> ${result.accepted ? "transitioned" : "stayed"} (${result.fromState} -> ${result.toState})`);
    } else {
      const result = engine.advance();
      console.log(`  -> ${result.accepted ? "transitioned" : "stayed"} (${result.fromState} -> ${result.toState})`);
    }
  }

  console.log(`\nFinal state: ${engine.currentStateId()}`);
  return auditLog;
}

function runOffScriptInterrupt() {
  console.log("\n\n=== Scenario 2: off-script interrupt mid-call ===");
  const auditLog = new JsonlAuditLog("demo-audit-off-script.jsonl");
  const engine = new ConversationEngine({
    flow: debtCollectionFlow,
    generator: new TemplateGenerator(),
    verifier: new KeywordCoverageVerifier(),
    auditLog,
    slots,
    callId: "call-off-script",
  });
  engine.start();

  printSpeak(engine.speakCurrentState()); // greeting
  engine.advance();

  printSpeak(engine.speakCurrentState()); // identity_verification
  console.log(`[identity_verification] debtor: "Yes, that's me."`);
  engine.userSays("Yes, that's me.");

  printSpeak(engine.speakCurrentState()); // mini_miranda
  engine.advance();

  printSpeak(engine.speakCurrentState()); // purpose_statement
  console.log(`[purpose_statement] debtor: "Stop calling me, I don't want to talk about this."`);
  const interrupt = engine.userSays("Stop calling me, I don't want to talk about this.");
  console.log(
    `  -> off-script intent "${interrupt.offScriptIntentId}" forced transition: ${interrupt.fromState} -> ${interrupt.toState}`,
  );

  printSpeak(engine.speakCurrentState()); // cease_and_desist
  engine.advance();

  console.log(`\nFinal state: ${engine.currentStateId()}`);
  return auditLog;
}

const log1 = runHappyPath();
const log2 = runOffScriptInterrupt();

console.log("\n\n=== Audit log integrity ===");
for (const [label, log] of [
  ["happy-path", log1],
  ["off-script", log2],
] as const) {
  const check = log.verifyChain();
  console.log(`${label}: ${log.readAll().length} entries, hash chain valid = ${check.valid}`);
}

console.log("\n=== Sample audit entries (off-script call, last 4) ===");
console.log(JSON.stringify(log2.readAll().slice(-4), null, 2));
