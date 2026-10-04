// analyze_energy_correlation.js
//
// Roda direto no VPS, na pasta do bot (onde fica data/research_outcomes.json).
// Uso:
//   node analyze_energy_correlation.js
//   node analyze_energy_correlation.js /caminho/custom/research_outcomes.json
//
// Objetivo: testar a hipótese da "mola comprimida" (energia = quantas vezes
// o H1 rompeu e recarregou dentro do mesmo ciclo, com o H4 vivo) antes de
// promover esse contador a sinal ativo no alert_classifier.js.
//
// Agrupa outcomes por reloadedH1Count e mostra, por grupo:
//   - quantos ovos
//   - hit rate de cada alvo (5/8/15/50/100%)
//   - ganho médio / mediano / máximo
//   - tempo médio até bater 5% (se aplicável)

const fs = require("fs");
const path = require("path");

const outcomesFile = process.argv[2] || path.join(__dirname, "data", "research_outcomes.json");

function loadOutcomes(file) {
    if (!fs.existsSync(file)) {
        console.error(`❌ Arquivo não encontrado: ${file}`);
        console.error(`   Passe o caminho como argumento: node analyze_energy_correlation.js /caminho/research_outcomes.json`);
        process.exit(1);
    }
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw);
}

function median(arr) {
    if (!arr.length) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(arr) {
    if (!arr.length) return null;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function pct(n, total) {
    if (!total) return "0.0%";
    return ((n / total) * 100).toFixed(1) + "%";
}

function fmt(n, digits = 2) {
    return n == null ? "-" : Number(n).toFixed(digits);
}

function bucketLabel(count) {
    if (count === 0) return "0 (sem recarga)";
    if (count === 1) return "1 recarga";
    if (count === 2) return "2 recargas";
    return "3+ recargas (mola comprimida)";
}

function bucketKey(count) {
    if (count >= 3) return 3;
    return count;
}

function main() {
    const outcomesObj = loadOutcomes(outcomesFile);
    const outcomes = Object.values(outcomesObj);

    if (!outcomes.length) {
        console.log("⚠️ Nenhum outcome encontrado no arquivo.");
        return;
    }

    console.log(`📂 ${outcomes.length} outcomes carregados de ${outcomesFile}\n`);

    // Agrupar por bucket de reloadedH1Count
    const buckets = new Map();
    for (const o of outcomes) {
        const count = Number.isFinite(o.reloadedH1Count) ? o.reloadedH1Count : 0;
        const key = bucketKey(count);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(o);
    }

    const targets = [5, 8, 15, 50, 100];

    console.log("═".repeat(80));
    console.log("RESULTADO POR NÍVEL DE ENERGIA (reloadedH1Count)");
    console.log("═".repeat(80));

    const sortedKeys = Array.from(buckets.keys()).sort((a, b) => a - b);

    for (const key of sortedKeys) {
        const group = buckets.get(key);
        const total = group.length;
        const gains = group.map(o => o.maxGainPct).filter(g => Number.isFinite(g));
        const losses = group.map(o => o.maxLossPct).filter(g => Number.isFinite(g));

        console.log(`\n🔹 ${bucketLabel(key)}  —  ${total} ovos`);
        console.log("-".repeat(60));

        for (const t of targets) {
            const hitKey = `hit${t}`;
            const timeKey = `timeTo${t}h`;
            const hits = group.filter(o => o[hitKey]);
            const times = hits.map(o => o[timeKey]).filter(Number.isFinite);
            console.log(
                `  hit${String(t).padEnd(3)}: ${pct(hits.length, total).padStart(6)} ` +
                `(${hits.length}/${total})` +
                (times.length ? `  | tempo médio: ${fmt(mean(times))}h` : "")
            );
        }

        console.log(`  ganho médio:   ${fmt(mean(gains))}%`);
        console.log(`  ganho mediano: ${fmt(median(gains))}%`);
        console.log(`  ganho máximo:  ${fmt(Math.max(...gains, 0))}%`);
        console.log(`  perda média:   ${fmt(mean(losses))}%`);
    }

    console.log("\n" + "═".repeat(80));
    console.log("RESUMO COMPARATIVO (hit50 e hit100 por grupo)");
    console.log("═".repeat(80));
    console.log(
        `${"Grupo".padEnd(28)} ${"N".padEnd(6)} ${"hit50".padEnd(10)} ${"hit100".padEnd(10)} ${"ganho médio".padEnd(12)}`
    );
    for (const key of sortedKeys) {
        const group = buckets.get(key);
        const total = group.length;
        const hit50 = group.filter(o => o.hit50).length;
        const hit100 = group.filter(o => o.hit100).length;
        const gains = group.map(o => o.maxGainPct).filter(Number.isFinite);
        console.log(
            `${bucketLabel(key).padEnd(28)} ${String(total).padEnd(6)} ` +
            `${pct(hit50, total).padEnd(10)} ${pct(hit100, total).padEnd(10)} ` +
            `${fmt(mean(gains)).padEnd(12)}%`
        );
    }

    console.log("\n⚠️ Leitura: se hit50/hit100 sobem consistentemente com mais recargas,");
    console.log("   a hipótese da 'mola comprimida' tem sustentação nos seus próprios dados.");
    console.log("   Se os grupos ficarem parecidos (ou o grupo 3+ tiver poucos casos), ainda");
    console.log("   é cedo pra promover isso a sinal ativo — precisa de mais amostra.");
}

main();