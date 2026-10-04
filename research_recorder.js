const fs = require("fs");
const path = require("path");

class ResearchRecorder {
    constructor(options = {}) {
        this.enabled = options.enabled ?? process.env.RESEARCH_ENABLED !== "false";
        this.dataDir = options.dataDir || path.join(__dirname, "data");
        this.eggsFile = options.eggsFile || path.join(this.dataDir, "research_eggs.jsonl");
        this.eventsFile = options.eventsFile || path.join(this.dataDir, "research_events.jsonl");
        this.outcomesFile = options.outcomesFile || path.join(this.dataDir, "research_outcomes.json");
        this.indexFile = options.indexFile || path.join(this.dataDir, "research_index.json");
        this.outcomes = {};
        this.index = {};
        this.load();
    }

    load() {
        if (!this.enabled) return;
        try {
            fs.mkdirSync(this.dataDir, { recursive: true });
            this.outcomes = this.readJson(this.outcomesFile, {});
            this.index = this.readJson(this.indexFile, {});
        } catch (e) {
            this.enabled = false;
            console.error("ResearchRecorder desativado:", e.message);
        }
    }

    readJson(file, fallback) {
        try {
            if (!fs.existsSync(file)) return fallback;
            return JSON.parse(fs.readFileSync(file, "utf8"));
        } catch (e) {
            console.error(`ResearchRecorder: erro lendo ${path.basename(file)}:`, e.message);
            return fallback;
        }
    }

    writeJson(file, value) {
        fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
    }

    appendJsonl(file, value) {
        fs.appendFileSync(file, JSON.stringify(value) + "\n", "utf8");
    }

    makeId(symbol, direction, createdAt) {
        return `${symbol}_${direction}_${createdAt}`;
    }

    key(symbol, direction) {
        return `${symbol}_${direction}`;
    }

    getActiveId(symbol, direction) {
        return this.index[this.key(symbol, direction)] || null;
    }

    normalizeNumber(value) {
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
    }

    directionalGainPct(direction, entryPrice, price) {
        const entry = this.normalizeNumber(entryPrice);
        const current = this.normalizeNumber(price);
        if (!entry || !current) return null;
        const raw = ((current - entry) / entry) * 100;
        return direction === "SHORT" ? -raw : raw;
    }

    targetPrice(direction, entryPrice, targetPct) {
        const entry = this.normalizeNumber(entryPrice);
        if (!entry) return null;
        return direction === "SHORT"
            ? entry * (1 - targetPct / 100)
            : entry * (1 + targetPct / 100);
    }

    inferTags(setup = {}) {
        const tags = [];
        const cciH4 = this.normalizeNumber(setup.cciH4);
        const cciH1 = this.normalizeNumber(setup.cciH1);
        const volumeRel = this.normalizeNumber(setup.volumeRel);
        const takerRatio = this.normalizeNumber(setup.takerRatio);

        if (Math.abs(cciH1 || 0) >= 180) tags.push("h1_turbo");
        if (setup.h4RegimeCode) tags.push(`h4_${String(setup.h4RegimeCode).toLowerCase()}`);
        if (Number.isFinite(cciH4)) {
            if (cciH4 < -100) tags.push("h4_below_minus100_entry");
            else if (cciH4 < 0) tags.push("h4_negative_entry");
            else if (cciH4 < 50) tags.push("h4_0_50_entry");
            else if (cciH4 < 100) tags.push("h4_50_100_entry");
            else if (cciH4 < 200) tags.push("h4_100_200_entry");
            else tags.push("h4_above_200_entry");
        }
        if (setup.fiboBias?.isDiscount) tags.push("fibo_discount");
        if (setup.fiboBias?.isRisk) tags.push("fibo_risk");
        if (setup.fvgSide === "BULL") tags.push("inside_bullish_fvg");
        if (setup.fvgSide === "BEAR") tags.push("inside_bearish_fvg");
        if (volumeRel >= 2) tags.push("volume_explosive");
        else if (volumeRel >= 1.2) tags.push("volume_confirmed");
        if (takerRatio >= 1.5) tags.push("taker_buy_strong");
        if (takerRatio > 0 && takerRatio <= 0.67) tags.push("taker_sell_strong");
        const lsrLabel = String(setup.lsr?.label || "").toUpperCase();
        if (setup.lsr?.isTooLong || lsrLabel.includes("MUITO LONG")) tags.push("lsr_too_long");
        if (setup.lsr?.isTooShort || lsrLabel.includes("MUITO SHORT")) tags.push("lsr_too_short");
        if (setup.divergence?.h1?.type) tags.push(`h1_div_${String(setup.divergence.h1.type).toLowerCase().replace(/\s+/g, "_")}`);
        if (setup.divergence?.h4?.type) tags.push(`h4_div_${String(setup.divergence.h4.type).toLowerCase().replace(/\s+/g, "_")}`);
        if (setup.divergence?.h12?.type) tags.push(`h12_div_${String(setup.divergence.h12.type).toLowerCase().replace(/\s+/g, "_")}`);
        if (setup.divergence?.m15?.type) tags.push(`m15_div_${String(setup.divergence.m15.type).toLowerCase().replace(/\s+/g, "_")}`);
        if (setup.h4Cross?.found) {
            tags.push("h4_cross_recent");
            if (setup.h4Cross.fallback || setup.h4Cross.source === "INCUBADORA_H4_SYNC") {
                tags.push("h4_sync_incubadora");
            } else {
                tags.push("h4_cross_scanner");
            }
            const age = this.normalizeNumber(setup.h4Cross.ageHours);
            if (age != null && age <= 12) tags.push("h4_cross_12h");
            else if (age != null && age <= 24) tags.push("h4_cross_24h");
            else if (age != null && age <= 72) tags.push("h4_cross_72h");
            else if (age != null && age <= 168) tags.push("h4_cross_168h");
        } else if (setup.h4Cross?.found === false) {
            tags.push("no_h4_cross_recent");
        }
        if (setup.direction === "LONG" && setup.fiboBias?.isRisk && setup.fvgSide === "BEAR" && volumeRel >= 2) tags.push("risk_trap");
        if (setup.direction === "SHORT" && setup.fiboBias?.isDiscount && setup.fvgSide === "BULL" && volumeRel >= 2) tags.push("risk_trap");
        if (setup.classification?.qualityCode) {
            tags.push(`quality_${String(setup.classification.qualityCode).toLowerCase()}`);
        }
        if (setup.classification?.phaseCode) {
            tags.push(`phase_${String(setup.classification.phaseCode).toLowerCase()}`);
        }
        if (setup.classification?.againstCount >= 2) tags.push("classified_conflict");

        const energyCycles = this.normalizeNumber(setup.energyCycles);
        if (energyCycles != null) {
            if (energyCycles >= 3) tags.push("energy_3plus");
            else if (energyCycles >= 1) tags.push("energy_1_2");
            else tags.push("energy_0");
        }

        return Array.from(new Set(tags));
    }

    recordSetup(setup) {
        if (!this.enabled || !setup?.symbol || !setup?.direction || !setup?.entryPrice) return null;
        try {
            const createdAt = setup.createdAt || Date.now();
            const id = setup.id || this.makeId(setup.symbol, setup.direction, createdAt);
            const record = {
                schemaVersion: 1,
                id,
                createdAt,
                source: setup.source || "SETUP",
                symbol: setup.symbol,
                direction: setup.direction,
                entryPrice: this.normalizeNumber(setup.entryPrice),
                alertNumber: setup.alertNumber ?? null,
                isTurbo: !!setup.isTurbo,
                hasEgg: !!setup.hasEgg,
                cciH1: this.normalizeNumber(setup.cciH1),
                cciH4: this.normalizeNumber(setup.cciH4),
                h4RegimeCode: setup.h4RegimeCode || null,
                h4RegimeLabel: setup.h4RegimeLabel || null,
                stochH1: this.normalizeNumber(setup.stochH1),
                stochH4: this.normalizeNumber(setup.stochH4),
                volumeRel: this.normalizeNumber(setup.volumeRel),
                volumeStrength: setup.volumeStrength || null,
                scoreTecnico: this.normalizeNumber(setup.scoreTecnico),
                scoreDivergence: this.normalizeNumber(setup.scoreDivergence),
                scoreInstitucional: this.normalizeNumber(setup.scoreInstitucional),
                takerRatio: this.normalizeNumber(setup.takerRatio),
                takerBuyPct: this.normalizeNumber(setup.takerBuyPct),
                takerSellPct: this.normalizeNumber(setup.takerSellPct),
                takerDominantSide: setup.takerDominantSide || null,
                fiboZone: setup.fiboZone || null,
                fiboBias: setup.fiboBias || null,
                fvgSide: setup.fvgSide || null,
                lsr: setup.lsr || null,
                h4Cross: setup.h4Cross || null,
                divergence: setup.divergence || null,
                classification: setup.classification || null,
                quality: setup.quality || null,
                energyCycles: this.normalizeNumber(setup.energyCycles),
                tags: this.inferTags(setup)
            };

            this.appendJsonl(this.eggsFile, record);
            this.index[this.key(record.symbol, record.direction)] = id;
            this.writeJson(this.indexFile, this.index);
            this.ensureOutcome(id, record);
            return id;
        } catch (e) {
            console.error("ResearchRecorder recordSetup:", e.message);
            return null;
        }
    }

    ensureOutcome(id, setupRecord = {}) {
        if (!this.outcomes[id]) {
            this.outcomes[id] = {
                id,
                symbol: setupRecord.symbol,
                direction: setupRecord.direction,
                entryPrice: setupRecord.entryPrice,
                createdAt: setupRecord.createdAt,
                maxGainPct: 0,
                maxGainPrice: setupRecord.entryPrice,
                maxGainAt: setupRecord.createdAt,
                maxLossPct: 0,
                maxLossPrice: setupRecord.entryPrice,
                maxLossAt: setupRecord.createdAt,
                hit5: false,
                hit8: false,
                hit15: false,
                hit50: false,
                hit100: false,
                timeTo5h: null,
                timeTo8h: null,
                timeTo15h: null,
                timeTo50h: null,
                timeTo100h: null,
                stopHunter: false,
                retest: false,
                takerZone: false,
                h4RecoveredMinus100: false,
                h4RecoveredZero: false,
                h4Impulse: false,
                h4LostZero: false,
                h4LostMinus100: false,
                h4Dead: false,
                reloadedH1Count: 0,
                lastEvent: null,
                lastUpdatedAt: Date.now()
            };
            this.writeJson(this.outcomesFile, this.outcomes);
        }
        return this.outcomes[id];
    }

    findOutcome(symbol, direction, id = null) {
        const outcomeId = id || this.getActiveId(symbol, direction);
        if (!outcomeId) return null;
        return this.ensureOutcome(outcomeId, { symbol, direction });
    }

    recordEvent(event) {
        if (!this.enabled || !event?.symbol || !event?.direction || !event?.type) return null;
        try {
            const at = event.at || Date.now();
            const id = event.eggId || this.getActiveId(event.symbol, event.direction) || this.makeId(event.symbol, event.direction, at);
            const outcome = this.ensureOutcome(id, {
                id,
                symbol: event.symbol,
                direction: event.direction,
                entryPrice: event.entryPrice,
                createdAt: at
            });
            const price = this.normalizeNumber(event.price);
            const gainPct = Number.isFinite(Number(event.gainPct))
                ? Number(event.gainPct)
                : this.directionalGainPct(event.direction, outcome.entryPrice || event.entryPrice, price);

            const record = {
                schemaVersion: 1,
                eggId: id,
                at,
                type: event.type,
                symbol: event.symbol,
                direction: event.direction,
                price,
                gainPct,
                cciH1: this.normalizeNumber(event.cciH1),
                cciH4: this.normalizeNumber(event.cciH4),
                details: event.details || {}
            };
            this.appendJsonl(this.eventsFile, record);
            this.updateOutcome(outcome, record);
            return id;
        } catch (e) {
            console.error("ResearchRecorder recordEvent:", e.message);
            return null;
        }
    }

    updateOutcome(outcome, event) {
        const gain = this.normalizeNumber(event.gainPct);
        const price = this.normalizeNumber(event.price);
        if (Number.isFinite(gain)) {
            if (!Number.isFinite(outcome.maxGainPct) || gain > outcome.maxGainPct) {
                outcome.maxGainPct = gain;
                outcome.maxGainPrice = price;
                outcome.maxGainAt = event.at;
            }
            if (!Number.isFinite(outcome.maxLossPct) || gain < outcome.maxLossPct) {
                outcome.maxLossPct = gain;
                outcome.maxLossPrice = price;
                outcome.maxLossAt = event.at;
            }
            for (const target of [5, 8, 15, 50, 100]) {
                const hitKey = `hit${target}`;
                const timeKey = `timeTo${target}h`;
                if (gain >= target && !outcome[hitKey]) {
                    outcome[hitKey] = true;
                    outcome[timeKey] = outcome.createdAt
                        ? Number(((event.at - outcome.createdAt) / 3600000).toFixed(2))
                        : null;
                }
            }
        }

        const type = event.type;
        if (type === "STOP_HUNTER") outcome.stopHunter = true;
        if (type === "RETEST_CONFIRMED") outcome.retest = true;
        if (type === "TAKER_ZONE") outcome.takerZone = true;
        if (type === "H4_RECOVERED_MINUS100") outcome.h4RecoveredMinus100 = true;
        if (type === "H4_RECOVERED_ZERO") outcome.h4RecoveredZero = true;
        if (type === "H4_IMPULSE") outcome.h4Impulse = true;
        if (type === "H4_LOST_ZERO") outcome.h4LostZero = true;
        if (type === "H4_LOST_MINUS100") outcome.h4LostMinus100 = true;
        if (type === "H4_DEAD") outcome.h4Dead = true;
        if (type === "H1_RELOADED") outcome.reloadedH1Count = (outcome.reloadedH1Count || 0) + 1;

        outcome.lastEvent = type;
        outcome.lastUpdatedAt = event.at;
        this.writeJson(this.outcomesFile, this.outcomes);
    }
}

module.exports = ResearchRecorder;
