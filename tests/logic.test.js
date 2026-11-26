// 실행: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../logic.js');

const TODAY = '2026-11-26';

test('parseDate: 실제 달력에 없는 날짜와 잘못된 형식은 거부한다', () => {
  assert.ok(L.parseDate('2026-11-26'));
  assert.equal(L.parseDate('2026-02-30'), null);
  assert.equal(L.parseDate('2026-13-01'), null);
  assert.equal(L.parseDate('2026-1-1'), null);
  assert.equal(L.parseDate(''), null);
  assert.equal(L.parseDate(20261126), null);
});

test('addYears: 윤년 2월 29일은 대상 연도의 말일로 맞춘다', () => {
  assert.equal(L.addYears('2024-02-29', 1), '2025-02-28');
  assert.equal(L.addYears('2024-02-29', 4), '2028-02-29');
  assert.equal(L.addYears(TODAY, -10), '2016-11-26');
  assert.equal(L.addYears('잘못된값', 1), '');
});

test('daysBetween / addDays', () => {
  assert.equal(L.daysBetween('2026-11-25', '2026-11-26'), 1);
  assert.equal(L.daysBetween('2025-11-26', '2026-11-26'), 365);
  assert.equal(L.addDays(TODAY, -30), '2026-10-27');
  assert.ok(Number.isNaN(L.daysBetween('x', TODAY)));
});

test('koreanAmount: 큰 금액을 한글 단위로 읽기 쉽게 표시한다', () => {
  assert.equal(L.koreanAmount(0), '0원');
  assert.equal(L.koreanAmount(1234), '1,234원');
  assert.equal(L.koreanAmount(100000000), '1억원');
  assert.equal(L.koreanAmount(550000000), '5억 5,000만원');
  assert.equal(L.koreanAmount(9999999999999), '9조 9,999억 9,999만 9,999원');
  assert.equal(L.formatKRW(1234567), '1,234,567원');
});

test('escapeHTML: 태그와 따옴표를 모두 치환한다', () => {
  assert.equal(L.escapeHTML('<img src=x onerror="a()">&\''), '&lt;img src=x onerror=&quot;a()&quot;&gt;&amp;&#39;');
});

test('reviewGifts: 상속인 10년·그 외 5년 경계와 포함 규칙', () => {
  const families = [{ id: 'c1', name: '자녀', relation: '자녀' }, { id: 'p1', name: '부모', relation: '부모' }];
  const gifts = [
    { id: '1', toType: 'family', toId: 'c1', toName: '', date: '2016-11-26', value: 1 }, // 정확히 10년 전: 포함
    { id: '2', toType: 'family', toId: 'c1', toName: '', date: '2016-11-25', value: 1 }, // 하루 지남: 제외
    { id: '3', toType: 'other', toId: '', toName: '이웃', date: '2021-11-26', value: 1 }, // 정확히 5년 전: 포함
    { id: '4', toType: 'other', toId: '', toName: '이웃', date: '2021-11-25', value: 1 }, // 제외
    { id: '5', toType: 'family', toId: 'c1', toName: '', date: '2026-11-27', value: 1 }, // 기준일 이후
    { id: '6', toType: 'family', toId: 'p1', toName: '', date: '2018-01-01', value: 1 } // 부모: 보수적으로 10년
  ];
  const r = L.reviewGifts(gifts, families, TODAY);
  assert.deepEqual(r.map((x) => x.status), ['in', 'out', 'in', 'out', 'future', 'in']);
  assert.equal(r[0].years, 10);
  assert.equal(r[2].years, 5);
  assert.equal(r[2].relation, '가족 외');
});

test('reviewGifts: 기준일이 잘못되면 판단하지 않는다', () => {
  const r = L.reviewGifts([{ id: '1', toType: 'other', toName: 'a', date: '2020-01-01', value: 1 }], [], '');
  assert.equal(r[0].status, 'unknown');
});

test('totals: 자산·채무·차액을 분리해 합산한다', () => {
  const t = L.totals([
    { type: '부동산', value: 500 },
    { type: '예금', value: 50 },
    { type: '채무', value: 20 }
  ]);
  assert.equal(t.assetTotal, 550);
  assert.equal(t.debtTotal, 20);
  assert.equal(t.net, 530);
});

test('readiness: 빈 상태는 0점이고 다음 할 일은 가족 등록이다', () => {
  const r = L.readiness(L.emptyState(), TODAY);
  assert.equal(r.score, 0);
  assert.equal(r.next.id, 'family');
  assert.equal(r.items.reduce((s, i) => s + i.max, 0), 100);
});

test('readiness: 샘플 데이터의 점수와 안내 항목', () => {
  const s = L.sampleState(TODAY);
  const r = L.readiness(s, TODAY);
  // 가족 10(미확인) + 재산 20 + 확인상태 11(3/4) + 채무 10 + 증여 15 + 유언 10 + 서류 1(1/7)
  assert.equal(r.score, 77);
  assert.equal(r.next.id, 'family');
  assert.equal(r.stats.unconfirmed.length, 1);
  assert.equal(r.stats.stale.length, 1);
  const inWin = r.review.filter((x) => x.status === 'in').map((x) => x.id);
  assert.deepEqual(inWin, ['g1', 'g3']); // g2는 12년 전이라 제외
  assert.ok(r.flags.some((f) => f.text.includes('합산 검토 대상이 2건')));
});

test('readiness: 가족 본인 확인을 하면 20점이 된다', () => {
  const s = L.sampleState(TODAY);
  s.confirm.family = true;
  assert.equal(L.readiness(s, TODAY).items.find((i) => i.id === 'family').earned, 20);
});

test('readiness: 채무가 재산보다 많으면 경고한다', () => {
  const s = L.emptyState();
  s.assets = [{ id: 'a', type: '채무', name: '대출', value: 100, asOf: TODAY, status: '직접 확인' }];
  const r = L.readiness(s, TODAY);
  assert.ok(r.flags.some((f) => f.level === 'warn' && f.text.includes('채무가 재산보다 많습니다')));
});

test('buildQuestions: 입력 상태에 따라 질문이 늘어난다', () => {
  const base = L.buildQuestions(L.emptyState(), TODAY);
  assert.equal(base.length, 4);
  const q = L.buildQuestions(L.sampleState(TODAY), TODAY);
  assert.ok(q.length > 4);
  assert.ok(q.some((x) => x.includes('부동산')));
  assert.ok(q.some((x) => x.includes('합산 검토 대상')));
  assert.ok(q.some((x) => x.includes('가족 외 수증자')));
});

test('normalizeState: 잘못된 항목은 버리고 개수를 알려준다', () => {
  const raw = {
    families: [
      { id: 'ok', name: '가족', relation: '자녀' },
      { id: 'x', name: '', relation: '자녀' },
      { id: 'y', name: '이름', relation: '이상한관계' },
      null
    ],
    assets: [
      { type: '예금', name: '정상(상태 없음)', value: 100, asOf: '2026-01-01' },
      { type: '예금', name: '문자열금액', value: '100', asOf: '2026-01-01' },
      { type: '예금', name: '음수', value: -1, asOf: '2026-01-01' },
      { type: '예금', name: '너무큼', value: L.MAX_AMOUNT + 1, asOf: '2026-01-01' },
      { type: '예금', name: '날짜오류', value: 1, asOf: '2026-02-30' },
      { type: '없는분류', name: '분류오류', value: 1, asOf: '2026-01-01' }
    ],
    gifts: [{ toType: 'family', toId: '없는id', toName: '삭제된가족', date: '2020-01-01', value: 5 }, { date: 'bad', value: 1 }]
  };
  const { state, dropped, valid } = L.normalizeState(raw);
  assert.ok(valid);
  assert.equal(state.families.length, 1);
  assert.equal(state.assets.length, 1);
  assert.equal(state.assets[0].status, '나중에 확인'); // 상태가 없으면 가장 보수적인 값
  assert.equal(state.gifts.length, 1);
  assert.equal(state.gifts[0].toType, 'other'); // 없는 가족 id는 가족 외로 정리
  assert.equal(state.gifts[0].toName, '삭제된가족');
  assert.equal(dropped, 3 + 5 + 1);
});

test('normalizeState: 객체가 아니면 빈 상태와 valid=false', () => {
  for (const bad of [null, 'text', 5, [], undefined]) {
    const r = L.normalizeState(bad);
    assert.equal(r.valid, false);
    assert.equal(r.state.families.length, 0);
  }
});

test('normalizeState: id는 안전한 문자만, 중복이면 새로 만든다', () => {
  const { state } = L.normalizeState({
    families: [
      { id: '<b>x</b>', name: 'a', relation: '자녀' },
      { id: 'dup', name: 'b', relation: '자녀' },
      { id: 'dup', name: 'c', relation: '자녀' }
    ]
  });
  assert.match(state.families[0].id, /^[A-Za-z0-9_-]+$/);
  const ids = state.families.map((f) => f.id);
  assert.equal(new Set(ids).size, 3);
});

test('normalizeState: 항목 수 제한과 가족 본인 확인 조건', () => {
  const many = Array.from({ length: 300 }, (_, i) => ({ type: '예금', name: 'n' + i, value: 1, asOf: '2026-01-01', status: '추정' }));
  assert.equal(L.normalizeState({ assets: many }).state.assets.length, L.MAX_ITEMS);
  assert.equal(L.normalizeState({ confirm: { family: true } }).state.confirm.family, false); // 가족이 없으면 확인 불가
});

test('내보내기·가져오기: 샘플 상태가 그대로 복원된다', () => {
  const s = L.sampleState(TODAY);
  const back = L.normalizeState(JSON.parse(JSON.stringify(s)));
  assert.equal(back.dropped, 0);
  assert.deepEqual(back.state, s);
});

test('시나리오·유언 안내 데이터에는 세액 숫자나 단정적 결론이 없다', () => {
  const text = JSON.stringify(L.SCENARIOS) + JSON.stringify(L.WILL_GUIDE);
  assert.ok(!/\d+(\.\d+)?\s?%/.test(text), '세율 같은 퍼센트 수치가 없어야 함');
  assert.ok(!text.includes('절세 효과가 큽니다'));
  assert.equal(L.SCENARIOS.length, 3);
  assert.deepEqual(Object.keys(L.WILL_GUIDE).sort(), [...L.WILL_METHODS].sort());
});
