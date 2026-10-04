// range_detector.js - VERSÃO CORRIGIDA
class RangeDetector {
    constructor(config) {
        this.config = config;
        this.ranges = new Map();
    }

    async detectRange(symbol, candles, timeframe = '4h') {
        if (!candles || candles.length < 20) return null;

        // 1. Identificar suportes e resistências (SIMPLIFICADO)
        const levels = this.findSupportResistance(candles);

        // 2. Calcular range atual
        const recentCandles = candles.slice(-10);
        const highs = recentCandles.map(c => c.high);
        const lows = recentCandles.map(c => c.low);

        const rangeHigh = Math.max(...highs);
        const rangeLow = Math.min(...lows);
        const rangeHeight = rangeHigh - rangeLow;

        // 3. Posição atual no range
        const currentPrice = candles[candles.length - 1].close;
        const rangePosition = rangeHeight > 0
            ? ((currentPrice - rangeLow) / rangeHeight * 100).toFixed(1)
            : 50;

        // 4. Classificar tipo de range
        const rangeType = this.classifyRange(candles, rangeHeight);

        // 5. Detectar bounces nos limites (SIMPLIFICADO)
        const bounceSignals = this.detectBounceSignals(candles, rangeLow, rangeHigh);

        const rangeInfo = {
            symbol,
            timeframe,
            rangeHigh,
            rangeLow,
            rangeHeight,
            currentPrice,
            rangePosition: parseFloat(rangePosition),
            rangeType,
            levels: levels.slice(0, 3), // Apenas 3 principais níveis
            bounceSignals,
            isInRange: rangePosition >= 20 && rangePosition <= 80,
            isNearEdge: rangePosition <= 25 || rangePosition >= 75,
            edgeType: rangePosition <= 25 ? 'NEAR_SUPPORT' :
                rangePosition >= 75 ? 'NEAR_RESISTANCE' : 'MIDDLE',
            volatility: this.calculateVolatility(candles),
            updatedAt: Date.now()
        };

        this.ranges.set(symbol, rangeInfo);
        return rangeInfo;
    }

    findSupportResistance(candles, sensitivity = 0.02) {
        const levels = [];
        const priceSeries = candles.map(c => c.close);

        // Encontrar picos e vales locais
        for (let i = 5; i < priceSeries.length - 5; i++) {
            const window = priceSeries.slice(i - 5, i + 6);
            const current = priceSeries[i];

            // É resistência (pico local)
            if (current === Math.max(...window)) {
                levels.push({
                    price: current,
                    type: 'RESISTANCE',
                    strength: this.calculateLevelStrength(candles, i, current)
                });
            }
            // É suporte (vale local)
            else if (current === Math.min(...window)) {
                levels.push({
                    price: current,
                    type: 'SUPPORT',
                    strength: this.calculateLevelStrength(candles, i, current)
                });
            }
        }

        // Agrupar níveis próximos (SIMPLIFICADO - sem groupNearbyLevels)
        return this.simplifyLevels(levels, sensitivity);
    }

    // NOVA FUNÇÃO SIMPLIFICADA PARA SUBSTITUIR groupNearbyLevels
    simplifyLevels(levels, tolerancePercent = 0.02) {
        if (levels.length === 0) return [];

        const simplified = [];
        const sortedLevels = levels.sort((a, b) => a.price - b.price);

        for (const level of sortedLevels) {
            // Verificar se já existe um nível próximo
            const existingLevel = simplified.find(existing =>
                Math.abs(existing.price - level.price) / existing.price <= tolerancePercent
            );

            if (existingLevel) {
                // Atualizar nível existente (média ponderada)
                existingLevel.price = (existingLevel.price + level.price) / 2;
                existingLevel.strength = this.combineStrength(existingLevel.strength, level.strength);
            } else {
                simplified.push({ ...level });
            }
        }

        return simplified;
    }

    combineStrength(str1, str2) {
        const strengths = ['WEAK', 'MODERATE', 'STRONG'];
        const idx1 = strengths.indexOf(str1);
        const idx2 = strengths.indexOf(str2);

        return strengths[Math.max(idx1, idx2)] || 'MODERATE';
    }

    calculateLevelStrength(candles, index, levelPrice) {
        let touches = 0;
        const tolerance = levelPrice * 0.005; // 0.5%

        for (let i = Math.max(0, index - 20); i < Math.min(candles.length, index + 20); i++) {
            const candle = candles[i];
            if (Math.abs(candle.low - levelPrice) <= tolerance ||
                Math.abs(candle.high - levelPrice) <= tolerance) {
                touches++;
            }
        }

        if (touches >= 3) return 'STRONG';
        if (touches >= 2) return 'MODERATE';
        return 'WEAK';
    }

    classifyRange(candles, rangeHeight) {
        const atr = this.calculateATR(candles);
        if (atr === 0) return 'NORMAL_RANGE';

        // Range apertado (consolidação)
        if (rangeHeight < atr * 1.5) {
            return 'TIGHT_RANGE';
        }
        // Range normal
        else if (rangeHeight < atr * 3) {
            return 'NORMAL_RANGE';
        }
        // Range largo (alta volatilidade)
        else {
            return 'WIDE_RANGE';
        }
    }

    detectBounceSignals(candles, support, resistance) {
        const recentCandles = candles.slice(-5);
        const signals = [];
        const tolerance = (resistance - support) * 0.02; // 2% do range

        recentCandles.forEach((candle, i) => {
            // Bounce no suporte
            if (Math.abs(candle.low - support) <= tolerance &&
                candle.close > candle.low) {
                signals.push({
                    type: 'SUPPORT_BOUNCE',
                    candleIndex: candles.length - 5 + i,
                    price: candle.low,
                    confirmation: candle.close > candle.open
                });
            }

            // Rejeição na resistência
            if (Math.abs(candle.high - resistance) <= tolerance &&
                candle.close < candle.high) {
                signals.push({
                    type: 'RESISTANCE_REJECTION',
                    candleIndex: candles.length - 5 + i,
                    price: candle.high,
                    confirmation: candle.close < candle.open
                });
            }
        });

        return signals;
    }

    calculateVolatility(candles) {
        if (candles.length < 2) return 0;

        const returns = [];
        for (let i = 1; i < candles.length; i++) {
            const ret = Math.abs((candles[i].close - candles[i - 1].close) / candles[i - 1].close);
            returns.push(ret);
        }

        const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
        return (avgReturn * 100).toFixed(2);
    }

    calculateATR(candles, period = 14) {
        if (candles.length < period + 1) return 0;

        let trSum = 0;
        const startIdx = Math.max(0, candles.length - period - 1);

        for (let i = startIdx; i < candles.length - 1; i++) {
            const candle = candles[i];
            const prevCandle = candles[i - 1] || candle;

            const tr = Math.max(
                candle.high - candle.low,
                Math.abs(candle.high - prevCandle.close),
                Math.abs(candle.low - prevCandle.close)
            );
            trSum += tr;
        }

        return trSum / Math.min(period, candles.length - 1);
    }

    getTradingAdvice(symbol, setupType, currentPrice) {
        const range = this.ranges.get(symbol);
        if (!range) return null;

        const advice = {
            rangePosition: range.rangePosition,
            rangeType: range.rangeType,
            edgeType: range.edgeType,
            action: 'WAIT',
            reason: '',
            confidence: 0
        };

        if (setupType === 'LONG') {
            if (range.edgeType === 'NEAR_SUPPORT') {
                advice.action = 'CONSIDER_ENTRY';
                advice.reason = 'Próximo ao suporte do range';
                advice.confidence = 70;
            } else if (range.edgeType === 'NEAR_RESISTANCE') {
                advice.action = 'AVOID';
                advice.reason = 'Próximo à resistência - risco alto';
                advice.confidence = 80;
            }
        } else if (setupType === 'SHORT') {
            if (range.edgeType === 'NEAR_RESISTANCE') {
                advice.action = 'CONSIDER_ENTRY';
                advice.reason = 'Próximo à resistência do range';
                advice.confidence = 70;
            } else if (range.edgeType === 'NEAR_SUPPORT') {
                advice.action = 'AVOID';
                advice.reason = 'Próximo ao suporte - risco alto';
                advice.confidence = 80;
            }
        }

        // Ajustar baseado no tipo de range
        if (range.rangeType === 'TIGHT_RANGE') {
            advice.reason += ' (Range apertado - possível rompimento)';
            advice.confidence -= 10;
        } else if (range.rangeType === 'WIDE_RANGE') {
            advice.reason += ' (Range amplo - bom para swing)';
            advice.confidence += 5;
        }

        return advice;
    }
}

module.exports = RangeDetector;