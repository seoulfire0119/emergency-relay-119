const SERVICE_BASE = 'https://apis.data.go.kr/B552657/ErmctInfoInqireService';

// 공개 경로 → 공공데이터 오퍼레이션 + 시도/시군구 파라미터 이름
const ROUTES = {
  // 응급실 실시간 가용병상
  '/api/emergency-beds': { op: 'getEmrrmRltmUsefulSckbdInfoInqire', sidoParam: 'STAGE1', guParam: 'STAGE2' },
  // 응급의료기관 목록 (좌표 wgs84Lat/Lon, 종별 dutyEmclsName) — 거리순 정렬용
  '/api/emergency-list': { op: 'getEgytListInfoInqire', sidoParam: 'Q0', guParam: 'Q1' },
  // 중증질환자 수용가능정보 (MKioskTy1~28: 재관류중재술·뇌출혈수술·응급투석 등 Y/불가능/정보미제공)
  '/api/emergency-severe': { op: 'getSrsillDissAceptncPosblInfoInqire', sidoParam: 'STAGE1', guParam: 'STAGE2' },
};

function textResponse(message, status, headers) {
  return new Response(message, {
    status,
    headers: {
      ...headers,
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function parseAllowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
}

function buildCorsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowedOrigins = parseAllowedOrigins(env);
  const allowAnyOrigin = allowedOrigins.includes('*');
  const headers = {
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };

  if (allowAnyOrigin) {
    headers['Access-Control-Allow-Origin'] = '*';
    return headers;
  }

  if (origin && allowedOrigins.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers.Vary = 'Origin';
  }

  return headers;
}

// Origin 이 없는 요청(curl·스크립트)도 막는다 — 그대로 두면 누구나 이 프록시로
// 공공데이터 키의 하루 호출 한도를 써 버릴 수 있다.
function isOriginAllowed(request, env) {
  const origin = request.headers.get('Origin');
  const allowedOrigins = parseAllowedOrigins(env);

  if (allowedOrigins.includes('*')) return true;
  return !!origin && allowedOrigins.includes(origin);
}

function firstParam(url, name) {
  return String(url.searchParams.get(name) || '').trim();
}

function normalizeServiceKey(value) {
  const trimmed = String(value || '').trim();

  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
}

function normalizeNumOfRows(value) {
  const rows = Number.parseInt(value, 10);

  if (!Number.isFinite(rows)) return '1000';
  return String(Math.min(Math.max(rows, 1), 1000));
}

async function handleProxy(route, request, env, corsHeaders) {
  if (!isOriginAllowed(request, env)) {
    return textResponse('Origin is not allowed.', 403, corsHeaders);
  }

  const serviceKey = normalizeServiceKey(env.DATA_GO_KR_SERVICE_KEY);

  if (!serviceKey) {
    return textResponse('DATA_GO_KR_SERVICE_KEY secret is not configured.', 500, corsHeaders);
  }

  const requestUrl = new URL(request.url);
  const sido = firstParam(requestUrl, 'sido');
  const gu = firstParam(requestUrl, 'gu');
  const upstreamUrl = new URL(`${SERVICE_BASE}/${route.op}`);

  upstreamUrl.searchParams.set('serviceKey', serviceKey);
  upstreamUrl.searchParams.set('_type', 'xml');
  upstreamUrl.searchParams.set('numOfRows', normalizeNumOfRows(firstParam(requestUrl, 'numOfRows')));

  if (sido) upstreamUrl.searchParams.set(route.sidoParam, sido);
  if (gu) upstreamUrl.searchParams.set(route.guParam, gu);

  const upstreamResponse = await fetch(upstreamUrl.toString(), {
    headers: {
      Accept: 'application/xml,text/xml,*/*',
    },
    cf: {
      cacheTtl: 30,
      cacheEverything: true,
    },
  });

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    headers: {
      ...corsHeaders,
      'Content-Type': upstreamResponse.headers.get('Content-Type') || 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=30',
    },
  });
}

export default {
  async fetch(request, env) {
    const corsHeaders = buildCorsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    if (request.method !== 'GET') {
      return textResponse('Method Not Allowed', 405, {
        ...corsHeaders,
        Allow: 'GET',
      });
    }

    const url = new URL(request.url);

    const route = ROUTES[url.pathname];
    if (!route) {
      return textResponse('Not Found', 404, corsHeaders);
    }

    try {
      return await handleProxy(route, request, env, corsHeaders);
    } catch (error) {
      console.error('Emergency bed proxy failed', error);
      return textResponse('공공데이터 API 요청에 실패했습니다.', 502, corsHeaders);
    }
  },
};
