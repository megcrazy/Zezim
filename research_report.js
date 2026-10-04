const fs = require("fs");
const path = require("path");
const axios = require("axios");
require("dotenv").config();

const CONFIG = require("./config");

const DATA_DIR = path.join(__dirname, "data");
const EGGS_FILE = path.join(DATA_DIR, "research_eggs.jsonl");
const OUTCOMES_FILE = path.join(DATA_DIR, "research_outcomes.json");

function readJsonl(file) {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
            try { return JSON.parse(line); }
            catch { return null; }
        })
        .filter(Boolean);
}

function readJson(file, fallback) {
    try {
        if (!fs.existsSync(file)) return fallback;
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
        return fallback;
    }
}

function pct(n, total) {
    if (!total) return "0%";
    return `${((n / total) * 100).toFixed(1)}%`;
}

function num(v, digits = 2) {
    if (v === null || v === undefined || v === "") return "-";
    const n = Number(v);
    if (!Number.isFinite(n)) return "-";
    return n.toFixed(digits);
}

function avg(values) {
    const clean = values.map(Number).filter(Number.isFinite);
    if (!clean.length) return null;
    return clean.reduce((sum, v) => sum + v, 0) / clean.length;
}

function hours(value) {
    if (value === null || value === undefined || value === "") return "-";
    const n = Number(value);
    if (!Number.isFinite(n)) return "-";
    return `${n.toFixed(1)}h`;
}

function directionalValue(direction, value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return direction === "SHORT" ? -n : n;
}

function directionalGain(direction, entry, price) {
    const e = Number(entry);
    const p = Number(price);
    if (!Number.isFinite(e) || !e || !Number.isFinite(p)) return null;
    const raw = ((p - e) / e) * 100;
    return direction === "SHORT" ? -raw : raw;
}

function loadDataset(days = 30) {
    const cutoff = Date.now() - days * 24 * 3600000;
    const eggs = readJsonl(EGGS_FILE).filter((egg) => !days || egg.createdAt >= cutoff);
    const outcomesById = readJson(OUTCOMES_FILE, {});
    const rows = eggs.map((egg) => {
        const outcome = outcomesById[egg.id] || {};
        const maxGainPct = Number.isFinite(Number(outcome.maxGainPct))
            ? Number(outcome.maxGainPct)
            : directionalGain(egg.direction, egg.entryPrice, outcome.maxGainPrice);
        return {
            ...egg,
            outcome: {
                ...outcome,
                maxGainPct: Number.isFinite(maxGainPct) ? maxGainPct : 0,
                maxLossPct: Number.isFinite(Number(outcome.maxLossPct)) ? Number(outcome.maxLossPct) : 0
            }
        };
    });

    const knownIds = new Set(rows.map(r => r.id));
    for (const [id, outcome] of Object.entries(outcomesById)) {
        if (knownIds.has(id)) continue;
        if (days && outcome.createdAt && outcome.createdAt < cutoff) continue;
        rows.push({
            id,
            createdAt: outcome.createdAt,
            source: "OUTCOME_ONLY",
            symbol: outcome.symbol,
            direction: outcome.direction,
            entryPrice: outcome.entryPrice,
            tags: [],
            outcome: {
                ...outcome,
                maxGainPct: Number.isFinite(Number(outcome.maxGainPct)) ? Number(outcome.maxGainPct) : 0,
                maxLossPct: Number.isFinite(Number(outcome.maxLossPct)) ? Number(outcome.maxLossPct) : 0
            }
        });
    }
    return rows;
}

function lineForGroup(label, rows) {
    const total = rows.length;
    const hit5 = rows.filter(r => r.outcome.hit5 || r.outcome.maxGainPct >= 5).length;
    const hit15 = rows.filter(r => r.outcome.hit15 || r.outcome.maxGainPct >= 15).length;
    const avgGain = avg(rows.map(r => r.outcome.maxGainPct));
    const avgLoss = avg(rows.map(r => r.outcome.maxLossPct));
    return `${label}\nOvos: ${total}\nAlvo 5%: ${pct(hit5, total)} | Alvo 15%: ${pct(hit15, total)} | Ganho medio: ${num(avgGain)}% | Drawdown medio: ${num(avgLoss)}%`;
}

function compactLineForGroup(label, rows) {
    const total = rows.length;
    const hit5 = rows.filter(r => r.outcome.hit5 || r.outcome.maxGainPct >= 5).length;
    const hit8 = rows.filter(r => r.outcome.hit8 || r.outcome.maxGainPct >= 8).length;
    const hit15 = rows.filter(r => r.outcome.hit15 || r.outcome.maxGainPct >= 15).length;
    const avgGain = avg(rows.map(r => r.outcome.maxGainPct));
    const avgLoss = avg(rows.map(r => r.outcome.maxLossPct));
    return `${label}\nOvos: ${total} | 5%: ${pct(hit5, total)} | 8%: ${pct(hit8, total)} | 15%: ${pct(hit15, total)} | Gain: ${num(avgGain)}% | DD: ${num(avgLoss)}%`;
}

function reportGeral(rows, days) {
    const total = rows.length;
    const countTarget = (target) => rows.filter(r => r.outcome[`hit${target}`] || r.outcome.maxGainPct >= target).length;
    const sortedGain = [...rows].sort((a, b) => b.outcome.maxGainPct - a.outcome.maxGainPct);
    const sortedLoss = [...rows].sort((a, b) => a.outcome.maxLossPct - b.outcome.maxLossPct);
    const best = sortedGain[0];
    const worst = sortedLoss[0];

    return [
        `📊 ZEZIM RESEARCH`,
        ``,
        `Periodo: ultimos ${days} dias`,
        ``,
        `🥚 Ovos encontrados: ${total}`,
        ``,
        `✅ Acertaram alvo 5%: ${countTarget(5)} (${pct(countTarget(5), total)})`,
        `Acertaram alvo 8%: ${countTarget(8)} (${pct(countTarget(8), total)})`,
        `Acertaram alvo 15%: ${countTarget(15)} (${pct(countTarget(15), total)})`,
        `Acima de 50%: ${countTarget(50)} (${pct(countTarget(50), total)})`,
        `Acima de 100%: ${countTarget(100)} (${pct(countTarget(100), total)})`,
        ``,
        `Maior pump: ${best ? `${best.symbol} ${best.direction} +${num(best.outcome.maxGainPct)}%` : "-"}`,
        `Maior perda: ${worst ? `${worst.symbol} ${worst.direction} ${num(worst.outcome.maxLossPct)}%` : "-"}`,
        ``,
        `Tempo medio ate 5%: ${hours(avg(rows.map(r => r.outcome.timeTo5h)))}`,
        `Tempo medio ate 8%: ${hours(avg(rows.map(r => r.outcome.timeTo8h)))}`,
        `Tempo medio ate 15%: ${hours(avg(rows.map(r => r.outcome.timeTo15h)))}`,
        `Tempo medio ate 50%: ${hours(avg(rows.map(r => r.outcome.timeTo50h)))}`
    ].join("\n");
}

function reportH4(rows) {
    const buckets = [
        ["<0", (v) => v < 0],
        ["0-50", (v) => v >= 0 && v < 50],
        ["50-100", (v) => v >= 50 && v < 100],
        ["100-200", (v) => v >= 100 && v < 200],
        [">200", (v) => v >= 200]
    ];
    const lines = [`📊 ZEZIM RESEARCH — H4`, ``, `CCI H4 direcional na entrada`];
    for (const [label, fn] of buckets) {
        const group = rows.filter((r) => {
            const value = directionalValue(r.direction, r.cciH4);
            return Number.isFinite(value) && fn(value);
        });
        lines.push(``, lineForGroup(label, group));
    }
    return lines.join("\n");
}

function reportReteste(rows) {
    const withRetest = rows.filter(r => r.outcome.retest);
    const withoutRetest = rows.filter(r => !r.outcome.retest);
    const withStopHunter = rows.filter(r => r.outcome.stopHunter);
    return [
        `📊 ZEZIM RESEARCH — RETESTE`,
        ``,
        lineForGroup("Com reteste confirmado", withRetest),
        ``,
        lineForGroup("Sem reteste confirmado", withoutRetest),
        ``,
        lineForGroup("Com stop hunter", withStopHunter)
    ].join("\n");
}

function takerAlignment(row) {
    const ratio = Number(row.takerRatio);
    if (!Number.isFinite(ratio)) return "sem taker";
    const aligned = row.direction === "LONG" ? ratio >= 1 : ratio <= 1;
    const strong = row.direction === "LONG" ? ratio >= 1.5 : ratio <= 0.67;
    const againstStrong = row.direction === "LONG" ? ratio <= 0.67 : ratio >= 1.5;
    if (strong) return "a favor forte";
    if (aligned) return "a favor leve";
    if (againstStrong) return "contra forte";
    return "contra leve";
}

function h4Bucket(row) {
    const value = directionalValue(row.direction, row.cciH4);
    if (!Number.isFinite(value)) return "sem H4";
    if (value < 0) return "H4 <0";
    if (value < 50) return "H4 0-50";
    if (value < 100) return "H4 50-100";
    if (value < 200) return "H4 100-200";
    return "H4 >200";
}

function fiboGroup(row) {
    const isDiscount = !!row.fiboBias?.isDiscount;
    const isRisk = !!row.fiboBias?.isRisk;
    if (!isDiscount && !isRisk) return "Fibo neutra/sem";
    const favor = (row.direction === "LONG" && isDiscount) ||
        (row.direction === "SHORT" && isRisk);
    return favor ? "Fibo a favor" : "Fibo contra";
}

function isTakerFavorForte(row) {
    return takerAlignment(row) === "a favor forte";
}

function isVolumeExplosive(row) {
    return Number(row.volumeRel) >= 2;
}

function reportTaker(rows) {
    const groups = ["a favor forte", "a favor leve", "contra leve", "contra forte", "sem taker"];
    const lines = [`📊 ZEZIM RESEARCH — TAKER`];
    for (const label of groups) {
        lines.push(``, lineForGroup(label, rows.filter(r => takerAlignment(r) === label)));
    }
    return lines.join("\n");
}

function fvgGroup(row) {
    if (!row.fvgSide) return "fora de FVG";
    const favor = (row.direction === "LONG" && row.fvgSide === "BULL") ||
        (row.direction === "SHORT" && row.fvgSide === "BEAR");
    return favor ? "FVG a favor" : "FVG contra";
}

function reportFvg(rows) {
    const groups = ["FVG a favor", "FVG contra", "fora de FVG"];
    const lines = [`📊 ZEZIM RESEARCH — FVG`];
    for (const label of groups) {
        lines.push(``, lineForGroup(label, rows.filter(r => fvgGroup(r) === label)));
    }
    return lines.join("\n");
}

function divergenceBias(row, key) {
    const bias = row.divergence?.[key]?.bias;
    if (bias === "favor") return "a favor";
    if (bias === "contra") return "contra";
    return "sem div";
}

function reportDivergencias(rows) {
    const defs = [
        ["H1", "h1"],
        ["H4", "h4"],
        ["12h", "h12"],
        ["15m", "m15"]
    ];
    const lines = [`📊 ZEZIM RESEARCH — DIVERGÊNCIAS CCI`];

    for (const [label, key] of defs) {
        lines.push(``, `${label}`);
        for (const group of ["a favor", "contra", "sem div"]) {
            lines.push(lineForGroup(group, rows.filter(r => divergenceBias(r, key) === group)));
        }
    }

    lines.push(``, `🔎 Combinações`);
    lines.push(``, lineForGroup("H1 + H4 a favor", rows.filter(r =>
        divergenceBias(r, "h1") === "a favor" && divergenceBias(r, "h4") === "a favor"
    )));
    lines.push(``, lineForGroup("H1 a favor + H4 contra", rows.filter(r =>
        divergenceBias(r, "h1") === "a favor" && divergenceBias(r, "h4") === "contra"
    )));
    lines.push(``, lineForGroup("H4 + 12h a favor", rows.filter(r =>
        divergenceBias(r, "h4") === "a favor" && divergenceBias(r, "h12") === "a favor"
    )));
    lines.push(``, lineForGroup("H4 contra + 12h contra", rows.filter(r =>
        divergenceBias(r, "h4") === "contra" && divergenceBias(r, "h12") === "contra"
    )));

    return lines.join("\n");
}

function reportTraps(rows) {
    const traps = rows.filter(r => (r.tags || []).includes("risk_trap"));
    const nonTraps = rows.filter(r => !(r.tags || []).includes("risk_trap"));
    return [
        `📊 ZEZIM RESEARCH — TRAPS`,
        ``,
        lineForGroup("Risk trap: Fibo contra + FVG contra + volume forte", traps),
        ``,
        lineForGroup("Demais setups", nonTraps)
    ].join("\n");
}

function comboKey(row) {
    return [
        h4Bucket(row),
        takerAlignment(row),
        fvgGroup(row),
        fiboGroup(row)
    ].join(" + ");
}

function comboStats(label, rows) {
    const total = rows.length;
    const hit5 = rows.filter(r => r.outcome.hit5 || r.outcome.maxGainPct >= 5).length;
    const hit8 = rows.filter(r => r.outcome.hit8 || r.outcome.maxGainPct >= 8).length;
    const hit15 = rows.filter(r => r.outcome.hit15 || r.outcome.maxGainPct >= 15).length;
    return {
        label,
        total,
        hit5Rate: total ? (hit5 / total) * 100 : 0,
        hit8Rate: total ? (hit8 / total) * 100 : 0,
        hit15Rate: total ? (hit15 / total) * 100 : 0,
        avgGain: avg(rows.map(r => r.outcome.maxGainPct)),
        avgLoss: avg(rows.map(r => r.outcome.maxLossPct))
    };
}

function formatComboStat(stat) {
    return `${stat.label}\nOvos: ${stat.total} | 5%: ${num(stat.hit5Rate, 1)}% | 8%: ${num(stat.hit8Rate, 1)}% | 15%: ${num(stat.hit15Rate, 1)}% | Gain: ${num(stat.avgGain)}% | DD: ${num(stat.avgLoss)}%`;
}

function reportCombinado(rows, minSamples = 10) {
    const combos = [
        ["H4 100-200 + taker forte a favor", r => h4Bucket(r) === "H4 100-200" && isTakerFavorForte(r)],
        ["H4 100-200 + FVG a favor", r => h4Bucket(r) === "H4 100-200" && fvgGroup(r) === "FVG a favor"],
        ["H4 100-200 + taker forte + FVG a favor", r => h4Bucket(r) === "H4 100-200" && isTakerFavorForte(r) && fvgGroup(r) === "FVG a favor"],
        ["H4 0-200 + taker forte a favor", r => ["H4 0-50", "H4 50-100", "H4 100-200"].includes(h4Bucket(r)) && isTakerFavorForte(r)],
        ["H4 <0 + taker forte a favor", r => h4Bucket(r) === "H4 <0" && isTakerFavorForte(r)],
        ["H4 >200 + taker forte a favor", r => h4Bucket(r) === "H4 >200" && isTakerFavorForte(r)],
        ["FVG a favor + taker forte a favor", r => fvgGroup(r) === "FVG a favor" && isTakerFavorForte(r)],
        ["Fibo a favor + FVG a favor", r => fiboGroup(r) === "Fibo a favor" && fvgGroup(r) === "FVG a favor"],
        ["Fibo contra + FVG contra", r => fiboGroup(r) === "Fibo contra" && fvgGroup(r) === "FVG contra"],
        ["Fibo contra + volume explosivo", r => fiboGroup(r) === "Fibo contra" && isVolumeExplosive(r)],
        ["FVG contra + volume explosivo", r => fvgGroup(r) === "FVG contra" && isVolumeExplosive(r)],
        ["Fibo contra + FVG contra + volume explosivo", r => fiboGroup(r) === "Fibo contra" && fvgGroup(r) === "FVG contra" && isVolumeExplosive(r)]
    ];

    const grouped = new Map();
    for (const row of rows) {
        const key = comboKey(row);
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(row);
    }

    const ranked = Array.from(grouped.entries())
        .map(([label, groupRows]) => comboStats(label, groupRows))
        .filter(stat => stat.total >= minSamples)
        .sort((a, b) => {
            if ((b.avgGain || 0) !== (a.avgGain || 0)) return (b.avgGain || 0) - (a.avgGain || 0);
            return b.hit5Rate - a.hit5Rate;
        });

    const lines = [
        `📊 ZEZIM RESEARCH — COMBINADO`,
        ``,
        `Periodo analisado: ${rows.length} ovos`,
        `Ranking automatico: minimo ${minSamples} ovos por combinacao`,
        ``,
        `🔎 Combinacoes suspeitas`
    ];

    for (const [label, predicate] of combos) {
        lines.push(``, compactLineForGroup(label, rows.filter(predicate)));
    }

    lines.push(``, `🏆 Melhores combinacoes por ganho medio`);
    for (const stat of ranked.slice(0, 8)) {
        lines.push(``, formatComboStat(stat));
    }

    lines.push(``, `⚠️ Piores combinacoes por ganho medio`);
    for (const stat of [...ranked].reverse().slice(0, 8)) {
        lines.push(``, formatComboStat(stat));
    }

    return lines.join("\n");
}

async function sendTelegram(text) {
    if (!CONFIG.TELEGRAM.TOKEN || !CONFIG.TELEGRAM.CHAT_ID) return;
    await axios.post(
        `https://api.telegram.org/bot${CONFIG.TELEGRAM.TOKEN}/sendMessage`,
        { chat_id: CONFIG.TELEGRAM.CHAT_ID, text, parse_mode: "Markdown", disable_web_page_preview: true },
        { timeout: 10000 }
    );
}

async function main() {
    const args = process.argv.slice(2);
    const command = (args[0] || "geral").toLowerCase();
    const daysArg = args.find(a => /^\d+$/.test(a));
    const days = daysArg ? parseInt(daysArg, 10) : 30;
    const rows = loadDataset(days);

    const reports = {
        geral: () => reportGeral(rows, days),
        h4: () => reportH4(rows),
        reteste: () => reportReteste(rows),
        taker: () => reportTaker(rows),
        fvg: () => reportFvg(rows),
        div: () => reportDivergencias(rows),
        divergencia: () => reportDivergencias(rows),
        divergencias: () => reportDivergencias(rows),
        traps: () => reportTraps(rows),
        combinado: () => reportCombinado(rows, parseInt(args.find(a => /^min=\d+$/i.test(a))?.split("=")[1] || "10", 10)),
        combos: () => reportCombinado(rows, parseInt(args.find(a => /^min=\d+$/i.test(a))?.split("=")[1] || "10", 10))
    };

    const text = reports[command]
        ? reports[command]()
        : `Comando desconhecido. Use: geral, h4, reteste, taker, fvg, div, traps, combinado`;

    console.log(text);
    if (args.includes("--telegram")) await sendTelegram(text);
}

main().catch((e) => {
    console.error("Erro no research_report:", e.message);
    process.exitCode = 1;
});
