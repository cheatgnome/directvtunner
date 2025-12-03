#!/bin/bash
# Start PulseAudio in system mode for capturing Chrome audio
# Creates separate virtual sinks for each tuner

NUM_TUNERS=${DVR_NUM_TUNERS:-1}

# Clean up any stale PulseAudio files
rm -rf /tmp/pulse-* /run/pulse 2>/dev/null

# Create runtime directory
mkdir -p /run/pulse
chmod 755 /run/pulse

echo "Starting PulseAudio with $NUM_TUNERS virtual sinks..."

# Start PulseAudio first with basic config
pulseaudio \
    --system \
    --disallow-exit \
    --disallow-module-loading=0 \
    --load="module-native-protocol-unix auth-anonymous=1" \
    --log-level=notice &

# Wait for PulseAudio to start
sleep 2

# Load virtual sinks for each tuner using pactl
for i in $(seq 0 $((NUM_TUNERS - 1))); do
    echo "Creating virtual_speaker_${i}..."
    pactl load-module module-null-sink sink_name=virtual_speaker_${i} sink_properties=device.description=VirtualSpeaker${i}
done

# Also create the legacy single sink for backwards compatibility
echo "Creating virtual_speaker (legacy)..."
pactl load-module module-null-sink sink_name=virtual_speaker sink_properties=device.description=VirtualSpeaker

echo "PulseAudio ready with $NUM_TUNERS virtual sinks"

# Keep the script running
wait
