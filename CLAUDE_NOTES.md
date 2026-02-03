# DVR Player Project Notes

## Project Overview
DirecTV IPTV Proxy Server that captures live TV streams via Chrome browser automation and serves them as MPEG-TS streams to IPTV clients like TiviMate.

## Repositories
- **GitHub:** https://github.com/jorge123255/directvtunner.git
- **Docker Hub:** `sunnyside1/directvtunner:latest`

## Server Access
- SSH connection configured as 'default' in MCP SSH server
- Docker container name: `dvr-tuner1`

## Current Stream Configuration (as of 2025-11-27)
- **Encoding:** libx264 with CRF 23 (quality-based)
- **Video bitrate:** 8Mbps target, 10Mbps max burst
- **Audio:** 192k AAC at 48kHz stereo
- **Resolution:** Configured in config.js
- **Keyframes:** Every 2 seconds (GOP 60 at 30fps)
- **B-frames:** Enabled (2 B-frames, adaptive placement)
- **Profile:** H.264 High, Level 4.1
- **Output:** Direct MPEG-TS pipe to HTTP clients

## Key Files
- `docker/app/ffmpeg-capture.js` - FFmpeg capture with auto-restart and stats
- `docker/app/stream-proxy.js` - Express server with /stats endpoint
- `docker/app/tuner.js` - Tuner management, includes stream stats in getStatus()
- `docker/app/tuner-manager.js` - Multi-tuner coordination
- `docker/supervisord.conf` - Process management (xvfb, pulseaudio, chrome, dvr, etc.)

## Endpoints
- `/playlist.m3u` - M3U playlist for IPTV clients
- `/stream/:channelId` - MPEG-TS stream endpoint
- `/stats` - Stream health statistics (uptime, bitrate, errors, restarts)
- `/tuners` - Tuner status
- `/health` - Health check

## Features Implemented
1. MPEG-TS direct streaming (replaced HLS for TiviMate compatibility)
2. CRF-based encoding with bitrate ceiling
3. B-frames for better compression
4. 192k audio quality
5. Auto-restart on FFmpeg crash (max 5 attempts)
6. Stream health monitoring (/stats endpoint)
7. Cursor hiding with unclutter
8. Multi-client support (broadcast to multiple viewers)

## Future Improvements (Intel Hardware Acceleration)
When moving to Intel laptop with Docker:

```javascript
// VAAPI hardware encoding args for Intel Quick Sync
args = [
  '-vaapi_device', '/dev/dri/renderD128',
  '-f', 'x11grab',
  '-framerate', '30',
  '-video_size', `${config.resolution.width}x${config.resolution.height}`,
  '-i', `:${displayNum}`,
  '-vf', 'format=nv12,hwupload',
  '-c:v', 'h264_vaapi',
  '-qp', '23',  // Quality parameter for VAAPI
  '-b:v', '8M',
  '-maxrate', '10M',
  '-g', '60',
  // ... audio args same as before
  '-f', 'mpegts',
  'pipe:1',
];
```

Docker run command for VAAPI:
```bash
docker run --device /dev/dri:/dev/dri ...
```

## Dockerfile Changes Needed for VAAPI
```dockerfile
RUN apt-get install -y \
    vainfo \
    intel-media-va-driver-non-free \
    libva-drm2 \
    libva2
```

## Troubleshooting
- If stream drops, check `/stats` endpoint for error count and restarts
- Supervisor logs in container: `/var/log/supervisor/`
- Restart DVR service: `pkill -f "node stream-proxy.js"` (supervisor auto-restarts)

