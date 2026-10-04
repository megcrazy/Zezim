// analyze_energy_correlation_v2.js
//
// Uso:
//   node analyze_energy_correlation_v2.js
//   node analyze_energy_correlation_v2.js /caminho/custom/research_outcomes.json
//
// Objetivo: a v1 mostrou que "3+ recargas" tem ganho médio muito maior,
// mas isso pode ser só viés de sobrevivência (ovo que dura mais tempo tem
// mais chance cumulativa de bater alvo, independente de energia).
//
// Aqui cruzamos ENERGIA x IDADE DO OVO. Se, dentro do MESMO faixa de idade,
// o grupo de energia alta ainda bate mais alvo que o de energia baixa,
// a hipótese da mola comprimida sobrevive ao teste. Se as diferenças
// desaparecerem quando controlamos por idade, era só efeito de tempo.

const fs = require("fs");
const path = require("path");

const outcomesFile = process.argv[2] || path.join(__dirname, "data", "research_outcomes.json");

function loadOutcomes(file) {
    if (!fs.existsSync(file)) {
        console.error(`❌ Arquivo não encontrado: ${file}`);
        console.error(`   Passe o caminho como argumento: node analyze_energy_correlation_v2.js /caminho/research_outcomes.json`);
        process.exit(1);
    }
    return JSON.parse(fs.readFileSync(file, "utf8"));
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

function energyBucketKey(count) {
    const c = Number.isFinite(count) ? count : 0;
    if (c >= 3) return 3;
    return c;
}

function energyLabel(key) {
    if (key === 0) return "0 recargas";
    if (key === 1) return "1 recarga";
    if (key === 2) return "2 recargas";
    return "3+ recargas";
}

// Idade do ovo em horas: usa lastUpdatedAt como proxy do "tempo vivido até agora".
function ageHours(outcome) {
    const created = Number(outcome.createdAt);
    const updated = Number(outcome.lastUpdatedAt);
    if (!Number.isFinite(created) || !Number.isFinite(updated)) return null;
    return (updated - created) / (1000 * 60 * 60);
}

const AGE_BUCKETS = [
    { label: "0–12h", min: 0, max: 12 },
    { label: "12–24h", min: 12, max: 24 },
    { label: "24–48h", min: 24, max: 48 },
    { label: "48–96h", min: 48, max: 96 },
    { label: "96h+", min: 96, max: Infinity }
];

function ageBucketFor(hours) {
    return AGE_BUCKETS.find(b => hours >= b.min && hours < b.max) || null;
}

function main() {
    const outcomesObj = loadOutcomes(outcomesFile);
    const outcomes = Object.values(outcomesObj)
        .map(o => ({ ...o, __ageHours: ageHours(o) }))
        .filter(o => o.__ageHours != null);

    if (!outcomes.length) {
        console.log("⚠️ Nenhum outcome com idade calculável encontrado.");
        return;
    }

    console.log(`📂 ${outcomes.length} outcomes com idade calculada de ${outcomesFile}\n`);

    // Tabela cruzada: faixa de idade x grupo de energia
    console.log("═".repeat(90));
    console.log("CRUZAMENTO: IDADE DO OVO x ENERGIA (reloadedH1Count)");
    console.log("Dentro de cada faixa de idade, compare hit50/hit100 entre grupos de energia.");
    console.log("═".repeat(90));

    for (const ageBucket of AGE_BUCKETS) {
        const inAge = outcomes.filter(o => o.__ageHours >= ageBucket.min && o.__ageHours < ageBucket.max);
        if (!inAge.length) continue;

        console.log(`\n📅 Idade ${ageBucket.label}  —  ${inAge.length} ovos no total`);
        console.log("-".repeat(78));
        console.log(
            `  ${"Energia".padEnd(16)} ${"N".padEnd(6)} ${"hit50".padEnd(10)} ${"hit100".padEnd(10)} ${"ganho médio".padEnd(12)}`
        );

        const byEnergy = new Map();
        for (const o of inAge) {
            const key = energyBucketKey(o.reloadedH1Count);
            if (!byEnergy.has(key)) byEnergy.set(key, []);
            byEnergy.get(key).push(o);
        }

        const sortedKeys = Array.from(byEnergy.keys()).sort((a, b) => a - b);
        for (const key of sortedKeys) {
            const group = byEnergy.get(key);
            const total = group.length;
            const hit50 = group.filter(o => o.hit50).length;
            const hit100 = group.filter(o => o.hit100).length;
            const gains = group.map(o => o.maxGainPct).filter(Number.isFinite);
            console.log(
                `  ${energyLabel(key).padEnd(16)} ${String(total).padEnd(6)} ` +
                `${pct(hit50, total).padEnd(10)} ${pct(hit100, total).padEnd(10)} ` +
                `${fmt(mean(gains))}%`
            );
        }
    }

    // Idade média por grupo de energia (pra expor o viés de sobrevivência diretamente)
    console.log("\n" + "═".repeat(90));
    console.log("IDADE MÉDIA POR GRUPO DE ENERGIA (evidência direta do viés de sobrevivência)");
    console.log("═".repeat(90));

    const byEnergyGlobal = new Map();
    for (const o of outcomes) {
        const key = energyBucketKey(o.reloadedH1Count);
        if (!byEnergyGlobal.has(key)) byEnergyGlobal.set(key, []);
        byEnergyGlobal.get(key).push(o);
    }
    const sortedGlobalKeys = Array.from(byEnergyGlobal.keys()).sort((a, b) => a - b);
    for (const key of sortedGlobalKeys) {
        const group = byEnergyGlobal.get(key);
        const ages = group.map(o => o.__ageHours);
        console.log(`  ${energyLabel(key).padEnd(16)} N=${String(group.length).padEnd(6)} idade média: ${fmt(mean(ages))}h`);
    }

    console.log("\n⚠️ Como ler:");
    console.log("   1) Se a idade média sobe forte com a energia (ex: 0 recargas ~poucas horas,");
    console.log("      3+ recargas dezenas/centenas de horas), o viés de sobrevivência é real e");
    console.log("      explica boa parte do ganho médio maior visto na v1.");
    console.log("   2) O teste que importa é o cruzamento por faixa de idade: se, DENTRO da mesma");
    console.log("      faixa (ex: 48–96h), o grupo de energia alta ainda bate mais hit50/hit100 que");
    console.log("      o de energia baixa, a hipótese da mola comprimida sobrevive ao controle.");
    console.log("   3) Se dentro da mesma faixa os grupos ficarem parecidos, era só efeito de tempo.");
}

main();