#!/usr/bin/env bash
# Local live HLS test source for the demo page — no Owncast server needed.
# Generates a real sliding-window live stream into demo/local-hls/ with
# wall-clock time and pts burned into the video so latency is eyeball-able.
#
# Usage:  bash local-stream.sh   (or: npm run stream)
# Serve the demo dir (npm start), then play:
#   http://localhost:8080/local-hls/stream.m3u8
#
# SEGMENT_DURATION: HLS segment length in seconds. Default 2; Owncast's
# default segment duration is 4, so set SEGMENT_DURATION=4 to mimic it.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$DIR/local-hls"
SEGMENT_DURATION="${SEGMENT_DURATION:-2}"
HLS_LIST_SIZE="${HLS_LIST_SIZE:-6}"
FPS=30

rm -rf "$OUT"
mkdir -p "$OUT"

echo "Playback URL: http://localhost:8080/local-hls/master.m3u8"
echo "Stop with Ctrl-C."

exec ffmpeg -hide_banner -loglevel warning \
  -re -f lavfi -i "testsrc2=size=1280x720:rate=${FPS}" \
  -re -f lavfi -i "sine=frequency=440:sample_rate=44100" \
  -vf "drawtext=text='%{localtime\:%T}  pts %{pts\:hms}':fontsize=48:fontcolor=white:box=1:boxcolor=black@0.6:x=(w-text_w)/2:y=h-text_h-40" \
  -c:v libx264 -preset veryfast -tune zerolatency -pix_fmt yuv420p \
  -g $((SEGMENT_DURATION * FPS)) -keyint_min $((SEGMENT_DURATION * FPS)) -sc_threshold 0 \
  -c:a aac -b:a 128k \
  -f hls -hls_time "$SEGMENT_DURATION" -hls_list_size "$HLS_LIST_SIZE" \
  -hls_flags delete_segments+program_date_time+independent_segments \
  -master_pl_name master.m3u8 \
  "$OUT/stream.m3u8"
