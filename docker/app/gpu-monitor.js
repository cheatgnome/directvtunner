/**
 * GPU Monitor - Detects and monitors NVIDIA GPUs
 * Used for hardware acceleration status and monitoring
 */

const { exec, execSync } = require('child_process');
const config = require('./config');

const os = require('os');

class GPUMonitor {
  constructor() {
    this.gpuInfo = null;
    this.cpuInfo = null;
    this.lastUpdate = null;
    this.updateInterval = null;
    this.available = false;
    this.type = 'none'; // 'none', 'nvidia', 'intel'
    this.lastCpuTimes = null;
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

    // Check for Intel GPU
    const intel = await this.detectIntel();
    if (intel) {
      this.type = 'intel';
      this.available = true;
      console.log(`[gpu-monitor] Intel GPU detected: ${intel.name}`);
      console.log(`[gpu-monitor] VA-API supported: ${intel.vapiSupported}`);
      console.log(`[gpu-monitor] Driver: ${intel.driverVersion || 'Unknown'}`);

      // Start periodic monitoring
      this.startMonitoring();
      return;
    }

    console.log('[gpu-monitor] No GPU detected, using CPU encoding');
    this.type = 'none';
    this.available = false;

    // Start CPU monitoring for software encoding
    this.startMonitoring();
  }

  /**
   * Get CPU usage statistics
   */
  getCpuUsage() {
    const cpus = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;

    for (const cpu of cpus) {
      for (const type in cpu.times) {
        totalTick += cpu.times[type];
      }
      totalIdle += cpu.times.idle;
    }

    const currentTimes = { idle: totalIdle, total: totalTick };

    let usage = 0;
    if (this.lastCpuTimes) {
      const idleDiff = currentTimes.idle - this.lastCpuTimes.idle;
      const totalDiff = currentTimes.total - this.lastCpuTimes.total;
      usage = totalDiff > 0 ? Math.round(100 - (100 * idleDiff / totalDiff)) : 0;
    }

    this.lastCpuTimes = currentTimes;

    // Get load averages
    const loadAvg = os.loadavg();

    // Get memory info
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    this.cpuInfo = {
      model: cpus[0]?.model || 'Unknown CPU',
      cores: cpus.length,
      usage: usage,
      loadAvg: {
        '1m': loadAvg[0].toFixed(2),
        '5m': loadAvg[1].toFixed(2),
        '15m': loadAvg[2].toFixed(2),
      },
      memory: {
        total: Math.round(totalMem / (1024 * 1024 * 1024) * 100) / 100, // GB
        used: Math.round(usedMem / (1024 * 1024 * 1024) * 100) / 100,
        free: Math.round(freeMem / (1024 * 1024 * 1024) * 100) / 100,
        usedPercent: Math.round((usedMem / totalMem) * 100),
      }
    };

    this.lastUpdate = Date.now();
    return this.cpuInfo;
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
   * Detect Intel GPU using vainfo
   */
  async detectIntel() {
    return new Promise((resolve) => {
      // Check for Intel GPU using lspci
      exec('lspci | grep -i "vga.*intel"', { timeout: 2000 }, (error, stdout) => {
        if (error || !stdout.trim()) {
          resolve(null);
          return;
        }

        const gpuName = stdout.trim().split(':').pop()?.trim() || 'Intel GPU';

        // Check for render device
        exec('ls /dev/dri/renderD* 2>/dev/null', { timeout: 2000 }, (error2, stdout2) => {
          if (error2 || !stdout2.trim()) {
            resolve(null);
            return;
          }

          const renderDevice = stdout2.trim().split('\n')[0];

          // Try to get VA-API info
          exec('vainfo 2>&1', { timeout: 5000 }, async (error3, stdout3) => {
            const info = {
              name: gpuName,
              renderDevice: renderDevice,
              vapiSupported: false,
              profiles: [],
              utilization: { render: 0, video: 0, videoEnhance: 0 }
            };

            if (!error3 && stdout3) {
              // Parse vainfo output
              if (stdout3.includes('VAProfileH264')) {
                info.vapiSupported = true;
                const profileMatches = stdout3.match(/VAProfile\w+/g);
                if (profileMatches) {
                  info.profiles = [...new Set(profileMatches)].slice(0, 10);
                }
              }
              // Get driver info
              const driverMatch = stdout3.match(/Driver version:\s*(.+)/);
              if (driverMatch) {
                info.driverVersion = driverMatch[1].trim();
              }
            }

            // Get utilization from intel_gpu_top
            const util = await this.getIntelUtilization();
            if (util) {
              info.utilization = util;
            }

            this.gpuInfo = info;
            this.lastUpdate = Date.now();
            resolve(info);
          });
        });
      });
    });
  }

  /**
   * Get Intel GPU utilization using intel_gpu_top
   */
  async getIntelUtilization() {
    return new Promise((resolve) => {
      // Run for 3 seconds with 1 second samples to get stable readings
      // Use -l 1 to get a single JSON object output
      exec('timeout 3 intel_gpu_top -J -s 1000 2>/dev/null', { timeout: 5000 }, (error, stdout) => {
        if (error || !stdout.trim()) {
          resolve(null);
          return;
        }
        try {
          // The output is multi-line JSON objects separated by newlines
          // Find complete JSON objects by matching braces
          const output = stdout.trim();
          let lastUtil = null;
          let braceCount = 0;
          let jsonStart = -1;

          for (let i = 0; i < output.length; i++) {
            if (output[i] === '{') {
              if (braceCount === 0) jsonStart = i;
              braceCount++;
            } else if (output[i] === '}') {
              braceCount--;
              if (braceCount === 0 && jsonStart >= 0) {
                // Found complete JSON object
                try {
                  const jsonStr = output.substring(jsonStart, i + 1);
                  const data = JSON.parse(jsonStr);
                  if (data.engines) {
                    const util = { render: 0, video: 0, videoEnhance: 0 };
                    // Engine names are keys like "Render/3D/0", "Video/0", "VideoEnhance/0"
                    for (const [name, engine] of Object.entries(data.engines)) {
                      if (name.startsWith('Render/3D')) util.render = Math.round(engine.busy || 0);
                      else if (name.startsWith('Video/') && !name.startsWith('VideoEnhance')) util.video = Math.round(engine.busy || 0);
                      else if (name.startsWith('VideoEnhance')) util.videoEnhance = Math.round(engine.busy || 0);
                    }
                    lastUtil = util;
                  }
                } catch (parseErr) {
                  // Skip malformed JSON
                }
                jsonStart = -1;
              }
            }
          }
          resolve(lastUtil);
        } catch (e) {
          resolve(null);
        }
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
      } else if (this.type === 'intel') {
        await this.detectIntel();
      } else {
        // Monitor CPU for software encoding
        this.getCpuUsage();
      }
    }, 5000);

    // Initial CPU reading
    if (this.type === 'none') {
      this.getCpuUsage();
    }
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

    if (this.type === 'intel' && this.gpuInfo) {
      status.intel = {
        name: this.gpuInfo.name,
        renderDevice: this.gpuInfo.renderDevice,
        driverVersion: this.gpuInfo.driverVersion || 'Unknown',
        vapiSupported: this.gpuInfo.vapiSupported,
        profiles: this.gpuInfo.profiles || [],
        utilization: {
          render: this.gpuInfo.utilization?.render || 0,
          video: this.gpuInfo.utilization?.video || 0,
          videoEnhance: this.gpuInfo.utilization?.videoEnhance || 0,
        },
      };

      if (hwAccel === 'vaapi') {
        status.vaapiSettings = {
          device: '/dev/dri/renderD128',
        };
      }
    }

    // Add CPU info for software encoding (or always for general system info)
    if (this.cpuInfo) {
      status.cpu = {
        model: this.cpuInfo.model,
        cores: this.cpuInfo.cores,
        usage: this.cpuInfo.usage,
        loadAvg: this.cpuInfo.loadAvg,
        memory: this.cpuInfo.memory,
      };
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
   * Check if QSV is available and working
   */
  async testQsv() {
    return new Promise((resolve) => {
      // Try to run a quick QSV test
      exec('ffmpeg -init_hw_device qsv=qsv:hw -f lavfi -i testsrc=duration=1:size=320x240:rate=30 -c:v h264_qsv -f null - 2>&1',
        { timeout: 10000 },
        (error, stdout, stderr) => {
          const output = stdout + stderr;
          if (error) {
            resolve({
              working: false,
              error: output.includes('Cannot load') ? 'QSV library not found' :
                     output.includes('No device') ? 'No QSV capable GPU' :
                     output.includes('MFX') ? 'Intel Media SDK error' :
                     'QSV test failed'
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
