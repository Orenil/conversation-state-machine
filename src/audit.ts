import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AuditEntry } from "./types.js";

/**
 * Append-only, hash-chained audit trail: every transition, trigger, and
 * verification result is logged here so a call can be reconstructed
 * exactly. Storage is a real append-only JSON-Lines file (opened with the
 * `a` flag, never rewritten), with each entry's hash covering the
 * previous entry's hash, so edits or deletions are detectable via
 * `verifyChain()`. See README.md "Why JSON-Lines instead of Postgres" for
 * the swap-in path — `AuditLog` is a two-method interface
 * (`append`/`readAll`) a `PostgresAuditLog` could implement identically.
 */
export interface AuditLog {
  append(entry: Omit<AuditEntry, "seq" | "hash" | "prevHash" | "timestamp">): AuditEntry;
  readAll(): AuditEntry[];
}

function computeHash(prevHash: string | null, content: Omit<AuditEntry, "hash">): string {
  const h = createHash("sha256");
  h.update(prevHash ?? "GENESIS");
  h.update(JSON.stringify(content));
  return h.digest("hex");
}

/** JSON-Lines-backed append-only audit log with a tamper-evident hash
 * chain. Default store for both the demo CLI and the test suite. */
export class JsonlAuditLog implements AuditLog {
  private readonly filePath: string;
  private seq = 0;
  private lastHash: string | null = null;

  constructor(filePath: string) {
    this.filePath = filePath;
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (existsSync(filePath)) {
      const existing = this.readAll();
      if (existing.length > 0) {
        const last = existing[existing.length - 1] as AuditEntry;
        this.seq = last.seq;
        this.lastHash = last.hash;
      }
    }
  }

  append(entry: Omit<AuditEntry, "seq" | "hash" | "prevHash" | "timestamp">): AuditEntry {
    this.seq += 1;
    const withoutHash = {
      ...entry,
      seq: this.seq,
      timestamp: new Date().toISOString(),
      prevHash: this.lastHash,
    };
    const hash = computeHash(this.lastHash, withoutHash);
    const full: AuditEntry = { ...withoutHash, hash };
    appendFileSync(this.filePath, JSON.stringify(full) + "\n", "utf8");
    this.lastHash = hash;
    return full;
  }

  readAll(): AuditEntry[] {
    if (!existsSync(this.filePath)) return [];
    const raw = readFileSync(this.filePath, "utf8");
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as AuditEntry);
  }

  /** Re-walks the hash chain and returns whether every entry is
   * consistent with its predecessor — the tamper-evidence check. */
  verifyChain(): { valid: boolean; brokenAtSeq: number | null } {
    const entries = this.readAll();
    let prevHash: string | null = null;
    for (const entry of entries) {
      const { hash, ...rest } = entry;
      const expected = computeHash(prevHash, rest);
      if (expected !== hash || entry.prevHash !== prevHash) {
        return { valid: false, brokenAtSeq: entry.seq };
      }
      prevHash = hash;
    }
    return { valid: true, brokenAtSeq: null };
  }
}

/** Ephemeral, in-memory implementation — no filesystem I/O. Handy for unit
 * tests that only care about log contents, not persistence. */
export class InMemoryAuditLog implements AuditLog {
  private entries: AuditEntry[] = [];
  private seq = 0;
  private lastHash: string | null = null;

  append(entry: Omit<AuditEntry, "seq" | "hash" | "prevHash" | "timestamp">): AuditEntry {
    this.seq += 1;
    const withoutHash = {
      ...entry,
      seq: this.seq,
      timestamp: new Date().toISOString(),
      prevHash: this.lastHash,
    };
    const hash = computeHash(this.lastHash, withoutHash);
    const full: AuditEntry = { ...withoutHash, hash };
    this.entries.push(full);
    this.lastHash = hash;
    return full;
  }

  readAll(): AuditEntry[] {
    return [...this.entries];
  }
}
