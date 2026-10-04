const fs = require("fs");
const path = require("path");
const { CCI } = require("technicalindicators");

class Incubadora {
    constructor(CONFIG, sendTelegram, formatPrice, formatPercent, tvLink, options = {}) {
        this.CONFIG = CONFIG || {};
        this.sendTelegram = sendTelegram || (async () => {});
        this.formatPrice = formatPrice || ((value) => String(value));
        this.formatPercent = formatPercent || ((value) => `${value.toFixed(2)}%`);
        this.tvLink = tvLink || ((symbol) => symbol);
        this.getTakerVolume = options.getTakerVolume || null;
        this.getOpenInterest = options.getOpenInterest || null;
        this.getOpenInterestTrend = options.getOpenInterestTrend || null;
        this.getH4CrossContext = options.getH4CrossContext || null;

        const cfg = this.CONFIG.INCUBADORA || {};
        this.settings = {
            enabled: cfg.ENABLED !== false,
            longActive: cfg.LONG_ACTIVE !== false,
            shortActive: cfg.SHORT_ACTIVE === true,
            useClosedCandles: cfg.USE_CLOSED_CANDLES !== false,
            h4CciReloadLevel: this.num(cfg.H4_CCI_RELOAD_LEVEL, -100),
            h4CciExtremeLevel: this.num(cfg.H4_CCI_EXTREME_LEVEL, -200),
            h4StochReloadLevel: this.num(cfg.H4_STOCH_RELOAD_LEVEL, 20),
            h4LookbackCandles: this.int(cfg.H4_LOOKBACK_CANDLES, 24),
            h4SyncWindowCandles: this.int(cfg.H4_SYNC_WINDOW_CANDLES, 1),
            h1WindowCandles: this.int(cfg.H1_WINDOW_CANDLES, 40),
            minBreaks100: this.int(cfg.MIN_ROMPIMENTOS_100, 3),
            maxRangePercent: this.num(cfg.MAX_RANGE_PERCENT, 20),
            reversalH1Lookback: this.int(cfg.REVERSAO_H1_LOOKBACK, 18),
            reversalCciRecovery: this.num(cfg.REVERSAO_CCI_RECOVERY, -100),
            reversalCciConfirm: this.num(cfg.REVERSAO_CCI_CONFIRM, 0),
            reversalStochLevel: this.num(cfg.REVERSAO_STOCH_LEVEL, 20),
            reversalVolumeRatio: this.num(cfg.REVERSAO_VOLUME_RATIO, 1.2),
            triggerCci: this.num(cfg.DISPARO_CCI, 130),
            triggerVolumeRatio: this.num(cfg.DISPARO_VOLUME_RATIO, 1.5),
            volumeLookbackCandles: this.int(cfg.VOLUME_LOOKBACK_CANDLES, 20),
            alertSyncReset: cfg.ALERT_SYNC_RESET === true,
            alertReversal: cfg.ALERT_REVERSAO !== false,
            alertH4: cfg.ALERT_H4 === true,
            alertAcumulo: cfg.ALERT_ACUMULO !== false,
            alertDisparo: cfg.ALERT_DISPARO !== false,
            minAlertIntervalMs: this.int(cfg.MIN_ALERT_INTERVAL_MINUTES, 45) * 60 * 1000,
            h4CrossLookbackMs: this.num(
                cfg.H4_CROSS_LOOKBACK_HOURS || this.CONFIG?.STOCH_CCI_H4_SCANNER?.CROSS_LOOKBACK_HOURS,
                168
            ) * 60 * 60 * 1000,
            maxCycleAgeMs: this.int(cfg.MAX_CYCLE_AGE_HOURS, 168) * 60 * 60 * 1000
        };

        this.dataDir = options.dataDir || path.join(__dirname, "data");
        this.stateFile = options.stateFile || path.join(this.dataDir, "incubadora_state.json");
        this.eventsFile = options.eventsFile || path.join(this.dataDir, "incubadora_events.jsonl");
        this.cyclesFile = options.cyclesFile || path.join(this.dataDir, "incubadora_ciclos.jsonl");
        this.cycles = new Map();
        this.load();
    }

    num(value, fallback) {
        const n = Number(value);
        return Number.isFinite(n) ? n : fallback;
    }

    int(value, fallback) {
        const n = parseInt(value, 10);
        return Number.isFinite(n) ? n : fallback;
    }

    key(symbol, direction) {
        return `${symbol}_${direction}`;
    }

    load() {
        try {
            fs.mkdirSync(this.dataDir, { recursive: true });
            if (!fs.existsSync(this.stateFile)) return;
            const data = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
            this.cycles = new Map((data.cycles || []).map(([key, cycle]) => [key, cycle]));
            console.log(`🥚 Incubadora carregada: ${this.cycles.size} ciclos`);
        } catch (e) {
            console.error("❌ Erro ao carregar Incubadora:", e.message);
        }
    }

    save() {
        try {
            fs.mkdirSync(this.dataDir, { recursive: true });
            fs.writeFileSync(this.stateFile, JSON.stringify({
                savedAt: new Date().toISOString(),
                cycles: Array.from(this.cycles.entries())
            }, null, 2), "utf8");
        } catch (e) {
            console.error("❌ Erro ao salvar Incubadora:", e.message);
        }
    }

    appendJsonl(file, value) {
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.appendFileSync(file, JSON.stringify(value) + "\n", "utf8");
        } catch (e) {
            console.error("❌ Incubadora JSONL:", e.message);
        }
    }

    closedCandles(candles, intervalMs) {
        const list = Array.isArray(candles) ? candles.slice() : [];
        if (!this.settings.useClosedCandles || !list.length) return list;

        const last = list[list.length - 1];
        const openTime = Number(last?.time);
        if (Number.isFinite(openTime) && openTime > 100000000000 && openTime + intervalMs > Date.now()) {
            return list.slice(0, -1);
        }
        return list;
    }

    calculateCCI(candles) {
        const period = this.CONFIG?.INDICATORS?.CCI?.PERIOD || 20;
        if (!candles || candles.length < period) return [];
        try {
            return CCI.calculate({
                high: candles.map(c => c.high),
                low: candles.map(c => c.low),
                close: candles.map(c => c.close),
                period
            });
        } catch (e) {
            return [];
        }
    }

    calculateStochSeries(candles, period = 5, smooth = 3) {
        const values = new Array(candles.length).fill(null);
        if (!candles || candles.length < period + smooth) return values;

        const raw = [];
        for (let i = period - 1; i < candles.length; i++) {
            const window = candles.slice(i - period + 1, i + 1);
            const hi = Math.max(...window.map(c => c.high));
            const lo = Math.min(...window.map(c => c.low));
            const value = hi === lo ? 50 : ((candles[i].close - lo) / (hi - lo)) * 100;
            raw.push({ index: i, value });
        }

        for (let i = smooth - 1; i < raw.length; i++) {
            const slice = raw.slice(i - smooth + 1, i + 1);
            values[raw[i].index] = slice.reduce((sum, item) => sum + item.value, 0) / slice.length;
        }
        return values;
    }

    buildIndicatorPairs(candles) {
        const cci = this.calculateCCI(candles);
        const stoch = this.calculateStochSeries(candles);
        const offset = candles.length - cci.length;
        const pairs = [];

        for (let i = 0; i < cci.length; i++) {
            const candleIndex = offset + i;
            const stochK = stoch[candleIndex];
            if (!candles[candleIndex] || !Number.isFinite(stochK)) continue;
            pairs.push({
                time: candles[candleIndex].time,
                candle: candles[candleIndex],
                cci: cci[i],
                stochK
            });
        }
        return pairs;
    }

    directionalCCI(direction, value) {
        if (!Number.isFinite(value)) return null;
        return direction === "SHORT" ? -value : value;
    }

    rawCCI(direction, value) {
        if (!Number.isFinite(value)) return null;
        return direction === "SHORT" ? -value : value;
    }

    directionalStoch(direction, value) {
        if (!Number.isFinite(value)) return null;
        return direction === "SHORT" ? 100 - value : value;
    }

    rawStoch(direction, value) {
        if (!Number.isFinite(value)) return null;
        return direction === "SHORT" ? 100 - value : value;
    }

    analyzeH4(candlesH4, direction) {
        const pairs = this.buildIndicatorPairs(candlesH4);
        if (pairs.length < 2) return null;

        const recent = pairs.slice(-this.settings.h4LookbackCandles).map(pair => ({
            ...pair,
            signedCCI: this.directionalCCI(direction, pair.cci),
            signedStoch: this.directionalStoch(direction, pair.stochK)
        })).filter(pair => Number.isFinite(pair.signedCCI) && Number.isFinite(pair.signedStoch));

        if (recent.length < 2) return null;

        const current = recent[recent.length - 1];
        const previous = recent[recent.length - 2];
        const cciMinSigned = Math.min(...recent.map(pair => pair.signedCCI));
        const stochMinSigned = Math.min(...recent.map(pair => pair.signedStoch));
        const cciBottoms = [];
        const stochBottoms = [];

        recent.forEach((pair, index) => {
            if (pair.signedCCI <= this.settings.h4CciReloadLevel) cciBottoms.push({ index, pair });
            if (pair.signedStoch <= this.settings.h4StochReloadLevel) stochBottoms.push({ index, pair });
        });

        let syncedBottom = null;
        for (const cciBottom of cciBottoms) {
            for (const stochBottom of stochBottoms) {
                const distance = Math.abs(cciBottom.index - stochBottom.index);
                if (distance > this.settings.h4SyncWindowCandles) continue;
                if (!syncedBottom || distance < syncedBottom.distance) {
                    syncedBottom = { cciBottom, stochBottom, distance };
                }
            }
        }

        const cleaned = !!syncedBottom;
        const syncPair = syncedBottom
            ? (Number(syncedBottom.stochBottom.pair.time || 0) > Number(syncedBottom.cciBottom.pair.time || 0)
                ? syncedBottom.stochBottom.pair
                : syncedBottom.cciBottom.pair)
            : null;

        const turningUp = current.signedCCI > previous.signedCCI &&
            current.signedStoch > previous.signedStoch;

        return {
            cleaned,
            turningUp,
            syncedBottom: !!syncedBottom,
            syncDistanceCandles: syncedBottom ? syncedBottom.distance : null,
            syncTime: syncedBottom ? Math.max(
                Number(syncedBottom.cciBottom.pair.time || 0),
                Number(syncedBottom.stochBottom.pair.time || 0)
            ) : null,
            syncPrice: syncPair?.candle?.close ?? null,
            extreme: cciMinSigned <= this.settings.h4CciExtremeLevel,
            cciMinSigned,
            stochMinSigned,
            cciMinRaw: this.rawCCI(direction, cciMinSigned),
            stochMinRaw: this.rawStoch(direction, stochMinSigned),
            currentCCI: current.cci,
            previousCCI: previous.cci,
            currentSignedCCI: current.signedCCI,
            previousSignedCCI: previous.signedCCI,
            currentStoch: current.stochK,
            previousStoch: previous.stochK,
            currentSignedStoch: current.signedStoch,
            previousSignedStoch: previous.signedStoch,
            currentTime: current.time
        };
    }

    analyzeAccumulationH1(candlesH1, direction, sinceMs = null) {
        const cci = this.calculateCCI(candlesH1);
        if (cci.length < 2) return null;
        const stoch = this.calculateStochSeries(candlesH1);

        const offset = candlesH1.length - cci.length;
        let pairs = cci.map((value, i) => {
            const candleIndex = offset + i;
            const candle = candlesH1[candleIndex];
            const stochK = stoch[candleIndex];
            return {
                cci: value,
                signedCCI: this.directionalCCI(direction, value),
                stochK,
                signedStoch: this.directionalStoch(direction, stochK),
                candle,
                time: candle?.time
            };
        }).filter(pair => pair.candle && Number.isFinite(pair.signedCCI));

        if (Number.isFinite(Number(sinceMs))) {
            pairs = pairs.filter(pair => !Number.isFinite(Number(pair.time)) || Number(pair.time) >= Number(sinceMs));
        }
        pairs = pairs.slice(-this.settings.h1WindowCandles);
        if (pairs.length < 2) return null;

        let breaks100 = 0;
        let breaks130 = 0;
        let returnsBelow100 = 0;
        let crossUpMinus100 = 0;
        let crossUpZero = 0;
        let stochCrossUp20 = 0;

        for (let i = 1; i < pairs.length; i++) {
            const prev = pairs[i - 1].signedCCI;
            const cur = pairs[i].signedCCI;
            const prevStoch = pairs[i - 1].signedStoch;
            const curStoch = pairs[i].signedStoch;

            if (prev < -100 && cur >= -100) crossUpMinus100++;
            if (prev < 0 && cur >= 0) crossUpZero++;
            if (prev < 100 && cur >= 100) breaks100++;
            if (prev < 130 && cur >= 130) breaks130++;
            if (prev > 100 && cur < 100) returnsBelow100++;
            if (Number.isFinite(prevStoch) && Number.isFinite(curStoch) && prevStoch <= 20 && curStoch > 20) {
                stochCrossUp20++;
            }
        }

        const range = this.calculateRange(pairs.map(pair => pair.candle));
        const last = pairs[pairs.length - 1];
        const prev = pairs[pairs.length - 2];
        const signedCciValues = pairs.map(pair => pair.signedCCI).filter(Number.isFinite);
        const signedStochValues = pairs.map(pair => pair.signedStoch).filter(Number.isFinite);

        return {
            breaks100,
            breaks130,
            returnsBelow100,
            crossUpMinus100,
            crossUpZero,
            stochCrossUp20,
            rangePercent: range.rangePercent,
            rangeTop: range.top,
            rangeBottom: range.bottom,
            candlesAnalyzed: pairs.length,
            currentCCI: last.cci,
            previousCCI: prev.cci,
            currentSignedCCI: last.signedCCI,
            previousSignedCCI: prev.signedCCI,
            currentStoch: last.stochK,
            previousStoch: prev.stochK,
            currentSignedStoch: last.signedStoch,
            previousSignedStoch: prev.signedStoch,
            lowestSignedCCI: signedCciValues.length ? Math.min(...signedCciValues) : null,
            lowestSignedStoch: signedStochValues.length ? Math.min(...signedStochValues) : null
        };
    }

    buildH1Pairs(candlesH1, direction) {
        const cci = this.calculateCCI(candlesH1);
        if (cci.length < 2) return [];
        const stoch = this.calculateStochSeries(candlesH1);
        const offset = candlesH1.length - cci.length;

        return cci.map((value, i) => {
            const candleIndex = offset + i;
            const candle = candlesH1[candleIndex];
            const stochK = stoch[candleIndex];
            return {
                cci: value,
                signedCCI: this.directionalCCI(direction, value),
                stochK,
                signedStoch: this.directionalStoch(direction, stochK),
                candle,
                time: candle?.time
            };
        }).filter(pair => pair.candle && Number.isFinite(pair.signedCCI));
    }

    summarizeH1Crosses(pairs) {
        const scoped = (pairs || []).filter(pair => pair.candle && Number.isFinite(pair.signedCCI));
        if (scoped.length < 2) return null;

        const out = {
            cciCrossUpMinus100: 0,
            cciCrossUpZero: 0,
            cciCrossUp100: 0,
            cciCrossUp130: 0,
            cciReturnBelow100: 0,
            stochCrossUp20: 0,
            candles: scoped.length
        };

        for (let i = 1; i < scoped.length; i++) {
            const prev = scoped[i - 1].signedCCI;
            const cur = scoped[i].signedCCI;
            const prevStoch = scoped[i - 1].signedStoch;
            const curStoch = scoped[i].signedStoch;

            if (prev < -100 && cur >= -100) out.cciCrossUpMinus100++;
            if (prev < 0 && cur >= 0) out.cciCrossUpZero++;
            if (prev < 100 && cur >= 100) out.cciCrossUp100++;
            if (prev < 130 && cur >= 130) out.cciCrossUp130++;
            if (prev > 100 && cur < 100) out.cciReturnBelow100++;
            if (Number.isFinite(prevStoch) && Number.isFinite(curStoch) && prevStoch <= 20 && curStoch > 20) {
                out.stochCrossUp20++;
            }
        }

        const range = this.calculateRange(scoped.map(pair => pair.candle));
        out.rangePercent = range.rangePercent;
        out.rangeTop = range.top;
        out.rangeBottom = range.bottom;
        return out;
    }

    analyzeH1BeforeSync(candlesH1, direction, syncMs) {
        const sync = Number(syncMs);
        if (!Number.isFinite(sync)) return null;

        const pairs = this.buildH1Pairs(candlesH1, direction)
            .filter(pair => !Number.isFinite(Number(pair.time)) || Number(pair.time) < sync)
            .slice(-this.settings.h1WindowCandles);

        return this.summarizeH1Crosses(pairs);
    }

    analyzeReversalH1(candlesH1, direction, cycle) {
        const sync = Number(cycle?.h4SyncTime || cycle?.inicioMs);
        if (!Number.isFinite(sync)) return null;

        const pairs = this.buildH1Pairs(candlesH1, direction)
            .filter(pair => !Number.isFinite(Number(pair.time)) || Number(pair.time) >= sync)
            .slice(-this.settings.reversalH1Lookback);

        if (pairs.length < 2) return null;

        const current = pairs[pairs.length - 1];
        const previous = pairs[pairs.length - 2];
        const previousCandles = pairs.slice(0, -1).map(pair => pair.candle);
        const range = this.calculateRange(previousCandles);
        const cciValues = pairs.map(pair => pair.signedCCI).filter(Number.isFinite);
        const stochValues = pairs.map(pair => pair.signedStoch).filter(Number.isFinite);
        const avgVolumeCandles = previousCandles.slice(-this.settings.volumeLookbackCandles);
        const avgVolume = avgVolumeCandles.length
            ? avgVolumeCandles.reduce((sum, candle) => sum + Number(candle.volume || 0), 0) / avgVolumeCandles.length
            : null;
        const volumeRatio = avgVolume > 0 ? Number(current.candle.volume || 0) / avgVolume : null;

        const priceReclaim = direction === "SHORT"
            ? current.candle.close < previous.candle.low
            : current.candle.close > previous.candle.high;
        const brokeMicroRange = direction === "SHORT"
            ? Number.isFinite(range.bottom) && current.candle.close < range.bottom
            : Number.isFinite(range.top) && current.candle.close > range.top;

        const minCCI = cciValues.length ? Math.min(...cciValues) : null;
        const minStoch = stochValues.length ? Math.min(...stochValues) : null;
        const cciRising = current.signedCCI > previous.signedCCI;
        const stochRising = Number.isFinite(current.signedStoch) &&
            Number.isFinite(previous.signedStoch) &&
            current.signedStoch > previous.signedStoch;
        const cciRecovered = previous.signedCCI < this.settings.reversalCciRecovery &&
            current.signedCCI >= this.settings.reversalCciRecovery;
        const cciConfirmed = previous.signedCCI < this.settings.reversalCciConfirm &&
            current.signedCCI >= this.settings.reversalCciConfirm;
        const stochRecovered = Number.isFinite(previous.signedStoch) &&
            Number.isFinite(current.signedStoch) &&
            previous.signedStoch <= this.settings.reversalStochLevel &&
            current.signedStoch > this.settings.reversalStochLevel;
        const volumeOk = Number.isFinite(volumeRatio) && volumeRatio >= this.settings.reversalVolumeRatio;
        const priceOk = priceReclaim || brokeMicroRange;

        const candidate = cciRising && stochRising &&
            current.signedCCI >= this.settings.reversalCciRecovery &&
            (priceOk || volumeOk || cciRecovered);
        const confirmed = (cciConfirmed || current.signedCCI >= this.settings.reversalCciConfirm) &&
            (stochRecovered || current.signedStoch > this.settings.reversalStochLevel) &&
            (priceOk || volumeOk);

        return {
            candidate,
            confirmed,
            price: current.candle.close,
            cciH1: current.cci,
            signedCCI: current.signedCCI,
            previousSignedCCI: previous.signedCCI,
            stochH1: current.stochK,
            signedStoch: current.signedStoch,
            previousSignedStoch: previous.signedStoch,
            minCCI,
            minStoch,
            cciRising,
            stochRising,
            cciRecovered,
            cciConfirmed,
            stochRecovered,
            priceReclaim,
            brokeMicroRange,
            volumeRatio,
            rangeTop: range.top,
            rangeBottom: range.bottom,
            candlesAfterSync: pairs.length
        };
    }

    calculateRange(candles) {
        const valid = (candles || []).filter(c => Number.isFinite(c?.high) && Number.isFinite(c?.low));
        if (!valid.length) return { top: null, bottom: null, rangePercent: null };
        const top = Math.max(...valid.map(c => c.high));
        const bottom = Math.min(...valid.map(c => c.low));
        return {
            top,
            bottom,
            rangePercent: bottom > 0 ? ((top - bottom) / bottom) * 100 : null
        };
    }

    detectTrigger(candlesH1, direction, h1) {
        if (!candlesH1 || candlesH1.length < this.settings.h1WindowCandles + 1 || !h1) return null;

        const current = candlesH1[candlesH1.length - 1];
        const rangeCandles = candlesH1.slice(-(this.settings.h1WindowCandles + 1), -1);
        const volumeCandles = candlesH1.slice(-(this.settings.volumeLookbackCandles + 1), -1);
        const range = this.calculateRange(rangeCandles);
        const avgVolume = volumeCandles.length
            ? volumeCandles.reduce((sum, candle) => sum + Number(candle.volume || 0), 0) / volumeCandles.length
            : null;
        const volumeRatio = avgVolume > 0 ? Number(current.volume || 0) / avgVolume : null;

        const brokeRange = direction === "SHORT"
            ? Number.isFinite(range.bottom) && current.close < range.bottom
            : Number.isFinite(range.top) && current.close > range.top;

        const cciOk = h1.currentSignedCCI >= this.settings.triggerCci;
        const volumeOk = Number.isFinite(volumeRatio) && volumeRatio >= this.settings.triggerVolumeRatio;

        return {
            triggered: cciOk && volumeOk && brokeRange,
            price: current.close,
            cci: h1.currentCCI,
            signedCCI: h1.currentSignedCCI,
            volumeRatio,
            avgVolume,
            rangeTop: range.top,
            rangeBottom: range.bottom,
            brokeRange,
            cciOk,
            volumeOk
        };
    }

    applyOpenInterest(target, oi) {
        if (!target || !oi) return target;
        target.openInterest = Number.isFinite(Number(oi.openInterest)) ? Number(oi.openInterest) : null;
        target.openInterestValue = Number.isFinite(Number(oi.openInterestValue)) ? Number(oi.openInterestValue) : null;
        target.openInterestPrevious = Number.isFinite(Number(oi.previousOpenInterest)) ? Number(oi.previousOpenInterest) : null;
        target.openInterestChange = Number.isFinite(Number(oi.change)) ? Number(oi.change) : null;
        target.openInterestChangePct = Number.isFinite(Number(oi.changePct)) ? Number(oi.changePct) : null;
        target.openInterestTrend = oi.trend || null;
        target.openInterestPeriod = oi.period || null;
        target.openInterestPoints = Number.isFinite(Number(oi.points)) ? Number(oi.points) : null;
        return target;
    }

    async fetchOpenInterestContext(symbol) {
        const fn = this.getOpenInterestTrend || this.getOpenInterest;
        if (!fn) return null;
        try {
            return await fn(symbol);
        } catch (e) {
            return null;
        }
    }

    async attachOpenInterest(symbol, target) {
        const oi = await this.fetchOpenInterestContext(symbol);
        return this.applyOpenInterest(target, oi);
    }

    async enrichWithTaker(symbol, trigger, direction) {
        if (!trigger || !trigger.triggered) return trigger;
        let enriched = { ...trigger };

        if (this.getTakerVolume) {
            try {
                const takerData = await this.getTakerVolume(symbol);
                const ratio = Number(takerData?.buyRatio);
                const aligned = direction === "SHORT"
                    ? Number.isFinite(ratio) && ratio <= 0.85
                    : Number.isFinite(ratio) && ratio >= 1.15;
                enriched = {
                    ...enriched,
                    takerData,
                    takerRatio: Number.isFinite(ratio) ? ratio : null,
                    takerAligned: aligned,
                    takerBuyPct: Number.isFinite(Number(takerData?.buyPct)) ? Number(takerData.buyPct) : null,
                    takerSellPct: Number.isFinite(Number(takerData?.sellPct)) ? Number(takerData.sellPct) : null
                };
            } catch (e) {}
        }

        try {
            await this.attachOpenInterest(symbol, enriched);
        } catch (e) {
            return enriched;
        }

        return enriched;
    }

    async enrichReversal(symbol, reversal, direction) {
        if (!reversal || (!reversal.candidate && !reversal.confirmed)) return reversal;
        const enriched = { ...reversal };

        if (this.getTakerVolume) {
            try {
                const takerData = await this.getTakerVolume(symbol);
                const ratio = Number(takerData?.buyRatio);
                enriched.takerData = takerData;
                enriched.takerRatio = Number.isFinite(ratio) ? ratio : null;
                enriched.takerAligned = direction === "SHORT"
                    ? Number.isFinite(ratio) && ratio <= 0.85
                    : Number.isFinite(ratio) && ratio >= 1.15;
                enriched.takerBuyPct = Number.isFinite(Number(takerData?.buyPct)) ? Number(takerData.buyPct) : null;
                enriched.takerSellPct = Number.isFinite(Number(takerData?.sellPct)) ? Number(takerData.sellPct) : null;
            } catch (e) {}
        }

        await this.attachOpenInterest(symbol, enriched);

        return enriched;
    }

    createCycle(symbol, direction, h4) {
        const now = Date.now();
        return {
            schemaVersion: 1,
            id: `${symbol}_${direction}_${now}`,
            symbol,
            direction,
            estado: "H4_SYNC_RESET",
            inicio: new Date(now).toISOString(),
            inicioMs: now,
            inicioH4Time: h4.currentTime || null,
            syncPrice: h4.syncPrice,
            cciH4Min: h4.cciMinRaw,
            stochH4Min: h4.stochMinRaw,
            cciH4MinSigned: h4.cciMinSigned,
            stochH4MinSigned: h4.stochMinSigned,
            h4Recarregado: true,
            h4Extreme: !!h4.extreme,
            h4SyncedBottom: !!h4.syncedBottom,
            h4SyncDistanceCandles: h4.syncDistanceCandles,
            h4SyncTime: h4.syncTime,
            h4TurningUp: !!h4.turningUp,
            h4CurrentCCI: h4.currentCCI,
            h4CurrentStoch: h4.currentStoch,
            h1BeforeSync: null,
            reversal: null,
            rompimentos100: 0,
            rompimentos130: 0,
            voltouAbaixo100: 0,
            rangePercent: null,
            rangeTop: null,
            rangeBottom: null,
            candlesAnalisados: 0,
            scoreIncubadora: 0,
            alertas: {},
            performance: {
                maxGain5h: null,
                maxGain24h: null,
                maxGain72h: null,
                maxDrawdown: null
            },
            updatedAt: now
        };
    }

    updateCycleFromH4(cycle, h4) {
        cycle.cciH4Min = h4.cciMinRaw;
        cycle.stochH4Min = h4.stochMinRaw;
        cycle.cciH4MinSigned = h4.cciMinSigned;
        cycle.stochH4MinSigned = h4.stochMinSigned;
        cycle.h4Extreme = !!h4.extreme;
        if (h4.syncedBottom) {
            cycle.h4SyncedBottom = true;
            cycle.h4SyncDistanceCandles = h4.syncDistanceCandles;
            cycle.h4SyncTime = h4.syncTime ?? cycle.h4SyncTime;
            cycle.syncPrice = h4.syncPrice ?? cycle.syncPrice;
        }
        cycle.h4TurningUp = !!h4.turningUp;
        cycle.h4CurrentCCI = h4.currentCCI;
        cycle.h4CurrentStoch = h4.currentStoch;
        cycle.updatedAt = Date.now();
    }

    updateCycleFromH1(cycle, h1) {
        cycle.rompimentos100 = h1.breaks100;
        cycle.rompimentos130 = h1.breaks130;
        cycle.voltouAbaixo100 = h1.returnsBelow100;
        cycle.recuperouMenos100H1 = h1.crossUpMinus100;
        cycle.recuperouZeroH1 = h1.crossUpZero;
        cycle.stochCrossUp20H1 = h1.stochCrossUp20;
        cycle.rangePercent = h1.rangePercent;
        cycle.rangeTop = h1.rangeTop;
        cycle.rangeBottom = h1.rangeBottom;
        cycle.candlesAnalisados = h1.candlesAnalyzed;
        cycle.cciH1Atual = h1.currentCCI;
        cycle.cciH1Direcional = h1.currentSignedCCI;
        cycle.stochH1Atual = h1.currentStoch;
        cycle.stochH1Direcional = h1.currentSignedStoch;
        cycle.scoreIncubadora = this.calculateScore(cycle);
        cycle.updatedAt = Date.now();
    }

    calculateScore(cycle, trigger = null) {
        let score = 0;
        score += cycle.h4Extreme ? 30 : 20;
        if (cycle.h4SyncedBottom) {
            score += Number(cycle.h4SyncDistanceCandles) === 0 ? 15 : 10;
        }
        score += Math.min(25, (cycle.rompimentos100 || 0) * 5);
        score += Math.min(15, (cycle.rompimentos130 || 0) * 5);

        const range = Number(cycle.rangePercent);
        if (Number.isFinite(range)) {
            if (range <= 8) score += 20;
            else if (range <= 12) score += 15;
            else if (range <= this.settings.maxRangePercent) score += 10;
        }

        const volumeRatio = Number(trigger?.volumeRatio || cycle.volumeRatio);
        if (Number.isFinite(volumeRatio)) {
            if (volumeRatio >= 2.5) score += 15;
            else if (volumeRatio >= this.settings.triggerVolumeRatio) score += 10;
        }

        if (trigger?.takerAligned) score += 10;
        if (cycle.reversal?.confirmed) score += 15;
        else if (cycle.reversal?.candidate) score += 8;
        if (cycle.reversal?.takerAligned) score += 5;
        return Math.max(0, Math.min(100, score));
    }

    isAccumulation(h1) {
        return h1 &&
            h1.breaks100 >= this.settings.minBreaks100 &&
            Number.isFinite(h1.rangePercent) &&
            h1.rangePercent <= this.settings.maxRangePercent;
    }

    shouldSend(cycle, key) {
        const now = Date.now();
        const last = Number(cycle.alertas?.[key] || 0);
        return !last || now - last >= this.settings.minAlertIntervalMs;
    }

    markSent(cycle, key) {
        if (!cycle.alertas) cycle.alertas = {};
        cycle.alertas[key] = Date.now();
    }

    recordEvent(cycle, type, details = {}) {
        this.appendJsonl(this.eventsFile, {
            schemaVersion: 1,
            at: Date.now(),
            type,
            cycleId: cycle.id,
            symbol: cycle.symbol,
            direction: cycle.direction,
            estado: cycle.estado,
            details
        });
    }

    recordCycle(cycle, type) {
        this.appendJsonl(this.cyclesFile, {
            schemaVersion: 1,
            type,
            recordedAt: Date.now(),
            ...cycle
        });
    }

    formatDateTime(ms) {
        const n = Number(ms);
        if (!Number.isFinite(n)) return "-";
        return new Date(n).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
    }

    fmt(value, digits = 1) {
        const n = Number(value);
        return Number.isFinite(n) ? n.toFixed(digits) : "-";
    }

    fmtPct(value, digits = 1) {
        const n = Number(value);
        return Number.isFinite(n) ? `${n.toFixed(digits)}%` : "-";
    }

    buildOpenInterestLine(data) {
        const oi = Number(data?.openInterest);
        if (!Number.isFinite(oi)) return "";
        const arrow = data.openInterestTrend === "UP" ? "↑" :
            data.openInterestTrend === "DOWN" ? "↓" : "→";
        const change = Number(data.openInterestChangePct);
        const changeText = Number.isFinite(change) ? ` ${arrow} ${this.fmtPct(change, 2)}` : "";
        const windowText = data.openInterestPeriod && data.openInterestPoints
            ? `/${data.openInterestPeriod} x${data.openInterestPoints}`
            : "";
        return `│ OI: ${this.fmt(oi, 0)} contratos${changeText}${windowText}\n`;
    }

    buildCycleH4CrossContext(cycle, at = Date.now(), currentPrice = null) {
        const lookbackHours = this.settings.h4CrossLookbackMs / 3600000;
        const empty = (extra = {}) => ({
            found: false,
            source: "INCUBADORA_H4_SYNC",
            lookbackHours,
            ...extra
        });

        if (!cycle) return empty();

        const atMs = Number(at || Date.now());
        const syncMs = Number(cycle.h4SyncTime || cycle.inicioH4Time || cycle.inicioMs);
        if (!Number.isFinite(atMs) || !Number.isFinite(syncMs) || syncMs <= 0) return empty();

        const ageMs = atMs - syncMs;
        const ageHours = ageMs / 3600000;
        if (ageMs < 0 || ageMs > this.settings.h4CrossLookbackMs) {
            return empty({ ageHours });
        }

        const direction = cycle.direction || "LONG";
        const priceAtCross = Number(cycle.syncPrice);
        const priceNow = Number(
            currentPrice ?? cycle.precoDisparo ?? cycle.reversal?.price ?? cycle.syncPrice
        );
        const rawMovePct = Number.isFinite(priceNow) && Number.isFinite(priceAtCross) && priceAtCross > 0
            ? ((priceNow - priceAtCross) / priceAtCross) * 100
            : null;
        const directionalMovePct = Number.isFinite(rawMovePct)
            ? (direction === "SHORT" ? -rawMovePct : rawMovePct)
            : null;
        const cciSync = Number(cycle.cciH4Min);
        const stochSync = Number(cycle.stochH4Min);

        return {
            found: true,
            fallback: true,
            symbol: cycle.symbol || null,
            direction,
            source: "INCUBADORA_H4_SYNC",
            lookbackHours,
            candleCloseTime: syncMs,
            ageHours,
            priceAtCross: Number.isFinite(priceAtCross) ? priceAtCross : null,
            currentPrice: Number.isFinite(priceNow) ? priceNow : null,
            rawMovePct,
            directionalMovePct,
            prevCci: null,
            lastCci: Number.isFinite(cciSync) ? cciSync : cycle.h4CurrentCCI,
            crossLabel: direction === "SHORT" ? "sync topo H4" : "sync fundo H4",
            stochK: Number.isFinite(stochSync) ? stochSync : cycle.h4CurrentStoch,
            stochD: null,
            stochExtremeK: Number.isFinite(stochSync) ? stochSync : null,
            stochExtremeD: null,
            stochExtremeLabel: direction === "SHORT" ? "topo" : "fundo"
        };
    }

    findH4SyncContext(symbol, direction, at = Date.now(), currentPrice = null) {
        const cycle = this.cycles.get(this.key(symbol, direction));
        return this.buildCycleH4CrossContext(cycle, at, currentPrice);
    }

    buildH4CrossLine(data) {
        const ctx = data?.h4Cross;
        if (!ctx) return "";
        if (!ctx.found) return `│ Radar H4: sem cruzamento/sync recente\n`;
        const move = Number.isFinite(Number(ctx.directionalMovePct))
            ? `${ctx.directionalMovePct >= 0 ? "+" : ""}${Number(ctx.directionalMovePct).toFixed(2)}%`
            : "-";
        const age = Number.isFinite(Number(ctx.ageHours)) ? `${Number(ctx.ageHours).toFixed(1)}h` : "-";
        const price = Number.isFinite(Number(ctx.priceAtCross)) ? `$${this.formatPrice(Number(ctx.priceAtCross))}` : "-";
        const label = ctx.fallback || ctx.source === "INCUBADORA_H4_SYNC"
            ? "sync incubadora"
            : "cruzou scanner";
        return `│ Radar H4: ${label} ha ${age} | ${price} | mov. ${move}\n`;
    }

    async attachH4CrossContext(symbol, direction, target) {
        if (!target) return target;
        const at = Date.now();
        const price = target.price || target.precoDisparo || target.reversal?.price || target.syncPrice;

        try {
            const scannerContext = this.getH4CrossContext
                ? await this.getH4CrossContext(symbol, direction, at, price)
                : null;
            if (scannerContext?.found) {
                target.h4Cross = scannerContext;
                return target;
            }

            const syncContext = this.buildCycleH4CrossContext(target, at, price);
            target.h4Cross = syncContext?.found
                ? syncContext
                : (scannerContext || syncContext || { found: false });
        } catch (e) {
            target.h4Cross = this.buildCycleH4CrossContext(target, at, price) || { found: false };
        }
        return target;
    }

    labels(direction) {
        const isShort = direction === "SHORT";
        return {
            h4Recharge: isShort ? "H4 LIMPOU TOPO" : "H4 RECARREGADO",
            h4Reset: isShort ? "H4 TOPO SINCRONIZADO" : "H4 RESET SINCRONIZADO",
            h4Clean: isShort ? "H4 LIMPOU TOPO" : "H4 LIMPOU FUNDO",
            cciExtreme: isShort ? "CCI H4 maximo" : "CCI H4 minimo",
            stochExtreme: isShort ? "Stoch H4 maximo" : "Stoch H4 minimo",
            aligned: isShort ? "CCI + Stoch alinharam topo" : "CCI + Stoch alinharam fundo",
            state: isShort ? "ACUMULO H1 vendido apos recarga H4" : "ACUMULO H1 apos recarga H4",
            break100: isShort ? "Rompimentos CCI <-100" : "Rompimentos CCI >100",
            break130: isShort ? "Rompimentos CCI <-130" : "Rompimentos CCI >130",
            return100: isShort ? "Voltas acima de -100" : "Voltas abaixo de 100",
            cci100: isShort ? "CCI <-100" : "CCI >100",
            cci130: isShort ? "CCI <-130" : "CCI >130",
            crossMinus100: isShort ? "CCI perdeu +100" : "CCI recuperou -100",
            crossZero: isShort ? "CCI perdeu 0" : "CCI recuperou 0",
            stochCross: isShort ? "Stoch perdeu 80" : "Stoch cruzou 20",
            rangeBreak: isShort ? "fundo" : "topo",
            reversalNext: isShort
                ? "Proxima fase: H1 virar para baixo com volume, taker ou rompimento de micro range."
                : "Proxima fase: H1 recuperar -100/0 com volume, taker ou rompimento de micro range.",
            next: isShort
                ? "Proxima fase: aguardar disparo vendido com volume/taker"
                : "Proxima fase: aguardar disparo com volume/taker"
        };
    }

    buildH4SyncLine(cycle) {
        const distance = Number(cycle.h4SyncDistanceCandles);
        if (!cycle.h4SyncedBottom || !Number.isFinite(distance)) {
            return `│ Sincronia: nao confirmada\n`;
        }
        const label = distance === 0
            ? "exata, mesmo candle"
            : `janela curta, ${distance} candle${distance > 1 ? "s" : ""}`;
        return `│ Sincronia: ${label}\n`;
    }

    buildAccumulationMessage(cycle) {
        const labels = this.labels(cycle.direction);
        const oiLine = this.buildOpenInterestLine(cycle);
        return `🥚 *INCUBADORA DETECTOU OVO EM GESTAÇÃO*\n\n` +
            `💹 *${cycle.symbol}*\n` +
            `📍 Direção: *${cycle.direction}*\n` +
            `📍 Estado: *${labels.state}*\n` +
            `⭐ Score incubadora: *${this.fmt(cycle.scoreIncubadora, 0)}/100*\n\n` +
            `┌─ 🔋 *${labels.h4Recharge}* ─────────\n` +
            `│ ${labels.cciExtreme}: ${this.fmt(cycle.cciH4Min, 1)}\n` +
            `│ ${labels.stochExtreme}: ${this.fmt(cycle.stochH4Min, 1)}\n` +
            `│ Leitura: ${labels.aligned}${cycle.h4Extreme ? " extremo" : ""}\n` +
            `└────────────────────────────\n\n` +
            `┌─ 🥚 *ACÚMULO H1* ─────────────\n` +
            `│ ${labels.break100}: ${cycle.rompimentos100}x\n` +
            `│ ${labels.break130}: ${cycle.rompimentos130}x\n` +
            `│ ${labels.return100}: ${cycle.voltouAbaixo100}x\n` +
            `│ Range: ${this.fmtPct(cycle.rangePercent, 1)}\n` +
            oiLine +
            `│ Leitura: compressão com insistência\n` +
            `└────────────────────────────\n\n` +
            `🚀 ${labels.next}\n` +
            `🔗 ${this.tvLink(cycle.symbol)}\n` +
            `⚠️ _Não é conselho financeiro._`;
    }

    buildSyncResetMessage(cycle) {
        const labels = this.labels(cycle.direction);
        return `🧭 *INCUBADORA — H4 SYNC RESET*\n\n` +
            `💹 *${cycle.symbol}*\n` +
            `📍 Direcao: *${cycle.direction}*\n` +
            `💰 Preco sync: ${Number.isFinite(Number(cycle.syncPrice)) ? `$${this.formatPrice(Number(cycle.syncPrice))}` : "-"}\n\n` +
            `┌─ ${labels.h4Reset} ─────\n` +
            `│ ${labels.cciExtreme}: ${this.fmt(cycle.cciH4Min, 1)}\n` +
            `│ ${labels.stochExtreme}: ${this.fmt(cycle.stochH4Min, 1)}\n` +
            this.buildH4SyncLine(cycle) +
            `│ Estado: vigia de reversao, sem entrada\n` +
            `└────────────────────────────\n\n` +
            `🔎 ${labels.reversalNext}\n` +
            `🔗 ${this.tvLink(cycle.symbol)}\n` +
            `⚠️ _Nao e conselho financeiro._`;
    }

    buildReversalMessage(cycle) {
        const labels = this.labels(cycle.direction);
        const rev = cycle.reversal || {};
        const before = cycle.h1BeforeSync || {};
        const takerLine = Number.isFinite(Number(rev.takerRatio))
            ? `│ Taker ratio: ${this.fmt(rev.takerRatio, 2)}${rev.takerAligned ? " alinhado" : ""}\n`
            : "";
        const oiLine = this.buildOpenInterestLine(rev);
        const label = rev.confirmed ? "CONFIRMADA" : "INICIAL";

        return `🟢 *INCUBADORA — REVERSAO POS SYNC H4* 🟢\n\n` +
            `💹 *${cycle.symbol}*\n` +
            `📍 Direcao: *${cycle.direction}*\n` +
            `📍 Estado: *${label}*\n` +
            `⭐ Score incubadora: *${this.fmt(cycle.scoreIncubadora, 0)}/100*\n\n` +
            `┌─ H4 SYNC RESET ─────────────\n` +
            `│ ${labels.cciExtreme}: ${this.fmt(cycle.cciH4Min, 1)}\n` +
            `│ ${labels.stochExtreme}: ${this.fmt(cycle.stochH4Min, 1)}\n` +
            this.buildH4SyncLine(cycle) +
            `└────────────────────────────\n\n` +
            `┌─ H1 ANTES DO RESET ─────────\n` +
            `│ ${labels.crossMinus100}: ${before.cciCrossUpMinus100 ?? 0}x\n` +
            `│ ${labels.crossZero}: ${before.cciCrossUpZero ?? 0}x\n` +
            `│ ${labels.cci100}: ${before.cciCrossUp100 ?? 0}x | ${labels.cci130}: ${before.cciCrossUp130 ?? 0}x\n` +
            `│ ${labels.stochCross}: ${before.stochCrossUp20 ?? 0}x\n` +
            `└────────────────────────────\n\n` +
            `┌─ H1 VIRANDO AGORA ──────────\n` +
            `│ CCI H1: ${this.fmt(rev.cciH1, 1)}\n` +
            `│ Stoch H1: ${this.fmt(rev.stochH1, 1)}\n` +
            `│ Volume: ${this.fmt(rev.volumeRatio, 2)}x\n` +
            takerLine +
            oiLine +
            `│ Preco: $${this.formatPrice(rev.price)}\n` +
            `│ Range rompido: ${rev.brokeMicroRange ? "sim" : "nao"}\n` +
            `└────────────────────────────\n\n` +
            `📌 Modo observador: reversao detectada, aguardar disparo/confirmacao do range.\n` +
            `🔗 ${this.tvLink(cycle.symbol)}\n` +
            `⚠️ _Nao e conselho financeiro._`;
    }

    buildTriggerMessage(cycle) {
        const labels = this.labels(cycle.direction);
        const takerLine = Number.isFinite(Number(cycle.takerRatio))
            ? `│ Taker ratio: ${this.fmt(cycle.takerRatio, 2)}${cycle.takerAligned ? " ✅ alinhado" : ""}\n`
            : "";
        const oiLine = this.buildOpenInterestLine(cycle);
        const h4CrossLine = this.buildH4CrossLine(cycle);

        return `🚀 *INCUBADORA — OVO EXPLOSIVO NASCEU*\n\n` +
            `💹 *${cycle.symbol}*\n` +
            `📍 Direção: *${cycle.direction}*\n` +
            `⏰ Incubação: ${this.fmt((Date.now() - cycle.inicioMs) / 3600000, 1)}h\n` +
            `⭐ Score incubadora: *${this.fmt(cycle.scoreIncubadora, 0)}/100*\n\n` +
            `┌─ 🔋 *${labels.h4Clean}* ────────\n` +
            `│ ${labels.cciExtreme}: ${this.fmt(cycle.cciH4Min, 1)}\n` +
            `│ ${labels.stochExtreme}: ${this.fmt(cycle.stochH4Min, 1)}\n` +
            `│ Estado: ${cycle.h4Extreme ? "recarga extrema" : "recarga"}\n` +
            `└────────────────────────────\n\n` +
            `┌─ 🥚 *ACÚMULO ANTES DO DISPARO* ─\n` +
            `│ ${labels.cci100}: ${cycle.rompimentos100}x | ${labels.cci130}: ${cycle.rompimentos130}x\n` +
            `│ ${labels.return100}: ${cycle.voltouAbaixo100}x\n` +
            `│ Range antes: ${this.fmtPct(cycle.rangePercent, 1)}\n` +
            `└────────────────────────────\n\n` +
            `┌─ 🚀 *DISPARO* ────────────────\n` +
            `│ Preço: $${this.formatPrice(cycle.precoDisparo)}\n` +
            `│ CCI H1: ${this.fmt(cycle.cciH1Disparo, 1)}\n` +
            `│ Volume: ${this.fmt(cycle.volumeRatio, 2)}x\n` +
            takerLine +
            oiLine +
            h4CrossLine +
            `│ Range rompido: ${labels.rangeBreak} H1\n` +
            `└────────────────────────────\n\n` +
            `📌 Modo observador: a incubadora só classificou e registrou o ciclo.\n` +
            `🔗 ${this.tvLink(cycle.symbol)}\n` +
            `⚠️ _Não é conselho financeiro._`;
    }

    updatePerformance(cycle, candlesH1) {
        if (cycle.estado !== "DISPARO" || !Number.isFinite(Number(cycle.dataDisparoMs))) return;

        const entry = Number(cycle.precoDisparo);
        if (!Number.isFinite(entry) || entry <= 0) return;

        const windows = [
            { key: "maxGain5h", hours: 5 },
            { key: "maxGain24h", hours: 24 },
            { key: "maxGain72h", hours: 72 }
        ];
        if (!cycle.performance) cycle.performance = {};

        const candles = candlesH1.filter(candle =>
            Number.isFinite(Number(candle.time)) &&
            Number(candle.time) >= Number(cycle.dataDisparoMs)
        );

        for (const window of windows) {
            const until = Number(cycle.dataDisparoMs) + window.hours * 3600000;
            const scoped = candles.filter(candle => Number(candle.time) <= until);
            const gains = scoped.map(candle => {
                const favorable = cycle.direction === "SHORT" ? candle.low : candle.high;
                const raw = ((favorable - entry) / entry) * 100;
                return cycle.direction === "SHORT" ? -raw : raw;
            }).filter(Number.isFinite);
            if (gains.length) cycle.performance[window.key] = Math.max(...gains);
        }

        const drawdowns = candles.map(candle => {
            const adverse = cycle.direction === "SHORT" ? candle.high : candle.low;
            const raw = ((adverse - entry) / entry) * 100;
            return cycle.direction === "SHORT" ? -raw : raw;
        }).filter(Number.isFinite);
        if (drawdowns.length) cycle.performance.maxDrawdown = Math.min(...drawdowns);
        cycle.updatedAt = Date.now();
    }

    async analyze(symbol, data = {}) {
        if (!this.settings.enabled || !symbol) return null;

        const candlesH1 = this.closedCandles(data.candlesH1, 60 * 60 * 1000);
        const candlesH4 = this.closedCandles(data.candlesH4, 4 * 60 * 60 * 1000);
        if (candlesH1.length < 30 || candlesH4.length < 25) return null;

        const directions = [];
        if (this.settings.longActive) directions.push("LONG");
        if (this.settings.shortActive) directions.push("SHORT");

        for (const direction of directions) {
            await this.analyzeDirection(symbol, direction, candlesH1, candlesH4);
        }

        this.save();
        return true;
    }

    async analyzeDirection(symbol, direction, candlesH1, candlesH4) {
        const key = this.key(symbol, direction);
        let cycle = this.cycles.get(key);

        if (cycle?.estado === "DISPARO") {
            this.updatePerformance(cycle, candlesH1);
            return;
        }

        const h4 = this.analyzeH4(candlesH4, direction);
        if (!h4) return;

        if (!cycle) {
            if (!h4.cleaned) return;
            cycle = this.createCycle(symbol, direction, h4);
            this.cycles.set(key, cycle);
            this.recordEvent(cycle, "H4_SYNC_RESET", {
                cciH4Min: cycle.cciH4Min,
                stochH4Min: cycle.stochH4Min,
                h4Extreme: cycle.h4Extreme,
                h4SyncedBottom: cycle.h4SyncedBottom,
                h4SyncDistanceCandles: cycle.h4SyncDistanceCandles,
                syncPrice: cycle.syncPrice
            });
            if (this.settings.alertSyncReset && this.shouldSend(cycle, "H4_SYNC_RESET")) {
                this.markSent(cycle, "H4_SYNC_RESET");
                await this.sendTelegram(this.buildSyncResetMessage(cycle));
            }
        } else {
            this.updateCycleFromH4(cycle, h4);
        }

        const h1 = this.analyzeAccumulationH1(candlesH1, direction);
        if (!h1) return;

        this.updateCycleFromH1(cycle, h1);
        cycle.h1BeforeSync = this.analyzeH1BeforeSync(candlesH1, direction, cycle.h4SyncTime);

        const reversal = await this.enrichReversal(
            symbol,
            this.analyzeReversalH1(candlesH1, direction, cycle),
            direction
        );

        if (reversal?.candidate && ["H4_SYNC_RESET", "INCUBACAO_H4"].includes(cycle.estado)) {
            cycle.estado = "REVERSAO_POS_SYNC_H4";
            cycle.reversal = reversal;
            cycle.scoreIncubadora = this.calculateScore(cycle);
            cycle.updatedAt = Date.now();
            this.recordEvent(cycle, "REVERSAO_POS_SYNC_H4", {
                confirmed: reversal.confirmed,
                price: reversal.price,
                cciH1: reversal.cciH1,
                stochH1: reversal.stochH1,
                volumeRatio: reversal.volumeRatio,
                takerRatio: reversal.takerRatio,
                openInterest: reversal.openInterest,
                openInterestTrend: reversal.openInterestTrend,
                openInterestChangePct: reversal.openInterestChangePct,
                h1BeforeSync: cycle.h1BeforeSync
            });
            if (this.settings.alertReversal && this.shouldSend(cycle, "REVERSAO_POS_SYNC_H4")) {
                this.markSent(cycle, "REVERSAO_POS_SYNC_H4");
                await this.sendTelegram(this.buildReversalMessage(cycle));
            }
        } else if (reversal?.candidate && cycle.estado === "REVERSAO_POS_SYNC_H4") {
            cycle.reversal = reversal;
            cycle.scoreIncubadora = this.calculateScore(cycle);
            cycle.updatedAt = Date.now();
        }

        if (this.isAccumulation(h1) && ["H4_SYNC_RESET", "INCUBACAO_H4", "REVERSAO_POS_SYNC_H4"].includes(cycle.estado)) {
            cycle.estado = "ACUMULO_H1";
            await this.attachOpenInterest(symbol, cycle);
            this.recordEvent(cycle, "ACUMULO_H1", {
                rompimentos100: cycle.rompimentos100,
                rompimentos130: cycle.rompimentos130,
                rangePercent: cycle.rangePercent,
                openInterest: cycle.openInterest,
                openInterestTrend: cycle.openInterestTrend,
                openInterestChangePct: cycle.openInterestChangePct,
                h1BeforeSync: cycle.h1BeforeSync
            });
            if (this.settings.alertAcumulo && this.shouldSend(cycle, "ACUMULO_H1")) {
                this.markSent(cycle, "ACUMULO_H1");
                await this.sendTelegram(this.buildAccumulationMessage(cycle));
            }
        }

        const trigger = await this.enrichWithTaker(
            symbol,
            this.detectTrigger(candlesH1, direction, h1),
            direction
        );

        if (trigger?.triggered && ["ACUMULO_H1", "REVERSAO_POS_SYNC_H4"].includes(cycle.estado)) {
            cycle.estado = "DISPARO";
            cycle.precoDisparo = trigger.price;
            cycle.cciH1Disparo = trigger.cci;
            cycle.cciH1DirecionalDisparo = trigger.signedCCI;
            cycle.volumeRatio = trigger.volumeRatio;
            cycle.topoRangeH1 = trigger.rangeTop;
            cycle.fundoRangeH1 = trigger.rangeBottom;
            cycle.takerRatio = trigger.takerRatio;
            cycle.takerBuyPct = trigger.takerBuyPct;
            cycle.takerSellPct = trigger.takerSellPct;
            cycle.takerAligned = !!trigger.takerAligned;
            cycle.openInterest = trigger.openInterest;
            cycle.openInterestValue = trigger.openInterestValue;
            cycle.openInterestPrevious = trigger.openInterestPrevious;
            cycle.openInterestChange = trigger.openInterestChange;
            cycle.openInterestChangePct = trigger.openInterestChangePct;
            cycle.openInterestTrend = trigger.openInterestTrend;
            cycle.openInterestPeriod = trigger.openInterestPeriod;
            cycle.openInterestPoints = trigger.openInterestPoints;
            cycle.dataDisparo = new Date().toISOString();
            cycle.dataDisparoMs = Date.now();
            await this.attachH4CrossContext(symbol, direction, cycle);
            cycle.scoreIncubadora = this.calculateScore(cycle, trigger);
            cycle.updatedAt = Date.now();

            this.recordEvent(cycle, "DISPARO", {
                precoDisparo: cycle.precoDisparo,
                cciH1Disparo: cycle.cciH1Disparo,
                volumeRatio: cycle.volumeRatio,
                takerRatio: cycle.takerRatio,
                openInterest: cycle.openInterest,
                openInterestTrend: cycle.openInterestTrend,
                openInterestChangePct: cycle.openInterestChangePct,
                h4Cross: cycle.h4Cross,
                scoreIncubadora: cycle.scoreIncubadora
            });
            this.recordCycle(cycle, "DISPARO");

            if (this.settings.alertDisparo && this.shouldSend(cycle, "DISPARO")) {
                this.markSent(cycle, "DISPARO");
                await this.sendTelegram(this.buildTriggerMessage(cycle));
            }
        }
    }

    cleanupOldCycles() {
        const now = Date.now();
        let removed = 0;
        for (const [key, cycle] of this.cycles.entries()) {
            const start = Number(cycle.inicioMs || cycle.updatedAt || now);
            if (now - start > this.settings.maxCycleAgeMs) {
                this.cycles.delete(key);
                removed++;
            }
        }
        if (removed > 0) {
            console.log(`🧹 Incubadora removeu ${removed} ciclos antigos`);
            this.save();
        }
        return removed;
    }

    getWatchingCount() {
        return this.cycles.size;
    }
}

module.exports = Incubadora;
