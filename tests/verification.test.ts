import { describe, expect, it } from "vitest";
import { KeywordCoverageVerifier } from "../src/verification.js";
import { debtCollectionFlow } from "../src/config/flow.js";
import type { DisclosureSpec } from "../src/types.js";

function disclosure(id: string): DisclosureSpec {
  const state = debtCollectionFlow.states.find((s) => s.disclosure?.id === id);
  if (!state?.disclosure) throw new Error(`no disclosure ${id} in fixture flow`);
  return state.disclosure;
}

describe("KeywordCoverageVerifier", () => {
  const verifier = new KeywordCoverageVerifier();

  it("passes the canonical text against itself", () => {
    const miniMiranda = disclosure("mini_miranda");
    const result = verifier.verify(miniMiranda.canonicalText, miniMiranda);
    expect(result.passed).toBe(true);
    expect(result.missingRequiredPhrases).toEqual([]);
    expect(result.coverage).toBe(1);
  });

  it("passes a personalized on-script utterance that still contains the required phrases", () => {
    const miniMiranda = disclosure("mini_miranda");
    const utterance =
      "Jordan Rivera, this communication is from a debt collector. This is an attempt to collect a debt, and any information obtained will be used for that purpose. This call may be recorded.";
    const result = verifier.verify(utterance, miniMiranda);
    expect(result.passed).toBe(true);
  });

  it("ADVERSARIAL: catches wholly off-topic generated text (e.g. a hallucinated/garbled model output)", () => {
    const miniMiranda = disclosure("mini_miranda");
    const corrupted =
      "Hey there! Beautiful weather we're having. Anyway, would you like to hear about our new rewards program and travel discounts?";
    const result = verifier.verify(corrupted, miniMiranda);

    expect(result.passed).toBe(false);
    expect(result.missingRequiredPhrases).toEqual(
      expect.arrayContaining(["debt collector", "attempt to collect a debt"]),
    );
    expect(result.coverage).toBeLessThan(miniMiranda.minCoverage);
  });

  it("ADVERSARIAL: catches partial/corrupted text that keeps one required phrase but drops the rest of the disclosure", () => {
    const validationNotice = disclosure("validation_notice");
    // Contains "dispute this debt" but strips the timeframe and the
    // verification-of-debt clause entirely -- a truncated/garbled output.
    const corrupted = "You have the right to dispute this debt. Thanks, bye.";
    const result = verifier.verify(corrupted, validationNotice);

    expect(result.passed).toBe(false);
    expect(result.missingRequiredPhrases).toContain("thirty days");
    expect(result.missingRequiredPhrases).toContain("verification of the debt");
  });

  it("fails when a required phrase is subtly reworded away from its legal meaning", () => {
    const miniMiranda = disclosure("mini_miranda");
    // Swaps "debt collector" for a euphemism -- exactly the kind of drift
    // an unconstrained LLM might introduce.
    const reworded =
      "This communication is from a friendly account representative. This is an attempt to collect a debt, and any information obtained will be used for that purpose.";
    const result = verifier.verify(reworded, miniMiranda);

    expect(result.passed).toBe(false);
    expect(result.missingRequiredPhrases).toContain("debt collector");
  });

  it("computes proportional keyword coverage rather than an all-or-nothing score", () => {
    const miniMiranda = disclosure("mini_miranda");
    const halfBaked = "This is an attempt to collect a debt.";
    const result = verifier.verify(halfBaked, miniMiranda);
    expect(result.coverage).toBeGreaterThan(0);
    expect(result.coverage).toBeLessThan(1);
  });
});
