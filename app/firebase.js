// Firebase 초기화 (공용 모듈)
// 로컬(localhost/127.0.0.1)에서는 Firestore/Auth 에뮬레이터에 자동 연결됩니다.
// 실제 배포 시에는 아래 firebaseConfig 값을 콘솔에서 발급받은 값으로 교체하세요.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
    getFirestore,
    connectFirestoreEmulator,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import {
    getAuth,
    connectAuthEmulator,
    signInAnonymously,
    onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

// Firebase 콘솔 > 프로젝트 설정 > 웹 앱 config (apiKey는 비밀키가 아니며 클라이언트 노출이 정상 — 보안은 firestore.rules로 처리)
const firebaseConfig = {
    apiKey: 'AIzaSyAgk4aeg8UNm0mjaqT2oJ3llO4RQM4O6Z4',
    authDomain: 'emergency-145fe.firebaseapp.com',
    projectId: 'emergency-145fe',
    storageBucket: 'emergency-145fe.firebasestorage.app',
    messagingSenderId: '960503778483',
    appId: '1:960503778483:web:4cfce4470c845c8fe2f4c6',
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

const isLocal = ['localhost', '127.0.0.1'].includes(window.location.hostname);

if (isLocal) {
    // 로컬 개발: 에뮬레이터 연결 (실제 키 없이도 동작)
    try {
        connectFirestoreEmulator(db, '127.0.0.1', 8080);
        connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
        console.info('[firebase] 에뮬레이터에 연결되었습니다 (Firestore:8080, Auth:9099)');
    } catch (e) {
        console.warn('[firebase] 에뮬레이터 연결 실패(이미 연결됨일 수 있음):', e?.message);
    }
}

// 익명 로그인으로 간편하게 사용자 식별 (프로토타입용)
function ensureSignedIn() {
    return new Promise((resolve, reject) => {
        onAuthStateChanged(auth, (user) => {
            if (user) {
                resolve(user);
            } else {
                signInAnonymously(auth).catch(reject);
            }
        });
    });
}

export { app, db, auth, ensureSignedIn, isLocal };
