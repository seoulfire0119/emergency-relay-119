// 소방청 구급현황(EMS incidents) 데이터 집계 스크립트
// bigdata-119.kr API를 페이지 단위로 호출해 "시도/시군구 × 증상 × 이송분류"로 요약합니다.
// 결과: ../app/ems-summary.json (구급대원 화면의 참고지표 패널에서 사용)
//
// 사용법 (PowerShell):
//   $env:EMS_API_KEY = '발급받은_키'
//   node tools/aggregate-ems.js --max-pages 50 --size 100
//
// 전체(1,430만 건)를 다 받으려면 --max-pages 를 크게 주거나 생략하세요(매우 오래 걸림).
// 데모용으로는 수십~수백 페이지 샘플이면 충분합니다.

const API_URL = 'https://www.bigdata-119.kr/fsdpApi/rest/v1/ems-incidents';
const API_KEY = process.env.EMS_API_KEY;

function arg(name, def) {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const SIZE = Math.min(parseInt(arg('size', '100'), 10), 100);
const MAX_PAGES = parseInt(arg('max-pages', '50'), 10);

if (!API_KEY) {
    console.error('환경변수 EMS_API_KEY 가 필요합니다. (PowerShell: $env:EMS_API_KEY = "키")');
    process.exit(1);
}

async function fetchPage(page) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000); // 페이지당 15초 타임아웃
    try {
        const res = await fetch(`${API_URL}?page=${page}&size=${SIZE}`, {
            method: 'POST',
            headers: { 'X-API-KEY': API_KEY },
            signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`page ${page}: HTTP ${res.status}`);
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

function emptyStat() {
    return { total: 0, 이송: 0, 미이송: 0, 연계이송: 0, 소방활동: 0, symptoms: {}, severeFlags: { 심정지: 0, 중증외상: 0, 심뇌혈관: 0 } };
}

function bump(map, key) {
    if (!map[key]) map[key] = emptyStat();
    return map[key];
}

async function main() {
    const bySgg = {};   // "시도|시군구" → stat
    const bySido = {};  // 시도 → stat
    let scanned = 0;
    let total = 0;
    let fails = 0;

    for (let page = 1; page <= MAX_PAGES; page++) {
        let data;
        try {
            data = await fetchPage(page);
            fails = 0;
        } catch (e) {
            fails++;
            console.warn(`page ${page} 실패(${e.message}) — 건너뜀`);
            if (fails >= 3) { console.warn('연속 3회 실패 — 중단하고 저장'); break; }
            continue;
        }
        total = data.total;
        const items = data.items || [];
        if (items.length === 0) break;

        for (const it of items) {
            scanned++;
            const sido = (it.ctpvNm || '미상').trim();
            const sgg = (it.sggNm || '미상').trim();
            const trans = (it.transClsfNm || '').trim();
            const sym = (it.ptnSymSeNm || '').trim();

            for (const stat of [bump(bySido, sido), bump(bySgg, `${sido}|${sgg}`)]) {
                stat.total++;
                if (trans && stat[trans] !== undefined) stat[trans]++;
                if (sym) stat.symptoms[sym] = (stat.symptoms[sym] || 0) + 1;
                if ((it.hrtarstNm || '').trim()) stat.severeFlags.심정지++;
                if ((it.srilOncrNm || '').trim()) stat.severeFlags.중증외상++;
                if ((it.crdvscCrvsscrSeNm || '').trim()) stat.severeFlags.심뇌혈관++;
            }
        }
        if (page % 10 === 0) console.log(`  ...page ${page}, 누적 ${scanned}건 집계`);
    }

    // 미이송률 등 파생 지표 계산
    const finalize = (map) => {
        for (const k of Object.keys(map)) {
            const s = map[k];
            s.미이송률 = s.total ? +(s.미이송 / s.total * 100).toFixed(1) : 0;
            // 상위 증상 5개만 보관
            s.topSymptoms = Object.entries(s.symptoms).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, n]) => ({ name, n }));
            delete s.symptoms;
        }
    };
    finalize(bySido);
    finalize(bySgg);

    const out = {
        generatedAt: new Date().toISOString(),
        source: '소방청 구급현황(bigdata-119.kr)',
        sampledRecords: scanned,
        totalRecordsInDataset: total,
        bySido,
        bySgg,
    };

    const fs = await import('node:fs');
    const path = await import('node:path');
    const outPath = path.join(import.meta.dirname, '..', 'app', 'ems-summary.json');
    fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf-8');
    console.log(`\n완료: ${scanned}건 집계 → ${outPath}`);
    console.log(`시도 ${Object.keys(bySido).length}곳, 시군구 ${Object.keys(bySgg).length}곳`);
}

main().catch((e) => { console.error(e); process.exit(1); });
