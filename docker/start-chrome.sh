#!/bin/bash
# Start Chrome instances for multi-tuner support
# DVR_NUM_TUNERS controls how many Chrome instances to start (default: 1)
# Each instance gets its own display, debug port, profile, and audio sink

NUM_TUNERS=${DVR_NUM_TUNERS:-1}
BASE_DEBUG_PORT=${CHROME_DEBUG_PORT:-9222}

echo "Starting $NUM_TUNERS Chrome instance(s)..."

# Wait for Xvfb and PulseAudio to be ready
sleep 5

# Start Chrome instances - each with its own audio sink
for i in $(seq 0 $((NUM_TUNERS - 1))); do
    DISPLAY_NUM=$((i + 1))
    DEBUG_PORT=$((BASE_DEBUG_PORT + i))
    PROFILE_DIR="/data/chrome-profile-${i}"
    AUDIO_SINK="virtual_speaker_${i}"

    # Create profile directory if it doesn't exist
    mkdir -p "$PROFILE_DIR"

    # Clean up stale Chrome lock files
    rm -f "$PROFILE_DIR/SingletonLock" \
          "$PROFILE_DIR/SingletonCookie" \
          "$PROFILE_DIR/SingletonSocket" 2>/dev/null

    echo "Starting Chrome instance $i on display :${DISPLAY_NUM}, port ${DEBUG_PORT}, audio sink ${AUDIO_SINK}"

    # Each Chrome instance gets its own PULSE_SINK for isolated audio
    DISPLAY=:${DISPLAY_NUM} \
    PULSE_SERVER=unix:/run/pulse/native \
    PULSE_SINK=${AUDIO_SINK} \
    google-chrome-stable \
        --remote-debugging-port=${DEBUG_PORT} \
        --remote-debugging-address=0.0.0.0 \
        --user-data-dir=${PROFILE_DIR} \
        --no-first-run \
        --no-default-browser-check \
        --disable-background-networking \
        --disable-sync \
        --disable-translate \
        --disable-gpu \
        --window-size=1920,1080 \
        --window-position=0,0 \
        --kiosk \
        --autoplay-policy=no-user-gesture-required \
        --disable-dev-shm-usage \
        --no-sandbox \
        --alsa-output-device=pulse \
        "https://stream.directv.com" &
done

echo "All $NUM_TUNERS Chrome instance(s) started"

# Wait for all background processes
wait
