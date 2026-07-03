/*
Deterministic fake videojs player + VHS tech + live-stream model. Harness, not
a test.

The model, all driven by the MOCKED clock (enable node:test mock timers with
apis ['setInterval','setTimeout','Date'] before constructing anything here):

- A live encoder starts producing at model start. Media second m of the stream
  maps 1:1 to wall time; segment k covers media seconds [k*d, (k+1)*d) and
  becomes fetchable once fully produced (the available edge is quantized to
  whole segments, like a real HLS playlist). programDateTime(k) is expressed
  in SERVER wall time; the client's (mocked) clock may differ from the server
  clock by `clockErrorMs` (client = server + clockErrorMs), which is what
  setClockSkew(-clockErrorMs) is supposed to correct.
- The downloader fetches sequentially at `rateFactor(tSec)` x realtime into
  buffered ranges, capped at `maxBufferAheadSec` of forward buffer.
  networkState is 2 (LOADING) only while a fetch is in flight and 1 (IDLE)
  between segment fetches -- rev 2 regression: NEVER hardcode 2.
- The playhead advances at playbackRate while buffer is available. On
  underrun it freezes and fires 'waiting' (recorded as a stall); it resumes
  and fires 'playing' once >=1s is rebuffered. A seek into unbuffered content
  starts a refill instead: 'waiting' fires immediately with seeking() reading
  true for the whole refill (rev 7: a seek-discontinuity fetch, not playback
  starvation) and the freeze is NOT counted as a stall. Played content is
  evicted backBufferSec behind the playhead, so far-backward scrubs land in
  unbuffered territory like they do in a real media element.
- Surface implemented (exactly what old+new compensators touch): on, paused,
  seeking, networkState, tech({...}).vhs.{playlists.media(), systemBandwidth,
  representations()}, tech.currentTime, buffered, currentTime (get/set),
  playbackRate (get/set), seekable, liveTracker.seekToLiveEdge.

Recorded: every currentTime write, every playbackRate write, every stall,
every rendition enabled() write, and network idle/fetching tallies.

Drive it with advanceTo(Date.now()) after every mock-timer tick; runScenario()
below does exactly that in 100ms steps (mock Date is end-of-tick and timers
scheduled mid-tick fire on the next tick, so fine steps keep everything within
100ms of truth).

All expected values in assertion helpers here are derived from the contract
spec, never from the implementation.
*/

import assert from "node:assert";

const MODEL_STEP_MS = 100;
const RESUME_THRESHOLD_SEC = 1.0;

// ---- Spec oracles (contract formulas, restated independently of the
// implementation so scenario assertions never lean on the code under test).
// Rev 9: every oracle takes the earned-trust flag. Trusted formulas from the
// spec: floor = max(segDur + 1, 3); base min = max(3000, 1700 * segDur).

export function specBufferFloor(segDur, trusted = false) {
  if (trusted) {
    return Math.max(segDur + 1, 3);
  }
  return Math.max(1.5 * segDur, 4);
}

export function specThresholds(segDur, worstRebufferLatencyMs = null, trusted = false) {
  let min = Math.max(trusted ? 3000 : 4000, 1700 * segDur);
  if (Number.isFinite(worstRebufferLatencyMs)) {
    min = Math.max(min, Math.min(worstRebufferLatencyMs + 1000, 15000));
  }
  let max = Math.max(min * 1.4, Math.min(2200 * segDur, 15000));
  if (min >= max) {
    max = min + 3000;
  }
  return { min, max };
}

// Rev 6: the band adjusted for what the buffer can afford. All band
// comparisons in decide() use this. Rev 9: trusted selects floor and base.
export function specEffectiveBand(segDur, worstW, latencyMs, playableBufferSec, trusted = false) {
  const base = specThresholds(segDur, worstW, trusted);
  const reachable =
    latencyMs - (playableBufferSec - specBufferFloor(segDur, trusted)) * 1000;
  const min = Math.max(base.min, reachable);
  const max = min >= base.max ? min + 3000 : base.max;
  return { min, max };
}

// The trust state the compensator itself reported at a given instant: the
// last onStats sample at or before it (stats are emitted before actions
// execute, so a sample sharing the timestamp of a rate write / seek carries
// the trust state that produced it). No stats yet -> untrusted.
export function trustedAt(stats, atMs) {
  let trusted = false;
  for (const s of stats) {
    if (s.at > atMs) break;
    trusted = !!s.trusted;
  }
  return trusted;
}

// ---- The fake player -------------------------------------------------------

export class FakeLivePlayer {
  constructor({
    segDur,
    initialLatencySec,
    initialBufferSec = 2,
    rateFactor = () => 3,
    clockErrorMs = 0,
    maxBufferAheadSec = 30,
    backBufferSec = 30, // played content evicted this far behind the playhead
    networkStateWhenIdle = 1, // rev 2: IDLE between fetches; some browsers stick at 2
    bandwidth = 3_000_000,
    renditionBandwidths = [400_000, 1_200_000, 3_000_000],
    playlistBandwidth = undefined, // playlist BANDWIDTH attr; null = unknown
    playlistWindowSec = 120,
  }) {
    this.segDur = segDur;
    this.initialLatencySec = initialLatencySec;
    this.rateFactor = rateFactor;
    this.clockErrorMs = clockErrorMs;
    this.maxBufferAheadSec = maxBufferAheadSec;
    this.backBufferSec = backBufferSec;
    this.networkStateWhenIdle = networkStateWhenIdle;
    this.bandwidth = bandwidth;
    this.playlistBandwidth =
      playlistBandwidth === undefined ? bandwidth : playlistBandwidth;
    this.playlistWindowSec = playlistWindowSec;

    this.simStartMs = Date.now();
    this.lastNowMs = this.simStartMs;
    this.playhead = 0;
    this.ranges = [{ start: 0, end: Math.min(initialBufferSec, this.availableEdge(0)) }];
    this.pausedFlag = false;
    this.stalled = false;
    this.refilling = false;
    this.seekTick = 0; // in-buffer seeks report seeking() for one model step
    this.rate = 1.0;
    this.networkStateVal = 1;
    this.startedPlaying = false;
    this.listeners = new Map();

    this.renditions = renditionBandwidths.map((bw, i) => {
      const rep = {
        id: `rep${i}`,
        bandwidth: bw,
        _enabled: true,
      };
      rep.enabled = (flag) => {
        if (flag === undefined) return rep._enabled;
        if (rep._enabled !== flag) {
          this.records.renditionWrites.push({
            at: Date.now(),
            id: rep.id,
            enabled: flag,
          });
        }
        rep._enabled = flag;
      };
      return rep;
    });

    this.records = {
      seeks: [], // {at, from, to, user, bufferedBefore, bufferedAfter, availableAheadAfter}
      rateWrites: [], // {at, from, to, bufferedAhead}
      stalls: [], // {at, mediaPos}
      renditionWrites: [],
      refillWaitings: 0, // 'waiting' fired at a seek discontinuity (rev 7)
      net: { idle: 0, fetching: 0 },
    };

    const self = this;
    this._tech = {
      currentTime: () => self.playhead,
      vhs: {
        playlists: { media: () => self.buildPlaylist() },
        get systemBandwidth() {
          return self.rateFactor(self.tSec()) * self.bandwidth;
        },
        representations: () => self.renditions,
      },
    };
    this.liveTracker = {
      seekToLiveEdge: () => this.currentTime(this.availableEdge(this.tSec())),
    };
  }

  // -- time helpers --
  tSec() {
    return (this.lastNowMs - this.simStartMs) / 1000;
  }
  producedEdge(tSec) {
    return this.initialLatencySec + tSec;
  }
  availableEdge(tSec) {
    return Math.floor(this.producedEdge(tSec) / this.segDur) * this.segDur;
  }
  bufferedAhead() {
    const r = this.activeRange();
    return r ? Math.max(r.end - this.playhead, 0) : 0;
  }
  activeRange() {
    return this.ranges.find(
      (r) => this.playhead >= r.start - 0.25 && this.playhead <= r.end + 1e-9
    );
  }

  // -- videojs surface --
  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(fn);
  }
  fire(event) {
    for (const fn of this.listeners.get(event) ?? []) fn();
  }
  paused() {
    return this.pausedFlag;
  }
  seeking() {
    return this.refilling || this.seekTick > 0;
  }
  networkState() {
    return this.networkStateVal;
  }
  tech() {
    return this._tech;
  }
  buffered() {
    const ranges = this.ranges;
    return {
      length: ranges.length,
      start: (i) => ranges[i].start,
      end: (i) => ranges[i].end,
    };
  }
  seekable() {
    const avail = this.availableEdge(this.tSec());
    const start = Math.max(0, avail - this.playlistWindowSec);
    return { length: 1, start: () => start, end: () => avail };
  }
  playbackRate(r) {
    if (r === undefined) return this.rate;
    this.records.rateWrites.push({
      at: Date.now(),
      from: this.rate,
      to: r,
      bufferedAhead: this.bufferedAhead(),
    });
    this.rate = r;
  }
  currentTime(v) {
    if (v === undefined) return this.playhead;
    const from = this.playhead;
    const bufferedBefore = this.bufferedAhead();
    this.playhead = v;
    this.seekTick = 2;
    let landed = this.activeRange();
    const refill = !landed;
    if (refill) {
      landed = { start: v, end: v };
      this.ranges.push(landed);
      this.ranges.sort((a, b) => a.start - b.start);
      this.refilling = true;
      this.stalled = false;
    }
    this.records.seeks.push({
      at: Date.now(),
      from,
      to: v,
      user: !!this._userSeek,
      bufferedBefore,
      bufferedAfter: Math.max(landed.end - v, 0),
      availableAheadAfter: this.availableEdge(this.tSec()) - v,
    });
    if (refill) {
      // A real player fires 'waiting' while it fetches across a seek
      // discontinuity -- with seeking() reading true (rev 7). This is NOT
      // playback starvation and is not counted as a stall.
      this.records.refillWaitings++;
      this.fire("waiting");
    }
  }

  // A viewer-initiated scrub: same mechanics, but the seek is not the
  // compensator's doing and is exempt from its safety invariants.
  userSeek(v) {
    this._userSeek = true;
    this.currentTime(v);
    this._userSeek = false;
  }

  // -- scenario controls --
  pause() {
    this.pausedFlag = true;
    this.fire("pause");
  }
  play() {
    this.pausedFlag = false;
    this.fire("playing");
  }

  allRenditionsEnabled() {
    return this.renditions.every((r) => r._enabled);
  }

  // -- the model tick --
  advanceTo(nowMs) {
    while (this.lastNowMs < nowMs) {
      this.step(Math.min(MODEL_STEP_MS, nowMs - this.lastNowMs));
    }
  }

  step(dtMs) {
    this.lastNowMs += dtMs;
    const dt = dtMs / 1000;
    const t = this.tSec();

    if (!this.startedPlaying) {
      this.startedPlaying = true;
      if (!this.pausedFlag) this.fire("playing");
    }
    if (this.seekTick > 0) this.seekTick--;

    // Download: extend the range containing the playhead toward the
    // available edge, respecting the forward-buffer cap.
    const range = this.activeRange();
    const available = this.availableEdge(t);
    let fetching = false;
    if (
      range &&
      range.end < available - 1e-9 &&
      range.end - this.playhead < this.maxBufferAheadSec
    ) {
      fetching = true;
      const speed = this.rateFactor(t);
      range.end = Math.min(
        range.end + speed * dt,
        available,
        this.playhead + this.maxBufferAheadSec
      );
      // Merge with the next range if we caught up to it.
      const i = this.ranges.indexOf(range);
      const next = this.ranges[i + 1];
      if (next && range.end >= next.start - 1e-9) {
        range.end = Math.max(range.end, next.end);
        this.ranges.splice(i + 1, 1);
      }
    }
    // Back-buffer eviction: played content further behind the playhead than
    // backBufferSec is released, like a real media element does. Ranges
    // evicted to nothing disappear (except the one the playhead sits in,
    // e.g. a fresh zero-length refill range).
    for (const r of this.ranges) {
      r.start = Math.min(Math.max(r.start, this.playhead - this.backBufferSec), r.end);
    }
    this.ranges = this.ranges.filter(
      (r) =>
        r.end - r.start > 1e-6 ||
        (this.playhead >= r.start - 0.25 && this.playhead <= r.end + 1e-9)
    );
    this.networkStateVal = fetching ? 2 : this.networkStateWhenIdle;
    this.records.net[fetching ? "fetching" : "idle"]++;

    // Playback.
    if (this.refilling) {
      if (this.bufferedAhead() >= RESUME_THRESHOLD_SEC) {
        this.refilling = false;
        this.seekTick = 0;
        this.fire("playing");
      }
      return;
    }
    if (this.pausedFlag) return;
    if (this.stalled) {
      if (this.bufferedAhead() >= RESUME_THRESHOLD_SEC) {
        this.stalled = false;
        this.fire("playing");
      }
      return;
    }
    const room = range ? range.end - this.playhead : 0;
    const want = this.rate * dt;
    const advance = Math.min(want, Math.max(room, 0));
    this.playhead += advance;
    if (advance < want - 1e-9) {
      this.stalled = true;
      this.records.stalls.push({ at: Date.now(), mediaPos: this.playhead });
      this.fire("waiting");
    }
  }

  buildPlaylist() {
    const d = this.segDur;
    const avail = this.availableEdge(this.tSec());
    const lastK = Math.round(avail / d); // exclusive
    const firstK = Math.max(0, Math.floor((avail - this.playlistWindowSec) / d));
    const segments = [];
    for (let k = firstK; k < lastK; k++) {
      segments.push({
        start: k * d,
        end: (k + 1) * d,
        duration: d,
        // Server wall time at which media second k*d was produced.
        dateTimeObject: new Date(
          this.simStartMs - this.clockErrorMs - (this.initialLatencySec - k * d) * 1000
        ),
      });
    }
    return {
      segments,
      targetDuration: d,
      attributes:
        this.playlistBandwidth > 0 ? { BANDWIDTH: this.playlistBandwidth } : {},
    };
  }
}

// ---- Scenario runner -------------------------------------------------------

/*
Runs one simulated timeline. `t` is the node:test context (mock timers are
enabled here). Returns all records plus the stats stream from onStats.
`Compensator` may be the new or the old class (same public surface); pass
withCompensator:false for the baseline stall-comparison run.
clockSkewMs: null never calls setClockSkew at all (rev 9: leaves the
clock-skew fallback estimator armed).
*/
export function runScenario(t, {
  Compensator,
  withCompensator = true,
  compensatorOptions = undefined, // rev 9: e.g. { qualityPinMode: "current" }
  durationSec,
  enableAtSec = 0,
  clockSkewMs = 0,
  script = [], // [{ atSec, run(model, comp) }]
  now = 1_000_000_000_000,
  ...playerConfig
}) {
  // A test may run several timelines (ON vs OFF comparison): drop any
  // previous mock-timer install before enabling a fresh one.
  t.mock.timers.reset();
  t.mock.timers.enable({
    apis: ["setInterval", "setTimeout", "Date"],
    now,
  });
  // The compensators log every check; keep test output readable. trace() is
  // collected so harness-triggered exceptions inside check() can't hide.
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "log", () => {});
  const traces = [];
  t.mock.method(console, "trace", (err) => traces.push(err));

  const model = new FakeLivePlayer(playerConfig);
  const stats = [];
  let comp = null;
  if (withCompensator) {
    comp = new Compensator(model, compensatorOptions);
    if (clockSkewMs !== null) {
      comp.setClockSkew(clockSkewMs);
    }
    comp.onStats = (s) => {
      stats.push({
        at: Date.now(),
        ...s,
        allRenditionsEnabled: model.allRenditionsEnabled(),
      });
    };
    if (enableAtSec === 0) comp.enable();
  }

  const pending = [...script].sort((a, b) => a.atSec - b.atSec);
  const startMs = Date.now();
  // Ground truth from the model, independent of anything the compensator
  // reports: what the viewer's real latency and buffer are, once a second.
  const latencyTrace = [];
  const steps = Math.round((durationSec * 1000) / MODEL_STEP_MS);
  for (let i = 1; i <= steps; i++) {
    t.mock.timers.tick(MODEL_STEP_MS);
    model.advanceTo(Date.now());
    const tSec = (Date.now() - startMs) / 1000;
    if (comp && enableAtSec > 0 && tSec >= enableAtSec) {
      comp.enable();
      enableAtSec = 0; // once
    }
    while (pending.length && pending[0].atSec <= tSec) {
      pending.shift().run(model, comp);
    }
    if (i % 10 === 0) {
      latencyTrace.push({
        at: Date.now(),
        latencyMs: (model.producedEdge(model.tSec()) - model.playhead) * 1000,
        bufferedAhead: model.bufferedAhead(),
      });
    }
  }

  if (comp) comp.disable?.();
  return {
    model,
    comp,
    stats,
    traces,
    latencyTrace,
    endMs: Date.now(),
    startMs,
    ...model.records,
  };
}

// ---- Churn / episode counters ----------------------------------------------

// A compensation episode starts when the played rate rises off 1.0.
export function engageEpisodes(rateWrites, afterMs = -Infinity) {
  return rateWrites.filter(
    (w) => w.at >= afterMs && w.from === 1.0 && w.to > 1.0
  ).length;
}

// Rising edges of inTimeout in the stats stream.
export function timeoutEdges(stats, afterMs = -Infinity) {
  let edges = 0;
  let prev = false;
  for (const s of stats) {
    if (s.at >= afterMs && s.inTimeout && !prev) edges++;
    prev = s.inTimeout;
  }
  return edges;
}

export function backwardSeeks(seeks) {
  return seeks.filter((s) => s.to < s.from - 1e-9);
}

// ---- Spec invariants (contract section "Invariants for every simulated
// scenario"). Tolerances: the model steps in 100ms quanta and rev 8 makes all
// non-emergency decisions on a MEAN-of-4-samples buffer, which may lag the
// raw instantaneous value by up to one segment of sawtooth; raw-value
// assertions therefore carry a one-segment allowance plus the hard >=2s
// critical bound.

export function assertInvariants(run, {
  segDur,
  offStalls = null, // stalls array from the identical compensator-less run
  band = null, // { lastSec } steady-state: latency in spec band, no churn
  maxEngageEpisodes = null,
  disableAtMs = null, // invariant 6: nothing may act after this time
}) {
  const eps = 1e-9;
  // Viewer-initiated scrubs (model.userSeek) are not the compensator's
  // actions; its safety invariants apply only to its own writes.
  const compSeeks = run.seeks.filter((s) => !s.user);

  // Invariant 1: never seeks backwards. Under no input whatsoever.
  for (const s of compSeeks) {
    assert.ok(
      s.to >= s.from - eps,
      `backward seek: ${s.from.toFixed(2)} -> ${s.to.toFixed(2)} at ${s.at}`
    );
  }

  // Invariant 2: rate within [1.0, 1.08]; ramps in <=0.005 steps. A direct
  // reset to exactly 1.0 is the spec'd emergency path ("on timeout/stall the
  // rate resets to 1.0 immediately") and is the one allowed large step.
  for (const w of run.rateWrites) {
    assert.ok(
      w.to >= 1.0 - eps && w.to <= 1.08 + eps,
      `rate out of [1.0, 1.08]: ${w.to} at ${w.at}`
    );
    assert.ok(
      Math.abs(w.to - w.from) <= 0.005 + eps || w.to === 1.0,
      `rate step ${w.from} -> ${w.to} exceeds 0.005 and is not a reset`
    );
  }

  // Invariant 3: no speed-up/jump initiated below the floor, and jumps land
  // keeping the floor. Speed initiation additionally requires the rev 4
  // entry margin of segDur/2 above the floor (on the smoothed buffer, hence
  // the sawtooth allowance on this raw sample). Rev 9: the floor in effect
  // is the one for the trust state the compensator reported when it acted.
  for (const w of run.rateWrites) {
    if (w.from === 1.0 && w.to > 1.0) {
      const f = specBufferFloor(segDur, trustedAt(run.stats, w.at));
      assert.ok(
        w.bufferedAhead >= Math.max(2, f - segDur / 2 - 0.25) - eps,
        `speed-up initiated with only ${w.bufferedAhead.toFixed(2)}s buffered ` +
          `(floor ${f}) at ${w.at}`
      );
    }
  }
  for (const s of compSeeks) {
    const f = specBufferFloor(segDur, trustedAt(run.stats, s.at));
    if (s.bufferedAfter > 0.5) {
      // decide()-driven jump: lands inside buffered content.
      assert.ok(
        s.bufferedBefore >= f - segDur - 0.25,
        `jump initiated with only ${s.bufferedBefore.toFixed(2)}s buffered at ${s.at}`
      );
      assert.ok(
        s.bufferedAfter >= Math.max(1.75, f - segDur - 0.25),
        `jump landed with only ${s.bufferedAfter.toFixed(2)}s buffered at ${s.at}`
      );
    } else {
      // Unpause/cold-start seek: must land floor+segDur behind the live
      // edge, never on it (old code's seekToLiveEdge landed at ~0).
      assert.ok(
        s.availableAheadAfter >= f - 0.25,
        `live-edge seek landed only ${s.availableAheadAfter.toFixed(2)}s ` +
          `behind the edge (floor ${f}) at ${s.at}`
      );
    }
  }

  // Invariant 4: zero added stalls vs the identical compensator-less run.
  if (offStalls !== null) {
    assert.ok(
      run.stalls.length <= offStalls.length,
      `compensator added stalls: ${run.stalls.length} ON vs ${offStalls.length} OFF`
    );
  }

  // Invariant 5 (rev 8): in steady state the resting point either sits
  // AT/INSIDE the effective band or cannot afford to start
  // (buf < floor + segDur/2) -- in both cases it is SILENT: no timeout
  // ping-pong, no new engage/stop transitions, and never below the base
  // minimum. The harness recomputes the compensator's smoothed buffer view
  // as the mean of 4 samples spaced 3s apart (phase differences covered by
  // the 0.25s slack).
  if (band) {
    const windowStart = run.endMs - band.lastSec * 1000;
    const trace = run.latencyTrace;
    const windowIdx = trace
      .map((s, i) => [s, i])
      .filter(([s, i]) => s.at >= windowStart && i >= 9);
    assert.ok(
      windowIdx.length >= 10,
      `expected steady samples in the last ${band.lastSec}s, got ${windowIdx.length}`
    );
    for (const [s, i] of windowIdx) {
      const smoothedBuf =
        (trace[i - 9].bufferedAhead +
          trace[i - 6].bufferedAhead +
          trace[i - 3].bufferedAhead +
          trace[i].bufferedAhead) /
        4;
      // Rev 9: the resting expectations follow the trust state the
      // compensator reported at that instant (trusted thins the floor and
      // lowers the base minimum).
      const trusted = trustedAt(run.stats, s.at);
      const f = specBufferFloor(segDur, trusted);
      const { min: baseMin } = specThresholds(segDur, null, trusted);
      const { max: effMax } = specEffectiveBand(
        segDur,
        null,
        s.latencyMs,
        smoothedBuf,
        trusted
      );
      const cannotAffordStart = smoothedBuf < f + segDur / 2 + 0.25;
      assert.ok(
        s.latencyMs <= effMax + 250 || cannotAffordStart,
        `resting state not silent-by-construction: latency ${Math.round(s.latencyMs)}ms ` +
          `above effective max ${Math.round(effMax)}ms with ${smoothedBuf.toFixed(2)}s ` +
          `smoothed buffer at ${s.at}`
      );
      assert.ok(
        s.latencyMs > baseMin - 250,
        `latency ${Math.round(s.latencyMs)}ms fell below the base minimum ${baseMin}ms at ${s.at}`
      );
    }
    for (const s of run.stats.filter((x) => x.at >= windowStart)) {
      assert.ok(!s.inTimeout, `timeout ping-pong: in timeout at ${s.at}`);
    }
    assert.strictEqual(
      engageEpisodes(run.rateWrites, run.endMs - 90_000),
      0,
      "engage/stop churn: new compensation episode during steady state"
    );
    assert.strictEqual(
      timeoutEdges(run.stats, run.endMs - 120_000),
      0,
      "timeout ping-pong during steady state"
    );
  }
  if (maxEngageEpisodes !== null) {
    const n = engageEpisodes(run.rateWrites);
    assert.ok(
      n <= maxEngageEpisodes,
      `engage/stop churn: ${n} compensation episodes (max ${maxEngageEpisodes})`
    );
  }

  // Rev 8: rendition pin/restore flips are bounded by the episodes that
  // caused them -- at most one pin and one restore per catch-up episode. A
  // flip is one pin or restore event (rep writes sharing a timestamp).
  if (run.comp) {
    const flipEvents = new Set(run.renditionWrites.map((w) => w.at)).size;
    const episodes = engageEpisodes(run.rateWrites);
    assert.ok(
      flipEvents <= 2 * episodes,
      `rendition churn: ${flipEvents} pin/restore flips for ${episodes} episodes`
    );
  }

  // Invariant 6: disable is terminal.
  if (disableAtMs !== null) {
    for (const w of run.rateWrites) {
      assert.ok(
        w.at <= disableAtMs || w.to === 1.0,
        `rate write ${w.to} after disable at ${w.at}`
      );
    }
    for (const s of compSeeks) {
      assert.ok(s.at <= disableAtMs, `seek after disable at ${s.at}`);
    }
    assert.strictEqual(run.model.rate, 1.0, "rate not exactly 1.0 after disable");
    assert.ok(
      run.model.allRenditionsEnabled(),
      "renditions not restored after disable"
    );
    const late = run.stats.filter((s) => s.at > disableAtMs + 3500);
    assert.strictEqual(
      late.length,
      0,
      `compensator still reporting stats after disable (${late.length} samples)`
    );
  }

  // Invariant 7: renditions restored whenever not actively compensating.
  for (const s of run.stats) {
    if (!s.running) {
      assert.ok(
        s.allRenditionsEnabled,
        `renditions pinned while not compensating at ${s.at}`
      );
    }
  }
  if (run.comp && !run.stats.at(-1)?.running) {
    assert.ok(run.model.allRenditionsEnabled(), "renditions pinned at scenario end");
  }



  // Harness sanity: the compensator swallowed no exceptions caused by us.
  assert.deepStrictEqual(
    run.traces,
    [],
    `compensator caught exceptions: ${run.traces[0]?.stack ?? ""}`
  );
}
