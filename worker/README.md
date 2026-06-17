# Emergency Bed Proxy Worker

Firebase Spark Hosting은 서버 코드를 실행할 수 없으므로, 공공데이터 API 호출은 Cloudflare Workers 무료 플랜에서 처리합니다.

## 설정

1. Cloudflare에 로그인합니다.

   ```powershell
   cd worker
   npm install
   npx wrangler login
   ```

2. 공공데이터 서비스키를 Worker Secret으로 저장합니다.

   ```powershell
   npx wrangler secret put DATA_GO_KR_SERVICE_KEY
   ```

   프롬프트가 뜨면 공공데이터 포털 서비스키를 붙여넣습니다. 인코딩된 키와 디코딩된 키 모두 처리합니다.

3. `wrangler.toml`의 `ALLOWED_ORIGINS`에 실제 Firebase Hosting 도메인을 넣습니다.

4. Worker를 배포합니다.

   ```powershell
   npm run deploy
   ```

5. 배포 출력에 나온 주소를 `emergency.js`의 `WORKER_API_ENDPOINT`에 반영합니다.

   예:

   ```js
   const WORKER_API_ENDPOINT = 'https://emergency-bed-proxy.emergency-145fe.workers.dev/api/emergency-beds';
   ```

## 로컬 테스트

로컬에서 Worker를 먼저 실행합니다.

```powershell
copy .dev.vars.example .dev.vars
notepad .dev.vars
npm run dev
```

Firebase Hosting 로컬 서버는 별도 터미널에서 실행합니다.

```powershell
firebase emulators:start --only hosting
```
