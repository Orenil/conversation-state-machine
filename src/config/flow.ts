import type { FlowConfig } from "../types.js";

/**
 * Declarative flow for a (fictional, illustrative) FDCPA-governed debt
 * collection call. This is the single source of truth for:
 *   - what states the conversation can be in,
 *   - what must legally be disclosed in each state,
 *   - what utterance template the generator uses per state,
 *   - which off-script user intents can preempt the script from anywhere.
 *
 * Nothing here is TypeScript control flow — it's data. src/machine.ts
 * compiles it into an xstate machine; src/generator.ts and
 * src/verification.ts consume it directly. Swapping industries (healthcare
 * intake, financial-services KYC) means editing this file, not the engine.
 */
export const debtCollectionFlow: FlowConfig = {
  id: "debt-collection-call",
  initial: "greeting",
  states: [
    {
      id: "greeting",
      template:
        "Hello, this is {{agentName}} calling from {{companyName}}. May I confirm I'm speaking with {{debtorName}}?",
      next: "identity_verification",
    },
    {
      id: "identity_verification",
      template:
        "Thank you. Before we continue, can you confirm your date of birth for verification purposes?",
      branches: {
        affirm: "mini_miranda",
        deny: "wrong_party",
      },
    },
    {
      id: "wrong_party",
      template:
        "I apologize for the confusion. This call was intended for someone else. I'll remove this number from the file. Have a good day.",
      terminal: true,
    },
    {
      id: "mini_miranda",
      // Required disclosure: the FDCPA "mini-Miranda" warning. The template
      // embeds the canonical wording verbatim so the on-script path always
      // passes verification honestly, without the generator "knowing"
      // about compliance — the gate is the verifier, not the author's care.
      template:
        "{{debtorName}}, this communication is from a debt collector. This is an attempt to collect a debt, and any information obtained will be used for that purpose. This call may be recorded.",
      disclosure: {
        id: "mini_miranda",
        canonicalText:
          "This communication is from a debt collector. This is an attempt to collect a debt, and any information obtained will be used for that purpose. This call may be recorded.",
        requiredPhrases: [
          "debt collector",
          "attempt to collect a debt",
          "information obtained will be used for that purpose",
        ],
        minCoverage: 0.7,
      },
      next: "purpose_statement",
    },
    {
      id: "purpose_statement",
      template:
        "I'm calling about an outstanding balance of {{debtAmount}} owed to {{creditorName}}. Would you like to discuss payment options today?",
      branches: {
        affirm: "payment_options",
        deny: "closing_disclosure",
      },
    },
    {
      id: "payment_options",
      template:
        "We can offer a payment plan of {{debtAmount}} split over several months, or a one-time settlement. Would either of those work for you?",
      next: "closing_disclosure",
    },
    {
      id: "closing_disclosure",
      // Required disclosure: FDCPA validation notice.
      template:
        "Before we end this call: you have the right to dispute this debt in writing within thirty days. If you do not dispute it within that period, we will assume the debt is valid. Upon written request within that period, we will provide verification of the debt or the name of the original creditor. Thank you for your time, {{debtorName}}.",
      disclosure: {
        id: "validation_notice",
        canonicalText:
          "You have the right to dispute this debt in writing within thirty days. If you do not dispute it within that period, we will assume the debt is valid. Upon written request within that period, we will provide verification of the debt or the name of the original creditor.",
        requiredPhrases: [
          "dispute this debt",
          "thirty days",
          "verification of the debt",
        ],
        minCoverage: 0.7,
      },
      next: "call_end",
    },
    {
      id: "call_end",
      template: "Goodbye, and thank you for your time.",
      terminal: true,
    },

    // --- Off-script landing states, reachable from ANY state ---
    {
      id: "dispute_handling",
      offScript: true,
      template:
        "I've noted that you dispute this debt. We are required to cease collection activity until we mail you verification of the debt, including the name of the original creditor and the amount owed.",
      disclosure: {
        id: "dispute_ack",
        canonicalText:
          "I've noted that you dispute this debt. We are required to cease collection activity until we mail you verification of the debt.",
        requiredPhrases: ["dispute", "cease collection", "verification"],
        minCoverage: 0.6,
      },
      next: "call_end",
    },
    {
      id: "cease_and_desist",
      offScript: true,
      next: "call_end",
      template:
        "Understood. I will honor your request to stop calling you and will cease further telephone contact regarding this debt, as required by law.",
      disclosure: {
        id: "cease_ack",
        canonicalText:
          "I will honor your request to stop calling you and will cease further telephone contact regarding this debt, as required by law.",
        requiredPhrases: ["stop calling", "cease further telephone contact"],
        minCoverage: 0.6,
      },
    },
    {
      id: "attorney_representation",
      offScript: true,
      next: "call_end",
      template:
        "Understood — you're represented by counsel. Under the Fair Debt Collection Practices Act, we are required to direct all further communication to your attorney and will not contact you directly regarding this debt.",
      disclosure: {
        id: "attorney_ack",
        canonicalText:
          "You're represented by counsel. We are required to direct all further communication to your attorney and will not contact you directly regarding this debt.",
        requiredPhrases: [
          "represented by counsel",
          "direct all further communication",
        ],
        minCoverage: 0.6,
      },
    },
  ],
  offScriptIntents: [
    {
      id: "dispute_debt",
      description: "Debtor disputes owing the debt.",
      patterns: [/\bdispute\b/i, /don'?t owe/i, /not my debt/i, /this isn'?t mine/i],
      targetState: "dispute_handling",
      excludeFrom: ["dispute_handling", "call_end", "wrong_party", "cease_and_desist", "attorney_representation"],
    },
    {
      id: "stop_calling",
      description: "Debtor invokes their right to cease contact.",
      patterns: [/stop calling/i, /do not call/i, /don'?t call me/i, /cease contact/i],
      targetState: "cease_and_desist",
      excludeFrom: ["cease_and_desist", "attorney_representation"],
    },
    {
      id: "attorney_referral",
      description: "Debtor states they are represented by an attorney.",
      patterns: [/attorney/i, /lawyer/i, /my counsel/i],
      targetState: "attorney_representation",
      excludeFrom: ["attorney_representation", "cease_and_desist"],
    },
  ],
};
