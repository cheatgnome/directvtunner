#!/bin/bash
# Start x11vnc for multiple displays (multi-tuner support)
# DVR_NUM_TUNERS controls how many VNC servers to start

NUM_TUNERS=${DVR_NUM_TUNERS:-1}
BASE_VNC_PORT=5901

echo "Starting $NUM_TUNERS VNC server(s)..."

# Wait for Xvfb to be ready
sleep 2

# Start VNC server for each display
for i in $(seq 0 $((NUM_TUNERS - 1))); do
    DISPLAY_NUM=$((i + 1))
    VNC_PORT=$((BASE_VNC_PORT + i))

    echo "Starting x11vnc for display :${DISPLAY_NUM} on port ${VNC_PORT}"
    x11vnc -display :${DISPLAY_NUM} -forever -shared -rfbport ${VNC_PORT} -nopw &
done

echo "All $NUM_TUNERS VNC server(s) started"

# Wait for all background processes
wait
