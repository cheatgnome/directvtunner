const { Tuner, TunerState } = require('./tuner');
const config = require('./config');
const directvEpg = require('./directv-epg');

class TunerManager {
  constructor() {
    this.tuners = [];
    this.initialized = false;
    // Track pending channel request to handle rapid surfing
    this.pendingChannel = null;
    this.pendingResolvers = [];
    this.tuningLock = false;
  }

  async initialize() {
    if (this.initialized) return;

    console.log(`[tuner-manager] Initializing ${config.numTuners} tuner(s)...`);

    for (let i = 0; i < config.numTuners; i++) {
      const tuner = new Tuner(i);
      this.tuners.push(tuner);

      try {
        await tuner.start();
      } catch (err) {
        console.error(`[tuner-manager] Failed to start tuner ${i}:`, err.message);
      }
    }

    this.initialized = true;
    console.log(`[tuner-manager] Initialized ${this.tuners.filter(t => t.state === TunerState.FREE).length} tuner(s)`);

    // Start idle cleanup interval
    this.startIdleCleanup();
  }

  startIdleCleanup() {
    setInterval(async () => {
      for (const tuner of this.tuners) {
        // Release idle streaming tuners
        if (tuner.state === TunerState.STREAMING && tuner.isIdle()) {
          console.log(`[tuner-manager] Tuner ${tuner.id} is idle, releasing...`);
          this.releaseTuner(tuner.id);
        }

        // Auto-recover tuners stuck in ERROR state
        if (tuner.state === TunerState.ERROR) {
          console.log(`[tuner-manager] Tuner ${tuner.id} in ERROR state, attempting auto-recovery...`);
          this.recoverTuner(tuner.id);
        }

        // Periodic health check for FREE tuners - check CDP connection
        if (tuner.state === TunerState.FREE) {
          try {
            const healthy = await tuner.checkConnectionHealth();
            if (!healthy) {
              console.log(`[tuner-manager] Tuner ${tuner.id} CDP connection unhealthy, reconnecting...`);
              await tuner.reconnect();
            }
          } catch (e) {
            console.log(`[tuner-manager] Tuner ${tuner.id} health check error: ${e.message}`);
          }
        }
      }
    }, 30000);  // Check every 30 seconds
  }

  // Attempt to recover a tuner from error state
  async recoverTuner(tunerId) {
    const tuner = this.getTuner(tunerId);
    if (!tuner) return;

    try {
      // Stop any lingering processes
      if (tuner.ffmpeg) {
        try { tuner.ffmpeg.stop(); } catch (e) { }
      }

      // Try to reconnect the CDP connection
      console.log(`[tuner-manager] Attempting to reconnect tuner ${tunerId}...`);
      const reconnected = await tuner.reconnect();

      if (reconnected) {
        console.log(`[tuner-manager] Tuner ${tunerId} recovered and reconnected to Chrome`);
      } else {
        // Fallback: just reset the state so it can try again later
        tuner.state = TunerState.FREE;
        tuner.currentChannel = null;
        tuner.clients = 0;
        console.log(`[tuner-manager] Tuner ${tunerId} reset to FREE state (reconnect will retry on next use)`);
      }
    } catch (err) {
      console.error(`[tuner-manager] Failed to recover tuner ${tunerId}:`, err.message);
    }
  }

  // Find a tuner for the requested channel
  // Handles rapid channel surfing by queuing and debouncing requests
  async allocateTuner(channelId) {
    // First, check if any tuner is already streaming this channel
    const existingTuner = this.tuners.find(
      t => t.state === TunerState.STREAMING && t.currentChannel === channelId
    );

    if (existingTuner) {
      console.log(`[tuner-manager] Reusing tuner ${existingTuner.id} already on ${channelId}`);
      existingTuner.addClient();
      return existingTuner;
    }

    // Check if a tuner is currently TUNING to this channel - wait for it
    const tuningToThis = this.tuners.find(
      t => t.state === TunerState.TUNING && t.currentChannel === channelId
    );

    if (tuningToThis) {
      console.log(`[tuner-manager] Tuner ${tuningToThis.id} already tuning to ${channelId}, waiting...`);
      // Wait for the tuner to finish tuning (poll every 500ms)
      const maxWait = 30000;
      let waited = 0;
      while (waited < maxWait) {
        await new Promise(r => setTimeout(r, 500));
        waited += 500;
        if (tuningToThis.state === TunerState.STREAMING && tuningToThis.currentChannel === channelId) {
          console.log(`[tuner-manager] Tuner ${tuningToThis.id} finished tuning to ${channelId}`);
          tuningToThis.addClient();
          return tuningToThis;
        }
        if (tuningToThis.state === TunerState.ERROR || tuningToThis.state === TunerState.FREE) {
          console.log(`[tuner-manager] Tuner ${tuningToThis.id} tuning failed, will try allocation`);
          break;
        }
      }
    }

    // If we're currently tuning to a DIFFERENT channel, this is channel surfing
    // Queue this request and cancel/supersede the current one
    const tuningTuner = this.tuners.find(t => t.state === TunerState.TUNING);
    if (tuningTuner && tuningTuner.currentChannel !== channelId) {
      console.log(`[tuner-manager] Channel surf detected: ${tuningTuner.currentChannel} -> ${channelId}, queuing new channel`);

      // Store the new channel as the target - the current tune will complete
      // but we'll immediately switch to this one
      this.pendingChannel = channelId;

      // Wait for the current tuning to complete
      const maxWait = 35000;
      let waited = 0;
      while (waited < maxWait && tuningTuner.state === TunerState.TUNING) {
        await new Promise(r => setTimeout(r, 500));
        waited += 500;

        // Check if another channel was requested during this wait
        if (this.pendingChannel !== channelId) {
          console.log(`[tuner-manager] Channel ${channelId} superseded by ${this.pendingChannel}`);
          return null;  // This request is no longer relevant
        }
      }

      // Clear pending since we're about to process this
      this.pendingChannel = null;

      // Now switch to the new channel
      if (tuningTuner.state === TunerState.STREAMING || tuningTuner.state === TunerState.FREE) {
        console.log(`[tuner-manager] Now switching to queued channel ${channelId}`);
        tuningTuner.clients = 0;
        await tuningTuner.tuneToChannel(channelId);
        tuningTuner.addClient();
        return tuningTuner;
      }
    }

    // Find a free tuner - prefer tuners that have access to this channel
    // (for multi-account setups where different accounts have different channels)
    const allowedTuners = directvEpg.getTunersForChannel(channelId);
    const preferredTunerId = directvEpg.getTunerForChannel(channelId);
    const hasChannelRestriction = allowedTuners.length > 0;

    let freeTuner = null;

    if (hasChannelRestriction) {
      // Multi-account: ONLY use tuners that have access to this channel
      freeTuner = this.tuners.find(t =>
        t.state === TunerState.FREE && t.id === preferredTunerId
      );
      if (!freeTuner) {
        freeTuner = this.tuners.find(t =>
          t.state === TunerState.FREE && allowedTuners.includes(t.id)
        );
      }
      if (freeTuner) {
        console.log(`[tuner-manager] Using tuner ${freeTuner.id} (has access to channel ${channelId})`);
      }
    } else {
      // No EPG mapping (single-account or EPG not scanned yet) - use any free tuner
      freeTuner = this.tuners.find(t => t.state === TunerState.FREE);
    }

    if (freeTuner) {
      console.log(`[tuner-manager] Allocating free tuner ${freeTuner.id} for ${channelId}`);
      await freeTuner.tuneToChannel(channelId);
      freeTuner.addClient();
      return freeTuner;
    }

    // No free tuners - check for idle tuners we can steal
    // ONLY use idle tuners that have access to the channel (if restrictions exist)
    let idleTuner = null;
    const idleTuners = this.tuners
      .filter(t => t.state === TunerState.STREAMING && t.clients === 0)
      .sort((a, b) => a.lastActivity - b.lastActivity);

    if (hasChannelRestriction) {
      // Only steal idle tuners that have access
      idleTuner = idleTuners.find(t => allowedTuners.includes(t.id));
    } else {
      // No restrictions - use any idle tuner
      idleTuner = idleTuners[0];
    }

    if (idleTuner) {
      console.log(`[tuner-manager] Stealing idle tuner ${idleTuner.id} for ${channelId}`);
      await idleTuner.tuneToChannel(channelId);
      idleTuner.addClient();
      return idleTuner;
    }

    // AUTO-SWITCH: Only for single-tuner or when no channel restrictions
    // For multi-account, don't steal busy tuners that don't have access
    if (!hasChannelRestriction) {
      const busyTuner = this.tuners.find(t => t.state === TunerState.STREAMING);
      if (busyTuner) {
        console.log(`[tuner-manager] Auto-switching tuner ${busyTuner.id} from ${busyTuner.currentChannel} to ${channelId}`);
        busyTuner.clients = 0;
        await busyTuner.tuneToChannel(channelId);
        busyTuner.addClient();
        return busyTuner;
      }
    } else {
      // Multi-account: check if any allowed tuner is streaming but could be stolen
      const allowedBusyTuner = this.tuners.find(t =>
        t.state === TunerState.STREAMING && allowedTuners.includes(t.id)
      );
      if (allowedBusyTuner) {
        console.log(`[tuner-manager] Auto-switching tuner ${allowedBusyTuner.id} (has access) from ${allowedBusyTuner.currentChannel} to ${channelId}`);
        allowedBusyTuner.clients = 0;
        await allowedBusyTuner.tuneToChannel(channelId);
        allowedBusyTuner.addClient();
        return allowedBusyTuner;
      }
    }

    // All tuners with access are busy - cannot tune
    if (hasChannelRestriction) {
      console.log(`[tuner-manager] No tuners with access to channel ${channelId} are available (requires tuner ${allowedTuners.join(', ')})`);
    } else {
      console.log(`[tuner-manager] All tuners busy or unavailable`);
    }
    return null;
  }

  // Get tuner by ID
  getTuner(tunerId) {
    return this.tuners.find(t => t.id === parseInt(tunerId));
  }

  // Release a client from a tuner
  releaseClient(tunerId) {
    const tuner = this.getTuner(tunerId);
    if (tuner) {
      tuner.removeClient();
    }
  }

  // Force release a tuner (stop streaming)
  async releaseTuner(tunerId) {
    const tuner = this.getTuner(tunerId);
    if (tuner && (tuner.state === TunerState.STREAMING || tuner.state === TunerState.ERROR || tuner.state === TunerState.TUNING)) {
      // Stop FFmpeg but keep Chrome running
      if (tuner.ffmpeg) {
        try { tuner.ffmpeg.stop(); } catch (e) { }
      }
      tuner.state = TunerState.FREE;
      tuner.currentChannel = null;
      tuner.clients = 0;
      console.log(`[tuner-manager] Released tuner ${tunerId}`);
    }
  }

  // Get status of all tuners
  getStatus() {
    return {
      numTuners: this.tuners.length,
      tuners: this.tuners.map(t => t.getStatus()),
    };
  }

  // Shutdown all tuners
  async shutdown() {
    console.log(`[tuner-manager] Shutting down all tuners...`);
    for (const tuner of this.tuners) {
      await tuner.stop();
    }
    this.tuners = [];
    this.initialized = false;
  }
}

// Singleton instance
const tunerManager = new TunerManager();

module.exports = tunerManager;
