// 실시간 응급실 병상 조회 (NEMC, Cloudflare Worker 프록시 경유)
// emergency.js와 동일한 엔드포인트를 모듈로 재사용합니다.
const WORKER_API_ENDPOINT = 'https://emergency-bed-proxy.emergency-145fe.workers.dev/api/emergency-beds';
const LOCAL_WORKER_API_ENDPOINT = 'http://localhost:8787/api/emergency-beds';

const API_ENDPOINT = ['localhost', '127.0.0.1'].includes(window.location.hostname)
    ? LOCAL_WORKER_API_ENDPOINT
    : WORKER_API_ENDPOINT;

function buildUrl({ sido = '', gu = '', numOfRows = 1000 } = {}) {
    const params = new URLSearchParams();
    if (sido) params.set('sido', sido);
    if (gu) params.set('gu', gu);
    params.set('numOfRows', String(numOfRows));
    return `${API_ENDPOINT}?${params.toString()}`;
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

// 응급실 병상 목록을 [{ name, hvec, tel }] 형태로 반환
export async function fetchBeds({ sido = '', gu = '', numOfRows = 1000 } = {}) {
    const res = await fetchWithTimeout(buildUrl({ sido, gu, numOfRows }));
    const xmlText = await res.text();
    if (!res.ok) throw new Error(xmlText || `병상 요청 실패 (${res.status})`);

    const xml = new DOMParser().parseFromString(xmlText, 'text/xml');
    if (xml.querySelector('parsererror')) throw new Error('병상 응답 XML 해석 실패');

    const code = xml.getElementsByTagName('resultCode')[0]?.textContent;
    if (code && !['00', 'INFO-000'].includes(code)) {
        const msg = xml.getElementsByTagName('resultMsg')[0]?.textContent;
        throw new Error(msg ? `${msg} (${code})` : `공공데이터 오류 (${code})`);
    }

    return Array.from(xml.getElementsByTagName('item')).map((item) => ({
        id: item.getElementsByTagName('hpid')[0]?.textContent || '',
        name: item.getElementsByTagName('dutyName')[0]?.textContent || '이름 없음',
        hvec: parseInt(item.getElementsByTagName('hvec')[0]?.textContent || '0', 10),
        tel: item.getElementsByTagName('dutyTel3')[0]?.textContent || '',
    }));
}

// 병원명 부분일치로 가용 응급실 병상 수를 찾음 (데모 병원 매칭용)
export function bedCountForHospital(beds, hospitalName) {
    const key = hospitalName.replace(/\s/g, '');
    const hit = beds.find((b) => b.name.replace(/\s/g, '').includes(key) || key.includes(b.name.replace(/\s/g, '')));
    return hit ? hit.hvec : null;
}
