const WORKER_API_ENDPOINT = 'https://emergency-bed-proxy.emergency-145fe.workers.dev/api/emergency-beds';
const LOCAL_WORKER_API_ENDPOINT = 'http://localhost:8787/api/emergency-beds';
const SEOUL = '서울특별시';

const API_ENDPOINT = ['localhost', '127.0.0.1'].includes(window.location.hostname)
    ? LOCAL_WORKER_API_ENDPOINT
    : WORKER_API_ENDPOINT;

const hospitalContainer = document.getElementById('hospital-container');
const sidoSelect = document.getElementById('sido-select');
const kwonyeokSelect = document.getElementById('kwonyeok-select');
const refreshBtn = document.getElementById('refresh-btn');
const syncTimeDisplay = document.getElementById('sync-time');

// 서울 권역별 구 매핑
const kwonyeokMap = {
    "1": ['종로구', '중구', '용산구', '은평구', '서대문구', '마포구'],
    "2": ['노원구', '동대문구', '중랑구', '성북구', '강북구', '도봉구'],
    "3": ['양천구', '강서구', '구로구', '금천구', '영등포구', '동작구', '관악구'],
    "4": ['서초구', '강남구', '송파구', '강동구', '성동구', '광진구']
};

window.addEventListener('DOMContentLoaded', () => {
    sidoSelect.value = SEOUL;
    kwonyeokSelect.style.display = 'inline-block';
    fetchHospitalData(SEOUL);
});

sidoSelect.addEventListener('change', (e) => {
    const isSeoul = e.target.value === SEOUL;
    kwonyeokSelect.style.display = isSeoul ? 'inline-block' : 'none';
    if (!isSeoul) kwonyeokSelect.value = '';
    fetchHospitalData(e.target.value);
});

kwonyeokSelect.addEventListener('change', () => {
    fetchHospitalData(sidoSelect.value);
});

refreshBtn.addEventListener('click', () => {
    fetchHospitalData(sidoSelect.value);
});

function assertWorkerEndpointConfigured() {
    if (API_ENDPOINT.includes('YOUR_WORKERS_SUBDOMAIN')) {
        throw new Error('Cloudflare Worker 배포 후 emergency.js의 WORKER_API_ENDPOINT를 실제 workers.dev 주소로 바꿔주세요.');
    }
}

function buildEmergencyBedsUrl({ sido = '', gu = '', numOfRows = 1000 } = {}) {
    const params = new URLSearchParams();
    if (sido) params.set('sido', sido);
    if (gu) params.set('gu', gu);
    params.set('numOfRows', String(numOfRows));

    return `${API_ENDPOINT}?${params.toString()}`;
}

async function fetchWithTimeout(url, timeoutMs = 20000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        return await fetch(url, {
            signal: controller.signal,
            cache: 'no-store'
        });
    } finally {
        clearTimeout(timeoutId);
    }
}

async function fetchItems({ sido = '', gu = '', numOfRows = 1000 } = {}) {
    assertWorkerEndpointConfigured();

    const response = await fetchWithTimeout(buildEmergencyBedsUrl({ sido, gu, numOfRows }));
    const xmlText = await response.text();

    if (!response.ok) {
        throw new Error(xmlText || `데이터 요청 실패 (${response.status})`);
    }

    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlText, 'text/xml');

    if (xmlDoc.querySelector('parsererror')) {
        throw new Error('공공데이터 응답 XML을 해석할 수 없습니다.');
    }

    const resultCode = xmlDoc.getElementsByTagName('resultCode')[0]?.textContent;
    const resultMsg = xmlDoc.getElementsByTagName('resultMsg')[0]?.textContent;

    if (resultCode && !['00', 'INFO-000'].includes(resultCode)) {
        throw new Error(resultMsg ? `${resultMsg} (${resultCode})` : `공공데이터 오류 (${resultCode})`);
    }

    return Array.from(xmlDoc.getElementsByTagName('item'));
}

async function fetchByGu(sido, gu) {
    return fetchItems({ sido, gu, numOfRows: 100 });
}

async function fetchHospitalData(sido = '') {
    try {
        hospitalContainer.innerHTML = '<div class="loading">데이터를 불러오는 중입니다...</div>';
        const selectedKwonyeok = kwonyeokSelect.value;
        let allItems = [];

        if (sido === SEOUL && selectedKwonyeok) {
            const gus = kwonyeokMap[selectedKwonyeok] || [];

            for (const gu of gus) {
                const items = await fetchByGu(sido, gu);
                allItems = allItems.concat(items);
            }
        } else {
            allItems = await fetchItems({ sido, numOfRows: 1000 });
        }

        renderHospitals(allItems);

        const now = new Date();
        syncTimeDisplay.textContent = `마지막 업데이트: ${now.toLocaleTimeString('ko-KR')} (병원 수: ${allItems.length}개)`;
    } catch (error) {
        console.error('Error:', error);
        hospitalContainer.innerHTML = `<div class="loading" style="color: red;">오류 발생: ${error.message}</div>`;
    }
}

function renderHospitals(items) {
    hospitalContainer.innerHTML = '';

    if (items.length === 0) {
        hospitalContainer.innerHTML = '<div class="loading">검색된 병원이 없습니다.</div>';
        return;
    }

    items.forEach(item => {
        const dutyName = item.getElementsByTagName('dutyName')[0]?.textContent || '이름 없음';
        const hvec = parseInt(item.getElementsByTagName('hvec')[0]?.textContent || '0', 10);
        const dutyTel3 = item.getElementsByTagName('dutyTel3')[0]?.textContent || '';

        let statusClass = 'status-green';
        let statusText = '여유';

        if (hvec <= 0) {
            statusClass = 'status-red';
            statusText = '만석/확인불가';
        } else if (hvec < 5) {
            statusClass = 'status-yellow';
            statusText = '주의';
        }

        const card = document.createElement('div');
        card.className = `hospital-card ${statusClass}`;

        const name = document.createElement('span');
        name.className = 'hospital-name';
        name.textContent = dutyName;

        const bedInfo = document.createElement('div');
        bedInfo.className = 'bed-info';

        const bedCount = document.createElement('div');
        bedCount.className = 'bed-count';
        bedCount.append(String(hvec), ' ');

        const bedLabel = document.createElement('small');
        bedLabel.style.fontSize = '0.9rem';
        bedLabel.style.fontWeight = 'normal';
        bedLabel.textContent = '병상';
        bedCount.appendChild(bedLabel);

        const statusBadge = document.createElement('span');
        statusBadge.className = 'status-badge';
        statusBadge.textContent = statusText;

        bedInfo.append(bedCount, statusBadge);

        const contactInfo = document.createElement('div');
        contactInfo.className = 'contact-info';
        contactInfo.append('응급실 ');

        if (dutyTel3) {
            const telLink = document.createElement('a');
            telLink.href = `tel:${dutyTel3}`;
            telLink.textContent = dutyTel3;
            contactInfo.appendChild(telLink);
        } else {
            contactInfo.append('전화번호 없음');
        }

        card.append(name, bedInfo, contactInfo);
        hospitalContainer.appendChild(card);
    });
}
