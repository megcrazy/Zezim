// retest_monitor.js — MONITOR DE RETESTE + STOP HUNTER + TAKER VOLUME
// Bot Zezim Pro v2
// Depois de um alerta, monitora se o ativo faz reteste em zona de suporte/resistência
// e detecta stop hunters (wick longo que perfura mas fecha de volta)

const axios = require("axios");

class RetestMonitor {
    constructor(config, sendTelegramFn, formatPriceFn, formatPercentFn, tvLinkFn, options = {}) {
        this.config       = config;
        this.sendTelegram = sendTelegramFn;
        this.formatPrice  = formatPriceFn;
        this.formatPct    = formatPercentFn;
        this.tvLink       = tvLinkFn;
        this.researchRecorder = options.researchRecorder || null;

        // Map de alertas ativos sendo monitorados
        // key: symbol_direction  ex: "STGUSDT_LONG"
        // value: { symbol, direction, alertPrice, alertAt, support, resistance,
        //          fvgSupport, fvgResistance, fiboLevel, retestAlertSent, stopHunterSent }
        this.watching = new Map();

        // Cooldown para não spammar alertas de reteste
        this.retestCooldownMs = 30 * 60 * 1000; // 30 min
    }

    // ========================================================
    // REGISTRAR UM ALERTA PARA MONITORAMENTO
    // Chamado logo após sendSetupAlert ou checkGoldEggTriggers
    // ========================================================
    register({ symbol, direction, alertPrice, h4, fibo, fvgs, researchId = null }) {
        const key = `${symbol}_${direction}`;

        // Extrair suporte e resistência do H4 (últimas 20 velas)
        const { support, resistance } = this._calcSupportResistance(h4);

        // FVG mais relevante como zona de reteste
        const fvgSupport    = this._findFVGSupport(alertPrice, fvgs);
        const fvgResistance = this._findFVGResistance(alertPrice, fvgs);

        // Nível Fibo mais próximo abaixo (para LONG) ou acima (para SHORT)
        const fiboLevel = this._findFiboRetestLevel(alertPrice, fibo, direction);

        const entry = {
            symbol,
            direction,
            alertPrice,
            researchId,
            alertAt: Date.now(),
            support,
            resistance,
            fvgSupport,
            fvgResistance,
            fiboLevel,
            retestAlertSent: false,
            stopHunterSent: false,
            takerAlertSent: false,
            maxMonitorMs: 6 * 60 * 60 * 1000, // monitorar por 6 horas
            lastCheckedAt: 0
        };

        this.watching.set(key, entry);
        console.log(`👁️  RetestMonitor: registrando ${key} | suporte=${this.formatPrice(support)} | FVG=${fvgSupport ? this.formatPrice(fvgSupport.top) : "N/A"} | Fibo=${fiboLevel ? this.formatPrice(fiboLevel.value) : "N/A"}`);
    }

    // ========================================================
    // CICLO PRINCIPAL — chamar no mainLoop, após analyzeSymbol
    // ========================================================
    async checkAll(getCandles) {
        const now = Date.now();
        const toRemove = [];

        for (const [key, entry] of this.watching.entries()) {
            // Expirou?
            if (now - entry.alertAt > entry.maxMonitorMs) {
                toRemove.push(key);
                console.log(`🕐 RetestMonitor: ${key} expirou após 6h`);
                continue;
            }

            // Throttle: não checar mais de 1x por ciclo de 10min
            if (now - entry.lastCheckedAt < 8 * 60 * 1000) continue;
            entry.lastCheckedAt = now;

            try {
                // Buscar candles M15 (mais sensível para reteste) e H1
                const [m15, h1] = await Promise.all([
                    getCandles(entry.symbol, "15m", 20),
                    getCandles(entry.symbol, "1h",  10)
                ]);
                if (!m15 || !h1) continue;

                const currentPrice = m15[m15.length - 1].close;
                const currentCandle = m15[m15.length - 1];

                // 1. Checar stop hunter
                if (!entry.stopHunterSent) {
                    const sh = this._detectStopHunter(m15, entry, currentPrice);
                    if (sh) {
                        entry.stopHunterSent = true;
                        await this._alertStopHunter(entry, sh, currentPrice);
                    }
                }

                // 2. Checar reteste em zona
                if (!entry.retestAlertSent) {
                    const rt = this._detectRetest(currentCandle, m15, entry);
                    if (rt) {
                        entry.retestAlertSent = true;
                        // Checar taker volume para confirmar
                        const takerData = await this._getTakerVolume(entry.symbol);
                        await this._alertRetest(entry, rt, currentPrice, takerData);
                    }
                }

                // 3. Alerta de taker volume autônomo (compra agressiva na zona)
                if (!entry.takerAlertSent && !entry.retestAlertSent) {
                    const takerData = await this._getTakerVolume(entry.symbol);
                    const takerSignal = this._analyzeTakerSignal(takerData, entry.direction);
                    if (takerSignal && this._isNearZone(currentPrice, entry)) {
                        entry.takerAlertSent = true;
                        await this._alertTakerActivity(entry, takerSignal, currentPrice);
                    }
                }

            } catch (e) {
                console.error(`❌ RetestMonitor ${key}:`, e.message);
            }
        }

        for (const k of toRemove) this.watching.delete(k);
    }

    // ========================================================
    // DETECÇÃO DE STOP HUNTER
    // wick longo perfura suporte/resistência mas fecha de volta
    // ========================================================
    _detectStopHunter(m15candles, entry, currentPrice) {
        // Verificar últimas 3 velas M15
        const recent = m15candles.slice(-4);

        for (const candle of recent) {
            const wickDown = candle.open - candle.low;   // wick inferior
            const wickUp   = candle.high - candle.open;  // wick superior
            const body     = Math.abs(candle.close - candle.open);
            const range    = candle.high - candle.low;

            if (range === 0) continue;

            // STOP HUNTER DE BAIXA (para LONG):
            // Wick inferior longo, fecha acima do suporte
            if (entry.direction === "LONG") {
                const zones = this._getZonesBelowPrice(entry);
                for (const zone of zones) {
                    const perfurou = candle.low < zone.price * 0.999; // perfurou 0.1% abaixo
                    const fechouAcima = candle.close > zone.price;
                    const wickDominante = wickDown > body * 1.5 && wickDown > range * 0.4;

                    if (perfurou && fechouAcima && wickDominante) {
                        const wickPct = ((candle.open - candle.low) / candle.open * 100).toFixed(2);
                        return {
                            type: "STOP_HUNTER_BAIXA",
                            zone: zone.label,
                            zonePrice: zone.price,
                            wickPct,
                            candleLow: candle.low,
                            candleClose: candle.close
                        };
                    }
                }
            }

            // STOP HUNTER DE ALTA (para SHORT):
            // Wick superior longo, fecha abaixo da resistência
            if (entry.direction === "SHORT") {
                const zones = this._getZonesAbovePrice(entry);
                for (const zone of zones) {
                    const perfurou = candle.high > zone.price * 1.001;
                    const fechouAbaixo = candle.close < zone.price;
                    const wickDominante = wickUp > body * 1.5 && wickUp > range * 0.4;

                    if (perfurou && fechouAbaixo && wickDominante) {
                        const wickPct = ((candle.high - candle.open) / candle.open * 100).toFixed(2);
                        return {
                            type: "STOP_HUNTER_ALTA",
                            zone: zone.label,
                            zonePrice: zone.price,
                            wickPct,
                            candleHigh: candle.high,
                            candleClose: candle.close
                        };
                    }
                }
            }
        }

        return null;
    }

    // ========================================================
    // DETECÇÃO DE RETESTE EM ZONA
    // preço retorna para suporte/FVG/Fibo e segura
    // ========================================================
    _detectRetest(currentCandle, m15candles, entry) {
        const price = currentCandle.close;
        const zones = entry.direction === "LONG"
            ? this._getZonesBelowPrice(entry)
            : this._getZonesAbovePrice(entry);

        for (const zone of zones) {
            const tolerance = zone.price * 0.015; // 1.5% de tolerância

            if (entry.direction === "LONG") {
                // Preço tocou a zona e está fechando acima dela
                const tocouZona = currentCandle.low <= zone.price + tolerance;
                const fechandoAcima = currentCandle.close > zone.price * 0.995;
                // Confirmação: vela com fechamento positivo (bullish)
                const vElaBullish = currentCandle.close > currentCandle.open;

                if (tocouZona && fechandoAcima && vElaBullish) {
                    // Verificar que o preço veio de cima (reteste real, não lateral)
                    const precoAntes = m15candles.slice(-8, -3).map(c => c.close);
                    const maxAntes = Math.max(...precoAntes);
                    const veioDeCima = maxAntes > zone.price * 1.01; // estava 1%+ acima

                    if (veioDeCima) {
                        return {
                            type: "RETEST_SUPORTE",
                            zone: zone.label,
                            zonePrice: zone.price,
                            currentPrice: price,
                            distFromAlert: ((price - entry.alertPrice) / entry.alertPrice * 100).toFixed(2)
                        };
                    }
                }
            } else {
                // SHORT: preço subiu até zona de resistência e está fechando abaixo
                const tocouZona = currentCandle.high >= zone.price - tolerance;
                const fechandoAbaixo = currentCandle.close < zone.price * 1.005;
                const velaBearish = currentCandle.close < currentCandle.open;

                if (tocouZona && fechandoAbaixo && velaBearish) {
                    const precoAntes = m15candles.slice(-8, -3).map(c => c.close);
                    const minAntes = Math.min(...precoAntes);
                    const veioDeBaixo = minAntes < zone.price * 0.99;

                    if (veioDeBaixo) {
                        return {
                            type: "RETEST_RESISTENCIA",
                            zone: zone.label,
                            zonePrice: zone.price,
                            currentPrice: price,
                            distFromAlert: ((price - entry.alertPrice) / entry.alertPrice * 100).toFixed(2)
                        };
                    }
                }
            }
        }

        return null;
    }

    // ========================================================
    // TAKER VOLUME — busca aggTrades da Binance
    // Mostra quem está comprando/vendendo AGRESSIVAMENTE
    // ========================================================
    async _getTakerVolume(symbol) {
        try {
            // Endpoint de taker buy/sell volume nos últimos períodos
            const response = await axios.get(
                "https://fapi.binance.com/futures/data/takerlongshortRatio",
                { params: { symbol, period: "5m", limit: 6 }, timeout: 8000 }
            );

            const data = response.data;
            if (!data || data.length < 2) return null;

            const lastEntry = data[data.length - 1];
            const prevEntry = data[data.length - 2];

            // A Binance chama o campo de buySellRatio. Quando os volumes estão
            // disponíveis, derivamos a razão deles para manter ratio, % e lado coerentes.
            const parsePeriod = (entry) => {
                const buyVol = parseFloat(entry?.buyVol || 0);
                const sellVol = parseFloat(entry?.sellVol || 0);
                const apiRatio = parseFloat(entry?.buySellRatio);
                const derivedRatio = sellVol > 0 ? buyVol / sellVol : NaN;
                const ratio = Number.isFinite(derivedRatio)
                    ? derivedRatio
                    : Number.isFinite(apiRatio) ? apiRatio : 1;
                return { buyVol, sellVol, ratio };
            };

            const current = parsePeriod(lastEntry);
            const previous = parsePeriod(prevEntry);
            const currentRatio = current.ratio;
            const prevRatio = previous.ratio;
            const trend = currentRatio > prevRatio ? "UP" : currentRatio < prevRatio ? "DOWN" : "FLAT";

            const buyVol  = current.buyVol;
            const sellVol = current.sellVol;
            const total   = buyVol + sellVol;
            const buyPct  = total > 0 ? (buyVol / total * 100).toFixed(1) : "50.0";
            const sellPct = total > 0 ? (sellVol / total * 100).toFixed(1) : "50.0";

            return {
                buyRatio:  currentRatio.toFixed(3),
                prevRatio: prevRatio.toFixed(3),
                trend,
                buyVol,
                sellVol,
                buyPct,
                sellPct,
                strongBuy:  currentRatio > 1.3,
                strongSell: currentRatio < 0.7,
                dominantSide: currentRatio >= 1.0 ? "COMPRA" : "VENDA",
                source: "takerlongshortRatio"
            };
        } catch (e) {
            // Fallback: tentar aggTrades para calcular manualmente
            try {
                const aggResp = await axios.get(
                    "https://fapi.binance.com/fapi/v1/aggTrades",
                    { params: { symbol, limit: 200 }, timeout: 8000 }
                );
                const trades = aggResp.data;
                if (!trades || trades.length === 0) return null;

                let buyVol = 0, sellVol = 0;
                for (const t of trades) {
                    const qty = parseFloat(t.q) * parseFloat(t.p); // volume em USD
                    if (t.m === false) buyVol  += qty; // m=false: taker comprou (market buy)
                    else               sellVol += qty; // m=true:  taker vendeu (market sell)
                }
                const total = buyVol + sellVol;
                const ratio = sellVol > 0 ? buyVol / sellVol : 1;
                return {
                    buyRatio:      ratio.toFixed(3),
                    prevRatio:     "N/A",
                    trend:         ratio > 1 ? "UP" : ratio < 1 ? "DOWN" : "FLAT",
                    buyVol,
                    sellVol,
                    buyPct:        total > 0 ? (buyVol / total * 100).toFixed(1) : "50.0",
                    sellPct:       total > 0 ? (sellVol / total * 100).toFixed(1) : "50.0",
                    strongBuy:     ratio > 1.3,
                    strongSell:    ratio < 0.7,
                    dominantSide:  ratio >= 1.0 ? "COMPRA" : "VENDA",
                    source:        "aggTrades"
                };
            } catch (e2) {
                console.error(`❌ TakerVolume ${symbol}:`, e2.message);
                return null;
            }
        }
    }

    _analyzeTakerSignal(takerData, direction) {
        if (!takerData) return null;
        if (direction === "LONG"  && takerData.strongBuy)  return { signal: "TAKER_BUY_FORTE",  ...takerData };
        if (direction === "SHORT" && takerData.strongSell) return { signal: "TAKER_SELL_FORTE", ...takerData };
        return null;
    }

    _isNearZone(currentPrice, entry) {
        const zones = entry.direction === "LONG"
            ? this._getZonesBelowPrice(entry)
            : this._getZonesAbovePrice(entry);
        return zones.some(z => Math.abs(currentPrice - z.price) / z.price <= 0.02); // dentro de 2%
    }

    // ========================================================
    // HELPERS DE ZONA
    // ========================================================
    _getZonesBelowPrice(entry) {
        const zones = [];
        if (entry.support)     zones.push({ label: "Suporte H4",   price: entry.support });
        if (entry.fvgSupport)  zones.push({ label: "FVG Bullish H4", price: entry.fvgSupport.top });
        if (entry.fiboLevel)   zones.push({ label: `Fibo ${entry.fiboLevel.label}`, price: entry.fiboLevel.value });
        return zones.filter(z => z.price < entry.alertPrice * 1.01);
    }

    _getZonesAbovePrice(entry) {
        const zones = [];
        if (entry.resistance)     zones.push({ label: "Resistência H4",   price: entry.resistance });
        if (entry.fvgResistance)  zones.push({ label: "FVG Bearish H4",   price: entry.fvgResistance.bottom });
        if (entry.fiboLevel)      zones.push({ label: `Fibo ${entry.fiboLevel.label}`, price: entry.fiboLevel.value });
        return zones.filter(z => z.price > entry.alertPrice * 0.99);
    }

    _calcSupportResistance(h4) {
        if (!h4 || h4.length < 5) return { support: null, resistance: null };
        const recent = h4.slice(-20);
        return {
            support:    Math.min(...recent.map(c => c.low)),
            resistance: Math.max(...recent.map(c => c.high))
        };
    }

    _findFVGSupport(alertPrice, fvgs) {
        if (!fvgs || !fvgs.length) return null;
        return fvgs
            .filter(f => f.type === "BULL" && f.top < alertPrice * 1.02)
            .sort((a, b) => b.top - a.top)[0] || null;
    }

    _findFVGResistance(alertPrice, fvgs) {
        if (!fvgs || !fvgs.length) return null;
        return fvgs
            .filter(f => f.type === "BEAR" && f.bottom > alertPrice * 0.98)
            .sort((a, b) => a.bottom - b.bottom)[0] || null;
    }

    _findFiboRetestLevel(alertPrice, fibo, direction) {
        if (!fibo) return null;
        const levels = [
            { label: "61.8%", value: fibo.fib618 },
            { label: "70.6%", value: fibo.fib706 },
            { label: "79%",   value: fibo.fib79  },
            { label: "50%",   value: fibo.fib50  }
        ];
        if (direction === "LONG") {
            // Nível Fibo mais próximo ABAIXO do preço do alerta (zona de pullback)
            const candidates = levels.filter(l => l.value < alertPrice * 1.01);
            return candidates.sort((a, b) => Math.abs(alertPrice - a.value) - Math.abs(alertPrice - b.value))[0] || null;
        } else {
            // Nível Fibo mais próximo ACIMA do preço do alerta
            const candidates = levels.filter(l => l.value > alertPrice * 0.99);
            return candidates.sort((a, b) => Math.abs(alertPrice - a.value) - Math.abs(alertPrice - b.value))[0] || null;
        }
    }

    _recordResearchEvent(entry, type, currentPrice, details = {}) {
        if (!this.researchRecorder) return;
        try {
            this.researchRecorder.recordEvent({
                eggId: entry.researchId,
                symbol: entry.symbol,
                direction: entry.direction,
                entryPrice: entry.alertPrice,
                type,
                price: currentPrice,
                details
            });
        } catch (e) {
            console.error("RetestMonitor research:", e.message);
        }
    }

    // ========================================================
    // ALERTAS TELEGRAM
    // ========================================================
    async _alertStopHunter(entry, sh, currentPrice) {
        const distPct = ((currentPrice - entry.alertPrice) / entry.alertPrice * 100).toFixed(2);
        const emoji = entry.direction === "LONG" ? "🟢" : "🔴";
        const tipo  = entry.direction === "LONG"
            ? "STOP CAÇADO — LONG AINDA VÁLIDO?"
            : "STOP CAÇADO — SHORT AINDA VÁLIDO?";

        const msg =
            `🎯 *${tipo}*\n\n` +
            `💹 *${entry.symbol}*\n` +
            `📍 Direção original: ${entry.direction}\n` +
            `💰 Preço do alerta: $${this.formatPrice(entry.alertPrice)}\n` +
            `💰 Preço atual: $${this.formatPrice(currentPrice)} (${distPct >= 0 ? "+" : ""}${distPct}%)\n\n` +
            `┌─ 🪤 *STOP HUNTER DETECTADO (M15)* ──\n` +
            `│ Zona perfurada: ${sh.zone} ($${this.formatPrice(sh.zonePrice)})\n` +
            `│ Mínimo da vela: $${this.formatPrice(sh.candleLow || sh.candleHigh)}\n` +
            `│ Fechamento: $${this.formatPrice(sh.candleClose)}\n` +
            `│ Wick: ${sh.wickPct}% (vela de armadilha)\n` +
            `│ Leitura: wick longo + fechamento dentro = stop caçado\n` +
            `└──────────────────────────────────────\n\n` +
            `${emoji} *O setup original ainda está ativo.*\n` +
            `💡 Se fechou acima do suporte: ${entry.direction === "LONG" ? "oportunidade de segunda entrada" : "aguardar rejeição confirmada"}\n` +
            `🔗 ${this.tvLink(entry.symbol)}\n` +
            `⏰ ${new Date().toLocaleString("pt-BR")}\n` +
            `⚠️ _Não é conselho financeiro._`;

        await this.sendTelegram(msg);
        this._recordResearchEvent(entry, "STOP_HUNTER", currentPrice, {
            zone: sh.zone,
            zonePrice: sh.zonePrice,
            wickPct: sh.wickPct,
            candleLow: sh.candleLow || null,
            candleHigh: sh.candleHigh || null,
            candleClose: sh.candleClose
        });
        console.log(`🪤 Stop hunter alertado: ${entry.symbol} ${entry.direction}`);
    }

    async _alertRetest(entry, rt, currentPrice, takerData) {
        const distPct = ((currentPrice - entry.alertPrice) / entry.alertPrice * 100).toFixed(2);
        const emoji = entry.direction === "LONG" ? "🟢" : "🔴";

        let takerBlock = "";
        if (takerData) {
            const takerEmoji = parseFloat(takerData.buyRatio) >= 1.0 ? "🟢" : "🔴";
            takerBlock =
                `\n┌─ 📊 *TAKER VOLUME (confirmação)* ──\n` +
                `│ Compra agressiva: ${takerData.buyPct}%\n` +
                `│ Venda agressiva: ${takerData.sellPct}%\n` +
                `│ Razão buy/sell: ${takerData.buyRatio} ${takerData.trend === "UP" ? "↑" : takerData.trend === "DOWN" ? "↓" : "→"}\n` +
                `│ ${takerEmoji} Dominância: ${takerData.dominantSide}\n` +
                (takerData.strongBuy  ? "│ 🔥 COMPRA INSTITUCIONAL FORTE — confirma LONG\n" : "") +
                (takerData.strongSell ? "│ 💀 VENDA INSTITUCIONAL FORTE — confirma SHORT\n" : "") +
                `└──────────────────────────────────────\n`;
        }

        const msg =
            `${emoji} *RETESTE CONFIRMADO — ${entry.direction}* ${emoji}\n\n` +
            `💹 *${entry.symbol}*\n` +
            `💰 Preço alerta original: $${this.formatPrice(entry.alertPrice)}\n` +
            `💰 Preço atual (reteste): $${this.formatPrice(currentPrice)} (${distPct >= 0 ? "+" : ""}${distPct}%)\n\n` +
            `┌─ 🎯 *ZONA DE RETESTE* ─────────────\n` +
            `│ Tipo: ${rt.type === "RETEST_SUPORTE" ? "Reteste em Suporte" : "Reteste em Resistência"}\n` +
            `│ Zona: ${rt.zone}\n` +
            `│ Preço da zona: $${this.formatPrice(rt.zonePrice)}\n` +
            `│ Leitura: preço voltou, testou e está segurando\n` +
            `└──────────────────────────────────────\n` +
            takerBlock +
            `\n💡 *Esta pode ser a segunda entrada.*\n` +
            `🎯 Alvos: mesmos do alerta original\n` +
            `🛑 Stop: abaixo da zona de reteste ($${this.formatPrice(rt.zonePrice * (entry.direction === "LONG" ? 0.985 : 1.015))})\n` +
            `🔗 ${this.tvLink(entry.symbol)}\n` +
            `⏰ ${new Date().toLocaleString("pt-BR")}\n` +
            `⚠️ _Não é conselho financeiro._`;

        await this.sendTelegram(msg);
        this._recordResearchEvent(entry, "RETEST_CONFIRMED", currentPrice, {
            zone: rt.zone,
            zonePrice: rt.zonePrice,
            retestType: rt.type,
            distFromAlert: rt.distFromAlert,
            taker: takerData ? {
                buyPct: takerData.buyPct,
                sellPct: takerData.sellPct,
                buyRatio: takerData.buyRatio,
                dominantSide: takerData.dominantSide,
                trend: takerData.trend
            } : null
        });
        console.log(`🎯 Reteste alertado: ${entry.symbol} ${entry.direction} em ${rt.zone}`);
    }

    async _alertTakerActivity(entry, takerSignal, currentPrice) {
        const emoji = entry.direction === "LONG" ? "🔥" : "💀";
        const distPct = ((currentPrice - entry.alertPrice) / entry.alertPrice * 100).toFixed(2);

        const msg =
            `${emoji} *TAKER VOLUME NA ZONA — ${entry.symbol}*\n\n` +
            `💹 Setup ${entry.direction} original: $${this.formatPrice(entry.alertPrice)}\n` +
            `💰 Preço atual: $${this.formatPrice(currentPrice)} (${distPct >= 0 ? "+" : ""}${distPct}%)\n\n` +
            `┌─ 📊 *TAKER VOLUME AGRESSIVO* ──────\n` +
            `│ Compra: ${takerSignal.buyPct}% | Venda: ${takerSignal.sellPct}%\n` +
            `│ Razão: ${takerSignal.buyRatio}\n` +
            `│ ${takerSignal.dominantSide === "COMPRA" ? "🟢 COMPRADORES agressivos na zona" : "🔴 VENDEDORES agressivos na zona"}\n` +
            `│ Leitura: ordens de mercado indicam ${takerSignal.dominantSide === "COMPRA" ? "demanda institucional" : "oferta institucional"}\n` +
            `└──────────────────────────────────────\n\n` +
            `💡 Atividade de taker confirma interesse no setup ${entry.direction}\n` +
            `🔗 ${this.tvLink(entry.symbol)}\n` +
            `⏰ ${new Date().toLocaleString("pt-BR")}\n` +
            `⚠️ _Não é conselho financeiro._`;

        await this.sendTelegram(msg);
        this._recordResearchEvent(entry, "TAKER_ZONE", currentPrice, {
            signal: takerSignal.signal,
            buyPct: takerSignal.buyPct,
            sellPct: takerSignal.sellPct,
            buyRatio: takerSignal.buyRatio,
            dominantSide: takerSignal.dominantSide,
            trend: takerSignal.trend
        });
        console.log(`📊 Taker volume alertado: ${entry.symbol} ${entry.direction}`);
    }

    // ========================================================
    // UTILITÁRIO — montar bloco de taker para incluir em alertas normais
    // Chamar opcionalmente em sendSetupAlert para já mostrar taker
    // ========================================================
    static buildTakerBlock(takerData) {
        if (!takerData) return "";
        const emoji = parseFloat(takerData.buyRatio) >= 1.0 ? "🟢" : "🔴";
        const trend = takerData.trend === "UP" ? "↑" : takerData.trend === "DOWN" ? "↓" : "→";
        let alert = "";
        if (takerData.strongBuy)  alert = "\n│ 🔥 *COMPRA INSTITUCIONAL FORTE*";
        if (takerData.strongSell) alert = "\n│ 💀 *VENDA INSTITUCIONAL FORTE*";
        return (
            `\n┌─ 📊 *TAKER VOLUME (5m)* ───────────\n` +
            `│ 🟢 Compra agressiva: ${takerData.buyPct}%\n` +
            `│ 🔴 Venda agressiva:  ${takerData.sellPct}%\n` +
            `│ Razão buy/sell: \`${takerData.buyRatio}\` ${trend}\n` +
            `│ ${emoji} Dominância: ${takerData.dominantSide}${alert}\n` +
            `└──────────────────────────────────────\n`
        );
    }

    // Exposta para uso no bot_principal.js — busca taker e retorna dados
    async fetchTakerVolume(symbol) {
        return this._getTakerVolume(symbol);
    }

    getWatchingCount() {
        return this.watching.size;
    }

    // Remover manualmente (ex: quando ovo é removido)
    unregister(symbol, direction) {
        const key = `${symbol}_${direction}`;
        this.watching.delete(key);
    }
}

module.exports = RetestMonitor;
