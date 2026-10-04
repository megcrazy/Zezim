const axios = require("axios");
const { CCI } = require("technicalindicators");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const CONFIG = require("./config");
const VolumeAnalyzer = require("./volume_analyzer");
const SetupScorer = require("./setup_scorer");
const RangeDetector = require("./range_detector");
const RetestMonitor = require("./retest_monitor");
const CCIEggMonitor = require("./cci_egg_monitor");
const ResearchRecorder = require("./research_recorder");
const Incubadora = require("./incubadora");
const StochCciH4Scanner = require("./stoch_cci_h4_scanner");
const {
    classifyAlert,
    buildClassificationBlock,
    cleanClassification
} = require("./alert_classifier");

console.log("🤖 BOT ZEZIM PRO v2 — FIBO + FVG + LSR DETALHADO");
console.log("==================================================");

const volumeAnalyzer = new VolumeAnalyzer(CONFIG);
const setupScorer    = new SetupScorer(CONFIG);
const rangeDetector  = new RangeDetector(CONFIG);
const researchRecorder = new ResearchRecorder();

// ==================== PERSISTÊNCIA DE OVOS ====================
const EGGS_FILE = path.join(__dirname, "eggs_state.json");
const ALERTS_FILE = path.join(__dirname, "alerts_state.json");

function saveEggs() {
    try {
        const data = {
            long:    Array.from(state.goldEggsLong.entries()),
            short:   Array.from(state.goldEggsShort.entries()),
            savedAt: new Date().toISOString()
        };
        fs.writeFileSync(EGGS_FILE, JSON.stringify(data, null, 2), "utf8");
    } catch (e) {
        console.error("❌ Erro ao salvar ovos:", e.message);
    }
}

function loadEggs() {
    try {
        if (!fs.existsSync(EGGS_FILE)) return;
        const raw  = fs.readFileSync(EGGS_FILE, "utf8");
        const data = JSON.parse(raw);
        state.goldEggsLong  = new Map(data.long  || []);
        state.goldEggsShort = new Map(data.short || []);
        console.log(`📂 Ovos carregados: ${state.goldEggsLong.size} LONG | ${state.goldEggsShort.size} SHORT`);
    } catch (e) {
        console.error("❌ Erro ao carregar ovos:", e.message);
    }
}

function saveAlertCounters() {
    try {
        const data = {
            counters: state.alertCounters,
            savedAt: new Date().toISOString()
        };
        fs.writeFileSync(ALERTS_FILE, JSON.stringify(data, null, 2), "utf8");
    } catch (e) {
        console.error("❌ Erro ao salvar alertas:", e.message);
    }
}

function loadAlertCounters() {
    try {
        if (!fs.existsSync(ALERTS_FILE)) return;
        const raw = fs.readFileSync(ALERTS_FILE, "utf8");
        const data = JSON.parse(raw);
        state.alertCounters = data.counters || {};
        resetDailyCountersIfNeeded();
        console.log(`📂 Cooldowns carregados: ${Object.keys(state.alertCounters).length} pares`);
    } catch (e) {
        console.error("❌ Erro ao carregar alertas:", e.message);
    }
}

// ==================== ESTADO ====================
const state = {
    alertCounters: {},
    goldEggsLong:  new Map(),
    goldEggsShort: new Map(),
    todayStats: { highQuality: 0, triggered: 0, lsrAlerts: 0, skipped: 0 }
};

// ==================== HELPERS ====================
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function tvLink(symbol) {
    return `[Chart](https://www.tradingview.com/chart/?symbol=BINANCE%3A${symbol.replace("USDT", "USDT.P")})`;
}

function formatPrice(value) {
    if (value == null || Number.isNaN(value)) return "-";
    return value.toFixed(6);
}

function formatPercent(value) {
    if (value == null || Number.isNaN(value)) return "-";
    const sign = value >= 0 ? "+" : "";
    return `${sign}${value.toFixed(2)}%`;
}

async function sendTelegram(message) {
    if (!CONFIG.TELEGRAM.TOKEN || !CONFIG.TELEGRAM.CHAT_ID) return;
    try {
        await axios.post(
            `https://api.telegram.org/bot${CONFIG.TELEGRAM.TOKEN}/sendMessage`,
            { chat_id: CONFIG.TELEGRAM.CHAT_ID, text: message, parse_mode: "Markdown", disable_web_page_preview: true }
        );
        console.log("📤 Telegram enviado");
    } catch (e) {
        console.error("❌ Erro Telegram:", e.message);
    }
}

async function sendTelegramTo(chatId, message) {
    try {
        await axios.post(
            `https://api.telegram.org/bot${CONFIG.TELEGRAM.TOKEN}/sendMessage`,
            { chat_id: chatId, text: message, parse_mode: "Markdown", disable_web_page_preview: true }
        );
    } catch (e) {
        console.error("sendTelegramTo:", e.message);
    }
}

// ==================== RETESTE + TAKER VOLUME ====================
const retestMonitor = new RetestMonitor(
    CONFIG,
    sendTelegram,
    formatPrice,
    formatPercent,
    tvLink,
    { researchRecorder }
);

const cciEggMonitor = new CCIEggMonitor(
    CONFIG,
    sendTelegram,
    formatPrice,
    formatPercent,
    tvLink,
    { researchRecorder }
);

let stochCciH4Scanner;

const incubadora = new Incubadora(
    CONFIG,
    sendTelegram,
    formatPrice,
    formatPercent,
    tvLink,
    {
        getTakerVolume: (symbol) => retestMonitor.fetchTakerVolume(symbol),
        getOpenInterest: (symbol) => getOpenInterest(symbol),
        getOpenInterestTrend: (symbol) => getOpenInterestTrend(symbol),
        getH4CrossContext: (symbol, direction, at, price) =>
            stochCciH4Scanner?.findRecentSignal(symbol, direction, at, price)
    }
);

stochCciH4Scanner = new StochCciH4Scanner(
    CONFIG,
    sendTelegram,
    formatPrice,
    tvLink,
    {
        getTakerVolume: (symbol) => retestMonitor.fetchTakerVolume(symbol),
        getOpenInterest: (symbol) => getOpenInterest(symbol),
        getOpenInterestTrend: (symbol) => getOpenInterestTrend(symbol)
    }
);

// ==================== CONTADOR DIÁRIO ====================
function getBrazilDateKey() {
    const now = new Date();
    const local = new Date(now.getTime() + (-3 * 60 * 60 * 1000));
    return local.toISOString().slice(0, 10);
}

function resetDailyCountersIfNeeded() {
    const today = getBrazilDateKey();
    let changed = false;
    for (const sym in state.alertCounters) {
        if (state.alertCounters[sym].countDate !== today) {
            state.alertCounters[sym].dailyCount = 0;
            state.alertCounters[sym].countDate  = today;
            changed = true;
        }
    }
    if (changed) saveAlertCounters();
}

// ==================== BINANCE ====================
async function getLiquidSymbols() {
    try {
        const r = await axios.get("https://fapi.binance.com/fapi/v1/ticker/24hr", { timeout: CONFIG.BINANCE.TIMEOUT });
        return r.data
            .filter(t =>
                t.symbol.endsWith("USDT") &&
                parseFloat(t.quoteVolume) >= CONFIG.FILTERS.MIN_VOLUME_24H_USD &&
                Math.abs(parseFloat(t.priceChangePercent)) <= CONFIG.FILTERS.MAX_PRICE_CHANGE_24H
            )
            .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
            .map(t => t.symbol);
    } catch (e) {
        console.error("❌ Símbolos:", e.message);
        return ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT"];
    }
}

async function getCandles(symbol, interval = "1h", limit = 30) {
    try {
        const r = await axios.get(`${CONFIG.BINANCE.BASE_URL}/fapi/v1/klines`, {
            params: { symbol, interval, limit }, timeout: CONFIG.BINANCE.TIMEOUT
        });
        return r.data.map(c => ({
            time:   c[0],
            open:   parseFloat(c[1]),
            high:   parseFloat(c[2]),
            low:    parseFloat(c[3]),
            close:  parseFloat(c[4]),
            volume: parseFloat(c[5])
        }));
    } catch (e) { return null; }
}

async function getOpenInterest(symbol) {
    try {
        const r = await axios.get(`${CONFIG.BINANCE.BASE_URL}/fapi/v1/openInterest`, {
            params: { symbol },
            timeout: CONFIG.BINANCE.TIMEOUT
        });
        return {
            symbol,
            openInterest: parseFloat(r.data?.openInterest),
            time: Number(r.data?.time || Date.now())
        };
    } catch (e) {
        return null;
    }
}

async function getOpenInterestTrend(symbol, period = "5m", limit = 12) {
    try {
        const r = await axios.get(`${CONFIG.BINANCE.BASE_URL}/futures/data/openInterestHist`, {
            params: { symbol, period, limit },
            timeout: CONFIG.BINANCE.TIMEOUT
        });
        const rows = Array.isArray(r.data)
            ? r.data
                .map(row => ({
                    openInterest: parseFloat(row.sumOpenInterest),
                    openInterestValue: parseFloat(row.sumOpenInterestValue),
                    time: Number(row.timestamp || row.time || 0)
                }))
                .filter(row => Number.isFinite(row.openInterest))
            : [];

        if (rows.length >= 2) {
            const first = rows[0];
            const last = rows[rows.length - 1];
            const change = last.openInterest - first.openInterest;
            const changePct = first.openInterest > 0 ? (change / first.openInterest) * 100 : null;
            return {
                symbol,
                period,
                points: rows.length,
                openInterest: last.openInterest,
                openInterestValue: last.openInterestValue,
                previousOpenInterest: first.openInterest,
                change,
                changePct,
                trend: change > 0 ? "UP" : change < 0 ? "DOWN" : "FLAT",
                time: last.time || Date.now()
            };
        }

        const current = await getOpenInterest(symbol);
        return current ? { ...current, period, points: rows.length, trend: "FLAT", change: null, changePct: null } : null;
    } catch (e) {
        return getOpenInterest(symbol);
    }
}

// ==================== INDICADORES ====================
function calculateCCI(candles) {
    if (!candles || candles.length < CONFIG.INDICATORS.CCI.PERIOD) return [];
    try {
        return CCI.calculate({
            high:   candles.map(c => c.high),
            low:    candles.map(c => c.low),
            close:  candles.map(c => c.close),
            period: CONFIG.INDICATORS.CCI.PERIOD
        });
    } catch (e) { return []; }
}

function getAlignedCCI(candles) {
    const values = calculateCCI(candles);
    const offset = candles.length - values.length;
    return values.map((cci, i) => ({
        index: offset + i,
        cci,
        candle: candles[offset + i]
    })).filter(x => x.candle);
}

function findPivots(series, field, lookback = 2) {
    const pivots = { highs: [], lows: [] };
    for (let i = lookback; i < series.length - lookback; i++) {
        const value = series[i][field];
        const window = series.slice(i - lookback, i + lookback + 1).map(x => x[field]);
        if (value === Math.max(...window)) pivots.highs.push(series[i]);
        if (value === Math.min(...window)) pivots.lows.push(series[i]);
    }
    return pivots;
}

function getClosedCandles(candles) {
    if (!Array.isArray(candles) || candles.length < 2) return candles;
    return candles.slice(0, -1);
}

function getDivergenceScoreImpact(timeframe, bias) {
    const tf = String(timeframe || "").toUpperCase();
    if (tf === "H1") return bias === "favor" ? 10 : -10;
    if (tf === "15M") return bias === "favor" ? 5 : -3;
    return 0;
}

function detectCCIDivergence(candles, direction = "LONG", timeframe = "H1") {
    if (!candles || candles.length < 35) return null;

    const aligned = getAlignedCCI(candles);
    if (aligned.length < 20) return null;

    const recent = aligned.slice(-35).map(x => ({
        index: x.index,
        priceHigh: x.candle.high,
        priceLow: x.candle.low,
        close: x.candle.close,
        cci: x.cci
    }));

    const priceLowPivots = findPivots(recent, "priceLow").lows.slice(-3);
    const priceHighPivots = findPivots(recent, "priceHigh").highs.slice(-3);
    const cciLowPivots = findPivots(recent, "cci").lows.slice(-3);
    const cciHighPivots = findPivots(recent, "cci").highs.slice(-3);

    const lastClose = recent[recent.length - 1].close;
    const prevClose = recent[Math.max(0, recent.length - 6)].close;
    const priceTrend = lastClose > prevClose ? "UP" : lastClose < prevClose ? "DOWN" : "FLAT";

    if (direction === "LONG" && priceLowPivots.length >= 2 && cciLowPivots.length >= 2) {
        const p1 = priceLowPivots[priceLowPivots.length - 2];
        const p2 = priceLowPivots[priceLowPivots.length - 1];
        const c1 = cciLowPivots[cciLowPivots.length - 2];
        const c2 = cciLowPivots[cciLowPivots.length - 1];

        const regular = p2.priceLow < p1.priceLow && c2.cci > c1.cci;
        const hidden = p2.priceLow > p1.priceLow && c2.cci < c1.cci;
        if (regular || hidden) {
            return {
                timeframe,
                direction,
                type: regular ? "BULLISH" : "OCULTA BULLISH",
                bias: "favor",
                scoreImpact: getDivergenceScoreImpact(timeframe, "favor"),
                label: regular
                    ? "preco fez fundo menor, mas CCI fez fundo maior"
                    : "preco segurou fundo maior, mas CCI limpou sobrevenda",
                priceA: p1.priceLow,
                priceB: p2.priceLow,
                cciA: c1.cci,
                cciB: c2.cci,
                priceTrend
            };
        }
    }

    if (direction === "SHORT" && priceHighPivots.length >= 2 && cciHighPivots.length >= 2) {
        const p1 = priceHighPivots[priceHighPivots.length - 2];
        const p2 = priceHighPivots[priceHighPivots.length - 1];
        const c1 = cciHighPivots[cciHighPivots.length - 2];
        const c2 = cciHighPivots[cciHighPivots.length - 1];

        const regular = p2.priceHigh > p1.priceHigh && c2.cci < c1.cci;
        const hidden = p2.priceHigh < p1.priceHigh && c2.cci > c1.cci;
        if (regular || hidden) {
            return {
                timeframe,
                direction,
                type: regular ? "BEARISH" : "OCULTA BEARISH",
                bias: "favor",
                scoreImpact: getDivergenceScoreImpact(timeframe, "favor"),
                label: regular
                    ? "preco fez topo maior, mas CCI fez topo menor"
                    : "preco fez topo menor, mas CCI aliviou sobrecompra",
                priceA: p1.priceHigh,
                priceB: p2.priceHigh,
                cciA: c1.cci,
                cciB: c2.cci,
                priceTrend
            };
        }
    }

    // Cautela: setup direcional com CCI perdendo impulso no mesmo lado.
    const last = recent[recent.length - 1];
    const prev = recent[Math.max(0, recent.length - 8)];
    if (direction === "LONG" && last.close > prev.close && last.cci < prev.cci) {
        return {
            timeframe,
            direction,
            type: "CAUTELA BEARISH",
            bias: "contra",
            scoreImpact: getDivergenceScoreImpact(timeframe, "contra"),
            label: "preco subiu, mas CCI perdeu forca",
            priceA: prev.close,
            priceB: last.close,
            cciA: prev.cci,
            cciB: last.cci,
            priceTrend
        };
    }
    if (direction === "SHORT" && last.close < prev.close && last.cci > prev.cci) {
        return {
            timeframe,
            direction,
            type: "CAUTELA BULLISH",
            bias: "contra",
            scoreImpact: getDivergenceScoreImpact(timeframe, "contra"),
            label: "preco caiu, mas CCI ganhou forca",
            priceA: prev.close,
            priceB: last.close,
            cciA: prev.cci,
            cciB: last.cci,
            priceTrend
        };
    }

    return null;
}

// Classifica a força do CCI (portado do indexv7)
function classifyCCI(cci) {
    const abs = Math.abs(cci);
    if (abs >= 200) return "EXTREMO 🔥";
    if (abs >= 150) return "MUITO FORTE ✅";
    if (abs >= 130) return "FORTE";
    if (abs >= 100) return "MODERADO";
    return "FRACO";
}

function getH4CCIValues(candles) {
    const values = calculateCCI(candles);
    if (!values.length) return null;
    return {
        current: values[values.length - 1],
        previous: values.length >= 2 ? values[values.length - 2] : null
    };
}

function classifyH4CCIRegime(h4CCI, direction) {
    if (!h4CCI || !Number.isFinite(h4CCI.current)) return null;

    const current = h4CCI.current;
    const previous = h4CCI.previous;
    const rising = Number.isFinite(previous) && current > previous;
    const falling = Number.isFinite(previous) && current < previous;
    const trend = rising ? "UP" : falling ? "DOWN" : "FLAT";
    const nearZero = current >= -25 && current <= 25;
    const isZeroPullback = Number.isFinite(previous) && nearZero && (
        (direction === "LONG" && previous > 25 && current < previous) ||
        (direction === "SHORT" && previous < -25 && current > previous)
    );

    if (isZeroPullback) return { current, previous, trend, code: "PULLBACK_ZERO", label: "⚡ PULLBACK 0" };

    if (direction === "LONG") {
        if (current >= 0) return { current, previous, trend, code: "IMPULSE", label: "🚀 IMPULSO" };
        if (current >= -100 && Number.isFinite(previous) && previous < -100) {
            return { current, previous, trend, code: "RECOVERY", label: "🟡 RECUPERAÇÃO" };
        }
        if (current >= -100) return { current, previous, trend, code: "HOLDING", label: "🟢 SUSTENTA" };
        return { current, previous, trend, code: "CORRECTION", label: "🟠 CORRIGE" };
    }

    if (current <= 0) return { current, previous, trend, code: "IMPULSE", label: "🚀 IMPULSO" };
    if (current <= 100 && Number.isFinite(previous) && previous > 100) {
        return { current, previous, trend, code: "RECOVERY", label: "🟡 RECUPERAÇÃO" };
    }
    if (current <= 100) return { current, previous, trend, code: "HOLDING", label: "🟢 SUSTENTA" };
    return { current, previous, trend, code: "CORRECTION", label: "🟠 CORRIGE" };
}

function buildH4CCIRegimeLine(h4CCI, direction) {
    const regime = classifyH4CCIRegime(h4CCI, direction);
    if (!regime) return "";
    const trendArrow = regime.trend === "UP" ? "↑" : regime.trend === "DOWN" ? "↓" : "→";
    return `🧭 CCI H4: ${regime.current.toFixed(1)} ${trendArrow} | ${regime.label}\n`;
}

function calculateStochastic(candles, period = 5) {
    if (!candles || candles.length < period + 3) return null;
    const highs = candles.map(c => c.high);
    const lows  = candles.map(c => c.low);
    const closes = candles.map(c => c.close);
    const kRaw = [];
    for (let i = period - 1; i < closes.length; i++) {
        const hi = Math.max(...highs.slice(i - period + 1, i + 1));
        const lo = Math.min(...lows.slice(i  - period + 1, i + 1));
        kRaw.push(hi === lo ? 50 : ((closes[i] - lo) / (hi - lo)) * 100);
    }
    const smoothed = [];
    for (let i = 2; i < kRaw.length; i++) smoothed.push((kRaw[i-2]+kRaw[i-1]+kRaw[i])/3);
    const cur  = smoothed[smoothed.length-1] ?? 50;
    const prev = smoothed[smoothed.length-2] ?? cur;
    return { currentK: cur, prevK: prev, direction: cur > prev ? "UP" : cur < prev ? "DOWN" : "FLAT" };
}

// ==================== FIBO SEMANAL INVERTIDA ====================
// Lógica portada do indexv7 — usa a semana anterior como referência

function calcWeeklyFibo(candlesW, useInverse = true) {
    if (!candlesW || candlesW.length < 2) return null;
    const prevWeek  = candlesW[candlesW.length - 2];
    const weekHigh  = prevWeek.high;
    const weekLow   = prevWeek.low;
    const weekOpen  = prevWeek.open;
    const weekClose = prevWeek.close;
    const isBear    = weekClose < weekOpen;
    // Inverte a direção da fibo baseado na semana ser bearish ou bullish
    const topBase    = isBear ? weekHigh : weekLow;
    const bottomBase = isBear ? weekLow  : weekHigh;
    const top    = useInverse ? bottomBase : topBase;
    const bottom = useInverse ? topBase    : bottomBase;
    const range  = top - bottom;
    return {
        fib0:   top,
        fib50:  top - range * 0.5,
        fib618: top - range * 0.618,
        fib706: top - range * 0.706,
        fib79:  top - range * 0.79,
        fib100: bottom,
        weekHigh, weekLow, weekOpen, weekClose, isBear
    };
}

function getFiboLevels(fibo) {
    return [
        { label: "0%",    value: fibo.fib0   },
        { label: "50%",   value: fibo.fib50  },
        { label: "61.8%", value: fibo.fib618 },
        { label: "70.6%", value: fibo.fib706 },
        { label: "79%",   value: fibo.fib79  },
        { label: "100%",  value: fibo.fib100 }
    ];
}

function getFiboZone(price, fibo) {
    if (!fibo || price == null) return "zona indefinida";
    const levels = getFiboLevels(fibo);
    for (let i = 0; i < levels.length - 1; i++) {
        const max = Math.max(levels[i].value, levels[i+1].value);
        const min = Math.min(levels[i].value, levels[i+1].value);
        if (price <= max && price >= min) return `entre ${levels[i].label} e ${levels[i+1].label}`;
    }
    const values = levels.map(l => l.value);
    if (price > Math.max(...values)) return "acima da faixa principal";
    if (price < Math.min(...values)) return "abaixo da faixa principal";
    return "fora da faixa principal";
}

function getNearestFiboLevel(price, fibo) {
    if (!fibo || price == null) return { label: "-", value: null, distancePct: null };
    const levels = getFiboLevels(fibo);
    let nearest = levels[0], minDiff = Math.abs(price - nearest.value);
    for (const lv of levels.slice(1)) {
        const diff = Math.abs(price - lv.value);
        if (diff < minDiff) { minDiff = diff; nearest = lv; }
    }
    const distancePct = nearest.value === 0 ? null
        : (Math.abs(price - nearest.value) / Math.abs(nearest.value)) * 100;
    return { label: nearest.label, value: nearest.value, distancePct };
}

// Retorna se o preço está em zona de desconto, neutra ou risco
function getFiboBias(price, fibo) {
    if (!fibo || price == null) return null;
    const values = getFiboLevels(fibo).map(l => l.value);
    const top = Math.max(...values), bottom = Math.min(...values);
    const range = top - bottom;
    if (range === 0) return null;
    const normalized = (price - bottom) / range;
    if (normalized <= 0.35) return { label: "🟢 zona de desconto", isDiscount: true,  isRisk: false };
    if (normalized >= 0.65) return { label: "🔴 zona de risco",    isDiscount: false, isRisk: true  };
    return { label: "🟡 zona neutra", isDiscount: false, isRisk: false };
}

// Monta o bloco formatado da Fibo para o Telegram
function buildFiboBlock(fibo, price) {
    if (!fibo) return "";
    const zone    = getFiboZone(price, fibo);
    const nearest = getNearestFiboLevel(price, fibo);
    const bias    = getFiboBias(price, fibo);
    return `\n┌─ 📐 *FIBO SEMANAL INVERTIDA* ────────\n` +
        `│ Zona: ${zone}\n` +
        `│ Leitura: ${bias ? bias.label : "indefinido"}\n` +
        `│ Nível mais próximo: ${nearest.label} (${formatPrice(nearest.value)})\n` +
        `│ Distância: ${nearest.distancePct != null ? formatPercent(nearest.distancePct) : "-"}\n` +
        `│ 0%: ${formatPrice(fibo.fib0)}  |  50%: ${formatPrice(fibo.fib50)}\n` +
        `│ 61.8%: ${formatPrice(fibo.fib618)}  |  70.6%: ${formatPrice(fibo.fib706)}\n` +
        `│ 79%: ${formatPrice(fibo.fib79)}  |  100%: ${formatPrice(fibo.fib100)}\n` +
        `└──────────────────────────────────────\n`;
}

// ==================== FAIR VALUE GAPS — ICT ====================
// Detecta FVGs nas últimas N velas do H4

function detectFVGs(candles, lookback = 15) {
    if (!candles || candles.length < 3) return [];
    const fvgs = [];
    const start = Math.max(1, candles.length - lookback - 1);
    for (let i = start; i < candles.length - 1; i++) {
        const prev = candles[i - 1];
        const curr = candles[i];     // vela do gap (não usada diretamente)
        const next = candles[i + 1];
        // FVG bullish: topo da vela anterior < fundo da vela seguinte
        if (prev.high < next.low)
            fvgs.push({ type: "BULL", top: next.low, bottom: prev.high });
        // FVG bearish: fundo da vela anterior > topo da vela seguinte
        if (prev.low > next.high)
            fvgs.push({ type: "BEAR", top: prev.low, bottom: next.high });
    }
    return fvgs;
}

// Verifica se o preço está dentro de algum FVG e qual o mais próximo acima/abaixo
function getFVGContext(price, fvgs) {
    if (!fvgs || !fvgs.length) return null;

    // Preço dentro de um FVG?
    for (const fvg of fvgs) {
        if (price >= fvg.bottom && price <= fvg.top) {
            return fvg.type === "BULL"
                ? { inside: true, label: "✅ Dentro de FVG Bullish H4 — zona de demanda institucional" }
                : { inside: true, label: "⚠️ Dentro de FVG Bearish H4 — zona de oferta institucional" };
        }
    }

    const parts = [];
    // FVG bullish mais próximo abaixo (suporte)
    const bullBelow = fvgs
        .filter(f => f.type === "BULL" && f.top < price)
        .sort((a, b) => b.top - a.top)[0];
    if (bullBelow) {
        const dist = ((price - bullBelow.top) / bullBelow.top * 100).toFixed(1);
        parts.push(`FVG 🟢 suporte: ${formatPrice(bullBelow.bottom)}–${formatPrice(bullBelow.top)} (${dist}% abaixo)`);
    }

    // FVG bearish mais próximo acima (resistência)
    const bearAbove = fvgs
        .filter(f => f.type === "BEAR" && f.bottom > price)
        .sort((a, b) => a.bottom - b.bottom)[0];
    if (bearAbove) {
        const dist = ((bearAbove.bottom - price) / price * 100).toFixed(1);
        parts.push(`FVG 🔴 resistência: ${formatPrice(bearAbove.bottom)}–${formatPrice(bearAbove.top)} (${dist}% acima)`);
    }

    return parts.length ? { inside: false, label: parts.join("\n│ ") } : null;
}

// Monta o bloco de FVG para o Telegram
function buildFVGBlock(price, fvgs) {
    const ctx = getFVGContext(price, fvgs);
    if (!ctx) return "";
    return `\n┌─ 🧲 *FAIR VALUE GAPS — ICT (H4)* ────\n` +
        `│ ${ctx.label}\n` +
        `└──────────────────────────────────────\n`;
}

function getFVGSide(price, fvgs) {
    if (!fvgs || !fvgs.length) return null;
    for (const fvg of fvgs) {
        if (price >= fvg.bottom && price <= fvg.top) return fvg.type;
    }
    return null;
}

function buildCCIDivergenceBlock(divH1, divM15, isLong, fiboBias, fvgSide, divH4 = null, div12H = null) {
    if (!divH1 && !divM15 && !divH4 && !div12H) return "";

    const lines = [];
    let impact = 0;
    if (divH1) impact += divH1.scoreImpact || 0;
    if (divM15) impact += divM15.scoreImpact || 0;
    if (divH4) impact += divH4.scoreImpact || 0;
    if (div12H) impact += div12H.scoreImpact || 0;

    const direction = isLong ? "LONG" : "SHORT";
    const fvgContra = (isLong && fvgSide === "BEAR") || (!isLong && fvgSide === "BULL");
    const fiboContra = (isLong && fiboBias?.isRisk) || (!isLong && fiboBias?.isDiscount);
    const macroFavor = divH4?.bias === "favor" || div12H?.bias === "favor";
    const macroContra = divH4?.bias === "contra" || div12H?.bias === "contra";

    if (divH1) {
        const emoji = divH1.bias === "favor" ? "✅" : "⚠️";
        lines.push(`│ ${emoji} H1: ${divH1.type} — ${divH1.label}`);
        lines.push(`│    CCI: ${divH1.cciA.toFixed(1)} → ${divH1.cciB.toFixed(1)}`);
    }

    if (divH4) {
        const emoji = divH4.bias === "favor" ? "🧭" : "⚠️";
        lines.push(`│ ${emoji} H4: ${divH4.type} — ${divH4.label}`);
        lines.push(`│    CCI: ${divH4.cciA.toFixed(1)} → ${divH4.cciB.toFixed(1)}`);
    }

    if (div12H) {
        const emoji = div12H.bias === "favor" ? "🌐" : "⚠️";
        lines.push(`│ ${emoji} 12h: ${div12H.type} — ${div12H.label}`);
        lines.push(`│    CCI: ${div12H.cciA.toFixed(1)} → ${div12H.cciB.toFixed(1)}`);
    }

    if (divM15) {
        const emoji = divM15.bias === "favor" ? "⚡" : "🟡";
        lines.push(`│ ${emoji} 15m: ${divM15.type} — ${divM15.label}`);
    }

    let leitura = "";
    if (divH1?.bias === "favor" && divH4?.bias === "favor" && !fvgContra && !fiboContra) {
        leitura = `🟢 H1 + H4 alinhados; ovo com estrutura a favor`;
    } else if (divH4?.bias === "contra") {
        leitura = `🟠 cautela: divergência H4 contra o ${direction}; observar confirmação`;
    } else if (div12H?.bias === "contra" && divH1?.bias !== "favor") {
        leitura = `🟠 12h contra; vento macro pede paciência`;
    } else if (divH1?.bias === "favor" && !fvgContra && !fiboContra) {
        leitura = `🟢 melhora o ${direction}; setup com leitura premium`;
    } else if (divH1?.bias === "favor" && (fvgContra || fiboContra)) {
        leitura = `🟡 divergência ajuda, mas região pede confirmação H4`;
    } else if (divH1?.bias === "contra") {
        leitura = `🟠 cautela: CCI H1 contra o ${direction}; aguardar fechamento/reteste`;
    } else if (macroFavor) {
        leitura = `🟡 estrutura maior ajuda, mas H1 ainda manda no gatilho`;
    } else if (divM15?.bias === "favor") {
        leitura = `🟡 15m confirma entrada fina, mas H1 não mostrou divergência clara`;
    } else if (macroContra) {
        leitura = `🟡 divergência maior pede cautela`;
    } else {
        leitura = "neutra";
    }

    const impactTxt = impact > 0 ? `+${impact}` : `${impact}`;
    const researchOnly = [divH4, div12H].some(div => div && !(div.scoreImpact || 0));
    lines.push(`│ Impacto: ${impactTxt} pts de qualidade${researchOnly ? " (H4/12h em pesquisa)" : ""}`);
    lines.push(`│ Leitura: ${leitura}`);

    return `\n┌─ 📉 *DIVERGÊNCIA CCI* ─────────────\n` +
        lines.join("\n") + "\n" +
        `└──────────────────────────────────────\n`;
}

function applyDivergenceScore(basePercentage, divH1, divM15, divH4 = null, div12H = null) {
    const base = parseInt(basePercentage || "0", 10);
    const impact = (divH1?.scoreImpact || 0) +
        (divM15?.scoreImpact || 0) +
        (divH4?.scoreImpact || 0) +
        (div12H?.scoreImpact || 0);
    const adjusted = Math.max(0, Math.min(100, base + impact));
    return { adjusted, impact };
}

function analyzeTakerForSetup(takerData, direction) {
    if (!takerData) {
        return { impact: 0, aligned: false, against: false, label: "indisponível" };
    }

    const ratio = parseFloat(takerData.buyRatio);
    const buyPct = parseFloat(takerData.buyPct);
    const sellPct = parseFloat(takerData.sellPct);
    const isLong = direction === "LONG";

    let impact = 0;
    let label = "neutro";
    let aligned = false;
    let against = false;

    if (isLong) {
        if (ratio >= 1.6 || buyPct >= 62) { impact = 15; label = "compra agressiva extrema"; aligned = true; }
        else if (ratio >= 1.3 || buyPct >= 57) { impact = 10; label = "compra agressiva forte"; aligned = true; }
        else if (ratio <= 0.7 || sellPct >= 58) { impact = -10; label = "venda agressiva contra o LONG"; against = true; }
    } else {
        if (ratio <= 0.62 || sellPct >= 62) { impact = 15; label = "venda agressiva extrema"; aligned = true; }
        else if (ratio <= 0.7 || sellPct >= 57) { impact = 10; label = "venda agressiva forte"; aligned = true; }
        else if (ratio >= 1.3 || buyPct >= 58) { impact = -10; label = "compra agressiva contra o SHORT"; against = true; }
    }

    return { impact, aligned, against, label };
}

function applyTakerScore(basePercentage, takerData, direction) {
    const base = parseInt(basePercentage || "0", 10);
    const tk = analyzeTakerForSetup(takerData, direction);
    const adjusted = Math.max(0, Math.min(100, base + tk.impact));
    return { adjusted, ...tk };
}

function cleanDivergence(div) {
    if (!div) return null;
    return {
        timeframe: div.timeframe,
        type: div.type,
        bias: div.bias,
        scoreImpact: div.scoreImpact || 0,
        label: div.label || null,
        priceA: Number.isFinite(div.priceA) ? div.priceA : null,
        priceB: Number.isFinite(div.priceB) ? div.priceB : null,
        cciA: Number.isFinite(div.cciA) ? div.cciA : null,
        cciB: Number.isFinite(div.cciB) ? div.cciB : null,
        priceTrend: div.priceTrend || null
    };
}

function cleanLSR(lsr, lsrResult) {
    if (!lsr && !lsrResult) return null;
    return {
        label: lsrResult?.label || null,
        isBullish: !!lsrResult?.isBullish,
        isBearish: !!lsrResult?.isBearish,
        isAlert: !!lsrResult?.isAlert,
        isTooLong: lsrResult?.label === "MUITO LONG (risco de squeeze)",
        isTooShort: lsrResult?.label === "MUITO SHORT (risco de squeeze)",
        posChange: Number.isFinite(lsrResult?.posChange) ? lsrResult.posChange : null,
        accountsRatio: Number.isFinite(lsr?.accounts?.ratio) ? lsr.accounts.ratio : null,
        accountsLongPct: Number.isFinite(lsr?.accounts?.long) ? lsr.accounts.long * 100 : null,
        positionsRatio: Number.isFinite(lsr?.positions?.ratio) ? lsr.positions.ratio : null,
        positionsLongPct: Number.isFinite(lsr?.positions?.long) ? lsr.positions.long * 100 : null
    };
}

function cleanH4CrossContext(ctx) {
    if (!ctx) return { found: false };
    return {
        found: !!ctx.found,
        source: ctx.source || null,
        fallback: !!ctx.fallback,
        lookbackHours: Number.isFinite(Number(ctx.lookbackHours)) ? Number(ctx.lookbackHours) : null,
        candleCloseTime: Number.isFinite(Number(ctx.candleCloseTime)) ? Number(ctx.candleCloseTime) : null,
        ageHours: Number.isFinite(Number(ctx.ageHours)) ? Number(ctx.ageHours) : null,
        priceAtCross: Number.isFinite(Number(ctx.priceAtCross)) ? Number(ctx.priceAtCross) : null,
        currentPrice: Number.isFinite(Number(ctx.currentPrice)) ? Number(ctx.currentPrice) : null,
        rawMovePct: Number.isFinite(Number(ctx.rawMovePct)) ? Number(ctx.rawMovePct) : null,
        directionalMovePct: Number.isFinite(Number(ctx.directionalMovePct)) ? Number(ctx.directionalMovePct) : null,
        prevCci: Number.isFinite(Number(ctx.prevCci)) ? Number(ctx.prevCci) : null,
        lastCci: Number.isFinite(Number(ctx.lastCci)) ? Number(ctx.lastCci) : null,
        crossLabel: ctx.crossLabel || null,
        stochK: Number.isFinite(Number(ctx.stochK)) ? Number(ctx.stochK) : null,
        stochD: Number.isFinite(Number(ctx.stochD)) ? Number(ctx.stochD) : null,
        stochExtremeK: Number.isFinite(Number(ctx.stochExtremeK)) ? Number(ctx.stochExtremeK) : null,
        stochExtremeD: Number.isFinite(Number(ctx.stochExtremeD)) ? Number(ctx.stochExtremeD) : null,
        takerRatio: Number.isFinite(Number(ctx.taker?.buyRatio)) ? Number(ctx.taker.buyRatio) : null,
        takerDominantSide: ctx.taker?.dominantSide || null,
        oiTrend: ctx.openInterest?.trend || null,
        oiChangePct: Number.isFinite(Number(ctx.openInterest?.changePct)) ? Number(ctx.openInterest.changePct) : null,
        oiOpenInterest: Number.isFinite(Number(ctx.openInterest?.openInterest)) ? Number(ctx.openInterest.openInterest) : null
    };
}

function getSetupH4CrossContext(symbol, direction, price, at = Date.now()) {
    const scannerContext = stochCciH4Scanner?.findRecentSignal(symbol, direction, at, price);
    if (scannerContext?.found) return scannerContext;

    const syncContext = incubadora?.findH4SyncContext?.(symbol, direction, at, price);
    if (syncContext?.found) return syncContext;

    return scannerContext || syncContext || { found: false, lookbackHours: 168 };
}

function buildH4CrossBlock(ctx, direction) {
    const clean = cleanH4CrossContext(ctx);
    if (!clean.found) {
        return `\n┌─ 🧭 RADAR H4 STOCH+CCI ────────\n` +
            `│ Status: sem cruzamento/sync ${direction} recente\n` +
            `│ Janela: ${clean.lookbackHours ? clean.lookbackHours.toFixed(0) : "168"}h\n` +
            `└──────────────────────────────────────\n`;
    }

    const isIncubadoraSync = clean.fallback || clean.source === "INCUBADORA_H4_SYNC";
    const sourceLabel = isIncubadoraSync ? "sync incubadora" : "cruzamento scanner";
    const priceLabel = isIncubadoraSync ? "Preço sync" : "Preço radar";
    const move = Number.isFinite(clean.directionalMovePct)
        ? formatPercent(clean.directionalMovePct)
        : "-";
    const takerLine = clean.takerRatio
        ? `│ Taker no radar: ${clean.takerDominantSide || "-"} | ratio ${clean.takerRatio.toFixed(3)}\n`
        : "";
    const oiArrow = clean.oiTrend === "UP" ? "↑" : clean.oiTrend === "DOWN" ? "↓" : "→";
    const oiLine = Number.isFinite(clean.oiOpenInterest)
        ? `│ OI no radar: ${clean.oiOpenInterest.toFixed(0)} ${clean.oiTrend ? oiArrow : ""}` +
            (Number.isFinite(clean.oiChangePct) ? ` ${formatPercent(clean.oiChangePct)}` : "") + `\n`
        : "";

    return `\n┌─ 🧭 RADAR H4 STOCH+CCI ────────\n` +
        `│ Status: ✅ ${sourceLabel} ${direction} há ${clean.ageHours?.toFixed(1) || "-"}h\n` +
        `│ ${priceLabel}: $${formatPrice(clean.priceAtCross)} | Movimento: ${move}\n` +
        `│ CCI H4: ${clean.prevCci?.toFixed(1) || "-"} → ${clean.lastCci?.toFixed(1) || "-"} (${clean.crossLabel || "-"})\n` +
        `│ Stoch H4: ${clean.stochK?.toFixed(1) || "-"} / ${clean.stochD?.toFixed(1) || "-"}\n` +
        takerLine +
        oiLine +
        `└──────────────────────────────────────\n`;
}

function buildSetupClassification({
    direction,
    fiboBias,
    fvgSide,
    takerScore,
    takerData,
    divH1,
    divM15,
    divH4,
    div12H,
    h4CrossContext,
    lsr,
    lsrResult,
    volData,
    openInterest,
    h4CCI,
    hasEgg,
    source,
    phase,
    energyCycles
}) {
    const h4Regime = classifyH4CCIRegime(h4CCI, direction);
    const cleanLsr = cleanLSR(lsr, lsrResult);
    const cleanH4Cross = cleanH4CrossContext(h4CrossContext);
    return classifyAlert({
        direction,
        phase,
        fiboBias,
        fvgSide,
        takerAligned: !!takerScore?.aligned,
        takerAgainst: !!takerScore?.against,
        takerRatio: takerData?.buyRatio,
        divBias: divH1?.bias || divM15?.bias || null,
        h4SyncFound: !!cleanH4Cross.found,
        h4CrossContext: cleanH4Cross,
        lsr: cleanLsr,
        volumeRel: volData?.relativeVolume,
        volumeStrength: volData?.volumeStrength,
        openInterest,
        h4RegimeCode: h4Regime?.code,
        triggerConfirmed: true,
        hasEgg: !!hasEgg,
        source,
        energyCycles: energyCycles || 0,
        energyThreshold: CONFIG?.ENERGY_CYCLES?.MIN_CYCLES_FOR_SIGNAL ?? 3
    });
}

function recordResearchSetup({
    source,
    symbol,
    direction,
    price,
    cci,
    h4CCI,
    stochH1,
    stochH4,
    volData,
    scoreResult,
    divScore,
    takerScore,
    takerData,
    fibo,
    fiboBias,
    fvgSide,
    lsr,
    lsrResult,
    divH1,
    divM15,
    divH4,
    div12H,
    alertNumber,
    isTurbo,
    hasEgg,
    qualityGate,
    h4CrossContext,
    classification,
    energyCycles
}) {
    try {
        const h4Regime = classifyH4CCIRegime(h4CCI, direction);
        return researchRecorder.recordSetup({
            source,
            symbol,
            direction,
            entryPrice: price,
            alertNumber,
            isTurbo,
            hasEgg,
            energyCycles: energyCycles || 0,
            cciH1: cci,
            cciH4: h4CCI?.current,
            h4RegimeCode: h4Regime?.code,
            h4RegimeLabel: h4Regime?.label,
            stochH1: stochH1?.currentK,
            stochH4: stochH4?.currentK,
            volumeRel: volData?.relativeVolume,
            volumeStrength: volData?.volumeStrength,
            scoreTecnico: scoreResult?.percentage ?? qualityGate?.score,
            scoreDivergence: divScore?.adjusted,
            scoreInstitucional: takerScore?.adjusted ?? qualityGate?.score,
            takerRatio: takerData?.buyRatio,
            takerBuyPct: takerData?.buyPct,
            takerSellPct: takerData?.sellPct,
            takerDominantSide: takerData?.dominantSide,
            fiboZone: fibo ? getFiboZone(price, fibo) : null,
            fiboBias,
            fvgSide,
            lsr: cleanLSR(lsr, lsrResult),
            h4Cross: cleanH4CrossContext(h4CrossContext),
            divergence: {
                h1: cleanDivergence(divH1),
                h4: cleanDivergence(divH4),
                h12: cleanDivergence(div12H),
                m15: cleanDivergence(divM15)
            },
            classification: cleanClassification(classification),
            quality: qualityGate ? {
                score: qualityGate.score,
                blockers: qualityGate.blockers || [],
                pass: !!qualityGate.pass
            } : null
        });
    } catch (e) {
        console.error("Research setup:", e.message);
        return null;
    }
}

function detectAbsorption(volData, takerData, candles, direction) {
    if (!volData || !takerData || !candles || candles.length < 2) return null;

    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    const relVol = parseFloat(volData.relativeVolume || 0);
    const ratio = parseFloat(takerData.buyRatio || 1);
    const bodyPct = last.open > 0 ? (Math.abs(last.close - last.open) / last.open) * 100 : 0;
    const closeMovePct = prev.close > 0 ? ((last.close - prev.close) / prev.close) * 100 : 0;

    const longAbsorption = direction === "LONG" && relVol >= 1.5 && ratio >= 1.3 && bodyPct <= 1.2;
    const shortAbsorption = direction === "SHORT" && relVol >= 1.5 && ratio <= 0.7 && bodyPct <= 1.2;

    if (!longAbsorption && !shortAbsorption) return null;

    return {
        direction,
        relativeVolume: relVol,
        bodyPct,
        closeMovePct,
        label: direction === "LONG"
            ? "compra agressiva com preço comprimido"
            : "venda agressiva com preço comprimido"
    };
}

function buildAbsorptionBlock(absorption) {
    if (!absorption) return "";
    return `
┌─ 💣 *ABSORÇÃO DETECTADA* ──────────
` +
        `│ Leitura: ${absorption.label}
` +
        `│ Volume: ${absorption.relativeVolume.toFixed(2)}x
` +
        `│ Corpo da vela H1: ${absorption.bodyPct.toFixed(2)}%
` +
        `│ Movimento vs vela anterior: ${formatPercent(absorption.closeMovePct)}
` +
        `│ Possível acúmulo antes de expansão
` +
        `└──────────────────────────────────────
`;
}

function hasRecentQualityBlock(egg) {
    if (!egg?.waitingQuality?.at) return false;
    const maxAgeMs = Math.max(5, CONFIG.TIMING.LOOP_INTERVAL_MINUTES || 10) * 60 * 1000;
    return Date.now() - egg.waitingQuality.at <= maxAgeMs;
}

function getSetupCooldownMs(hasEgg) {
    const minutes = hasEgg
        ? CONFIG.FILTERS.GOLD_EGG_SETUP_COOLDOWN_MINUTES
        : CONFIG.FILTERS.SETUP_COOLDOWN_MINUTES;
    return Math.max(1, minutes || 45) * 60 * 1000;
}

function getBreakoutContext(candles, direction, lookback = 18) {
    if (!candles || candles.length < lookback + 2) return null;
    const last = candles[candles.length - 1];
    const previous = candles.slice(-(lookback + 1), -1);
    const prevHigh = Math.max(...previous.map(c => c.high));
    const prevLow = Math.min(...previous.map(c => c.low));
    const candleRange = last.high - last.low;
    const closeLocation = candleRange > 0 ? ((last.close - last.low) / candleRange) * 100 : 50;

    if (direction === "LONG") {
        const breakoutPct = prevHigh > 0 ? ((last.close - prevHigh) / prevHigh) * 100 : 0;
        return {
            passed: last.close > prevHigh * 1.001 && closeLocation >= 50,
            level: prevHigh,
            breakoutPct,
            closeLocation,
            label: last.close > prevHigh
                ? `rompeu topo H1 recente (${formatPercent(breakoutPct)})`
                : `ainda abaixo do topo H1 (${formatPercent(breakoutPct)})`
        };
    }

    const breakoutPct = prevLow > 0 ? ((prevLow - last.close) / prevLow) * 100 : 0;
    return {
        passed: last.close < prevLow * 0.999 && closeLocation <= 50,
        level: prevLow,
        breakoutPct,
        closeLocation,
        label: last.close < prevLow
            ? `perdeu fundo H1 recente (${formatPercent(breakoutPct)})`
            : `ainda acima do fundo H1 (${formatPercent(breakoutPct)})`
    };
}

function buildGoldEggQualityBlock(gate) {
    if (!gate) return "";
    const status = gate.pass ? "✅ LIBERADO" : "⏳ AGUARDAR";
    const lines = gate.reasons.map(reason => `│ ${reason}`).join("\n");
    return `\n┌─ 🧪 *QUALIDADE DO OVO* ────────────\n` +
        `│ Status: ${status} | Score: ${gate.score}/100\n` +
        lines + "\n" +
        `└──────────────────────────────────────\n`;
}

async function assessGoldEggQuality(symbol, direction, { price, h1, h4, fiboBias, fvgSide, lsrResult, volData, takerData }) {
    const reasons = [];
    let score = 0;
    const blockers = [];

    if (volData?.hasVolumeSpike) {
        score += volData.volumeStrength === "EXPLOSIVO" ? 25 : 20;
        reasons.push(`✅ Volume trigger: ${volData.relativeVolume}x (${volData.volumeStrength})`);
    } else {
        blockers.push("volume");
        reasons.push(`❌ Volume trigger: ${volData?.relativeVolume || "0"}x (sem expansão)`);
    }

    const breakCtx = getBreakoutContext(h1, direction);
    if (breakCtx?.passed) {
        score += 35;
        reasons.push(`✅ Estrutura H1: ${breakCtx.label}`);
    } else {
        blockers.push("estrutura");
        reasons.push(`❌ Estrutura H1: ${breakCtx?.label || "dados insuficientes"}`);
    }

    const rangeInfo = await rangeDetector.detectRange(symbol, h4, "4h");
    if (rangeInfo) {
        const goodRange =
            (direction === "LONG" && rangeInfo.edgeType !== "NEAR_RESISTANCE") ||
            (direction === "SHORT" && rangeInfo.edgeType !== "NEAR_SUPPORT");
        if (goodRange) {
            score += 10;
            reasons.push(`✅ Range H4: ${rangeInfo.rangePosition}% (${rangeInfo.edgeType})`);
        } else {
            score -= 10;
            reasons.push(`⚠️ Range H4: ${rangeInfo.rangePosition}% (${rangeInfo.edgeType})`);
        }
    }

    const lsrContra =
        (direction === "LONG" && lsrResult?.isBearish) ||
        (direction === "SHORT" && lsrResult?.isBullish);
    if (lsrContra) {
        blockers.push("lsr");
        reasons.push("❌ LSR contra o setup");
    } else if (lsrResult?.isBullish || lsrResult?.isBearish || lsrResult?.isAlert) {
        score += 10;
        reasons.push("✅ LSR sem conflito direcional");
    } else {
        score += 5;
        reasons.push("➖ LSR neutro");
    }

    if ((direction === "LONG" && fiboBias?.isDiscount) || (direction === "SHORT" && fiboBias?.isRisk)) {
        score += 10;
        reasons.push("✅ Fibo favorece a direção");
    } else if ((direction === "LONG" && fiboBias?.isRisk) || (direction === "SHORT" && fiboBias?.isDiscount)) {
        score -= 10;
        reasons.push("⚠️ Fibo contra a direção");
    }

    if ((direction === "LONG" && fvgSide === "BULL") || (direction === "SHORT" && fvgSide === "BEAR")) {
        score += 10;
        reasons.push("✅ FVG H4 a favor");
    } else if ((direction === "LONG" && fvgSide === "BEAR") || (direction === "SHORT" && fvgSide === "BULL")) {
        reasons.push("⚠️ FVG H4 contra; precisa rompimento forte");
    }

    const takerScore = analyzeTakerForSetup(takerData, direction);
    if (takerScore.aligned) {
        score += takerScore.impact;
        reasons.push(`🐋 Taker alinhado: ${takerScore.label} (+${takerScore.impact})`);
    } else if (takerScore.against) {
        score += takerScore.impact;
        reasons.push(`⚠️ Taker contra: ${takerScore.label} (${takerScore.impact})`);
    }

    score = Math.max(0, Math.min(100, Math.round(score)));
    return {
        pass: blockers.length === 0 && score >= 60,
        score,
        blockers,
        reasons
    };
}

// ==================== LSR ====================
async function getLSR(symbol) {
    try {
        const [accounts, positions] = await Promise.all([
            axios.get("https://fapi.binance.com/futures/data/globalLongShortAccountRatio", {
                params: { symbol, period: "1h", limit: 2 }
            }),
            axios.get("https://fapi.binance.com/futures/data/topLongShortPositionRatio", {
                params: { symbol, period: "1h", limit: 2 }
            })
        ]);
        const acc = accounts.data, pos = positions.data;
        if (!acc || acc.length < 2 || !pos || pos.length < 2) return null;

        const lastAcc = acc[acc.length-1], prevAcc = acc[acc.length-2];
        const lastPos = pos[pos.length-1], prevPos = pos[pos.length-2];
        const posRatio = parseFloat(lastPos.longShortRatio);
        const rawPL    = parseFloat(lastPos.longPosition);
        const rawPS    = parseFloat(lastPos.shortPosition);

        return {
            accounts: {
                ratio:     parseFloat(lastAcc.longShortRatio),
                prevRatio: parseFloat(prevAcc.longShortRatio),
                long:      parseFloat(lastAcc.longAccount),
                short:     parseFloat(lastAcc.shortAccount),
                trend:     parseFloat(lastAcc.longShortRatio) > parseFloat(prevAcc.longShortRatio) ? "UP" : "DOWN"
            },
            positions: {
                ratio:     posRatio,
                prevRatio: parseFloat(prevPos.longShortRatio),
                long:      isNaN(rawPL)||rawPL===0 ? posRatio/(1+posRatio) : rawPL,
                short:     isNaN(rawPS)||rawPS===0 ? 1/(1+posRatio)        : rawPS,
                trend:     parseFloat(lastPos.longShortRatio) > parseFloat(prevPos.longShortRatio) ? "UP" : "DOWN"
            }
        };
    } catch (e) { return null; }
}

function analyzeLSR(lsr) {
    if (!lsr) return null;
    const acc = lsr.accounts.ratio, pos = lsr.positions.ratio;
    const prevPos = lsr.positions.prevRatio;
    let posChange = null;
    if (prevPos > 0) posChange = ((pos - prevPos) / prevPos) * 100;

    if (acc < 0.8  && pos > 1)   return { label: "DIVERGÊNCIA BULLISH (forte)",          emoji: "🐋", isBullish: true,  isBearish: false, isAlert: true,  posChange };
    if (acc > 1.2  && pos < 1)   return { label: "DIVERGÊNCIA BEARISH (forte)",           emoji: "🐻", isBullish: false, isBearish: true,  isAlert: true,  posChange };
    if (acc >= 0.8 && acc <= 1.2 && pos > 1.3) return { label: "ALERTA BULLISH — baleias comprando", emoji: "⚡", isBullish: true,  isBearish: false, isAlert: true,  posChange };
    if (acc >= 0.8 && acc <= 1.2 && pos < 0.7) return { label: "ALERTA BEARISH — baleias vendendo",  emoji: "⚡", isBullish: false, isBearish: true,  isAlert: true,  posChange };
    if (acc > 1.2  && pos > 1)   return { label: "MUITO LONG (risco de squeeze)",         emoji: "⚠️", isBullish: false, isBearish: false, isAlert: false, posChange };
    if (acc < 0.8  && pos < 1)   return { label: "MUITO SHORT (risco de squeeze)",        emoji: "⚠️", isBullish: false, isBearish: false, isAlert: false, posChange };
    return { label: "NEUTRO", emoji: "➖", isBullish: false, isBearish: false, isAlert: false, posChange };
}

// Detecta divergências ocultas entre preço e posições das baleias (portado do indexv7)
function detectSqueeze(lsr, currentPrice, previousPrice, eggType) {
    if (!lsr || !previousPrice) return "";
    const priceDown        = currentPrice < previousPrice;
    const priceUp          = currentPrice > previousPrice;
    const whalesLong       = lsr.positions.ratio > 1.0;
    const whalesShort      = lsr.positions.ratio < 1.0;
    const whalesIncreasing = lsr.positions.trend === "UP";
    const whalesDecreasing = lsr.positions.trend === "DOWN";
    if (eggType === "LONG"  && priceDown && whalesLong  && whalesIncreasing)
        return "\n⚠️ *DIVERGÊNCIA OCULTA:* preço caindo mas baleias comprando → possível LONG SQUEEZE!";
    if (eggType === "SHORT" && priceUp   && whalesShort && whalesDecreasing)
        return "\n⚠️ *DIVERGÊNCIA OCULTA:* preço subindo mas baleias vendendo → possível SHORT SQUEEZE!";
    return "";
}

// Monta o bloco detalhado de LSR para o Telegram (portado e expandido do indexv7)
function buildLSRBlock(lsr, lsrResult, isLong) {
    if (!lsr) return "";
    const accLongPct  = isNaN(lsr.accounts.long)  ? 0 : lsr.accounts.long  * 100;
    const accShortPct = isNaN(lsr.accounts.short) ? 0 : lsr.accounts.short * 100;
    const posLongPct  = isNaN(lsr.positions.long) ? 0 : lsr.positions.long * 100;
    const posShortPct = isNaN(lsr.positions.short)? 0 : lsr.positions.short* 100;
    const accArrow    = lsr.accounts.trend  === "UP" ? "↑" : "↓";
    const posArrow    = lsr.positions.trend === "UP" ? "↑" : "↓";
    const accChange   = lsr.accounts.prevRatio  ? ` (${lsr.accounts.prevRatio.toFixed(2)} → ${lsr.accounts.ratio.toFixed(2)})`   : "";
    const posChange   = lsr.positions.prevRatio ? ` (${lsr.positions.prevRatio.toFixed(2)} → ${lsr.positions.ratio.toFixed(2)})` : "";

    let lsrLabel  = lsrResult ? `${lsrResult.emoji} ${lsrResult.label}` : "➖ NEUTRO";
    let alignLine = "";
    if (isLong  === true  && lsrResult?.isBullish) alignLine = "\n│ 🐋 *BALEIAS ALINHADAS COM O LONG!*";
    if (isLong  === false && lsrResult?.isBearish) alignLine = "\n│ 🐻 *BALEIAS ALINHADAS COM O SHORT!*";

    // Variação percentual das baleias
    let posChangeLine = "";
    if (lsrResult?.posChange != null && Math.abs(lsrResult.posChange) >= 5) {
        const arrow = lsrResult.posChange > 0 ? "📈" : "📉";
        posChangeLine = `\n│ ${arrow} *Variação baleias:* ${formatPercent(lsrResult.posChange)}`;
    }

    return `\n┌─ 📊 *SENTIMENTO (LSR)* ─────────────\n` +
        `│ 👥 *Varejo (contas):* \`${lsr.accounts.ratio.toFixed(2)}\` ${accArrow}${accChange}\n` +
        `│    _${accLongPct.toFixed(1)}% long_ | _${accShortPct.toFixed(1)}% short_\n` +
        `│ 🐋 *Top Traders (posições):* \`${lsr.positions.ratio.toFixed(2)}\` ${posArrow}${posChange}\n` +
        `│    _${posLongPct.toFixed(1)}% long_ | _${posShortPct.toFixed(1)}% short_\n` +
        `│ 🔍 *Leitura:* ${lsrLabel}${posChangeLine}${alignLine}\n` +
        `└──────────────────────────────────────\n`;
}

// ==================== DETECTOR DE OVOS ====================
async function detectGoldEggs() {
    if (!CONFIG.GOLD_EGG.ENABLED) return;
    console.log("🔍 Procurando ovos de ouro...");
    const symbols = await getLiquidSymbols();

    for (const symbol of symbols) {
        try {
            const h4 = await getCandles(symbol, "4h", 20);
            if (!h4) continue;
            const stoch = calculateStochastic(h4);
            if (!stoch) continue;
            const price = h4[h4.length-1].close;
            const now   = Date.now();

            // OVO LONG
            if (CONFIG.GOLD_EGG.LONG.ACTIVE &&
                stoch.currentK <= CONFIG.GOLD_EGG.LONG.STOCH_H4_THRESHOLD &&
                !state.goldEggsLong.has(symbol))
            {
                const strength = stoch.currentK <= 10 ? "EXTREMO" : stoch.currentK <= 15 ? "FORTE" : "MODERADO";
                state.goldEggsLong.set(symbol, { symbol, type:"LONG", detectedAt:now, price, stochH4:stoch.currentK, strength, status:"DETECTED" });
                saveEggs();
                console.log(`🥚 OVO LONG: ${symbol} Stoch=${stoch.currentK.toFixed(1)}`);
                await sendTelegram(
                    `🥚 *OVO LONG DETECTADO*\n\n` +
                    `📈 *${symbol}*\n` +
                    `📊 Stoch H4: ${stoch.currentK.toFixed(1)} (${stoch.direction}) — ${strength}\n` +
                    `💰 Preço: $${price.toFixed(6)}\n` +
                    `🎯 Aguardando CCI > ${CONFIG.GOLD_EGG.LONG.MIN_CCI_FOR_TRIGGER}\n` +
                    `🔗 ${tvLink(symbol)}\n` +
                    `⏰ ${new Date().toLocaleString("pt-BR")}`
                );
            }

            // OVO SHORT
            if (CONFIG.GOLD_EGG.SHORT.ACTIVE &&
                stoch.currentK >= CONFIG.GOLD_EGG.SHORT.STOCH_H4_THRESHOLD &&
                stoch.direction === "DOWN" &&
                !state.goldEggsShort.has(symbol))
            {
                const strength = stoch.currentK >= 95 ? "EXTREMO" : stoch.currentK >= 90 ? "FORTE" : "MODERADO";
                state.goldEggsShort.set(symbol, { symbol, type:"SHORT", detectedAt:now, price, stochH4:stoch.currentK, strength, status:"DETECTED" });
                saveEggs();
                console.log(`🔥 OVO SHORT: ${symbol} Stoch=${stoch.currentK.toFixed(1)}`);
                await sendTelegram(
                    `🔥 *OVO SHORT DETECTADO*\n\n` +
                    `📉 *${symbol}*\n` +
                    `📊 Stoch H4: ${stoch.currentK.toFixed(1)} (${stoch.direction}) — ${strength}\n` +
                    `💰 Preço: $${price.toFixed(6)}\n` +
                    `🎯 Aguardando CCI < ${CONFIG.GOLD_EGG.SHORT.MAX_CCI_FOR_TRIGGER}\n` +
                    `🔗 ${tvLink(symbol)}\n` +
                    `⏰ ${new Date().toLocaleString("pt-BR")}`
                );
            }

            await sleep(CONFIG.TIMING.SLEEP_BETWEEN_REQUESTS_MS);
        } catch (e) {
            console.error(`❌ Ovos ${symbol}:`, e.message);
        }
    }
}

// ==================== ATIVAR OVOS (com Fibo + FVG + LSR detalhado) ====================
async function checkGoldEggTriggers(symbol, cci, price, stochH4, h4, fibo, h4CCI, h4ForCCI = h4) {
    // ---- LONG ----
    const longEgg = state.goldEggsLong.get(symbol);
    if (longEgg && longEgg.status === "DETECTED" && cci >= CONFIG.GOLD_EGG.LONG.MIN_CCI_FOR_TRIGGER) {
        const [lsr, h1, m15, h12, volData, openInterestContext] = await Promise.all([
            getLSR(symbol),
            getCandles(symbol, "1h", 70),
            getCandles(symbol, "15m", 70),
            getCandles(symbol, "12h", 70),
            volumeAnalyzer.getVolumeAnalysis(symbol, "1h"),
            getOpenInterestTrend(symbol)
        ]);
        const lsrResult   = analyzeLSR(lsr);
        const cciStrength = classifyCCI(cci);
        const fvgs        = detectFVGs(h4);
        const prevPrice   = h1 ? h1[h1.length-2]?.close : null;
        const squeeze     = detectSqueeze(lsr, price, prevPrice, "LONG");
        const priceChg    = ((price - longEgg.price) / longEgg.price) * 100;
        const divH1       = detectCCIDivergence(h1, "LONG", "H1");
        const divM15      = detectCCIDivergence(m15, "LONG", "15m");
        const divH4       = detectCCIDivergence(getClosedCandles(h4ForCCI), "LONG", "H4");
        const div12H      = detectCCIDivergence(getClosedCandles(h12), "LONG", "12h");
        const takerData   = await retestMonitor.fetchTakerVolume(symbol);

        // Confluência Fibo × direção
        let fiboConfl = "";
        const fiboBias = fibo ? getFiboBias(price, fibo) : null;
        if (fiboBias?.isDiscount) fiboConfl = "\n✅ *Fibo: zona de desconto confirma LONG!*";
        if (fiboBias?.isRisk)     fiboConfl = "\n⚠️ *Fibo: zona de risco — cautela no LONG*";

        const fvgSide = getFVGSide(price, fvgs);
        const qualityGate = await assessGoldEggQuality(symbol, "LONG", {
            price, h1, h4, fiboBias, fvgSide, lsrResult, volData, takerData
        });
        if (!qualityGate.pass) {
            longEgg.waitingQuality = { at: Date.now(), score: qualityGate.score, blockers: qualityGate.blockers };
            saveEggs();
            state.todayStats.skipped++;
            console.log(`⏳ ${symbol} — ovo LONG aguardando confirmação (${qualityGate.blockers.join(", ") || "score"} | ${qualityGate.score}/100)`);
            return;
        }

        longEgg.status = "TRIGGERED"; longEgg.triggeredAt = Date.now(); longEgg.triggerPrice = price;
        saveEggs();

        const lsrBlock  = buildLSRBlock(lsr, lsrResult, true);
        const fiboBlock = buildFiboBlock(fibo, price);
        const fvgBlock  = buildFVGBlock(price, fvgs);
        const qualityBlock = buildGoldEggQualityBlock(qualityGate);
        const divBlock  = buildCCIDivergenceBlock(divH1, divM15, true, fiboBias, fvgSide, divH4, div12H);
        const h4CrossContext = getSetupH4CrossContext(symbol, "LONG", price);
        const goldLongDivScore = applyDivergenceScore(qualityGate.score, divH1, divM15, divH4, div12H);
        const goldLongTakerScore = applyTakerScore(goldLongDivScore.adjusted, takerData, "LONG");
        const classification = buildSetupClassification({
            direction: "LONG",
            fiboBias,
            fvgSide,
            takerScore: goldLongTakerScore,
            takerData,
            divH1,
            divM15,
            divH4,
            div12H,
            h4CrossContext,
            lsr,
            lsrResult,
            volData,
            openInterest: openInterestContext,
            h4CCI,
            hasEgg: true,
            energyCycles: cciEggMonitor.getEnergyCycles(symbol),
            source: "GOLD_EGG_TRIGGER"
        });
        const classificationBlock = buildClassificationBlock(classification);

        state.todayStats.triggered++;
        console.log(`🚀 OVO LONG ATIVADO: ${symbol}`);
        await sendTelegram(
            `🚀 *OVO DE OURO LONG ATIVADO! ENTRADA!*\n\n` +
            `📈 *${symbol}*\n` +
            `💰 Preço: $${formatPrice(price)}\n` +
            `📊 CCI H1: ${cci.toFixed(1)} (${cciStrength} — rompeu +${CONFIG.GOLD_EGG.LONG.MIN_CCI_FOR_TRIGGER})\n` +
            buildH4CCIRegimeLine(h4CCI, "LONG") +
            `📈 Variação desde detecção: ${formatPercent(priceChg)}\n` +
            `🥚 Stoch H4: ${longEgg.stochH4.toFixed(1)} → ${stochH4?.currentK?.toFixed(1)||"N/A"} (${stochH4?.direction||"?"})\n` +
            `📊 Força detecção: ${longEgg.strength}\n` +
            `📌 Detecção: $${formatPrice(longEgg.price)}\n` +
            classificationBlock +
            fiboConfl +
            qualityBlock + lsrBlock + fiboBlock + fvgBlock + divBlock +
            RetestMonitor.buildTakerBlock(takerData) +
            `⚠️ *Oversold H4 + CCI rompendo = PUMP potencial*${squeeze}\n` +
            `🎯 Alvos: 5-8% scalp | 15%+ swing\n` +
            `🛑 Stop: abaixo do suporte H4\n` +
            `🔗 ${tvLink(symbol)}\n` +
            `⏰ ${new Date().toLocaleString("pt-BR")}\n` +
            `⚠️ _Não é conselho financeiro._`
        );

        const researchId = recordResearchSetup({
            source: "GOLD_EGG_TRIGGER",
            symbol,
            direction: "LONG",
            price,
            cci,
            h4CCI,
            stochH1: null,
            stochH4,
            volData,
            scoreResult: { percentage: qualityGate.score },
            divScore: goldLongDivScore,
            takerScore: goldLongTakerScore,
            takerData,
            fibo,
            fiboBias,
            fvgSide,
            lsr,
            lsrResult,
            divH1,
            divM15,
            divH4,
            div12H,
            alertNumber: null,
            isTurbo: Math.abs(cci) >= CONFIG.INDICATORS.CCI.TURBO_THRESHOLD,
            hasEgg: true,
            energyCycles: cciEggMonitor.getEnergyCycles(symbol),
            qualityGate,
            h4CrossContext,
            classification
        });

        retestMonitor.register({
            symbol,
            direction: "LONG",
            alertPrice: price,
            h4,
            fibo,
            fvgs,
            researchId
        });

        cciEggMonitor.register({
            symbol,
            direction: "LONG",
            alertPrice: price,
            triggeredAt: longEgg.triggeredAt,
            cciH1: cci,
            cciH4: h4CCI?.current,
            stochH4Start: longEgg.stochH4,
            stochH4Current: stochH4?.currentK,
            researchId
        });
    }

    // ---- SHORT ----
    const shortEgg = state.goldEggsShort.get(symbol);
    if (shortEgg && shortEgg.status === "DETECTED" && cci <= CONFIG.GOLD_EGG.SHORT.MAX_CCI_FOR_TRIGGER) {
        const [lsr, h1, m15, h12, volData, openInterestContext] = await Promise.all([
            getLSR(symbol),
            getCandles(symbol, "1h", 70),
            getCandles(symbol, "15m", 70),
            getCandles(symbol, "12h", 70),
            volumeAnalyzer.getVolumeAnalysis(symbol, "1h"),
            getOpenInterestTrend(symbol)
        ]);
        const lsrResult   = analyzeLSR(lsr);
        const cciStrength = classifyCCI(cci);
        const fvgs        = detectFVGs(h4);
        const prevPrice   = h1 ? h1[h1.length-2]?.close : null;
        const squeeze     = detectSqueeze(lsr, price, prevPrice, "SHORT");
        const priceChg    = ((price - shortEgg.price) / shortEgg.price) * 100;
        const divH1       = detectCCIDivergence(h1, "SHORT", "H1");
        const divM15      = detectCCIDivergence(m15, "SHORT", "15m");
        const divH4       = detectCCIDivergence(getClosedCandles(h4ForCCI), "SHORT", "H4");
        const div12H      = detectCCIDivergence(getClosedCandles(h12), "SHORT", "12h");
        const takerData   = await retestMonitor.fetchTakerVolume(symbol);

        let fiboConfl = "";
        const fiboBias = fibo ? getFiboBias(price, fibo) : null;
        if (fiboBias?.isRisk)     fiboConfl = "\n✅ *Fibo: zona de risco confirma SHORT!*";
        if (fiboBias?.isDiscount) fiboConfl = "\n⚠️ *Fibo: zona de desconto — cautela no SHORT*";

        const fvgSide = getFVGSide(price, fvgs);
        const qualityGate = await assessGoldEggQuality(symbol, "SHORT", {
            price, h1, h4, fiboBias, fvgSide, lsrResult, volData, takerData
        });
        if (!qualityGate.pass) {
            shortEgg.waitingQuality = { at: Date.now(), score: qualityGate.score, blockers: qualityGate.blockers };
            saveEggs();
            state.todayStats.skipped++;
            console.log(`⏳ ${symbol} — ovo SHORT aguardando confirmação (${qualityGate.blockers.join(", ") || "score"} | ${qualityGate.score}/100)`);
            return;
        }

        shortEgg.status = "TRIGGERED"; shortEgg.triggeredAt = Date.now(); shortEgg.triggerPrice = price;
        saveEggs();

        const lsrBlock  = buildLSRBlock(lsr, lsrResult, false);
        const fiboBlock = buildFiboBlock(fibo, price);
        const fvgBlock  = buildFVGBlock(price, fvgs);
        const qualityBlock = buildGoldEggQualityBlock(qualityGate);
        const divBlock  = buildCCIDivergenceBlock(divH1, divM15, false, fiboBias, fvgSide, divH4, div12H);
        const h4CrossContext = getSetupH4CrossContext(symbol, "SHORT", price);
        const goldShortDivScore = applyDivergenceScore(qualityGate.score, divH1, divM15, divH4, div12H);
        const goldShortTakerScore = applyTakerScore(goldShortDivScore.adjusted, takerData, "SHORT");
        const classification = buildSetupClassification({
            direction: "SHORT",
            fiboBias,
            fvgSide,
            takerScore: goldShortTakerScore,
            takerData,
            divH1,
            divM15,
            divH4,
            div12H,
            h4CrossContext,
            lsr,
            lsrResult,
            volData,
            openInterest: openInterestContext,
            h4CCI,
            hasEgg: true,
            energyCycles: cciEggMonitor.getEnergyCycles(symbol),
            source: "GOLD_EGG_TRIGGER"
        });
        const classificationBlock = buildClassificationBlock(classification);

        state.todayStats.triggered++;
        console.log(`💀 OVO SHORT ATIVADO: ${symbol}`);
        await sendTelegram(
            `💀 *OVO DE OURO SHORT ATIVADO! ENTRADA!*\n\n` +
            `📉 *${symbol}*\n` +
            `💰 Preço: $${formatPrice(price)}\n` +
            `📊 CCI H1: ${cci.toFixed(1)} (${cciStrength} — rompeu ${CONFIG.GOLD_EGG.SHORT.MAX_CCI_FOR_TRIGGER})\n` +
            buildH4CCIRegimeLine(h4CCI, "SHORT") +
            `📈 Variação desde detecção: ${formatPercent(priceChg)}\n` +
            `🔥 Stoch H4: ${shortEgg.stochH4.toFixed(1)} → ${stochH4?.currentK?.toFixed(1)||"N/A"} (${stochH4?.direction||"?"})\n` +
            `📊 Força detecção: ${shortEgg.strength}\n` +
            `📌 Detecção: $${formatPrice(shortEgg.price)}\n` +
            classificationBlock +
            fiboConfl +
            qualityBlock + lsrBlock + fiboBlock + fvgBlock + divBlock +
            RetestMonitor.buildTakerBlock(takerData) +
            `⚠️ *Overbought H4 + CCI rompendo = DUMP potencial*${squeeze}\n` +
            `🎯 Alvos: 5-8% scalp | 15%+ swing (short)\n` +
            `🛑 Stop: acima da resistência H4\n` +
            `🔗 ${tvLink(symbol)}\n` +
            `⏰ ${new Date().toLocaleString("pt-BR")}\n` +
            `⚠️ _Não é conselho financeiro._`
        );

        const researchId = recordResearchSetup({
            source: "GOLD_EGG_TRIGGER",
            symbol,
            direction: "SHORT",
            price,
            cci,
            h4CCI,
            stochH1: null,
            stochH4,
            volData,
            scoreResult: { percentage: qualityGate.score },
            divScore: goldShortDivScore,
            takerScore: goldShortTakerScore,
            takerData,
            fibo,
            fiboBias,
            fvgSide,
            lsr,
            lsrResult,
            divH1,
            divM15,
            divH4,
            div12H,
            alertNumber: null,
            isTurbo: Math.abs(cci) >= CONFIG.INDICATORS.CCI.TURBO_THRESHOLD,
            hasEgg: true,
            energyCycles: cciEggMonitor.getEnergyCycles(symbol),
            qualityGate,
            h4CrossContext,
            classification
        });

        retestMonitor.register({
            symbol,
            direction: "SHORT",
            alertPrice: price,
            h4,
            fibo,
            fvgs,
            researchId
        });

        cciEggMonitor.register({
            symbol,
            direction: "SHORT",
            alertPrice: price,
            triggeredAt: shortEgg.triggeredAt,
            cciH1: cci,
            cciH4: h4CCI?.current,
            stochH4Start: shortEgg.stochH4,
            stochH4Current: stochH4?.currentK,
            researchId
        });
    }
}

// ==================== ANÁLISE PRINCIPAL ====================
async function analyzeSymbol(symbol) {
    try {
        // Busca H1, M15, H4 e semanal em paralelo
        const h4CCILimit = Math.max(
            60,
            CONFIG.INDICATORS.CCI.PERIOD + (CONFIG.INCUBADORA?.H4_LOOKBACK_CANDLES || 24) + 5
        );
        const [h1, m15, h4ForCCI, w1] = await Promise.all([
            getCandles(symbol, "1h", 70),
            getCandles(symbol, "15m", 70),
            getCandles(symbol, "4h", h4CCILimit),
            getCandles(symbol, "1w", 10)
        ]);
        if (!h1 || !h4ForCCI) return null;

        // Mantém 20 candles no restante da estratégia; o candle extra serve
        // somente para comparar o CCI H4 atual com o anterior.
        const h4 = h4ForCCI.slice(-20);
        const h4CCI = getH4CCIValues(h4ForCCI);

        const cciArr = calculateCCI(h1);
        if (cciArr.length < 2) return null;

        const cci     = cciArr[cciArr.length-1];
        const prevCCI = cciArr[cciArr.length-2];
        const stochH1 = calculateStochastic(h1);
        const stochH4 = calculateStochastic(h4);
        const price   = h1[h1.length-1].close;
        const fibo    = w1 ? calcWeeklyFibo(w1) : null;
        const fvgs    = detectFVGs(h4);

        const isLongBreak  = prevCCI <= CONFIG.INDICATORS.CCI.THRESHOLD_HIGH && cci > CONFIG.INDICATORS.CCI.THRESHOLD_HIGH;
        const isShortBreak = prevCCI >= CONFIG.INDICATORS.CCI.THRESHOLD_LOW  && cci < CONFIG.INDICATORS.CCI.THRESHOLD_LOW;
        const setupDirection = isLongBreak ? "LONG" : isShortBreak ? "SHORT" : null;
        const h12 = setupDirection ? await getCandles(symbol, "12h", 70) : null;
        const divH1  = setupDirection ? detectCCIDivergence(h1, setupDirection, "H1") : null;
        const divM15 = setupDirection ? detectCCIDivergence(m15, setupDirection, "15m") : null;
        const divH4  = setupDirection ? detectCCIDivergence(getClosedCandles(h4ForCCI), setupDirection, "H4") : null;
        const div12H = setupDirection ? detectCCIDivergence(getClosedCandles(h12), setupDirection, "12h") : null;

        // Verificar ativação de ovos sempre (mesmo sem breakout)
        await incubadora.analyze(symbol, {
            candlesH1: h1,
            candlesH4: h4ForCCI
        });

        await checkGoldEggTriggers(symbol, cci, price, stochH4, h4, fibo, h4CCI, h4ForCCI);

        if (!isLongBreak && !isShortBreak) return null;
        return { symbol, price, cci, prevCCI, h4CCI, stochH1, stochH4, isLongBreak, isShortBreak, fibo, fvgs, divH1, divM15, divH4, div12H, h1 };
    } catch (e) {
        console.error(`❌ Análise ${symbol}:`, e.message);
        return null;
    }
}

// ==================== ALERTA DE SETUP (com Fibo + FVG + LSR detalhado) ====================
async function sendSetupAlert(analysis) {
    const { symbol, price, cci, h4CCI, stochH1, stochH4, isLongBreak, fibo, fvgs, divH1, divM15, divH4, div12H, h1 } = analysis;
    const setupType = isLongBreak ? "LONG" : "SHORT";

    resetDailyCountersIfNeeded();
    const todayKey = getBrazilDateKey();
    const counterKey = `${symbol}_${setupType}`;
    if (!state.alertCounters[counterKey])
        state.alertCounters[counterKey] = { lastAlert: 0, dailyCount: 0, countDate: todayKey };

    // Cooldown por par e direção. Ovo tem prioridade no score, mas não fura repetição.
    const counter = state.alertCounters[counterKey];
    const setupEgg = isLongBreak ? state.goldEggsLong.get(symbol) : state.goldEggsShort.get(symbol);
    const hasEgg  = !!setupEgg;
    if (hasRecentQualityBlock(setupEgg)) {
        state.todayStats.skipped++;
        console.log(`⏳ ${symbol} — setup ${setupType} pulado: ovo aguardando qualidade (${setupEgg.waitingQuality.score}/100)`);
        return;
    }
    const cooldownMs = getSetupCooldownMs(hasEgg);
    const elapsedMs = Date.now() - counter.lastAlert;
    if (elapsedMs < cooldownMs) {
        const waitMin = Math.ceil((cooldownMs - elapsedMs) / 60000);
        state.todayStats.skipped++;
        console.log(`⏳ ${symbol} — cooldown ${setupType}${hasEgg ? " ovo" : ""}: aguardar ${waitMin} min`);
        return;
    }
    if (counter.dailyCount >= CONFIG.FILTERS.MAX_ALERTS_PER_SYMBOL) {
        state.todayStats.skipped++;
        console.log(`⏭️  ${symbol} — limite diário atingido (${counter.dailyCount}/${CONFIG.FILTERS.MAX_ALERTS_PER_SYMBOL})`);
        return;
    }

    // Volume obrigatório
    const volData = await volumeAnalyzer.getVolumeAnalysis(symbol, "1h");
    if (!volData || !volData.hasVolumeSpike) {
        state.todayStats.skipped++;
        console.log(`⏭️  ${symbol} — volume insuficiente (${volData?.relativeVolume||"0"}x)`);
        return;
    }

    // Score mínimo 70%
    const pricePos    = await volumeAnalyzer.getPricePosition(symbol);
    const scoreResult = await setupScorer.calculateScore(
        { isNewHighSignal: isLongBreak, stochH1, stochH4, hasGoldEgg: hasEgg },
        volData, pricePos
    );
    if (parseInt(scoreResult.percentage) < 70 && !hasEgg) {
        state.todayStats.skipped++;
        console.log(`⏭️  ${symbol} — score baixo (${scoreResult.percentage}%)`);
        return;
    }

    // LSR: buscar e verificar conflito (lógica de filtro original mantida)
    const lsr       = await getLSR(symbol);
    const lsrResult = analyzeLSR(lsr);
    const [takerData, openInterestContext] = await Promise.all([
        retestMonitor.fetchTakerVolume(symbol),
        getOpenInterestTrend(symbol)
    ]);
    const h4CrossContext = getSetupH4CrossContext(symbol, setupType, price);

    if (lsrResult) {
        if (isLongBreak  && lsrResult.isBearish) { state.todayStats.skipped++; console.log(`⏭️  ${symbol} — LSR bearish contraria LONG`);  return; }
        if (!isLongBreak && lsrResult.isBullish) { state.todayStats.skipped++; console.log(`⏭️  ${symbol} — LSR bullish contraria SHORT`); return; }
    }

    // Tudo ok — enviar alerta
    state.alertCounters[counterKey].dailyCount++;
    const alertNumber = state.alertCounters[counterKey].dailyCount;
    state.alertCounters[counterKey].lastAlert = Date.now();
    state.alertCounters[counterKey].lastSetupType = setupType;
    state.alertCounters[counterKey].lastPrice = price;
    saveAlertCounters();
    state.todayStats.highQuality++;
    if (lsrResult?.isAlert) state.todayStats.lsrAlerts++;

    const emoji      = isLongBreak ? "🟢" : "🔴";
    const isTurbo    = Math.abs(cci) >= CONFIG.INDICATORS.CCI.TURBO_THRESHOLD;
    const eggTag     = hasEgg ? " 🥚" : "";
    const stochH4C   = stochH4 ? (stochH4.currentK <= 20 ? "🟢" : stochH4.currentK >= 88 ? "🔴" : "🟡") : "";
    const cciStrength = classifyCCI(cci);

    // Confluência Fibo × direção do setup
    let fiboConfl = "";
    const fiboBias = fibo ? getFiboBias(price, fibo) : null;
    if (isLongBreak  && fiboBias?.isDiscount) fiboConfl = "\n✅ *Fibo: zona de desconto confirma LONG!*";
    if (!isLongBreak && fiboBias?.isRisk)     fiboConfl = "\n✅ *Fibo: zona de risco confirma SHORT!*";
    if (isLongBreak  && fiboBias?.isRisk)     fiboConfl = "\n⚠️ *Fibo: zona de risco — cautela no LONG*";
    if (!isLongBreak && fiboBias?.isDiscount) fiboConfl = "\n⚠️ *Fibo: zona de desconto — cautela no SHORT*";

    const lsrBlock  = buildLSRBlock(lsr, lsrResult, isLongBreak);
    const fiboBlock = buildFiboBlock(fibo, price);
    const fvgBlock  = buildFVGBlock(price, fvgs);
    const fvgSide   = getFVGSide(price, fvgs);
    const divBlock  = buildCCIDivergenceBlock(divH1, divM15, isLongBreak, fiboBias, fvgSide, divH4, div12H);
    const h4CrossBlock = buildH4CrossBlock(h4CrossContext, setupType);
    const divScore  = applyDivergenceScore(scoreResult.percentage, divH1, divM15, divH4, div12H);
    const takerScore = applyTakerScore(divScore.adjusted, takerData, setupType);
    const absorption = detectAbsorption(volData, takerData, h1, setupType);
    const classification = buildSetupClassification({
        direction: setupType,
        fiboBias,
        fvgSide,
        takerScore,
        takerData,
        divH1,
        divM15,
        divH4,
        div12H,
        h4CrossContext,
        lsr,
        lsrResult,
        volData,
        openInterest: openInterestContext,
        h4CCI,
        hasEgg,
        energyCycles: cciEggMonitor.getEnergyCycles(symbol),
        source: "SETUP_ALERT"
    });
    const classificationBlock = buildClassificationBlock(classification);
    const scoreLine = `📈 Score Técnico: ${scoreResult.percentage}%` +
        (divScore.impact ? ` → ${divScore.adjusted}% (divergência ${divScore.impact > 0 ? "+" : ""}${divScore.impact})` : "") +
        (takerScore.impact ? `
🐋 Score Institucional: ${takerScore.adjusted}% (Taker ${takerScore.impact > 0 ? "+" : ""}${takerScore.impact})` : `
🐋 Score Institucional: ${takerScore.adjusted}%`);

    await sendTelegram(
        `${emoji} *${setupType} SETUP*${eggTag}${isTurbo?" 🚀 TURBO":""} ${emoji}\n\n` +
        `💹 *${symbol}*\n` +
        `💰 Preço: $${formatPrice(price)}\n` +
        `📊 CCI H1: ${cci.toFixed(1)} (${cciStrength})\n` +
        buildH4CCIRegimeLine(h4CCI, setupType) +
        `✅ Volume: ${volData.relativeVolume}x (${volData.volumeStrength})\n` +
        (stochH1 ? `🟡 Stoch H1: ${stochH1.currentK.toFixed(1)} (${stochH1.direction})\n` : "") +
        (stochH4 ? `${stochH4C} Stoch H4: ${stochH4.currentK.toFixed(1)} (${stochH4.direction})\n` : "") +
        classificationBlock +
        scoreLine +
        fiboConfl + "\n" +
        h4CrossBlock + lsrBlock + fiboBlock + fvgBlock + divBlock +
        RetestMonitor.buildTakerBlock(takerData) +
        buildAbsorptionBlock(absorption) +
        `🔁 *Alerta #${alertNumber} do dia*\n\n` +
        `🎯 Alvos: 5-8% scalp | 15%+ swing\n` +
        `🛑 Stop: ${isLongBreak?"abaixo do suporte H4":"acima da resistência H4"}\n` +
        `🔗 ${tvLink(symbol)}\n` +
        `⏰ ${new Date().toLocaleString("pt-BR")}\n` +
        `⚠️ _Não é conselho financeiro._`
    );

    const researchId = recordResearchSetup({
        source: "SETUP_ALERT",
        symbol,
        direction: setupType,
        price,
        cci,
        h4CCI,
        stochH1,
        stochH4,
        volData,
        scoreResult,
        divScore,
        takerScore,
        takerData,
        fibo,
        fiboBias,
        fvgSide,
        lsr,
        lsrResult,
        divH1,
        divM15,
        divH4,
        div12H,
        alertNumber,
        isTurbo,
        hasEgg,
        energyCycles: cciEggMonitor.getEnergyCycles(symbol),
        qualityGate: null,
        h4CrossContext,
        classification
    });

    retestMonitor.register({
        symbol,
        direction: setupType,
        alertPrice: price,
        h4: await getCandles(symbol, "4h", 20),
        fibo,
        fvgs,
        researchId
    });

    console.log(`✅ ${symbol} — alerta enviado (${setupType} | score ${scoreResult.percentage}% → inst ${takerScore.adjusted}% | CCI ${cciStrength} | #${alertNumber} hoje)`);
}

// ==================== COMANDO /lsr (portado do indexv7) ====================
let lastUpdateId = 0;

async function sendLSRReport(symbol, chatId) {
    const sym = symbol.toUpperCase().endsWith("USDT")
        ? symbol.toUpperCase()
        : symbol.toUpperCase() + "USDT";
    try {
        const lsr = await getLSR(sym);
        if (!lsr) {
            await sendTelegramTo(chatId,
                `⚠️ LSR indisponível para *${sym}*\n` +
                `_Símbolo pode não existir ou não ter dados de futuros na Binance._`
            );
            return;
        }
        const lsrResult = analyzeLSR(lsr);
        const lsrBlock  = buildLSRBlock(lsr, lsrResult, null);
        await sendTelegramTo(chatId,
            `🔍 *LSR — ${sym}*\n` +
            lsrBlock +
            `🔗 ${tvLink(sym)}\n` +
            `⏰ ${new Date().toLocaleString("pt-BR")}`
        );
    } catch (e) {
        await sendTelegramTo(chatId, `❌ Erro ao buscar LSR para *${sym}*: ${e.message}`);
    }
}

async function handleUpdate(update) {
    const msg = update.message || update.channel_post;
    if (!msg || !msg.text) return;
    const text   = msg.text.trim();
    const chatId = msg.chat.id;
    const match  = text.match(/^\/lsr(?:@\S+)?\s+(\S+)/i);
    if (match) {
        console.log(`Comando /lsr recebido: ${match[1]} (chat ${chatId})`);
        await sendTelegramTo(chatId, `⏳ Buscando LSR para *${match[1].toUpperCase()}*...`);
        await sendLSRReport(match[1], chatId);
    }
}

async function pollCommands() {
    while (true) {
        try {
            const res = await axios.get(
                `https://api.telegram.org/bot${CONFIG.TELEGRAM.TOKEN}/getUpdates`,
                {
                    params: { offset: lastUpdateId + 1, timeout: 30, allowed_updates: ["message", "channel_post"] },
                    timeout: 35000
                }
            );
            for (const update of (res.data.result || [])) {
                lastUpdateId = update.update_id;
                await handleUpdate(update);
            }
        } catch (e) {
            if (!e.message.includes("timeout")) console.error("pollCommands:", e.message);
            await sleep(3000);
        }
    }
}

// ==================== LOOP PRINCIPAL ====================
async function mainLoop() {
    const start = Date.now();
    console.log(`\n🔄 ${new Date().toLocaleString("pt-BR")} — CICLO INICIADO`);
    try {
        await stochCciH4Scanner.checkAndSend();
        await detectGoldEggs();
        const symbols = await getLiquidSymbols();
        console.log(`📊 Analisando ${symbols.length} pares...`);

        for (const symbol of symbols) {
            const analysis = await analyzeSymbol(symbol);
            if (analysis) await sendSetupAlert(analysis);
            await sleep(CONFIG.TIMING.SLEEP_BETWEEN_REQUESTS_MS);
        }

        await retestMonitor.checkAll(getCandles);
        console.log(`👁️  Retest monitor: ${retestMonitor.getWatchingCount()} pares sob observação`);

        await cciEggMonitor.checkAll(getCandles);
        console.log(`🧠 CCI Egg monitor: ${cciEggMonitor.getWatchingCount()} ovos sob observação`);

        incubadora.cleanupOldCycles();
        console.log(`🥚 Incubadora: ${incubadora.getWatchingCount()} ciclos sob observação`);

        const stochCciStatus = stochCciH4Scanner.getLastStatus();
        if (stochCciStatus?.scanned) {
            console.log(`Stoch+CCI H4: ${stochCciStatus.signals} sinais no ultimo fechamento`);
        }

        cleanupOldEggs();

        const elapsed = ((Date.now()-start)/1000).toFixed(1);
        console.log(`\n📈 RESUMO (${elapsed}s):`);
        console.log(`✅ Alta qualidade: ${state.todayStats.highQuality}`);
        console.log(`🚀 Ovos ativados:  ${state.todayStats.triggered}`);
        console.log(`🐋 Alertas LSR:    ${state.todayStats.lsrAlerts}`);
        console.log(`⏭️  Ignorados:       ${state.todayStats.skipped}`);
        console.log(`🥚 LONG ativos: ${Array.from(state.goldEggsLong.values()).filter(e=>e.status==="DETECTED").length}`);
        console.log(`🔥 SHORT ativos: ${Array.from(state.goldEggsShort.values()).filter(e=>e.status==="DETECTED").length}`);
        console.log("🎯 CICLO CONCLUÍDO");
    } catch (e) {
        console.error("❌ ERRO NO CICLO:", e.message);
    }
}

// ==================== LIMPEZA ====================
function cleanupOldEggs() {
    const maxAge = CONFIG.GOLD_EGG.MONITOR_HOURS * 60 * 60 * 1000;
    const nowMs  = Date.now();
    let removed  = 0;
    for (const [sym, egg] of state.goldEggsLong.entries())
        if (egg.status === "TRIGGERED" || nowMs - egg.detectedAt > maxAge) { state.goldEggsLong.delete(sym);  removed++; }
    for (const [sym, egg] of state.goldEggsShort.entries())
        if (egg.status === "TRIGGERED" || nowMs - egg.detectedAt > maxAge) { state.goldEggsShort.delete(sym); removed++; }
    if (removed > 0) { saveEggs(); console.log(`🧹 ${removed} ovos removidos`); }

    const brasiliaHour = (new Date().getUTCHours() - 3 + 24) % 24;
    if (brasiliaHour === CONFIG.TIMING.RESET_DAILY_HOUR && !state._lastResetDate) {
        state.todayStats    = { highQuality:0, triggered:0, lsrAlerts:0, skipped:0 };
        state._lastResetDate = getBrazilDateKey();
        console.log("🔄 Stats diárias resetadas (21h BR)");
    } else if (state._lastResetDate !== getBrazilDateKey()) {
        state.todayStats    = { highQuality:0, triggered:0, lsrAlerts:0, skipped:0 };
        state._lastResetDate = getBrazilDateKey();
        console.log("🔄 Stats diárias resetadas (pós-reinício)");
    }
}

// ==================== INICIALIZAÇÃO ====================
async function start() {
    console.log("🚀 INICIANDO BOT ZEZIM PRO v2");
    loadEggs();
    loadAlertCounters();
    state._lastResetDate = getBrazilDateKey();
    await sendTelegram(
        `🤖 *BOT ZEZIM PRO v2 — ONLINE* 🚀\n\n` +
        `✅ Ovos carregados: ${state.goldEggsLong.size} LONG | ${state.goldEggsShort.size} SHORT\n\n` +
        `🆕 *Novidades v2:*\n` +
        `📐 Fibo semanal invertida (zona + nível + bias) ✅\n` +
        `🧲 Fair Value Gaps H4 — ICT ✅\n` +
        `📊 LSR detalhado (ratios + % + variação) ✅\n` +
        `⚠️ Detecção de squeeze oculto ✅\n` +
        `🔥 Classificação CCI (FRACO→EXTREMO) ✅\n` +
        `🧠 Monitor CCI dos ovos ativados ✅\n` +
        `🔍 Comando /lsr <SYMBOL> ativo ✅\n\n` +
        `📊 Filtros ativos:\n` +
        `• Volume mínimo: ${CONFIG.INDICATORS.VOLUME.MIN_RELATIVE_VOLUME}x\n` +
        `• Score mínimo: 70%\n` +
        `• LSR como filtro de conflito ✅\n` +
        `• Cooldown setup: ${CONFIG.FILTERS.SETUP_COOLDOWN_MINUTES} min\n` +
        `• Cooldown setup com ovo: ${CONFIG.FILTERS.GOLD_EGG_SETUP_COOLDOWN_MINUTES} min\n` +
        `⏰ Ciclo: ${CONFIG.TIMING.LOOP_INTERVAL_MINUTES} min`
    );
    pollCommands(); // roda em paralelo sem bloquear o mainLoop
    await mainLoop();
    setInterval(mainLoop, CONFIG.TIMING.LOOP_INTERVAL_MINUTES * 60 * 1000);
}

start().catch(e => { console.error("💥 ERRO:", e); process.exit(1); });

process.on("SIGINT", () => {
    saveEggs();
    saveAlertCounters();
    console.log(`\n📊 FINAL: ${state.todayStats.highQuality} alertas | ${state.todayStats.triggered} ovos ativados`);
    process.exit(0);
});
