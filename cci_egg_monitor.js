const fs = require('fs');
const path = require('path');
const { CCI } = require('technicalindicators');

/**
 * CCIEggMonitor
 *
 * Monitora SOMENTE ovos ativados do Zezim.
 * A ideia é acompanhar a saúde do CCI depois da ativação:
 * - H1: pico, pullback, recuperação e perda de níveis 0 / -100 / -200.
 * - H4: contexto maior do movimento e se o ovo está em impulso, sustentação,
 *       correção profunda ou morreu.
 *
 * Para SHORT, o CCI é normalizado internamente multiplicando por -1.
 * Assim, as mesmas regras servem para LONG e SHORT:
 *   direcional >= +100 = impulso a favor
 *   direcional >= 0    = tendência preservada
 *   direcional >= -100 = sustenta/recuperação
 *   direcional >= -200 = correção profunda
 *   direcional < -200  = ovo morto/reset
 */
class CCIEggMonitor {
    constructor(CONFIG, sendTelegram, formatPrice, formatPercent, tvLink, options = {}) {
        this.CONFIG = CONFIG;
        this.sendTelegram = sendTelegram;
        this.formatPrice = formatPrice || ((v) => String(v));
        this.formatPercent = formatPercent || ((v) => `${v.toFixed(2)}%`);
        this.tvLink = tvLink || ((symbol) => symbol);
        this.researchRecorder = options.researchRecorder || null;

        this.stateFile = options.stateFile || path.join(__dirname, 'cci_eggs_state.json');
        this.maxAgeHours = options.maxAgeHours || 96;
        this.minAlertIntervalMs = (options.minAlertIntervalMinutes || 45) * 60 * 1000;
        const configuredPrimaryTargetPct = Number(
            options.primaryTargetPct ??
            process.env.CCI_EGG_PRIMARY_TARGET_PCT ??
            this.CONFIG?.GOLD_EGG?.PRIMARY_TARGET_PCT ??
            5
        );
        this.primaryTargetPct = Number.isFinite(configuredPrimaryTargetPct) && configuredPrimaryTargetPct > 0
            ? configuredPrimaryTargetPct
            : 5;
        this.eggs = new Map();
        this.load();
    }

    load() {
        try {
            if (!fs.existsSync(this.stateFile)) return;
            const raw = fs.readFileSync(this.stateFile, 'utf8');
            const data = JSON.parse(raw);
            this.eggs = new Map((data.eggs || []).map(([symbol, egg]) => [symbol, egg]));
            console.log(`🧠 CCI Egg Monitor carregado: ${this.eggs.size} ovos`);
        } catch (e) {
            console.error('❌ Erro ao carregar CCI Egg Monitor:', e.message);
        }
    }

    save() {
        try {
            const data = {
                savedAt: new Date().toISOString(),
                eggs: Array.from(this.eggs.entries())
            };
            fs.writeFileSync(this.stateFile, JSON.stringify(data, null, 2), 'utf8');
        } catch (e) {
            console.error('❌ Erro ao salvar CCI Egg Monitor:', e.message);
        }
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

    signed(direction, value) {
        if (!Number.isFinite(value)) return null;
        return direction === 'SHORT' ? -value : value;
    }

    rawFromSigned(direction, value) {
        if (!Number.isFinite(value)) return null;
        return direction === 'SHORT' ? -value : value;
    }

    formatTargetPct(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return '-';
        return `${n.toFixed(Number.isInteger(n) ? 0 : 2)}%`;
    }

    formatDateTime(ms) {
        if (!Number.isFinite(Number(ms))) return '-';
        try {
            return new Date(ms).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
        } catch (e) {
            return new Date(ms).toLocaleString('pt-BR');
        }
    }

    directionalGainPct(egg, price) {
        const entry = Number(egg?.alertPrice);
        const current = Number(price);
        if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(current)) return null;

        const rawGain = ((current - entry) / entry) * 100;
        return egg.direction === 'SHORT' ? -rawGain : rawGain;
    }

    targetPriceFor(egg, targetPct = this.primaryTargetPct) {
        const entry = Number(egg?.alertPrice);
        const pct = Number(targetPct);
        if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(pct)) return null;

        const multiplier = egg.direction === 'SHORT'
            ? 1 - (pct / 100)
            : 1 + (pct / 100);
        return entry * multiplier;
    }

    ensurePerformance(egg) {
        if (!egg.performance) egg.performance = {};

        const performance = egg.performance;
        const entry = Number(egg.alertPrice);
        const targetPct = Number(performance.targetPct);

        performance.entryPrice = Number.isFinite(Number(performance.entryPrice))
            ? Number(performance.entryPrice)
            : (Number.isFinite(entry) ? entry : null);
        performance.targetPct = Number.isFinite(targetPct) && targetPct > 0
            ? targetPct
            : this.primaryTargetPct;
        performance.targetPrice = this.targetPriceFor(egg, performance.targetPct);

        if (!Number.isFinite(Number(performance.bestPrice))) {
            performance.bestPrice = performance.entryPrice;
        }
        if (!Number.isFinite(Number(performance.bestGainPct))) {
            performance.bestGainPct = 0;
        }
        if (!Number.isFinite(Number(performance.bestAt))) {
            performance.bestAt = egg.triggeredAt || egg.registeredAt || Date.now();
        }

        if (typeof performance.primaryTargetHit !== 'boolean') {
            performance.primaryTargetHit = Number(performance.bestGainPct) >= performance.targetPct;
        }
        if (performance.primaryTargetHit) {
            if (!Number.isFinite(Number(performance.hitPrice))) performance.hitPrice = performance.bestPrice;
            if (!Number.isFinite(Number(performance.hitGainPct))) performance.hitGainPct = performance.bestGainPct;
            if (!Number.isFinite(Number(performance.hitAt))) performance.hitAt = performance.bestAt;
        }

        return performance;
    }

    updatePerformance(egg, h1Candles = []) {
        const performance = this.ensurePerformance(egg);
        const triggeredAt = Number(egg.triggeredAt || egg.registeredAt || 0);
        const triggerCandleOpen = Number.isFinite(triggeredAt)
            ? Math.floor(triggeredAt / 3600000) * 3600000
            : null;

        const candidates = [];
        if (Number.isFinite(Number(egg.currentPrice))) {
            candidates.push({ price: Number(egg.currentPrice), at: Date.now() });
        }

        for (const candle of h1Candles || []) {
            const candleTime = Number(candle.time);
            if (Number.isFinite(triggerCandleOpen) && Number.isFinite(candleTime) && candleTime <= triggerCandleOpen) {
                continue;
            }

            const favorablePrice = egg.direction === 'SHORT'
                ? Number(candle.low)
                : Number(candle.high);
            candidates.push({
                price: favorablePrice,
                at: Number.isFinite(candleTime) ? candleTime : Date.now()
            });
        }

        let hitNow = false;
        let bestUpdated = false;
        for (const candidate of candidates) {
            const gain = this.directionalGainPct(egg, candidate.price);
            if (!Number.isFinite(gain)) continue;

            if (!Number.isFinite(Number(performance.bestGainPct)) || gain > Number(performance.bestGainPct)) {
                performance.bestGainPct = gain;
                performance.bestPrice = candidate.price;
                performance.bestAt = candidate.at;
                bestUpdated = true;
            }
        }

        if (!performance.primaryTargetHit && Number(performance.bestGainPct) >= Number(performance.targetPct)) {
            performance.primaryTargetHit = true;
            performance.hitPrice = performance.bestPrice;
            performance.hitGainPct = performance.bestGainPct;
            performance.hitAt = performance.bestAt;
            hitNow = true;
        }

        performance.currentGainPct = this.directionalGainPct(egg, egg.currentPrice);
        return { hitNow, bestUpdated, performance };
    }

    buildPerformanceBlock(egg) {
        const performance = this.ensurePerformance(egg);
        const targetPctText = this.formatTargetPct(performance.targetPct);
        const targetPriceText = Number.isFinite(Number(performance.targetPrice))
            ? `$${this.formatPrice(Number(performance.targetPrice))}`
            : '-';
        const bestPriceText = Number.isFinite(Number(performance.bestPrice))
            ? `$${this.formatPrice(Number(performance.bestPrice))}`
            : '-';
        const bestGainText = Number.isFinite(Number(performance.bestGainPct))
            ? this.formatPercent(Number(performance.bestGainPct))
            : '-';

        const statusLine = performance.primaryTargetHit
            ? `│ Status: ✅ Batido em ${this.formatDateTime(Number(performance.hitAt || performance.bestAt))}\n`
            : `│ Status: ⏳ Ainda não bateu\n`;
        const hitLine = performance.primaryTargetHit && Number.isFinite(Number(performance.hitPrice))
            ? `│ Toque: $${this.formatPrice(Number(performance.hitPrice))} (${this.formatPercent(Number(performance.hitGainPct || performance.bestGainPct))})\n`
            : '';

        return `\n┌─ 🎯 *ALVO PRIMÁRIO* ─────────────\n` +
            `│ Meta: ${targetPctText} (${targetPriceText})\n` +
            statusLine +
            hitLine +
            `│ Melhor ganho: ${bestGainText} (${bestPriceText})\n` +
            `└────────────────────────────────\n`;
    }

    buildOutcomeNote(egg, eventCode) {
        if (!['H4_DEAD', 'H4_LOST_MINUS100'].includes(eventCode)) return '';

        const performance = this.ensurePerformance(egg);
        if (performance.primaryTargetHit) {
            return `\n✅ Mesmo perdendo estrutura, este ovo já pagou o alvo primário de ${this.formatTargetPct(performance.targetPct)}.`;
        }
        if (Number(performance.bestGainPct) > 0) {
            return `\n📌 Antes da perda, melhor ganho observado: ${this.formatPercent(Number(performance.bestGainPct))}.`;
        }
        return '\n📌 Ovo perdeu estrutura sem tocar ganho relevante antes.';
    }

    classifyH4(directionalCCI, previousDirectionalCCI = null) {
        const rising = Number.isFinite(previousDirectionalCCI) && directionalCCI > previousDirectionalCCI;
        const falling = Number.isFinite(previousDirectionalCCI) && directionalCCI < previousDirectionalCCI;
        const arrow = rising ? '↑' : falling ? '↓' : '→';

        if (directionalCCI >= 100) {
            return { code: 'IMPULSE', label: '🚀 IMPULSO', score: 100, arrow };
        }
        if (directionalCCI >= 0) {
            return { code: 'TREND', label: '🟢 TENDÊNCIA', score: 80, arrow };
        }
        if (directionalCCI >= -100) {
            return { code: rising ? 'RECOVERY' : 'HOLDING', label: rising ? '🟡 RECUPERAÇÃO' : '🟢 SUSTENTA', score: 60, arrow };
        }
        if (directionalCCI >= -200) {
            return { code: 'DEEP_PULLBACK', label: '🟠 CORREÇÃO PROFUNDA', score: 30, arrow };
        }
        return { code: 'DEAD', label: '💀 RESET / OVO MORTO', score: 0, arrow };
    }

    classifyPullback(lowestDirectionalCCI) {
        if (!Number.isFinite(lowestDirectionalCCI)) return { code: 'UNKNOWN', label: 'indefinido' };
        if (lowestDirectionalCCI >= 0) return { code: 'PREMIUM', label: '🔥 Pullback Premium — não perdeu 0' };
        if (lowestDirectionalCCI >= -100) return { code: 'HEALTHY', label: '🟢 Pullback saudável — segurou -100' };
        if (lowestDirectionalCCI >= -200) return { code: 'DEEP', label: '🟡 Pullback profundo — segurou -200' };
        return { code: 'FAILED', label: '🔴 Pullback falhou — perdeu -200' };
    }

    register({ symbol, direction, alertPrice, triggeredAt, cciH1, cciH4, stochH4Start, stochH4Current, researchId = null }) {
        if (!symbol || !direction) return;

        const now = Date.now();
        const signedH1 = this.signed(direction, Number(cciH1));
        const signedH4 = this.signed(direction, Number(cciH4));
        const entryPrice = Number(alertPrice);

        const egg = {
            symbol,
            direction,
            alertPrice,
            researchId,
            triggeredAt: triggeredAt || now,
            registeredAt: now,
            stochH4Start,
            stochH4Current,

            h1: {
                triggerCCI: Number.isFinite(Number(cciH1)) ? Number(cciH1) : null,
                highest: Number.isFinite(signedH1) ? signedH1 : null,
                lowestAfterHigh: Number.isFinite(signedH1) ? signedH1 : null,
                current: Number.isFinite(Number(cciH1)) ? Number(cciH1) : null,
                currentSigned: Number.isFinite(signedH1) ? signedH1 : null,
                lostZero: false,
                lostMinus100: false,
                lostMinus200: false,
                recovered100: Number.isFinite(signedH1) ? signedH1 >= 100 : false
            },

            h4: {
                triggerCCI: Number.isFinite(Number(cciH4)) ? Number(cciH4) : null,
                highest: Number.isFinite(signedH4) ? signedH4 : null,
                lowestAfterHigh: Number.isFinite(signedH4) ? signedH4 : null,
                current: Number.isFinite(Number(cciH4)) ? Number(cciH4) : null,
                currentSigned: Number.isFinite(signedH4) ? signedH4 : null,
                previousSigned: null,
                lostZero: Number.isFinite(signedH4) ? signedH4 < 0 : false,
                lostMinus100: Number.isFinite(signedH4) ? signedH4 < -100 : false,
                lostMinus200: Number.isFinite(signedH4) ? signedH4 < -200 : false,
                recoveredZero: Number.isFinite(signedH4) ? signedH4 >= 0 : false,
                recovered100: Number.isFinite(signedH4) ? signedH4 >= 100 : false,
                regime: Number.isFinite(signedH4) ? this.classifyH4(signedH4, null) : null
            },

            performance: {
                entryPrice: Number.isFinite(entryPrice) ? entryPrice : null,
                targetPct: this.primaryTargetPct,
                targetPrice: Number.isFinite(entryPrice)
                    ? this.targetPriceFor({ direction, alertPrice: entryPrice }, this.primaryTargetPct)
                    : null,
                bestPrice: Number.isFinite(entryPrice) ? entryPrice : null,
                bestGainPct: 0,
                bestAt: now,
                currentGainPct: 0,
                primaryTargetHit: false,
                hitAt: null,
                hitPrice: null,
                hitGainPct: null
            },

            energyCycles: 0,
            lastEvent: 'REGISTERED',
            lastEventAt: 0,
            status: 'ACTIVE',
            notes: []
        };

        this.eggs.set(symbol, egg);
        this.save();
        console.log(`🧠 CCI Monitor registrou ovo ${direction}: ${symbol}`);
    }

    updateDirectionalStats(stats, rawCCI, direction) {
        const signedCCI = this.signed(direction, rawCCI);
        if (!Number.isFinite(signedCCI)) return;

        stats.current = rawCCI;
        stats.currentSigned = signedCCI;

        if (!Number.isFinite(stats.highest) || signedCCI > stats.highest) {
            stats.highest = signedCCI;
            stats.lowestAfterHigh = signedCCI;
        } else if (!Number.isFinite(stats.lowestAfterHigh) || signedCCI < stats.lowestAfterHigh) {
            stats.lowestAfterHigh = signedCCI;
        }

        if (signedCCI < 0) stats.lostZero = true;
        if (signedCCI < -100) stats.lostMinus100 = true;
        if (signedCCI < -200) stats.lostMinus200 = true;
        if (signedCCI >= 0) stats.recoveredZero = true;
        if (signedCCI >= 100) stats.recovered100 = true;
    }

    shouldSend(egg, eventCode) {
        const now = Date.now();
        if (egg.lastEvent !== eventCode) return true;
        return now - (egg.lastEventAt || 0) > this.minAlertIntervalMs;
    }

    markEvent(egg, eventCode) {
        egg.lastEvent = eventCode;
        egg.lastEventAt = Date.now();
    }

    recordResearchEvent(egg, type, details = {}) {
        if (!this.researchRecorder) return;
        try {
            this.researchRecorder.recordEvent({
                eggId: egg.researchId,
                at: details.at ?? details.hitAt ?? Date.now(),
                symbol: egg.symbol,
                direction: egg.direction,
                entryPrice: egg.alertPrice,
                type,
                price: details.price ?? egg.currentPrice,
                gainPct: egg.performance?.bestGainPct,
                cciH1: egg.h1?.current,
                cciH4: egg.h4?.current,
                details: {
                    currentGainPct: egg.performance?.currentGainPct,
                    bestGainPct: egg.performance?.bestGainPct,
                    bestPrice: egg.performance?.bestPrice,
                    h1CurrentSigned: egg.h1?.currentSigned,
                    h4CurrentSigned: egg.h4?.currentSigned,
                    h4Regime: egg.h4?.regime?.code,
                    ...details
                }
            });
        } catch (e) {
            console.error("CCI Monitor research:", e.message);
        }
    }

    buildMessage(egg, event) {
        const h1Pullback = this.classifyPullback(egg.h1.lowestAfterHigh);
        const h4Pullback = this.classifyPullback(egg.h4.lowestAfterHigh);
        const h4Regime = egg.h4.regime || this.classifyH4(egg.h4.currentSigned || 0, egg.h4.previousSigned);
        const ageHours = ((Date.now() - egg.triggeredAt) / 3600000).toFixed(1);
        const currentGain = this.directionalGainPct(egg, egg.currentPrice);
        const currentPriceLine = Number.isFinite(egg.currentPrice) && Number.isFinite(egg.alertPrice)
            ? `💰 Preço: $${this.formatPrice(egg.currentPrice)} (${Number.isFinite(currentGain) ? this.formatPercent(currentGain) : '-'})\n`
            : '';
        const performanceBlock = this.buildPerformanceBlock(egg);
        const outcomeNote = this.buildOutcomeNote(egg, event.code);
        const energyCycles = Number.isFinite(event.energyCycles) ? event.energyCycles : (egg.energyCycles || 0);
        const energyLine = energyCycles > 0
            ? `⚡ Energia (recargas H1): ${energyCycles}${energyCycles >= 3 ? ' — mola comprimida' : ''}\n`
            : '';

        const h1LowRaw = this.rawFromSigned(egg.direction, egg.h1.lowestAfterHigh);
        const h4LowRaw = this.rawFromSigned(egg.direction, egg.h4.lowestAfterHigh);

        return `${event.emoji} *CCI MONITOR — ${event.title}* ${event.emoji}\n\n` +
            `💹 *${egg.symbol}*\n` +
            `📍 Direção: *${egg.direction}*\n` +
            `⏰ Idade do ovo: ${ageHours}h\n` +
            energyLine +
            currentPriceLine +
            performanceBlock +
            `\n┌─ 📊 *CCI H1 — PULLBACK* ─────────\n` +
            `│ Atual: ${egg.h1.current != null ? egg.h1.current.toFixed(1) : '-'}\n` +
            `│ Pico direcional: ${egg.h1.highest != null ? egg.h1.highest.toFixed(1) : '-'}\n` +
            `│ Menor pullback: ${h1LowRaw != null ? h1LowRaw.toFixed(1) : '-'}\n` +
            `│ Leitura: ${h1Pullback.label}\n` +
            `└────────────────────────────────\n` +
            `\n┌─ 🧭 *CCI H4 — ESTRUTURA* ───────\n` +
            `│ Atual: ${egg.h4.current != null ? egg.h4.current.toFixed(1) : '-'} ${h4Regime.arrow || '→'}\n` +
            `│ Estado: ${h4Regime.label}\n` +
            `│ Menor pullback: ${h4LowRaw != null ? h4LowRaw.toFixed(1) : '-'}\n` +
            `│ Leitura: ${h4Pullback.label}\n` +
            `└────────────────────────────────\n` +
            `\n${event.note}${outcomeNote}\n` +
            `🔗 ${this.tvLink(egg.symbol)}\n` +
            `⚠️ _Não é conselho financeiro._`;
    }

    detectEvent(egg, previousH4RegimeCode) {
        const h1 = egg.h1.currentSigned;
        const h4 = egg.h4.currentSigned;
        const prevH4 = egg.h4.previousSigned;
        const h4Regime = egg.h4.regime;

        if (!Number.isFinite(h1) || !Number.isFinite(h4)) return null;

        // Ovo perdeu -200 no H4: evento mais grave.
        if (h4 < -200) {
            return {
                code: 'H4_DEAD',
                emoji: '💀',
                title: 'OVO PERDEU -200 NO H4',
                note: '💀 Estrutura H4 resetada. Melhor tratar como novo ciclo/acumulação.'
            };
        }

        // Recuperou o zero no H4 depois de estar abaixo: esse é o evento que queremos validar.
        if (Number.isFinite(prevH4) && prevH4 < 0 && h4 >= 0) {
            return {
                code: 'H4_RECOVERED_ZERO',
                emoji: '🚀',
                title: 'OVO RECUPEROU O 0 NO H4',
                note: '🚀 H4 recuperou a linha 0. Pela teoria da Meg, pode iniciar nova perna se o preço confirmar.'
            };
        }

        // H4 recuperou -100 depois de estar abaixo.
        if (Number.isFinite(prevH4) && prevH4 < -100 && h4 >= -100) {
            return {
                code: 'H4_RECOVERED_MINUS100',
                emoji: '🟡',
                title: 'OVO RECUPEROU -100 NO H4',
                note: '🟡 Saiu da zona perigosa. Ainda precisa recuperar 0 para ficar explosivo.'
            };
        }

        // Perdeu -100 no H4, mas ainda não morreu.
        if (Number.isFinite(prevH4) && prevH4 >= -100 && h4 < -100) {
            return {
                code: 'H4_LOST_MINUS100',
                emoji: '⚠️',
                title: 'OVO PERDEU -100 NO H4',
                note: '⚠️ Correção profunda em andamento. Observar se segura antes de -200.'
            };
        }

        // Recarregou no H1: fez pullback e voltou acima de +100 direcional.
        const h1Pull = this.classifyPullback(egg.h1.lowestAfterHigh);
        if (egg.h1.lostZero && h1 >= 100 && h1Pull.code !== 'FAILED') {
            return {
                code: 'H1_RELOADED',
                emoji: '🥚',
                title: 'OVO RECARREGOU NO H1',
                note: '🥚 H1 fez pullback e recuperou +100. Pode ser segunda perna do movimento.'
            };
        }

        // H4 entrou em impulso acima de +100.
        if (previousH4RegimeCode !== 'IMPULSE' && h4Regime?.code === 'IMPULSE') {
            return {
                code: 'H4_IMPULSE',
                emoji: '🔥',
                title: 'OVO ENTROU EM IMPULSO H4',
                note: '🔥 CCI H4 acima de +100. Movimento ganhou estrutura de expansão.'
            };
        }

        return null;
    }

    async checkOne(symbol, egg, getCandles) {
        const [h1, h4] = await Promise.all([
            getCandles(symbol, '1h', 120),
            getCandles(symbol, '4h', 90)
        ]);
        if (!h1 || !h4) return;

        const h1CCI = this.calculateCCI(h1);
        const h4CCI = this.calculateCCI(h4);
        if (!h1CCI.length || !h4CCI.length) return;

        const currentH1 = h1CCI[h1CCI.length - 1];
        const currentH4 = h4CCI[h4CCI.length - 1];
        const previousH4 = h4CCI.length >= 2 ? h4CCI[h4CCI.length - 2] : currentH4;
        const previousH4Signed = this.signed(egg.direction, previousH4);
        const previousH4RegimeCode = egg.h4.regime?.code;

        egg.currentPrice = h1[h1.length - 1].close;
        egg.updatedAt = Date.now();
        const performanceUpdate = this.updatePerformance(egg, h1);

        this.updateDirectionalStats(egg.h1, currentH1, egg.direction);
        this.updateDirectionalStats(egg.h4, currentH4, egg.direction);
        egg.h4.previousSigned = previousH4Signed;
        egg.h4.regime = this.classifyH4(egg.h4.currentSigned, egg.h4.previousSigned);

        if (performanceUpdate.hitNow) {
            this.recordResearchEvent(egg, "TARGET_5_HIT", {
                price: egg.performance?.hitPrice,
                targetPct: egg.performance?.targetPct,
                hitAt: egg.performance?.hitAt
            });
        } else if (performanceUpdate.bestUpdated && Number(egg.performance?.bestGainPct) >= 8) {
            this.recordResearchEvent(egg, "BEST_GAIN_UPDATE", {
                price: egg.performance?.bestPrice,
                at: egg.performance?.bestAt
            });
        }

        const event = this.detectEvent(egg, previousH4RegimeCode);

        // Contagem de energia (mola comprimida): conta o ciclo assim que detectado,
        // independente do cooldown de envio ao Telegram. Reseta lostZero pra exigir
        // um novo mergulho abaixo de zero antes de contar a próxima recarga —
        // sem isso, o H1 parado acima de 100 re-disparava o mesmo evento a cada
        // cooldown e inflava a contagem sem recarga real ter acontecido.
        if (event?.code === 'H1_RELOADED') {
            egg.energyCycles = (egg.energyCycles || 0) + 1;
            egg.h1.lostZero = false;
        }
        if (event?.code === 'H4_DEAD') {
            egg.energyCycles = 0;
        }

        if (event && this.shouldSend(egg, event.code)) {
            await this.sendTelegram(this.buildMessage(egg, { ...event, energyCycles: egg.energyCycles }));
            this.recordResearchEvent(egg, event.code, { title: event.title, energyCycles: egg.energyCycles });
            this.markEvent(egg, event.code);
        }
    }

    async checkAll(getCandles) {
        const now = Date.now();
        const maxAgeMs = this.maxAgeHours * 60 * 60 * 1000;
        let removed = 0;

        for (const [symbol, egg] of this.eggs.entries()) {
            try {
                if (now - egg.registeredAt > maxAgeMs || egg.status === 'DONE') {
                    this.eggs.delete(symbol);
                    removed++;
                    continue;
                }
                await this.checkOne(symbol, egg, getCandles);
            } catch (e) {
                console.error(`❌ CCI Monitor ${symbol}:`, e.message);
            }
        }

        if (removed > 0) console.log(`🧹 CCI Monitor removeu ${removed} ovos antigos`);
        this.save();
    }

    getWatchingCount() {
        return this.eggs.size;
    }

    // Energia acumulada (recargas H1) do ovo ativo pro símbolo, se houver.
    getEnergyCycles(symbol) {
        const egg = this.eggs.get(symbol);
        return egg?.energyCycles || 0;
    }
}

module.exports = CCIEggMonitor;
