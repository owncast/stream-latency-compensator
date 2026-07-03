/*
Multi-minute simulated timelines through the real LatencyCompensator class,
driven by node:test mock timers (setInterval/setTimeout/Date) in 100ms steps.
Invariant scenarios run >= 5 simulated minutes and afterwards assert the
spec's invariants (1-10) via assertInvariants(); scenario-specific
expectations are derived from the contract spec only.

The stall-comparison invariant (#4) runs the identical timeline twice --
with and without the compensator -- wherever stalls are possible at all;
scenarios that must be stall-free assert zero stalls outright, which is
strictly stronger.

Rev 9 note: any healthy timeline longer than ~3.5 minutes EARNS TRUST
(zero rebuffers + bandwidth ratio >= 2.0 for 3 continuous minutes), which
thins the floor and may legitimately unlock one further catch-up episode.
Long scenarios account for that; targeted rev 9 behavior tests (persistence,
quality pinning) deliberately stay under the trust horizon instead.
*/

import { test } from "node:test";
import assert from "node:assert";
import LatencyCompensator from "../latencyCompensator.js";
import {
  runScenario,
  assertInvariants,
  engageEpisodes,
  timeoutEdges,
  specBufferFloor,
} from "./fake-player.js";

const MIN_RUN_SEC = 300; // every scenario simulates at least 5 minutes

test("scenario: steady healthy network engages once and settles in the band", (t) => {
  const cfg = {
    Compensator: LatencyCompensator,
    durationSec: 360,
    segDur: 2,
    initialLatencySec: 8,
    initialBufferSec: 6,
    rateFactor: () => 3,
  };
  const run = runScenario(t, cfg);

  assert.ok(cfg.durationSec >= MIN_RUN_SEC);
  assert.strictEqual(run.stalls.length, 0, "healthy network must never stall");
  assert.ok(
    engageEpisodes(run.rateWrites) >= 1,
    "compensation must actually engage from 8s behind"
  );
  assert.strictEqual(timeoutEdges(run.stats), 0, "no timeouts on a healthy network");
  assertInvariants(run, {
    segDur: 2,
    offStalls: [], // zero stalls asserted above; comparison is degenerate
    band: { lastSec: 60 },
    maxEngageEpisodes: 2,
  });
});

test("scenario: rev 2 regression -- compensation engages across networkState IDLE periods", (t) => {
  // A fast connection spends most of its time NOT fetching: networkState
  // sits at 1 (IDLE) between segment fetches and only briefly at 2. The
  // old "!== 2" gate reset stability forever on exactly this timeline.
  const run = runScenario(t, {
    Compensator: LatencyCompensator,
    durationSec: 360,
    segDur: 2,
    initialLatencySec: 8,
    initialBufferSec: 6,
    rateFactor: () => 8,
  });

  // Harness self-check: the scenario really is idle-dominated.
  assert.ok(
    run.net.idle > 2 * run.net.fetching,
    `scenario must be IDLE-dominated (idle ${run.net.idle}, fetching ${run.net.fetching})`
  );
  assert.ok(
    run.stats.some((s) => s.consecutiveStableChecks >= 3),
    "stability must accumulate to >= 3 checks despite IDLE periods"
  );
  assert.ok(
    run.rateWrites.some((w) => w.to > 1.0),
    "rate must rise above 1.0 despite IDLE periods"
  );
  assert.strictEqual(run.stalls.length, 0);
  assertInvariants(run, {
    segDur: 2,
    offStalls: [],
    band: { lastSec: 60 },
    maxEngageEpisodes: 2,
  });
});

test("scenario: bandwidth degrades mid-catchup -- compensator lets go and stays quiet", (t) => {
  const cfg = {
    Compensator: LatencyCompensator,
    durationSec: 300,
    segDur: 2,
    // 9s behind: just under the cold-start seek threshold (gap < 2*segDur),
    // so the catch-up must come from the SPEED path -- which is what this
    // scenario is about: bandwidth degrading mid-speed-up.
    initialLatencySec: 9,
    initialBufferSec: 6,
    // Healthy 3x until t=70, then 1.1x: above realtime (no stalls) but far
    // below the 1.5x continue gate and the 2.0x start gate.
    rateFactor: (tSec) => (tSec < 70 ? 3 : 1.1),
  };
  const run = runScenario(t, cfg);

  assert.ok(
    engageEpisodes(run.rateWrites) >= 1,
    "must engage during the healthy phase"
  );
  // Once the conservative bandwidth estimate absorbs the degrade, the
  // compensator must stop and never re-engage (start needs 2.0x).
  const lateRaises = run.rateWrites.filter(
    (w) => w.at > run.startMs + 120_000 && w.to > w.from
  );
  assert.deepStrictEqual(
    lateRaises,
    [],
    "no speed-up may survive a bandwidth collapse below the continue gate"
  );
  assert.strictEqual(run.model.rate, 1.0, "rate must be released back to 1.0");
  assert.strictEqual(run.stalls.length, 0, "1.1x download never stalls playback");
  assertInvariants(run, { segDur: 2, offStalls: [] });
});

test("scenario: jitter bursts stay safe -- no backward seeks, no added stalls", (t) => {
  const dip = (tSec) =>
    (tSec >= 40 && tSec < 46) ||
    (tSec >= 90 && tSec < 96) ||
    (tSec >= 140 && tSec < 146) ||
    (tSec >= 190 && tSec < 196) ||
    (tSec >= 240 && tSec < 246);
  const cfg = {
    durationSec: 300,
    segDur: 4,
    initialLatencySec: 12,
    initialBufferSec: 8,
    rateFactor: (tSec) => (dip(tSec) ? 0.4 : 2.5),
  };
  const off = runScenario(t, { ...cfg, withCompensator: false });
  const run = runScenario(t, { ...cfg, Compensator: LatencyCompensator });

  assertInvariants(run, {
    segDur: 4,
    offStalls: off.stalls,
    maxEngageEpisodes: 6, // one per burst at most, plus the initial engage
  });
});

test("scenario: near-edge operation -- inside the band the compensator is inert", (t) => {
  const run = runScenario(t, {
    Compensator: LatencyCompensator,
    durationSec: 300,
    segDur: 2,
    initialLatencySec: 5.2, // inside the (4000, 5600] band from the start
    initialBufferSec: 3,
    rateFactor: () => 3,
  });

  assert.deepStrictEqual(run.seeks, [], "no seeks while inside the band");
  assert.strictEqual(engageEpisodes(run.rateWrites), 0, "no speed-ups in the band");
  for (const w of run.rateWrites) {
    assert.strictEqual(w.to, 1.0, "rate must stay untouched at 1.0");
  }
  assert.strictEqual(run.stalls.length, 0);
  assert.strictEqual(timeoutEdges(run.stats), 0, "no timeout churn near the edge");
  assertInvariants(run, {
    segDur: 2,
    offStalls: [],
    band: { lastSec: 60 },
    maxEngageEpisodes: 0,
  });
});

test("scenario: player clock off by +/-30s, corrected via setClockSkew", async (t) => {
  for (const clockErrorMs of [30_000, -30_000]) {
    await t.test(`clock error ${clockErrorMs}ms`, (t2) => {
      const run = runScenario(t2, {
        Compensator: LatencyCompensator,
        durationSec: 360,
        segDur: 2,
        initialLatencySec: 8,
        initialBufferSec: 6,
        rateFactor: () => 3,
        clockErrorMs,
        clockSkewMs: -clockErrorMs, // correct correction
      });

      // With the skew corrected the run must behave exactly like the
      // steady scenario: engage, settle in the band, never time out on
      // "absurd" latency.
      assert.ok(engageEpisodes(run.rateWrites) >= 1, "must engage");
      assert.strictEqual(
        timeoutEdges(run.stats),
        0,
        "corrected skew must not produce bad-data timeouts"
      );
      assert.strictEqual(run.stalls.length, 0);
      assertInvariants(run, {
        segDur: 2,
        offStalls: [],
        band: { lastSec: 60 },
        maxEngageEpisodes: 2,
      });
    });
  }
});

test("scenario: long pause then unpause seeks near -- never onto -- the live edge", (t) => {
  const cfg = {
    Compensator: LatencyCompensator,
    durationSec: 420,
    segDur: 2,
    initialLatencySec: 6,
    initialBufferSec: 5,
    rateFactor: () => 3,
    script: [
      { atSec: 60, run: (m) => m.pause() },
      { atSec: 150, run: (m) => m.play() }, // 90s pause: must catch up
      { atSec: 260, run: (m) => m.pause() },
      { atSec: 263, run: (m) => m.play() }, // 3s pause: gap < 2*segDur, no seek
    ],
  };
  const run = runScenario(t, cfg);

  // Exactly one seek: the long-pause catch-up. The short pause must not.
  assert.strictEqual(
    run.seeks.length,
    1,
    `expected exactly the unpause seek, got ${JSON.stringify(run.seeks)}`
  );
  const seek = run.seeks[0];
  const atSec = (seek.at - run.startMs) / 1000;
  assert.ok(atSec >= 150 && atSec < 152, `seek at unpause time, got t=${atSec}`);
  assert.ok(seek.to > seek.from, "unpause seek must go forward");
  // Spec: target = liveEdge - (floor + segDur) = liveEdge - 6.
  assert.ok(
    Math.abs(seek.availableAheadAfter - 6) < 0.25,
    `must land floor+segDur behind the edge, landed ${seek.availableAheadAfter}`
  );
  assert.strictEqual(run.stalls.length, 0, "seek refill is not a stall");
  assertInvariants(run, {
    segDur: 2,
    offStalls: [],
    band: { lastSec: 45 },
    maxEngageEpisodes: 4, // initial + after long pause + after short pause
  });
});

test("scenario: cold start far behind live seeks near the edge immediately", (t) => {
  const run = runScenario(t, {
    Compensator: LatencyCompensator,
    durationSec: 420,
    segDur: 2,
    initialLatencySec: 45,
    initialBufferSec: 2,
    rateFactor: () => 4,
  });

  assert.strictEqual(run.seeks.length, 1, "exactly one cold-start seek");
  const seek = run.seeks[0];
  assert.ok(seek.at - run.startMs < 1000, "cold-start seek happens right away");
  assert.ok(seek.to > seek.from, "cold-start seek must go forward");
  assert.ok(
    Math.abs(seek.availableAheadAfter - 6) < 0.25,
    `must land floor+segDur behind the edge, landed ${seek.availableAheadAfter}`
  );
  assert.strictEqual(run.stalls.length, 0);
  // Rev 9: the long clean tail earns trust (never before 3 clean minutes);
  // the thinned floor MAY unlock one further catch-up (hence the extra
  // episode allowance), but the run must stay free of stalls and timeouts
  // and settle silently -- the 420s duration leaves the trust-era episode
  // room to complete before the steady-state window.
  const trustAt = run.stats.find((s) => s.trusted)?.at;
  assert.ok(trustAt, "a long clean run must earn trust");
  assert.ok(trustAt - run.startMs >= 180_000, "trust needs 3 full clean minutes");
  assert.strictEqual(timeoutEdges(run.stats), 0, "no timeouts, trusted or not");
  assertInvariants(run, {
    segDur: 2,
    offStalls: [],
    band: { lastSec: 60 },
    maxEngageEpisodes: 3,
  });
});

test("scenario: enabled late and far behind -- decide() jumps forward, lands on buffer", (t) => {
  // Enabling after playback started suppresses the cold-start seek, so the
  // catch-up must come from decide()'s jump rule: forward only, landing
  // inside buffered content with the floor intact.
  const run = runScenario(t, {
    Compensator: LatencyCompensator,
    durationSec: 420,
    segDur: 2,
    initialLatencySec: 40,
    initialBufferSec: 2,
    rateFactor: () => 4,
    enableAtSec: 22,
  });

  assert.ok(run.seeks.length >= 1, "must jump at least once from 40s behind");
  for (const s of run.seeks) {
    assert.ok(s.to > s.from, "every jump goes forward");
    assert.ok(
      s.bufferedAfter > 0.5,
      "decide() jumps must land inside buffered content"
    );
  }
  assert.strictEqual(run.stalls.length, 0);
  // Rev 9: same trust-era allowance as the cold-start scenario above.
  const trustAt = run.stats.find((s) => s.trusted)?.at;
  assert.ok(trustAt, "a long clean run must earn trust");
  assert.ok(trustAt - run.startMs >= 180_000, "trust needs 3 full clean minutes");
  assert.strictEqual(timeoutEdges(run.stats), 0, "no timeouts, trusted or not");
  assertInvariants(run, {
    segDur: 2,
    offStalls: [],
    band: { lastSec: 60 },
    maxEngageEpisodes: 4,
  });
});

test("scenario: repeated outages hit the rebuffer limit -- disable is terminal", (t) => {
  const outage = (tSec) =>
    (tSec >= 40 && tSec < 58) ||
    (tSec >= 85 && tSec < 103) ||
    (tSec >= 130 && tSec < 148) ||
    (tSec >= 175 && tSec < 193) ||
    (tSec >= 220 && tSec < 238);
  const cfg = {
    durationSec: 340,
    segDur: 2,
    initialLatencySec: 8,
    initialBufferSec: 6,
    // A tight forward-buffer goal (like VHS's) so every outage starves
    // playback instead of riding on buffer accumulated behind live.
    maxBufferAheadSec: 8,
    rateFactor: (tSec) => (outage(tSec) ? 0 : 2.5),
  };
  const off = runScenario(t, { ...cfg, withCompensator: false });
  const run = runScenario(t, { ...cfg, Compensator: LatencyCompensator });

  // Five outages -> five stalls -> five rebuffer events -> the limit (>4)
  // disables the compensator for the session.
  assert.strictEqual(off.stalls.length, 5, "harness: each outage stalls once");
  assert.strictEqual(run.stalls.length, 5, "compensator adds no stalls");
  assert.ok(
    run.stats.some((s) => s.bufferingEvents >= 1),
    "rebuffer events must be recorded"
  );
  const disableAtMs = run.stalls[4].at + 1500; // 5th event counted 200ms later
  assertInvariants(run, {
    segDur: 2,
    offStalls: off.stalls,
    disableAtMs,
    maxEngageEpisodes: 2, // at most the pre-outage engagement
  });
});

test("scenario: rev 7 -- a backward scrub is not blamed on the compensator", (t) => {
  // The viewer scrubs 40s back at t=60. The landing fires 'waiting' while
  // seeking() is true: a seek-discontinuity fetch, NOT starvation. The
  // compensator must record no rebuffer event and enter no timeout for it,
  // and with rebuffer memory clean the jump path must engage within ~15s
  // and take the viewer forward again.
  const run = runScenario(t, {
    Compensator: LatencyCompensator,
    durationSec: 300,
    segDur: 2,
    initialLatencySec: 8,
    initialBufferSec: 6,
    rateFactor: () => 3,
    script: [{ atSec: 60, run: (m) => m.userSeek(m.currentTime() - 40) }],
  });

  // Harness self-check: the scrub really produced a seek-discontinuity
  // 'waiting' (seeking() true), and it was not counted as a stall.
  assert.ok(run.refillWaitings >= 1, "scrub must fire a refill 'waiting'");
  assert.strictEqual(run.stalls.length, 0, "no genuine starvation in this run");

  // Rev 7: no rebuffer recorded, no timeout entered -- ever, in this run.
  for (const s of run.stats) {
    assert.strictEqual(
      s.bufferingEvents,
      0,
      `scrub was blamed on the compensator: rebuffer recorded by ${s.at}`
    );
  }
  assert.strictEqual(timeoutEdges(run.stats), 0, "scrub must not cause a timeout");

  // With rebuffer memory clean the compensator is free to help: a decide()
  // jump (forward, landing on buffer) within 20s of the scrub.
  const scrubAt = run.seeks.find((s) => s.user).at;
  const rescue = run.seeks.filter(
    (s) => !s.user && s.at > scrubAt && s.at <= scrubAt + 20_000
  );
  assert.ok(
    rescue.length >= 1,
    `expected a rescue jump within 20s of the scrub, seeks: ${JSON.stringify(run.seeks)}`
  );
  for (const s of rescue) {
    assert.ok(s.to > s.from, "rescue jump goes forward");
    assert.ok(s.bufferedAfter > 0.5, "rescue jump lands inside buffered content");
  }
  assertInvariants(run, { segDur: 2 });
});

// ---------------------------------------------------------------------------
// Rev 9: earned trust, clock-skew fallback, rebuffer persistence, pin modes.

test("scenario: rev 9 trust lifecycle -- earn, thin the floor, revert on a stall (invariant 8)", (t) => {
  // 4s segments, ~12s behind, forward buffer capped at 8.5s (~8.4 after the
  // model's sampling lag). Untrusted (floor 6) the spendable buffer is
  // ~2.4s < 3s, so the reachable minimum sits at/above the base max and the
  // degenerate effective band (min + 3000) contains the latency forever:
  // silent by construction. The trusted floor 5 frees one more second,
  // reachable drops BELOW the base max, and 12.1s > eff max 9520 becomes an
  // honest catch-up -- earned trust is exactly what unlocks it. (A
  // floor-bound rest can never restart under trust -- the entry margin stays
  // ~1s above the resting buffer by design -- so the trust-unlocked
  // engagement needs spendable headroom like this, not a thinner rest.)
  const cfg = {
    durationSec: 640,
    segDur: 4,
    initialLatencySec: 12,
    initialBufferSec: 6,
    maxBufferAheadSec: 8.5,
    rateFactor: (tSec) => (tSec >= 430 && tSec < 442 ? 0 : 3),
  };
  const off = runScenario(t, { ...cfg, withCompensator: false });
  const run = runScenario(t, { ...cfg, Compensator: LatencyCompensator });

  // Phase 1 -- untrusted: totally silent (degenerate band, see above).
  const trustAt = run.stats.find((s) => s.trusted)?.at;
  assert.ok(trustAt, "3 clean minutes at >= 2x headroom must earn trust");
  assert.ok(
    trustAt - run.startMs >= 180_000,
    "trust may never arrive before 3 full clean minutes"
  );
  assert.ok(
    trustAt - run.startMs <= 240_000,
    "trust must arrive shortly after the 3 clean minutes are up"
  );
  for (const w of run.rateWrites) {
    if (w.at < trustAt) {
      assert.strictEqual(w.to, 1.0, "untrusted phase must be silent");
    }
  }

  // The floor in stats drops with the flip: 6 untrusted -> 5 trusted.
  const lastUntrusted = run.stats.filter(
    (s) => s.at < trustAt && Number.isFinite(s.bufferFloorSeconds)
  ).at(-1);
  assert.strictEqual(lastUntrusted.bufferFloorSeconds, specBufferFloor(4, false));
  const firstTrusted = run.stats.find((s) => s.trusted);
  assert.strictEqual(firstTrusted.bufferFloorSeconds, specBufferFloor(4, true));

  // Phase 2 -- trusted: exactly one catch-up engages and completes (rate
  // released back to 1.0) before the outage.
  const outageAtMs = run.startMs + 430_000;
  assert.ok(
    engageEpisodes(run.rateWrites, trustAt) >= 1,
    "earned trust must unlock the catch-up the untrusted margin blocked"
  );
  const preOutageWrites = run.rateWrites.filter((w) => w.at < outageAtMs);
  assert.strictEqual(
    preOutageWrites.at(-1)?.to,
    1.0,
    "the trusted catch-up must complete and release the rate before the outage"
  );
  // No timeout ping-pong may hide behind the trust flip.
  assert.strictEqual(
    timeoutEdges(run.stats.filter((s) => s.at < outageAtMs)),
    0,
    "the whole calm phase must be timeout-free"
  );

  // Phase 3 -- a genuine stall: trust reverts instantly and for good.
  assert.strictEqual(off.stalls.length, 1, "harness: the outage stalls the baseline");
  assert.strictEqual(run.stalls.length, 1, "zero ADDED stalls (one genuine outage)");
  const stallAt = run.stalls[0].at;
  assert.ok(stallAt >= outageAtMs, "the only stall is the forced outage");
  for (const s of run.stats) {
    if (s.at > stallAt) {
      assert.strictEqual(
        s.trusted,
        false,
        `trust must revert from the next report and stay gone (sample at ${s.at})`
      );
    }
  }
  // Decisions are back on the untrusted floor from the next real check
  // (the 30s backoff itself only re-reports the pre-stall snapshot, with
  // trusted already false above; the floor is recomputed once checks run).
  const firstCheckAfter = run.stats.find(
    (s) =>
      s.at > stallAt &&
      !s.inTimeout &&
      s.action?.type !== "idle" &&
      Number.isFinite(s.bufferFloorSeconds)
  );
  assert.strictEqual(firstCheckAfter.bufferFloorSeconds, specBufferFloor(4, false));
  // Re-earning takes 3 full clean minutes at minimum: the remaining >= 3
  // minutes of clean tail never re-earn (the amnesty window alone pins the
  // trust clock past the end of the run).
  assert.ok(
    run.endMs - stallAt >= 180_000,
    "harness: the post-stall window must cover the full 3-minute horizon"
  );
  // The stall's 30s backoff is the spec'd response -- but exactly that, no
  // ping-pong afterwards.
  const totalEdges = timeoutEdges(run.stats);
  assert.ok(
    totalEdges >= 1 && totalEdges <= 2,
    `the stall must enter one timeout, never a ping-pong (saw ${totalEdges})`
  );
  assert.ok(
    !run.rateWrites.some((w) => w.at > stallAt && w.to > 1.0),
    "a live rebuffer event blocks any further compensation"
  );
  assertInvariants(run, {
    segDur: 4,
    offStalls: off.stalls,
    maxEngageEpisodes: 2,
  });
});

test("scenario: rev 9 calm-then-spike -- thinned trusted buffer adds no stalls (invariant 9)", (t) => {
  // THE safety case for earned trust: a long calm earns trust and thins the
  // operating buffer (the compensator sits ~4s from live instead of ~8s),
  // then the network collapses outright. The thinner cushion must cost the
  // viewer NOTHING versus the identical run with the compensator disabled.
  const cfg = {
    durationSec: 330,
    segDur: 2,
    initialLatencySec: 8,
    initialBufferSec: 6,
    rateFactor: (tSec) => (tSec >= 270 && tSec < 282 ? 0 : 3),
  };
  const off = runScenario(t, { ...cfg, withCompensator: false });
  const run = runScenario(t, { ...cfg, Compensator: LatencyCompensator });

  const spikeAtMs = run.startMs + 270_000;
  const trustAt = run.stats.find((s) => s.trusted)?.at;
  assert.ok(trustAt, "the calm must earn trust");
  assert.ok(
    trustAt - run.startMs >= 180_000 && trustAt < spikeAtMs,
    "trust arrives after 3 clean minutes, before the spike"
  );
  // Trust holds through the calm and the floor is thinned when it hits.
  const lastCalm = run.stats.filter(
    (s) => s.at < spikeAtMs && Number.isFinite(s.bufferFloorSeconds)
  ).at(-1);
  assert.strictEqual(lastCalm.trusted, true, "trust must hold through the calm");
  assert.strictEqual(lastCalm.bufferFloorSeconds, specBufferFloor(2, true));
  // The calm itself is clean: no stalls, no timeouts before the spike.
  assert.strictEqual(
    run.stalls.filter((s) => s.at < spikeAtMs).length,
    0,
    "no stalls during the calm"
  );
  assert.strictEqual(
    timeoutEdges(run.stats.filter((s) => s.at < spikeAtMs)),
    0,
    "no timeouts during the calm -- trust may not smuggle in ping-pong"
  );

  // The spike genuinely bites: the baseline stalls too. Invariant 4 is the
  // whole point -- the compensator's thinned buffer adds NOTHING on top.
  assert.ok(off.stalls.length >= 1, "harness: the spike must stall the baseline");
  assert.ok(
    run.stalls.length <= off.stalls.length,
    `trusted operation added stalls: ${run.stalls.length} ON vs ${off.stalls.length} OFF`
  );
  // Trust reverts on the spike's stall and the backoff stays bounded.
  const stallAt = run.stalls[0].at;
  for (const s of run.stats) {
    if (s.at > stallAt) {
      assert.strictEqual(s.trusted, false, "trust must revert on the spike");
    }
  }
  const totalEdges = timeoutEdges(run.stats);
  assert.ok(
    totalEdges >= 1 && totalEdges <= 2,
    `one backoff for the stall, never a ping-pong (saw ${totalEdges})`
  );
  assertInvariants(run, {
    segDur: 2,
    offStalls: off.stalls,
    maxEngageEpisodes: 3,
  });
});

test("scenario: rev 9 -- clocks minutes off compensate via the skew fallback (invariant 10)", async (t) => {
  // setClockSkew is never called (clockSkewMs: null): the sighting-based
  // estimator must rescue a clock that is +/-5 minutes off, which used to
  // park the compensator forever on the 90s bad-data guard.
  for (const clockErrorMs of [300_000, -300_000]) {
    await t.test(`clock error ${clockErrorMs}ms`, (t2) => {
      const run = runScenario(t2, {
        Compensator: LatencyCompensator,
        durationSec: 420,
        segDur: 2,
        initialLatencySec: 8,
        initialBufferSec: 6,
        rateFactor: () => 3,
        clockErrorMs,
        clockSkewMs: null,
      });

      assert.ok(
        engageEpisodes(run.rateWrites) >= 1,
        "must compensate despite the broken clock -- not sit inert on bad data"
      );
      assert.strictEqual(run.stalls.length, 0);
      // The estimator may need its first sighting; after the first minute
      // there is no excuse for a bad-data timeout ever again.
      assert.strictEqual(
        timeoutEdges(run.stats, run.startMs + 60_000),
        0,
        "no bad-data timeouts once the estimator has sightings"
      );
      // Measured latency is SANE: within a poll interval of the model's
      // ground truth (the estimator under-reports by at most the
      // publish-and-poll delay -- the conservative direction -- never over).
      const lastTrue = run.latencyTrace.at(-1).latencyMs;
      const lastSeen = run.stats.at(-1).latency;
      assert.ok(
        lastSeen <= lastTrue + 250 && lastSeen >= lastTrue - 3500,
        `estimator-corrected latency ${Math.round(lastSeen)}ms vs true ${Math.round(lastTrue)}ms`
      );
      assertInvariants(run, {
        segDur: 2,
        offStalls: [],
        band: { lastSec: 60 },
        maxEngageEpisodes: 3,
      });
    });
  }
});

test("scenario: rev 9 -- a well-synced clock is untouched by the armed estimator (invariant 10)", async (t) => {
  // With clock error under 10s the estimate must never be applied: the run
  // with the estimator ARMED (setClockSkew never called) is bit-identical
  // to the run where setClockSkew(0) disabled it. Anything else means the
  // fallback perturbs well-synced clients.
  for (const clockErrorMs of [0, 8000]) {
    await t.test(`clock error ${clockErrorMs}ms`, (t2) => {
      const cfg = {
        Compensator: LatencyCompensator,
        durationSec: 300,
        segDur: 2,
        initialLatencySec: 8,
        initialBufferSec: 6,
        rateFactor: () => 3,
        clockErrorMs,
      };
      const disarmed = runScenario(t2, { ...cfg, clockSkewMs: 0 });
      const armed = runScenario(t2, { ...cfg, clockSkewMs: null });

      assert.deepStrictEqual(
        armed.rateWrites,
        disarmed.rateWrites,
        "estimator changed the rate decisions of a well-synced client"
      );
      assert.deepStrictEqual(armed.seeks, disarmed.seeks);
      assert.deepStrictEqual(
        armed.stats.map((s) => s.action?.type),
        disarmed.stats.map((s) => s.action?.type),
        "estimator changed a decision of a well-synced client"
      );
      assertInvariants(armed, { segDur: 2, offStalls: [] });
    });
  }
});

test("scenario: rev 9 -- rebuffer memory survives a reload via sessionStorage", (t) => {
  const KEY = "owncast-latency-compensator.rebuffers";
  const T0 = 1_000_000_000_000;
  const healthy = {
    Compensator: LatencyCompensator,
    durationSec: 120,
    segDur: 2,
    initialLatencySec: 8,
    initialBufferSec: 6,
    rateFactor: () => 3,
  };
  // The "first page load": two outages starve playback -> two rebuffer
  // events, recorded at ~46s and ~93s.
  const stormy = {
    Compensator: LatencyCompensator,
    durationSec: 150,
    segDur: 2,
    initialLatencySec: 8,
    initialBufferSec: 6,
    maxBufferAheadSec: 8,
    rateFactor: (tSec) =>
      (tSec >= 40 && tSec < 52) || (tSec >= 85 && tSec < 97) ? 0 : 3,
  };

  // Control: the healthy timeline with no window object at all (plain
  // Node). Everything below compares against it.
  const control = runScenario(t, { ...healthy, now: T0 + 190_000 });
  assert.ok(
    control.rateWrites.some((w) => w.to > 1.0),
    "harness: the healthy timeline engages without persisted caution"
  );
  const firstBand = (r) => r.stats.find((s) => s.minEndingLatency > 0);

  const store = new Map();
  globalThis.window = {
    sessionStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => void store.set(k, String(v)),
      removeItem: (k) => void store.delete(k),
    },
  };
  try {
    const first = runScenario(t, { ...stormy, now: T0 });
    assert.strictEqual(first.stalls.length, 2, "harness: both outages stall once");
    assert.ok(
      first.stats.some((s) => s.bufferingEvents >= 2),
      "harness: both stalls became rebuffer events"
    );
    assert.ok(store.has(KEY), "events must be written under the spec'd key");

    // The "reload" ~40s after the storm: both events are inside the
    // 4-minute amnesty and must come back at construction.
    const reload = runScenario(t, { ...healthy, now: T0 + 190_000 });
    assert.strictEqual(
      reload.stats[0].bufferingEvents,
      2,
      "persisted events must be live from the very first report"
    );
    // Learned caution is honored immediately: live events block starting
    // (rule 9) and the worst rebuffer latency raises the stop threshold.
    assert.ok(
      !reload.rateWrites.some((w) => w.to > 1.0),
      "live persisted events must block compensation after a reload"
    );
    assert.ok(
      firstBand(reload).minEndingLatency > firstBand(control).minEndingLatency,
      "the persisted worst-rebuffer latency must raise the threshold immediately"
    );

    // A reload past the amnesty loads nothing: age-pruned at construction.
    const late = runScenario(t, { ...healthy, now: T0 + 340_000 });
    assert.strictEqual(
      late.stats[0].bufferingEvents,
      0,
      "events past the 4-minute amnesty must be pruned at load"
    );
    assert.ok(
      late.rateWrites.some((w) => w.to > 1.0),
      "a pruned reload engages like a fresh session"
    );

    // Broken storage (private mode, sandboxed iframe) degrades silently to
    // the in-memory behavior: bit-identical to the no-window control.
    globalThis.window = {
      sessionStorage: {
        getItem() {
          throw new Error("denied");
        },
        setItem() {
          throw new Error("denied");
        },
      },
    };
    const broken = runScenario(t, { ...healthy, now: T0 + 190_000 });
    assert.deepStrictEqual(broken.rateWrites, control.rateWrites);
  } finally {
    delete globalThis.window;
  }

  // Plain Node (no window) stays untouched: bit-identical to the control.
  const node = runScenario(t, { ...healthy, now: T0 + 190_000 });
  assert.deepStrictEqual(node.rateWrites, control.rateWrites);
  assertInvariants(control, { segDur: 2, offStalls: [] });
});

test("scenario: rev 9 quality pin modes", async (t) => {
  // Short timelines on purpose: pinning behavior has nothing to do with
  // trust, so these stay under the 3-minute horizon.
  const cfg = {
    Compensator: LatencyCompensator,
    durationSec: 120,
    segDur: 2,
    initialLatencySec: 8,
    initialBufferSec: 6,
    rateFactor: () => 3,
    renditionBandwidths: [400_000, 1_200_000, 3_000_000],
  };
  const writtenIds = (run) => new Set(run.renditionWrites.map((w) => w.id));

  await t.test("default (lowest): everything but the cheapest rendition is disabled", (t2) => {
    const run = runScenario(t2, cfg);
    assert.ok(engageEpisodes(run.rateWrites) >= 1, "must compensate");
    // rep0 is the 400k floor: never touched. rep1 and rep2 are pinned off
    // during the catch-up and restored at stop.
    assert.deepStrictEqual([...writtenIds(run)].sort(), ["rep1", "rep2"]);
    for (const id of ["rep1", "rep2"]) {
      const writes = run.renditionWrites.filter((w) => w.id === id);
      assert.strictEqual(writes[0].enabled, false, `${id} pinned off while running`);
      assert.strictEqual(writes.at(-1).enabled, true, `${id} restored on stop`);
    }
    assertInvariants(run, { segDur: 2, offStalls: [] });
  });

  await t.test("current: only upswitches are blocked, downswitches stay open", (t2) => {
    // Playing the 1.2M playlist: rep2 (3M) must be disabled during the
    // catch-up; rep0 (400k) and rep1 (the current one) are never touched.
    const run = runScenario(t2, {
      ...cfg,
      bandwidth: 1_200_000,
      compensatorOptions: { qualityPinMode: "current" },
    });
    assert.ok(engageEpisodes(run.rateWrites) >= 1, "must compensate");
    assert.deepStrictEqual([...writtenIds(run)], ["rep2"]);
    const writes = run.renditionWrites;
    assert.strictEqual(writes[0].enabled, false, "rep2 blocked while running");
    assert.strictEqual(writes.at(-1).enabled, true, "rep2 restored on stop");
    assertInvariants(run, { segDur: 2, offStalls: [] });
  });

  await t.test("current with unknown playlist BANDWIDTH: pinning is a no-op", (t2) => {
    // Start inside the band (no engagement), drop the BANDWIDTH attribute
    // once the bandwidth history is warm, then force a catch-up with a
    // short pause (4s < 2*segDur: no unpause seek, the speed path runs).
    // Compensation must run WITHOUT touching any rendition.
    const run = runScenario(t2, {
      ...cfg,
      durationSec: 150,
      initialLatencySec: 5.2,
      initialBufferSec: 3,
      compensatorOptions: { qualityPinMode: "current" },
      script: [
        { atSec: 50, run: (m) => (m.playlistBandwidth = null) },
        { atSec: 60, run: (m) => m.pause() },
        { atSec: 64, run: (m) => m.play() },
      ],
    });
    assert.ok(
      run.rateWrites.some((w) => w.to > 1.0),
      "must still compensate on the warm bandwidth history"
    );
    assert.deepStrictEqual(
      run.renditionWrites,
      [],
      "unknown current bandwidth must leave every rendition alone"
    );
    assertInvariants(run, { segDur: 2, offStalls: [] });
  });
});
