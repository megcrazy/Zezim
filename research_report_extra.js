// research_report_extra.js
// Relatórios adicionais que NÃO existem no research_report.js original:
//   1) distribuicao  -> mediana + máximo + média excluindo o top-1 (resolve distorção de outlier)
//   2) cauda         -> % de ovos com drawdown pior que -5% / -10% / -15%
//   3) top           -> lista detalhada dos ovos que bateram um alvo (padrão 50%+)
//   4) split         -> robustez temporal (primeira metade vs segunda metade do período)
//
// Usa os MESMOS arquivos de dados do research_report.js (./data/research_eggs.jsonl e
// ./data/research_outcomes.json), sem precisar tocar no arquivo original.
//
// Uso:
//   node research_report_extra.js distribuicao 30
//   node research_report_extra.js cauda 30
//   node research_report_extra.js top 30 min=50        (lista quem bateu >= 50%; padrão 50)
//   node research_report_extra.js split 30

const fs = require("fs");
const path = require("path");
const axios = require("axios");
require("dotenv").config();

const CONFIG = require("./config");

const DATA_DIR = path.join(__dirname, "data");
const EGGS_FILE = path.join(DATA_DIR, "research_eggs.jsonl");
const OUTCOMES_FILE = path.join(DATA_DIR, "research_outcomes.json");

// ---------- helpers (mesmo comportamento do research_report.js) ----------

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

function num(v, digits = 2) {
    if (v === null || v === undefined || v === "") return "-";
    const n = Number(v);
    if (!Number.isFinite(n)) return "-";
    return n.toFixed(digits);
}

function pct(n, total) {
    if (!total) return "0%";
    return `${((n / total) * 100).toFixed(1)}%`;
}

function avg(values) {
    const clean = values.map(Number).filter(Number.isFinite);
    if (!clean.length) return null;
    return clean.reduce((sum, v) => sum + v, 0) / clean.length;
}

function median(values) {
    const clean = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (!clean.length) return null;
    const mid = Math.floor(clean.length / 2);
    return clean.length % 2 === 0 ? (clean[mid - 1] + clean[mid]) / 2 : clean[mid];
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

function h4Bucket(row) {
    const value = directionalValue(row.direction, row.cciH4);
    if (!Number.isFinite(value)) return "sem H4";
    if (value < 0) return "H4 <0";
    if (value < 50) return "H4 0-50";
    if (value < 100) return "H4 50-100";
    if (value < 200) return "H4 100-200";
    return "H4 >200";
}

// ---------- 1) DISTRIBUICAO: mediana + max + media sem o top-1 ----------
// Resolve o problema de outlier: um NFPUSDT/AKE de +600-700% pode estar
// carregando sozinho a media de um bucket inteiro. A mediana e a "media
// sem o top-1" mostram o que e tipico vs o que e excepcional.

function distribGroup(label, rows) {
    const total = rows.length;
    if (!total) return `${label}\nOvos: 0`;

    const gains = rows.map(r => r.outcome.maxGainPct);
    const losses = rows.map(r => r.outcome.maxLossPct);
    const sortedByGain = [...rows].sort((a, b) => b.outcome.maxGainPct - a.outcome.maxGainPct);
    const top1 = sortedByGain[0];
    const gainsSemTop1 = sortedByGain.slice(1).map(r => r.outcome.maxGainPct);

    const avgGain = avg(gains);
    const medGain = median(gains);
    const avgGainSemTop1 = avg(gainsSemTop1);
    const worst = [...rows].sort((a, b) => a.outcome.maxLossPct - b.outcome.maxLossPct)[0];

    const distortion = avgGain && avgGainSemTop1
        ? (((avgGain - avgGainSemTop1) / avgGain) * 100)
        : null;

    return [
        `${label}`,
        `Ovos: ${total}`,
        `Ganho medio: ${num(avgGain)}% | Ganho mediano: ${num(medGain)}%`,
        `Maior pump: ${top1 ? `${top1.symbol} +${num(top1.outcome.maxGainPct)}%` : "-"}`,
        `Ganho medio SEM o top-1: ${num(avgGainSemTop1)}%${distortion !== null ? ` (top-1 responde por ${num(distortion, 1)}% da media)` : ""}`,
        `Drawdown mediano: ${num(median(losses))}% | Pior perda: ${worst ? `${worst.symbol} ${num(worst.outcome.maxLossPct)}%` : "-"}`
    ].join("\n");
}

function reportDistribuicao(rows) {
    const buckets = [
        ["<0", (v) => v < 0],
        ["0-50", (v) => v >= 0 && v < 50],
        ["50-100", (v) => v >= 50 && v < 100],
        ["100-200", (v) => v >= 100 && v < 200],
        [">200", (v) => v >= 200]
    ];

    const lines = [
        `📊 ZEZIM RESEARCH — DISTRIBUICAO (mediana vs media)`,
        ``,
        `═══ GERAL (todos os ovos) ═══`,
        distribGroup("Todos", rows)
    ];

    lines.push(``, `═══ POR FAIXA DE H4 ═══`);
    for (const [label, fn] of buckets) {
        const group = rows.filter((r) => {
            const value = directionalValue(r.direction, r.cciH4);
            return Number.isFinite(value) && fn(value);
        });
        lines.push(``, distribGroup(`H4 ${label}`, group));
    }

    return lines.join("\n");
}

// ---------- 2) CAUDA: distribuicao de perdas (nao so a media) ----------
// A media de DD pode estar tranquila (-0.5%) escondendo uma cauda de
// poucos casos catastroficos (-20%, -28%). Isso importa mais pra risco
// do que a media.

function caudaGroup(label, rows) {
    const total = rows.length;
    if (!total) return `${label}\nOvos: 0`;

    const worse5 = rows.filter(r => r.outcome.maxLossPct <= -5).length;
    const worse10 = rows.filter(r => r.outcome.maxLossPct <= -10).length;
    const worse15 = rows.filter(r => r.outcome.maxLossPct <= -15).length;
    const worse20 = rows.filter(r => r.outcome.maxLossPct <= -20).length;

    return [
        `${label}`,
        `Ovos: ${total}`,
        `DD medio: ${num(avg(rows.map(r => r.outcome.maxLossPct)))}% | DD mediano: ${num(median(rows.map(r => r.outcome.maxLossPct)))}%`,
        `Pior que -5%: ${worse5} (${pct(worse5, total)}) | Pior que -10%: ${worse10} (${pct(worse10, total)})`,
        `Pior que -15%: ${worse15} (${pct(worse15, total)}) | Pior que -20%: ${worse20} (${pct(worse20, total)})`
    ].join("\n");
}

function reportCauda(rows) {
    const buckets = [
        ["<0", (v) => v < 0],
        ["0-50", (v) => v >= 0 && v < 50],
        ["50-100", (v) => v >= 50 && v < 100],
        ["100-200", (v) => v >= 100 && v < 200],
        [">200", (v) => v >= 200]
    ];

    const lines = [
        `📊 ZEZIM RESEARCH — CAUDA DE PERDAS`,
        ``,
        `═══ GERAL ═══`,
        caudaGroup("Todos", rows)
    ];

    lines.push(``, `═══ POR FAIXA DE H4 ═══`);
    for (const [label, fn] of buckets) {
        const group = rows.filter((r) => {
            const value = directionalValue(r.direction, r.cciH4);
            return Number.isFinite(value) && fn(value);
        });
        lines.push(``, caudaGroup(`H4 ${label}`, group));
    }

    return lines.join("\n");
}

// ---------- 3) TOP: lista detalhada de quem bateu um alvo alto ----------
// Pra responder: "os pumps grandes sao concentrados em pares de baixa
// liquidez? sao turbo? qual faixa de H4 domina?"

function reportTop(rows, minTarget = 50) {
    const hits = rows
        .filter(r => r.outcome.maxGainPct >= minTarget)
        .sort((a, b) => b.outcome.maxGainPct - a.outcome.maxGainPct);

    const lines = [
        `📊 ZEZIM RESEARCH — TOP (>= ${minTarget}%)`,
        ``,
        `Total de ovos que bateram ${minTarget}%+: ${hits.length} de ${rows.length} (${pct(hits.length, rows.length)})`,
        ``
    ];

    if (!hits.length) {
        lines.push(`Nenhum ovo bateu ${minTarget}%+ nesse periodo.`);
        return lines.join("\n");
    }

    // Resumo agregado: quantos por faixa de H4 e quantos eram turbo
    const byH4 = new Map();
    let turboCount = 0;
    for (const r of hits) {
        const b = h4Bucket(r);
        byH4.set(b, (byH4.get(b) || 0) + 1);
        if (r.isTurbo) turboCount++;
    }
    lines.push(`Turbo: ${turboCount}/${hits.length} (${pct(turboCount, hits.length)})`);
    lines.push(`Por faixa H4: ${Array.from(byH4.entries()).map(([k, v]) => `${k}=${v}`).join(" | ")}`);
    lines.push(``, `── Lista individual (top ${Math.min(hits.length, 25)}) ──`);

    for (const r of hits.slice(0, 25)) {
        const date = r.createdAt ? new Date(r.createdAt).toLocaleDateString("pt-BR") : "-";
        lines.push(
            `${r.symbol} ${r.direction} ${r.isTurbo ? "🚀TURBO" : ""} | +${num(r.outcome.maxGainPct)}% | ` +
            `H4: ${h4Bucket(r)} | vol.rel: ${num(r.volumeRel, 2)}x | ${date}`
        );
    }

    return lines.join("\n");
}

// ---------- 4) SPLIT: robustez temporal (1a metade vs 2a metade) ----------
// Se o edge sobrevive dividindo o periodo em duas janelas, e mais
// confiavel do que um numero agregado unico (protege contra "so
// funcionou porque o mes foi de alta geral").

function splitGroup(label, rows) {
    const total = rows.length;
    const hit5 = rows.filter(r => r.outcome.hit5 || r.outcome.maxGainPct >= 5).length;
    const hit15 = rows.filter(r => r.outcome.hit15 || r.outcome.maxGainPct >= 15).length;
    return `${label}\nOvos: ${total} | Alvo 5%: ${pct(hit5, total)} | Alvo 15%: ${pct(hit15, total)} | Gain medio: ${num(avg(rows.map(r => r.outcome.maxGainPct)))}% | DD medio: ${num(avg(rows.map(r => r.outcome.maxLossPct)))}%`;
}

function reportSplit(rows, days) {
    const withTime = rows.filter(r => Number.isFinite(Number(r.createdAt)));
    if (!withTime.length) {
        return `📊 ZEZIM RESEARCH — SPLIT TEMPORAL\n\nSem dados com timestamp valido.`;
    }
    const times = withTime.map(r => Number(r.createdAt));
    const minT = Math.min(...times);
    const maxT = Math.max(...times);
    const mid = (minT + maxT) / 2;

    const firstHalf = withTime.filter(r => Number(r.createdAt) < mid);
    const secondHalf = withTime.filter(r => Number(r.createdAt) >= mid);

    const fmtDate = (ms) => new Date(ms).toLocaleDateString("pt-BR");

    return [
        `📊 ZEZIM RESEARCH — SPLIT TEMPORAL (${days} dias)`,
        ``,
        `Janela completa: ${fmtDate(minT)} até ${fmtDate(maxT)}`,
        ``,
        splitGroup(`1a metade (${fmtDate(minT)} → ${fmtDate(mid)})`, firstHalf),
        ``,
        splitGroup(`2a metade (${fmtDate(mid)} → ${fmtDate(maxT)})`, secondHalf),
        ``,
        `Se as taxas de acerto/gain das duas metades forem parecidas, o edge é mais`,
        `provável de ser estrutural. Se uma metade carregar o resultado sozinha,`,
        `desconfie de viés de período (ex: mês de alta geral do mercado).`
    ].join("\n");
}

// ---------- 5) COBERTURA: quantos ovos tiveram o outcome realmente ----------
// atualizado (vs travado no default 0/0 desde a criacao).
// outcome.lastEvent so deixa de ser null quando updateOutcome() roda pelo
// menos uma vez (via retest_monitor STOP_HUNTER/RETEST_CONFIRMED/TAKER_ZONE
// ou via cci_egg_monitor BEST_GAIN_UPDATE). Se ficou null, o ovo nunca foi
// re-checado depois de criado e o 0.00% dele nao significa "preco parado".

function coberturaGroup(label, rows) {
    const total = rows.length;
    if (!total) return `${label}\nOvos: 0`;
    const tracked = rows.filter(r => r.outcome.lastEvent != null || r.outcome.lastUpdatedAt !== r.outcome.createdAt);
    const untracked = total - tracked.length;
    return [
        `${label}`,
        `Ovos: ${total}`,
        `Rastreados (outcome atualizado ao menos 1x): ${tracked.length} (${pct(tracked.length, total)})`,
        `NUNCA rastreados (travados no default 0%/0%): ${untracked} (${pct(untracked, total)})`
    ].join("\n");
}

function reportCobertura(rows) {
    const lines = [
        `📊 ZEZIM RESEARCH — COBERTURA DE RASTREAMENTO`,
        ``,
        `Mede quantos ovos tiveram o outcome atualizado pelo menos 1x depois`,
        `de criados (via retest_monitor ou cci_egg_monitor), vs quantos ficaram`,
        `travados no valor default (0%/0%) por nunca terem sido re-checados.`,
        ``,
        `═══ GERAL ═══`,
        coberturaGroup("Todos", rows)
    ];

    const hasEggRows = rows.filter(r => r.hasEgg);
    const noEggRows = rows.filter(r => !r.hasEgg);
    lines.push(``, `═══ POR TIPO ═══`);
    lines.push(``, coberturaGroup("Com Gold Egg (hasEgg=true)", hasEggRows));
    lines.push(``, coberturaGroup("Sem Gold Egg", noEggRows));

    const turboRows = rows.filter(r => r.isTurbo);
    const nonTurboRows = rows.filter(r => !r.isTurbo);
    lines.push(``, coberturaGroup("Turbo", turboRows));
    lines.push(``, coberturaGroup("Nao-turbo", nonTurboRows));

    return lines.join("\n");
}

// ---------- 6) TURBO: turbo vs nao-turbo, apenas nos ovos rastreados ----------
// Testa a hipotese "os turbo sao os tops" com numero de verdade, restrito
// aos ovos que de fato tiveram outcome atualizado (senao a comparacao fica
// contaminada pelos 0%/0% de ovos nunca checados).

function isTracked(row) {
    return row.outcome.lastEvent != null || row.outcome.lastUpdatedAt !== row.outcome.createdAt;
}

function turboGroup(label, rows) {
    const total = rows.length;
    if (!total) return `${label}\nOvos: 0`;
    const hit5 = rows.filter(r => r.outcome.hit5 || r.outcome.maxGainPct >= 5).length;
    const hit15 = rows.filter(r => r.outcome.hit15 || r.outcome.maxGainPct >= 15).length;
    const hit50 = rows.filter(r => r.outcome.hit50 || r.outcome.maxGainPct >= 50).length;
    return [
        `${label}`,
        `Ovos rastreados: ${total}`,
        `Alvo 5%: ${pct(hit5, total)} | Alvo 15%: ${pct(hit15, total)} | Alvo 50%: ${pct(hit50, total)}`,
        `Ganho medio: ${num(avg(rows.map(r => r.outcome.maxGainPct)))}% | Ganho mediano: ${num(median(rows.map(r => r.outcome.maxGainPct)))}%`
    ].join("\n");
}

function reportTurbo(rows) {
    const tracked = rows.filter(isTracked);
    const turbo = tracked.filter(r => r.isTurbo);
    const nonTurbo = tracked.filter(r => !r.isTurbo);

    const hits50 = rows.filter(r => r.outcome.maxGainPct >= 50);
    const turboIn50 = hits50.filter(r => r.isTurbo).length;

    return [
        `📊 ZEZIM RESEARCH — TURBO vs NAO-TURBO`,
        ``,
        `(restrito aos ovos com outcome rastreado, pra nao contaminar com`,
        `ovos nunca re-checados — veja o relatorio "cobertura")`,
        ``,
        `Base geral: ${pct(tracked.filter(r=>r.isTurbo).length, tracked.length)} dos ovos rastreados sao turbo`,
        `Entre os que bateram 50%+: ${turboIn50}/${hits50.length} sao turbo (${pct(turboIn50, hits50.length)})`,
        ``,
        turboGroup("TURBO", turbo),
        ``,
        turboGroup("NAO-TURBO", nonTurbo)
    ].join("\n");
}

// ---------- 7) CONDICIONAL: ganho medio ENTRE OS QUE BATERAM 5%+ ----------
// A metrica de maxGainPct fica "com piso" em 0 ate cruzar 5% (ver
// BEST_GAIN_UPDATE >= 8% e TARGET_5_HIT no cci_egg_monitor.js). Isso mistura
// "taxa de acerto" com "magnitude de quem acerta" numa media so. Este
// relatorio separa as duas perguntas: dado que bateu 5%, o turbo corre mais
// longe que o nao-turbo, ou so acerta com mais frequencia?

function condicionalGroup(label, rows) {
    const total = rows.length;
    if (!total) return `${label}\nOvos: 0`;
    const winners = rows.filter(r => r.outcome.maxGainPct >= 5);
    if (!winners.length) {
        return `${label}\nOvos: ${total} | Bateram 5%+: 0 (0.0%)`;
    }
    const runsTo15 = winners.filter(r => r.outcome.maxGainPct >= 15).length;
    const runsTo50 = winners.filter(r => r.outcome.maxGainPct >= 50).length;
    const gains = winners.map(r => r.outcome.maxGainPct);
    return [
        `${label}`,
        `Ovos: ${total} | Bateram 5%+: ${winners.length} (${pct(winners.length, total)})`,
        `[Entre os que bateram 5%+] Ganho medio: ${num(avg(gains))}% | Ganho mediano: ${num(median(gains))}% | Maior: ${num(Math.max(...gains))}%`,
        `[Entre os que bateram 5%+] Continuou ate 15%: ${pct(runsTo15, winners.length)} | Continuou ate 50%: ${pct(runsTo50, winners.length)}`
    ].join("\n");
}

function reportCondicional(rows) {
    const tracked = rows.filter(isTracked);
    const turbo = tracked.filter(r => r.isTurbo);
    const nonTurbo = tracked.filter(r => !r.isTurbo);

    const lines = [
        `📊 ZEZIM RESEARCH — GANHO CONDICIONAL (separa taxa de acerto de magnitude)`,
        ``,
        `Restrito aos ovos rastreados. "[Entre os que bateram 5%+]" exclui os`,
        `travados no piso 0% — mostra quanto quem acerta realmente corre depois.`,
        ``,
        `═══ TURBO vs NAO-TURBO ═══`,
        ``,
        condicionalGroup("TURBO", turbo),
        ``,
        condicionalGroup("NAO-TURBO", nonTurbo)
    ];

    const buckets = [
        ["<0", (v) => v < 0],
        ["0-50", (v) => v >= 0 && v < 50],
        ["50-100", (v) => v >= 50 && v < 100],
        ["100-200", (v) => v >= 100 && v < 200],
        [">200", (v) => v >= 200]
    ];
    lines.push(``, `═══ POR FAIXA DE H4 ═══`);
    for (const [label, fn] of buckets) {
        const group = tracked.filter((r) => {
            const value = directionalValue(r.direction, r.cciH4);
            return Number.isFinite(value) && fn(value);
        });
        lines.push(``, condicionalGroup(`H4 ${label}`, group));
    }

    return lines.join("\n");
}

// ---------- Telegram (opcional, mesmo padrão do original) ----------

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
    const command = (args[0] || "distribuicao").toLowerCase();
    const daysArg = args.find(a => /^\d+$/.test(a));
    const days = daysArg ? parseInt(daysArg, 10) : 30;
    const minArg = args.find(a => /^min=\d+$/i.test(a));
    const minTarget = minArg ? parseInt(minArg.split("=")[1], 10) : 50;

    const rows = loadDataset(days);

    const reports = {
        distribuicao: () => reportDistribuicao(rows),
        cauda: () => reportCauda(rows),
        top: () => reportTop(rows, minTarget),
        split: () => reportSplit(rows, days),
        cobertura: () => reportCobertura(rows),
        turbo: () => reportTurbo(rows),
        condicional: () => reportCondicional(rows)
    };

    const text = reports[command]
        ? reports[command]()
        : `Comando desconhecido. Use: distribuicao, cauda, top, split`;

    console.log(text);
    if (args.includes("--telegram")) await sendTelegram(text);
}

main().catch((e) => {
    console.error("Erro no research_report_extra:", e.message);
    process.exitCode = 1;
});