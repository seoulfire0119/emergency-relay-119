import { db, ensureSignedIn } from './firebase.js?v=3';
import { fetchBeds } from './beds.js?v=4';
import { bedState } from './bedstatus.js?v=1';
import {
    collection,
    query,
    where,
    orderBy,
    limit,
    onSnapshot,
    doc,
    getDoc,
    setDoc,
    deleteDoc,
    runTransaction,
    serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const $ = (id) => document.getElementById(id);

const SIDO_LIST = [
    '서울특별시', '부산광역시', '대구광역시', '인천광역시', '광주광역시', '대전광역시',
    '울산광역시', '세종특별자치시', '경기도', '강원도', '충청북도', '충청남도',
    '전라북도', '전라남도', '경상북도', '경상남도', '제주특별자치도',
];

// 거절 사유 — 코드로 남겨야 병원별·사유별로 모아 볼 수 있다
const REASONS = [
    { code: 'cs_absent', label: '흉부외과 담당의 공백' },
    { code: 'icu_full', label: '중환자실 만실' },
    { code: 'er_crowded', label: '응급실 과밀' },
    { code: 'or_unavailable', label: '수술실 가동 불가' },
    { code: 'dept_absent', label: '해당 진료과 부재' },
    { code: 'equip_unavailable', label: '장비 사용 불가(CT·MRI 등)' },
];
const REASON_LABEL = Object.fromEntries(REASONS.map((r) => [r.code, r.label]));
const DEFAULT_TIMEOUT_MS = 90 * 1000;

let mySido = localStorage.getItem('myHospitalSido') || '서울특별시';
let myHospitalId = '';
let myHospitalName = '';
let hospitalsInSido = []; // 현재 시도의 실시간 병원 목록 (NEMC)
let unsub = null;
let unsubHistory = null;
let pendingForMe = [];    // 지금 우리 병원 차례인 요청
const seen = new Set();   // 새 요청 판별 (알림 1회)
const acked = new Set();  // 알람을 끈 요청

const KTAS = {
    '1': { label: 'KTAS 1 · 소생', color: '#e63946', dark: false },
    '2': { label: 'KTAS 2 · 긴급', color: '#f3722c', dark: false },
    '3': { label: 'KTAS 3 · 응급', color: '#f9c74f', dark: true },
    '4': { label: 'KTAS 4 · 준응급', color: '#43aa8b', dark: false },
    '5': { label: 'KTAS 5 · 비응급', color: '#577590', dark: false },
};
function ktasInfo(v) { return KTAS[v] || { label: v ? `KTAS ${v}` : '-', color: '#999', dark: false }; }

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDur = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const fmtClock = (ms) => new Date(ms).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });

const userReady = ensureSignedIn();
userReady.catch((e) => console.error('로그인 실패', e));

// ---------- 병원 인증 ----------
// 병원은 「병원 선택 + 인증코드」로 들어온다. 코드는 관리자가 Firestore hospitalPins 에 넣어 두고,
// 맞는지는 보안 규칙이 비교한다(앱은 코드 목록을 읽을 수 없다).
const sessionRef = (uid) => doc(db, 'hospitalSessions', uid);

function initSidoSelect() {
    const sel = $('hospital-sido');
    SIDO_LIST.forEach((s) => {
        const o = document.createElement('option');
        o.value = s; o.textContent = s;
        sel.appendChild(o);
    });
    sel.value = mySido;
    sel.onchange = () => {
        mySido = sel.value;
        localStorage.setItem('myHospitalSido', mySido);
        loadHospitals();
    };
}

async function loadHospitals() {
    const sel = $('hospital-select');
    sel.innerHTML = '<option value="">불러오는 중...</option>';
    try {
        hospitalsInSido = await fetchBeds({ sido: mySido, numOfRows: 1000 });
    } catch (e) {
        hospitalsInSido = [];
        $('login-msg').textContent = '병원 목록 로드 실패: ' + e.message;
    }
    sel.innerHTML = '';
    // 첫 병원으로 저절로 정하지 않는다 — 모르는 새 다른 병원 이름으로 응답하는 일을 막는다
    const ph = document.createElement('option');
    ph.value = ''; ph.textContent = hospitalsInSido.length ? '— 우리 병원을 선택하세요 —' : '(표시할 병원 없음)';
    sel.appendChild(ph);
    [...hospitalsInSido].sort((a, b) => a.name.localeCompare(b.name, 'ko')).forEach((h) => {
        const o = document.createElement('option');
        o.value = h.id;
        const st = bedState(h.hvec);
        o.textContent = `${h.name} (응급실 ${st.key === 'unknown' ? '확인불가' : st.text})`;
        sel.appendChild(o);
    });
    const last = localStorage.getItem('myHospitalId');
    if (last && hospitalsInSido.some((h) => h.id === last)) sel.value = last;
}

async function login() {
    const hpid = $('hospital-select').value;
    const pin = $('hospital-pin').value.trim();
    const msg = $('login-msg');
    if (!hpid) { msg.textContent = '우리 병원을 선택하세요.'; return; }
    if (!pin) { msg.textContent = '병원 인증코드를 입력하세요.'; $('hospital-pin').focus(); return; }
    const h = hospitalsInSido.find((x) => x.id === hpid);
    msg.textContent = '인증 중...';
    unlockAlarm(); // 로그인 버튼 누른 김에 소리·알림 권한도 연다
    try {
        const user = await userReady;
        await setDoc(sessionRef(user.uid), { hpid, name: h?.name || hpid, pin, at: serverTimestamp() });
        localStorage.setItem('myHospitalId', hpid);
        $('hospital-pin').value = '';
        msg.textContent = '';
        setMe(hpid, h?.name || hpid);
    } catch (e) {
        console.error('병원 인증 실패', e);
        msg.textContent = e.code === 'permission-denied'
            ? '인증코드가 올바르지 않습니다. 관리자에게 병원 인증코드를 확인하세요.'
            : '인증 실패: ' + e.message;
    }
}

async function restoreSession() {
    const user = await userReady;
    try {
        const snap = await getDoc(sessionRef(user.uid));
        if (snap.exists()) { setMe(snap.data().hpid, snap.data().name); return; }
    } catch (e) { console.warn('세션 확인 실패', e); }
    showLogin();
}

function setMe(hpid, name) {
    myHospitalId = hpid;
    myHospitalName = name;
    $('me-name').textContent = name;
    $('login-bar').classList.add('hidden');
    $('me-bar').classList.remove('hidden');
    seen.clear(); acked.clear();
    listen();
    listenHistory();
    requestWakeLock();
    updateAlarmBanner();
}

function showLogin() {
    myHospitalId = '';
    myHospitalName = '';
    if (unsub) { unsub(); unsub = null; }
    if (unsubHistory) { unsubHistory(); unsubHistory = null; }
    pendingForMe = [];
    stopAlarm();
    $('login-bar').classList.remove('hidden');
    $('me-bar').classList.add('hidden');
    $('requests').innerHTML = '<div class="empty">우리 병원을 선택하고 인증코드를 입력하면 수용요청을 받습니다.</div>';
    $('history').innerHTML = '<div class="ref">인증 후 표시됩니다.</div>';
    $('history-count').textContent = '';
    $('stats').innerHTML = '';
    updateAlarmBanner();
}

async function logout() {
    if (!confirm(`${myHospitalName} 수신을 끝내고 병원을 바꿀까요?\n이 기기로는 더 이상 요청이 오지 않습니다.`)) return;
    showLogin(); // 구독부터 끊는다 — 세션을 먼저 지우면 열린 구독이 권한 오류를 낸다
    try {
        const user = await userReady;
        await deleteDoc(sessionRef(user.uid));
    } catch (e) { console.warn('세션 삭제 실패', e); }
}

$('login-btn').onclick = login;
$('hospital-pin').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
$('logout-btn').onclick = logout;

// ---------- 수신 대기 ----------
// 우리 병원 차례인 요청만 받는다 (전국 요청을 받아 거르지 않는다)
function listen() {
    if (unsub) unsub();
    const q = query(
        collection(db, 'requests'),
        where('currentHospitalId', '==', myHospitalId),
        where('status', '==', 'pending'),
    );
    unsub = onSnapshot(q, (snap) => {
        pendingForMe = [];
        snap.forEach((d) => pendingForMe.push({ id: d.id, ...d.data() }));
        pendingForMe.sort((a, b) => (a.askedAt || 0) - (b.askedAt || 0));
        render();
    }, (err) => {
        console.error('수신 오류', err);
        $('status').textContent = '수신 오류: ' + err.message;
        if (err.code === 'permission-denied') showLogin();
    });
}

// ---------- 이력 (우리 병원이 응답한 요청: 수용/거절/무응답) ----------
function listenHistory() {
    if (unsubHistory) unsubHistory();
    const q = query(
        collection(db, 'requests'),
        where('respondedHospitalIds', 'array-contains', myHospitalId),
        orderBy('createdAt', 'desc'),
        limit(100),
    );
    unsubHistory = onSnapshot(q, (snap) => {
        const mine = [];
        snap.forEach((d) => {
            const data = d.data();
            const myResp = [...(data.responses || [])].reverse().find((r) => r.hospitalId === myHospitalId);
            if (myResp) mine.push({ id: d.id, myResp, ...data });
        });
        mine.sort((a, b) => (b.myResp.at || 0) - (a.myResp.at || 0));
        renderHistory(mine);
        renderStats(mine);
    }, (err) => {
        console.error('이력 수신 오류', err);
        $('history').innerHTML = '';
        const div = document.createElement('div');
        div.className = 'ref';
        div.style.color = 'var(--danger)';
        div.textContent = `이력을 불러올 수 없습니다: ${err.message}`;
        $('history').appendChild(div);
    });
}

const DECISION_TEXT = {
    accept: { txt: '수용', cls: 'dec-accept', item: 'h-accept' },
    reject: { txt: '거절', cls: 'dec-reject', item: 'h-reject' },
    timeout: { txt: '무응답', cls: 'dec-timeout', item: 'h-timeout' },
    skip: { txt: '넘겨짐', cls: 'dec-timeout', item: 'h-timeout' },
};

function outcomeText(data) {
    if (data.status === 'accepted') {
        if (data.acceptedHospitalId === myHospitalId) return { txt: '✅ 우리 병원 수용 확정', cls: 'accepted' };
        const name = data.hospitalQueue.find((h) => h.hospitalId === data.acceptedHospitalId)?.name || '타 병원';
        return { txt: `최종: ${name} 수용`, cls: 'other' };
    }
    if (data.status === 'exhausted') return { txt: '⚠️ 전 병원 수용불가로 종료', cls: 'exhausted' };
    if (data.status === 'cancelled') return { txt: '구급대원이 요청 취소', cls: 'pending' };
    return { txt: '진행 중', cls: 'pending' };
}

function renderHistory(list) {
    const wrap = $('history');
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
        const dec = DECISION_TEXT[r.decision] || DECISION_TEXT.reject;
        const myRank = (data.hospitalQueue.findIndex((h) => h.hospitalId === myHospitalId)) + 1;
        const out = outcomeText(data);

        const div = document.createElement('div');
        div.className = 'hist-item ' + dec.item;

        const head = document.createElement('div');
        head.className = 'hist-head';
        head.innerHTML = `<span class="hist-sym">${esc(p.symptom || '-')}</span>`
            + `<span class="ktas-chip" style="background:${k.color};${k.dark ? 'color:#333;' : ''}">${esc(k.label)}</span>`
            + `<span class="dec ${dec.cls}">${dec.txt}</span>`;
        div.appendChild(head);

        const meta = document.createElement('div');
        meta.className = 'hist-meta';
        const took = r.askedAt && r.at ? ` · 응답 ${fmtDur(r.at - r.askedAt)}` : '';
        meta.textContent = `${myRank}순위 · ${p.gender || '-'}/${p.age || '-'}세 · ${fmtClock(r.at)}${took}`;
        div.appendChild(meta);

        if (r.decision !== 'accept' && r.reason) {
            const reason = document.createElement('div');
            reason.className = 'hist-reason';
            reason.textContent = r.decision === 'reject' ? `거절 사유: ${r.reason}` : r.reason;
            div.appendChild(reason);
        }

        const outcome = document.createElement('div');
        outcome.className = `hist-outcome o-${out.cls}`;
        outcome.textContent = out.txt;
        if (data.status === 'accepted' && data.acceptedHospitalId === myHospitalId) {
            if (data.arrivedAt) outcome.textContent += ` · ${fmtClock(data.arrivedAt)} 도착`;
            else if (data.etaAt) outcome.textContent += ` · 도착 예정 ${fmtClock(data.etaAt)}`;
        }
        div.appendChild(outcome);

        wrap.appendChild(div);
    });
}

// ---------- 통계 (우리 병원 최근 이력 기준) ----------
function renderStats(list) {
    const el = $('stats');
    if (!list.length) { el.innerHTML = ''; return; }
    const count = (d) => list.filter((x) => x.myResp.decision === d).length;
    const acc = count('accept');
    const rej = count('reject');
    const none = count('timeout') + count('skip');
    const answered = list.filter((x) => ['accept', 'reject'].includes(x.myResp.decision) && x.myResp.askedAt);
    const avg = answered.length
        ? answered.reduce((s, x) => s + (x.myResp.at - x.myResp.askedAt), 0) / answered.length
        : null;
    const reasons = {};
    list.filter((x) => x.myResp.decision === 'reject').forEach((x) => {
        const key = REASON_LABEL[x.myResp.reasonCode] || '기타';
        reasons[key] = (reasons[key] || 0) + 1;
    });
    const top = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([k, v]) => `${esc(k)} ${v}건`).join(' · ');
    el.innerHTML = `
        <div class="stat"><div class="sv">${list.length}</div><div class="sk">응답한 요청</div></div>
        <div class="stat"><div class="sv">${Math.round((acc / list.length) * 100)}%</div><div class="sk">수용률 (${acc}건)</div></div>
        <div class="stat"><div class="sv">${rej}</div><div class="sk">거절</div></div>
        <div class="stat"><div class="sv">${none}</div><div class="sk">무응답</div></div>
        <div class="stat"><div class="sv">${avg != null ? fmtDur(avg) : '-'}</div><div class="sk">평균 응답 시간</div></div>
        ${top ? `<div class="stat wide"><div class="sk">주요 거절 사유</div><div>${top}</div></div>` : ''}`;
}

// ---------- 렌더 ----------
function render() {
    const wrap = $('requests');
    $('status').textContent = `대기 중인 요청 ${pendingForMe.length}건`;
    if (pendingForMe.length === 0) {
        wrap.innerHTML = '<div class="empty">현재 우리 병원으로 들어온 수용요청이 없습니다.<br>구급대원이 요청을 보내면 여기에 알람과 함께 표시됩니다.</div>';
        stopAlarm();
        return;
    }
    wrap.innerHTML = '';
    pendingForMe.forEach((req) => {
        const isNew = !seen.has(req.id);
        if (isNew) { seen.add(req.id); notify(req); }
        wrap.appendChild(card(req));
    });
    if (pendingForMe.some((r) => !acked.has(r.id))) startAlarm();
    else stopAlarm();
    updateDeadlines();
}

function card(req) {
    const p = req.patient || {};
    const div = document.createElement('div');
    div.className = 'req-card' + (acked.has(req.id) ? '' : ' alarm');

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

    // 순위 · 응답 남은 시간
    const note = document.createElement('div');
    note.className = 'rank-note';
    note.textContent = `우리 병원은 이 요청의 ${myRank}순위입니다.`;
    div.appendChild(note);
    if (req.deadlineAt) {
        const dl = document.createElement('div');
        dl.className = 'deadline';
        dl.dataset.deadline = String(req.deadlineAt);
        div.appendChild(dl);
    }

    // 환자 정보
    const info = document.createElement('div');
    info.className = 'pinfo';
    info.innerHTML = `
        <div><div class="k">연령</div>${esc(p.age || '-')}</div>
        <div><div class="k">성별</div>${esc(p.gender || '-')}</div>
        <div><div class="k">의식수준</div>${esc(p.consciousness || '-')}</div>
        <div><div class="k">KTAS</div>${esc(k.label)}</div>`;
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
            cell.innerHTML = `<div class="k">${label}</div>${esc(val)}${unit ? ' ' + unit : ''}`;
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

    // 앞순위 병원들의 거절·무응답
    const prior = (req.responses || []).filter((r) => r.decision !== 'accept');
    if (prior.length > 0) {
        const box = document.createElement('div');
        box.className = 'prior';
        box.innerHTML = '<h4>⚠️ 앞순위 병원 수용불가 · 무응답</h4>';
        prior.forEach((r) => {
            const name = req.hospitalQueue.find((h) => h.hospitalId === r.hospitalId)?.name || r.hospitalId;
            const line = document.createElement('div');
            line.textContent = `· ${name}: ${r.reason || '사유 미기재'}`;
            box.appendChild(line);
        });
        div.appendChild(box);
    }

    // 알람 끄기 (응답 전에 소리만 멈출 때)
    if (!acked.has(req.id)) {
        const ack = document.createElement('button');
        ack.className = 'ack-btn';
        ack.textContent = '🔕 알람 확인 (소리 끄기)';
        ack.onclick = () => { acked.add(req.id); render(); };
        div.appendChild(ack);
    }

    // 액션 버튼
    const actions = document.createElement('div');
    actions.className = 'actions';
    const acceptBtn = document.createElement('button');
    acceptBtn.className = 'accept';
    acceptBtn.textContent = '✅ 수용 가능';
    acceptBtn.onclick = () => respond(req, 'accept');
    const rejectBtn = document.createElement('button');
    rejectBtn.className = 'reject';
    rejectBtn.textContent = '✕ 수용 불가';
    const form = document.createElement('div');
    form.className = 'reject-form';
    rejectBtn.onclick = () => form.classList.toggle('open');
    actions.append(acceptBtn, rejectBtn);
    div.appendChild(actions);

    // 거절 사유 입력 폼 — 빠른 사유는 코드로, 직접 입력은 「기타」로 남긴다
    let reasonCode = '';
    const quick = document.createElement('div');
    quick.className = 'quick';
    const input = document.createElement('input');
    input.placeholder = '수용불가 사유를 고르거나 직접 입력하세요';
    input.oninput = () => { reasonCode = REASONS.find((r) => r.label === input.value.trim())?.code || 'other'; };
    REASONS.forEach((r) => {
        const b = document.createElement('button');
        b.textContent = r.label;
        b.onclick = () => { input.value = r.label; reasonCode = r.code; };
        quick.appendChild(b);
    });
    const submit = document.createElement('button');
    submit.className = 'reject';
    submit.textContent = '거절 사유 제출 → 다음 순위로';
    submit.style.width = '100%';
    submit.onclick = () => {
        const reason = input.value.trim();
        if (!reason) { input.focus(); return; }
        respond(req, 'reject', reason, reasonCode || 'other');
    };
    form.append(quick, input, submit);
    div.appendChild(form);

    return div;
}

// 응답 남은 시간 표시
function updateDeadlines() {
    document.querySelectorAll('.deadline').forEach((el) => {
        const left = Number(el.dataset.deadline) - Date.now();
        el.textContent = left > 0
            ? `⏱ 응답 남은 시간 ${fmtDur(left)} — 지나면 다음 순위 병원으로 넘어갑니다`
            : '⏱ 응답 시간이 지났습니다 — 곧 다음 순위 병원으로 넘어갑니다';
        el.classList.toggle('urgent', left < 20000);
    });
}
setInterval(updateDeadlines, 1000);

// ---------- 응답 처리 ----------
// 트랜잭션으로 「아직 우리 차례인지」를 확인하고 쓴다. 이미 다른 병원으로 넘어갔거나
// 같은 병원의 다른 사람이 먼저 처리했으면 덮어쓰지 않는다.
async function respond(req, decision, reason = '', reasonCode = '') {
    try {
        await runTransaction(db, async (tx) => {
            const ref = doc(db, 'requests', req.id);
            const snap = await tx.get(ref);
            if (!snap.exists()) throw new Error('STALE');
            const d = snap.data();
            if (d.status !== 'pending' || d.currentHospitalId !== myHospitalId) throw new Error('STALE');
            const now = Date.now();
            const responses = [...(d.responses || []), {
                hospitalId: myHospitalId, decision, reason, reasonCode, askedAt: d.askedAt || null, at: now,
            }];
            const respondedHospitalIds = [...new Set([...(d.respondedHospitalIds || []), myHospitalId])];
            if (decision === 'accept') {
                tx.update(ref, {
                    status: 'accepted', acceptedHospitalId: myHospitalId,
                    responses, respondedHospitalIds, deadlineAt: null, updatedAt: now,
                });
            } else {
                const next = d.currentRank + 1;
                const exhausted = next >= d.hospitalQueue.length;
                const timeout = d.deadlineAt && d.askedAt ? d.deadlineAt - d.askedAt : DEFAULT_TIMEOUT_MS;
                tx.update(ref, {
                    responses, respondedHospitalIds,
                    currentRank: exhausted ? d.currentRank : next,
                    currentHospitalId: exhausted ? null : d.hospitalQueue[next].hospitalId,
                    status: exhausted ? 'exhausted' : 'pending',
                    askedAt: exhausted ? d.askedAt : now,
                    deadlineAt: exhausted ? null : now + timeout,
                    updatedAt: now,
                });
            }
        });
        acked.add(req.id);
    } catch (e) {
        if (e.message === 'STALE') alert('이미 처리됐거나 다음 순위 병원으로 넘어간 요청입니다.');
        else alert('처리 실패: ' + e.message);
    }
}

// ---------- 알람 ----------
// 브라우저는 사용자가 한 번도 누르지 않은 페이지의 소리를 막는다. 그래서 「알람 켜기」로
// 소리를 열고, 확인할 때까지 1.5초마다 반복한다. 탭이 뒤에 있으면 브라우저 알림도 띄운다.
const baseTitle = document.title;
let audioCtx = null;
let alarmTimer = null;
let titleFlip = false;
let wakeLock = null;

function audioReady() { return !!audioCtx && audioCtx.state === 'running'; }

function unlockAlarm() {
    try {
        audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state !== 'running') audioCtx.resume().then(updateAlarmBanner).catch(() => {});
    } catch { /* 소리 미지원 */ }
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission().then(updateAlarmBanner).catch(() => {});
    }
    requestWakeLock();
    updateAlarmBanner();
}
$('alarm-enable').onclick = unlockAlarm;
// 페이지 어디를 눌러도 소리가 열리게
document.addEventListener('pointerdown', () => { if (!audioReady()) unlockAlarm(); });

function updateAlarmBanner() {
    const off = !!myHospitalId && !audioReady();
    $('alarm-banner').classList.toggle('hidden', !off);
}

function beep() {
    if (!audioReady()) return;
    const t = audioCtx.currentTime;
    [0, 0.3].forEach((offset, i) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain); gain.connect(audioCtx.destination);
        osc.type = 'square';
        osc.frequency.value = i === 0 ? 880 : 1175;
        gain.gain.setValueAtTime(0.15, t + offset);
        osc.start(t + offset);
        osc.stop(t + offset + 0.22);
    });
}

function alarmTick() {
    const waiting = pendingForMe.filter((r) => !acked.has(r.id)).length;
    if (!waiting) { stopAlarm(); return; }
    beep();
    if (navigator.vibrate) navigator.vibrate(300);
    titleFlip = !titleFlip;
    document.title = titleFlip ? `🚨 수용요청 ${waiting}건` : baseTitle;
}

function startAlarm() {
    if (alarmTimer) return;
    alarmTick();
    alarmTimer = setInterval(alarmTick, 1500);
}

function stopAlarm() {
    if (alarmTimer) { clearInterval(alarmTimer); alarmTimer = null; }
    document.title = baseTitle;
}

function notify(req) {
    if (!('Notification' in window) || Notification.permission !== 'granted' || !document.hidden) return;
    const p = req.patient || {};
    try {
        const n = new Notification('🚑 응급실 수용요청', {
            body: `${p.symptom || '-'} · ${ktasInfo(p.ktas).label} · ${p.gender || '-'}/${p.age || '-'}세`,
            tag: req.id,
            requireInteraction: true,
        });
        n.onclick = () => { window.focus(); n.close(); };
    } catch { /* 일부 모바일 브라우저는 페이지에서 직접 알림 불가 */ }
}

// 병원 PC·태블릿 화면이 꺼지면 요청을 못 본다 — 수신 중에는 화면 꺼짐을 막는다
async function requestWakeLock() {
    if (!myHospitalId || !('wakeLock' in navigator) || wakeLock) return;
    try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch { /* 권한 없음 · 절전 모드 */ }
}
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') requestWakeLock();
});

// ---------- 시작 ----------
initSidoSelect();
loadHospitals();
showLogin();
restoreSession();
