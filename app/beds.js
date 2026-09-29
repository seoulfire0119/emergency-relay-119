// 실시간 응급실 병상 조회 (NEMC, Cloudflare Worker 프록시 경유)
// 병상 현황(emergency.js)·구급대원·병원 화면이 모두 이 모듈을 쓴다.
import { RESOURCE_FIELDS, SEVERE_ITEMS, severeValue } from './bedstatus.js?v=2';

const WORKER_BASE = 'https://emergency-bed-proxy.emergency-145fe.workers.dev';
const LOCAL_WORKER_BASE = 'http://localhost:8787';

const API_BASE = ['localhost', '127.0.0.1'].includes(window.location.hostname)
    ? LOCAL_WORKER_BASE
    : WORKER_BASE;

function buildUrl(path, { sido = '', gu = '', numOfRows = 1000 } = {}) {
    const params = new URLSearchParams();
    if (sido) params.set('sido', sido);
    if (gu) params.set('gu', gu);
    params.set('numOfRows', String(numOfRows));
    return `${API_BASE}${path}?${params.toString()}`;
}

async function fetchWithTimeout(url, timeoutMs = 20000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { signal: controller.signal, cache: 'no-store' });
    } finally {
        clearTimeout(id);
    }
}

async function fetchXmlItems(url) {
    const res = await fetchWithTimeout(url);
    const xmlText = await res.text();
    if (!res.ok) throw new Error(xmlText || `요청 실패 (${res.status})`);

    const xml = new DOMParser().parseFromString(xmlText, 'text/xml');
    if (xml.querySelector('parsererror')) throw new Error('응답 XML 해석 실패');

    const code = xml.getElementsByTagName('resultCode')[0]?.textContent;
    if (code && !['00', 'INFO-000'].includes(code)) {
        const msg = xml.getElementsByTagName('resultMsg')[0]?.textContent;
        throw new Error(msg ? `${msg} (${code})` : `공공데이터 오류 (${code})`);
    }
    return Array.from(xml.getElementsByTagName('item'));
}

const tag = (item, name) => item.getElementsByTagName(name)[0]?.textContent ?? '';

// 응급실 병상 목록
// → [{ id(hpid), name, tel, hvec(없으면 null), hvidate, res: { hvoc, hvicc, … } }]
export async function fetchBeds({ sido = '', gu = '', numOfRows = 1000 } = {}) {
    const items = await fetchXmlItems(buildUrl('/api/emergency-beds', { sido, gu, numOfRows }));
    return items.map((item) => {
        // 값이 없으면 0 이 아니라 null — 「만석」과 「확인불가」를 구분해야 한다
        const hvecRaw = tag(item, 'hvec').trim();
        const hvec = hvecRaw === '' ? null : parseInt(hvecRaw, 10);
        const res = {};
        for (const [field] of RESOURCE_FIELDS) res[field] = tag(item, field);
        return {
            id: tag(item, 'hpid'),
            name: tag(item, 'dutyName') || '이름 없음',
            tel: tag(item, 'dutyTel3'),
            hvec: Number.isNaN(hvec) ? null : hvec,
            hvidate: tag(item, 'hvidate'),
            res,
        };
    });
}

// 응급의료기관 목록(좌표·종별). Worker 의 /api/emergency-list 가 필요하다.
// 아직 배포 전이거나 실패하면 빈 Map — 거리·종별 표시만 빠지고 나머지는 그대로 동작한다.
// → Map<hpid, { lat, lon, emcls, addr }>
const infoCache = new Map();
export async function fetchHospitalInfo({ sido = '' } = {}) {
    if (infoCache.has(sido)) return infoCache.get(sido);
    const map = new Map();
    try {
        const items = await fetchXmlItems(buildUrl('/api/emergency-list', { sido, numOfRows: 1000 }));
        items.forEach((item) => {
            const id = tag(item, 'hpid');
            const lat = parseFloat(tag(item, 'wgs84Lat'));
            const lon = parseFloat(tag(item, 'wgs84Lon'));
            if (!id) return;
            map.set(id, {
                lat: Number.isFinite(lat) ? lat : null,
                lon: Number.isFinite(lon) ? lon : null,
                emcls: tag(item, 'dutyEmclsName'),
                addr: tag(item, 'dutyAddr'),
            });
        });
        infoCache.set(sido, map);
    } catch (e) {
        console.info('[beds] 병원 좌표·종별 정보 없음 (Worker 업데이트 필요할 수 있음):', e.message);
    }
    return map;
}

// 중증질환자 수용가능정보. 실패하면 빈 Map (표시·필터만 빠진다)
// → Map<hpid, { flags: { 1: true|false|null, … }, msgs: { 10: '9개월부터 가능', … } }>
const severeCache = new Map();
export async function fetchSevere({ sido = '' } = {}) {
    if (severeCache.has(sido)) return severeCache.get(sido);
    const map = new Map();
    try {
        const items = await fetchXmlItems(buildUrl('/api/emergency-severe', { sido, numOfRows: 1000 }));
        items.forEach((item) => {
            const id = tag(item, 'hpid');
            if (!id) return;
            const flags = {};
            const msgs = {};
            for (const [n] of SEVERE_ITEMS) {
                flags[n] = severeValue(tag(item, `MKioskTy${n}`));
                const m = tag(item, `MKioskTy${n}Msg`).trim();
                if (m && m !== '.') msgs[n] = m;
            }
            map.set(id, { flags, msgs });
        });
        severeCache.set(sido, map);
    } catch (e) {
        console.info('[beds] 중증질환 수용가능정보 없음:', e.message);
    }
    return map;
}
