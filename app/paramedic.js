import { db, ensureSignedIn } from './firebase.js?v=3';
import { fetchBeds } from './beds.js?v=3';
import {
    collection,
    addDoc,
    doc,
    onSnapshot,
    serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const $ = (id) => document.getElementById(id);

let queue = [];   // 구급대원이 지정한 병원 순위 목록
let unsub = null;
let beds = [];    // 패널 표시용 병상 목록 (권역 필터 반영 가능)
let allBeds = []; // 선택 시도 전체 병상 목록 (병원 순위 지정용)

ensureSignedIn().catch((e) => console.error('로그인 실패', e));

// ---------- 실시간 병상 ----------
const SEOUL = '서울특별시';
// 서울 권역별 구 매핑 (응급의료 권역 구분)
const kwonyeokMap = {
    '1': ['종로구', '중구', '용산구', '은평구', '서대문구', '마포구'],
    '2': ['노원구', '동대문구', '중랑구', '성북구', '강북구', '도봉구'],
    '3': ['양천구', '강서구', '구로구', '금천구', '영등포구', '동작구', '관악구'],
    '4': ['서초구', '강남구', '송파구', '강동구', '성동구', '광진구'],
};

function syncKwonyeokVisibility() {
    const wrap = $('bed-kwonyeok-wrap');
    if (!wrap) return;
    wrap.style.display = $('bed-sido').value === SEOUL ? '' : 'none';
}

async function loadBeds() {
    const sido = $('bed-sido').value;
    const kwonyeok = $('bed-kwonyeok')?.value || '';
    const listEl = $('bed-list');
    listEl.innerHTML = '<div class="ref">병상 정보를 불러오는 중...</div>';
    $('hospital-list').innerHTML = '<div class="ref">실시간 병원 목록을 불러오는 중...</div>';
    try {
        // 병원 순위 지정용: 항상 선택한 시도 전체 병원
        allBeds = await fetchBeds({ sido, numOfRows: 1000 });
        // 패널 표시용: 서울 권역 선택 시 해당 구만, 그 외엔 시도 전체
        if (sido === SEOUL && kwonyeok) {
            const gus = kwonyeokMap[kwonyeok] || [];
            const results = await Promise.all(gus.map((gu) => fetchBeds({ sido, gu, numOfRows: 100 })));
            beds = results.flat();
        } else {
            beds = allBeds;
        }
        renderBedList();
        renderHospitalList();
    } catch (e) {
        beds = []; allBeds = [];
        renderHospitalList();
        listEl.innerHTML = `<div class="ref" style="color:var(--danger);">병상 정보를 불러올 수 없습니다: ${e.message}</div>`;
    }
}

function bedClass(n) { return n < 0 ? 'b-gray' : n === 0 ? 'b-red' : n < 5 ? 'b-yellow' : 'b-green'; }
function bedText(n) { return n < 0 ? '정보없음' : `${n}병상`; }

function renderBedList() {
    const listEl = $('bed-list');
    listEl.innerHTML = '';
    if (beds.length === 0) { listEl.innerHTML = '<div class="ref">표시할 병상 정보가 없습니다.</div>'; return; }
    beds.slice(0, 50).forEach((b) => {
        const row = document.createElement('div');
        row.className = `bed-row ${bedClass(b.hvec)}`;
        const name = document.createElement('div');
        name.className = 'bn';
        name.textContent = b.name;
        const cnt = document.createElement('div');
        cnt.className = 'bc';
        cnt.textContent = bedText(b.hvec);
        row.append(name, cnt);
        listEl.appendChild(row);
    });
}

$('bed-refresh').onclick = loadBeds;
$('bed-sido').onchange = () => { syncKwonyeokVisibility(); loadBeds(); };
$('bed-kwonyeok').onchange = loadBeds;

// ---------- 병원 선택 (선택한 시도의 실시간 병상 데이터 기반) ----------
function renderHospitalList() {
    const wrap = $('hospital-list');
    wrap.innerHTML = '';
    if (allBeds.length === 0) {
        wrap.innerHTML = '<div class="ref">선택한 지역에 표시할 병원이 없습니다. (지역을 바꾸거나 새로고침)</div>';
        return;
    }
    const remaining = allBeds
        .filter((b) => !queue.some((q) => q.id === b.id))
        .sort((a, b) => b.hvec - a.hvec); // 가용 병상 많은 순
    if (remaining.length === 0) {
        wrap.innerHTML = '<div class="ref">모든 병원이 순위에 추가되었습니다.</div>';
        return;
    }
    remaining.forEach((b) => {
        const div = document.createElement('div');
        div.className = 'hospital-pick';
        const info = document.createElement('div');
        const name = document.createElement('div');
        name.style.fontWeight = '600';
        name.textContent = b.name;
        const meta = document.createElement('small');
        const bedTxt = b.hvec < 0 ? '실시간 응급실 가용: 정보없음' : `실시간 응급실 가용 ${b.hvec}병상`;
        meta.textContent = `🛏 ${bedTxt}` + (b.tel ? ` · ☎ ${b.tel}` : '');
        info.append(name, meta);
        const btn = document.createElement('button');
        btn.className = 'small';
        btn.textContent = '+ 추가';
        btn.onclick = () => { queue.push(b); render(); };
        div.append(info, btn);
        wrap.appendChild(div);
    });
}

function renderQueue() {
    const wrap = $('queue-list');
    wrap.innerHTML = '';
    if (queue.length === 0) {
        wrap.innerHTML = '<div class="ref">아직 선택된 병원이 없습니다.</div>';
        return;
    }
    queue.forEach((h, i) => {
        const div = document.createElement('div');
        div.className = 'queue-item';
        const badge = document.createElement('div');
        badge.className = 'rank-badge';
        badge.textContent = i + 1;
        const name = document.createElement('div');
        name.className = 'qname';
        name.textContent = h.name;
        const up = mkBtn('▲', () => { if (i > 0) { [queue[i-1], queue[i]] = [queue[i], queue[i-1]]; render(); } });
        const down = mkBtn('▼', () => { if (i < queue.length-1) { [queue[i+1], queue[i]] = [queue[i], queue[i+1]]; render(); } });
        const del = mkBtn('✕', () => { queue.splice(i, 1); render(); });
        div.append(badge, name, up, down, del);
        wrap.appendChild(div);
    });
}

function mkBtn(label, onClick) {
    const b = document.createElement('button');
    b.className = 'small ghost';
    b.textContent = label;
    b.onclick = onClick;
    return b;
}

function render() {
    renderHospitalList();
    renderQueue();
    $('send-btn').disabled = queue.length === 0;
}

// ---------- 요청 전송 ----------
$('send-btn').onclick = async () => {
    $('send-btn').disabled = true;
    const patient = {
        symptom: $('symptom').value,
        ktas: $('ktas').value,
        age: $('age').value || '미상',
        gender: $('gender').value,
        consciousness: $('consciousness').value,
        vitals: {
            bp: $('v-bp').value.trim(),
            pulse: $('v-pulse').value,
            spo2: $('v-spo2').value,
            temp: $('v-temp').value,
            glucose: $('v-glucose').value,
        },
        memo: $('memo').value.trim(),
    };
    const hospitalQueue = queue.map((h, i) => ({ rank: i + 1, hospitalId: h.id, name: h.name }));

    try {
        const ref = await addDoc(collection(db, 'requests'), {
            patient,
            hospitalQueue,
            currentRank: 0,
            status: 'pending',
            acceptedHospitalId: null,
            responses: [],
            createdAt: serverTimestamp(),
        });
        subscribe(ref.id);
        lockCompose();
    } catch (e) {
        console.error('요청 전송 실패', e);
        alert('요청 전송에 실패했습니다: ' + e.message);
        $('send-btn').disabled = false;
    }
};

function lockCompose() {
    $('compose-col').querySelectorAll('input, select, textarea, button').forEach((el) => { el.disabled = true; });
}

// ---------- 실시간 추적 ----------
function subscribe(requestId) {
    if (unsub) unsub();
    $('track-empty').classList.add('hidden');
    unsub = onSnapshot(doc(db, 'requests', requestId), (snap) => {
        if (snap.exists()) renderTracking(snap.data());
    });
}

function renderTracking(data) {
    // 결과 배너
    const resultArea = $('result-area');
    resultArea.innerHTML = '';
    if (data.status === 'accepted') {
        const h = data.hospitalQueue.find((q) => q.hospitalId === data.acceptedHospitalId);
        resultArea.innerHTML = `<div class="result-banner accepted">✅ ${h ? h.name : '병원'} 수용 확정</div>`;
    } else if (data.status === 'exhausted') {
        resultArea.innerHTML = `<div class="result-banner exhausted">⚠️ 모든 병원이 수용 불가 — 추가 병원 지정이 필요합니다</div>`;
    }

    // 병원별 카드
    const list = $('track-list');
    list.innerHTML = '';
    const byHospital = {};
    (data.responses || []).forEach((r) => { byHospital[r.hospitalId] = r; });

    data.hospitalQueue.forEach((q, i) => {
        const resp = byHospital[q.hospitalId];
        let state = 'pending', badgeText = '대기';
        if (resp && resp.decision === 'accept') { state = 'accepted'; badgeText = '수용'; }
        else if (resp && resp.decision === 'reject') { state = 'rejected'; badgeText = '거절'; }
        else if (data.status === 'pending' && i === data.currentRank) { state = 'asking'; badgeText = '요청중'; }

        const div = document.createElement('div');
        div.className = `track-item ${state}`;
        const head = document.createElement('div');
        head.className = 'track-head';
        head.innerHTML = `<b>${i + 1}순위 · ${q.name}</b><span class="badge ${state}">${badgeText}</span>`;
        div.appendChild(head);
        if (resp && resp.decision === 'reject') {
            const reason = document.createElement('div');
            reason.className = 'reason';
            reason.textContent = `거절 사유: ${resp.reason || '사유 미기재'}`;
            div.appendChild(reason);
        }
        list.appendChild(div);
    });
}

render();
syncKwonyeokVisibility();
loadBeds();
