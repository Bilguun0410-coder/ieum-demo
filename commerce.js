/* =========================================================
   이음 IEUM - commerce.js
   모의 결제·이용권·금액권·관리자 기능 (실제 결제 없음)
   - 실제 서비스라면 서버가 처리할 일을 시연용으로 이 기기 안에서 흉내 냅니다.
   - 브라우저와 Node 공용 (tests/commerce.test.js 에서 검증)
   ========================================================= */
(function (root) {
  'use strict';

  const SHOP_VERSION = 1;
  const FREE_AI = 3; // 처음 시작할 때 주는 AI 체험 횟수
  const MAX_ORDERS = 500;
  const MAX_CODES = 500;
  const MAX_LOG = 300;
  const MAX_PRICE = 10000000;
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 0/O, 1/I 제외

  // 사업 개발서의 단위경제 가정 (검증 전 가설)
  const PLAN = {
    packagePrice: 89000,
    vatRate: 0.1,
    variableCost: 15000,
    cac: 30000,
    fixedMonthly: 10000000,
    bepMonthly: 279
  };

  const METHODS = { card: '모의 신용카드', easy: '모의 간편결제', balance: '금액권 잔액' };

  function defaultProducts() {
    return [
      {
        id: 'package',
        kind: 'pass',
        name: '자산승계 준비 패키지',
        price: 89000,
        grants: { report: 1, ai: 30, days: 0 },
        desc: '상담 준비 리포트 1회 발급(인쇄·PDF) + AI 서류 읽기·브리핑·도우미 30회',
        requires: '',
        active: true
      },
      {
        id: 'family',
        kind: 'pass',
        name: '가족 기록관리 (연간)',
        price: 59000,
        grants: { report: 0, ai: 50, days: 365 },
        desc: '1년간 리포트 무제한 재발급 + AI 50회. 준비 패키지 구매 후 추가 가능',
        requires: 'package',
        active: true
      },
      { id: 'gift50', kind: 'gift', name: '이음 금액권 5만원', price: 50000, amount: 50000, desc: '부모님께 선물할 수 있는 금액권 코드를 발급합니다', requires: '', active: true },
      { id: 'gift100', kind: 'gift', name: '이음 금액권 10만원', price: 100000, amount: 100000, desc: '부모님께 선물할 수 있는 금액권 코드를 발급합니다', requires: '', active: true }
    ];
  }

  function emptyShop() {
    return {
      version: SHOP_VERSION,
      products: defaultProducts(),
      wallet: { balance: 0, ai: FREE_AI, report: 0, unlimitedUntil: '' },
      orders: [],
      codes: [],
      issues: [],
      log: [],
      admin: { hash: '', salt: '' },
      seq: { order: 0, issue: 0, product: 0 }
    };
  }

  // ---------- 유틸 ----------
  function pad(n, w) {
    return String(n).padStart(w || 2, '0');
  }
  function ymd(iso) {
    return String(iso).slice(0, 10);
  }
  function compact(iso) {
    return ymd(iso).replace(/-/g, '');
  }
  function addDaysIso(dateStr, n) {
    const d = new Date(dateStr + 'T00:00:00Z');
    if (isNaN(d.getTime())) return '';
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function isInt(v, min, max) {
    return Number.isSafeInteger(v) && v >= min && v <= max;
  }
  function str(v, max) {
    return typeof v === 'string' ? v.trim().slice(0, max) : '';
  }
  function randomCode(rand) {
    const r = rand || Math.random;
    let s = '';
    for (let i = 0; i < 8; i++) s += CODE_CHARS[Math.floor(r() * CODE_CHARS.length)];
    return 'IEUM-' + s.slice(0, 4) + '-' + s.slice(4);
  }
  function normalizeCode(input) {
    return String(input || '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .replace(/^IEUM/, '');
  }
  function formatCode(raw8) {
    return 'IEUM-' + raw8.slice(0, 4) + '-' + raw8.slice(4, 8);
  }
  function pushLog(shop, at, kind, text) {
    shop.log.unshift({ at: at, kind: kind, text: String(text).slice(0, 120) });
    if (shop.log.length > MAX_LOG) shop.log.length = MAX_LOG;
  }
  function findProduct(shop, id) {
    return shop.products.find(function (p) { return p.id === id; });
  }

  function unlimitedActive(shop, today) {
    return !!shop.wallet.unlimitedUntil && shop.wallet.unlimitedUntil >= today;
  }

  function hasPurchased(shop, productId) {
    return shop.orders.some(function (o) { return o.productId === productId && o.status === 'paid'; });
  }

  // ---------- 구매 ----------
  // now: ISO 시각 문자열, rand: 테스트용 난수 함수
  function purchase(shop, productId, method, now, rand) {
    const p = findProduct(shop, productId);
    if (!p || !p.active) return { ok: false, error: '판매 중인 상품이 아닙니다.' };
    if (!METHODS[method]) return { ok: false, error: '결제 수단을 선택하세요.' };
    if (p.requires && !hasPurchased(shop, p.requires)) {
      const req = findProduct(shop, p.requires);
      return { ok: false, error: '"' + (req ? req.name : p.requires) + '"을(를) 먼저 구매해야 이용할 수 있는 상품입니다.' };
    }
    if (method === 'balance') {
      if (p.kind === 'gift') return { ok: false, error: '금액권은 금액권 잔액으로 살 수 없습니다.' };
      if (shop.wallet.balance < p.price) {
        return { ok: false, error: '금액권 잔액이 부족합니다. (잔액 ' + shop.wallet.balance.toLocaleString('ko-KR') + '원)' };
      }
    }
    if (shop.orders.length >= MAX_ORDERS) return { ok: false, error: '시연용 주문 기록이 가득 찼습니다. 관리자 화면에서 초기화하세요.' };

    shop.seq.order += 1;
    const order = {
      id: 'O' + shop.seq.order,
      no: 'IEUM-' + compact(now) + '-' + pad(shop.seq.order, 4),
      productId: p.id,
      name: p.name,
      kind: p.kind,
      price: p.price,
      grants: p.kind === 'pass' ? { report: p.grants.report, ai: p.grants.ai, days: p.grants.days } : null,
      method: method,
      status: 'paid',
      at: now,
      refundedAt: '',
      code: '',
      prevUnlimited: ''
    };

    if (method === 'balance') shop.wallet.balance -= p.price;

    if (p.kind === 'pass') {
      shop.wallet.report += p.grants.report;
      shop.wallet.ai += p.grants.ai;
      if (p.grants.days > 0) {
        order.prevUnlimited = shop.wallet.unlimitedUntil;
        const today = ymd(now);
        const base = unlimitedActive(shop, today) ? shop.wallet.unlimitedUntil : today;
        shop.wallet.unlimitedUntil = addDaysIso(base, p.grants.days);
      }
    } else {
      let code;
      do {
        code = randomCode(rand);
      } while (shop.codes.some(function (c) { return c.code === code; }));
      shop.codes.unshift({ code: code, amount: p.amount, status: 'issued', source: 'purchase', memo: p.name, at: now, usedAt: '' });
      if (shop.codes.length > MAX_CODES) shop.codes.length = MAX_CODES;
      order.code = code;
    }
    shop.orders.unshift(order);
    pushLog(shop, now, 'order', order.no + ' ' + p.name + ' 결제 (' + METHODS[method] + ')');
    return { ok: true, order: order };
  }

  // ---------- 환불 (모의) ----------
  function refundable(shop, orderId) {
    const o = shop.orders.find(function (x) { return x.id === orderId; });
    if (!o) return { ok: false, error: '주문을 찾을 수 없습니다.' };
    if (o.status !== 'paid') return { ok: false, error: '이미 환불된 주문입니다.' };
    if (o.kind === 'gift') {
      const c = shop.codes.find(function (x) { return x.code === o.code; });
      if (c && c.status !== 'issued') return { ok: false, error: '이미 등록된 금액권은 환불할 수 없습니다.' };
      return { ok: true, order: o };
    }
    if (shop.wallet.report < o.grants.report || shop.wallet.ai < o.grants.ai) {
      return { ok: false, error: '이 주문으로 받은 이용권을 이미 사용해 환불할 수 없습니다.' };
    }
    if (o.grants.days > 0 && shop.issues.some(function (i) { return i.at > o.at; })) {
      return { ok: false, error: '구매 후 리포트를 발급해 환불할 수 없습니다.' };
    }
    return { ok: true, order: o };
  }

  function refund(shop, orderId, now) {
    const chk = refundable(shop, orderId);
    if (!chk.ok) return chk;
    const o = chk.order;
    if (o.kind === 'gift') {
      const c = shop.codes.find(function (x) { return x.code === o.code; });
      if (c) c.status = 'void';
    } else {
      shop.wallet.report -= o.grants.report;
      shop.wallet.ai -= o.grants.ai;
      if (o.grants.days > 0) shop.wallet.unlimitedUntil = o.prevUnlimited || '';
    }
    if (o.method === 'balance') shop.wallet.balance += o.price;
    o.status = 'refunded';
    o.refundedAt = now;
    pushLog(shop, now, 'refund', o.no + ' 환불 (' + (o.method === 'balance' ? '금액권 잔액으로 복원' : '모의 결제 취소') + ')');
    return { ok: true, order: o };
  }

  // ---------- 금액권 ----------
  function redeem(shop, input, now) {
    const raw = normalizeCode(input);
    if (raw.length !== 8) return { ok: false, error: '금액권 번호 8자리를 확인하세요. (예: IEUM-AB12-CD34)' };
    const code = formatCode(raw);
    const c = shop.codes.find(function (x) { return x.code === code; });
    if (!c) return { ok: false, error: '등록되지 않은 금액권 번호입니다.' };
    if (c.status === 'used') return { ok: false, error: '이미 사용한 금액권입니다.' };
    if (c.status === 'void') return { ok: false, error: '취소된 금액권입니다.' };
    c.status = 'used';
    c.usedAt = now;
    shop.wallet.balance += c.amount;
    pushLog(shop, now, 'redeem', code + ' 등록, ' + c.amount.toLocaleString('ko-KR') + '원 충전');
    return { ok: true, amount: c.amount, code: code };
  }

  // ---------- 이용권 사용 ----------
  function canUse(shop, kind, today) {
    if (kind === 'report') return unlimitedActive(shop, today) || shop.wallet.report > 0;
    if (kind === 'ai') return shop.wallet.ai > 0;
    return false;
  }

  function useAi(shop, now, detail) {
    if (shop.wallet.ai <= 0) return { ok: false, error: 'AI 이용 횟수가 남아 있지 않습니다. 이용권 화면에서 구매하세요.' };
    shop.wallet.ai -= 1;
    pushLog(shop, now, 'ai', 'AI ' + (detail || '사용') + ' (남은 횟수 ' + shop.wallet.ai + ')');
    return { ok: true, left: shop.wallet.ai };
  }

  // 리포트 발급: 연간 플랜이 유효하면 차감하지 않는다.
  function issueReport(shop, now, stamp) {
    const today = ymd(now);
    const unlimited = unlimitedActive(shop, today);
    if (!unlimited && shop.wallet.report <= 0) {
      return { ok: false, error: '리포트 발급권이 없습니다. "자산승계 준비 패키지"를 구매하세요.' };
    }
    if (!unlimited) shop.wallet.report -= 1;
    shop.seq.issue += 1;
    const issue = { no: 'IEUM-R-' + today.slice(0, 4) + '-' + pad(shop.seq.issue, 5), at: now, stamp: String(stamp || ''), unlimited: unlimited };
    shop.issues.unshift(issue);
    if (shop.issues.length > MAX_ORDERS) shop.issues.length = MAX_ORDERS;
    pushLog(shop, now, 'issue', '리포트 발급 ' + issue.no + (unlimited ? ' (연간 플랜)' : ''));
    return { ok: true, issue: issue };
  }

  // 마지막 발급 이후 입력 내용이 바뀌지 않았으면 그 발급이 유효하다.
  function activeIssue(shop, stamp) {
    const last = shop.issues[0];
    return last && last.stamp && last.stamp === String(stamp) ? last : null;
  }

  // ---------- 관리자 ----------
  function adminIssueCode(shop, amount, memo, now, rand) {
    if (!isInt(amount, 1000, MAX_PRICE)) return { ok: false, error: '금액은 1,000원 이상 1,000만원 이하의 정수로 입력하세요.' };
    if (shop.codes.length >= MAX_CODES) return { ok: false, error: '발급 가능한 금액권 수를 넘었습니다.' };
    let code;
    do {
      code = randomCode(rand);
    } while (shop.codes.some(function (c) { return c.code === code; }));
    shop.codes.unshift({ code: code, amount: amount, status: 'issued', source: 'admin', memo: str(memo, 40) || '관리자 발급', at: now, usedAt: '' });
    pushLog(shop, now, 'admin', '금액권 발급 ' + code + ' ' + amount.toLocaleString('ko-KR') + '원');
    return { ok: true, code: code };
  }

  function adminGrant(shop, ai, report, now) {
    if (!isInt(ai, 0, 1000) || !isInt(report, 0, 100) || ai + report === 0) {
      return { ok: false, error: 'AI 0~1000회, 리포트 0~100장 사이로 입력하세요. (둘 다 0은 안 됩니다)' };
    }
    shop.wallet.ai += ai;
    shop.wallet.report += report;
    pushLog(shop, now, 'admin', '이용권 지급 AI ' + ai + '회, 리포트 ' + report + '장');
    return { ok: true };
  }

  function adminSetPrice(shop, productId, price, now) {
    const p = findProduct(shop, productId);
    if (!p) return { ok: false, error: '상품을 찾을 수 없습니다.' };
    if (p.kind === 'gift') return { ok: false, error: '금액권 가격은 액면가로 고정됩니다.' };
    if (!isInt(price, 0, MAX_PRICE)) return { ok: false, error: '가격은 0원 이상 1,000만원 이하의 정수로 입력하세요.' };
    p.price = price;
    pushLog(shop, now, 'admin', p.name + ' 가격 변경 ' + price.toLocaleString('ko-KR') + '원');
    return { ok: true };
  }

  function adminToggle(shop, productId, now) {
    const p = findProduct(shop, productId);
    if (!p) return { ok: false, error: '상품을 찾을 수 없습니다.' };
    p.active = !p.active;
    pushLog(shop, now, 'admin', p.name + (p.active ? ' 판매 재개' : ' 판매 중지'));
    return { ok: true, active: p.active };
  }

  function adminAddProduct(shop, input, now) {
    const name = str(input && input.name, 30);
    const price = input && input.price;
    const ai = input && input.ai;
    const report = input && input.report;
    const days = input && input.days;
    if (!name) return { ok: false, error: '상품명을 입력하세요.' };
    if (!isInt(price, 0, MAX_PRICE)) return { ok: false, error: '가격은 0원 이상 1,000만원 이하의 정수로 입력하세요.' };
    if (!isInt(ai, 0, 1000) || !isInt(report, 0, 100) || !isInt(days, 0, 3650)) return { ok: false, error: '제공 내용(AI 횟수·리포트 장수·기간)을 확인하세요.' };
    if (ai + report + days === 0) return { ok: false, error: '제공 내용이 하나 이상 있어야 합니다.' };
    if (shop.products.length >= 30) return { ok: false, error: '상품은 30개까지 등록할 수 있습니다.' };
    shop.seq.product += 1;
    const parts = [];
    if (report) parts.push('리포트 ' + report + '회 발급');
    if (days) parts.push(days + '일간 리포트 무제한');
    if (ai) parts.push('AI ' + ai + '회');
    const p = { id: 'p' + shop.seq.product, kind: 'pass', name: name, price: price, grants: { report: report, ai: ai, days: days }, desc: parts.join(' + '), requires: '', active: true };
    shop.products.push(p);
    pushLog(shop, now, 'admin', '상품 추가 ' + name);
    return { ok: true, product: p };
  }

  // ---------- 매출·손익분기 (모의 주문 기준, 계획서 가정 적용) ----------
  function stats(shop) {
    const paid = shop.orders.filter(function (o) { return o.status === 'paid'; });
    const refunded = shop.orders.filter(function (o) { return o.status === 'refunded'; });
    // 금액권은 선수금이라 판매 시점 매출이 아니다. 이용권 결제 중 금액권 잔액으로 낸 것은 실제 매출로 본다.
    const passPaid = paid.filter(function (o) { return o.kind === 'pass'; });
    const giftPaid = paid.filter(function (o) { return o.kind === 'gift'; });
    const revenue = passPaid.reduce(function (s, o) { return s + o.price; }, 0);
    const supply = Math.round(revenue / (1 + PLAN.vatRate));
    const packages = passPaid.filter(function (o) { return o.productId === 'package'; }).length;
    const unitContribution = Math.round(PLAN.packagePrice / (1 + PLAN.vatRate)) - PLAN.variableCost - PLAN.cac;
    const byProduct = {};
    paid.forEach(function (o) {
      byProduct[o.name] = byProduct[o.name] || { count: 0, amount: 0 };
      byProduct[o.name].count += 1;
      byProduct[o.name].amount += o.price;
    });
    const outstanding = shop.codes
      .filter(function (c) { return c.status === 'issued'; })
      .reduce(function (s, c) { return s + c.amount; }, 0);
    return {
      orders: paid.length,
      refunds: refunded.length,
      revenue: revenue,
      supply: supply,
      giftSales: giftPaid.reduce(function (s, o) { return s + o.price; }, 0),
      outstandingGift: outstanding,
      packages: packages,
      bep: PLAN.bepMonthly,
      bepRate: Math.min(1, packages / PLAN.bepMonthly),
      unitContribution: unitContribution,
      contribution: packages * unitContribution,
      byProduct: byProduct
    };
  }

  // ---------- 저장값 정리 ----------
  function normalizeShop(raw) {
    const s = emptyShop();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { shop: s, valid: false };
    if (Array.isArray(raw.products) && raw.products.length) {
      const prods = [];
      raw.products.slice(0, 30).forEach(function (p) {
        if (!p || typeof p !== 'object') return;
        const id = str(p.id, 20).replace(/[^A-Za-z0-9_-]/g, '');
        const name = str(p.name, 30);
        if (!id || !name || !isInt(p.price, 0, MAX_PRICE) || prods.some(function (x) { return x.id === id; })) return;
        if (p.kind === 'gift') {
          if (!isInt(p.amount, 1000, MAX_PRICE)) return;
          prods.push({ id: id, kind: 'gift', name: name, price: p.amount, amount: p.amount, desc: str(p.desc, 80), requires: '', active: p.active !== false });
        } else if (p.kind === 'pass' && p.grants && typeof p.grants === 'object') {
          const g = { report: p.grants.report, ai: p.grants.ai, days: p.grants.days };
          if (!isInt(g.report, 0, 100) || !isInt(g.ai, 0, 1000) || !isInt(g.days, 0, 3650)) return;
          prods.push({ id: id, kind: 'pass', name: name, price: p.price, grants: g, desc: str(p.desc, 80), requires: str(p.requires, 20), active: p.active !== false });
        }
      });
      if (prods.length) s.products = prods;
    }
    const w = raw.wallet || {};
    if (isInt(w.balance, 0, 1e12)) s.wallet.balance = w.balance;
    if (isInt(w.ai, 0, 1e6)) s.wallet.ai = w.ai;
    if (isInt(w.report, 0, 1e6)) s.wallet.report = w.report;
    if (typeof w.unlimitedUntil === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(w.unlimitedUntil)) s.wallet.unlimitedUntil = w.unlimitedUntil;
    if (Array.isArray(raw.orders)) {
      s.orders = raw.orders.slice(0, MAX_ORDERS).filter(function (o) {
        return o && typeof o.id === 'string' && typeof o.no === 'string' && isInt(o.price, 0, MAX_PRICE) && METHODS[o.method] && (o.status === 'paid' || o.status === 'refunded') && (o.kind === 'pass' || o.kind === 'gift');
      }).map(function (o) {
        return {
          id: str(o.id, 20), no: str(o.no, 40), productId: str(o.productId, 20), name: str(o.name, 30), kind: o.kind, price: o.price,
          grants: o.kind === 'pass' && o.grants ? { report: o.grants.report | 0, ai: o.grants.ai | 0, days: o.grants.days | 0 } : null,
          method: o.method, status: o.status, at: str(o.at, 40), refundedAt: str(o.refundedAt, 40), code: str(o.code, 20), prevUnlimited: str(o.prevUnlimited, 10)
        };
      });
    }
    if (Array.isArray(raw.codes)) {
      s.codes = raw.codes.slice(0, MAX_CODES).filter(function (c) {
        return c && /^IEUM-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(c.code) && isInt(c.amount, 1, MAX_PRICE) && ['issued', 'used', 'void'].indexOf(c.status) >= 0;
      }).map(function (c) {
        return { code: c.code, amount: c.amount, status: c.status, source: c.source === 'admin' ? 'admin' : 'purchase', memo: str(c.memo, 40), at: str(c.at, 40), usedAt: str(c.usedAt, 40) };
      });
    }
    if (Array.isArray(raw.issues)) {
      s.issues = raw.issues.slice(0, MAX_ORDERS).filter(function (i) { return i && typeof i.no === 'string'; }).map(function (i) {
        return { no: str(i.no, 30), at: str(i.at, 40), stamp: str(i.stamp, 40), unlimited: i.unlimited === true };
      });
    }
    if (Array.isArray(raw.log)) {
      s.log = raw.log.slice(0, MAX_LOG).filter(function (l) { return l && typeof l.text === 'string'; }).map(function (l) {
        return { at: str(l.at, 40), kind: str(l.kind, 10), text: str(l.text, 120) };
      });
    }
    if (raw.admin && /^[0-9a-f]{64}$/.test(raw.admin.hash) && /^[0-9a-f]{8,64}$/.test(raw.admin.salt)) {
      s.admin = { hash: raw.admin.hash, salt: raw.admin.salt };
    }
    if (raw.seq) {
      ['order', 'issue', 'product'].forEach(function (k) {
        if (isInt(raw.seq[k], 0, 1e9)) s.seq[k] = raw.seq[k];
      });
    }
    return { shop: s, valid: true };
  }

  const api = {
    SHOP_VERSION: SHOP_VERSION,
    FREE_AI: FREE_AI,
    PLAN: PLAN,
    METHODS: METHODS,
    defaultProducts: defaultProducts,
    emptyShop: emptyShop,
    normalizeShop: normalizeShop,
    normalizeCode: normalizeCode,
    randomCode: randomCode,
    unlimitedActive: unlimitedActive,
    hasPurchased: hasPurchased,
    purchase: purchase,
    refundable: refundable,
    refund: refund,
    redeem: redeem,
    canUse: canUse,
    useAi: useAi,
    issueReport: issueReport,
    activeIssue: activeIssue,
    adminIssueCode: adminIssueCode,
    adminGrant: adminGrant,
    adminSetPrice: adminSetPrice,
    adminToggle: adminToggle,
    adminAddProduct: adminAddProduct,
    stats: stats
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.IEUM_SHOP = api;
})(typeof window !== 'undefined' ? window : globalThis);
