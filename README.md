# DirecTV Stream Tuner

A Docker-based IPTV proxy that turns DirecTV Stream into an M3U playlist compatible with apps like TvMate, VLC, and other IPTV players.

## Features

### DirecTV Live TV
- **Tuner Architecture**: Simulates traditional TV tuners - one Chrome instance per tuner
- **HLS Streaming**: Captures DirecTV video via FFmpeg and serves as HLS streams
- **M3U Playlist**: Generates M3U playlists compatible with IPTV apps
- **Auto Channel Switching**: Automatically switches channels when requested
- **Smart Video Detection**: Waits for video to be ready before starting capture
- **noVNC Access**: Built-in VNC viewer to see what Chrome is doing
- **348 Channels**: Extensive channel list with smart matching
- **EPG (Electronic Program Guide)**: Full XMLTV EPG with 830+ channels
- **Auto-refresh EPG**: Automatically updates every 4 hours

---

## Docker Hub

```bash
# CPU-only (default)
docker pull sunnyside1/directvtuner:latest

# NVIDIA GPU accelerated
docker pull sunnyside1/directvtuner:nvidia

# Intel QSV accelerated (coming soon)
docker pull sunnyside1/directvtuner:intel
```

### Image Tags

| Tag | Description | Hardware |
|-----|-------------|----------|
| `latest` | CPU-only encoding (libx264) | Any |
| `nvidia` | NVIDIA NVENC hardware encoding | NVIDIA GPU (GTX 600+) |
| `intel` | Intel QuickSync encoding (coming soon) | Intel CPU with iGPU |

---

## Quick Start

```bash
docker run -d \
  --name dvr-tuner \
  -p 7070:7070 \
  -p 6080:6080 \
  -p 9222:9222 \
  -v ./chrome-profile:/data/chrome-profile \
  sunnyside1/directvtuner:latest
```

---

## Network Configuration

This container works with different Docker networking modes. Choose the one that fits your setup:

### Option 1: Bridge Network (Simplest - Recommended for Most Users)

Standard Docker networking with port mapping. Works everywhere.

```yaml
version: '3.8'
services:
  dvr-tuner1:
    image: sunnyside1/directvtuner:latest
    container_name: dvr-tuner1
    ports:
      - "7070:7070"   # IPTV API
      - "6080:6080"   # noVNC web viewer
      - "5900:5900"   # VNC
      - "9222:9222"   # Chrome debugging
    volumes:
      - ./chrome-profile:/data/chrome-profile
      - ./streams:/data/streams
    restart: unless-stopped
```

**Access URLs:**
- Playlist: `http://YOUR_HOST_IP:7070/playlist.m3u`
- noVNC: `http://YOUR_HOST_IP:6080`

---

### Option 2: Host Network (Simple, No Port Conflicts)

Container shares the host's network stack directly.

```yaml
version: '3.8'
services:
  dvr-tuner1:
    image: sunnyside1/directvtuner:latest
    container_name: dvr-tuner1
    network_mode: host
    volumes:
      - ./chrome-profile:/data/chrome-profile
      - ./streams:/data/streams
    restart: unless-stopped
```

**Access URLs:**
- Playlist: `http://YOUR_HOST_IP:7070/playlist.m3u`
- noVNC: `http://YOUR_HOST_IP:6080`

**Note:** All ports are exposed directly on the host. Make sure ports 7070, 6080, 5900, 9222 are not in use.

---

### Option 3: Macvlan Network (Container Gets Its Own IP)

Container gets a dedicated IP on your LAN - appears as a separate device. Best for Unraid and advanced setups.

**Step 1: Create macvlan network (one-time setup)**

```bash
# Adjust these for your network:
# - parent: your network interface (eth0, br0, bond0, etc.)
# - subnet: your LAN subnet
# - gateway: your router IP
# - ip-range: range of IPs for containers

docker network create -d macvlan \
  --subnet=192.168.1.0/24 \
  --gateway=192.168.1.1 \
  --ip-range=192.168.1.90/29 \
  -o parent=eth0 \
  macvlan_net
```

**Step 2: Docker Compose**

```yaml
version: '3.8'
services:
  dvr-tuner1:
    image: sunnyside1/directvtuner:latest
    container_name: dvr-tuner1
    networks:
      macvlan_net:
        ipv4_address: 192.168.1.92  # Pick an IP in your range
    volumes:
      - ./chrome-profile:/data/chrome-profile
      - ./streams:/data/streams
    restart: unless-stopped

networks:
  macvlan_net:
    external: true
```

**Access URLs:**
- Playlist: `http://192.168.1.92:7070/playlist.m3u`
- noVNC: `http://192.168.1.92:6080`

**Note:** With macvlan, the container has its own IP but cannot communicate with the Docker host directly. Use a macvlan shim interface if you need host-to-container communication.

---

## GPU Acceleration (NVIDIA)

For significantly better performance and lower CPU usage, use the NVIDIA GPU-accelerated image.

### Requirements

1. **NVIDIA GPU** with NVENC support (GTX 600 series or newer)
2. **NVIDIA drivers** installed on the host
3. **nvidia-container-toolkit** installed

### Install nvidia-container-toolkit

```bash
# Ubuntu/Debian
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
  sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
  sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt-get update
sudo apt-get install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

### Docker Compose with NVIDIA GPU

```yaml
version: '3.8'
services:
  dvr-tuner-nvidia:
    image: sunnyside1/directvtuner:nvidia
    container_name: dvr-tuner-nvidia
    runtime: nvidia
    environment:
      - NVIDIA_VISIBLE_DEVICES=all
      - NVIDIA_DRIVER_CAPABILITIES=video,compute,utility
    ports:
      - "7070:7070"
      - "6080:6080"
      - "5900:5900"
      - "9222:9222"
    volumes:
      - ./chrome-profile:/data/chrome-profile
      - ./streams:/data/streams
    restart: unless-stopped
```

### Docker Run with NVIDIA GPU

```bash
docker run -d \
  --name dvr-tuner-nvidia \
  --runtime=nvidia \
  -e NVIDIA_VISIBLE_DEVICES=all \
  -e NVIDIA_DRIVER_CAPABILITIES=video,compute,utility \
  -p 7070:7070 \
  -p 6080:6080 \
  -p 9222:9222 \
  -v ./chrome-profile:/data/chrome-profile \
  sunnyside1/directvtuner:nvidia
```

### NVENC Settings (Environment Variables)

| Variable | Default | Description |
|----------|---------|-------------|
| `DVR_NVENC_PRESET` | `p4` | Encoding preset: p1 (fastest) to p7 (best quality) |
| `DVR_NVENC_TUNE` | `ll` | Tuning: `ll` (low latency), `ull` (ultra low latency), `hq` (high quality) |
| `DVR_NVENC_RC` | `vbr` | Rate control: `vbr`, `cbr`, `cq` |
| `DVR_NVENC_BFRAMES` | `0` | B-frames (0 for lowest latency) |

### GPU Monitoring

The web GUI (Status tab) shows real-time GPU stats:
- GPU Name & Driver Version
- GPU Utilization %
- Encoder Utilization %
- VRAM Usage
- Temperature
- Power Draw
- Active Encoder Sessions

### Performance Comparison

| Metric | CPU (libx264) | GPU (NVENC) |
|--------|---------------|-------------|
| CPU Usage | 80-100% | 5-15% |
| Encoding Speed | ~1x realtime | ~5-10x realtime |
| Latency | Higher | Lower |
| Quality at bitrate | Slightly better | Good |

---

## First-Time Setup

1. Start the container using one of the network configurations above
2. Access noVNC at `http://<IP>:6080`
3. Log into DirecTV Stream in the Chrome browser with **your own credentials**
4. The login session will be saved in the `chrome-profile` volume for future use

**Important:** The Docker image does NOT include any DirecTV credentials. Each user must log in with their own DirecTV Stream subscription.

---

## API Endpoints

### DirecTV Live TV

| Endpoint | Description |
|----------|-------------|
| `GET /playlist.m3u` | M3U playlist for IPTV apps |
| `GET /stream/:channelId` | Stream a specific channel |
| `GET /channels` | List all available channels |
| `GET /tuners` | Check tuner status |
| `GET /health` | Health check |

### DirecTV EPG

| Endpoint | Description |
|----------|-------------|
| `GET /tve/directv/epg.xml` | XMLTV EPG data |
| `GET /tve/directv/playlist.m3u` | M3U with EPG tvg-id mapping |
| `GET /tve/directv/channels` | List channels from EPG |
| `GET /tve/directv/epg/status` | EPG refresh status |
| `POST /tve/directv/epg/refresh` | Manual EPG refresh |

---

## Usage

### Add to TvMate / IPTV Apps

**For Live TV with EPG:**
```
Playlist: http://<SERVER_IP>:7070/tve/directv/playlist.m3u
EPG URL:  http://<SERVER_IP>:7070/tve/directv/epg.xml
```

### Direct Stream

Open a specific channel:
```
http://<SERVER_IP>:7070/stream/cnn
http://<SERVER_IP>:7070/stream/espn
```

---

## Auto-Refresh Schedule

| Service | Interval | Description |
|---------|----------|-------------|
| DirecTV EPG | 4 hours | Updates channel guide (830+ channels) |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Docker Container                          │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │
│  │   Xvfb   │  │  Chrome  │  │  FFmpeg  │  │  Node.js │    │
│  │ (Display)│  │ (Browser)│  │(Capture) │  │ (Server) │    │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘    │
│        │            │             │             │           │
│        └────────────┴─────────────┴─────────────┘           │
│                           │                                  │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              Stream Proxy (port 7070)                │    │
│  ├─────────────────────────────────────────────────────┤    │
│  │  • DirecTV Live Streams                             │    │
│  │  • EPG Service (auto-refresh every 4 hours)         │    │
│  │  • HLS Proxy with header injection                  │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                            │
                     HLS Stream Output
                            │
              ┌─────────────┴─────────────┐
              │                           │
         ┌────┴────┐               ┌──────┴──────┐
         │  VLC    │               │  TvMate     │
         └─────────┘               └─────────────┘
```

---

## Files Structure

```
/app
├── stream-proxy.js          # Main server
├── directv-epg.js           # EPG service with auto-refresh
├── tuner-manager.js         # DirecTV tuner management
├── channels.js              # Channel definitions
└── data/
    └── epg-cache.json           # EPG cache
```

---

## Configuration

Edit `app/config.js` to customize:

- `numTuners`: Number of simultaneous streams (default: 1)
- `port`: HTTP server port (default: 7070)
- `resolution`: Video resolution (default: 1280x720)
- `videoBitrate`: Video bitrate (default: 3M)

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TUNER_HOST` | `localhost:7070` | Host for stream URLs in M3U |
| `DATA_DIR` | `/app/data` | Data directory for databases |
| `CHROME_DEBUG_PORT` | `9222` | Chrome DevTools Protocol port |

---

## Adding Channels

Edit `app/channels.js` to add/modify channels:

```javascript
{
  id: 'cnn',
  name: 'CNN',
  number: 202,
  category: 'News',
  searchTerms: ['cnn', 'cable news network']
}
```

---

## Troubleshooting

### Container won't start
- Check if ports are already in use: `netstat -tulpn | grep 7070`
- Try host network mode to avoid port conflicts

### Can't access from other devices
- Bridge mode: Make sure you're using the host's IP, not `localhost`
- Macvlan: Container has its own IP - use that IP directly
- Check firewall rules on the host

### Stream not playing
- Access noVNC to verify Chrome is logged into DirecTV
- Check `/health` endpoint for status
- Look at container logs: `docker logs dvr-tuner1`

### High latency
- Reduce VLC network caching to 500ms
- Current FFmpeg settings use 1-second HLS segments (already optimized)

---

## ☕ Support

If you find this project useful and want to support its development, consider buying me a coffee!

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-ffdd00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/gszulc)

Your support helps me:
- Dedicate more time to adding new features
- Fix bugs quickly
- Maintain documentation
- Keep the project alive long-term

Thank you! 🙏

---

## License

MIT License
