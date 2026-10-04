const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { CCI, Stochastic } = require("technicalindicators");

class StochCciH4Scanner {
    constructor(CONFIG, sendTelegram, formatPrice, tvLink, options = {}) {
        this.CONFIG = CONFIG || {};
        this.sendTelegram = sendTelegram || (async () => {});
        this.formatPrice = formatPrice || ((value) => String(value));
        this.tvLink = tvLink || ((symbol) => symbol);
        this.getTakerVolume = options.getTakerVolume || null;
        this.getOpenInterest = options.getOpenInterest || null;
        this.getOpenInterestTrend = options.getOpenInterestTrend || null;

        const cfg = this.CONFIG.STOCH_CCI_H4_SCANNER || {};
        this.settings = {
            enabled: cfg.ENABLED !== false,
            longActive: cfg.LONG_ACTIVE !== false,
            shortActive: cfg.SHORT_ACTIVE !== false,
            timeframe: cfg.TIMEFRAME || "4h",
            klineLimit: this.int(cfg.KLINE_LIMIT, 220),
            cciPeriod: this.int(cfg.CCI_PERIOD, 20),
            cciOversold: this.num(cfg.CCI_OVERSOLD, -200),
            cciOverbought: this.num(cfg.CCI_OVERBOUGHT, 200),
            stochPeriod: this.int(cfg.STOCH_PERIOD, 14),
            stochSignalPeriod: this.int(cfg.STOCH_SIGNAL_PERIOD, 3),
            stochOversold: this.num(cfg.STOCH_OVERSOLD, 20),
            stochOverbought: this.num(cfg.STOCH_OVERBOUGHT, 80),
            syncLookback: this.int(cfg.SIGNAL_LOOKBACK_CANDLES, 4),
            minQuoteVolume: this.num(cfg.MIN_QUOTE_VOLUME_USDT, 0),
            maxSymbols: this.int(cfg.MAX_SYMBOLS, 0),
            concurrency: this.int(cfg.CONCURRENCY, 8),
            requestDelayMs: this.int(cfg.REQUEST_DELAY_MS, 80),
            runGraceMs: this.int(cfg.RUN_GRACE_MINUTES, 3) * 60 * 1000,
            crossLookbackMs: this.num(cfg.CROSS_LOOKBACK_HOURS, 168) * 60 * 60 * 1000,
            alertWhenEmpty: cfg.ALERT_WHEN_EMPTY === true,
            enrichTaker: cfg.ENRICH_TAKER !== false,
            enrichOpenInterest: cfg.ENRICH_OPEN_INTEREST !== false,
            enrichH1: cfg.ENRICH_H1 !== false,
            h1WindowCandles: this.int(cfg.H1_WINDOW_CANDLES, 40),
            timezone: cfg.TIMEZONE || process.env.TZ || "America/Sao_Paulo"
        };

        this.baseUrl = this.CONFIG?.BINANCE?.BASE_URL || "https://fapi.binance.com";
        this.timeout = this.CONFIG?.BINANCE?.TIMEOUT || 12000;
        this.dataDir = options.dataDir || path.join(__dirname, "data");
        this.stateFile = options.stateFile || path.join(this.dataDir, "stoch_cci_h4_scanner_state.json");
        this.signalsFile = options.signalsFile || path.join(this.dataDir, "stoch_cci_h4_signals.jsonl");
        this.state = { lastScannedCandleOpenTime: 0, alerts: {}, recentSignals: [] };
        this.running = false;
        this.nextRequestAt = 0;
        this.lastStatus = null;
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

    timeframeMs() {
        const match = String(this.settings.timeframe).match(/^(\d+)([mhd])$/i);
        if (!match) return 4 * 60 * 60 * 1000;
        const value = Number(match[1]);
        const unit = match[2].toLowerCase();
        if (unit === "m") return value * 60 * 1000;
        if (unit === "h") return value * 60 * 60 * 1000;
        return value * 24 * 60 * 60 * 1000;
    }

    load() {
        try {
            fs.mkdirSync(this.dataDir, { recursive: true });
            if (!fs.existsSync(this.stateFile)) return;
            const data = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
            this.state = {
                lastScannedCandleOpenTime: Number(data.lastScannedCandleOpenTime || 0),
                alerts: data.alerts || {},
                recentSignals: Array.isArray(data.recentSignals) ? data.recentSignals : []
            };
            if (!this.state.recentSignals.length) {
                this.state.recentSignals = this.loadRecentSignalsFromFile();
            }
            console.log(`Scanner Stoch+CCI H4 carregado: ultimo candle ${this.state.lastScannedCandleOpenTime || "nenhum"}`);
        } catch (e) {
            console.error("Erro ao carregar Scanner Stoch+CCI H4:", e.message);
        }
    }

    loadRecentSignalsFromFile() {
        try {
            if (!fs.existsSync(this.signalsFile)) return [];
            const minTime = Date.now() - this.settings.crossLookbackMs * 2;
            return fs.readFileSync(this.signalsFile, "utf8")
                .split(/\r?\n/)
                .filter(Boolean)
                .slice(-1000)
                .map(line => {
                    try { return JSON.parse(line); } catch { return null; }
                })
                .filter(signal => signal &&
                    Number(signal.candleCloseTime || signal.candle?.closeTime || signal.alertedAt || 0) >= minTime
                );
        } catch (e) {
            return [];
        }
    }

    save() {
        try {
            fs.mkdirSync(this.dataDir, { recursive: true });
            fs.writeFileSync(this.stateFile, JSON.stringify({
                savedAt: new Date().toISOString(),
                lastScannedCandleOpenTime: this.state.lastScannedCandleOpenTime,
                lastScan: this.state.lastScan || null,
                alerts: this.state.alerts || {},
                recentSignals: this.state.recentSignals || []
            }, null, 2), "utf8");
        } catch (e) {
            console.error("Erro ao salvar Scanner Stoch+CCI H4:", e.message);
        }
    }

    appendSignal(signal) {
        try {
            fs.mkdirSync(this.dataDir, { recursive: true });
            fs.appendFileSync(this.signalsFile, JSON.stringify(signal) + "\n", "utf8");
        } catch (e) {
            console.error("Scanner Stoch+CCI H4 JSONL:", e.message);
        }
    }

    pruneAlerts() {
        const alerts = this.state.alerts || {};
        const keys = Object.keys(alerts);
        if (keys.length <= 1500) return;
        keys
            .sort((a, b) => Number(alerts[a]?.alertedAt || 0) - Number(alerts[b]?.alertedAt || 0))
            .slice(0, keys.length - 1000)
            .forEach(key => delete alerts[key]);
    }

    pruneRecentSignals() {
        const minTime = Date.now() - this.settings.crossLookbackMs * 2;
        this.state.recentSignals = (this.state.recentSignals || [])
            .filter(signal => Number(signal.candleCloseTime || signal.candle?.closeTime || signal.alertedAt || 0) >= minTime)
            .sort((a, b) => Number(b.candleCloseTime || b.candle?.closeTime || 0) - Number(a.candleCloseTime || a.candle?.closeTime || 0))
            .slice(0, 500);
    }

    compactSignal(signal) {
        return {
            source: `STOCH_CCI_H4_${signal.direction}_CROSS`,
            symbol: signal.symbol,
            direction: signal.direction,
            candleOpenTime: signal.candle.openTime,
            candleCloseTime: signal.candle.closeTime,
            alertedAt: Date.now(),
            price: signal.price,
            prevCci: signal.prevCci,
            lastCci: signal.lastCci,
            crossedLevel: signal.crossedLevel,
            crossLabel: signal.crossLabel,
            stochK: signal.stochK,
            stochD: signal.stochD,
            stochExtremeK: signal.stochExtremeK,
            stochExtremeD: signal.stochExtremeD,
            stochExtremeLabel: signal.stochExtremeLabel,
            quoteVolume: signal.quoteVolume,
            taker: signal.taker || null,
            openInterest: signal.openInterest || null,
            h1Accumulation: signal.h1Accumulation || null
        };
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async throttle() {
        if (this.settings.requestDelayMs <= 0) return;
        const now = Date.now();
        const waitMs = Math.max(0, this.nextRequestAt - now);
        this.nextRequestAt = Math.max(now, this.nextRequestAt) + this.settings.requestDelayMs;
        if (waitMs > 0) await this.sleep(waitMs);
    }

    async getJson(pathname, params = {}, options = {}) {
        const retries = options.retries ?? 3;
        let lastError;

        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                if (options.throttle !== false) await this.throttle();
                const response = await axios.get(`${this.baseUrl}${pathname}`, {
                    params,
                    timeout: options.timeout || this.timeout
                });
                return response.data;
            } catch (e) {
                lastError = e;
                const status = e.response?.status;
                const retryAfter = Number(e.response?.headers?.["retry-after"] || 0);
                const backoffMs = retryAfter > 0 ? retryAfter * 1000 : attempt * 1200;
                if (attempt < retries && (status === 418 || status === 429 || !status || status >= 500)) {
                    await this.sleep(backoffMs);
                    continue;
                }
                break;
            }
        }

        throw lastError;
    }

    parseKline(kline) {
        return {
            openTime: Number(kline[0]),
            time: Number(kline[0]),
            open: Number(kline[1]),
            high: Number(kline[2]),
            low: Number(kline[3]),
            close: Number(kline[4]),
            volume: Number(kline[5]),
            closeTime: Number(kline[6]),
            quoteVolume: Number(kline[7])
        };
    }

    closedCandles(rawKlines, maxCloseTime = Date.now()) {
        return (rawKlines || [])
            .map(kline => this.parseKline(kline))
            .filter(candle =>
                candle.closeTime <= maxCloseTime &&
                candle.open > 0 &&
                candle.high > 0 &&
                candle.low > 0 &&
                candle.close > 0
            );
    }

    getLastClosedWindow(now = Date.now()) {
        const tfMs = this.timeframeMs();
        const currentOpen = Math.floor(now / tfMs) * tfMs;
        return {
            openTime: currentOpen - tfMs,
            closeTime: currentOpen - 1
        };
    }

    candleTime(value) {
        const time = Number(value?.closeTime ?? value);
        return new Date(time).toLocaleString("pt-BR", {
            timeZone: this.settings.timezone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit"
        });
    }

    fmtNum(value, decimals = 2) {
        const n = Number(value);
        if (!Number.isFinite(n)) return "n/a";
        return n.toLocaleString("en-US", {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals
        });
    }

    fmtPrice(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return "n/a";
        if (this.formatPrice) return this.formatPrice(n);
        return this.fmtNum(n, n >= 1 ? 4 : 6);
    }

    fmtVolume(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return "n/a";
        return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
    }

    fmtPct(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return "n/a";
        const sign = n >= 0 ? "+" : "";
        return `${sign}${n.toFixed(2)}%`;
    }

    async fetchSymbols() {
        const [exchangeInfo, tickers] = await Promise.all([
            this.getJson("/fapi/v1/exchangeInfo", {}, { throttle: false }),
            this.getJson("/fapi/v1/ticker/24hr", {}, { throttle: false })
        ]);

        const volumeBySymbol = new Map((tickers || []).map(t => [
            t.symbol,
            Number(t.quoteVolume || 0)
        ]));

        let symbols = (exchangeInfo.symbols || [])
            .filter(symbolInfo =>
                symbolInfo.status === "TRADING" &&
                symbolInfo.contractType === "PERPETUAL" &&
                symbolInfo.quoteAsset === "USDT"
            )
            .map(symbolInfo => ({
                symbol: symbolInfo.symbol,
                quoteVolume: volumeBySymbol.get(symbolInfo.symbol) || 0
            }))
            .filter(symbolInfo => symbolInfo.quoteVolume >= this.settings.minQuoteVolume)
            .sort((a, b) => b.quoteVolume - a.quoteVolume);

        if (this.settings.maxSymbols > 0) {
            symbols = symbols.slice(0, this.settings.maxSymbols);
        }

        return symbols;
    }

    activeDirections() {
        const directions = [];
        if (this.settings.longActive) directions.push("LONG");
        if (this.settings.shortActive) directions.push("SHORT");
        return directions;
    }

    signedCCI(direction, value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return null;
        return direction === "SHORT" ? -n : n;
    }

    windowStochInfo(stochValues, stochOffset, lastCandleIndex, direction) {
        const start = Math.max(0, lastCandleIndex - this.settings.syncLookback + 1);
        let minK = Infinity;
        let minD = Infinity;
        let maxK = -Infinity;
        let maxD = -Infinity;
        let touchedExtreme = false;

        for (let candleIndex = start; candleIndex <= lastCandleIndex; candleIndex++) {
            const stoch = stochValues[candleIndex - stochOffset];
            if (!stoch || !Number.isFinite(stoch.k) || !Number.isFinite(stoch.d)) continue;

            minK = Math.min(minK, stoch.k);
            minD = Math.min(minD, stoch.d);
            maxK = Math.max(maxK, stoch.k);
            maxD = Math.max(maxD, stoch.d);

            if (direction === "SHORT") {
                if (stoch.k >= this.settings.stochOverbought || stoch.d >= this.settings.stochOverbought) {
                    touchedExtreme = true;
                }
            } else if (stoch.k <= this.settings.stochOversold || stoch.d <= this.settings.stochOversold) {
                touchedExtreme = true;
            }
        }

        const isShort = direction === "SHORT";
        return {
            touchedExtreme,
            minK: Number.isFinite(minK) ? minK : null,
            minD: Number.isFinite(minD) ? minD : null,
            maxK: Number.isFinite(maxK) ? maxK : null,
            maxD: Number.isFinite(maxD) ? maxD : null,
            extremeK: isShort && Number.isFinite(maxK) ? maxK : Number.isFinite(minK) ? minK : null,
            extremeD: isShort && Number.isFinite(maxD) ? maxD : Number.isFinite(minD) ? minD : null,
            extremeLabel: isShort ? "topo" : "fundo"
        };
    }

    async analyzeSymbol(symbolInfo, targetWindow) {
        const rawKlines = await this.getJson("/fapi/v1/klines", {
            symbol: symbolInfo.symbol,
            interval: this.settings.timeframe,
            limit: this.settings.klineLimit
        });

        const candles = this.closedCandles(rawKlines, targetWindow.closeTime);
        const lastCandleIndex = candles.findIndex(candle => candle.openTime === targetWindow.openTime);
        const minCandles = Math.max(
            this.settings.cciPeriod,
            this.settings.stochPeriod + this.settings.stochSignalPeriod
        ) + 5;

        if (lastCandleIndex < 0 || candles.length < minCandles) return null;

        const high = candles.map(candle => candle.high);
        const low = candles.map(candle => candle.low);
        const close = candles.map(candle => candle.close);

        const cciValues = CCI.calculate({
            period: this.settings.cciPeriod,
            high,
            low,
            close
        });
        const stochValues = Stochastic.calculate({
            period: this.settings.stochPeriod,
            signalPeriod: this.settings.stochSignalPeriod,
            high,
            low,
            close
        });

        const cciOffset = candles.length - cciValues.length;
        const stochOffset = candles.length - stochValues.length;
        const cciIndex = lastCandleIndex - cciOffset;
        const stochIndex = lastCandleIndex - stochOffset;

        if (cciIndex < 1 || stochIndex < 0) return null;

        const prevCci = cciValues[cciIndex - 1];
        const lastCci = cciValues[cciIndex];
        const lastStoch = stochValues[stochIndex];
        const lastCandle = candles[lastCandleIndex];
        if (!lastStoch) return null;

        const signals = [];
        for (const direction of this.activeDirections()) {
            const isShort = direction === "SHORT";
            const cciCrossed = isShort
                ? prevCci >= this.settings.cciOverbought && lastCci < this.settings.cciOverbought
                : prevCci <= this.settings.cciOversold && lastCci > this.settings.cciOversold;
            const stochWindow = this.windowStochInfo(stochValues, stochOffset, lastCandleIndex, direction);

            if (!cciCrossed || !stochWindow.touchedExtreme) continue;

            signals.push({
                symbol: symbolInfo.symbol,
                direction,
                quoteVolume: symbolInfo.quoteVolume,
                candle: lastCandle,
                price: lastCandle.close,
                prevCci,
                lastCci,
                crossedLevel: isShort ? this.settings.cciOverbought : this.settings.cciOversold,
                crossLabel: isShort ? "perdeu +200" : "recuperou -200",
                stochK: lastStoch.k,
                stochD: lastStoch.d,
                stochMinK: stochWindow.minK,
                stochMinD: stochWindow.minD,
                stochMaxK: stochWindow.maxK,
                stochMaxD: stochWindow.maxD,
                stochExtremeK: stochWindow.extremeK,
                stochExtremeD: stochWindow.extremeD,
                stochExtremeLabel: stochWindow.extremeLabel
            });
        }

        return signals.length ? signals : null;
    }

    analyzeH1Accumulation(candles, cciValues, direction) {
        const cciOffset = candles.length - cciValues.length;
        const pairs = cciValues
            .map((cci, index) => ({
                cci,
                signedCCI: this.signedCCI(direction, cci),
                candle: candles[cciOffset + index]
            }))
            .filter(pair => pair.candle && Number.isFinite(pair.signedCCI));
        const recent = pairs.slice(-this.settings.h1WindowCandles);
        if (recent.length < 2) return null;

        let breaks100 = 0;
        let breaks130 = 0;
        let backBelow100 = 0;

        for (let i = 1; i < recent.length; i++) {
            const previous = recent[i - 1].signedCCI;
            const current = recent[i].signedCCI;
            if (previous < 100 && current >= 100) breaks100++;
            if (previous < 130 && current >= 130) breaks130++;
            if (previous > 100 && current < 100) backBelow100++;
        }

        const highs = recent.map(pair => pair.candle.high);
        const lows = recent.map(pair => pair.candle.low);
        const max = Math.max(...highs);
        const min = Math.min(...lows);
        const rangePercent = min > 0 ? ((max - min) / min) * 100 : null;

        return {
            breaks100,
            breaks130,
            backBelow100,
            currentCci: recent[recent.length - 1].cci,
            currentSignedCci: recent[recent.length - 1].signedCCI,
            minCci: Math.min(...recent.map(pair => pair.cci)),
            maxCci: Math.max(...recent.map(pair => pair.cci)),
            minSignedCci: Math.min(...recent.map(pair => pair.signedCCI)),
            maxSignedCci: Math.max(...recent.map(pair => pair.signedCCI)),
            rangePercent,
            candlesAnalyzed: recent.length
        };
    }

    async enrichH1(signal) {
        const limit = this.settings.h1WindowCandles + this.settings.cciPeriod + 20;
        const rawKlines = await this.getJson("/fapi/v1/klines", {
            symbol: signal.symbol,
            interval: "1h",
            limit
        }, { retries: 2 });
        const candles = this.closedCandles(rawKlines, signal.candle.closeTime);
        if (candles.length < this.settings.cciPeriod + 5) return null;
        const cciValues = CCI.calculate({
            period: this.settings.cciPeriod,
            high: candles.map(candle => candle.high),
            low: candles.map(candle => candle.low),
            close: candles.map(candle => candle.close)
        });
        if (!cciValues.length) return null;
        return this.analyzeH1Accumulation(candles, cciValues, signal.direction);
    }

    async enrichSignal(signal) {
        const tasks = [];

        if (this.settings.enrichTaker && this.getTakerVolume) {
            tasks.push(
                this.getTakerVolume(signal.symbol)
                    .then(taker => { signal.taker = taker; })
                    .catch(() => {})
            );
        }

        if (this.settings.enrichOpenInterest && (this.getOpenInterestTrend || this.getOpenInterest)) {
            tasks.push(
                (this.getOpenInterestTrend || this.getOpenInterest)(signal.symbol)
                    .then(openInterest => { signal.openInterest = openInterest; })
                    .catch(() => {})
            );
        }

        if (this.settings.enrichH1) {
            tasks.push(
                this.enrichH1(signal)
                    .then(h1Accumulation => { signal.h1Accumulation = h1Accumulation; })
                    .catch(() => {})
            );
        }

        await Promise.all(tasks);
        return signal;
    }

    async mapWithConcurrency(items, concurrency, mapper) {
        let index = 0;
        const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
            while (index < items.length) {
                const currentIndex = index;
                index++;
                await mapper(items[currentIndex], currentIndex);
            }
        });
        await Promise.all(workers);
    }

    buildSignalBlock(signal, index) {
        const taker = signal.taker;
        const h1 = signal.h1Accumulation;
        const ratio = Number(taker?.buyRatio);
        const takerAligned = signal.direction === "SHORT"
            ? Number.isFinite(ratio) && ratio <= 0.85
            : Number.isFinite(ratio) && ratio >= 1.15;
        const takerLine = taker
            ? `Taker: ${taker.dominantSide} | ratio ${taker.buyRatio} | buy ${taker.buyPct}% ${taker.trend || ""}${takerAligned ? " | alinhado" : ""}`
            : "Taker: n/a";
        const oiLine = this.buildOpenInterestLine(signal.openInterest);
        const h1Line = h1
            ? (signal.direction === "SHORT"
                ? `H1 antes: <-100 ${h1.breaks100}x | <-130 ${h1.breaks130}x | voltou >-100 ${h1.backBelow100}x | range ${this.fmtPct(h1.rangePercent)}`
                : `H1 antes: >100 ${h1.breaks100}x | >130 ${h1.breaks130}x | voltou <100 ${h1.backBelow100}x | range ${this.fmtPct(h1.rangePercent)}`)
            : "H1 antes: n/a";

        return [
            `${index + 1}. ${signal.symbol} ${signal.direction}`,
            `Preco: $${this.fmtPrice(signal.price)} | Vol 24h: ${this.fmtVolume(signal.quoteVolume)} USDT`,
            `CCI H4: ${this.fmtNum(signal.prevCci)} -> ${this.fmtNum(signal.lastCci)} | ${signal.crossLabel}`,
            `Stoch H4 K/D: ${this.fmtNum(signal.stochK)} / ${this.fmtNum(signal.stochD)} | ${signal.stochExtremeLabel}: ${this.fmtNum(signal.stochExtremeK)} / ${this.fmtNum(signal.stochExtremeD)}`,
            h1Line,
            takerLine,
            oiLine,
            `Grafico: ${this.tvLink(signal.symbol)}`
        ].filter(Boolean).join("\n");
    }

    buildOpenInterestLine(oi) {
        if (!oi?.openInterest) return null;
        const arrow = oi.trend === "UP" ? "↑" : oi.trend === "DOWN" ? "↓" : "→";
        const changeText = Number.isFinite(Number(oi.changePct))
            ? ` ${arrow} ${this.fmtPct(oi.changePct)}`
            : "";
        const periodText = oi.period && oi.points ? `/${oi.period} x${oi.points}` : "";
        return `OI: ${this.fmtVolume(oi.openInterest)} contratos${changeText}${periodText}`;
    }

    findRecentSignal(symbol, direction, at = Date.now(), currentPrice = null, maxAgeMs = this.settings.crossLookbackMs) {
        const atMs = Number(at || Date.now());
        const priceNow = Number(currentPrice);
        const found = (this.state.recentSignals || [])
            .filter(signal =>
                signal?.symbol === symbol &&
                signal?.direction === direction &&
                Number(signal.candleCloseTime || signal.candle?.closeTime || 0) <= atMs &&
                atMs - Number(signal.candleCloseTime || signal.candle?.closeTime || 0) <= maxAgeMs
            )
            .sort((a, b) => Number(b.candleCloseTime || b.candle?.closeTime || 0) - Number(a.candleCloseTime || a.candle?.closeTime || 0))[0];

        if (!found) {
            return {
                found: false,
                symbol,
                direction,
                lookbackHours: maxAgeMs / 3600000
            };
        }

        const crossTime = Number(found.candleCloseTime || found.candle?.closeTime || 0);
        const crossPrice = Number(found.price);
        const rawMovePct = Number.isFinite(priceNow) && Number.isFinite(crossPrice) && crossPrice > 0
            ? ((priceNow - crossPrice) / crossPrice) * 100
            : null;
        const directionalMovePct = Number.isFinite(rawMovePct)
            ? (direction === "SHORT" ? -rawMovePct : rawMovePct)
            : null;

        return {
            found: true,
            symbol,
            direction,
            source: found.source || `STOCH_CCI_H4_${direction}_CROSS`,
            candleCloseTime: crossTime,
            candleTimeText: this.candleTime(crossTime),
            ageHours: Number.isFinite(crossTime) ? (atMs - crossTime) / 3600000 : null,
            priceAtCross: crossPrice,
            currentPrice: Number.isFinite(priceNow) ? priceNow : null,
            rawMovePct,
            directionalMovePct,
            prevCci: found.prevCci,
            lastCci: found.lastCci,
            crossLabel: found.crossLabel,
            stochK: found.stochK,
            stochD: found.stochD,
            stochExtremeK: found.stochExtremeK,
            stochExtremeD: found.stochExtremeD,
            stochExtremeLabel: found.stochExtremeLabel,
            taker: found.taker || null,
            openInterest: found.openInterest || null,
            h1Accumulation: found.h1Accumulation || null
        };
    }

    buildMessages(signals, meta) {
        const header = [
            "🥚 ZEZIM — RELATORIO STOCH + CCI H4",
            "",
            `Fechamento H4: ${this.candleTime(meta.closeTime)}`,
            `Regra LONG: CCI recuperou ${this.settings.cciOversold} + Stoch no fundo`,
            `Regra SHORT: CCI perdeu +${this.settings.cciOverbought} + Stoch no topo`,
            `Janela Stoch: ultimos ${this.settings.syncLookback} candles`,
            `Scan: ${meta.checked}/${meta.total} pares | falhas: ${meta.failed} | sinais: ${signals.length}`,
            ""
        ].join("\n");

        if (!signals.length) {
            return [
                header +
                "Nenhum cruzamento exato encontrado neste fechamento.\n\n" +
                "⚠️ Nao e conselho financeiro."
            ];
        }

        const blocks = signals.map((signal, index) => this.buildSignalBlock(signal, index));
        const messages = [];
        let current = header;

        for (const block of blocks) {
            const next = `${current}${current.endsWith("\n\n") || current.endsWith("\n") ? "" : "\n\n"}${block}\n\n`;
            if (next.length > 3600 && current.trim() !== header.trim()) {
                messages.push(`${current.trim()}\n\n⚠️ Nao e conselho financeiro.`);
                current = `🥚 ZEZIM — STOCH + CCI H4 (continua)\nFechamento H4: ${this.candleTime(meta.closeTime)}\n\n${block}\n\n`;
            } else {
                current = next;
            }
        }

        messages.push(`${current.trim()}\n\nProxima fase: acompanhar reversao/volume/taker na incubadora.\n⚠️ Nao e conselho financeiro.`);
        return messages;
    }

    async notify(signals, meta) {
        if (!signals.length && !this.settings.alertWhenEmpty) return;
        const messages = this.buildMessages(signals, meta);
        for (const message of messages) {
            await this.sendTelegram(message);
            await this.sleep(500);
        }
    }

    markScanned(targetWindow, signals, meta) {
        const now = Date.now();
        this.state.lastScannedCandleOpenTime = targetWindow.openTime;
        this.state.lastScan = {
            scannedAt: now,
            candleOpenTime: targetWindow.openTime,
            candleCloseTime: targetWindow.closeTime,
            total: meta.total,
            checked: meta.checked,
            failed: meta.failed,
            signals: signals.length
        };

        for (const signal of signals) {
            const key = `${this.settings.timeframe}:${signal.symbol}:${signal.direction}:${signal.candle.closeTime}`;
            const compact = this.compactSignal(signal);
            this.state.alerts[key] = {
                alertedAt: now,
                direction: signal.direction,
                price: signal.price,
                cci: signal.lastCci,
                stochK: signal.stochK,
                stochD: signal.stochD
            };
            this.state.recentSignals = [
                compact,
                ...(this.state.recentSignals || []).filter(item =>
                    !(item.symbol === compact.symbol &&
                        item.direction === compact.direction &&
                        Number(item.candleCloseTime) === Number(compact.candleCloseTime))
                )
            ];
            this.appendSignal({
                schemaVersion: 1,
                ...compact
            });
        }

        this.pruneAlerts();
        this.pruneRecentSignals();
        this.save();
    }

    async scanOnce(targetWindow) {
        const startedAt = Date.now();
        const symbols = await this.fetchSymbols();
        const signals = [];
        let checked = 0;
        let failed = 0;

        console.log(
            `Scanner Stoch+CCI H4: ${symbols.length} pares | ` +
            `candle ${this.candleTime(targetWindow.closeTime)} | ` +
            `CCI ${this.settings.cciPeriod}/${this.settings.cciOversold}/${this.settings.cciOverbought} | ` +
            `Stoch ${this.settings.stochPeriod}/${this.settings.stochSignalPeriod}/${this.settings.stochOversold}/${this.settings.stochOverbought}`
        );

        await this.mapWithConcurrency(symbols, this.settings.concurrency, async symbolInfo => {
            try {
                const symbolSignals = await this.analyzeSymbol(symbolInfo, targetWindow);
                checked++;
                if (Array.isArray(symbolSignals)) signals.push(...symbolSignals);
            } catch (e) {
                failed++;
                const status = e.response?.status ? ` HTTP ${e.response.status}` : "";
                console.warn(`Scanner Stoch+CCI H4 ${symbolInfo.symbol}: erro${status} - ${e.message}`);
            }
        });

        signals.sort((a, b) => b.quoteVolume - a.quoteVolume);

        const freshSignals = [];
        for (const signal of signals) {
            const key = `${this.settings.timeframe}:${signal.symbol}:${signal.direction}:${signal.candle.closeTime}`;
            if (this.state.alerts?.[key]) continue;
            freshSignals.push(await this.enrichSignal(signal));
        }

        const meta = {
            total: symbols.length,
            checked,
            failed,
            rawSignals: signals.length,
            elapsedSeconds: (Date.now() - startedAt) / 1000,
            closeTime: targetWindow.closeTime
        };

        await this.notify(freshSignals, meta);
        this.markScanned(targetWindow, freshSignals, meta);
        this.lastStatus = {
            ...meta,
            scanned: true,
            signals: freshSignals.length,
            candleOpenTime: targetWindow.openTime
        };

        console.log(
            `Scanner Stoch+CCI H4 finalizado: ${checked}/${symbols.length} analisados, ` +
            `${failed} falhas, ${freshSignals.length} sinais novos, ${meta.elapsedSeconds.toFixed(1)}s.`
        );

        return this.lastStatus;
    }

    async checkAndSend() {
        if (!this.settings.enabled) return { skipped: true, reason: "disabled" };
        if (this.running) return { skipped: true, reason: "running" };

        const targetWindow = this.getLastClosedWindow();
        if (Date.now() < targetWindow.closeTime + this.settings.runGraceMs) {
            return { skipped: true, reason: "waiting_grace", targetWindow };
        }
        if (this.state.lastScannedCandleOpenTime === targetWindow.openTime) {
            return { skipped: true, reason: "already_scanned", targetWindow };
        }

        this.running = true;
        try {
            return await this.scanOnce(targetWindow);
        } catch (e) {
            this.lastStatus = {
                scanned: false,
                error: e.message,
                candleOpenTime: targetWindow.openTime,
                closeTime: targetWindow.closeTime
            };
            console.error("Scanner Stoch+CCI H4 falhou:", e.message);
            return this.lastStatus;
        } finally {
            this.running = false;
        }
    }

    getLastStatus() {
        return this.lastStatus;
    }
}

module.exports = StochCciH4Scanner;
