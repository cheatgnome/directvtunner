#!/bin/bash
# Start unclutter on all displays to hide the mouse cursor
# DVR_NUM_TUNERS controls how many displays we have (default: 1)

NUM_TUNERS=${DVR_NUM_TUNERS:-1}
echo "Starting unclutter on $NUM_TUNERS display(s)..."

# Wait for Xvfb displays to be ready
sleep 2

# Start unclutter on each display (:1, :2, :3...)
for i in $(seq 1 $NUM_TUNERS); do
    echo "Starting unclutter on display :${i}"
    DISPLAY=:${i} unclutter -idle 0.1 -root &
done

echo "Unclutter started on all $NUM_TUNERS display(s)"

# Wait for all background processes
wait
