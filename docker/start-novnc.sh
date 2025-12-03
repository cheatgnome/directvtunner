#!/bin/bash
# Start noVNC proxies for multiple VNC servers (multi-tuner support)
# DVR_NUM_TUNERS controls how many noVNC proxies to start

NUM_TUNERS=${DVR_NUM_TUNERS:-1}
BASE_VNC_PORT=5901
BASE_NOVNC_PORT=6080

echo "Starting $NUM_TUNERS noVNC proxy(s)..."

# Wait for VNC servers to be ready
sleep 4

# Start noVNC proxy for each VNC server
for i in $(seq 0 $((NUM_TUNERS - 1))); do
    VNC_PORT=$((BASE_VNC_PORT + i))
    NOVNC_PORT=$((BASE_NOVNC_PORT + i))

    echo "Starting noVNC proxy: VNC port ${VNC_PORT} -> noVNC port ${NOVNC_PORT}"
    /opt/novnc/utils/novnc_proxy --vnc localhost:${VNC_PORT} --listen ${NOVNC_PORT} &
done

echo "All $NUM_TUNERS noVNC proxy(s) started"

# Wait for all background processes
wait
