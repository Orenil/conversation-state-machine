import { describe, expect, it } from "vitest";
import { createActor } from "xstate";
import { buildMachine } from "../src/machine.js";
import { debtCollectionFlow } from "../src/config/flow.js";

/**
 * Pure machine-level tests: no generator, no verifier, no audit log. Just
 * "does the compiled xstate machine enforce the flow config's legality
 * rules." These are the illegal-transition-rejection tests.
 */
describe("buildMachine: illegal transition rejection", () => {
  it("stays in the initial state when sent an event the state doesn't define", () => {
    const actor = createActor(buildMachine(debtCollectionFlow)).start();
    expect(actor.getSnapshot().value).toBe("greeting");

    // greeting only defines ADVANCE, not AFFIRM/DENY.
    actor.send({ type: "AFFIRM" });
    expect(actor.getSnapshot().value).toBe("greeting");

    actor.send({ type: "DENY" });
    expect(actor.getSnapshot().value).toBe("greeting");
  });

  it("rejects ADVANCE on a branch-only state (no default forward transition)", () => {
    const actor = createActor(buildMachine(debtCollectionFlow)).start();
    actor.send({ type: "ADVANCE" }); // greeting -> identity_verification
    expect(actor.getSnapshot().value).toBe("identity_verification");

    // identity_verification only defines AFFIRM/DENY, not ADVANCE.
    actor.send({ type: "ADVANCE" });
    expect(actor.getSnapshot().value).toBe("identity_verification");
  });

  it("blocks ADVANCE out of a disclosure-bearing state until SET_VERIFIED(passed=true) is sent", () => {
    const actor = createActor(buildMachine(debtCollectionFlow)).start();
    actor.send({ type: "ADVANCE" }); // -> identity_verification
    actor.send({ type: "AFFIRM" }); // -> mini_miranda
    expect(actor.getSnapshot().value).toBe("mini_miranda");

    // No verification recorded yet: ADVANCE must be rejected.
    actor.send({ type: "ADVANCE" });
    expect(actor.getSnapshot().value).toBe("mini_miranda");

    // A failed verification must ALSO keep it rejected.
    actor.send({ type: "SET_VERIFIED", stateId: "mini_miranda", passed: false });
    actor.send({ type: "ADVANCE" });
    expect(actor.getSnapshot().value).toBe("mini_miranda");

    // Only a passing verification unlocks the transition.
    actor.send({ type: "SET_VERIFIED", stateId: "mini_miranda", passed: true });
    actor.send({ type: "ADVANCE" });
    expect(actor.getSnapshot().value).toBe("purpose_statement");
  });

  it("verification recorded for one state does not unlock a different state's gate", () => {
    const actor = createActor(buildMachine(debtCollectionFlow)).start();
    actor.send({ type: "ADVANCE" });
    actor.send({ type: "AFFIRM" }); // -> mini_miranda

    // Verifying an unrelated disclosure id must not satisfy mini_miranda's guard.
    actor.send({ type: "SET_VERIFIED", stateId: "validation_notice", passed: true });
    actor.send({ type: "ADVANCE" });
    expect(actor.getSnapshot().value).toBe("mini_miranda");
  });

  it("rejects events sent to a machine that has already reached a terminal state", () => {
    const actor = createActor(buildMachine(debtCollectionFlow)).start();
    actor.send({ type: "ADVANCE" });
    actor.send({ type: "DENY" }); // -> wrong_party (terminal)
    expect(actor.getSnapshot().value).toBe("wrong_party");
    expect(actor.getSnapshot().status).toBe("done");

    actor.send({ type: "ADVANCE" });
    expect(actor.getSnapshot().value).toBe("wrong_party");
  });
});
