const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../commerce.js');

const T0 = '2026-11-26T10:00:00.000Z';
const T1 = '2026-11-26T11:00:00.000Z';
const T2 = '2026-11-27T09:00:00.000Z';

function seq(values) {
  let i = 0;
  return function () {
    const v = values[i % values.length];
    i++;
    return v;
  };
}

test('처음 상태: AI 체험 3회, 리포트 0장, 잔액 0원', () => {
  const s = S.emptyShop();
  assert.equal(s.wallet.ai, S.FREE_AI);
  assert.equal(s.wallet.report, 0);
  assert.equal(s.wallet.balance, 0);
  assert.equal(S.canUse(s, 'report', '2026-11-26'), false);
});

test('패키지 구매: 리포트 1장 + AI 30회 지급, 주문번호 생성', () => {
  const s = S.emptyShop();
  const r = S.purchase(s, 'package', 'card', T0);
  assert.equal(r.ok, true);
  assert.match(r.order.no, /^IEUM-20261126-0001$/);
  assert.equal(s.wallet.report, 1);
  assert.equal(s.wallet.ai, S.FREE_AI + 30);
  assert.equal(s.orders.length, 1);
});

test('연간 상품은 패키지를 먼저 사야 하고, 구매하면 365일 무제한', () => {
  const s = S.emptyShop();
  assert.equal(S.purchase(s, 'family', 'card', T0).ok, false);
  S.purchase(s, 'package', 'card', T0);
  const r = S.purchase(s, 'family', 'easy', T0);
  assert.equal(r.ok, true);
  assert.equal(s.wallet.unlimitedUntil, '2027-11-26');
  assert.equal(S.unlimitedActive(s, '2027-11-26'), true);
  assert.equal(S.unlimitedActive(s, '2027-11-27'), false);
});

test('리포트 발급: 발급권 차감, 연간 플랜 중에는 차감 없음', () => {
  const s = S.emptyShop();
  assert.equal(S.issueReport(s, T0, 'a').ok, false);
  S.purchase(s, 'package', 'card', T0);
  const i1 = S.issueReport(s, T0, 'stamp1');
  assert.equal(i1.ok, true);
  assert.equal(s.wallet.report, 0);
  assert.match(i1.issue.no, /^IEUM-R-2026-00001$/);
  assert.equal(S.activeIssue(s, 'stamp1').no, i1.issue.no);
  assert.equal(S.activeIssue(s, 'stamp2'), null);
  S.purchase(s, 'family', 'card', T1);
  const i2 = S.issueReport(s, T1, 'stamp2');
  assert.equal(i2.ok, true);
  assert.equal(i2.issue.unlimited, true);
  assert.equal(s.wallet.report, 0);
});

test('AI 사용: 0회가 되면 막힌다', () => {
  const s = S.emptyShop();
  for (let i = 0; i < S.FREE_AI; i++) assert.equal(S.useAi(s, T0, '테스트').ok, true);
  assert.equal(S.useAi(s, T0, '테스트').ok, false);
  assert.equal(s.wallet.ai, 0);
});

test('금액권: 구매하면 코드 발급, 등록하면 잔액 충전, 재사용 불가', () => {
  const s = S.emptyShop();
  const r = S.purchase(s, 'gift50', 'card', T0, seq([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]));
  assert.equal(r.ok, true);
  assert.match(r.order.code, /^IEUM-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const lower = r.order.code.toLowerCase().replace(/-/g, ' ');
  const rd = S.redeem(s, lower, T1);
  assert.equal(rd.ok, true);
  assert.equal(s.wallet.balance, 50000);
  assert.equal(S.redeem(s, r.order.code, T1).ok, false);
  assert.equal(S.redeem(s, 'IEUM-ZZZZ-ZZZZ', T1).ok, false);
  assert.equal(S.redeem(s, '123', T1).ok, false);
});

test('금액권 잔액으로 결제: 부족하면 실패, 충분하면 차감', () => {
  const s = S.emptyShop();
  assert.equal(S.purchase(s, 'package', 'balance', T0).ok, false);
  S.adminIssueCode(s, 100000, '시연', T0);
  S.redeem(s, s.codes[0].code, T0);
  const r = S.purchase(s, 'package', 'balance', T1);
  assert.equal(r.ok, true);
  assert.equal(s.wallet.balance, 11000);
  assert.equal(S.purchase(s, 'gift50', 'balance', T1).ok, false, '금액권으로 금액권 구매 불가');
});

test('환불: 미사용이면 이용권 회수, 잔액 결제는 잔액 복원', () => {
  const s = S.emptyShop();
  S.adminIssueCode(s, 89000, '', T0);
  S.redeem(s, s.codes[0].code, T0);
  const o = S.purchase(s, 'package', 'balance', T0).order;
  const r = S.refund(s, o.id, T1);
  assert.equal(r.ok, true);
  assert.equal(s.wallet.balance, 89000);
  assert.equal(s.wallet.report, 0);
  assert.equal(s.wallet.ai, S.FREE_AI);
  assert.equal(S.refund(s, o.id, T1).ok, false, '두 번 환불 불가');
});

test('환불: 이용권을 쓴 뒤에는 불가', () => {
  const s = S.emptyShop();
  const o = S.purchase(s, 'package', 'card', T0).order;
  S.issueReport(s, T1, 'x');
  const r = S.refund(s, o.id, T1);
  assert.equal(r.ok, false);
  assert.match(r.error, /사용/);
});

test('환불: 연간 플랜은 구매 후 발급 이력이 있으면 불가, 없으면 기간 원복', () => {
  const s = S.emptyShop();
  S.purchase(s, 'package', 'card', T0);
  const y = S.purchase(s, 'family', 'card', T1).order;
  assert.equal(S.refundable(s, y.id).ok, true);
  const s2 = JSON.parse(JSON.stringify(s));
  assert.equal(S.refund(s2, y.id, T2).ok, true);
  assert.equal(s2.wallet.unlimitedUntil, '');
  S.issueReport(s, T2, 'z');
  assert.equal(S.refund(s, y.id, T2).ok, false);
});

test('환불: 등록한 금액권 주문은 불가, 미등록이면 코드 무효화', () => {
  const s = S.emptyShop();
  const a = S.purchase(s, 'gift50', 'card', T0).order;
  const b = S.purchase(s, 'gift100', 'card', T0).order;
  S.redeem(s, a.code, T1);
  assert.equal(S.refund(s, a.id, T1).ok, false);
  assert.equal(S.refund(s, b.id, T1).ok, true);
  assert.equal(S.redeem(s, b.code, T2).ok, false);
});

test('관리자: 가격 변경·판매 중지·상품 추가·이용권 지급', () => {
  const s = S.emptyShop();
  assert.equal(S.adminSetPrice(s, 'package', 79000, T0).ok, true);
  assert.equal(S.adminSetPrice(s, 'package', -1, T0).ok, false);
  assert.equal(S.adminSetPrice(s, 'gift50', 1, T0).ok, false);
  assert.equal(S.purchase(s, 'package', 'card', T0).order.price, 79000);
  S.adminToggle(s, 'package', T0);
  assert.equal(S.purchase(s, 'package', 'card', T0).ok, false);
  const add = S.adminAddProduct(s, { name: 'AI 10회권', price: 9900, ai: 10, report: 0, days: 0 }, T0);
  assert.equal(add.ok, true);
  assert.equal(add.product.desc, 'AI 10회');
  assert.equal(S.adminAddProduct(s, { name: '', price: 1, ai: 1, report: 0, days: 0 }, T0).ok, false);
  assert.equal(S.adminAddProduct(s, { name: '빈 상품', price: 1, ai: 0, report: 0, days: 0 }, T0).ok, false);
  assert.equal(S.adminGrant(s, 5, 1, T0).ok, true);
  assert.equal(S.adminGrant(s, 0, 0, T0).ok, false);
  assert.equal(S.adminIssueCode(s, 500, '', T0).ok, false);
});

test('매출 통계: 금액권 판매는 매출에서 제외, 환불 제외, 손익분기 진행률', () => {
  const s = S.emptyShop();
  S.purchase(s, 'package', 'card', T0);
  S.purchase(s, 'package', 'easy', T0);
  const g = S.purchase(s, 'gift50', 'card', T0).order;
  const x = S.purchase(s, 'package', 'card', T0).order;
  S.refund(s, x.id, T1);
  const st = S.stats(s);
  assert.equal(st.revenue, 178000);
  assert.equal(st.supply, Math.round(178000 / 1.1));
  assert.equal(st.packages, 2);
  assert.equal(st.refunds, 1);
  assert.equal(st.giftSales, 50000);
  assert.equal(st.outstandingGift, 50000);
  assert.equal(st.unitContribution, 35909);
  assert.equal(st.contribution, 71818);
  assert.equal(st.bep, 279);
  assert.ok(Math.abs(st.bepRate - 2 / 279) < 1e-9);
  assert.equal(g.kind, 'gift');
});

test('저장값 정리: 깨진 값은 버리고 정상 값은 유지', () => {
  const s = S.emptyShop();
  S.purchase(s, 'package', 'card', T0);
  S.adminIssueCode(s, 10000, '', T0);
  const copy = S.normalizeShop(JSON.parse(JSON.stringify(s)));
  assert.equal(copy.valid, true);
  assert.deepEqual(copy.shop, s);
  const bad = S.normalizeShop({ wallet: { ai: -5, balance: 'x' }, orders: [{ id: 1 }], codes: [{ code: 'nope' }], products: [{ id: 'x', name: 'y', price: -1, kind: 'pass' }] });
  assert.equal(bad.shop.wallet.ai, S.FREE_AI);
  assert.equal(bad.shop.orders.length, 0);
  assert.equal(bad.shop.codes.length, 0);
  assert.equal(bad.shop.products.length, S.defaultProducts().length);
  assert.equal(S.normalizeShop(null).valid, false);
  assert.equal(S.normalizeShop([]).valid, false);
});
