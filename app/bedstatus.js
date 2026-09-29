// 응급실 병상 정보 해석 — 병상 현황·구급대원·병원 세 화면이 같은 기준을 쓴다.
//
// hvec(응급실 가용병상) = 응급실 기준병상 − 재실환자.
// 음수면 병상보다 환자가 많은 과밀 상태다(복도·대기공간 환자까지 재실로 집계).
// 값이 아예 없으면 병원이 입력하지 않은 것이라 「확인불가」로 따로 본다.

export function bedState(hvec) {
    if (hvec === null || hvec === undefined || Number.isNaN(hvec)) {
        return { key: 'unknown', label: '확인불가', text: '–' };
    }
    if (hvec < 0) return { key: 'over', label: '과밀', text: `만석 +${-hvec}명 초과` };
    if (hvec === 0) return { key: 'full', label: '만석', text: '0병상' };
    if (hvec < 5) return { key: 'low', label: '주의', text: `${hvec}병상` };
    return { key: 'ok', label: '여유', text: `${hvec}병상` };
}

// 정렬용 — 확인불가는 맨 뒤로
export function bedSortValue(hvec) {
    return hvec === null || hvec === undefined || Number.isNaN(hvec) ? -Infinity : hvec;
}

// 병상 API 응답에 이미 들어 있는 추가 자원. count=남은 수, yn=가용 여부(Y/N…)
export const RESOURCE_FIELDS = [
    ['hvoc', '수술실', 'count'],
    ['hvicc', '일반중환자실', 'count'],
    ['hvncc', '신생아중환자실', 'count'],
    ['hvgc', '입원실', 'count'],
    ['hvctayn', 'CT', 'yn'],
    ['hvmriayn', 'MRI', 'yn'],
    ['hvangioayn', '혈관조영', 'yn'],
    ['hvventiayn', '인공호흡기', 'yn'],
];

// 값이 있는 자원만 [{ label, text, ok }] 로. ok: true=가능, false=불가, null=알 수 없음
export function resourceChips(res = {}) {
    const chips = [];
    for (const [field, label, kind] of RESOURCE_FIELDS) {
        const raw = res[field];
        if (raw === undefined || raw === null || String(raw).trim() === '') continue;
        const v = String(raw).trim();
        if (kind === 'yn') {
            const ok = v.startsWith('Y') ? true : v.startsWith('N') ? false : null;
            chips.push({ label, text: ok === true ? '가능' : ok === false ? '불가' : v, ok });
        } else {
            const n = parseInt(v, 10);
            if (Number.isNaN(n)) continue;
            chips.push({ label, text: String(n), ok: n > 0 });
        }
    }
    return chips;
}

// hvidate(YYYYMMDDHHmmss, 한국시간) → { text: '14:25 갱신 · 3분 전', stale }
// 병원이 한참 입력하지 않은 숫자일 수 있어 1시간이 넘으면 stale 로 표시한다.
export function updatedInfo(hvidate) {
    const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?$/.exec(String(hvidate || '').trim());
    if (!m) return null;
    const [, y, mo, d, h, mi, s = '00'] = m;
    const at = Date.UTC(+y, +mo - 1, +d, +h - 9, +mi, +s);
    const mins = Math.max(0, Math.round((Date.now() - at) / 60000));
    const ago = mins < 1 ? '방금' : mins < 60 ? `${mins}분 전` : mins < 1440 ? `${Math.floor(mins / 60)}시간 전` : `${Math.floor(mins / 1440)}일 전`;
    return { text: `${h}:${mi} 갱신 · ${ago}`, stale: mins > 60, at };
}

// 두 좌표 사이 직선거리(km)
export function distanceKm(a, b) {
    if (!a || !b || a.lat == null || b.lat == null) return null;
    const R = 6371;
    const toRad = (x) => (x * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
}

// 직선거리로 어림한 도착 예상(분). 도로 우회를 감안해 1.3배, 긴급주행 평균 40km/h 로 잡는다.
export function etaMinutes(km) {
    if (km == null) return null;
    return Math.max(1, Math.round(((km * 1.3) / 40) * 60));
}

export function distanceText(km) {
    if (km == null) return '';
    const eta = etaMinutes(km);
    return `${km < 10 ? km.toFixed(1) : Math.round(km)}km · 약 ${eta}분`;
}
