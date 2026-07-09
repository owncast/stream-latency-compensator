/*
Regression: getCurrentlyPlayingSegment used to fall back to
playlist.segments[0] (the OLDEST segment) when no segment matched the
playhead -- segment.end is undefined for un-buffered segments, or the
playhead sits past every tracked end right after a seek/jump. That phantom
sample inflated the latency estimate by up to a whole playlist window, and
a run of them flips the 5-sample median into phantom catch-up decisions.
It must instead report no segment, so check() skips the sample entirely.
*/

import { test } from "node:test";
import assert from "node:assert";
import LatencyCompensator from "../latencyCompensator.js";
import { FakeLivePlayer } from "./fake-player.js";

test("regression: playhead matching no segment reports idle and produces no latency sample", (t) => {
  t.mock.timers.enable({
    apis: ["setInterval", "setTimeout", "Date"],
    now: 1_000_000_000_000,
  });
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "log", () => {});

  const model = new FakeLivePlayer({
    segDur: 2,
    initialLatencySec: 8,
    initialBufferSec: 6,
  });
  const comp = new LatencyCompensator(model);
  comp.setClockSkew(0);
  const stats = [];
  comp.onStats = (s) => stats.push(s);

  // Force the no-match condition the bug keyed on: every segment's `end`
  // is undefined (VHS bookkeeping for segments it hasn't buffered), while
  // valid program-date-time stamps stay present.
  const tech = model.tech({ IWillNotUseThisInPlugins: true });
  const realMedia = tech.vhs.playlists.media;
  tech.vhs.playlists.media = () => {
    const playlist = realMedia();
    playlist.segments = playlist.segments.map((s) => ({
      ...s,
      end: undefined,
    }));
    return playlist;
  };

  // Get past the startup grace period, then drive exactly one check tick.
  t.mock.timers.tick(21_000);
  model.advanceTo(Date.now());
  comp.enable();
  comp.check();

  assert.strictEqual(stats.length, 1, "one check must emit one stats sample");
  assert.strictEqual(stats[0].action.type, "idle");
  assert.strictEqual(
    stats[0].action.reason,
    "no segment timing (stream lacks program-date-time?)",
    "the check must be skipped for lack of segment timing, not decided on a phantom segments[0] sample"
  );
  assert.strictEqual(
    stats[0].latency,
    null,
    "no latency sample may be produced when no segment matches the playhead"
  );

  comp.disable();
});
