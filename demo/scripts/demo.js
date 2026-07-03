import LatencyCompensator from "./latencyCompensator.js";

var decisionStat = document.querySelector(".decision-stat");
var isRunningStat = document.querySelector(".latency-compensator-running");
var currentRateStat = document.querySelector(".current-rate-stat");
var currentLatencyStat = document.querySelector(".current-latency-stat");
var latencyMinMaxStat = document.querySelector(".latency-min-max");
var bufferFloorStat = document.querySelector(".buffer-floor-stat");
var bandwidthRatioStat = document.querySelector(".bandwidth-ratio-stat");
var stableChecksStat = document.querySelector(".stable-checks-stat");
var bufferingEventsStat = document.querySelector(".buffering-events-stat");
var inTimeoutStat = document.querySelector(".in-timeout-stat");
var timeoutRemainingStat = document.querySelector(".timeout-remaining-stat");
var decisionLog = document.querySelector(".decision-log");

var lastLoggedDecision = null;
var DECISION_LOG_LIMIT = 8;

function describeAction(action) {
  if (!action) {
    return "-";
  }
  var head = action.type;
  if (action.type === "speed" && action.rate) {
    head += " " + action.rate.toFixed(3) + "x";
  }
  if (action.type === "jump" && action.aheadSec) {
    head += " +" + action.aheadSec.toFixed(1) + "s";
  }
  return head + (action.reason ? " (" + action.reason + ")" : "");
}

// Append to the log only when the KIND of decision changes (type + reason).
// Rate micro-adjustments during a taper are the same decision and would
// turn the log into a 3-second firehose.
function logDecision(action) {
  if (!action) {
    return;
  }
  var key = action.type + "|" + (action.reason || "");
  if (key === lastLoggedDecision) {
    return;
  }
  lastLoggedDecision = key;

  var item = document.createElement("li");
  var time = new Date().toLocaleTimeString();
  item.textContent = time + "  " + describeAction(action);
  decisionLog.prepend(item);
  while (decisionLog.children.length > DECISION_LOG_LIMIT) {
    decisionLog.removeChild(decisionLog.lastChild);
  }
}

/* ---- Latency & buffer chart ----------------------------------------- */

var CHART_WINDOW_MS = 5 * 60 * 1000;
var chartCanvas = document.querySelector(".latency-chart");
var chartSamples = []; // { t, lat, buf, min, max, floor, running }
var chartEvents = []; // { t, type: "stall" | "seek" }

function playableBufferOf(player) {
  try {
    var buffered = player.buffered();
    var ct = player.currentTime();
    for (var i = 0; i < buffered.length; i++) {
      if (ct >= buffered.start(i) - 0.5 && ct <= buffered.end(i)) {
        return buffered.end(i) - ct;
      }
    }
  } catch (e) {
    /* not ready yet */
  }
  return null;
}

function trimChart() {
  var cutoff = Date.now() - CHART_WINDOW_MS;
  while (chartSamples.length && chartSamples[0].t < cutoff) chartSamples.shift();
  while (chartEvents.length && chartEvents[0].t < cutoff) chartEvents.shift();
}

function drawChart() {
  if (!chartCanvas) {
    return;
  }
  var dpr = window.devicePixelRatio || 1;
  var cssW = chartCanvas.clientWidth || 600;
  var cssH = chartCanvas.clientHeight || 220;
  if (chartCanvas.width !== cssW * dpr || chartCanvas.height !== cssH * dpr) {
    chartCanvas.width = cssW * dpr;
    chartCanvas.height = cssH * dpr;
  }
  var ctx = chartCanvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  var padL = 34;
  var padB = 16;
  var padT = 4;
  var w = cssW - padL - 4;
  var h = cssH - padT - padB;
  var now = Date.now();
  var t0 = now - CHART_WINDOW_MS;

  // y scale: seconds, headroom above the largest visible value
  var yMax = 12;
  for (var i = 0; i < chartSamples.length; i++) {
    var s = chartSamples[i];
    yMax = Math.max(yMax, s.lat || 0, s.buf || 0, s.max || 0);
  }
  yMax *= 1.15;

  var x = function (t) {
    return padL + ((t - t0) / CHART_WINDOW_MS) * w;
  };
  var y = function (sec) {
    return padT + h - (sec / yMax) * h;
  };

  // grid + axis labels
  ctx.font = "10px sans-serif";
  ctx.fillStyle = "#888";
  ctx.strokeStyle = "#eee";
  ctx.lineWidth = 1;
  var step = yMax > 30 ? 10 : 5;
  for (var g = 0; g <= yMax; g += step) {
    ctx.beginPath();
    ctx.moveTo(padL, y(g));
    ctx.lineTo(padL + w, y(g));
    ctx.stroke();
    ctx.fillText(g + "s", 2, y(g) + 3);
  }
  for (var m = 1; m < 5; m++) {
    var tx = x(now - m * 60 * 1000);
    ctx.fillText("-" + m + "m", tx - 8, cssH - 4);
  }

  if (chartSamples.length < 2) {
    return;
  }

  // speed-up periods (running) as a translucent backdrop
  ctx.fillStyle = "rgba(255, 193, 7, 0.15)";
  var runStart = null;
  for (var r = 0; r < chartSamples.length; r++) {
    var running = chartSamples[r].running;
    if (running && runStart === null) {
      runStart = chartSamples[r].t;
    }
    if ((!running || r === chartSamples.length - 1) && runStart !== null) {
      ctx.fillRect(x(runStart), padT, Math.max(x(chartSamples[r].t) - x(runStart), 1), h);
      runStart = null;
    }
  }

  // target band (between min and max) where reported
  ctx.fillStyle = "rgba(13, 110, 253, 0.12)";
  ctx.beginPath();
  var started = false;
  for (var a = 0; a < chartSamples.length; a++) {
    var sa = chartSamples[a];
    if (!sa.min || !sa.max) continue;
    if (!started) {
      ctx.moveTo(x(sa.t), y(sa.max));
      started = true;
    } else {
      ctx.lineTo(x(sa.t), y(sa.max));
    }
  }
  for (var b = chartSamples.length - 1; b >= 0; b--) {
    var sb = chartSamples[b];
    if (!sb.min || !sb.max) continue;
    ctx.lineTo(x(sb.t), y(sb.min));
  }
  if (started) {
    ctx.closePath();
    ctx.fill();
  }

  function drawSeries(key, color, width, dashed) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dashed ? [4, 3] : []);
    ctx.beginPath();
    var pen = false;
    for (var i = 0; i < chartSamples.length; i++) {
      var v = chartSamples[i][key];
      if (v == null) {
        pen = false;
        continue;
      }
      if (!pen) {
        ctx.moveTo(x(chartSamples[i].t), y(v));
        pen = true;
      } else {
        ctx.lineTo(x(chartSamples[i].t), y(v));
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  drawSeries("floor", "#fd7e14", 1, true);
  drawSeries("buf", "#198754", 1.5, false);
  drawSeries("lat", "#0d6efd", 2, false);

  // events
  for (var e = 0; e < chartEvents.length; e++) {
    var ev = chartEvents[e];
    if (ev.type === "seek") {
      ctx.strokeStyle = "rgba(111, 66, 193, 0.7)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x(ev.t), padT);
      ctx.lineTo(x(ev.t), padT + h);
      ctx.stroke();
    } else {
      ctx.fillStyle = "#dc3545";
      ctx.beginPath();
      ctx.arc(x(ev.t), y(0) - 3, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/* ---------------------------------------------------------------------- */

window.startDemo(function (player) {
  console.log("Enabling latency compensator...");
  window.latencyCompensator = new LatencyCompensator(player);

  var lastStats = null;

  window.latencyCompensator.onStats = (stats) => {
    lastStats = stats;
    var {
      latency,
      running,
      inTimeout,
      maxStartingLatency,
      minEndingLatency,
      bufferingEvents,
      timeoutRemaining,
      playbackRate,
      targetRate,
      playableBufferSeconds,
      bufferFloorSeconds,
      averageBandwidthRatio,
      consecutiveStableChecks,
      action,
    } = stats;

    decisionStat.textContent = describeAction(action);
    logDecision(action);

    isRunningStat.textContent = running ? "True" : "False";
    currentRateStat.textContent =
      playbackRate.toFixed(3) + "x \u2192 " + (targetRate || 1).toFixed(3) + "x";
    currentLatencyStat.textContent =
      latency != null ? (latency / 1000).toFixed(2) + "s" : "-";
    bufferingEventsStat.textContent = bufferingEvents;
    inTimeoutStat.firstChild.textContent = inTimeout ? "True (" : "False (";
    timeoutRemainingStat.textContent =
      Math.max(Math.round(timeoutRemaining / 1000), 0) + "s";

    bufferFloorStat.textContent =
      playableBufferSeconds != null
        ? playableBufferSeconds.toFixed(1) +
          "s / " +
          bufferFloorSeconds.toFixed(1) +
          "s" +
          (stats.trusted ? " (trusted)" : "")
        : "-";

    bandwidthRatioStat.textContent =
      averageBandwidthRatio != null
        ? (averageBandwidthRatio > 99
            ? "99+"
            : averageBandwidthRatio.toFixed(1)) + "\u00d7 realtime"
        : "measuring\u2026";

    stableChecksStat.textContent = consecutiveStableChecks;

    if (maxStartingLatency !== 0 && minEndingLatency !== 0) {
      latencyMinMaxStat.textContent =
        (minEndingLatency / 1000).toFixed(1) +
        "s \u2194 " +
        (maxStartingLatency / 1000).toFixed(1) +
        "s";
    } else {
      latencyMinMaxStat.textContent = "-";
    }
  };

  // Chart events: genuine stalls (seeking() false) and every seek.
  player.on("waiting", function () {
    if (!player.seeking()) {
      chartEvents.push({ t: Date.now(), type: "stall" });
    }
  });
  player.on("seeking", function () {
    chartEvents.push({ t: Date.now(), type: "seek" });
  });

  // 1s sampler: buffer read live from the player (shows the real sawtooth
  // the compensator smooths), latency/band/floor from the latest stats.
  setInterval(function () {
    chartSamples.push({
      t: Date.now(),
      buf: playableBufferOf(player),
      lat: lastStats && lastStats.latency != null ? lastStats.latency / 1000 : null,
      min:
        lastStats && lastStats.minEndingLatency
          ? lastStats.minEndingLatency / 1000
          : null,
      max:
        lastStats && lastStats.maxStartingLatency
          ? lastStats.maxStartingLatency / 1000
          : null,
      floor: lastStats ? lastStats.bufferFloorSeconds : null,
      running: !!(lastStats && lastStats.running),
    });
    trimChart();
    drawChart();
  }, 1000);

  window.latencyCompensator.enable();
});
