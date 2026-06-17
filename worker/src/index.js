const BASE_URL = 'https://apis.data.go.kr/B552657/ErmctInfoInqireService/getEmrrmRltmUsefulSckbdInfoInqire';

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

function isOriginAllowed(request, env) {
  const origin = request.headers.get('Origin');
  const allowedOrigins = parseAllowedOrigins(env);

  return !origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin);
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

async function handleEmergencyBeds(request, env, corsHeaders) {
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
  const upstreamUrl = new URL(BASE_URL);

  upstreamUrl.searchParams.set('serviceKey', serviceKey);
  upstreamUrl.searchParams.set('_type', 'xml');
  upstreamUrl.searchParams.set('numOfRows', normalizeNumOfRows(firstParam(requestUrl, 'numOfRows')));

  if (sido) upstreamUrl.searchParams.set('STAGE1', sido);
  if (gu) upstreamUrl.searchParams.set('STAGE2', gu);

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

    if (url.pathname !== '/api/emergency-beds') {
      return textResponse('Not Found', 404, corsHeaders);
    }

    try {
      return await handleEmergencyBeds(request, env, corsHeaders);
    } catch (error) {
      console.error('Emergency bed proxy failed', error);
      return textResponse('공공데이터 API 요청에 실패했습니다.', 502, corsHeaders);
    }
  },
};
