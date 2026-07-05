/*
Decision-contract tests for the pure decide() and the exported band/floor
helpers. Every expected value below is derived by hand from the contract spec
(rev 10), never from the implementation:

  floor(segDur)            = max(1.5*segDur, 4); trusted: max(segDur+1, 3)
  base min(segDur, W)      = max(4000, 1700*segDur) [trusted: max(3000, ...)],
                             raised to min(W+1000, 15000)
  base max(segDur, W)      = max(min*1.4, min(2200*segDur, 15000)) [+3000 if min>=max]
  trough (rev 10)          = bufferTroughSec, the min of the last 4 raw buffer
                             samples; when absent or non-finite decide() falls
                             back to min(playableBufferRawSec, playableBufferSec)
  SPEND band (rev 10)      = min raised to latencyMs - (TROUGH - floor)*1000
                             when that exceeds base min; max = min+3000 when the
                             raised min reaches base max. Governs the stop point
                             (rule 5) and the taper (rule 10).
  START band (rev 10)      = the same formula computed from the MEAN
                             (playableBufferSec). Governs start hysteresis
                             (rule 6) and the jump trigger (rule 8).
  rate                     = 1 + min(0.08, 0.02*(trough - floor)) * f, f = clamp01
                             ((latency - spendMin)/(spendMax - spendMin)), round 4dp

Every floor comparison (rule 3, the rule 8 landing gate, the rule 9 entry
margin) and every spend budget reads the TROUGH -- the sawtooth trough is what
stalls. Only start eagerness (rule 6 hysteresis, rule 8 trigger) reads the mean.

Spec base bands used throughout (worst = null):
  segDur 2: floor 4,  band [4000, 5600]    trusted: floor 3, band [3400, 4760]
  segDur 4: floor 6,  band [6800, 9520]    trusted: floor 5, band [6800, 9520]
  segDur 6: floor 9,  band [10200, 14280]  trusted: floor 7, band [10200, 14280]
  segDur 8: floor 12, band [13600, 19040]
*/

import { test } from "node:test";
import assert from "node:assert";
import {
  decide,
  bufferFloorSeconds,
  latencyThresholds,
  effectiveLatencyBand,
} from "../latencyCompensator.js";

// Healthy defaults: 10s behind, 8s buffer, 2.5x headroom, stable, 2s segments.
const base = Object.freeze({
  latencyMs: 10_000,
  playableBufferSec: 8,
  bufferTroughSec: 8, // rev 10: explicit, equal to the mean -- no divergence
  playableBufferRawSec: 8,
  bufferTrendSec: 0,
  bandwidthRatio: 2.5,
  segmentDurationSec: 2,
  stableChecks: 5,
  rebufferEvents: 0,
  worstRebufferLatencyMs: null,
  msSinceLastSpeedChange: 30_000,
  msSinceLastJump: Infinity,
  running: false,
});

// Far behind with a fat buffer: effective band == base band [4000, 5600],
// 21000 > 5600+5000, buffer 30 >= floor+2*segDur -- every jump gate passes.
const jumpBase = Object.freeze({
  ...base,
  latencyMs: 21_000,
  playableBufferSec: 30,
  bufferTroughSec: 30,
  playableBufferRawSec: 30,
  msSinceLastJump: 30_000,
});

const d = (over = {}) => decide(Object.freeze({ ...base, ...over }));
const dj = (over = {}) => decide(Object.freeze({ ...jumpBase, ...over }));

function assertJump(action, expectedAhead, msg) {
  assert.strictEqual(action.type, "jump", `${msg}: ${JSON.stringify(action)}`);
  assert.ok(action.aheadSec > 0, `${msg}: aheadSec must be > 0`);
  // The spec formula gives the exact value; rounding DOWN by up to 0.01 is
  // tolerated (it only makes the jump safer), rounding up never is.
  assert.ok(
    action.aheadSec <= expectedAhead + 1e-9 &&
      action.aheadSec >= expectedAhead - 0.011,
    `${msg}: aheadSec ${action.aheadSec}, expected ~${expectedAhead}`
  );
}

// ---------------------------------------------------------------------------

test("bufferFloorSeconds: max(1.5*segDur, 4)", () => {
  for (const [segDur, floor] of [
    [1, 4],
    [2, 4],
    [8 / 3, 4], // 1.5*8/3 = 4: boundary where the segment term takes over
    [4, 6],
    [6, 9],
    [8, 12],
  ]) {
    assert.strictEqual(bufferFloorSeconds(segDur), floor, `segDur ${segDur}`);
  }
});

test("latencyThresholds: base band per segment duration", () => {
  for (const [segDur, min, max] of [
    [2, 4000, 5600], // min=max(4000,3400), max=max(5600, min(4400,15000))
    [4, 6800, 9520], // min=6800, max=max(9520, 8800)
    [6, 10200, 14280],
    [8, 13600, 19040], // 2200*8=17600 < 19040=1.4*13600
  ]) {
    assert.deepStrictEqual(
      latencyThresholds(segDur, null),
      { minLatencyMs: min, maxLatencyMs: max },
      `segDur ${segDur}`
    );
  }
});

test("latencyThresholds: rebuffers raise min, never lower it, capped at 15000", () => {
  // W=7000 raises min to min(8000, 15000)=8000; max=max(11200, 4400).
  assert.deepStrictEqual(latencyThresholds(2, 7000), {
    minLatencyMs: 8000,
    maxLatencyMs: 11_200,
  });
  // A rebuffer at LOW latency must never lower the stop threshold.
  assert.deepStrictEqual(latencyThresholds(2, 1000), {
    minLatencyMs: 4000,
    maxLatencyMs: 5600,
  });
  // The raise is capped at 15000.
  assert.deepStrictEqual(latencyThresholds(2, 20_000), {
    minLatencyMs: 15_000,
    maxLatencyMs: 21_000,
  });
  assert.deepStrictEqual(latencyThresholds(2, 14_500), {
    minLatencyMs: 15_000, // min(15500, 15000)
    maxLatencyMs: 21_000,
  });
});

test("latencyThresholds: monotone in W, max always above min, null/NaN never poison", () => {
  for (const segDur of [2, 4, 6, 8]) {
    const baseBand = latencyThresholds(segDur, null);
    let prevMin = baseBand.minLatencyMs;
    for (let w = 0; w <= 30_000; w += 500) {
      const { minLatencyMs, maxLatencyMs } = latencyThresholds(segDur, w);
      assert.ok(
        minLatencyMs >= prevMin,
        `min must not decrease as W grows (segDur ${segDur}, W ${w})`
      );
      assert.ok(
        maxLatencyMs > minLatencyMs,
        `max must stay above min (segDur ${segDur}, W ${w})`
      );
      assert.ok(Number.isFinite(minLatencyMs) && Number.isFinite(maxLatencyMs));
      prevMin = minLatencyMs;
    }
    // "a null/unknown latency must be stored as null and NEVER poison
    // threshold math"
    for (const w of [null, NaN]) {
      assert.deepStrictEqual(latencyThresholds(segDur, w), baseBand);
    }
  }
});

test("effectiveLatencyBand: buffer-afforded band (rev 6)", () => {
  // Abundant buffer: reachable = 10000 - 26000 < base min -> base band.
  assert.deepStrictEqual(effectiveLatencyBand(2, null, 10_000, 30), {
    minLatencyMs: 4000,
    maxLatencyMs: 5600,
  });
  // Buffer at the floor: reachable = latency itself -> band starts AT the
  // current latency; max = min + 3000.
  assert.deepStrictEqual(effectiveLatencyBand(2, null, 10_000, 4), {
    minLatencyMs: 10_000,
    maxLatencyMs: 13_000,
  });
  // 4s spendable: reachable 6000 >= base max 5600 -> [6000, 9000].
  assert.deepStrictEqual(effectiveLatencyBand(2, null, 10_000, 8), {
    minLatencyMs: 6000,
    maxLatencyMs: 9000,
  });
  // Raise that stays below base max keeps the base max: reachable 4500.
  assert.deepStrictEqual(effectiveLatencyBand(2, null, 5000, 4.5), {
    minLatencyMs: 4500,
    maxLatencyMs: 5600,
  });
  // Boundary: reachable == base max (9600 - 4000) -> min >= max -> +3000.
  assert.deepStrictEqual(effectiveLatencyBand(2, null, 9600, 8), {
    minLatencyMs: 5600,
    maxLatencyMs: 8600,
  });
  // Composes with the rebuffer-raised base band: base [8000, 11200],
  // reachable 20000-6000=14000 -> [14000, 17000].
  assert.deepStrictEqual(effectiveLatencyBand(2, 7000, 20_000, 10), {
    minLatencyMs: 14_000,
    maxLatencyMs: 17_000,
  });
});

test("effectiveLatencyBand: min never below base, max always above min", () => {
  for (const segDur of [2, 4, 6, 8]) {
    const floor = Math.max(1.5 * segDur, 4);
    const { minLatencyMs: baseMin } = latencyThresholds(segDur, null);
    for (let lat = 4000; lat <= 60_000; lat += 2000) {
      for (let buf = floor; buf <= 30; buf += 2) {
        const { minLatencyMs, maxLatencyMs } = effectiveLatencyBand(
          segDur,
          null,
          lat,
          buf
        );
        assert.ok(minLatencyMs >= baseMin);
        assert.ok(maxLatencyMs > minLatencyMs);
      }
    }
  }
});

// ---------------------------------------------------------------------------

test("user contract: 10s behind, 8s buffer, 2.5x headroom, stable, 2s segments -> speed", () => {
  const action = d();
  assert.strictEqual(action.type, "speed");
  assert.ok(action.rate > 1.0 && action.rate <= 1.08);
  // Exact: boost = min(0.08, 0.02*(8-4)) = 0.08; eff band [6000, 9000];
  // f = min((10000-6000)/3000, 1) = 1 -> 1.08.
  assert.strictEqual(action.rate, 1.08);
});

test("rule 1: unmeasurable or absurd latency -> timeout, beats everything", async (t) => {
  const cases = [
    ["null latency", { latencyMs: null }],
    ["NaN latency", { latencyMs: NaN }],
    ["latency just past +90s", { latencyMs: 90_001 }],
    ["latency just past -90s", { latencyMs: -90_001 }],
    // Priority: bad data wins even while running with a critical buffer.
    [
      "null latency while running on a critical buffer",
      { latencyMs: null, running: true, playableBufferSec: 1, playableBufferRawSec: 1 },
    ],
  ];
  for (const [name, over] of cases) {
    await t.test(name, () => {
      assert.strictEqual(d(over).type, "timeout");
    });
  }
});

test("rule 1 boundary: |latency| of exactly 90000 is still actionable", () => {
  // +90000 with a fat buffer: eff band [64000, 67000] (reachable 90000-26000);
  // 90000 > 67000+5000, ahead = min(26, (90000-64000)/1000 - 2 = 24) = 24.
  assertJump(dj({ latencyMs: 90_000 }), 24, "latency 90000");
  // -90000 is at/below target (rule 5), quietly none -- not a timeout.
  assert.strictEqual(d({ latencyMs: -90_000 }).type, "none");
});

test("rule 2: critical buffer -> timeout; the RAW value pierces smoothing", async (t) => {
  const cases = [
    ["both below 2", { playableBufferSec: 1.99, playableBufferRawSec: 1.99, bufferTroughSec: 1.99 }],
    ["raw below 2, smoothed healthy", { playableBufferSec: 10, playableBufferRawSec: 1.99, bufferTroughSec: 1.99 }],
    ["smoothed below 2, raw healthy", { playableBufferSec: 1.99, playableBufferRawSec: 10, bufferTroughSec: 1.99 }],
    // Priority: critical beats the running->stop path of rules 3/5.
    [
      "critical while running",
      { playableBufferSec: 1.5, playableBufferRawSec: 1.5, bufferTroughSec: 1.5, running: true },
    ],
  ];
  for (const [name, over] of cases) {
    await t.test(name, () => {
      assert.strictEqual(d(over).type, "timeout");
    });
  }
  await t.test("exactly 2 is not critical", () => {
    // Falls through to rule 3 (2 < floor 4): none / stop, not timeout.
    const over = { playableBufferSec: 2, playableBufferRawSec: 2, bufferTroughSec: 2 };
    assert.strictEqual(d(over).type, "none");
    assert.strictEqual(d({ ...over, running: true }).type, "stop");
  });
});

test("rule 3: below the buffer floor nothing may act", () => {
  const over = { playableBufferSec: 3.99, playableBufferRawSec: 8, bufferTroughSec: 3.99 };
  assert.strictEqual(d(over).type, "none");
  assert.strictEqual(d({ ...over, running: true }).type, "stop");
  // Priority: the floor beats an otherwise perfect jump setup.
  assert.strictEqual(
    dj({ playableBufferSec: 3.9, bufferTroughSec: 3.9 }).type,
    "none",
    "sub-floor trough must veto a jump"
  );
  // Exactly AT the floor: no spendable buffer, so the effective band starts
  // at the current latency (rule 5) -- still none/stop, never an action.
  const atFloor = { playableBufferSec: 4, playableBufferRawSec: 4, bufferTroughSec: 4 };
  assert.strictEqual(d(atFloor).type, "none");
  assert.strictEqual(d({ ...atFloor, running: true }).type, "stop");
});

test("rule 4: trend limit scales with segment duration (rev 3)", async (t) => {
  await t.test("segDur 2: limit is -max(2,2) = -2", () => {
    assert.strictEqual(d({ bufferTrendSec: -2.001 }).type, "none");
    assert.strictEqual(d({ bufferTrendSec: -2.001, running: true }).type, "stop");
    assert.strictEqual(d({ bufferTrendSec: -2 }).type, "speed"); // strict <
  });
  await t.test("segDur 4: a -3 sawtooth must NOT trip the -max(2,4) limit", () => {
    // segDur 4: floor 6, eff band [8000, 9520] (reachable 12000-4000);
    // 12000 > 9520 -> speed, f=1, boost=min(0.08, 0.02*4)=0.08.
    const base4 = {
      segmentDurationSec: 4,
      latencyMs: 12_000,
      playableBufferSec: 10,
      playableBufferRawSec: 10,
      bufferTroughSec: 10,
    };
    assert.strictEqual(d({ ...base4, bufferTrendSec: -3 }).rate, 1.08);
    assert.strictEqual(d({ ...base4, bufferTrendSec: -4 }).type, "speed");
    assert.strictEqual(d({ ...base4, bufferTrendSec: -4.001 }).type, "none");
    assert.strictEqual(
      d({ ...base4, bufferTrendSec: -4.001, running: true }).type,
      "stop"
    );
  });
  await t.test("priority: a shrinking buffer vetoes a perfect jump", () => {
    assert.strictEqual(dj({ bufferTrendSec: -5 }).type, "none");
  });
});

test("rule 5: at or below the effective minimum -> stop/none", () => {
  assert.strictEqual(d({ latencyMs: 4000 }).type, "none");
  assert.strictEqual(d({ latencyMs: 4000, running: true }).type, "stop");
  assert.strictEqual(d({ latencyMs: 3999, running: true }).type, "stop");
  // Rev 6: buffer at the floor makes the current latency the reachable
  // minimum -- "at target" even 10s behind.
  const rest = { latencyMs: 10_000, playableBufferSec: 4, playableBufferRawSec: 4, bufferTroughSec: 4 };
  assert.strictEqual(d(rest).type, "none");
  assert.strictEqual(d({ ...rest, running: true }).type, "stop");
});

test("rule 6: hysteresis inside the band", () => {
  // 5000 with 8s buffer: eff band == base band [4000, 5600].
  assert.strictEqual(d({ latencyMs: 5000 }).type, "none");
  assert.strictEqual(d({ latencyMs: 5600 }).type, "none"); // <= max: no start
  // Already running: continues through the band, tapering.
  // f = (5000-4000)/1600 = 0.625, boost 0.08 -> 1.05.
  const going = d({ latencyMs: 5000, running: true, bandwidthRatio: 1.6 });
  assert.strictEqual(going.type, "speed");
  assert.strictEqual(going.rate, 1.05);
  assert.strictEqual(d({ latencyMs: 5600, running: true }).rate, 1.08); // f=1
  // Just above max: starting is allowed.
  assert.strictEqual(d({ latencyMs: 5601 }).rate, 1.08);
});

test("rev 6 headline: floor-resting is silent -- no start attempts, ever", () => {
  // A catch-up that ran out of spendable buffer rests just above the floor
  // with high latency. The effective band contains that resting point by
  // construction, so decide() must answer "none" across the whole regime
  // (reachable latency >= base max), not chatter on the start threshold.
  for (let buf = 4; buf <= 7; buf += 0.25) {
    for (let lat = 6000; lat <= 30_000; lat += 500) {
      const reachable = lat - (buf - 4) * 1000;
      if (reachable < 5600) continue; // could legitimately act: not resting
      const action = d({
        latencyMs: lat,
        playableBufferSec: buf,
        playableBufferRawSec: buf,
        bufferTroughSec: buf, // rev 10: an honest (non-divergent) trough
        bandwidthRatio: 3,
      });
      assert.strictEqual(
        action.type,
        "none",
        `resting state must stay silent (buf ${buf}, latency ${lat}): ` +
          JSON.stringify(action)
      );
    }
  }
});

test("rule 7: bandwidth gate, strict to start, looser to continue", async (t) => {
  await t.test("start needs >= 2.0", () => {
    assert.strictEqual(d({ bandwidthRatio: 1.99 }).type, "none");
    assert.strictEqual(d({ bandwidthRatio: 2.0 }).rate, 1.08);
  });
  await t.test("continue needs >= 1.5", () => {
    assert.strictEqual(d({ bandwidthRatio: 1.49, running: true }).type, "stop");
    assert.strictEqual(d({ bandwidthRatio: 1.5, running: true }).rate, 1.08);
  });
  await t.test("null/NaN always fails", () => {
    assert.strictEqual(d({ bandwidthRatio: null }).type, "none");
    assert.strictEqual(d({ bandwidthRatio: null, running: true }).type, "stop");
    assert.strictEqual(d({ bandwidthRatio: NaN }).type, "none");
  });
  await t.test("priority: bandwidth vetoes a perfect jump", () => {
    assert.strictEqual(dj({ bandwidthRatio: 1.99 }).type, "none");
    assert.strictEqual(dj({ bandwidthRatio: null }).type, "none");
  });
});

test("rule 8: jump happens only under pristine conditions", async (t) => {
  await t.test("all gates pass -> jump; ahead = min(buf-floor, (lat-min)/1000 - segDur)", () => {
    assertJump(dj(), 15, "jumpBase"); // min(26, 21-4-2 = 15)
  });
  await t.test("gate: latency must exceed max + 5000 strictly", () => {
    assert.strictEqual(dj({ latencyMs: 10_600 }).type, "speed"); // == max+5000
    assertJump(dj({ latencyMs: 10_601 }), 4.601, "just past the jump gate");
  });
  await t.test("gate: any recent rebuffer forbids jumping", () => {
    assert.strictEqual(dj({ rebufferEvents: 1 }).type, "none"); // start also blocked
    assert.strictEqual(dj({ rebufferEvents: 1, running: true }).type, "speed");
  });
  await t.test("gate: needs 3 stable checks", () => {
    assert.strictEqual(dj({ stableChecks: 2 }).type, "none");
  });
  await t.test("gate: at most one jump per 20s, strictly", () => {
    assert.strictEqual(dj({ msSinceLastJump: 20_000 }).type, "speed");
    assertJump(dj({ msSinceLastJump: 20_001 }), 15, "jump gate reopens");
  });
  await t.test("gate: buffer must cover floor + 2 segments (segDur 6)", () => {
    // segDur 6, latency 40000: needs buf >= 9 + 12 = 21.
    const seg6 = {
      segmentDurationSec: 6,
      latencyMs: 40_000,
      msSinceLastJump: 30_000,
    };
    // buf 20.99: eff band [28010, 31010], 40000 > 36010 but the buffer gate
    // fails -> falls through to speed (f=1, boost capped 0.08).
    const blocked = d({
      ...seg6,
      playableBufferSec: 20.99,
      playableBufferRawSec: 20.99,
      bufferTroughSec: 20.99,
    });
    assert.strictEqual(blocked.type, "speed");
    assert.strictEqual(blocked.rate, 1.08);
    // buf 21: eff band [28000, 31000], ahead = min(12, 40-28-6 = 6) = 6 >=
    // max(segDur, 2) -> jump.
    assertJump(
      d({ ...seg6, playableBufferSec: 21, playableBufferRawSec: 21, bufferTroughSec: 21 }),
      6,
      "buffer gate boundary"
    );
  });
  await t.test("not-worthwhile jumps fall through to speed (the old backward-seek window)", () => {
    // segDur 6, latency 22s, 22s buffer: base band [10200, 14280] applies
    // (reachable 9000 < base min). 22000 > 19280 and buf 22 >= 21, but
    // ahead = min(13, 22-10.2-6 = 5.8) < max(6, 2) -> MUST speed, not jump.
    // This is exactly where the old code seeked backwards.
    const action = d({
      segmentDurationSec: 6,
      latencyMs: 22_000,
      playableBufferSec: 22,
      playableBufferRawSec: 22,
      bufferTroughSec: 22,
      msSinceLastJump: 30_000,
    });
    assert.strictEqual(action.type, "speed");
    assert.strictEqual(action.rate, 1.08);
  });
  await t.test("jump does not require the speed-start cooldown", () => {
    // Rule 8 precedes rule 9: msSinceLastSpeedChange only gates speed starts.
    assertJump(dj({ msSinceLastSpeedChange: 0 }), 15, "jump despite cooldown");
  });
  await t.test("a rebuffer-raised band shifts the jump window", () => {
    // W 7000 -> base [8000, 11200]; abundant buffer keeps it effective.
    // 12000 is above max but not past max+5000 -> speed.
    const action = d({
      latencyMs: 12_000,
      playableBufferSec: 30,
      playableBufferRawSec: 30,
      bufferTroughSec: 30,
      worstRebufferLatencyMs: 7000,
      msSinceLastJump: 30_000,
    });
    assert.strictEqual(action.type, "speed");
    assert.strictEqual(action.rate, 1.08); // f = (12000-8000)/3200 -> 1
  });
});

test("rule 9: speed start gates (stability, rebuffers, cooldown, entry margin)", async (t) => {
  // latency 10000 / buf 8 cannot jump (10000 < eff max 9000 + 5000).
  await t.test("needs 3 stable checks to start", () => {
    assert.strictEqual(d({ stableChecks: 2 }).type, "none");
    assert.strictEqual(d({ stableChecks: 3 }).rate, 1.08);
  });
  await t.test("needs 10s since the last speed change to start", () => {
    assert.strictEqual(d({ msSinceLastSpeedChange: 9999 }).type, "none");
    assert.strictEqual(d({ msSinceLastSpeedChange: 10_000 }).rate, 1.08);
  });
  await t.test("any recent rebuffer blocks a start but not a continue", () => {
    assert.strictEqual(d({ rebufferEvents: 1 }).type, "none");
    assert.strictEqual(d({ rebufferEvents: 1, running: true }).rate, 1.08);
    assert.strictEqual(d({ rebufferEvents: 4, running: true }).rate, 1.08);
  });
  await t.test("entry margin floor + segDur/2 (rev 4), segDur 8", () => {
    // segDur 8: floor 12, entry needs buf >= 16. At buf 15.5 the effective
    // band is [21500, 24500] and latency 25000 is above max, yet starting
    // is refused; at 16 it starts (f=1, boost=min(0.08, 0.02*4)).
    const seg8 = { segmentDurationSec: 8, latencyMs: 25_000 };
    assert.strictEqual(
      d({ ...seg8, playableBufferSec: 15.5, playableBufferRawSec: 15.5, bufferTroughSec: 15.5 }).type,
      "none"
    );
    assert.strictEqual(
      d({ ...seg8, playableBufferSec: 16, playableBufferRawSec: 16, bufferTroughSec: 16 }).rate,
      1.08
    );
    // Continuing only needs the floor: boost = 0.02*3.5 = 0.07, f = 1.
    const cont = d({
      ...seg8,
      playableBufferSec: 15.5,
      playableBufferRawSec: 15.5,
      bufferTroughSec: 15.5,
      running: true,
    });
    assert.strictEqual(cont.type, "speed");
    assert.strictEqual(cont.rate, 1.07);
  });
});

test("rule 9: the taper -- rate strictly decreases toward the minimum, then stops", () => {
  // Running with 8s buffer, segDur 2: reachable <= base min for all these,
  // so the band is [4000, 5600]. boost = 0.08, f = (lat-4000)/1600.
  const rates = [];
  for (const [lat, expected] of [
    [5600, 1.08],
    [5000, 1.05],
    [4600, 1.03],
    [4300, 1.015],
    [4100, 1.005], // exactly the actionable minimum: still speed
  ]) {
    const action = d({ latencyMs: lat, running: true, bandwidthRatio: 2 });
    assert.strictEqual(action.type, "speed", `latency ${lat}`);
    assert.strictEqual(action.rate, expected, `latency ${lat}`);
    rates.push(action.rate);
  }
  for (let i = 1; i < rates.length; i++) {
    assert.ok(rates[i] < rates[i - 1], "taper must strictly decrease");
  }
  // Below the actionable rate the compensator lets go instead of idling at
  // an imperceptible speedup: 4080 -> rate 1.004 -> stop.
  assert.strictEqual(
    d({ latencyMs: 4080, running: true, bandwidthRatio: 2 }).type,
    "stop"
  );
});

test("rule 9: exact rate arithmetic at 4 decimals", () => {
  // boost not at the cap: buf 6.7 -> 0.02*2.7 = 0.054; f = 800/1600 = 0.5
  // -> 1.027.
  assert.strictEqual(
    d({
      latencyMs: 4800,
      playableBufferSec: 6.7,
      playableBufferRawSec: 6.7,
      bufferTroughSec: 6.7,
      running: true,
    }).rate,
    1.027
  );
  // Sub-cap boost with f = 1: buf 7.99 -> eff band [8010, 11010], latency
  // 12000 above max -> start at 1 + 0.02*3.99 = 1.0798.
  assert.strictEqual(
    d({
      latencyMs: 12_000,
      playableBufferSec: 7.99,
      playableBufferRawSec: 7.99,
      bufferTroughSec: 7.99,
    }).rate,
    1.0798
  );
});

test("property sweep: no timeout, jumps always forward and floor-preserving, rates bounded", () => {
  // segDur x latency x buffer x trough x running, all gates open. Rev 10:
  // each mean is swept with an equal trough AND a trough sunk a full segment
  // below it (clamped to the floor; trough <= mean always, as physically
  // guaranteed). Nothing in this grid may time out (latency <= 60s, raw and
  // mean >= floor >= 4); every jump must be > 0, leave >= floor of the
  // TROUGH, and be worth >= max(segDur, 2); every speed rate must be
  // actionable and within [1.005, 1.08].
  const gates = {
    bufferTrendSec: 0,
    bandwidthRatio: 3,
    stableChecks: 5,
    rebufferEvents: 0,
    worstRebufferLatencyMs: null,
    msSinceLastSpeedChange: 30_000,
    msSinceLastJump: 30_000,
  };
  for (const segDur of [2, 4, 6, 8]) {
    const floor = Math.max(1.5 * segDur, 4);
    const baseMin = Math.max(4000, 1700 * segDur);
    let jumps = 0;
    let speeds = 0;
    for (const running of [false, true]) {
      for (let lat = baseMin - 1000; lat <= 60_000; lat += 500) {
        for (let buf = floor; buf <= 30; buf += 0.5) {
          for (const trough of [buf, Math.max(floor, buf - segDur)]) {
            const action = decide(
              Object.freeze({
                ...gates,
                latencyMs: lat,
                playableBufferSec: buf,
                playableBufferRawSec: buf,
                bufferTroughSec: trough,
                segmentDurationSec: segDur,
                running,
              })
            );
            const ctx = `segDur ${segDur}, lat ${lat}, buf ${buf}, trough ${trough}, running ${running}`;
            assert.notStrictEqual(action.type, "timeout", ctx);
            if (action.type === "jump") {
              jumps++;
              assert.ok(action.aheadSec > 0, `${ctx}: backward/zero jump`);
              assert.ok(
                action.aheadSec <= trough - floor + 1e-9,
                `${ctx}: jump spends the trough past the floor (${action.aheadSec})`
              );
              assert.ok(
                action.aheadSec >= Math.max(segDur, 2) - 0.011,
                `${ctx}: jump below the worthwhile minimum`
              );
            } else if (action.type === "speed") {
              speeds++;
              assert.ok(
                action.rate >= 1.005 && action.rate <= 1.08,
                `${ctx}: rate ${action.rate}`
              );
            }
          }
        }
      }
    }
    // The sweep must actually exercise both action kinds per segDur.
    assert.ok(jumps > 0, `sweep never jumped for segDur ${segDur}`);
    assert.ok(speeds > 0, `sweep never sped for segDur ${segDur}`);
  }
});

test("decide is pure: same input, same answer, input untouched", () => {
  // Every call in this file already uses frozen inputs (a mutation would
  // throw). Determinism: identical calls give identical answers.
  for (const over of [
    {},
    { latencyMs: 21_000, playableBufferSec: 30, playableBufferRawSec: 30, msSinceLastJump: 30_000 },
    { latencyMs: null },
    { playableBufferSec: 1, playableBufferRawSec: 1 },
    { bufferTroughSec: 4.8 }, // rev 10: a divergent trough is just as pure
  ]) {
    const a = d(over);
    const b = d(over);
    assert.deepStrictEqual(a, b);
    assert.strictEqual(typeof a.reason, "string");
    assert.ok(a.reason.length > 0, "every action carries a reason");
  }
});

// ---------------------------------------------------------------------------
// Rev 9: earned trust. Trusted formulas, hand-derived from the spec:
//   floor = max(segDur + 1, 3)      base min = max(3000, 1700*segDur)
// Trust may only ever RELAX the safety cushion; every default preserves the
// untrusted (old) behavior.

test("rev 9: trusted floor and base band per segment duration", () => {
  // [segDur, trusted floor, untrusted floor, trusted min, trusted max]
  for (const [segDur, tFloor, uFloor, tMin, tMax] of [
    [1, 3, 4, 3000, 4200], // floor max(2,3); max = max(4200, min(2200, 15000))
    [2, 3, 4, 3400, 4760], // max = max(4760, 4400)
    [3, 4, 4.5, 5100, 7140], // 1700*3 > 3000: absolute min stops mattering
    [4, 5, 6, 6800, 9520],
    [6, 7, 9, 10200, 14280],
  ]) {
    assert.strictEqual(
      bufferFloorSeconds(segDur, true),
      tFloor,
      `trusted floor segDur ${segDur}`
    );
    assert.strictEqual(
      bufferFloorSeconds(segDur),
      uFloor,
      `untrusted floor segDur ${segDur}`
    );
    assert.deepStrictEqual(
      latencyThresholds(segDur, null, true),
      { minLatencyMs: tMin, maxLatencyMs: tMax },
      `trusted band segDur ${segDur}`
    );
  }
  // Boundary: once 1700*segDur >= 4000 (segDur >= 40/17) the segment term
  // owns the minimum and the trusted band EQUALS the untrusted one -- trust
  // then only thins the floor.
  for (const segDur of [3, 4, 6]) {
    assert.deepStrictEqual(
      latencyThresholds(segDur, null, true),
      latencyThresholds(segDur, null, false),
      `band must not differ at segDur ${segDur}`
    );
  }
});

test("rev 9: a rebuffer raise lands on the same guarded band regardless of trust", () => {
  // W=7000 raises min to min(8000, 15000) = 8000 in BOTH modes: learned
  // caution may never be undone by trust.
  assert.deepStrictEqual(latencyThresholds(2, 7000, true), {
    minLatencyMs: 8000,
    maxLatencyMs: 11_200,
  });
  assert.deepStrictEqual(
    latencyThresholds(2, 7000, true),
    latencyThresholds(2, 7000, false)
  );
  // A rebuffer at LOW latency still never lowers the trusted band either.
  assert.deepStrictEqual(latencyThresholds(2, 1000, true), {
    minLatencyMs: 3400,
    maxLatencyMs: 4760,
  });
});

test("rev 9 property: trust only ever relaxes -- floor and band never rise", () => {
  // Trusted floor above the untrusted one is impossible by construction:
  // max(s+1, 3) <= max(1.5s, 4) for every s > 0. Sweep the whole plausible
  // segment range including the crossover points s = 2 and s = 8/3.
  for (let segDur = 0.5; segDur <= 12; segDur += 0.25) {
    const tFloor = bufferFloorSeconds(segDur, true);
    const uFloor = bufferFloorSeconds(segDur, false);
    assert.ok(
      tFloor <= uFloor,
      `trusted floor ${tFloor} above untrusted ${uFloor} (segDur ${segDur})`
    );
    const tBand = latencyThresholds(segDur, null, true);
    const uBand = latencyThresholds(segDur, null, false);
    assert.ok(
      tBand.minLatencyMs <= uBand.minLatencyMs,
      `trusted min above untrusted (segDur ${segDur})`
    );
    assert.ok(
      tBand.maxLatencyMs > tBand.minLatencyMs,
      `trusted max not above min (segDur ${segDur})`
    );
    // The relaxation survives the effective-band adjustment: same state,
    // trusted effective minimum never sits above the untrusted one.
    for (const [lat, buf] of [
      [5000, uFloor + 1],
      [12_000, uFloor + 4],
      [30_000, uFloor + 10],
    ]) {
      const te = effectiveLatencyBand(segDur, null, lat, buf, true);
      const ue = effectiveLatencyBand(segDur, null, lat, buf, false);
      assert.ok(
        te.minLatencyMs <= ue.minLatencyMs,
        `trusted effective min above untrusted (segDur ${segDur}, lat ${lat}, buf ${buf})`
      );
    }
  }
});

test("rev 9: trusted effective band spends the thinner floor", () => {
  // Abundant buffer: the trusted base band comes through unchanged.
  assert.deepStrictEqual(effectiveLatencyBand(2, null, 10_000, 30, true), {
    minLatencyMs: 3400,
    maxLatencyMs: 4760,
  });
  // 8s buffer: trusted floor 3 -> 5s spendable -> reachable 5000 >= base
  // max 4760 -> [5000, 8000]. Untrusted floor 4 gives [6000, 9000]: one
  // extra second of reach, exactly the floor difference.
  assert.deepStrictEqual(effectiveLatencyBand(2, null, 10_000, 8, true), {
    minLatencyMs: 5000,
    maxLatencyMs: 8000,
  });
});

test("rev 9: trust flips the same state from none/stop to speed", async (t) => {
  await t.test("band: 5000ms is inside untrusted [4000, 5600] but above trusted max 4760", () => {
    const state = { latencyMs: 5000, playableBufferSec: 30, playableBufferRawSec: 30, bufferTroughSec: 30 };
    assert.strictEqual(d(state).type, "none"); // rule 6 hysteresis
    const trusted = d({ ...state, trusted: true });
    assert.strictEqual(trusted.type, "speed");
    assert.strictEqual(trusted.rate, 1.08); // boost capped, f = 1600/1360 -> 1
  });
  await t.test("rule 9 entry margin uses the trusted floor (4.2s buffer, 5700ms)", () => {
    // Untrusted: eff band [5500, 5600], 5700 above max, but the entry
    // margin needs buf >= floor + 1 = 5 -> none. Trusted: floor 3, margin
    // 4 <= 4.2; eff band [4500, 4760]; 5700 > max -> speed at
    // 1 + 0.02*(4.2-3) with f = 1200/260 clamped to 1 = 1.024.
    const state = { latencyMs: 5700, playableBufferSec: 4.2, playableBufferRawSec: 4.2, bufferTroughSec: 4.2 };
    assert.strictEqual(d(state).type, "none");
    const trusted = d({ ...state, trusted: true });
    assert.strictEqual(trusted.type, "speed");
    assert.strictEqual(trusted.rate, 1.024);
  });
  await t.test("rule 3 floor: 3.5s buffer stops an untrusted run, continues a trusted one", () => {
    // Untrusted: 3.5 < floor 4 -> stop, never act below the floor.
    // Trusted: floor 3 passes; eff band [4200, 4760]; f = 500/560,
    // boost = 0.02*0.5 -> rate = 1 + 0.01*0.892857 = 1.0089 (4dp).
    const state = {
      latencyMs: 4700,
      playableBufferSec: 3.5,
      playableBufferRawSec: 3.5,
      bufferTroughSec: 3.5,
      running: true,
    };
    assert.strictEqual(d(state).type, "stop");
    const trusted = d({ ...state, trusted: true });
    assert.strictEqual(trusted.type, "speed");
    assert.strictEqual(trusted.rate, 1.0089);
  });
});

test("rev 9: trusted jump math uses the trusted floor and minimum", () => {
  // jumpBase under trust: band [3400, 4760], floor 3 ->
  // ahead = min(30 - 3, (21000 - 3400)/1000 - 2) = min(27, 15.6) = 15.6
  // (the untrusted case above jumps 15: trust spends exactly the floor
  // difference plus the lower minimum).
  assertJump(dj({ trusted: true }), 15.6, "trusted jump");
});

test("rev 9: omitting `trusted` behaves exactly as trusted:false", () => {
  // The rev 9 surface is additive: every helper and decide() itself must
  // be bit-identical with the flag absent and with trusted:false.
  for (const segDur of [1, 2, 3, 4, 6]) {
    assert.strictEqual(bufferFloorSeconds(segDur), bufferFloorSeconds(segDur, false));
    for (const w of [null, 7000]) {
      assert.deepStrictEqual(
        latencyThresholds(segDur, w),
        latencyThresholds(segDur, w, false)
      );
      assert.deepStrictEqual(
        effectiveLatencyBand(segDur, w, 12_000, 10),
        effectiveLatencyBand(segDur, w, 12_000, 10, false)
      );
    }
  }
  for (const over of [
    {},
    { latencyMs: 5000, playableBufferSec: 30, playableBufferRawSec: 30, bufferTroughSec: 30 },
    { latencyMs: 5700, playableBufferSec: 4.2, playableBufferRawSec: 4.2, bufferTroughSec: 4.2 },
    { latencyMs: 4700, playableBufferSec: 3.5, playableBufferRawSec: 3.5, bufferTroughSec: 3.5, running: true },
    { latencyMs: 21_000, playableBufferSec: 30, playableBufferRawSec: 30, bufferTroughSec: 30, msSinceLastJump: 30_000 },
  ]) {
    assert.deepStrictEqual(d(over), d({ ...over, trusted: false }));
  }
});

// ---------------------------------------------------------------------------
// Rev 10: the trough/mean split. Live incident 2026-07-05: the raw playable
// buffer sawtooths a full segment below its mean (and reads an arbitrary
// phase when segDur matches the check cadence), so mean-based floor
// accounting let a catch-up spend the raw trough through the floor -> stall.
// Every floor comparison and spend budget now reads bufferTroughSec (the min
// of the last 4 raw samples); start eagerness stays on the mean. Every case
// below makes the two DIVERGE (trough < mean) -- exactly the sawtooth state
// the mean hides -- with expectations hand-derived from the rev 10 spec.

test("rev 10: floor and spend gates read the TROUGH, not the mean", async (t) => {
  // All from `base`: latency 10000, mean/raw 8, segDur 2 -> floor 4, base
  // band [4000, 5600]. Rule 2 stays quiet throughout: min(raw, mean) = 8.
  const cases = [
    // Rule 3: trough 3.9 < floor 4 while the mean reads a fat 8. Rev 9 read
    // the mean (8 >= floor, spend band [6000, 9000], f = 4000/3000 -> 1,
    // boost 0.08) and sped at 1.08 into a stall -- the incident.
    [
      "rule 3: trough 3.9 under floor 4 idles a rich-looking mean",
      { bufferTroughSec: 3.9 },
      { type: "none", reason: "buffer at floor" },
    ],
    [
      "rule 3: ...and stops a running catch-up",
      { bufferTroughSec: 3.9, running: true },
      { type: "stop", reason: "buffer at floor" },
    ],
    // Rule 5: a trough resting exactly ON the floor has zero spendable
    // buffer: spendMin = max(4000, 10000 - (4-4)*1000) = 10000; 10000 <=
    // 10000, and 10000 > base min 4000 picks the spent-down reason. The
    // mean 8 alone would have afforded [6000, 9000] -> speed 1.08 (rev 9).
    [
      "rule 5: trough ON the floor stops the spend despite mean 8",
      { bufferTroughSec: 4 },
      { type: "none", reason: "buffer spent down to the floor" },
    ],
    [
      "rule 5: ...and stops a running catch-up",
      { bufferTroughSec: 4, running: true },
      { type: "stop", reason: "buffer spent down to the floor" },
    ],
    // Rule 5 reason split: at or below base min 4000 the verdict stays
    // "at target latency" however far trough and mean diverge. trough 5:
    // spendMin = max(4000, 4000 - (5-4)*1000 = 3000) = 4000; 4000 <= 4000.
    [
      "rule 5: latency == base min is 'at target' regardless of divergence",
      { latencyMs: 4000, bufferTroughSec: 5 },
      { type: "none", reason: "at target latency" },
    ],
    [
      "rule 5: ...also when running",
      { latencyMs: 4000, bufferTroughSec: 5, running: true },
      { type: "stop", reason: "at target latency" },
    ],
    // Strictly below base min, still diverging (mean 6, trough 4.5):
    // spendMin = max(4000, 3600 - (4.5-4)*1000 = 3100) = 4000; 3600 <= 4000.
    [
      "rule 5: latency under base min is 'at target' too",
      { latencyMs: 3600, playableBufferSec: 6, playableBufferRawSec: 6, bufferTroughSec: 4.5 },
      { type: "none", reason: "at target latency" },
    ],
  ];
  for (const [name, over, expect] of cases) {
    await t.test(name, () => {
      const action = d(over);
      assert.strictEqual(action.type, expect.type, JSON.stringify(action));
      assert.strictEqual(action.reason, expect.reason);
    });
  }
});

test("rev 10: start eagerness reads the MEAN, spending reads the trough", async (t) => {
  // segDur 2, latency 8000. The START band (hysteresis) comes from the
  // mean; the SPEND band (stop point and taper) from the trough.
  const cases = [
    // START from mean 7: startMin = max(4000, 8000 - (7-4)*1000 = 5000) =
    // 5000 < base max 5600 -> startMax stays 5600; 8000 > 5600 -> start.
    // SPEND from trough 6: spendMin = max(4000, 8000 - 2000 = 6000) >=
    // 5600 -> spendMax 9000; f = (8000-6000)/3000 = 2/3; boost = min(0.08,
    // 0.02*(6-4)) = 0.04 -> rate = round4(1 + 0.04*2/3) = 1.0267.
    [
      "mean 7 starts at 8000; the trough 6 only shapes the rate",
      { latencyMs: 8000, playableBufferSec: 7, playableBufferRawSec: 7, bufferTroughSec: 6 },
      { type: "speed", reason: "catching up", rate: 1.0267 },
    ],
    // Same trough 6 but mean 6: startMin = max(4000, 8000 - 2000 = 6000)
    // >= base max 5600 -> startMax = 6000 + 3000 = 9000; 8000 <= 9000 ->
    // the crumb rule holds the start. The MEAN is the sole discriminator
    // between this row and the previous one.
    [
      "mean 6 at the same latency is inside the start band: no start",
      { latencyMs: 8000, playableBufferSec: 6, playableBufferRawSec: 6, bufferTroughSec: 6 },
      { type: "none", reason: "inside latency band" },
    ],
    // Hysteresis is start-only: running through the same state tapers on
    // the SPEND band [6000, 9000] (trough == mean == 6 here): f = 2/3,
    // boost 0.04 -> 1.0267, identical to the mean-7 start above.
    [
      "the same crumbs keep an active run tapering",
      { latencyMs: 8000, playableBufferSec: 6, playableBufferRawSec: 6, bufferTroughSec: 6, running: true },
      { type: "speed", reason: "catching up", rate: 1.0267 },
    ],
  ];
  for (const [name, over, expect] of cases) {
    await t.test(name, () => {
      const action = d(over);
      assert.strictEqual(action.type, expect.type, JSON.stringify(action));
      assert.strictEqual(action.reason, expect.reason);
      if ("rate" in expect) assert.strictEqual(action.rate, expect.rate);
    });
  }
});

test("rev 10: the rule 9 entry margin reads the TROUGH", async (t) => {
  // base: latency 10000, mean 8, segDur 2. START band from mean 8: startMin
  // = max(4000, 10000 - 4000 = 6000) >= base max 5600 -> startMax 9000;
  // 10000 > 9000 clears hysteresis. (A mean of 7 could NOT expose the entry
  // gate at this latency: its raise reaches base max, so startMax becomes
  // 10000 - 3000 + 3000 = the latency itself and rule 6 absorbs it.) The
  // jump trigger stays shut: 10000 <= 9000 + 5000. Rule 5 stays quiet for
  // every trough > floor: spendMin = 10000 - (trough-4)*1000 < 10000.
  const cases = [
    // Entry needs trough >= floor + segDur/2 = 5: 4.8 < 5 -> refuse.
    [
      "trough 4.8 < 5: too close to the floor to start, mean 8 or not",
      { bufferTroughSec: 4.8 },
      { type: "none", reason: "buffer too close to floor to start" },
    ],
    // The gate is strict <, so trough 5.0 starts: spendMin = max(4000,
    // 10000 - 1000 = 9000) >= 5600 -> spendMax 12000; boost = min(0.08,
    // 0.02*(5-4)) = 0.02; f = (10000-9000)/3000 = 1/3 ->
    // rate = round4(1 + 0.02/3) = 1.0067.
    [
      "trough 5.0 exactly clears the strict gate and starts",
      { bufferTroughSec: 5 },
      { type: "speed", reason: "catching up", rate: 1.0067 },
    ],
    // The margin gates STARTS only; a running spend at trough 4.8 falls to
    // the crumb rule instead: spendMin = max(4000, 10000 - 800 = 9200) ->
    // spendMax 12200; boost = 0.02*0.8 = 0.016; f = 800/3000; rate =
    // round4(1 + 0.016*800/3000) = 1.0043 < 1.005 -> not worthwhile.
    [
      "running at trough 4.8: the taper crumbles out instead",
      { bufferTroughSec: 4.8, running: true },
      { type: "stop", reason: "not enough headroom to be worthwhile" },
    ],
  ];
  for (const [name, over, expect] of cases) {
    await t.test(name, () => {
      const action = d(over);
      assert.strictEqual(action.type, expect.type, JSON.stringify(action));
      assert.strictEqual(action.reason, expect.reason);
      if ("rate" in expect) assert.strictEqual(action.rate, expect.rate);
    });
  }
});

test("rev 10: jumps are throttled by the trough, triggered by the mean", async (t) => {
  // jumpBase: latency 21000, mean/raw 30, segDur 2. The trigger reads the
  // MEAN: start band from mean 30 is the base [4000, 5600] (reachable
  // 21000 - 26000 < 0) and 21000 > 5600 + 5000. Landing and spend budget
  // read the TROUGH.
  await t.test("trough 12 throttles what rev 9's mean 30 jumped 15 on", () => {
    // spendMin = max(4000, 21000 - (12-4)*1000 = 13000) = 13000; ahead =
    // min(12-4, (21000-13000)/1000 - 2) = min(8, 6) = 6. Expanding the
    // spec formula, the second arm is min((latency-baseMin)/1000,
    // trough-floor) - segDur -- always below trough - floor, so the
    // spend-band raise is HOW the trough caps the landing; here it leaves
    // trough - 6 = 6 = floor + segDur behind.
    assertJump(dj({ bufferTroughSec: 12 }), 6, "trough-throttled jump");
  });
  await t.test("trough 8 == floor + 2*segDur: the smallest worthwhile jump", () => {
    // The landing gate is inclusive (>=). spendMin = max(4000, 21000 -
    // (8-4)*1000 = 17000) = 17000; ahead = min(4, (21000-17000)/1000 - 2
    // = 2) = 2, exactly max(segDur, 2).
    assertJump(dj({ bufferTroughSec: 8 }), 2, "boundary jump");
  });
  await t.test("trough 7.9 blocks the jump outright; mean 30 cannot revive it", () => {
    // 7.9 < floor + 2*segDur = 8 -> no jump. Falls through rule 9 (entry:
    // 7.9 >= 5) to speed: spendMin = max(4000, 21000 - 3900 = 17100) >=
    // 5600 -> spendMax 20100; f = (21000-17100)/3000 = 1.3 -> 1; boost =
    // min(0.08, 0.02*3.9 = 0.078) -> rate 1.078.
    const action = dj({ bufferTroughSec: 7.9 });
    assert.strictEqual(action.type, "speed", JSON.stringify(action));
    assert.strictEqual(action.reason, "catching up");
    assert.strictEqual(action.rate, 1.078);
  });
});

test("rev 10: an absent or non-finite trough falls back to min(raw, mean)", async (t) => {
  // The compensator's own sampling guarantees trough <= raw and mean;
  // outside callers may omit the input. The fallback must stay floor-safe.
  for (const [name, trough] of [
    ["omitted", undefined],
    ["null", null],
    ["NaN", NaN],
  ]) {
    await t.test(`${name}: raw 3.9 pierces the mean-8 smoothing`, () => {
      // trough = min(3.9, 8) = 3.9 < floor 4 -> rule 3. Rule 2 stays
      // quiet: min(raw, mean) = 3.9 >= 2.
      const action = d({ playableBufferRawSec: 3.9, bufferTroughSec: trough });
      assert.strictEqual(action.type, "none", JSON.stringify(action));
      assert.strictEqual(action.reason, "buffer at floor");
    });
  }
  await t.test("the mean arm of the fallback min", () => {
    // mean 3.9, raw 8: trough = min(8, 3.9) = 3.9 < floor 4 -> rule 3.
    const action = d({ playableBufferSec: 3.9, playableBufferRawSec: 8, bufferTroughSec: null });
    assert.strictEqual(action.type, "none", JSON.stringify(action));
    assert.strictEqual(action.reason, "buffer at floor");
  });
  await t.test("an explicit finite trough is authoritative over the raw sample", () => {
    // Fallback applies ONLY when the trough is absent/non-finite: base's
    // explicit trough 8 with raw 3.9 clears rule 3 (8 >= 4) and rule 2
    // (min(3.9, 8) >= 2); spend band [6000, 9000]; f = 4000/3000 -> 1;
    // boost = min(0.08, 0.02*4) -> speed 1.08.
    const action = d({ playableBufferRawSec: 3.9 });
    assert.strictEqual(action.type, "speed", JSON.stringify(action));
    assert.strictEqual(action.rate, 1.08);
  });
});

test("rev 10 trusted: the thinner floor still binds the trough, never the mean", async (t) => {
  // trusted, segDur 2: floor 3, base band [3400, 4760], entry margin
  // 3 + 1 = 4. Otherwise base: latency 10000, mean/raw 8 (rule 2 quiet).
  await t.test("floor gate: trough 2.9 < trusted floor 3", () => {
    const idle = d({ trusted: true, bufferTroughSec: 2.9 });
    assert.strictEqual(idle.type, "none", JSON.stringify(idle));
    assert.strictEqual(idle.reason, "buffer at floor");
    const stop = d({ trusted: true, bufferTroughSec: 2.9, running: true });
    assert.strictEqual(stop.type, "stop");
    assert.strictEqual(stop.reason, "buffer at floor");
  });
  await t.test("trust changes the verdict on the same sunk trough 3.5", () => {
    // Untrusted floor 4: 3.5 < 4 -> "buffer at floor". Trusted floor 3
    // passes, but the taper is a crumb: spendMin = max(3400, 10000 - 500 =
    // 9500) -> spendMax 12500; boost = 0.02*(3.5-3) = 0.01; f = 500/3000;
    // rate = round4(1 + 0.01/6) = 1.0017 < 1.005 -> not worthwhile.
    const run = { bufferTroughSec: 3.5, running: true };
    const untrusted = d(run);
    assert.strictEqual(untrusted.type, "stop");
    assert.strictEqual(untrusted.reason, "buffer at floor");
    const trusted = d({ ...run, trusted: true });
    assert.strictEqual(trusted.type, "stop");
    assert.strictEqual(trusted.reason, "not enough headroom to be worthwhile");
  });
  await t.test("entry margin: trough 3.9 < 4 refuses the start", () => {
    // START band from mean 8: startMin = max(3400, 10000 - (8-3)*1000 =
    // 5000) = 5000 >= base max 4760 -> startMax 8000; 10000 > 8000 clears
    // hysteresis; the jump trigger needs > 13000. Rule 5 quiet: spendMin =
    // max(3400, 10000 - 900 = 9100) < 10000. Entry: 3.9 < 4 -> refuse.
    const action = d({ trusted: true, bufferTroughSec: 3.9 });
    assert.strictEqual(action.type, "none", JSON.stringify(action));
    assert.strictEqual(action.reason, "buffer too close to floor to start");
  });
  await t.test("entry margin is strict: trough 4.0 starts", () => {
    // spendMin = max(3400, 10000 - 1000 = 9000) -> spendMax 12000; boost =
    // 0.02*(4-3) = 0.02; f = 1000/3000 -> rate = round4(1 + 0.02/3) = 1.0067.
    const action = d({ trusted: true, bufferTroughSec: 4 });
    assert.strictEqual(action.type, "speed", JSON.stringify(action));
    assert.strictEqual(action.rate, 1.0067);
  });
});
