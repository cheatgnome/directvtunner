/**
 * GPU Monitor - Detects and monitors NVIDIA GPUs
 * Used for hardware acceleration status and monitoring
 */

const { exec, execSync } = require('child_process');
const config = require('./config');

class GPUMonitor {
  constructor() {
    this.gpuInfo = null;
    this.lastUpdate = null;
    this.updateInterval = null;
    this.available = false;
    this.type = 'none'; // 'none', 'nvidia', 'intel'
  }

  /**
   * Initialize GPU detection
   */
  async initialize() {
    console.log('[gpu-monitor] Detecting GPU...');

    // Check for NVIDIA GPU first
    const nvidia = await this.detectNvidia();
    if (nvidia) {
      this.type = 'nvidia';
      this.available = true;
      console.log(`[gpu-monitor] NVIDIA GPU detected: ${nvidia.name}`);

      // Start periodic monitoring
      this.startMonitoring();
      return;
    }

    // Check for Intel GPU (future)
    const intel = await this.detectIntel();
    if (intel) {
      this.type = 'intel';
      this.available = true;
      console.log(`[gpu-monitor] Intel GPU detected`);
      return;
    }

    console.log('[gpu-monitor] No GPU detected, using CPU encoding');
    this.type = 'none';
    this.available = false;
  }

  /**
   * Detect NVIDIA GPU using nvidia-smi
   */
  async detectNvidia() {
    return new Promise((resolve) => {
      exec('nvidia-smi --query-gpu=name,driver_version,memory.total,memory.free,memory.used,utilization.gpu,utilization.encoder,utilization.decoder,temperature.gpu,power.draw,encoder.stats.sessionCount --format=csv,noheader,nounits',
        { timeout: 5000 },
        (error, stdout, stderr) => {
          if (error) {
            resolve(null);
            return;
          }

          try {
            const parts = stdout.trim().split(', ');
            if (parts.length >= 9) {
              const info = {
                name: parts[0],
                driverVersion: parts[1],
                memory: {
                  total: parseInt(parts[2]) || 0,
                  free: parseInt(parts[3]) || 0,
                  used: parseInt(parts[4]) || 0,
                },
                utilization: {
                  gpu: parseInt(parts[5]) || 0,
                  encoder: parseInt(parts[6]) || 0,
                  decoder: parseInt(parts[7]) || 0,
                },
                temperature: parseInt(parts[8]) || 0,
                powerDraw: parseFloat(parts[9]) || 0,
                encoderSessions: parseInt(parts[10]) || 0,
              };

              this.gpuInfo = info;
              this.lastUpdate = Date.now();
              resolve(info);
            } else {
              resolve(null);
            }
          } catch (e) {
            resolve(null);
          }
        }
      );
    });
  }

  /**
   * Detect Intel GPU (placeholder for future)
   */
  async detectIntel() {
    // Check for Intel GPU using vainfo or similar
    return new Promise((resolve) => {
      exec('ls /dev/dri/renderD* 2>/dev/null', { timeout: 2000 }, (error, stdout) => {
        if (error || !stdout.trim()) {
          resolve(null);
          return;
        }

        // Check if it's Intel specifically
        exec('lspci | grep -i "vga.*intel"', { timeout: 2000 }, (error2, stdout2) => {
          if (!error2 && stdout2.trim()) {
            resolve({ type: 'intel', device: stdout.trim().split('\n')[0] });
          } else {
            resolve(null);
          }
        });
      });
    });
  }

  /**
   * Start periodic monitoring
   */
  startMonitoring() {
    // Update every 5 seconds
    this.updateInterval = setInterval(async () => {
      if (this.type === 'nvidia') {
        await this.detectNvidia();
      }
    }, 5000);
  }

  /**
   * Stop monitoring
   */
  stopMonitoring() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }

  /**
   * Get current GPU status
   */
  getStatus() {
    const hwAccel = config.hwAccel || 'none';
    const encoder = config.getEncoder();

    const status = {
      available: this.available,
      type: this.type,
      hwAccelEnabled: hwAccel !== 'none',
      hwAccelType: hwAccel,
      encoder: encoder,
      lastUpdate: this.lastUpdate,
    };

    if (this.type === 'nvidia' && this.gpuInfo) {
      status.nvidia = {
        name: this.gpuInfo.name,
        driverVersion: this.gpuInfo.driverVersion,
        memory: {
          total: this.gpuInfo.memory.total,
          used: this.gpuInfo.memory.used,
          free: this.gpuInfo.memory.free,
          usedPercent: this.gpuInfo.memory.total > 0
            ? Math.round((this.gpuInfo.memory.used / this.gpuInfo.memory.total) * 100)
            : 0,
        },
        utilization: {
          gpu: this.gpuInfo.utilization.gpu,
          encoder: this.gpuInfo.utilization.encoder,
          decoder: this.gpuInfo.utilization.decoder,
        },
        temperature: this.gpuInfo.temperature,
        powerDraw: this.gpuInfo.powerDraw,
        encoderSessions: this.gpuInfo.encoderSessions,
      };

      // Add NVENC settings if enabled
      if (hwAccel === 'nvenc') {
        status.nvencSettings = {
          preset: config.nvenc?.preset || 'p4',
          tune: config.nvenc?.tune || 'll',
          rc: config.nvenc?.rc || 'vbr',
          lookahead: config.nvenc?.lookahead || 0,
          bframes: config.nvenc?.bframes || 0,
        };
      }
    }

    if (this.type === 'intel') {
      status.intel = {
        available: true,
        // Add more Intel-specific info in future
      };

      if (hwAccel === 'qsv') {
        status.qsvSettings = {
          preset: config.qsv?.preset || 'fast',
        };
      }
    }

    return status;
  }

  /**
   * Check if NVENC is available and working
   */
  async testNvenc() {
    return new Promise((resolve) => {
      // Try to run a quick NVENC test
      exec('ffmpeg -f lavfi -i testsrc=duration=1:size=320x240:rate=30 -c:v h264_nvenc -f null - 2>&1',
        { timeout: 10000 },
        (error, stdout, stderr) => {
          const output = stdout + stderr;
          if (error) {
            resolve({
              working: false,
              error: output.includes('Cannot load') ? 'NVENC library not found' :
                     output.includes('No NVENC capable devices') ? 'No NVENC capable GPU' :
                     'NVENC test failed'
            });
          } else {
            resolve({ working: true });
          }
        }
      );
    });
  }

  /**
   * Get NVENC session limits
   * Consumer GPUs typically have 3-5 session limit
   */
  getSessionLimits() {
    if (this.type !== 'nvidia' || !this.gpuInfo) {
      return null;
    }

    // Common NVENC session limits by GPU series
    const name = this.gpuInfo.name.toLowerCase();
    let maxSessions = 3; // Default consumer limit

    if (name.includes('quadro') || name.includes('tesla') || name.includes('a100') || name.includes('a40')) {
      maxSessions = 'unlimited';
    } else if (name.includes('rtx 40')) {
      maxSessions = 8;
    } else if (name.includes('rtx 30') || name.includes('rtx 20')) {
      maxSessions = 5;
    } else if (name.includes('gtx 16') || name.includes('gtx 10')) {
      maxSessions = 3;
    }

    return {
      current: this.gpuInfo.encoderSessions || 0,
      max: maxSessions,
    };
  }
}

// Singleton instance
const gpuMonitor = new GPUMonitor();

module.exports = gpuMonitor;
