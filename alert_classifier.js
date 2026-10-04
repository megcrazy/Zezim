// Classificador de qualidade e fase dos alertas do Zezim.
// Ele nao bloqueia setups: apenas organiza o contexto para Telegram, research e futuro painel.

function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function firstClean(items, max = 3) {
    return items.filter(Boolean).slice(0, max);
}

function classifyPhase({
    phase = null,
    cycleState = null,
    h4RegimeCode = null,
    h4SyncFound = false,
    triggerConfirmed = false,
    isSecondLeg = false,
    isDead = false
} = {}) {
    const explicit = phase || cycleState;

    if (isDead || explicit === "H4_DEAD" || explicit === "OVO_MORTO") {
        return { code: "RESET", emoji: "⚫", label: "OVO MORTO / RESET" };
    }

    if (isSecondLeg || explicit === "SECOND_LEG" || explicit === "H1_RELOADED") {
        return { code: "SECOND_LEG", emoji: "🔵", label: "SEGUNDA PERNA" };
    }

    if (explicit === "DISPARO" || explicit === "DISPARO_CONFIRMADO") {
        return { code: "DISPARO", emoji: "🚀", label: "DISPARO CONFIRMADO" };
    }

    if (explicit === "ACUMULO_H1") {
        return { code: "ACCUMULATION", emoji: "🥚", label: "ACUMULO H1" };
    }

    if (explicit === "REVERSAO_POS_SYNC_H4") {
        return { code: "REVERSAL", emoji: "🟢", label: "REVERSAO POS SYNC" };
    }

    if (h4RegimeCode === "IMPULSE") {
        return { code: "IMPULSE_H4", emoji: "🔥", label: "IMPULSO H4" };
    }

    if (triggerConfirmed) {
        return h4SyncFound
            ? { code: "SETUP_POS_SYNC", emoji: "🚀", label: "SETUP POS SYNC" }
            : { code: "SETUP_H1", emoji: "📈", label: "SETUP H1" };
    }

    if (h4SyncFound) {
        return { code: "H4_RADAR", emoji: "🧭", label: "RADAR H4" };
    }

    return { code: "OBSERVATION", emoji: "👁️", label: "OBSERVACAO" };
}

function classifyAlert({
    direction = "LONG",
    phase = null,
    cycleState = null,
    fiboBias = null,
    fvgSide = null,
    takerAligned = false,
    takerAgainst = false,
    takerRatio = null,
    divBias = null,
    h4SyncFound = false,
    h4CrossContext = null,
    lsr = null,
    lsrTooLong = false,
    lsrTooShort = false,
    volumeRel = null,
    volumeStrength = null,
    openInterest = null,
    oiTrend = null,
    oiChangePct = null,
    h4RegimeCode = null,
    triggerConfirmed = false,
    isSecondLeg = false,
    isDead = false,
    energyCycles = 0,
    energyThreshold = 3
} = {}) {
    const dir = direction === "SHORT" ? "SHORT" : "LONG";
    const isLong = dir === "LONG";
    const h4Found = !!h4SyncFound || !!h4CrossContext?.found;
    const vol = num(volumeRel);
    const taker = num(takerRatio);
    const oiDirection = oiTrend || openInterest?.trend || h4CrossContext?.oiTrend || null;
    const oiPct = num(oiChangePct ?? openInterest?.changePct ?? h4CrossContext?.oiChangePct);
    const lsrAgainst = isLong
        ? !!(lsrTooLong || lsr?.isTooLong)
        : !!(lsrTooShort || lsr?.isTooShort);
    const lsrFavor = isLong ? !!lsr?.isBullish : !!lsr?.isBearish;

    const fiboFavor = isLong ? !!fiboBias?.isDiscount : !!fiboBias?.isRisk;
    const fiboAgainst = isLong ? !!fiboBias?.isRisk : !!fiboBias?.isDiscount;
    const fvgFavor = isLong ? fvgSide === "BULL" : fvgSide === "BEAR";
    const fvgAgainst = isLong ? fvgSide === "BEAR" : fvgSide === "BULL";
    const divFavor = divBias === "favor";
    const divAgainst = divBias === "contra";
    const volumeStrong = vol != null && vol >= 2;
    const volumeOk = vol != null && vol >= 1.2;
    const volumeWeak = vol != null && vol < 1;
    const energyStrong = Number.isFinite(energyCycles) && energyCycles >= energyThreshold;
    const oiAligned = isLong ? oiDirection === "UP" : oiDirection === "DOWN";
    const oiAgainst = isLong ? oiDirection === "DOWN" : oiDirection === "UP";

    const reasons = [];
    const cautions = [];

    if (h4Found) {
        reasons.push(h4CrossContext?.fallback || h4CrossContext?.source === "INCUBADORA_H4_SYNC"
            ? "sync H4 da incubadora"
            : "cruzamento H4 scanner");
    }
    if (h4RegimeCode === "IMPULSE") reasons.push("H4 em impulso");
    if (fiboFavor) reasons.push("fibo a favor");
    if (fvgFavor) reasons.push("FVG a favor");
    if (takerAligned) reasons.push(taker != null ? `taker alinhado ${taker.toFixed(2)}` : "taker alinhado");
    if (volumeStrong) reasons.push(`volume explosivo ${vol.toFixed(2)}x`);
    else if (volumeOk) reasons.push(`volume ok ${vol.toFixed(2)}x`);
    if (oiAligned) reasons.push(`OI ${oiDirection}${oiPct != null ? ` ${oiPct.toFixed(2)}%` : ""}`);
    if (divFavor) reasons.push("divergencia a favor");
    if (lsrFavor) reasons.push("baleias/LSR a favor");
    if (energyStrong) reasons.push(`mola comprimida ${energyCycles}x`);

    if (fiboAgainst) cautions.push("fibo contra");
    if (fvgAgainst) cautions.push("FVG contra");
    if (takerAgainst) cautions.push(taker != null ? `taker contra ${taker.toFixed(2)}` : "taker contra");
    if (divAgainst) cautions.push("divergencia contra");
    if (lsrAgainst) cautions.push("LSR lotado contra");
    if (oiAgainst && Math.abs(oiPct || 0) >= 0.1) cautions.push(`OI ${oiDirection}${oiPct != null ? ` ${oiPct.toFixed(2)}%` : ""}`);
    if (volumeWeak) cautions.push(`volume fraco ${vol.toFixed(2)}x`);

    const againstCount = cautions.length;
    const confirmationCount = [
        h4Found,
        fiboFavor,
        fvgFavor,
        !!takerAligned,
        volumeOk,
        oiAligned,
        divFavor,
        lsrFavor,
        h4RegimeCode === "IMPULSE",
        energyStrong
    ].filter(Boolean).length;

    let quality;
    if (isDead) {
        quality = { code: "RESET", emoji: "⚫", label: "OVO MORTO / RESET" };
    } else if (againstCount >= 3) {
        quality = { code: "HIGH_RISK", emoji: "🔴", label: `${dir} RISCO ALTO` };
    } else if (againstCount === 2) {
        quality = { code: "CONFLICT", emoji: "🟠", label: `${dir} EM CONFLITO` };
    } else if (againstCount === 1) {
        quality = { code: "CAUTION", emoji: "🟡", label: `${dir} BOM COM CAUTELA` };
    } else if (h4Found && confirmationCount >= 4 && (takerAligned || oiAligned || volumeStrong)) {
        quality = { code: "PREMIUM", emoji: "🟢", label: `${dir} PREMIUM` };
    } else if (confirmationCount >= 3) {
        quality = { code: "GOOD", emoji: "🟡", label: `${dir} BOM` };
    } else {
        quality = { code: "WATCH", emoji: "⚪", label: `${dir} OBSERVAR` };
    }

    const phaseInfo = classifyPhase({
        phase,
        cycleState,
        h4RegimeCode,
        h4SyncFound: h4Found,
        triggerConfirmed,
        isSecondLeg,
        isDead
    });

    return {
        quality,
        phase: phaseInfo,
        direction: dir,
        favorCount: confirmationCount,
        againstCount,
        reasons,
        cautions,
        tag: `${quality.code}:${phaseInfo.code}`
    };
}

function buildClassificationBlock(classification) {
    if (!classification?.quality || !classification?.phase) return "";

    const reasons = firstClean(classification.reasons).join(" | ") || "-";
    const cautions = firstClean(classification.cautions).join(" | ");

    return `\n┌─ ${classification.quality.emoji} CLASSIFICACAO DO ALERTA ─────\n` +
        `│ Qualidade: ${classification.quality.label}\n` +
        `│ Fase: ${classification.phase.emoji} ${classification.phase.label}\n` +
        `│ A favor: ${reasons}\n` +
        (cautions ? `│ Cautela: ${cautions}\n` : "") +
        `└──────────────────────────────────────\n`;
}

function cleanClassification(classification) {
    if (!classification) return null;
    return {
        qualityCode: classification.quality?.code || null,
        qualityLabel: classification.quality?.label || null,
        phaseCode: classification.phase?.code || null,
        phaseLabel: classification.phase?.label || null,
        tag: classification.tag || null,
        favorCount: Number.isFinite(Number(classification.favorCount)) ? Number(classification.favorCount) : null,
        againstCount: Number.isFinite(Number(classification.againstCount)) ? Number(classification.againstCount) : null,
        reasons: Array.isArray(classification.reasons) ? classification.reasons : [],
        cautions: Array.isArray(classification.cautions) ? classification.cautions : []
    };
}

module.exports = {
    classifyAlert,
    classifyPhase,
    buildClassificationBlock,
    cleanClassification
};
