#!/bin/bash
# Wait for Chrome to be ready
sleep 10

cd /app
export DISPLAY=:1
# Use container's DVR_NUM_TUNERS env var, default to 1
export DVR_NUM_TUNERS=${DVR_NUM_TUNERS:-1}
export DVR_HLS_DIR=/data/streams

export NODE_OPTIONS="--max-old-space-size=2048"
exec node stream-proxy.js
