const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../ai.js');

function geminiReply(text, extra) {
  return Object.assign({ candidates: [{ content: { parts: [{ text: text }] }, finishReason: 'STOP' }] }, extra || {});
}
function fakeFetch(handler) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url: url, init: init, body: JSON.parse(init.body) });
    const r = handler(calls.length, url, init);
    return { ok: r.status === 200, status: r.status, json: async () => r.body };
  };
  f.calls = calls;
  return f;
}

test('안전장치: 세액 추정·유불리 권유·효력 단정 문장을 가린다', () => {
  const r = A.screen('사전증여는 합산될 수 있습니다. 이 경우 상속세가 약 3,000만원 나옵니다. 지금 증여하는 것이 더 유리합니다. 그 유언은 무효입니다. 전문가와 확인하세요.');
  assert.equal(r.removed.length, 3);
  assert.match(r.text, /^사전증여는 합산될 수 있습니다\./);
  assert.match(r.text, /전문가와 확인하세요\.$/);
  assert.equal(r.text.split(A.BLOCKED).length - 1, 1, '연속된 가림 표시는 하나로 합친다');
  assert.doesNotMatch(r.text, /3,000만원|유리합니다|무효입니다/);
});

test('안전장치: 일반 설명은 통과시킨다', () => {
  const ok = [
    '상속인은 사망 전 10년 이내 증여가 합산 검토 대상입니다.',
    '법정 방식을 지키지 않으면 무효가 될 수 있으니 전문가와 확인하세요.',
    '예금 5,000만원의 기준일을 확인해 두세요.',
    '유류분은 상속인에게 법이 보장하는 최소한의 몫을 말합니다.'
  ];
  ok.forEach((s) => assert.equal(A.screen(s).removed.length, 0, s));
});

test('요청 형식: 서류 읽기는 이미지 + 지시문 + JSON 스키마', () => {
  const b = A.buildExtractRequest('image/jpeg', 'QUJD');
  assert.equal(b.contents[0].parts[0].inlineData.mimeType, 'image/jpeg');
  assert.equal(b.contents[0].parts[0].inlineData.data, 'QUJD');
  assert.match(b.contents[0].parts[1].text, /재산 또는 채무/);
  assert.equal(b.generationConfig.responseMimeType, 'application/json');
  assert.equal(b.generationConfig.responseSchema.properties.items.items.properties.type.enum.length, 6);
  assert.match(b.systemInstruction.parts[0].text, /세금 액수/);
  assert.equal(A.buildExtractRequest('image/png', 'x', false).generationConfig.responseSchema, undefined);
});

test('요청 형식: 도우미는 대화 기록 8개까지, 내 정보는 선택 시에만', () => {
  const hist = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'model' : 'user', text: 'm' + i }));
  const b = A.buildChatRequest(hist, '유류분이 뭐예요?', null);
  assert.equal(b.contents.length, 9);
  assert.equal(b.contents.at(-1).parts[0].text, '유류분이 뭐예요?');
  const c = A.buildChatRequest([], '질문', { 가족: 2 });
  assert.match(c.contents[0].parts[0].text, /^\[참고:/);
});

test('서류 읽기 응답: 형식 검증, 계좌번호 가림, 잘못된 항목 제외', () => {
  const r = A.parseExtract('```json\n' + JSON.stringify({
    docType: '예금 잔액 증명서',
    items: [
      { type: '예금', name: '정기예금 110-234-567890', value: 50000000, asOf: '2026-11-20', evidence: '잔액 50,000,000원', confidence: 'high' },
      { type: '예금', name: '보통예금', value: '3,200,000', asOf: '2026-13-01', evidence: '', confidence: 'zzz' },
      { type: '현금다발', name: '이상한 것', value: 1, asOf: '', evidence: '', confidence: 'low' },
      { type: '채무', name: '', value: 1, asOf: '', evidence: '', confidence: 'low' },
      { type: '주식', name: '음수', value: -5, asOf: '', evidence: '', confidence: 'low' }
    ]
  }) + '\n```');
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 2);
  assert.equal(r.dropped, 3);
  assert.equal(r.items[0].name, '정기예금 ••••');
  assert.equal(r.items[1].value, 3200000);
  assert.equal(r.items[1].asOf, '');
  assert.equal(r.items[1].confidence, 'low');
  assert.equal(A.parseExtract('엉뚱한 글').ok, false);
});

test('브리핑 응답: 안전장치를 거친 뒤 걸러진 문장 수를 알려준다', () => {
  const r = A.parseBriefing(JSON.stringify({
    summary: '가족 3명과 재산 3건을 정리했습니다. 상속세는 약 2억원이 예상됩니다.',
    missing: ['주식 잔고 확인서'],
    questions: [{ q: '합산 대상 증여는 어떻게 확인하나요?', why: '최근 10년 증여가 있습니다.' }, { q: '지금 증여하는 것이 더 유리합니다.', why: 'x' }]
  }));
  assert.equal(r.ok, true);
  assert.equal(r.removed.length, 2);
  assert.doesNotMatch(r.summary, /2억원/);
  assert.equal(r.questions.length, 1);
});

test('응답 해석: 차단·빈 응답·생각(thought) 부분 제외', () => {
  assert.equal(A.responseText({ promptFeedback: { blockReason: 'SAFETY' } }).code, 'blocked');
  assert.equal(A.responseText({ candidates: [] }).code, 'empty');
  assert.equal(A.responseText({ candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] }).code, 'blocked');
  const t = A.responseText({ candidates: [{ content: { parts: [{ text: '속생각', thought: true }, { text: '답' }] } }] });
  assert.equal(t.text, '답');
});

test('호출: 키가 없으면 네트워크 요청을 하지 않는다', async () => {
  const f = fakeFetch(() => ({ status: 200, body: geminiReply('x') }));
  const r = await A.call({ key: '  ', fetch: f, body: {} });
  assert.equal(r.code, 'nokey');
  assert.equal(f.calls.length, 0);
});

test('호출: 주소·헤더·모델 이름이 올바르다', async () => {
  const f = fakeFetch(() => ({ status: 200, body: geminiReply('연결됨') }));
  const r = await A.ping({ key: 'TESTKEY', model: 'gemini-3.5-flash-lite', fetch: f });
  assert.equal(r.ok, true);
  assert.equal(f.calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');
  assert.equal(f.calls[0].init.headers['x-goog-api-key'], 'TESTKEY');
  assert.doesNotMatch(f.calls[0].url, /TESTKEY/, '키를 주소에 넣지 않는다');
  const bad = await A.ping({ key: 'K', model: '../evil', fetch: f });
  assert.equal(bad.ok, true);
  assert.match(f.calls[1].url, /gemini-4-hydrogen/);
});

test('호출: HTTP 오류를 한국어 안내로 바꾼다', async () => {
  for (const [status, code] of [[403, 'key'], [404, 'model'], [429, 'quota'], [503, 'server']]) {
    const f = fakeFetch(() => ({ status: status, body: { error: { message: 'x' } } }));
    const r = await A.ping({ key: 'K', fetch: f, sleep: async () => {} });
    assert.equal(r.ok, false);
    assert.equal(r.code, code);
  }
  const net = await A.ping({ key: 'K', fetch: async () => { throw new TypeError('Failed to fetch'); }, sleep: async () => {} });
  assert.equal(net.code, 'network');
});

test('호출: 스키마를 거절하면 스키마 없이 한 번 더 시도한다', async () => {
  const f = fakeFetch((n) =>
    n === 1
      ? { status: 400, body: { error: { message: 'Invalid JSON payload received. Unknown name "responseSchema"' } } }
      : { status: 200, body: geminiReply(JSON.stringify({ docType: 'x', items: [{ type: '예금', name: '예금', value: 1000, asOf: '2026-01-01', evidence: '1,000원', confidence: 'high' }] })) }
  );
  const r = await A.extract({ key: 'K', fetch: f }, 'image/png', 'AAAA');
  assert.equal(r.ok, true);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls[0].body.generationConfig.responseSchema);
  assert.equal(f.calls[1].body.generationConfig.responseSchema, undefined);
  assert.equal(r.items[0].value, 1000);
});

test('도우미 응답: 마크다운 기호 정리 + 안전장치', async () => {
  const f = fakeFetch(() => ({ status: 200, body: geminiReply('**유류분**은 최소한의 몫입니다.\n* 첫째\n지금 증여하시는 게 더 좋습니다.') }));
  const r = await A.chat({ key: 'K', fetch: f }, [], '유류분?', null);
  assert.equal(r.ok, true);
  assert.doesNotMatch(r.text, /\*\*/);
  assert.equal(r.removed.length, 1);
});

test('호출: 혼잡(503)이면 두 번까지 다시 시도하고, 성공하면 결과를 돌려준다', async () => {
  const f = fakeFetch((n) => (n < 3 ? { status: 503, body: { error: { message: 'This model is currently experiencing high demand.' } } } : { status: 200, body: geminiReply('연결됨') }));
  const retries = [];
  const r = await A.ping({ key: 'K', fetch: f, sleep: async () => {}, onRetry: (i, n) => retries.push(i + '/' + n) });
  assert.equal(r.ok, true);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(retries, ['1/2', '2/2']);
  assert.deepEqual(f.calls[0].body, f.calls[2].body, '같은 내용을 다시 보낸다');
});

test('호출: 다시 시도해도 실패하면 Google 원인 문구를 붙여 알려준다 (키는 가림)', async () => {
  const key = 'AIzaSyTESTKEY1234567890';
  const f = fakeFetch(() => ({ status: 503, body: { error: { message: 'High demand for key ' + key + ' and AIzaOtherKey9999999999' } } }));
  const r = await A.ping({ key: key, fetch: f, sleep: async () => {} });
  assert.equal(f.calls.length, 3);
  assert.equal(r.code, 'server');
  assert.match(r.error, /HTTP 503: High demand/);
  assert.doesNotMatch(r.error, /AIza/);
});

test('호출: 키 오류(403)는 다시 시도하지 않는다', async () => {
  const f = fakeFetch(() => ({ status: 403, body: { error: { message: 'API key not valid' } } }));
  await A.ping({ key: 'K', fetch: f, sleep: async () => {} });
  assert.equal(f.calls.length, 1);
});

test('호출: 재시도까지 혼잡하면 예비 모델로 바꿔 한 번 더 시도한다', async () => {
  const f = fakeFetch((n, url) => (/gemini-4-hydrogen/.test(url) ? { status: 503, body: { error: { message: 'high demand' } } } : { status: 200, body: geminiReply('답') }));
  const used = [];
  const r = await A.chat({ key: 'K', model: 'gemini-4-hydrogen', fetch: f, sleep: async () => {}, onFallback: (m) => used.push(m) }, [], '질문', null);
  assert.equal(r.ok, true);
  assert.equal(r.model, 'gemini-3.5-flash-lite');
  assert.deepEqual(used, ['gemini-3.5-flash-lite']);
  assert.equal(f.calls.length, 4, '원래 모델 3번 + 예비 모델 1번');
});

test('호출: 키 오류나 연결 테스트는 예비 모델로 바꾸지 않는다', async () => {
  const f1 = fakeFetch(() => ({ status: 403, body: { error: { message: 'bad key' } } }));
  await A.chat({ key: 'K', model: 'gemini-4-hydrogen', fetch: f1, sleep: async () => {} }, [], '질문', null);
  assert.equal(f1.calls.length, 1);
  const f2 = fakeFetch(() => ({ status: 503, body: { error: { message: 'high demand' } } }));
  await A.ping({ key: 'K', model: 'gemini-4-hydrogen', fetch: f2, sleep: async () => {} });
  assert.ok(f2.calls.every((c) => /gemini-4-hydrogen/.test(c.url)));
});
