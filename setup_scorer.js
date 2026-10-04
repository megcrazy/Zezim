class SetupScorer {
    constructor(config) {
        this.config = config;
    }

    async calculateScore(analysis, volumeAnalysis, pricePosition) {
        let score = 0;
        let reasons = [];
        let maxScore = 0;

        // 1. VOLUME (PESO 3)
        if (volumeAnalysis && volumeAnalysis.hasVolumeSpike) {
            score += 3;
            reasons.push(`✅ Volume: ${volumeAnalysis.relativeVolume}x (${volumeAnalysis.volumeStrength})`);
            maxScore += 3;
        } else {
            reasons.push(`❌ Volume: ${volumeAnalysis?.relativeVolume || '0'}x (insuficiente)`);
            maxScore += 3;
        }

        // 2. POSIÇÃO DE PREÇO (PESO 2)
        if (pricePosition) {
            const isLong = analysis.isNewHighSignal;
            const isGoodPosition = isLong 
                ? pricePosition.isNearSupport 
                : pricePosition.isNearResistance;
            
            if (isGoodPosition) {
                score += 2;
                reasons.push(`✅ Posição: ${pricePosition.zone} (${pricePosition.position}%)`);
            } else {
                reasons.push(`⚠️ Posição: ${pricePosition.zone} (${pricePosition.position}%) - não ideal`);
            }
            maxScore += 2;
        }

        // 3. ALINHAMENTO MULTI-TIMEFRAME (PESO 2)
        const timeframeAlign = this.checkTimeframeAlignment(analysis);
        if (timeframeAlign.good) {
            score += 2;
            reasons.push(`✅ Alinhamento: ${timeframeAlign.reason}`);
        } else {
            reasons.push(`⚠️ Alinhamento: ${timeframeAlign.reason}`);
        }
        maxScore += 2;

        // 4. HORÁRIO (PESO 1)
        const now = new Date();
        const hour = now.getUTCHours() - 3;
        if (this.config.FILTERS.PREFERRED_HOURS.includes(hour)) {
            score += 1;
            reasons.push(`✅ Horário: ${hour}:00 (boa liquidez)`);
        } else {
            reasons.push(`⚠️ Horário: ${hour}:00 (baixa liquidez)`);
        }
        maxScore += 1;

        // 5. RETESTE/CONFIRMAÇÃO (PESO 2) - Simulado
        // (Na prática, precisaria monitorar preço após alerta)
        const hasRetest = false; // Placeholder
        if (hasRetest) {
            score += 2;
            reasons.push(`✅ Reteste confirmado`);
        } else {
            reasons.push(`⏳ Aguardando reteste...`);
            maxScore += 2; // Incluir no máximo mesmo sem reteste ainda
        }

        // BÔNUS: OVO DE OURO
        if (analysis.hasGoldEgg) {
            score += 2;
            reasons.push(`🥚 Bônus: Ovo de Ouro ativo`);
            maxScore += 2;
        }

        const percentage = maxScore > 0 ? (score / maxScore * 100).toFixed(0) : 0;
        const quality = percentage >= 80 ? "ALTA" : 
                       percentage >= 60 ? "MÉDIA" : "BAIXA";

        return {
            score,
            maxScore,
            percentage,
            quality,
            reasons,
            pass: percentage >= (this.config.SCORING.MIN_SCORE_FOR_ALERT * 10) // Convertendo para %
        };
    }

    checkTimeframeAlignment(analysis) {
        const isLong = analysis.isNewHighSignal;
        
        if (!analysis.stochH1 || !analysis.stochH4) {
            return { good: false, reason: "Dados insuficientes" };
        }

        // Para LONG: Stoch H4 não pode estar overbought
        if (isLong) {
            if (analysis.stochH4.currentK >= this.config.INDICATORS.STOCH.H4_OVERBOUGHT) {
                return { good: false, reason: "Stoch H4 overbought" };
            }
            return { good: true, reason: "Stoch H4 ok para long" };
        }
        // Para SHORT: Stoch H4 não pode estar oversold
        else {
            if (analysis.stochH4.currentK <= this.config.INDICATORS.STOCH.H4_OVERSOLD) {
                return { good: false, reason: "Stoch H4 oversold" };
            }
            return { good: true, reason: "Stoch H4 ok para short" };
        }
    }

    // Verificar se é "rompimento fake" como FOLKSUSDT
    checkFakeBreakout(analysis, pricePosition) {
        if (!pricePosition) return false;
        
        const isLong = analysis.isNewHighSignal;
        const isNearResistance = pricePosition.isNearResistance;
        const isNearSupport = pricePosition.isNearSupport;
        
        // Se é LONG perto de resistência OU SHORT perto de suporte
        return (isLong && isNearResistance) || (!isLong && isNearSupport);
    }
}

module.exports = SetupScorer;