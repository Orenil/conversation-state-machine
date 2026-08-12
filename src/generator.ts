import type { StateSpec } from "./types.js";

/**
 * Utterance generation. This project's point is control flow, not
 * language quality, so the "LLM" here is honestly a deterministic
 * template-filler rather than a call dressed up to look like one.
 * `UtteranceGenerator` is an interface so a real model call can be
 * dropped in later — see README.md "Extension point: a real LLM" for a
 * worked example — without `ConversationEngine` or the verifier changing
 * at all.
 */
export interface UtteranceGenerator {
  generate(state: StateSpec, slots: Record<string, string>): string;
}

function fillTemplate(template: string, slots: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    if (!(key in slots)) {
      throw new Error(`Template for missing slot "${key}" was not supplied in context`);
    }
    return slots[key] as string;
  });
}

/** Deterministic, template-based generator used as the default/test
 * implementation everywhere in this repo. */
export class TemplateGenerator implements UtteranceGenerator {
  generate(state: StateSpec, slots: Record<string, string>): string {
    return fillTemplate(state.template, slots);
  }
}
