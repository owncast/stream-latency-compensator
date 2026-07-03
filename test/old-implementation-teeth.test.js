/*
TEETH PROOF -- expected-fail demonstrations against the OLD implementation.

These tests run the OLD LatencyCompensator (pre-rewrite, vendored at
test/fixtures/old-compensator.js)
through the exact same harness as the scenario suite and assert that it DOES
violate the contract invariants. They exist to prove the harness has teeth:
a suite that passes broken code is worthless. The old code is expected to
fail the invariants -- these tests are GREEN precisely because the violations
are present, and each pairs the old run with a new-code run on the identical
timeline to show the harness discriminates.

Violations demonstrated (>= 2 invariants, per the contract's teeth section):
- Invariant 1 (never seek backwards): with ~6s segments at ~22s latency the
  old jump math `min(buffer*0.5, latency/1000 - segDur*5)` goes NEGATIVE and
  the old jump() has no direction guard.
- Invariant 5 (no timeout ping-pong / churn): the old fixed "buffer <
  2*segDur -> timeout" continue-gate trips on the natural per-segment buffer
  sawtooth and cycles a 30s timeout forever, so compensation never runs at
  all on a healthy stream.

The old source is a committed fixture so the suite is self-contained: it
survives commits (HEAD moves) and shallow CI checkouts alike.
*/

import { test, before } from "node:test";
import assert from "node:assert";
import LatencyCompensator from "../latencyCompensator.js";
import {
  runScenario,
  assertInvariants,
  backwardSeeks,
  engageEpisodes,
  timeoutEdges,
} from "./fake-player.js";

// The pre-rewrite implementation, vendored as a committed fixture.
// (Deliberately NOT `git show HEAD:...`: after the rewrite lands, HEAD *is*
// the new code, and CI checkouts are shallow anyway.)
let OldLatencyCompensator;

before(async () => {
  OldLatencyCompensator = (await import("./fixtures/old-compensator.js"))
    .default;
});

// ~6s segments, ~22s behind, fat buffer, fast network: the old jump window.
// networkStateWhenIdle 2 models the sticky-LOADING browsers where the old
// code actually accumulated stability (on IDLE-reporting browsers it was
// simply dead -- the rev 2 bug); identical setting for both runs.
const backwardSeekScenario = {
  durationSec: 90,
  segDur: 6,
  initialLatencySec: 22,
  initialBufferSec: 12,
  rateFactor: () => 6,
  networkStateWhenIdle: 2,
};

test("teeth: old code seeks BACKWARDS in the 6s-segment jump window", (t) => {
  const oldRun = runScenario(t, {
    ...backwardSeekScenario,
    Compensator: OldLatencyCompensator,
  });

  const backward = backwardSeeks(oldRun.seeks);
  assert.ok(
    backward.length >= 1,
    "the old implementation must exhibit its backward-seek bug here"
  );
  // The bug is the spec'd one: jumpAmount = latency/1000 - 5*segDur < 0.
  for (const s of backward) {
    assert.ok(s.to < s.from, "seek moved the viewer BACKWARD");
  }
  // And the harness itself catches it: the invariant checker throws.
  assert.throws(
    () => assertInvariants(oldRun, { segDur: 6 }),
    /backward seek/,
    "assertInvariants must flag the backward seek"
  );
});

test("teeth control: new code on the identical timeline never seeks at all", (t) => {
  const newRun = runScenario(t, {
    ...backwardSeekScenario,
    Compensator: LatencyCompensator,
  });

  // Same conditions: the new decide() computes aheadSec = 5 < max(segDur, 2)
  // and falls through to speed -- no seek of any kind, forward catch-up only.
  assert.deepStrictEqual(
    newRun.seeks,
    [],
    "new code must not seek in the old backward-seek window"
  );
  assert.ok(
    newRun.rateWrites.some((w) => w.to > 1.0),
    "new code must instead catch up via speed"
  );
  assertInvariants(newRun, { segDur: 6 });
});

// ~6s segments phased so the natural buffer sawtooth dips under the old
// fixed "2 segments of buffer" continue-gate at exactly the check instants.
const churnScenario = {
  durationSec: 300,
  segDur: 6,
  initialLatencySec: 15.5,
  initialBufferSec: 10,
  rateFactor: () => 5.2,
};

test("teeth: old code timeout-ping-pongs forever on a healthy 6s-segment stream", (t) => {
  const oldRun = runScenario(t, {
    ...churnScenario,
    Compensator: OldLatencyCompensator,
  });

  // The oscillation/churn violation: a 30s timeout entered over and over on
  // a perfectly healthy stream, so the viewer never gets any compensation.
  const edges = timeoutEdges(oldRun.stats);
  assert.ok(
    edges >= 3,
    `old code must cycle timeouts on the buffer sawtooth (saw ${edges} timeout entries)`
  );
  assert.ok(
    !oldRun.rateWrites.some((w) => w.to > 1.0),
    "old code never actually compensates between its self-inflicted timeouts"
  );
  assert.strictEqual(oldRun.stalls.length, 0, "the stream itself was healthy");
});

test("teeth control: new code on the identical timeline never enters a timeout", (t) => {
  const newRun = runScenario(t, {
    ...churnScenario,
    Compensator: LatencyCompensator,
  });

  assert.strictEqual(
    timeoutEdges(newRun.stats),
    0,
    "the segment-scaled limits must not trip on the sawtooth"
  );
  // On this timeline the smoothed buffer hovers a hair under the untrusted
  // floor + segDur/2 entry margin (sawtooth [10, 14], mean ~11.9 vs 12):
  // the spec's "cannot afford to start" branch, so the untrusted phase is
  // totally silent -- no rate changes, no timeouts, no churn -- where the
  // old code cycled a 30s timeout forever. Rev 9: after 3 continuous clean
  // minutes trust is earned, the margin thins to 7 + 3 = 10 < 11.9, and
  // exactly ONE clean catch-up engages. Still zero stalls, zero timeouts.
  const trustAt = newRun.stats.find((s) => s.trusted)?.at;
  assert.ok(trustAt, "5 clean minutes must earn trust");
  assert.ok(
    trustAt - newRun.startMs >= 180_000,
    "trust may never be earned before 3 full clean minutes"
  );
  for (const w of newRun.rateWrites) {
    if (w.at < trustAt) {
      assert.strictEqual(w.to, 1.0, "silent-by-construction until trust is earned");
    }
  }
  assert.ok(
    newRun.rateWrites.some((w) => w.at >= trustAt && w.to > 1.0),
    "earned trust must unlock the catch-up the untrusted margin blocked"
  );
  assert.strictEqual(
    engageEpisodes(newRun.rateWrites),
    1,
    "exactly one clean trust-unlocked catch-up episode"
  );
  assert.strictEqual(newRun.stalls.length, 0);
  assertInvariants(newRun, { segDur: 6, maxEngageEpisodes: 1 });
});
