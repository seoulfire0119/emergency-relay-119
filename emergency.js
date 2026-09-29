// 실시간 응급실 병상 현황 (index.html)
import { fetchBeds, fetchSevere } from './app/beds.js?v=5';
import { bedState, bedSortValue, resourceChips, updatedInfo, severeDetails } from './app/bedstatus.js?v=2';

const SEOUL = '서울특별시';

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

// 모듈 스크립트는 문서 해석이 끝난 뒤 실행되므로 바로 시작한다
sidoSelect.value = SEOUL;
kwonyeokSelect.style.display = 'inline-block';
fetchHospitalData(SEOUL);

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

async function fetchHospitalData(sido = '') {
    try {
        hospitalContainer.innerHTML = '<div class="loading">데이터를 불러오는 중입니다...</div>';
        const selectedKwonyeok = kwonyeokSelect.value;
        let beds;

        if (sido === SEOUL && selectedKwonyeok) {
            // 구별 조회를 한꺼번에 — 하나씩 기다리면 권역 하나에 몇 초씩 걸렸다
            const gus = kwonyeokMap[selectedKwonyeok] || [];
            const results = await Promise.all(gus.map((gu) => fetchBeds({ sido, gu, numOfRows: 100 })));
            beds = results.flat();
        } else {
            beds = await fetchBeds({ sido, numOfRows: 1000 });
        }
        // 중증질환 수용가능정보 — 실패해도 병상 표시는 그대로
        const severe = await fetchSevere({ sido });
        beds.forEach((b) => { b.severe = severe.get(b.id) || null; });

        renderHospitals(beds);

        const now = new Date();
        syncTimeDisplay.textContent = `마지막 업데이트: ${now.toLocaleTimeString('ko-KR')} (병원 수: ${beds.length}개)`;
    } catch (error) {
        console.error('Error:', error);
        hospitalContainer.innerHTML = '';
        const div = document.createElement('div');
        div.className = 'loading';
        div.style.color = 'red';
        div.textContent = `오류 발생: ${error.message}`;
        hospitalContainer.appendChild(div);
    }
}

const STATE_CLASS = { ok: 'status-green', low: 'status-yellow', full: 'status-red', over: 'status-over', unknown: 'status-gray' };

function renderHospitals(beds) {
    hospitalContainer.innerHTML = '';

    if (beds.length === 0) {
        hospitalContainer.innerHTML = '<div class="loading">검색된 병원이 없습니다.</div>';
        return;
    }

    [...beds].sort((a, b) => bedSortValue(b.hvec) - bedSortValue(a.hvec)).forEach((b) => {
        const st = bedState(b.hvec);

        const card = document.createElement('div');
        card.className = `hospital-card ${STATE_CLASS[st.key]}`;

        const name = document.createElement('span');
        name.className = 'hospital-name';
        name.textContent = b.name;

        const bedInfo = document.createElement('div');
        bedInfo.className = 'bed-info';

        const bedCount = document.createElement('div');
        bedCount.className = 'bed-count';
        bedCount.textContent = st.text;

        const statusBadge = document.createElement('span');
        statusBadge.className = 'status-badge';
        statusBadge.textContent = st.label;

        bedInfo.append(bedCount, statusBadge);
        card.append(name, bedInfo);

        const chips = resourceChips(b.res);
        if (chips.length) {
            const res = document.createElement('div');
            res.className = 'res-chips';
            chips.forEach((c) => {
                const chip = document.createElement('span');
                chip.className = `res-chip ${c.ok === true ? 'ok' : c.ok === false ? 'no' : ''}`;
                chip.textContent = `${c.label} ${c.text}`;
                res.appendChild(chip);
            });
            card.appendChild(res);
        }

        const sev = severeDetails(b.severe);
        if (sev) card.appendChild(sev);

        const upd = updatedInfo(b.hvidate);
        if (upd) {
            const u = document.createElement('div');
            u.className = `updated${upd.stale ? ' stale' : ''}`;
            u.textContent = upd.stale ? `⚠ ${upd.text} — 오래된 정보일 수 있음` : upd.text;
            card.appendChild(u);
        }

        const contactInfo = document.createElement('div');
        contactInfo.className = 'contact-info';
        contactInfo.append('응급실 ');
        if (b.tel) {
            const telLink = document.createElement('a');
            telLink.href = `tel:${b.tel}`;
            telLink.textContent = b.tel;
            contactInfo.appendChild(telLink);
        } else {
            contactInfo.append('전화번호 없음');
        }
        card.appendChild(contactInfo);

        hospitalContainer.appendChild(card);
    });
}
