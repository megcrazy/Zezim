// CONFIGURAÇÕES ZEZIM PRO - COM FILTROS APRENDIDOS
module.exports = {
    // Telegram
    TELEGRAM: {
        TOKEN: process.env.TELEGRAM_TOKEN || "6408151313:AAETCCVuUB2qBVAqdV0shoAUPrnCHt_anck",
        CHAT_ID: process.env.TELEGRAM_CHAT_ID || "-1002816412263",
        ADMIN_ID: process.env.TELEGRAM_ADMIN_ID || ""
    },

    // Binance
    BINANCE: {
        BASE_URL: "https://fapi.binance.com",
        WS_URL: "wss://fstream.binance.com",
        TIMEOUT: 10000
    },

    // INDICADORES PRINCIPAIS
    INDICATORS: {
        CCI: {
            PERIOD: parseInt(process.env.CCI_PERIOD || "20"),
            THRESHOLD_HIGH: parseInt(process.env.CCI_THRESHOLD_HIGH || "130"),
            THRESHOLD_LOW: parseInt(process.env.CCI_THRESHOLD_LOW || "-130"),
            TURBO_THRESHOLD: parseInt(process.env.CCI_TURBO_THRESHOLD || "180")
        },

        STOCH: {
            H4_OVERSOLD: parseInt(process.env.STOCH_H4_OVERSOLD || "20"),
            H4_OVERBOUGHT: parseInt(process.env.STOCH_H4_OVERBOUGHT || "88"), // Ajustado
            H1_OVERBOUGHT: parseInt(process.env.STOCH_H1_OVERBOUGHT || "85")
        },

        // CONFIGURAÇÕES DE VOLUME
        VOLUME: {
            MIN_RELATIVE_VOLUME: parseFloat(process.env.MIN_RELATIVE_VOLUME || "1.2"), // 20% acima da média
            LOOKBACK_PERIOD: parseInt(process.env.VOLUME_LOOKBACK || "20"), // Período para média móvel
            CONFIRMATION_BARS: parseInt(process.env.VOLUME_CONFIRMATION_BARS || "3") // Barras para confirmação
        }
    },

    // FILTROS INTELIGENTES (APRENDIDOS)
    FILTERS: {
        // Filtro Volume (CRÍTICO - Aprendido com FOLKSUSDT)
        MIN_VOLUME_24H_USD: parseFloat(process.env.MIN_VOLUME_24H_USD || "5000000"), // $5M (aumentado)
        REQUIRE_VOLUME_CONFIRMATION: process.env.REQUIRE_VOLUME !== "false",

        // Filtro Horário (Liquidez)
        PREFERRED_HOURS: process.env.PREFERRED_HOURS
            ? process.env.PREFERRED_HOURS.split(',').map(Number)
            : [8, 9, 10, 11, 14, 15, 16, 17, 20, 21, 22], // UTC-3 horários com liquidez

        // Filtro Reteste (Aprendido com BEATUSDT)
        WAIT_FOR_RETEST: process.env.WAIT_FOR_RETEST !== "false",
        RETEST_TIMEFRAME_MINUTES: parseInt(process.env.RETEST_TIMEFRAME || "15"),

        // Filtro Preço
        MIN_PRICE_STRICT: parseFloat(process.env.MIN_PRICE_STRICT || "0.50"), // Pares > $0.50
        MAX_PRICE_CHANGE_24H: parseFloat(process.env.MAX_PRICE_CHANGE_24H || "50"), // Máx 50% variação em 24h

        // Limites
        MAX_ALERTS_PER_SYMBOL: parseInt(process.env.MAX_ALERTS_PER_SYMBOL || "2"), // Reduzido
        MAX_GOLD_EGG_ALERTS: parseInt(process.env.MAX_GOLD_EGG_ALERTS || "5"),
        SETUP_COOLDOWN_MINUTES: parseInt(process.env.SETUP_COOLDOWN_MINUTES || "45"),
        GOLD_EGG_SETUP_COOLDOWN_MINUTES: parseInt(process.env.GOLD_EGG_SETUP_COOLDOWN_MINUTES || "90")
    },

    // TEMPOS
    TIMING: {
        LOOP_INTERVAL_MINUTES: parseInt(process.env.LOOP_MINUTES || "10"), // A cada 5 minutos
        SLEEP_BETWEEN_REQUESTS_MS: parseInt(process.env.SLEEP_BETWEEN_REQUESTS_MS || "300"),
        GOLD_EGG_MAX_AGE_HOURS: parseInt(process.env.GOLD_EGG_MAX_AGE_HOURS || "24"), // Reduzido
        RESET_DAILY_HOUR: parseInt(process.env.RESET_DAILY_HOUR || "0")
    },

    // SISTEMA DE SCORE 
    SCORING: {
        ENABLED: process.env.SCORING_ENABLED !== "false",
        MIN_SCORE_FOR_ALERT: parseInt(process.env.MIN_SCORE || "6"), // Mínimo 6/10
        WEIGHTS: {
            VOLUME: 3,        // Peso mais alto
            PRICE_POSITION: 2, // Suporte/resistência
            TIMEFRAME_ALIGN: 2, // Alinhamento H1/H4
            TIME_OF_DAY: 1,    // Horário de liquidez
            RETEST_CONFIRM: 2   // Confirmação de reteste
        }
    },

    // INCUBADORA: observa ovos mortos/recarregados sem entrar sozinha
    INCUBADORA: {
        ENABLED: process.env.INCUBADORA_ENABLED !== "false",
        LONG_ACTIVE: process.env.INCUBADORA_LONG_ACTIVE !== "false",
        SHORT_ACTIVE: process.env.INCUBADORA_SHORT_ACTIVE !== "false",
        USE_CLOSED_CANDLES: process.env.INCUBADORA_USE_CLOSED_CANDLES !== "false",

        H4_CCI_RELOAD_LEVEL: parseFloat(process.env.INCUBADORA_H4_CCI_RELOAD || "-100"),
        H4_CCI_EXTREME_LEVEL: parseFloat(process.env.INCUBADORA_H4_CCI_EXTREME || "-200"),
        H4_STOCH_RELOAD_LEVEL: parseFloat(process.env.INCUBADORA_H4_STOCH_RELOAD || "20"),
        H4_LOOKBACK_CANDLES: parseInt(process.env.INCUBADORA_H4_LOOKBACK || "24"),
        H4_SYNC_WINDOW_CANDLES: parseInt(process.env.INCUBADORA_H4_SYNC_WINDOW || "1"),

        H1_WINDOW_CANDLES: parseInt(process.env.INCUBADORA_H1_WINDOW || "40"),
        MIN_ROMPIMENTOS_100: parseInt(process.env.INCUBADORA_MIN_ROMPIMENTOS_100 || "3"),
        MAX_RANGE_PERCENT: parseFloat(process.env.INCUBADORA_MAX_RANGE_PERCENT || "20"),
        REVERSAO_H1_LOOKBACK: parseInt(process.env.INCUBADORA_REVERSAO_H1_LOOKBACK || "18"),
        REVERSAO_CCI_RECOVERY: parseFloat(process.env.INCUBADORA_REVERSAO_CCI_RECOVERY || "-100"),
        REVERSAO_CCI_CONFIRM: parseFloat(process.env.INCUBADORA_REVERSAO_CCI_CONFIRM || "0"),
        REVERSAO_STOCH_LEVEL: parseFloat(process.env.INCUBADORA_REVERSAO_STOCH_LEVEL || "20"),
        REVERSAO_VOLUME_RATIO: parseFloat(process.env.INCUBADORA_REVERSAO_VOLUME_RATIO || "1.2"),

        DISPARO_CCI: parseFloat(process.env.INCUBADORA_DISPARO_CCI || "130"),
        DISPARO_VOLUME_RATIO: parseFloat(process.env.INCUBADORA_DISPARO_VOLUME_RATIO || "1.5"),
        VOLUME_LOOKBACK_CANDLES: parseInt(process.env.INCUBADORA_VOLUME_LOOKBACK || "20"),

        ALERT_SYNC_RESET: process.env.INCUBADORA_ALERT_SYNC_RESET === "true",
        ALERT_REVERSAO: process.env.INCUBADORA_ALERT_REVERSAO !== "false",
        ALERT_H4: process.env.INCUBADORA_ALERT_H4 === "true",
        ALERT_ACUMULO: process.env.INCUBADORA_ALERT_ACUMULO !== "false",
        ALERT_DISPARO: process.env.INCUBADORA_ALERT_DISPARO !== "false",
        MIN_ALERT_INTERVAL_MINUTES: parseInt(process.env.INCUBADORA_ALERT_COOLDOWN_MINUTES || "45"),
        MAX_CYCLE_AGE_HOURS: parseInt(process.env.INCUBADORA_MAX_CYCLE_AGE_HOURS || "168")
    },

    // RELATORIO H4: CCI cruza extremos com Stoch sincronizado no fundo/topo
    STOCH_CCI_H4_SCANNER: {
        ENABLED: process.env.STOCH_CCI_H4_ENABLED !== "false",
        LONG_ACTIVE: process.env.STOCH_CCI_H4_LONG !== "false",
        SHORT_ACTIVE: process.env.STOCH_CCI_H4_SHORT !== "false",
        TIMEFRAME: process.env.STOCH_CCI_H4_TIMEFRAME || "4h",
        KLINE_LIMIT: parseInt(process.env.STOCH_CCI_H4_KLINE_LIMIT || "220"),

        CCI_PERIOD: parseInt(process.env.STOCH_CCI_H4_CCI_PERIOD || "20"),
        CCI_OVERSOLD: parseFloat(process.env.STOCH_CCI_H4_CCI_OVERSOLD || "-200"),
        CCI_OVERBOUGHT: parseFloat(process.env.STOCH_CCI_H4_CCI_OVERBOUGHT || "200"),
        STOCH_PERIOD: parseInt(process.env.STOCH_CCI_H4_STOCH_PERIOD || "14"),
        STOCH_SIGNAL_PERIOD: parseInt(process.env.STOCH_CCI_H4_STOCH_SIGNAL_PERIOD || "3"),
        STOCH_OVERSOLD: parseFloat(process.env.STOCH_CCI_H4_STOCH_OVERSOLD || "20"),
        STOCH_OVERBOUGHT: parseFloat(process.env.STOCH_CCI_H4_STOCH_OVERBOUGHT || "80"),
        SIGNAL_LOOKBACK_CANDLES: parseInt(process.env.STOCH_CCI_H4_LOOKBACK || "4"),

        // Deixe 0 para reproduzir o scanner manual com todos os USDT perpetuals.
        MIN_QUOTE_VOLUME_USDT: parseFloat(process.env.STOCH_CCI_H4_MIN_VOLUME || "0"),
        MAX_SYMBOLS: parseInt(process.env.STOCH_CCI_H4_MAX_SYMBOLS || "0"),
        CONCURRENCY: parseInt(process.env.STOCH_CCI_H4_CONCURRENCY || "8"),
        REQUEST_DELAY_MS: parseInt(process.env.STOCH_CCI_H4_REQUEST_DELAY_MS || "80"),
        RUN_GRACE_MINUTES: parseInt(process.env.STOCH_CCI_H4_GRACE_MINUTES || "3"),
        CROSS_LOOKBACK_HOURS: parseFloat(process.env.STOCH_CCI_H4_CROSS_LOOKBACK_HOURS || "168"),

        ALERT_WHEN_EMPTY: process.env.STOCH_CCI_H4_ALERT_EMPTY === "true",
        ENRICH_TAKER: process.env.STOCH_CCI_H4_TAKER !== "false",
        ENRICH_OPEN_INTEREST: process.env.STOCH_CCI_H4_OI !== "false",
        ENRICH_H1: process.env.STOCH_CCI_H4_H1 !== "false",
        H1_WINDOW_CANDLES: parseInt(process.env.STOCH_CCI_H4_H1_WINDOW || "40"),
        TIMEZONE: process.env.STOCH_CCI_H4_TIMEZONE || "America/Sao_Paulo"
    },

    // ENERGIA / MOLA COMPRIMIDA: quantas vezes o H1 recarregou (mergulhou e voltou
    // a 100+) enquanto o H4 seguia vivo. Validado em análise de research_outcomes.json:
    // dentro da mesma faixa de idade, 3+ recargas teve hit50/hit100 e ganho médio
    // consistentemente maiores. Ainda é sinal fraco (contexto), não filtro bloqueante.
    ENERGY_CYCLES: {
        MIN_CYCLES_FOR_SIGNAL: parseInt(process.env.ENERGY_MIN_CYCLES || "3"),
        RESET_ON_H4_DEAD: process.env.ENERGY_RESET_ON_DEAD !== "false"
    },

    // SISTEMA OVOS DE OURO 
    GOLD_EGG: {
        ENABLED: process.env.GOLD_EGG_ENABLED !== "false",
        PRIMARY_TARGET_PCT: parseFloat(process.env.CCI_EGG_PRIMARY_TARGET_PCT || "5"),

        // LONG (OVERSOLD H4)
        LONG: {
            ACTIVE: true,
            STOCH_H4_THRESHOLD: parseInt(process.env.GOLD_EGG_LONG_STOCH || "20"),
            MIN_CCI_FOR_TRIGGER: parseInt(process.env.GOLD_EGG_LONG_CCI || "130"),
            REQUIRE_VOLUME: true,
            REQUIRE_RETEST: true
        },

        // SHORT (OVERBOUGHT H4)
        SHORT: {
            ACTIVE: true,
            STOCH_H4_THRESHOLD: parseInt(process.env.GOLD_EGG_SHORT_STOCH || "88"),
            MAX_CCI_FOR_TRIGGER: parseInt(process.env.GOLD_EGG_SHORT_CCI || "-130"),
            REQUIRE_VOLUME: true,
            REQUIRE_EXTREME: true // Só ativar em overbought extremo
        },

        MONITOR_HOURS: parseInt(process.env.GOLD_EGG_MONITOR_HOURS || "12") // Reduzido
    }
};
