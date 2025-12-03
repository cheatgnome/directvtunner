#!/bin/bash
# Start Xvfb virtual displays for multi-tuner support
# DVR_NUM_TUNERS controls how many displays to create (default: 1)

NUM_TUNERS=${DVR_NUM_TUNERS:-1}
echo "Starting $NUM_TUNERS Xvfb display(s)..."

# Clean up any stale lock files
for i in $(seq 1 $NUM_TUNERS); do
    rm -f /tmp/.X${i}-lock
done

# Start displays :1, :2, :3... based on NUM_TUNERS
for i in $(seq 1 $NUM_TUNERS); do
    echo "Starting Xvfb display :${i}"
    Xvfb :${i} -screen 0 1920x1080x24 &
done

echo "All $NUM_TUNERS Xvfb display(s) started"

# Wait for all background processes
wait
