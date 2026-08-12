import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlAuditLog } from "../src/audit.js";

describe("JsonlAuditLog", () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "csm-audit-test-"));
    filePath = join(dir, "audit.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("appends entries with a valid, gapless hash chain", () => {
    const log = new JsonlAuditLog(filePath);
    log.append({ callId: "c1", type: "transition", fromState: null, toState: "greeting", trigger: "START", payload: {} });
    log.append({ callId: "c1", type: "utterance", fromState: "greeting", toState: "greeting", trigger: "GENERATE", payload: { utterance: "hi" } });

    const check = log.verifyChain();
    expect(check.valid).toBe(true);
    expect(log.readAll()).toHaveLength(2);
  });

  it("is genuinely append-only across process boundaries: a fresh instance continues the same chain", () => {
    const log1 = new JsonlAuditLog(filePath);
    log1.append({ callId: "c1", type: "transition", fromState: null, toState: "greeting", trigger: "START", payload: {} });

    const log2 = new JsonlAuditLog(filePath);
    log2.append({ callId: "c1", type: "transition", fromState: "greeting", toState: "identity_verification", trigger: "ADVANCE", payload: {} });

    const entries = log2.readAll();
    expect(entries).toHaveLength(2);
    expect(entries[1]!.prevHash).toBe(entries[0]!.hash);
    expect(log2.verifyChain().valid).toBe(true);
  });

  it("detects tampering with a historical entry", () => {
    const log = new JsonlAuditLog(filePath);
    log.append({ callId: "c1", type: "transition", fromState: null, toState: "greeting", trigger: "START", payload: {} });
    log.append({ callId: "c1", type: "utterance", fromState: "greeting", toState: "greeting", trigger: "GENERATE", payload: { utterance: "hi" } });

    const lines = readFileSync(filePath, "utf8").trimEnd().split("\n");
    const tampered = JSON.parse(lines[0]!);
    tampered.payload = { injected: true };
    lines[0] = JSON.stringify(tampered);
    writeFileSync(filePath, lines.join("\n") + "\n", "utf8");

    const reloaded = new JsonlAuditLog(filePath);
    const check = reloaded.verifyChain();
    expect(check.valid).toBe(false);
    expect(check.brokenAtSeq).toBe(1);
  });
});
