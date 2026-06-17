# 119 응급실 수용요청 릴레이 + 실시간 병상 정보

> 제6회 소방안전 빅데이터 활용 및 아이디어 경진대회(2026) 출품작
> 구급대원이 현장에서 환자를 평가하고, 병원에 일일이 전화하는 대신 앱으로 **수용요청을 보내면**
> 1순위 병원부터 차례로 수용/거절을 응답하고, 거절 시 사유와 함께 다음 순위 병원으로 자동 에스컬레이션되는 **양방향 릴레이 시스템**.

- **배포 주소(Hosting)**: https://emergency-145fe.web.app
- **Firebase 프로젝트**: `emergency-145fe`
- **병상 프록시(Worker)**: https://emergency-bed-proxy.emergency-145fe.workers.dev

---

## 화면 구성

| 페이지 | 파일 | 용도 |
|--------|------|------|
| 실시간 병상 | `index.html` + `emergency.js` | 전국/서울 권역별 응급실 가용 병상 조회(NEMC) |
| 구급대원용 | `paramedic.html` + `app/paramedic.js` | 환자평가(KTAS·바이탈) → 병원 순위 지정 → 수용요청 전송 → 실시간 추적 |
| 병원용 | `hospital.html` + `app/hospital.js` | 우리 병원 요청 수신·알람 → 수용/거절(사유) → **응답 이력** 조회 |

## 아키텍처

```
[브라우저]
  ├─ 실시간 병상: app/beds.js ──HTTP──> [Cloudflare Worker] ──> NEMC 공공데이터 API(XML)
  │                                       (공공데이터 키는 Worker secret에만 보관)
  └─ 릴레이:    app/firebase.js ──> [Firebase Firestore]  (onSnapshot 실시간 구독 = 알람)
                                  + [Firebase Auth(익명)]  (사용자 식별)
[참고지표] tools/aggregate-ems.js ──> bigdata-119 구급현황 API ──> app/ems-summary.json (정적 집계)
```

- **실시간 알람**은 FCM 대신 Firestore `onSnapshot` 실시간 리스너로 구현(프로토타입 단순화). 닫힌 앱 푸시는 v2(FCM) 과제.
- **공공데이터 서비스 키는 절대 브라우저 코드에 두지 않는다.** Worker의 secret(`.dev.vars` 로컬 / `wrangler secret` 프로덕션)에만 보관.

## 데이터 모델 (Firestore `requests` 컬렉션)

```jsonc
{
  "patient": {
    "symptom": "흉통",
    "ktas": "3",                 // KTAS 1~5 (중증도 대체)
    "age": "67", "gender": "남",
    "consciousness": "명료(A)",
    "vitals": { "bp": "120/80", "pulse": "78", "spo2": "98", "temp": "36.5", "glucose": "110" },
    "memo": "현장 메모"
  },
  "hospitalQueue": [ { "rank": 1, "hospitalId": "<hpid>", "name": "서울대학교병원" }, ... ],
  "currentRank": 0,              // 현재 요청이 가 있는 순위(0-base)
  "status": "pending",          // pending | accepted | exhausted
  "acceptedHospitalId": null,
  "responses": [ { "hospitalId": "<hpid>", "decision": "reject", "reason": "흉부외과 담당의 공백", "at": 1718600000000 } ],
  "createdAt": <serverTimestamp>
}
```

- **병원 식별자는 NEMC `hpid`** 를 사용 → 구급대원 화면과 병원 화면이 같은 실시간 병원 목록을 공유해 전국 어디서나 매칭된다.
- **거절 시**: `currentRank++`, 마지막 순위까지 거절되면 `status: 'exhausted'`. **수용 시**: `status: 'accepted'`.
- 병원 화면 이력은 `responses[]`에 내 `hpid`가 포함된 문서를 클라이언트에서 필터링(최근 100건).

## 핵심 파일

```
index.html / emergency.js        실시간 병상 조회(+ 서울 권역 kwonyeokMap)
paramedic.html / app/paramedic.js  구급대원용: 환자평가, 시도→실시간 병원 목록, 순위지정, 추적
hospital.html  / app/hospital.js   병원용: 지역→병원 선택, 수신·알람, 수용/거절, 이력
app/firebase.js   Firebase 초기화(로컬은 에뮬레이터 자동연결, 익명 로그인)
app/beds.js       Worker 프록시 호출 → 병상 배열 [{id(hpid), name, hvec, tel}]
app/hospitals.js  (구버전 데모 병원 시드 — 현재 릴레이는 실시간 병상 기반으로 동작, 미사용)
worker/src/index.js  Cloudflare Worker(NEMC 프록시, CORS, 키 정규화)
tools/aggregate-ems.js  bigdata-119 구급현황 집계 → app/ems-summary.json
firestore.rules   프로토타입 보안 규칙
firebase.json     hosting(public=".") + firestore + emulators 설정
```

## 캐시 버전 규칙

ES 모듈 캐시 불일치를 막기 위해 모듈 URL에 `?v=N` 쿼리를 붙인다.
**모듈을 수정하면 해당 `?v=N`의 숫자를 올린다** (HTML `<script src>`와 내부 `import` 모두).
현재 버전: `firebase.js`/`beds.js` = `v=3`, `paramedic.js` = `v=3`, `hospital.js` = `v=4`.

## 로컬 실행

```powershell
# 1) 병상 프록시(Worker)  — worker/.dev.vars 에 DATA_GO_KR_SERVICE_KEY 필요
cd worker; npm install; npm run dev          # http://localhost:8787

# 2) Firebase 에뮬레이터 (Firestore 에뮬레이터는 Java 21+ 필요)
$env:JAVA_HOME = "C:\Users\rlaan\AppData\Local\Programs\jdk21\jdk-21.0.11+10"
firebase emulators:start                      # Hosting:5000, Firestore:8080, Auth:9099, UI:4000
# 브라우저: http://localhost:5000
```

> 로컬에서는 `app/firebase.js`가 hostname=localhost일 때 에뮬레이터에 자동 연결되어 **실제 키 없이도** 릴레이가 동작한다.

## 배포

```powershell
firebase deploy --only hosting --project emergency-145fe          # 정적 사이트
firebase deploy --only firestore:rules --project emergency-145fe  # 보안 규칙
cd worker; npx wrangler deploy                                    # Worker(프로덕션)
# 프로덕션 Worker 키:  npx wrangler secret put DATA_GO_KR_SERVICE_KEY
```

## ⚠️ 남은 작업 / 주의

- [x] **프로덕션 익명 로그인 활성화** — 2026-06-17 완료(콘솔에서 익명 Sign-in 사용 설정). 라이브 릴레이 동작 확인됨.
- [ ] bigdata-119 키 노출 이력 → **재발급** 후 사용(집계는 `$env:EMS_API_KEY`로만 주입).
- [ ] `app/ems-summary.json`은 샘플(800건)이라 미이송률 통계 신뢰도 낮음 → 제출 전 `--max-pages` 늘려 재집계.
- [ ] FCM 푸시(닫힌 앱 알람), 응급의료기관 종별(1·2·3차) API(`getEgytListInfoInqire`) 병합은 v2 과제.
- [ ] 운영 전 `firestore.rules` 권한 범위 축소(현재 프로토타입 수준).
