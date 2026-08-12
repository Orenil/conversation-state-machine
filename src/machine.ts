import { assign, createMachine, type AnyEventObject } from "xstate";
import type { FlowConfig } from "./types.js";

/** Machine context: the only conversation state xstate itself tracks
 * beyond "which node am I in." Verification results live here because the
 * transition guards need to read them synchronously. */
export interface MachineContext {
  verificationPassed: Record<string, boolean>;
}

export type FlowEvent =
  | { type: "ADVANCE" }
  | { type: "AFFIRM" }
  | { type: "DENY" }
  | { type: "SET_VERIFIED"; stateId: string; passed: boolean }
  | { type: string; intentId?: string; matchedText?: string };

export function offscriptEventName(intentId: string): string {
  return `OFFSCRIPT_${intentId.toUpperCase()}`;
}

/**
 * Compiles a declarative `FlowConfig` into a real xstate machine.
 *
 * The load-bearing property: the LLM/generator NEVER decides what state
 * comes next. It only produces the utterance spoken *within* a state.
 * Advancing past a state that has a required disclosure is gated by a
 * guard that reads `context.verificationPassed[state.id]` — set only by
 * `SET_VERIFIED`, which the engine sends only after the verifier has
 * scored the actual generated utterance. There is no path from "the model
 * said something" to "the machine transitioned" that skips that check.
 *
 * Off-script intents are wired as transitions on the machine's own `on`
 * block. xstate resolves an event against the current leaf state first;
 * if that state doesn't define a handler for the event, it bubbles up to
 * the nearest ancestor that does — here, the root machine — so these
 * transitions apply from every state without being repeated per state.
 * States listed in an intent's `excludeFrom` get an explicit no-op
 * handler for that event, which — because a child's own handler always
 * wins over an ancestor's — blocks the bubble and makes the event a no-op
 * (illegal/irrelevant transition, correctly rejected) in that state.
 */
export function buildMachine(flow: FlowConfig) {
  const stateNodes: Record<string, any> = {};

  for (const state of flow.states) {
    const on: Record<string, any> = {};

    if (state.branches) {
      for (const [branchKey, target] of Object.entries(state.branches)) {
        const eventType = branchKey.toUpperCase();
        on[eventType] = state.disclosure
          ? {
              target,
              guard: ({ context }: { context: MachineContext }) =>
                context.verificationPassed[state.id] === true,
            }
          : { target };
      }
    } else if (state.next) {
      on.ADVANCE = state.disclosure
        ? {
            target: state.next,
            guard: ({ context }: { context: MachineContext }) =>
              context.verificationPassed[state.id] === true,
          }
        : { target: state.next };
    }

    for (const intent of flow.offScriptIntents) {
      if (intent.excludeFrom?.includes(state.id)) {
        // Explicit no-op: overrides the root-level handler so the event
        // is swallowed instead of bubbling into a forced transition.
        on[offscriptEventName(intent.id)] = {};
      }
    }

    stateNodes[state.id] = {
      ...(state.terminal ? { type: "final" as const } : {}),
      on,
    };
  }

  const rootOn: Record<string, any> = {
    SET_VERIFIED: {
      actions: assign(({ context, event }: { context: MachineContext; event: AnyEventObject }) => {
        if (event.type !== "SET_VERIFIED") return {};
        return {
          verificationPassed: {
            ...context.verificationPassed,
            [event.stateId as string]: event.passed as boolean,
          },
        };
      }),
    },
  };
  for (const intent of flow.offScriptIntents) {
    rootOn[offscriptEventName(intent.id)] = { target: `.${intent.targetState}` };
  }

  return createMachine({
    id: flow.id,
    initial: flow.initial,
    context: { verificationPassed: {} } as MachineContext,
    states: stateNodes,
    on: rootOn,
  });
}

export type FlowMachine = ReturnType<typeof buildMachine>;
