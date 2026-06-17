import { db, ensureSignedIn } from './firebase.js?v=3';
import { fetchBeds } from './beds.js?v=3';
import {
    collection,
    query,
    where,
    orderBy,
    limit,
    onSnapshot,
    doc,
    updateDoc,
    arrayUnion,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const $ = (id) => document.getElementById(id);

const SIDO_LIST = [
    '서울특별시', '부산광역시', '대구광역시', '인천광역시', '광주광역시', '대전광역시',
    '울산광역시', '세종특별자치시', '경기도', '강원도', '충청북도', '충청남도',
    '전라북도', '전라남도', '경상북도', '경상남도', '제주특별자치도',
];

let mySido = localStorage.getItem('myHospitalSido') || '서울특별시';
let myHospitalId = localStorage.getItem('myHospitalId') || '';
let myHospitalName = localStorage.getItem('myHospitalName') || '';
let hospitalsInSido = []; // 현재 시도의 실시간 병원 목록 (NEMC)
let unsub = null;
let unsubHistory = null;
const seen = new Set(); // 알람 1회만 울리도록 추적

const KTAS = {
    '1': { label: 'KTAS 1 · 소생', color: '#e63946', dark: false },
    '2': { label: 'KTAS 2 · 긴급', color: '#f3722c', dark: false },
    '3': { label: 'KTAS 3 · 응급', color: '#f9c74f', dark: true },
    '4': { label: 'KTAS 4 · 준응급', color: '#43aa8b', dark: false },
    '5': { label: 'KTAS 5 · 비응급', color: '#577590', dark: false },
};
function ktasInfo(v) { return KTAS[v] || { label: v ? `KTAS ${v}` : '-', color: '#999', dark: false }; }

ensureSignedIn().catch((e) => console.error('로그인 실패', e));

// ---------- 지역(시도) 선택 ----------
function initSidoSelect() {
    const sel = $('hospital-sido');
    SIDO_LIST.forEach((s) => {
        const o = document.createElement('option');
        o.value = s; o.textContent = s;
        sel.appendChild(o);
    });
    sel.value = mySido;
    sel.onchange = async () => {
        mySido = sel.value;
        localStorage.setItem('myHospitalSido', mySido);
        await loadHospitals();
    };
}

// ---------- 병원 선택 (선택 시도의 실시간 병상 데이터 기반) ----------
async function loadHospitals() {
    const sel = $('hospital-select');
    sel.innerHTML = '<option>불러오는 중...</option>';
    $('status').textContent = '병원 목록을 불러오는 중...';
    try {
        hospitalsInSido = await fetchBeds({ sido: mySido, numOfRows: 1000 });
    } catch (e) {
        hospitalsInSido = [];
        $('status').textContent = '병원 목록 로드 실패: ' + e.message;
    }

    sel.innerHTML = '';
    if (hospitalsInSido.length === 0) {
        const o = document.createElement('option');
        o.value = ''; o.textContent = '(표시할 병원 없음)';
        sel.appendChild(o);
        $('me-name').textContent = '';
        if (unsub) unsub();
        if (unsubHistory) unsubHistory();
        render([]);
        renderHistory([]);
        return;
    }

    hospitalsInSido.forEach((h) => {
        const o = document.createElement('option');
        o.value = h.id;
        const avail = h.hvec < 0 ? '정보없음' : `${h.hvec}병상`;
        o.textContent = `${h.name} (응급실 가용 ${avail})`;
        sel.appendChild(o);
    });

    // 기존 선택 복원, 없으면 첫 병원
    const chosen = hospitalsInSido.find((h) => h.id === myHospitalId) || hospitalsInSido[0];
    myHospitalId = chosen.id;
    myHospitalName = chosen.name;
    persistMe();
    sel.value = myHospitalId;
    $('me-name').textContent = myHospitalName;

    sel.onchange = () => {
        const h = hospitalsInSido.find((x) => x.id === sel.value);
        if (!h) return;
        myHospitalId = h.id;
        myHospitalName = h.name;
        persistMe();
        $('me-name').textContent = myHospitalName;
        seen.clear();
        listen();
        listenHistory();
    };

    seen.clear();
    listen();
    listenHistory();
}

function persistMe() {
    localStorage.setItem('myHospitalId', myHospitalId);
    localStorage.setItem('myHospitalName', myHospitalName);
}

// ---------- 수신 대기 ----------
function listen() {
    if (unsub) unsub();
    if (!myHospitalId) { render([]); return; }
    const q = query(collection(db, 'requests'), where('status', '==', 'pending'));
    unsub = onSnapshot(q, (snap) => {
        const forMe = [];
        snap.forEach((d) => {
            const data = d.data();
            const target = data.hospitalQueue?.[data.currentRank];
            if (target && target.hospitalId === myHospitalId) {
                forMe.push({ id: d.id, ...data });
            }
        });
        render(forMe);
    }, (err) => {
        console.error('수신 오류', err);
        $('status').textContent = '수신 오류: ' + err.message;
    });
}

// ---------- 이력 (우리 병원이 응답한 요청: 수용/거절) ----------
function listenHistory() {
    if (unsubHistory) unsubHistory();
    if (!myHospitalId) { renderHistory([]); return; }
    const q = query(collection(db, 'requests'), orderBy('createdAt', 'desc'), limit(100));
    unsubHistory = onSnapshot(q, (snap) => {
        const mine = [];
        snap.forEach((d) => {
            const data = d.data();
            const myResp = (data.responses || []).find((r) => r.hospitalId === myHospitalId);
            if (myResp) mine.push({ id: d.id, myResp, ...data });
        });
        // 내 응답 시각 최신순
        mine.sort((a, b) => (b.myResp.at || 0) - (a.myResp.at || 0));
        renderHistory(mine);
    }, (err) => {
        console.error('이력 수신 오류', err);
        const el = $('history');
        if (el) el.innerHTML = `<div class="ref" style="color:var(--danger);">이력을 불러올 수 없습니다: ${err.message}</div>`;
    });
}

function fmtTime(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    return d.toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function outcomeText(data) {
    if (data.status === 'accepted') {
        if (data.acceptedHospitalId === myHospitalId) return { txt: '✅ 우리 병원 수용 확정', cls: 'accepted' };
        const name = data.hospitalQueue.find((h) => h.hospitalId === data.acceptedHospitalId)?.name || '타 병원';
        return { txt: `최종: ${name} 수용`, cls: 'other' };
    }
    if (data.status === 'exhausted') return { txt: '⚠️ 전 병원 수용불가로 종료', cls: 'exhausted' };
    return { txt: '진행 중', cls: 'pending' };
}

function renderHistory(list) {
    const wrap = $('history');
    if (!wrap) return;
    $('history-count').textContent = `${list.length}건`;
    if (list.length === 0) {
        wrap.innerHTML = '<div class="ref">아직 우리 병원이 응답한 요청이 없습니다.</div>';
        return;
    }
    wrap.innerHTML = '';
    list.forEach((data) => {
        const p = data.patient || {};
        const k = ktasInfo(p.ktas);
        const r = data.myResp;
        const accepted = r.decision === 'accept';
        const myRank = (data.hospitalQueue.findIndex((h) => h.hospitalId === myHospitalId)) + 1;
        const out = outcomeText(data);

        const div = document.createElement('div');
        div.className = 'hist-item ' + (accepted ? 'h-accept' : 'h-reject');

        const head = document.createElement('div');
        head.className = 'hist-head';
        head.innerHTML = `<span class="hist-sym">${p.symptom || '-'}</span>`
            + `<span class="ktas-chip" style="background:${k.color};${k.dark ? 'color:#333;' : ''}">${k.label}</span>`
            + `<span class="dec ${accepted ? 'dec-accept' : 'dec-reject'}">${accepted ? '수용' : '거절'}</span>`;
        div.appendChild(head);

        const meta = document.createElement('div');
        meta.className = 'hist-meta';
        meta.textContent = `${myRank}순위 · ${p.gender || '-'}/${p.age || '-'}세 · ${fmtTime(r.at)}`;
        div.appendChild(meta);

        if (!accepted && r.reason) {
            const reason = document.createElement('div');
            reason.className = 'hist-reason';
            reason.textContent = `거절 사유: ${r.reason}`;
            div.appendChild(reason);
        }

        const outcome = document.createElement('div');
        outcome.className = `hist-outcome o-${out.cls}`;
        outcome.textContent = out.txt;
        div.appendChild(outcome);

        wrap.appendChild(div);
    });
}

// ---------- 렌더 ----------
function render(reqs) {
    const wrap = $('requests');
    $('status').textContent = `대기 중인 요청 ${reqs.length}건`;
    if (reqs.length === 0) {
        wrap.innerHTML = '<div class="empty">현재 우리 병원으로 들어온 수용요청이 없습니다.<br>구급대원이 요청을 보내면 여기에 알람과 함께 표시됩니다.</div>';
        return;
    }
    wrap.innerHTML = '';
    reqs.forEach((req) => {
        const isNew = !seen.has(req.id);
        if (isNew) { seen.add(req.id); beep(); }
        wrap.appendChild(card(req, isNew));
    });
}

function card(req, isNew) {
    const p = req.patient || {};
    const div = document.createElement('div');
    div.className = 'req-card' + (isNew ? ' alarm' : '');

    const myRank = (req.hospitalQueue.findIndex((h) => h.hospitalId === myHospitalId)) + 1;

    // 상단: 증상 + KTAS
    const k = ktasInfo(p.ktas);
    const top = document.createElement('div');
    top.className = 'req-top';
    const h3 = document.createElement('h3');
    h3.style.margin = '0';
    h3.textContent = p.symptom || '-';
    const kbadge = document.createElement('span');
    kbadge.className = 'sev';
    kbadge.style.background = k.color;
    if (k.dark) kbadge.style.color = '#333';
    kbadge.textContent = k.label;
    top.append(h3, kbadge);
    div.appendChild(top);

    // 순위 안내
    const note = document.createElement('div');
    note.className = 'rank-note';
    note.textContent = `우리 병원은 이 요청의 ${myRank}순위입니다.`;
    div.appendChild(note);

    // 환자 정보
    const info = document.createElement('div');
    info.className = 'pinfo';
    info.innerHTML = `
        <div><div class="k">연령</div>${p.age || '-'}</div>
        <div><div class="k">성별</div>${p.gender || '-'}</div>
        <div><div class="k">의식수준</div>${p.consciousness || '-'}</div>
        <div><div class="k">KTAS</div>${k.label}</div>`;
    div.appendChild(info);

    // 바이탈 사인
    const v = p.vitals || {};
    const vitalDefs = [
        ['혈압', v.bp, ''], ['맥박', v.pulse, '회/분'], ['SpO₂', v.spo2, '%'],
        ['체온', v.temp, '℃'], ['혈당', v.glucose, 'mg/dL'],
    ].filter(([, val]) => val !== undefined && val !== null && String(val).trim() !== '');
    if (vitalDefs.length > 0) {
        const vit = document.createElement('div');
        vit.className = 'vitals-view';
        vitalDefs.forEach(([label, val, unit]) => {
            const cell = document.createElement('div');
            cell.innerHTML = `<div class="k">${label}</div>${val}${unit ? ' ' + unit : ''}`;
            vit.appendChild(cell);
        });
        div.appendChild(vit);
    }

    if (p.memo) {
        const memo = document.createElement('div');
        memo.className = 'memo';
        memo.textContent = '📝 ' + p.memo;
        div.appendChild(memo);
    }

    // 앞순위 병원들의 거절 사유
    const priorRejects = (req.responses || []).filter((r) => r.decision === 'reject');
    if (priorRejects.length > 0) {
        const prior = document.createElement('div');
        prior.className = 'prior';
        prior.innerHTML = '<h4>⚠️ 앞순위 병원 수용불가 사유</h4>';
        priorRejects.forEach((r) => {
            const name = req.hospitalQueue.find((h) => h.hospitalId === r.hospitalId)?.name || r.hospitalId;
            const line = document.createElement('div');
            line.textContent = `· ${name}: ${r.reason || '사유 미기재'}`;
            prior.appendChild(line);
        });
        div.appendChild(prior);
    }

    // 액션 버튼
    const actions = document.createElement('div');
    actions.className = 'actions';
    const acceptBtn = document.createElement('button');
    acceptBtn.className = 'accept';
    acceptBtn.textContent = '✅ 수용 가능';
    acceptBtn.onclick = () => accept(req);
    const rejectBtn = document.createElement('button');
    rejectBtn.className = 'reject';
    rejectBtn.textContent = '✕ 수용 불가';
    const form = document.createElement('div');
    form.className = 'reject-form';
    rejectBtn.onclick = () => form.classList.toggle('open');
    actions.append(acceptBtn, rejectBtn);
    div.appendChild(actions);

    // 거절 사유 입력 폼
    const quickReasons = ['흉부외과 담당의 공백', '중환자실 만실', '응급실 과밀', '수술실 가동 불가', '해당 진료과 부재'];
    const quick = document.createElement('div');
    quick.className = 'quick';
    const input = document.createElement('input');
    input.placeholder = '수용불가 사유를 입력하세요';
    quickReasons.forEach((r) => {
        const b = document.createElement('button');
        b.textContent = r;
        b.onclick = () => { input.value = r; };
        quick.appendChild(b);
    });
    const submit = document.createElement('button');
    submit.className = 'reject';
    submit.textContent = '거절 사유 제출 → 다음 순위로';
    submit.style.width = '100%';
    submit.onclick = () => {
        const reason = input.value.trim();
        if (!reason) { input.focus(); return; }
        reject(req, reason);
    };
    form.append(quick, input, submit);
    div.appendChild(form);

    return div;
}

// ---------- 응답 처리 ----------
async function accept(req) {
    try {
        await updateDoc(doc(db, 'requests', req.id), {
            status: 'accepted',
            acceptedHospitalId: myHospitalId,
            responses: arrayUnion({ hospitalId: myHospitalId, decision: 'accept', reason: '', at: Date.now() }),
        });
    } catch (e) { alert('처리 실패: ' + e.message); }
}

async function reject(req, reason) {
    const nextRank = req.currentRank + 1;
    const exhausted = nextRank >= req.hospitalQueue.length;
    try {
        await updateDoc(doc(db, 'requests', req.id), {
            currentRank: exhausted ? req.currentRank : nextRank,
            status: exhausted ? 'exhausted' : 'pending',
            responses: arrayUnion({ hospitalId: myHospitalId, decision: 'reject', reason, at: Date.now() }),
        });
    } catch (e) { alert('처리 실패: ' + e.message); }
}

// ---------- 알람음 (Web Audio) ----------
function beep() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.type = 'square'; osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.15, ctx.currentTime);
        osc.start();
        osc.stop(ctx.currentTime + 0.25);
    } catch (e) { /* 사용자 상호작용 전이면 무시 */ }
}

initSidoSelect();
loadHospitals();
