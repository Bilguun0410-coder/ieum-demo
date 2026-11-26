/* =========================================================
   이음 IEUM - ai.js
   Google Gemini API 연결 (생성형 AI)
   - AI가 하는 일: 서류 사진 읽기(재산 항목 추출), 상담 브리핑 초안, 용어·절차 도우미
   - AI가 하지 않는 일: 세액 계산, 유불리 판단, 법적 효력 판단 (지시 + 규칙 안전장치로 이중 차단)
   - 실제 서비스에서는 API 키를 서버가 보관해야 합니다. 이 시연판은 관리자가 기기에 직접 입력합니다.
   - 브라우저와 Node 공용 (tests/ai.test.js 에서 요청 형식·응답 검증·안전장치 확인)
   ========================================================= */
(function (root) {
  'use strict';

  const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/';
  // 기본값은 Google AI Studio의 기본 모델. 목록에 없는 모델은 관리자 화면에서 직접 입력할 수 있다.
  const MODELS = ['gemini-4-hydrogen', 'gemini-flash-latest', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
  const DEFAULT_MODEL = MODELS[0];
  // 고른 모델이 혼잡하면 한 번 더 시도할 예비 모델
  const FALLBACK_MODELS = ['gemini-3.5-flash-lite'];
  const ASSET_TYPES = ['부동산', '예금', '주식', '보험', '기타', '채무'];
  const CONFIDENCE = ['high', 'medium', 'low'];
  const MAX_AMOUNT = 9999999999999;
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
  const BLOCKED = '[전문가 확인이 필요한 내용이라 표시하지 않았습니다]';

  const SYSTEM_RULES = [
    '당신은 시니어(55~75세)의 상속·증여 준비를 돕는 "이음" 앱의 AI 도우미입니다.',
    '반드시 지킬 규칙:',
    '1. 상속세·증여세 등 세금 액수나 절세 효과를 계산하거나 추정하지 않습니다.',
    '2. 증여·상속·배분 방식 중 어느 쪽이 더 유리하거나 좋다고 판단하거나 권하지 않습니다.',
    '3. 유언이나 계약의 법적 효력, 누가 얼마를 받는지 같은 개별 법률 판단을 확정하지 않습니다.',
    '4. 개별 판단이 필요한 내용은 "세무사·변호사 등 전문가에게 확인하세요"라고 안내합니다.',
    '5. 이용자가 준 정보에 없는 사실이나 숫자를 지어내지 않습니다.',
    '6. 쉬운 우리말, 짧은 문장, 존댓말로 씁니다. 전문용어는 처음 나올 때 풀어 씁니다.'
  ].join('\n');

  // ---------- 안전장치: AI 출력에서 금지된 판단 문장을 걸러낸다 ----------
  const GUARDS = [
    { id: 'tax', label: '세금 액수·비율 추정', re: /(상속세|증여세|세금|세액|과세표준|절세)[^.\n]{0,30}?\d[\d,.]*\s*(원|만\s*원|억|%|퍼센트)/ },
    { id: 'tax2', label: '세금 액수·비율 추정', re: /\d[\d,.]*\s*(원|만\s*원|억)[^.\n]{0,20}?(상속세|증여세|세금|세액)\s*(이|가|을|를)?\s*(나|발생|부과|내|납부|줄|아낄)/ },
    { id: 'advice', label: '유불리 판단·권유', re: /(유리|불리|이득|손해)(합니다|해요|할 것|하다|한 편|할 수 있습니다|해 보입니다)|(하는 것이|하시는 것이|하시는 게|하는 게|쪽이)\s*(더\s*)?(좋|낫|바람직|유리)|(추천|권장)(합니다|드립니다|해요|드려요)/ },
    { id: 'legal', label: '법적 효력·몫 확정', re: /(유효|무효)(합니다|입니다|해요|예요)|효력이\s*(있습니다|없습니다|있어요|없어요)|(받을 수 있는|받게 되는|받으실)\s*(몫|금액|유류분)은\s*\d/ }
  ];

  function splitSentences(text) {
    return String(text)
      .replace(/\r/g, '')
      .split(/(?<=[.!?。])\s+|\n+/)
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
  }

  function screen(text) {
    const removed = [];
    const out = [];
    splitSentences(text).forEach(function (s) {
      const hit = GUARDS.find(function (g) { return g.re.test(s); });
      if (hit) {
        removed.push({ sentence: s, reason: hit.label });
        if (out[out.length - 1] !== BLOCKED) out.push(BLOCKED);
      } else out.push(s);
    });
    return { text: out.join(' '), removed: removed };
  }

  // ---------- 요청 만들기 ----------
  const EXTRACT_SCHEMA = {
    type: 'OBJECT',
    properties: {
      docType: { type: 'STRING' },
      note: { type: 'STRING' },
      items: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            type: { type: 'STRING', enum: ASSET_TYPES },
            name: { type: 'STRING' },
            value: { type: 'INTEGER' },
            asOf: { type: 'STRING' },
            evidence: { type: 'STRING' },
            confidence: { type: 'STRING', enum: CONFIDENCE }
          },
          required: ['type', 'name', 'value', 'asOf', 'evidence', 'confidence']
        }
      }
    },
    required: ['docType', 'items']
  };

  const EXTRACT_PROMPT = [
    '첨부한 문서에서 재산 또는 채무 항목을 찾아 JSON으로 정리하세요.',
    '- type: 부동산, 예금, 주식, 보험, 기타, 채무 중 하나 (대출·보증 등 갚을 돈은 채무)',
    '- name: 항목을 알아볼 짧은 이름. 계좌번호·주민등록번호·주소의 동·호수 같은 식별 정보는 쓰지 마세요.',
    '- value: 원 단위 정수 금액. 문서에 금액이 없으면 0',
    '- asOf: 그 금액의 기준일 YYYY-MM-DD. 문서에 없으면 빈 문자열',
    '- evidence: 그 금액을 읽은 문서 속 원문 문구를 그대로 (40자 이내)',
    '- confidence: 글자가 선명하고 확실하면 high, 일부 추정이면 medium, 불확실하면 low',
    'docType에는 문서 종류를 적으세요. 재산 문서가 아니거나 읽을 수 없으면 items를 빈 배열로 두고 note에 이유를 적으세요.',
    '보이지 않는 금액을 추측해서 만들지 마세요. 세금은 계산하지 마세요.'
  ].join('\n');

  function withSchema(body, schema) {
    const b = JSON.parse(JSON.stringify(body));
    b.generationConfig = b.generationConfig || {};
    b.generationConfig.responseMimeType = 'application/json';
    if (schema) b.generationConfig.responseSchema = schema;
    return b;
  }

  function buildExtractRequest(mimeType, base64, useSchema) {
    const body = {
      systemInstruction: { parts: [{ text: SYSTEM_RULES }] },
      contents: [{ role: 'user', parts: [{ inlineData: { mimeType: mimeType, data: base64 } }, { text: EXTRACT_PROMPT }] }],
      generationConfig: { temperature: 0 }
    };
    return withSchema(body, useSchema === false ? null : EXTRACT_SCHEMA);
  }

  const BRIEFING_SCHEMA = {
    type: 'OBJECT',
    properties: {
      summary: { type: 'STRING' },
      missing: { type: 'ARRAY', items: { type: 'STRING' } },
      questions: {
        type: 'ARRAY',
        items: { type: 'OBJECT', properties: { q: { type: 'STRING' }, why: { type: 'STRING' } }, required: ['q', 'why'] }
      }
    },
    required: ['summary', 'missing', 'questions']
  };

  function buildBriefingRequest(facts, useSchema) {
    const prompt = [
      '아래는 이용자가 직접 입력한 정보입니다(가명·가상 금액). 세무사·변호사 상담 전에 볼 "상담 준비 브리핑"을 써 주세요.',
      '- summary: 지금 준비 상황을 3~5문장으로 쉽게 요약 (입력에 있는 사실만)',
      '- missing: 상담 전에 더 챙기면 좋은 정보나 서류 2~4개',
      '- questions: 전문가에게 물어볼 질문 4~6개. q는 질문, why는 그 질문이 필요한 이유 한 문장',
      '세금 액수 계산, 유불리 판단, 법적 효력 판단은 하지 마세요.',
      '',
      '입력 정보(JSON):',
      JSON.stringify(facts)
    ].join('\n');
    const body = {
      systemInstruction: { parts: [{ text: SYSTEM_RULES }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3 }
    };
    return withSchema(body, useSchema === false ? null : BRIEFING_SCHEMA);
  }

  // history: [{role:'user'|'model', text}]
  function buildChatRequest(history, question, facts) {
    const contents = [];
    (history || []).slice(-8).forEach(function (m) {
      if (m && (m.role === 'user' || m.role === 'model') && m.text) {
        contents.push({ role: m.role, parts: [{ text: String(m.text).slice(0, 2000) }] });
      }
    });
    let q = String(question).slice(0, 500);
    if (facts) q = '[참고: 내가 앱에 입력한 정보(가명) ' + JSON.stringify(facts) + ']\n' + q;
    contents.push({ role: 'user', parts: [{ text: q }] });
    return {
      systemInstruction: {
        parts: [{ text: SYSTEM_RULES + '\n7. 답은 5문장 이내로 짧게 합니다. 목록이 필요하면 3개 이내로 씁니다. 마크다운 기호(*, #)는 쓰지 않습니다.' }]
      },
      contents: contents,
      generationConfig: { temperature: 0.4 }
    };
  }

  // ---------- 응답 읽기 ----------
  function responseText(data) {
    if (!data || typeof data !== 'object') return { ok: false, code: 'empty', error: 'AI 응답이 비어 있습니다.' };
    if (data.promptFeedback && data.promptFeedback.blockReason) {
      return { ok: false, code: 'blocked', error: 'AI 안전 정책에 의해 요청이 차단되었습니다. (' + data.promptFeedback.blockReason + ')' };
    }
    const c = data.candidates && data.candidates[0];
    if (!c) return { ok: false, code: 'empty', error: 'AI가 답을 만들지 못했습니다. 다시 시도하세요.' };
    const parts = (c.content && c.content.parts) || [];
    const text = parts
      .filter(function (p) { return p && typeof p.text === 'string' && !p.thought; })
      .map(function (p) { return p.text; })
      .join('')
      .trim();
    if (!text) {
      if (c.finishReason === 'SAFETY' || c.finishReason === 'PROHIBITED_CONTENT') {
        return { ok: false, code: 'blocked', error: 'AI 안전 정책에 의해 답변이 차단되었습니다.' };
      }
      return { ok: false, code: 'empty', error: 'AI가 답을 만들지 못했습니다. (' + (c.finishReason || '사유 없음') + ')' };
    }
    return { ok: true, text: text, usage: data.usageMetadata || null };
  }

  function parseJsonText(text) {
    let t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a < 0 || b < a) return null;
    try {
      return JSON.parse(t.slice(a, b + 1));
    } catch (e) {
      return null;
    }
  }

  function str(v, max) {
    return typeof v === 'string' ? v.trim().slice(0, max) : '';
  }

  function validDate(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const p = s.split('-').map(Number);
    const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    return d.getUTCFullYear() === p[0] && d.getUTCMonth() === p[1] - 1 && d.getUTCDate() === p[2];
  }

  // 계좌번호처럼 긴 숫자 묶음은 가린다.
  function maskIds(s) {
    return String(s).replace(/\d[\d-]{6,}\d/g, '••••');
  }

  function toAmount(v) {
    if (typeof v === 'string') v = Number(v.replace(/[^\d.-]/g, ''));
    if (typeof v !== 'number' || !isFinite(v)) return null;
    v = Math.round(v);
    return v >= 0 && v <= MAX_AMOUNT ? v : null;
  }

  function parseExtract(text) {
    const obj = parseJsonText(text);
    if (!obj || !Array.isArray(obj.items)) return { ok: false, error: 'AI 응답을 읽지 못했습니다. 다시 시도하세요.' };
    const items = [];
    let dropped = 0;
    obj.items.slice(0, 30).forEach(function (it) {
      const type = it && ASSET_TYPES.indexOf(it.type) >= 0 ? it.type : null;
      const name = it && maskIds(str(it.name, 60));
      const value = it ? toAmount(it.value) : null;
      if (!type || !name || value === null) {
        dropped++;
        return;
      }
      items.push({
        type: type,
        name: name,
        value: value,
        asOf: validDate(it.asOf) ? it.asOf : '',
        evidence: maskIds(str(it.evidence, 80)),
        confidence: CONFIDENCE.indexOf(it.confidence) >= 0 ? it.confidence : 'low'
      });
    });
    return { ok: true, docType: str(obj.docType, 40), note: str(obj.note, 200), items: items, dropped: dropped };
  }

  function parseBriefing(text) {
    const obj = parseJsonText(text);
    if (!obj || typeof obj.summary !== 'string') return { ok: false, error: 'AI 응답을 읽지 못했습니다. 다시 시도하세요.' };
    const removed = [];
    function clean(s, max) {
      const r = screen(str(s, max));
      Array.prototype.push.apply(removed, r.removed);
      return r.text;
    }
    const summary = clean(obj.summary, 1200);
    const missing = (Array.isArray(obj.missing) ? obj.missing : []).slice(0, 6).map(function (m) { return clean(m, 200); }).filter(Boolean);
    const questions = (Array.isArray(obj.questions) ? obj.questions : [])
      .slice(0, 8)
      .map(function (q) { return q && { q: clean(q.q, 200), why: clean(q.why, 200) }; })
      .filter(function (q) { return q && q.q && q.q !== BLOCKED; });
    return { ok: true, summary: summary, missing: missing, questions: questions, removed: removed };
  }

  function parseChat(text) {
    const plain = String(text).replace(/\*\*/g, '').replace(/^#+\s*/gm, '').replace(/^\s*[*-]\s+/gm, '· ');
    const r = screen(plain);
    return { ok: true, text: r.text, removed: r.removed };
  }

  // ---------- 호출 ----------
  // 화면에 보여줄 원인 문구에서 키처럼 생긴 글자를 가린다.
  function cleanDetail(message, key) {
    let m = String(message || '').replace(/AIza[0-9A-Za-z_-]{10,}/g, '(키 가림)');
    if (key && key.length >= 8) m = m.split(key).join('(키 가림)');
    return m.replace(/\s+/g, ' ').trim().slice(0, 160);
  }

  function errorFor(status, message) {
    const m = String(message || '');
    const base = baseError(status, m);
    base.error += ' [HTTP ' + status + (m ? ': ' + m : '') + ']';
    return base;
  }

  function baseError(status, m) {
    if (status === 400 && /api key|API_KEY/i.test(m)) return { code: 'key', error: 'API 키가 올바르지 않습니다. 관리자 > AI 설정에서 다시 입력하세요.' };
    if (status === 400 && /schema|response_schema|responseSchema|Invalid JSON payload/i.test(m)) return { code: 'schema', error: '요청 형식이 이 모델과 맞지 않습니다.' };
    if (status === 400) return { code: 'bad', error: 'AI 요청이 거절되었습니다.' };
    if (status === 401 || status === 403) return { code: 'key', error: 'API 키가 올바르지 않거나 차단되었습니다. 관리자 > AI 설정에서 확인하세요.' };
    if (status === 404) return { code: 'model', error: '모델을 찾을 수 없습니다. 관리자 > AI 설정에서 다른 모델을 고르세요.' };
    if (status === 429) return { code: 'quota', error: '무료 사용량을 넘었습니다. 1분 뒤 다시 시도하거나 다른 모델을 고르세요.' };
    if (status >= 500) return { code: 'server', error: 'AI 서버가 잠시 응답하지 않습니다. 잠시 뒤 다시 시도하세요.' };
    return { code: 'http', error: 'AI 요청 실패 (HTTP ' + status + ')' };
  }

  function wait(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function busy(r) {
    return !r.ok && (r.code === 'server' || r.code === 'quota' || r.code === 'timeout');
  }

  // 고른 모델로 재시도까지 실패하면(혼잡·한도·시간 초과) 예비 모델로 한 번 더 보낸다.
  async function call(opts) {
    let r = await callWithRetries(opts);
    const first = opts.model;
    const fallbacks = (Array.isArray(opts.fallbackModels) ? opts.fallbackModels : FALLBACK_MODELS).filter(function (m) { return m !== first; });
    for (let i = 0; i < fallbacks.length && busy(r); i++) {
      if (opts.onFallback) opts.onFallback(fallbacks[i], r);
      r = await callWithRetries(Object.assign({}, opts, { model: fallbacks[i], retryDelays: [2000] }));
    }
    return r;
  }

  // 혼잡(5xx)·일시적 한도(429)면 잠시 뒤 다시 보낸다. 같은 내용을 다시 보낼 뿐 추가 정보는 없다.
  async function callWithRetries(opts) {
    const delays = Array.isArray(opts.retryDelays) ? opts.retryDelays : [2000, 5000];
    const sleep = opts.sleep || wait;
    let r = await callOnce(opts);
    for (let i = 0; i < delays.length && !r.ok && (r.code === 'server' || r.code === 'quota'); i++) {
      if (opts.onRetry) opts.onRetry(i + 1, delays.length, r);
      await sleep(delays[i]);
      r = await callOnce(opts);
    }
    return r;
  }

  async function callOnce(opts) {
    const key = String(opts.key || '').trim();
    if (!key) return { ok: false, code: 'nokey', error: 'AI 연결이 설정되지 않았습니다. 관리자 > AI 설정에서 API 키를 입력하세요.' };
    const model = MODELS.indexOf(opts.model) >= 0 || /^[a-z0-9][a-z0-9.-]{2,60}$/.test(opts.model || '') ? opts.model : DEFAULT_MODEL;
    const doFetch = opts.fetch || (typeof fetch !== 'undefined' ? fetch.bind(root) : null);
    if (!doFetch) return { ok: false, code: 'network', error: '이 환경에서는 AI를 호출할 수 없습니다.' };
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(function () { ctrl.abort(); }, opts.timeoutMs || 60000) : null;
    let res;
    try {
      res = await doFetch(ENDPOINT + encodeURIComponent(model) + ':generateContent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(opts.body),
        signal: ctrl ? ctrl.signal : undefined
      });
    } catch (e) {
      if (timer) clearTimeout(timer);
      if (e && e.name === 'AbortError') return { ok: false, code: 'timeout', error: 'AI 응답이 너무 오래 걸려 중단했습니다. 다시 시도하세요.' };
      return { ok: false, code: 'network', error: '인터넷 연결 또는 브라우저 보안 설정 때문에 AI 서버에 연결하지 못했습니다.' };
    }
    if (timer) clearTimeout(timer);
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      data = null;
    }
    if (!res.ok) {
      const msg = cleanDetail(data && data.error && data.error.message, key);
      return Object.assign({ ok: false, status: res.status }, errorFor(res.status, msg));
    }
    const out = responseText(data);
    if (out.ok) out.model = model;
    return out;
  }

  // 구조화 응답(JSON 스키마)을 지원하지 않는 모델이면 스키마 없이 한 번 더 시도한다.
  async function callJson(opts, buildBody) {
    let r = await call(Object.assign({}, opts, { body: buildBody(true) }));
    if (!r.ok && r.code === 'schema') r = await call(Object.assign({}, opts, { body: buildBody(false) }));
    return r;
  }

  async function extract(opts, mimeType, base64) {
    const r = await callJson(opts, function (s) { return buildExtractRequest(mimeType, base64, s); });
    if (!r.ok) return r;
    const p = parseExtract(r.text);
    if (!p.ok) return { ok: false, code: 'parse', error: p.error };
    return Object.assign(p, { model: r.model });
  }

  async function briefing(opts, facts) {
    const r = await callJson(opts, function (s) { return buildBriefingRequest(facts, s); });
    if (!r.ok) return r;
    const p = parseBriefing(r.text);
    if (!p.ok) return { ok: false, code: 'parse', error: p.error };
    return Object.assign(p, { model: r.model });
  }

  async function chat(opts, history, question, facts) {
    const r = await call(Object.assign({}, opts, { body: buildChatRequest(history, question, facts) }));
    if (!r.ok) return r;
    return Object.assign(parseChat(r.text), { model: r.model });
  }

  // 연결 테스트는 고른 모델 자체를 확인하므로 예비 모델로 바꾸지 않는다.
  async function ping(opts) {
    const r = await call(Object.assign({}, opts, { fallbackModels: [] }, {
      body: { contents: [{ role: 'user', parts: [{ text: '연결 확인입니다. "연결됨"이라고만 답하세요.' }] }], generationConfig: { temperature: 0 } }
    }));
    return r.ok ? { ok: true, model: r.model, text: r.text.slice(0, 40) } : r;
  }

  const api = {
    ENDPOINT: ENDPOINT,
    MODELS: MODELS,
    DEFAULT_MODEL: DEFAULT_MODEL,
    FALLBACK_MODELS: FALLBACK_MODELS,
    MAX_IMAGE_BYTES: MAX_IMAGE_BYTES,
    BLOCKED: BLOCKED,
    SYSTEM_RULES: SYSTEM_RULES,
    GUARDS: GUARDS,
    screen: screen,
    maskIds: maskIds,
    buildExtractRequest: buildExtractRequest,
    buildBriefingRequest: buildBriefingRequest,
    buildChatRequest: buildChatRequest,
    responseText: responseText,
    parseJsonText: parseJsonText,
    parseExtract: parseExtract,
    parseBriefing: parseBriefing,
    parseChat: parseChat,
    errorFor: errorFor,
    cleanDetail: cleanDetail,
    call: call,
    extract: extract,
    briefing: briefing,
    chat: chat,
    ping: ping
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.IEUM_AI = api;
})(typeof window !== 'undefined' ? window : globalThis);
