/**
 * ema_cross_bot.js
 * -----------------------------------------------------------------------
 * Monitora o cruzamento das EMAs 8 e 89 no timeframe 5m para todos os pares
 * USDT-M perpétuos da Binance Futures e envia alerta no Telegram.
 *
 *   - Golden Cross (bullish): EMA8 cruza EMA89 de baixo para cima
 *   - Death Cross  (bearish): EMA8 cruza EMA89 de cima para baixo
 *
 * O cruzamento só é validado no candle FECHADO (evita repintar/sinal falso
 * de candle em formação). O ciclo de varredura é sincronizado com o
 * fechamento do candle de 5m.
 *
 * Uso:
 *   TELEGRAM_BOT_TOKEN=xxxx TELEGRAM_CHAT_ID=xxxx node ema_cross_bot.js
 *
 * Dependências:
 *   npm install axios
 * -----------------------------------------------------------------------
 */

'use strict';

const axios = require('axios');

// ============================================================
// CONFIG
// ============================================================
const CONFIG = {
  BASE_URL: 'https://fapi.binance.com',
  TIMEFRAME: '4h',
  EMA_FAST: 8,
  EMA_SLOW: 89,
  KLINES_LIMIT: 200,          // candles suficientes para a EMA89 "aquecer"
  CONCURRENCY: 8,             // requisições simultâneas (rate limit friendly)
  REQUEST_DELAY_MS: 120,      // pequeno espaçamento entre lotes
  RETRY_ATTEMPTS: 3,
  RETRY_DELAY_MS: 1500,
  SYMBOL_REFRESH_MIN: 60,     // minutos entre refresh da lista de símbolos
  ONLY_QUOTE: 'USDT',
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',
  // Filtra símbolos específicos (opcional). Deixe null para varrer tudo.
  SYMBOL_WHITELIST: null,     // ex: ['BTCUSDT', 'ETHUSDT']
};

// Guarda o último estado de cruzamento por símbolo, para não repetir alerta
// enquanto a tendência não mudar de lado.
const lastCrossState = new Map(); // symbol -> 'up' | 'down'

// ============================================================
// HTTP helper
// ============================================================
const http = axios.create({
  baseURL: CONFIG.BASE_URL,
  timeout: 10000,
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestWithRetry(fn, attempts = CONFIG.RETRY_ATTEMPTS) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      // 429/418 = rate limit da Binance -> espera mais
      const wait = status === 429 || status === 418
        ? CONFIG.RETRY_DELAY_MS * 3
        : CONFIG.RETRY_DELAY_MS;
      await sleep(wait * (i + 1));
    }
  }
  throw lastErr;
}

// ============================================================
// Binance Futures API
// ============================================================
async function fetchUSDTPerpetuals() {
  if (CONFIG.SYMBOL_WHITELIST && CONFIG.SYMBOL_WHITELIST.length) {
    return CONFIG.SYMBOL_WHITELIST;
  }
  const { data } = await requestWithRetry(() =>
    http.get('/fapi/v1/exchangeInfo')
  );
  return data.symbols
    .filter(
      (s) =>
        s.status === 'TRADING' &&
        s.contractType === 'PERPETUAL' &&
        s.quoteAsset === CONFIG.ONLY_QUOTE
    )
    .map((s) => s.symbol);
}

async function fetchKlines(symbol, interval, limit) {
  const { data } = await requestWithRetry(() =>
    http.get('/fapi/v1/klines', {
      params: { symbol, interval, limit },
    })
  );
  // kline: [openTime, open, high, low, close, volume, closeTime, ...]
  return data.map((k) => ({
    openTime: k[0],
    close: parseFloat(k[4]),
    closeTime: k[6],
    isClosed: true, // último elemento pode estar em formação, tratamos abaixo
  }));
}

// ============================================================
// EMA
// ============================================================
function calcEMASeries(values, period) {
  const k = 2 / (period + 1);
  const ema = new Array(values.length).fill(null);
  // seed: SMA dos primeiros "period" valores
  if (values.length < period) return ema;

  let sma = 0;
  for (let i = 0; i < period; i++) sma += values[i];
  sma /= period;
  ema[period - 1] = sma;

  for (let i = period; i < values.length; i++) {
    ema[i] = values[i] * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

// ============================================================
// Lógica de cruzamento
// ============================================================
function detectCross(closes) {
  const emaFast = calcEMASeries(closes, CONFIG.EMA_FAST);
  const emaSlow = calcEMASeries(closes, CONFIG.EMA_SLOW);

  const n = closes.length;
  // Precisamos de pelo menos 2 candles fechados com EMA89 já calculada
  if (n < 2 || emaSlow[n - 1] === null || emaSlow[n - 2] === null) {
    return null;
  }

  const prevFast = emaFast[n - 2];
  const prevSlow = emaSlow[n - 2];
  const currFast = emaFast[n - 1];
  const currSlow = emaSlow[n - 1];

  const wasBelow = prevFast <= prevSlow;
  const isAbove = currFast > currSlow;
  const wasAbove = prevFast >= prevSlow;
  const isBelow = currFast < currSlow;

  if (wasBelow && isAbove) {
    return { direction: 'up', fast: currFast, slow: currSlow };
  }
  if (wasAbove && isBelow) {
    return { direction: 'down', fast: currFast, slow: currSlow };
  }
  return null;
}

// ============================================================
// Telegram
// ============================================================
async function sendTelegramAlert(text) {
  if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) {
    console.log('[TELEGRAM DESATIVADO] ' + text.replace(/\n/g, ' | '));
    return;
  }
  const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    await axios.post(url, {
      chat_id: CONFIG.TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  } catch (err) {
    console.error('[Telegram] falha ao enviar:', err.response?.data || err.message);
  }
}

function formatAlert(symbol, cross, closeTimeIso) {
  const emoji = cross.direction === 'up' ? '🟢🔼' : '🔴🔽';
  const label = cross.direction === 'up' ? 'GOLDEN CROSS (alta)' : 'DEATH CROSS (baixa)';
  return (
    `${emoji} <b>${symbol}</b> — ${label}\n` +
    `Timeframe: ${CONFIG.TIMEFRAME}\n` +
    `EMA${CONFIG.EMA_FAST}: ${cross.fast.toFixed(6)}\n` +
    `EMA${CONFIG.EMA_SLOW}: ${cross.slow.toFixed(6)}\n` +
    `Candle fechado: ${closeTimeIso}`
  );
}

// ============================================================
// Processamento de um símbolo
// ============================================================
async function processSymbol(symbol) {
  try {
    const klines = await fetchKlines(symbol, CONFIG.TIMEFRAME, CONFIG.KLINES_LIMIT);
    if (klines.length < CONFIG.EMA_SLOW + 2) return; // histórico insuficiente

    // Descarta o último candle se ainda estiver em formação.
    // A Binance retorna o candle corrente como último item; comparamos
    // o closeTime dele com o tempo atual para decidir se já fechou.
    const now = Date.now();
    let usable = klines;
    const last = klines[klines.length - 1];
    if (last.closeTime > now) {
      usable = klines.slice(0, -1);
    }

    const closes = usable.map((k) => k.close);
    const cross = detectCross(closes);
    if (!cross) return;

    const prevState = lastCrossState.get(symbol);
    if (prevState === cross.direction) return; // já alertado nesse sentido

    lastCrossState.set(symbol, cross.direction);

    const lastUsable = usable[usable.length - 1];
    const closeTimeIso = new Date(lastUsable.closeTime).toISOString();
    const msg = formatAlert(symbol, cross, closeTimeIso);
    console.log(msg.replace(/\n/g, ' | '));
    await sendTelegramAlert(msg);
  } catch (err) {
    console.error(`[${symbol}] erro:`, err.message);
  }
}

// ============================================================
// Pool com concorrência limitada (evita estourar rate limit)
// ============================================================
async function runWithConcurrency(items, worker, concurrency) {
  const queue = [...items];
  const runners = new Array(concurrency).fill(null).map(async () => {
    while (queue.length) {
      const item = queue.shift();
      await worker(item);
      await sleep(CONFIG.REQUEST_DELAY_MS);
    }
  });
  await Promise.all(runners);
}

// ============================================================
// Ciclo principal
// ============================================================
let symbolsCache = [];
let symbolsCacheAt = 0;

async function getSymbols() {
  const ageMin = (Date.now() - symbolsCacheAt) / 60000;
  if (!symbolsCache.length || ageMin > CONFIG.SYMBOL_REFRESH_MIN) {
    symbolsCache = await fetchUSDTPerpetuals();
    symbolsCacheAt = Date.now();
    console.log(`[INFO] ${symbolsCache.length} pares USDT-M perpétuos carregados.`);
  }
  return symbolsCache;
}

async function runScan() {
  const startedAt = Date.now();
  const symbols = await getSymbols();
  await runWithConcurrency(symbols, processSymbol, CONFIG.CONCURRENCY);
  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[INFO] Varredura concluída em ${elapsedSec}s (${symbols.length} pares).`);
}

function msUntilNextCandleClose(timeframeMin = 5, bufferSec = 5) {
  const now = new Date();
  const ms = timeframeMin * 60 * 1000;
  const next = Math.ceil((now.getTime() + 1) / ms) * ms;
  return next - now.getTime() + bufferSec * 1000;
}

async function mainLoop() {
  console.log(
    `[START] EMA${CONFIG.EMA_FAST}/EMA${CONFIG.EMA_SLOW} cross bot — timeframe ${CONFIG.TIMEFRAME}`
  );
  // Primeira varredura imediata
  await runScan();

  // A partir daí, sincroniza com o fechamento de cada candle de 5m
  const scheduleNext = () => {
    const wait = msUntilNextCandleClose(5, 5);
    console.log(`[INFO] Próxima varredura em ${(wait / 1000).toFixed(0)}s.`);
    setTimeout(async () => {
      await runScan();
      scheduleNext();
    }, wait);
  };
  scheduleNext();
}

process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
});

mainLoop();

