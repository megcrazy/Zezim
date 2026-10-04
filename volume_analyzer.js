const axios = require("axios");

class VolumeAnalyzer {
    constructor(config) {
        this.config = config;
        this.volumeCache = new Map();
        this.cacheDuration = 5 * 60 * 1000; // 5 minutos
    }

    async getVolumeAnalysis(symbol, timeframe = "1h") {
        const cacheKey = `${symbol}_${timeframe}`;
        const now = Date.now();
        
        // Verificar cache
        if (this.volumeCache.has(cacheKey)) {
            const cached = this.volumeCache.get(cacheKey);
            if (now - cached.timestamp < this.cacheDuration) {
                return cached.data;
            }
        }

        try {
            // Buscar candles
            const response = await axios.get("https://fapi.binance.com/fapi/v1/klines", {
                params: {
                    symbol,
                    interval: timeframe,
                    limit: this.config.INDICATORS.VOLUME.LOOKBACK_PERIOD + 5
                }
            });

            const candles = response.data.map(c => ({
                volume: parseFloat(c[5]),
                close: parseFloat(c[4])
            }));

            // Calcular métricas
            const recentVolumes = candles.slice(-this.config.INDICATORS.VOLUME.CONFIRMATION_BARS);
            const allVolumes = candles.map(c => c.volume);
            
            const currentVolume = recentVolumes[recentVolumes.length - 1]?.volume || 0;
            const avgVolume = allVolumes.reduce((a, b) => a + b, 0) / allVolumes.length;
            const relativeVolume = avgVolume > 0 ? currentVolume / avgVolume : 0;
            
            // Volume das últimas barras
            const volumeTrend = this.calculateVolumeTrend(recentVolumes);
            
            // Classificação
            let strength = "FRACO";
            if (relativeVolume > 2.0) strength = "EXPLOSIVO";
            else if (relativeVolume > 1.5) strength = "FORTE";
            else if (relativeVolume > 1.2) strength = "MODERADO";
            
            const analysis = {
                symbol,
                timeframe,
                currentVolume,
                averageVolume: avgVolume,
                relativeVolume: relativeVolume.toFixed(2),
                volumeStrength: strength,
                volumeTrend, // "INCREASING", "DECREASING", "STABLE"
                hasVolumeSpike: relativeVolume >= this.config.INDICATORS.VOLUME.MIN_RELATIVE_VOLUME,
                timestamp: now
            };

            // Atualizar cache
            this.volumeCache.set(cacheKey, {
                timestamp: now,
                data: analysis
            });

            return analysis;

        } catch (error) {
            console.error(`❌ Erro análise volume ${symbol}:`, error.message);
            return null;
        }
    }

    calculateVolumeTrend(volumes) {
        if (volumes.length < 2) return "STABLE";
        
        const lastTwo = volumes.slice(-2);
        if (lastTwo[1].volume > lastTwo[0].volume * 1.2) return "INCREASING";
        if (lastTwo[1].volume < lastTwo[0].volume * 0.8) return "DECREASING";
        return "STABLE";
    }

    // Verificar se está em horário de liquidez
    isHighLiquidityTime() {
        const now = new Date();
        const hour = now.getUTCHours() - 3; // UTC-3
        
        return this.config.FILTERS.PREFERRED_HOURS.includes(hour);
    }

    // Calcular posição relativa do preço (suporte/resistência)
    async getPricePosition(symbol) {
        try {
            const response = await axios.get("https://fapi.binance.com/fapi/v1/klines", {
                params: { symbol, interval: "4h", limit: 50 }
            });

            const candles = response.data.map(c => ({
                high: parseFloat(c[2]),
                low: parseFloat(c[3]),
                close: parseFloat(c[4])
            }));

            const currentPrice = candles[candles.length - 1].close;
            const highs = candles.map(c => c.high);
            const lows = candles.map(c => c.low);
            
            const maxHigh = Math.max(...highs.slice(-20));
            const minLow = Math.min(...lows.slice(-20));
            
            const priceRange = maxHigh - minLow;
            const position = priceRange > 0 ? (currentPrice - minLow) / priceRange : 0.5;
            
            let zone = "NEUTRAL";
            if (position < 0.3) zone = "SUPPORT";
            else if (position > 0.7) zone = "RESISTANCE";
            
            return {
                currentPrice,
                support: minLow,
                resistance: maxHigh,
                position: (position * 100).toFixed(1),
                zone,
                isNearSupport: position < 0.3,
                isNearResistance: position > 0.7
            };

        } catch (error) {
            console.error(`❌ Erro posição preço ${symbol}:`, error.message);
            return null;
        }
    }
}

module.exports = VolumeAnalyzer;