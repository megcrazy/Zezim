const axios = require("axios");
const fs = require("fs").promises;
const path = require("path");

class GoldEggTracker {
  constructor() {
    this.tracker = new Map();
    this.stats = {
      totalDetected: 0,
      totalTriggered: 0,
      successes: [],
      failures: []
    };
    this.dataFile = path.join(__dirname, "data/gold_eggs.json");
    this.statsFile = path.join(__dirname, "data/gold_stats.json");
  }

  async initialize() {
    await this.loadFromDisk();
    console.log(`🥚 GoldEggTracker inicializado. ${this.tracker.size} ovos em memória.`);
  }

  async detect(symbol, data) {
    const eggId = `${symbol}_${Date.now()}`;
    
    const goldEgg = {
      id: eggId,
      symbol,
      detectedAt: Date.now(),
      detectedPrice: data.price,
      stochH4Value: data.stochValue,
      stochH4Direction: data.direction,
      cciAtDetection: data.cci,
      status: "DETECTED", // DETECTED → TRIGGERED → COMPLETED
      alertsSent: 0,
      maxAlerts: 10
    };

    this.tracker.set(eggId, goldEgg);
    this.stats.totalDetected++;
    
    await this.saveToDisk();
    return goldEgg;
  }

  async trigger(eggId, triggerData) {
    const egg = this.tracker.get(eggId);
    if (!egg) return null;

    egg.status = "TRIGGERED";
    egg.triggeredAt = Date.now();
    egg.triggeredPrice = triggerData.price;
    egg.cciAtTrigger = triggerData.cci;
    egg.gainFromDetection = ((triggerData.price - egg.detectedPrice) / egg.detectedPrice * 100).toFixed(2);
    egg.timeToTrigger = ((egg.triggeredAt - egg.detectedAt) / (1000 * 60 * 60)).toFixed(2); // horas

    this.stats.totalTriggered++;
    this.stats.successes.push({
      symbol: egg.symbol,
      detectionPrice: egg.detectedPrice,
      triggerPrice: egg.triggeredPrice,
      gain: egg.gainFromDetection,
      timeToTrigger: egg.timeToTrigger
    });

    await this.saveToDisk();
    return egg;
  }

  async updateProgress(eggId, currentPrice) {
    const egg = this.tracker.get(eggId);
    if (!egg || egg.status !== "TRIGGERED") return null;

    const currentGain = ((currentPrice - egg.triggeredPrice) / egg.triggeredPrice * 100).toFixed(2);
    egg.currentGain = currentGain;

    // Alertas de progresso automáticos
    if (currentGain >= 20 && !egg.alert20) {
      egg.alert20 = true;
      return { level: 20, gain: currentGain };
    }
    if (currentGain >= 50 && !egg.alert50) {
      egg.alert50 = true;
      return { level: 50, gain: currentGain };
    }
    if (currentGain >= 100 && !egg.alert100) {
      egg.alert100 = true;
      return { level: 100, gain: currentGain };
    }

    return null;
  }

  async cleanupOldEggs(maxAgeHours = 48) {
    const now = Date.now();
    const maxAgeMs = maxAgeHours * 60 * 60 * 1000;

    for (const [eggId, egg] of this.tracker.entries()) {
      const age = now - egg.detectedAt;
      if (age > maxAgeMs) {
        this.tracker.delete(eggId);
        console.log(`🧹 Ovo removido (antigo): ${egg.symbol}`);
      }
    }
  }

  getActiveEggs() {
    return Array.from(this.tracker.values()).filter(egg => 
      egg.status === "DETECTED" || egg.status === "TRIGGERED"
    );
  }

  getEggBySymbol(symbol) {
    return Array.from(this.tracker.values()).find(egg => 
      egg.symbol === symbol && (egg.status === "DETECTED" || egg.status === "TRIGGERED")
    );
  }

  async saveToDisk() {
    try {
      const data = {
        tracker: Array.from(this.tracker.entries()),
        stats: this.stats,
        savedAt: new Date().toISOString()
      };

      await fs.writeFile(this.dataFile, JSON.stringify(data, null, 2));
      await fs.writeFile(this.statsFile, JSON.stringify(this.stats, null, 2));
    } catch (error) {
      console.error("❌ Erro ao salvar ovos:", error.message);
    }
  }

  async loadFromDisk() {
    try {
      const data = await fs.readFile(this.dataFile, 'utf8');
      const parsed = JSON.parse(data);
      
      this.tracker = new Map(parsed.tracker || []);
      this.stats = parsed.stats || this.stats;
      
      console.log(`📂 ${this.tracker.size} ovos carregados do disco`);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error("❌ Erro ao carregar ovos:", error.message);
      }
    }
  }

  getStats() {
    const activeEggs = this.getActiveEggs();
    const triggeredEggs = activeEggs.filter(e => e.status === "TRIGGERED");
    
    return {
      totalDetected: this.stats.totalDetected,
      totalTriggered: this.stats.totalTriggered,
      activeEggs: activeEggs.length,
      triggeredNow: triggeredEggs.length,
      successRate: this.stats.totalTriggered > 0 
        ? (this.stats.successes.length / this.stats.totalTriggered * 100).toFixed(1)
        : 0,
      avgGain: this.stats.successes.length > 0
        ? (this.stats.successes.reduce((sum, s) => sum + parseFloat(s.gain), 0) / this.stats.successes.length).toFixed(2)
        : 0
    };
  }
}

module.exports = GoldEggTracker;