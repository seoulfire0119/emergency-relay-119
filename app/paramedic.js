import { db, ensureSignedIn } from './firebase.js?v=3';
import { fetchBeds, fetchHospitalInfo, fetchSevere } from './beds.js?v=5';
import {
    bedState, bedSortValue, resourceChips, updatedInfo, distanceKm, distanceText, etaMinutes,
    SEVERE_ITEMS, severeLabel, severeDetails,
} from './bedstatus.js?v=2';
import {
    collection,
    addDoc,
    doc,
    onSnapshot,
    serverTimestamp,
    runTransaction,
    updateDoc,
    deleteDoc,
    getDocs,
    query,
    where,
    Timestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const $ = (id) => document.getElementById(id);

// 병원 한 곳이 응답할 시간. 넘기면 다음 순위로 자동으로 넘어간다.
const RESPONSE_TIMEOUT_MS = 90 * 1000;
// 환자 정보 보관 기간. expiresAt 이 지난 내 요청은 이 화면을 열 때 지운다.
// (Firestore TTL 정책은 유료 요금제에서만 켤 수 있어, 켜기 전까지는 이 정리가 대신한다)
const RETENTION_MS = 24 * 60 * 60 * 1000;
// 새로고침해도 진행 중인 요청을 다시 붙잡기 위한 저장 키
const ACTIVE_KEY = 'zero-activeRequestId';

let queue = [];            // 전송 전, 구급대원이 지정한 병원 순위
let beds = [];             // 병상 패널 표시용 (권역 필터 반영)
let allBeds = [];          // 선택 시도 전체 병원 (순위 지정용)
let myPos = null;          // { lat, lon } — 거리순 정렬용
let sortMode = 'beds';     // 'beds' | 'distance'
let severeFilter = 0;      // 0=안 씀, 1~28 = 이 중증질환 수용 가능 병원을 위로
let activeId = null;       // 진행 중인 요청 id
let current = null;        // 진행 중인 요청 문서(최신)
let unsub = null;
let advancing = false;     // 무응답 자동 넘김 중복 방지

const userReady = ensureSignedIn();
userReady.catch((e) => console.error('로그인 실패', e));

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
        // 병원 순위 지정용: 항상 선택한 시도 전체 병원 (+ 좌표·종별, 없으면 빈 Map)
        const [all, info, severe] = await Promise.all([
            fetchBeds({ sido, numOfRows: 1000 }),
            fetchHospitalInfo({ sido }),
            fetchSevere({ sido }),
        ]);
        const enrich = (b) => Object.assign(b, info.get(b.id) || {}, { severe: severe.get(b.id) || null });
        all.forEach(enrich);
        allBeds = all;
        $('severe-filter').disabled = severe.size === 0;
        // 패널 표시용: 서울 권역 선택 시 해당 구만, 그 외엔 시도 전체
        if (sido === SEOUL && kwonyeok) {
            const gus = kwonyeokMap[kwonyeok] || [];
            const results = await Promise.all(gus.map((gu) => fetchBeds({ sido, gu, numOfRows: 100 })));
            beds = results.flat().map(enrich);
        } else {
            beds = allBeds;
        }
        $('geo-note').textContent = allBeds.some((b) => b.lat != null)
            ? ''
            : '병원 위치 정보를 아직 받을 수 없어 거리순 정렬은 쓸 수 없습니다.';
        renderBedList();
        render();
    } catch (e) {
        beds = []; allBeds = [];
        render();
        listEl.innerHTML = '';
        const err = document.createElement('div');
        err.className = 'ref';
        err.style.color = 'var(--danger)';
        err.textContent = `병상 정보를 불러올 수 없습니다: ${e.message}`;
        listEl.appendChild(err);
    }
}

// 병상 상태 표시 조각 — 과밀(음수)과 확인불가(값 없음)를 따로 보여 준다
function bedTag(b) {
    const st = bedState(b.hvec);
    const span = document.createElement('span');
    span.className = `bt bt-${st.key}`;
    span.textContent = st.key === 'unknown' ? '확인불가' : `${st.label} · ${st.text}`;
    return span;
}

function emclsTag(b) {
    if (!b.emcls) return null;
    const span = document.createElement('span');
    span.className = 'emcls';
    span.textContent = b.emcls.replace('응급의료', '');
    return span;
}

function resourcesLine(b) {
    const chips = resourceChips(b.res);
    if (!chips.length) return null;
    const div = document.createElement('div');
    div.className = 'res-line';
    chips.forEach((c) => {
        const s = document.createElement('span');
        s.className = `res-chip ${c.ok === true ? 'ok' : c.ok === false ? 'no' : ''}`;
        s.textContent = `${c.label} ${c.text}`;
        div.appendChild(s);
    });
    return div;
}

function updatedLine(b) {
    const u = updatedInfo(b.hvidate);
    if (!u) return null;
    const div = document.createElement('div');
    div.className = `upd${u.stale ? ' stale' : ''}`;
    div.textContent = u.stale ? `⚠ ${u.text} (오래된 정보일 수 있음)` : u.text;
    return div;
}

function renderBedList() {
    const listEl = $('bed-list');
    listEl.innerHTML = '';
    if (beds.length === 0) { listEl.innerHTML = '<div class="ref">표시할 병상 정보가 없습니다.</div>'; return; }
    [...beds].sort((a, b) => bedSortValue(b.hvec) - bedSortValue(a.hvec)).slice(0, 50).forEach((b) => {
        const st = bedState(b.hvec);
        const row = document.createElement('div');
        row.className = `bed-row b-${st.key}`;
        const left = document.createElement('div');
        const name = document.createElement('div');
        name.className = 'bn';
        name.textContent = b.name;
        const em = emclsTag(b);
        if (em) name.append(' ', em);
        left.appendChild(name);
        const upd = updatedLine(b);
        if (upd) left.appendChild(upd);
        const cnt = document.createElement('div');
        cnt.className = 'bc';
        cnt.textContent = st.key === 'unknown' ? '확인불가' : st.text;
        row.append(left, cnt);
        listEl.appendChild(row);
    });
}

$('bed-refresh').onclick = loadBeds;
$('bed-sido').onchange = () => { syncKwonyeokVisibility(); loadBeds(); };
$('bed-kwonyeok').onchange = loadBeds;

// ---------- 거리순 정렬 ----------
$('sort-mode').onchange = () => {
    sortMode = $('sort-mode').value;
    if (sortMode === 'distance' && !myPos) { locate(); return; }
    render();
};
$('geo-btn').onclick = locate;

// ---------- 중증질환 필터 ----------
// 고른 항목이 「가능」인 병원을 위로, 정보미제공은 가운데, 「불가」는 아래로 (숨기지는 않는다)
(function initSevereFilter() {
    const sel = $('severe-filter');
    const groups = {};
    SEVERE_ITEMS.forEach(([n, g, name]) => {
        if (!groups[g]) {
            groups[g] = document.createElement('optgroup');
            groups[g].label = g;
            sel.appendChild(groups[g]);
        }
        const o = document.createElement('option');
        o.value = String(n);
        o.textContent = `${g} · ${name}`;
        groups[g].appendChild(o);
    });
    sel.onchange = () => { severeFilter = Number(sel.value) || 0; render(); };
})();

function severeRank(b) {
    if (!severeFilter) return 0;
    const v = b.severe?.flags?.[severeFilter];
    return v === true ? 0 : v === false ? 2 : 1;
}

function severeTag(b) {
    if (!severeFilter) return null;
    const v = b.severe?.flags?.[severeFilter];
    const span = document.createElement('span');
    span.className = `sv-tag ${v === true ? 'ok' : v === false ? 'no' : 'unk'}`;
    const msg = v === true && b.severe?.msgs?.[severeFilter] ? ` (${b.severe.msgs[severeFilter]})` : '';
    span.textContent = `${v === true ? '✓ 가능' : v === false ? '✕ 불가' : '? 정보미제공'} · ${severeLabel(severeFilter)}${msg}`;
    return span;
}

function locate() {
    if (!navigator.geolocation) { $('geo-note').textContent = '이 기기에서는 위치를 확인할 수 없습니다.'; return; }
    $('geo-note').textContent = '현재 위치 확인 중...';
    navigator.geolocation.getCurrentPosition(
        (pos) => {
            myPos = { lat: pos.coords.latitude, lon: pos.coords.longitude };
            sortMode = 'distance';
            $('sort-mode').value = 'distance';
            $('geo-note').textContent = allBeds.some((b) => b.lat != null)
                ? '현재 위치 기준 직선거리·예상 시간입니다(도로 사정에 따라 다름).'
                : '위치는 확인했지만 병원 위치 정보가 없어 거리 계산을 할 수 없습니다.';
            render();
        },
        (err) => {
            sortMode = 'beds';
            $('sort-mode').value = 'beds';
            $('geo-note').textContent = `위치를 가져오지 못했습니다: ${err.message}`;
            render();
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
    );
}

const distOf = (b) => distanceKm(myPos, b);

// ---------- 병원 선택 (선택한 시도의 실시간 병상 데이터 기반) ----------
function canAppend() {
    return !!current && ['pending', 'exhausted'].includes(current.status);
}

function renderHospitalList() {
    const wrap = $('hospital-list');
    wrap.innerHTML = '';
    if (allBeds.length === 0) {
        wrap.innerHTML = '<div class="ref">선택한 지역에 표시할 병원이 없습니다. (지역을 바꾸거나 새로고침)</div>';
        return;
    }
    const taken = new Set([
        ...queue.map((q) => q.id),
        ...(current?.hospitalQueue || []).map((q) => q.hospitalId),
    ]);
    const remaining = allBeds.filter((b) => !taken.has(b.id));
    if (sortMode === 'distance' && myPos) {
        remaining.sort((a, b) => severeRank(a) - severeRank(b) || (distOf(a) ?? Infinity) - (distOf(b) ?? Infinity));
    } else {
        // 가용 병상 많은 순 (중증질환 필터가 있으면 그 가능 여부가 먼저)
        remaining.sort((a, b) => severeRank(a) - severeRank(b) || bedSortValue(b.hvec) - bedSortValue(a.hvec));
    }
    if (remaining.length === 0) {
        wrap.innerHTML = '<div class="ref">모든 병원이 순위에 추가되었습니다.</div>';
        return;
    }
    const appendMode = !!activeId;
    remaining.forEach((b) => {
        const div = document.createElement('div');
        div.className = 'hospital-pick';
        const info = document.createElement('div');
        info.className = 'pick-info';
        const name = document.createElement('div');
        name.className = 'pick-name';
        name.textContent = b.name;
        const em = emclsTag(b);
        if (em) name.append(' ', em);
        const meta = document.createElement('div');
        meta.className = 'pick-meta';
        meta.appendChild(bedTag(b));
        const km = distOf(b);
        if (km != null) meta.append(` · 📍 ${distanceText(km)}`);
        if (b.tel) meta.append(` · ☎ ${b.tel}`);
        info.append(name, meta);
        const sv = severeTag(b);
        if (sv) info.appendChild(sv);
        if (severeRank(b) === 2) div.classList.add('dim');
        const res = resourcesLine(b);
        if (res) info.appendChild(res);
        const det = severeDetails(b.severe);
        if (det) info.appendChild(det);
        const upd = updatedLine(b);
        if (upd) info.appendChild(upd);
        div.appendChild(info);

        if (!appendMode || canAppend()) {
            const btn = document.createElement('button');
            btn.className = 'small';
            btn.textContent = appendMode ? '+ 요청에 추가' : '+ 추가';
            btn.onclick = () => {
                if (appendMode) appendHospital(b);
                else { queue.push(b); render(); }
            };
            div.appendChild(btn);
        }
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
        name.append(' ', bedTag(h));
        const up = mkBtn('▲', () => { if (i > 0) { [queue[i - 1], queue[i]] = [queue[i], queue[i - 1]]; render(); } });
        const down = mkBtn('▼', () => { if (i < queue.length - 1) { [queue[i + 1], queue[i]] = [queue[i], queue[i + 1]]; render(); } });
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
    $('send-btn').disabled = queue.length === 0 || !!activeId;
}

// 진행 중인 요청이 있으면 환자 입력은 잠그고, 병원 목록은 「요청에 추가」용으로 남긴다
function applyComposeLock() {
    const locked = !!activeId;
    $('patient-panel').querySelectorAll('input, select, textarea').forEach((el) => { el.disabled = locked; });
    $('queue-section').classList.toggle('hidden', locked);
    $('append-note').classList.toggle('hidden', !locked);
}

// ---------- 요청 전송 ----------
function readPatient() {
    return {
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
}

function queueEntry(h, i) {
    return {
        rank: i + 1,
        hospitalId: h.id,
        name: h.name,
        tel: h.tel || '',
        lat: h.lat ?? null,
        lon: h.lon ?? null,
    };
}

$('send-btn').onclick = async () => {
    if (queue.length === 0 || activeId) return;
    $('send-btn').disabled = true;
    try {
        const user = await userReady;
        const now = Date.now();
        const hospitalQueue = queue.map(queueEntry);
        const ref = await addDoc(collection(db, 'requests'), {
            createdBy: user.uid,
            patient: readPatient(),
            hospitalQueue,
            currentRank: 0,
            currentHospitalId: hospitalQueue[0].hospitalId,
            status: 'pending',
            acceptedHospitalId: null,
            responses: [],
            respondedHospitalIds: [],
            askedAt: now,
            deadlineAt: now + RESPONSE_TIMEOUT_MS,
            createdAt: serverTimestamp(),
            updatedAt: now,
            expiresAt: Timestamp.fromMillis(now + RETENTION_MS),
        });
        queue = [];
        setActive(ref.id);
    } catch (e) {
        console.error('요청 전송 실패', e);
        alert('요청 전송에 실패했습니다: ' + e.message);
        $('send-btn').disabled = false;
    }
};

// ---------- 진행 중 요청 붙잡기 ----------
function setActive(id) {
    activeId = id;
    try { localStorage.setItem(ACTIVE_KEY, id); } catch { /* 저장 불가 환경 */ }
    subscribe(id);
    applyComposeLock();
    render();
}

function clearActive() {
    if (unsub) { unsub(); unsub = null; }
    activeId = null;
    current = null;
    try { localStorage.removeItem(ACTIVE_KEY); } catch { /* 무시 */ }
    $('result-area').innerHTML = '';
    $('track-list').innerHTML = '';
    $('track-empty').classList.remove('hidden');
    applyComposeLock();
    render();
}

function subscribe(requestId) {
    if (unsub) unsub();
    $('track-empty').classList.add('hidden');
    unsub = onSnapshot(doc(db, 'requests', requestId), (snap) => {
        if (!snap.exists()) { clearActive(); return; }
        current = snap.data();
        renderTracking();
        render();
    }, (err) => {
        console.error('요청 추적 오류', err);
        clearActive();
        $('track-empty').textContent = '이전 요청을 불러올 수 없습니다. 새 요청을 작성해 주세요.';
    });
}

// ---------- 무응답 넘김 · 수동 넘김 ----------
async function advance(kind) {
    if (!activeId || advancing) return;
    advancing = true;
    try {
        await runTransaction(db, async (tx) => {
            const ref = doc(db, 'requests', activeId);
            const snap = await tx.get(ref);
            if (!snap.exists()) return;
            const d = snap.data();
            if (d.status !== 'pending') return;
            if (kind === 'timeout' && Date.now() < (d.deadlineAt || 0)) return;
            const cur = d.hospitalQueue[d.currentRank];
            const next = d.currentRank + 1;
            const exhausted = next >= d.hospitalQueue.length;
            const now = Date.now();
            tx.update(ref, {
                responses: [...(d.responses || []), {
                    hospitalId: cur.hospitalId,
                    decision: kind,
                    reasonCode: kind,
                    reason: kind === 'timeout' ? `${RESPONSE_TIMEOUT_MS / 1000}초 무응답` : '구급대원이 다음 순위로 넘김',
                    askedAt: d.askedAt || null,
                    at: now,
                }],
                respondedHospitalIds: [...new Set([...(d.respondedHospitalIds || []), cur.hospitalId])],
                currentRank: exhausted ? d.currentRank : next,
                currentHospitalId: exhausted ? null : d.hospitalQueue[next].hospitalId,
                status: exhausted ? 'exhausted' : 'pending',
                askedAt: exhausted ? d.askedAt : now,
                deadlineAt: exhausted ? null : now + RESPONSE_TIMEOUT_MS,
                updatedAt: now,
            });
        });
    } catch (e) {
        console.error('다음 순위로 넘기기 실패', e);
        if (kind === 'skip') alert('넘기지 못했습니다: ' + e.message);
    } finally {
        advancing = false;
    }
}

// 진행 중(또는 전원 불가) 요청에 병원을 더 붙인다. 전원 불가였으면 새 병원부터 다시 요청한다.
async function appendHospital(b) {
    if (!activeId) return;
    try {
        await runTransaction(db, async (tx) => {
            const ref = doc(db, 'requests', activeId);
            const snap = await tx.get(ref);
            const d = snap.data();
            if (!['pending', 'exhausted'].includes(d.status)) throw new Error('이미 끝난 요청입니다.');
            if (d.hospitalQueue.some((q) => q.hospitalId === b.id)) return;
            const hospitalQueue = [...d.hospitalQueue, queueEntry(b, d.hospitalQueue.length)];
            const now = Date.now();
            const update = { hospitalQueue, updatedAt: now };
            if (d.status === 'exhausted') {
                Object.assign(update, {
                    status: 'pending',
                    currentRank: d.hospitalQueue.length,
                    currentHospitalId: b.id,
                    askedAt: now,
                    deadlineAt: now + RESPONSE_TIMEOUT_MS,
                });
            }
            tx.update(ref, update);
        });
    } catch (e) {
        alert('병원을 추가하지 못했습니다: ' + e.message);
    }
}

async function cancelRequest() {
    if (!activeId || !current || !['pending', 'exhausted'].includes(current.status)) return;
    if (!confirm('이 수용요청을 취소할까요?\n요청 중인 병원 화면에서도 사라집니다.')) return;
    try {
        await updateDoc(doc(db, 'requests', activeId), {
            status: 'cancelled', currentHospitalId: null, deadlineAt: null, updatedAt: Date.now(),
        });
    } catch (e) { alert('취소하지 못했습니다: ' + e.message); }
}

async function sendEta(minutes) {
    if (!activeId || !(minutes > 0)) return;
    try {
        await updateDoc(doc(db, 'requests', activeId), { etaAt: Date.now() + minutes * 60000, updatedAt: Date.now() });
    } catch (e) { alert('도착 예정 시간을 보내지 못했습니다: ' + e.message); }
}

async function markArrived() {
    if (!activeId) return;
    try {
        await updateDoc(doc(db, 'requests', activeId), { arrivedAt: Date.now(), updatedAt: Date.now() });
    } catch (e) { alert('처리하지 못했습니다: ' + e.message); }
}

async function newRequest() {
    if (current && current.status === 'pending') {
        if (!confirm('진행 중인 요청을 취소하고 새로 작성할까요?')) return;
        try {
            await updateDoc(doc(db, 'requests', activeId), {
                status: 'cancelled', currentHospitalId: null, deadlineAt: null, updatedAt: Date.now(),
            });
        } catch (e) { alert('취소하지 못했습니다: ' + e.message); return; }
    }
    clearActive();
    ['age', 'v-bp', 'v-pulse', 'v-spo2', 'v-temp', 'v-glucose', 'memo'].forEach((id) => { $(id).value = ''; });
    $('symptom').selectedIndex = 0;
    $('ktas').value = '3';
    $('gender').selectedIndex = 0;
    $('consciousness').selectedIndex = 0;
    queue = [];
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ---------- 실시간 추적 ----------
const fmtDur = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const fmtClock = (ms) => new Date(ms).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });

const DECISION = {
    accept: { state: 'accepted', badge: '수용' },
    reject: { state: 'rejected', badge: '거절' },
    timeout: { state: 'timeout', badge: '무응답' },
    skip: { state: 'timeout', badge: '넘김' },
};

function directionsUrl(h) {
    if (h.lat != null && h.lon != null) {
        return `https://map.kakao.com/link/to/${encodeURIComponent(h.name)},${h.lat},${h.lon}`;
    }
    return `https://map.kakao.com/link/search/${encodeURIComponent(h.name)}`;
}

function renderTracking() {
    const d = current;
    const resultArea = $('result-area');
    resultArea.innerHTML = '';
    $('track-empty').classList.add('hidden');

    const responses = d.responses || [];
    const rejects = responses.filter((r) => r.decision === 'reject').length;
    const noAnswer = responses.filter((r) => r.decision === 'timeout' || r.decision === 'skip').length;
    const createdMs = d.createdAt?.toMillis?.() ?? null;

    if (d.status === 'accepted') {
        const h = d.hospitalQueue.find((q) => q.hospitalId === d.acceptedHospitalId) || {};
        const box = document.createElement('div');
        box.innerHTML = `
            <div class="result-banner accepted">✅ ${esc(h.name || '병원')} 수용 확정</div>
            <div class="after-accept">
                <div class="aa-row">
                    ${h.tel ? `<a class="aa-btn" href="tel:${esc(h.tel)}">☎ 응급실 전화 ${esc(h.tel)}</a>` : ''}
                    <a class="aa-btn" href="${esc(directionsUrl(h))}" target="_blank" rel="noopener">🧭 길안내 (카카오맵)</a>
                </div>
                <div class="aa-row eta-row">
                    <span>도착 예정</span>
                    <input id="eta-min" type="number" min="1" max="180" placeholder="분">
                    <button id="eta-send" class="small">병원에 알리기</button>
                    <span id="eta-text" class="ref"></span>
                </div>
                <div class="aa-row">
                    <button id="arrived-btn" class="small">🏁 병원 도착 완료</button>
                    <span id="arrived-text" class="ref"></span>
                </div>
            </div>`;
        resultArea.appendChild(box);
        const km = distanceKm(myPos, h);
        if (km != null) $('eta-min').value = etaMinutes(km);
        if (d.etaAt) $('eta-text').textContent = `병원에 알린 도착 예정: ${fmtClock(d.etaAt)}`;
        $('eta-send').onclick = () => sendEta(parseInt($('eta-min').value, 10));
        if (d.arrivedAt) {
            $('arrived-btn').disabled = true;
            $('arrived-text').textContent = `${fmtClock(d.arrivedAt)} 도착`;
        } else {
            $('arrived-btn').onclick = markArrived;
        }
    } else if (d.status === 'exhausted') {
        resultArea.innerHTML = '<div class="result-banner exhausted">⚠️ 모든 병원이 수용 불가 — 왼쪽 목록에서 병원을 「요청에 추가」하면 이어서 요청합니다</div>';
    } else if (d.status === 'cancelled') {
        resultArea.innerHTML = '<div class="result-banner cancelled">요청이 취소되었습니다</div>';
    } else {
        const cur = d.hospitalQueue[d.currentRank] || {};
        const bar = document.createElement('div');
        bar.className = 'asking-bar';
        bar.innerHTML = `
            <div>⏳ <b>${d.currentRank + 1}순위 ${esc(cur.name)}</b> 응답 대기 · 남은 시간 <b id="countdown">-</b></div>
            <div class="ref">시간 안에 응답이 없으면 자동으로 다음 순위 병원에 요청합니다.</div>
            <div class="aa-row">
                <button id="skip-btn" class="small">⏭ 다음 순위로 넘기기</button>
                <button id="cancel-btn" class="small ghost">요청 취소</button>
            </div>`;
        resultArea.appendChild(bar);
        $('skip-btn').onclick = () => { if (confirm(`${cur.name} 응답을 기다리지 않고 다음 순위로 넘길까요?`)) advance('skip'); };
        $('cancel-btn').onclick = cancelRequest;
        updateCountdown();
    }

    // 요약 · 새 요청
    const summary = document.createElement('div');
    summary.className = 'track-summary';
    const acc = responses.find((r) => r.decision === 'accept');
    summary.innerHTML = `
        <span>거절 <b>${rejects}</b>회 · 무응답/넘김 <b>${noAnswer}</b>회${
            createdMs ? ` · ${acc ? `수용까지 <b>${fmtDur(acc.at - createdMs)}</b>` : `경과 <b id="elapsed">${fmtDur(Date.now() - createdMs)}</b>`}` : ''}</span>`;
    const newBtn = document.createElement('button');
    newBtn.className = 'small ghost';
    newBtn.textContent = '＋ 새 요청 작성';
    newBtn.onclick = newRequest;
    summary.appendChild(newBtn);
    if (d.status === 'exhausted') {
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'small ghost';
        cancelBtn.textContent = '요청 취소';
        cancelBtn.onclick = cancelRequest;
        summary.appendChild(cancelBtn);
    }
    resultArea.appendChild(summary);

    // 병원별 카드
    const list = $('track-list');
    list.innerHTML = '';
    const byHospital = {};
    responses.forEach((r) => { byHospital[r.hospitalId] = r; });

    d.hospitalQueue.forEach((q, i) => {
        const resp = byHospital[q.hospitalId];
        let state = 'pending', badgeText = '대기';
        if (resp && DECISION[resp.decision]) ({ state, badge: badgeText } = DECISION[resp.decision]);
        else if (d.status === 'pending' && i === d.currentRank) { state = 'asking'; badgeText = '요청중'; }

        const div = document.createElement('div');
        div.className = `track-item ${state}`;
        const head = document.createElement('div');
        head.className = 'track-head';
        const b = document.createElement('b');
        b.textContent = `${i + 1}순위 · ${q.name}`;
        const badge = document.createElement('span');
        badge.className = `badge ${state}`;
        badge.textContent = badgeText;
        head.append(b, badge);
        div.appendChild(head);
        if (resp && resp.decision !== 'accept') {
            const reason = document.createElement('div');
            reason.className = 'reason';
            reason.textContent = resp.decision === 'reject'
                ? `거절 사유: ${resp.reason || '사유 미기재'}`
                : resp.reason || '';
            div.appendChild(reason);
        }
        if (resp && resp.askedAt && resp.at) {
            const t = document.createElement('div');
            t.className = 'ref';
            t.textContent = `응답까지 ${fmtDur(resp.at - resp.askedAt)}`;
            div.appendChild(t);
        }
        list.appendChild(div);
    });
}

// 남은 시간 표시 + 시간이 지나면 다음 순위로
function updateCountdown() {
    if (!current) return;
    const createdMs = current.createdAt?.toMillis?.();
    const el = $('elapsed');
    if (el && createdMs) el.textContent = fmtDur(Date.now() - createdMs);
    if (current.status !== 'pending' || !current.deadlineAt) return;
    const left = current.deadlineAt - Date.now();
    const cd = $('countdown');
    if (cd) {
        cd.textContent = left > 0 ? fmtDur(left) : '시간 초과 — 다음 순위로 넘기는 중';
        cd.classList.toggle('urgent', left < 20000);
    }
    if (left <= 0) advance('timeout');
}
setInterval(updateCountdown, 1000);

// ---------- 시작 ----------
render();
applyComposeLock();
syncKwonyeokVisibility();
loadBeds();

// 새로고침 전 진행 중이던 요청이 있으면 다시 붙잡는다
let saved = null;
try { saved = localStorage.getItem(ACTIVE_KEY); } catch { /* 무시 */ }
if (saved) userReady.then(() => setActive(saved)).catch(() => {});

// 보관 기간(24시간)이 지난 내 요청 정리 — 환자 정보를 오래 남기지 않는다
userReady.then(async (user) => {
    const q = query(
        collection(db, 'requests'),
        where('createdBy', '==', user.uid),
        where('expiresAt', '<', Timestamp.now()),
    );
    const snap = await getDocs(q);
    await Promise.all(snap.docs.map((d) => (d.id === activeId ? null : deleteDoc(d.ref))));
    if (snap.size) console.info(`[정리] 보관 기간이 지난 요청 ${snap.size}건 삭제`);
}).catch((e) => console.warn('오래된 요청 정리 실패', e));
