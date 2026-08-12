import type { DisclosureSpec, VerificationResult } from "./types.js";

/**
 * The verification classifier: checks a candidate utterance against a
 * disclosure's required content, independent of whatever produced the
 * utterance. Implemented in-process and deterministically (no Python
 * sidecar) via two checks — required-phrase presence and keyword
 * coverage. See README.md "Why not a Python NLP sidecar" for the
 * rationale and `HttpVerifier` for how a real one plugs in via this same
 * `Verifier` interface without touching `ConversationEngine`.
 */
export interface Verifier {
  verify(candidateText: string, disclosure: DisclosureSpec): VerificationResult;
}

const STOPWORDS = new Set([
  "a", "an", "the", "this", "that", "these", "those", "is", "are", "was",
  "were", "be", "been", "being", "to", "of", "in", "on", "for", "and", "or",
  "will", "we", "you", "your", "it", "its", "as", "by", "with", "from",
  "any", "or", "may", "if", "not", "do", "does", "within", "upon", "i",
  "have", "has", "had", "at", "our",
]);

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function significantKeywords(text: string): string[] {
  const words = normalize(text).split(" ").filter(Boolean);
  return [...new Set(words.filter((w) => !STOPWORDS.has(w) && w.length > 2))];
}

/**
 * Deterministic, in-process implementation of `Verifier` described above.
 */
export class KeywordCoverageVerifier implements Verifier {
  verify(candidateText: string, disclosure: DisclosureSpec): VerificationResult {
    const normalizedCandidate = normalize(candidateText);

    const missingRequiredPhrases = disclosure.requiredPhrases.filter(
      (phrase) => !normalizedCandidate.includes(normalize(phrase)),
    );

    const keywords = significantKeywords(disclosure.canonicalText);
    const matchedKeywords = keywords.filter((kw) => normalizedCandidate.includes(kw));
    const missingKeywords = keywords.filter((kw) => !normalizedCandidate.includes(kw));
    const coverage = keywords.length === 0 ? 1 : matchedKeywords.length / keywords.length;

    const passed = missingRequiredPhrases.length === 0 && coverage >= disclosure.minCoverage;

    return {
      disclosureId: disclosure.id,
      passed,
      coverage: Number(coverage.toFixed(3)),
      missingRequiredPhrases,
      matchedKeywords,
      missingKeywords,
    };
  }
}
