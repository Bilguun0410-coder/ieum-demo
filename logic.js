/* =========================================================
   이음 IEUM - logic.js
   화면과 무관한 규칙·계산 모음 (브라우저와 Node 공용, tests/ 에서 검증)

   원칙
   - 세액은 계산하지 않습니다. 입력 정보의 완성도, 확인이 필요한 항목,
     사전증여 합산 검토 대상 여부만 규칙으로 분류합니다.
   - 법령 근거는 계획서(사업 개발서) 5장·참고자료 및 공개 자료 기준이며,
     실제 상용화 전에 법률·세무 전문가 검토로 재확인해야 합니다.
   ========================================================= */
(function (root) {
  'use strict';

  const SCHEMA_VERSION = 1;
  const MAX_AMOUNT = 9999999999999; // 약 10조 원. 합계가 안전한 정수 범위를 넘지 않도록 제한
  const MAX_ITEMS = 200;
  const MAX_FAMILIES = 50;

  const RELATIONS = ['배우자', '자녀', '부모', '형제자매', '기타'];
  const ASSET_TYPES = ['부동산', '예금', '주식', '보험', '기타', '채무'];
  const STATUSES = ['직접 확인', '추정', '나중에 확인'];
  const WILL_METHODS = ['자필증서', '녹음', '공정증서', '비밀증서', '구수증서'];
  const PRICE_CHOICES = ['', '0', '49000', '89000', '129000', 'none'];
  const SCENARIO_IDS = ['A', 'B', 'C'];
  const STALE_DAYS = 365;

  // 상담 때 챙길 서류 (예시. 실제 필요 서류는 전문가에게 확인)
  const DOCS = [
    { id: 'family', label: '가족관계를 확인할 수 있는 서류 (가족관계증명서 등)' },
    { id: 'realestate', label: '부동산 소유 확인 자료 (등기부등본 등)' },
    { id: 'deposit', label: '예금·적금 잔액 확인 자료' },
    { id: 'stock', label: '주식·펀드 잔고 확인 자료' },
    { id: 'debt', label: '대출·보증 등 채무 확인 자료' },
    { id: 'gift', label: '과거 증여 증빙 (이체 내역, 증여세 신고 자료 등)' },
    { id: 'will', label: '이미 작성한 유언장이나 메모가 있다면 사본' }
  ];

  // ---------- 공통 유틸 ----------
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  function todayStr(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  // 'YYYY-MM-DD' 형식이고 실제 달력에 있는 날짜일 때만 Date(UTC)를 돌려준다.
  function parseDate(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const parts = s.split('-').map(Number);
    const dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    if (dt.getUTCFullYear() !== parts[0] || dt.getUTCMonth() !== parts[1] - 1 || dt.getUTCDate() !== parts[2]) {
      return null;
    }
    return dt;
  }

  function fmtDate(dt) {
    return String(dt.getUTCFullYear()).padStart(4, '0') + '-' + pad(dt.getUTCMonth() + 1) + '-' + pad(dt.getUTCDate());
  }

  // b - a (일). 둘 중 하나라도 잘못된 날짜면 NaN
  function daysBetween(a, b) {
    const da = parseDate(a);
    const db = parseDate(b);
    if (!da || !db) return NaN;
    return Math.round((db - da) / 86400000);
  }

  function addDays(s, n) {
    const d = parseDate(s);
    if (!d) return '';
    return fmtDate(new Date(d.getTime() + n * 86400000));
  }

  // 2월 29일처럼 대상 연도에 없는 날은 그 달의 마지막 날로 맞춘다.
  function addYears(s, n) {
    const d = parseDate(s);
    if (!d) return '';
    const y = d.getUTCFullYear() + n;
    const m = d.getUTCMonth();
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return String(y).padStart(4, '0') + '-' + pad(m + 1) + '-' + pad(Math.min(d.getUTCDate(), last));
  }

  function formatNumber(n) {
    return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function formatKRW(n) {
    return formatNumber(n) + '원';
  }

  // 큰 금액을 읽기 쉬운 한글 단위로: 550000000 -> '5억 5,000만원'
  function koreanAmount(n) {
    n = Math.round(Number(n) || 0);
    if (n === 0) return '0원';
    const sign = n < 0 ? '-' : '';
    let rest = Math.abs(n);
    const out = [];
    [[1e12, '조'], [1e8, '억'], [1e4, '만']].forEach(function (u) {
      const q = Math.floor(rest / u[0]);
      if (q > 0) {
        out.push(formatNumber(q) + u[1]);
        rest -= q * u[0];
      }
    });
    if (rest > 0) out.push(formatNumber(rest));
    return sign + out.join(' ') + '원';
  }

  // ---------- 상태 ----------
  function emptyState() {
    const now = new Date().toISOString();
    return {
      version: SCHEMA_VERSION,
      sample: false,
      families: [],
      assets: [],
      gifts: [],
      confirm: { family: false, noDebt: false, noGift: false },
      will: { method: '자필증서', items: [], questions: '' },
      docs: {},
      assumeDate: '',
      scenario: 'A',
      report: { include: { family: true, assets: true, gifts: true, will: true } },
      pilot: { price: '' },
      meta: { createdAt: now, updatedAt: now }
    };
  }

  function cleanStr(v, max) {
    return typeof v === 'string' ? v.trim().slice(0, max) : '';
  }

  function cleanId(v, used) {
    let id = typeof v === 'string' ? v.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) : '';
    if (!id || used.has(id)) id = uid();
    while (used.has(id)) id = uid();
    used.add(id);
    return id;
  }

  function validAmount(v) {
    return Number.isSafeInteger(v) && v >= 0 && v <= MAX_AMOUNT;
  }

  function list(v, max) {
    return Array.isArray(v) ? v.slice(0, max) : [];
  }

  // 외부(localStorage, 가져온 파일)에서 온 임의의 값을 안전한 상태로 정리한다.
  // 잘못된 항목은 버리고 몇 건을 버렸는지 알려준다.
  function normalizeState(raw) {
    const s = emptyState();
    let dropped = 0;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { state: s, dropped: 0, valid: false };

    const used = new Set();

    list(raw.families, MAX_FAMILIES).forEach(function (f) {
      const name = f && cleanStr(f.name, 36);
      if (f && RELATIONS.indexOf(f.relation) >= 0 && name) {
        s.families.push({ id: cleanId(f.id, used), name: name, relation: f.relation });
      } else dropped++;
    });
    const famIds = new Set(s.families.map(function (f) { return f.id; }));

    list(raw.assets, MAX_ITEMS).forEach(function (a) {
      const name = a && cleanStr(a.name, 60);
      if (a && ASSET_TYPES.indexOf(a.type) >= 0 && name && validAmount(a.value) && parseDate(a.asOf)) {
        s.assets.push({
          id: cleanId(a.id, used),
          type: a.type,
          name: name,
          value: a.value,
          asOf: a.asOf,
          status: STATUSES.indexOf(a.status) >= 0 ? a.status : '나중에 확인'
        });
      } else dropped++;
    });

    function recipient(x) {
      const toName = cleanStr(x.toName, 36);
      if (x.toType === 'family' && famIds.has(x.toId)) {
        return { toType: 'family', toId: x.toId, toName: toName };
      }
      return { toType: 'other', toId: '', toName: toName || '(알 수 없음)' };
    }

    list(raw.gifts, MAX_ITEMS).forEach(function (g) {
      if (g && parseDate(g.date) && validAmount(g.value)) {
        s.gifts.push(Object.assign({ id: cleanId(g.id, used), date: g.date, value: g.value }, recipient(g)));
      } else dropped++;
    });

    if (raw.will && typeof raw.will === 'object') {
      if (WILL_METHODS.indexOf(raw.will.method) >= 0) s.will.method = raw.will.method;
      s.will.questions = cleanStr(raw.will.questions, 1000);
      list(raw.will.items, MAX_ITEMS).forEach(function (w) {
        const what = w && cleanStr(w.what, 120);
        if (w && what) {
          s.will.items.push(
            Object.assign({ id: cleanId(w.id, used), what: what, reason: cleanStr(w.reason, 200) }, recipient(w))
          );
        } else dropped++;
      });
    }

    if (raw.confirm && typeof raw.confirm === 'object') {
      s.confirm.family = raw.confirm.family === true && s.families.length > 0;
      s.confirm.noDebt = raw.confirm.noDebt === true;
      s.confirm.noGift = raw.confirm.noGift === true;
    }
    if (raw.docs && typeof raw.docs === 'object') {
      DOCS.forEach(function (d) {
        if (raw.docs[d.id] === true) s.docs[d.id] = true;
      });
    }
    if (parseDate(raw.assumeDate)) s.assumeDate = raw.assumeDate;
    if (SCENARIO_IDS.indexOf(raw.scenario) >= 0) s.scenario = raw.scenario;
    if (raw.report && raw.report.include && typeof raw.report.include === 'object') {
      Object.keys(s.report.include).forEach(function (k) {
        if (typeof raw.report.include[k] === 'boolean') s.report.include[k] = raw.report.include[k];
      });
    }
    if (raw.pilot && PRICE_CHOICES.indexOf(raw.pilot.price) >= 0) s.pilot.price = raw.pilot.price;
    s.sample = raw.sample === true;
    if (raw.meta && typeof raw.meta === 'object') {
      s.meta.createdAt = cleanStr(raw.meta.createdAt, 40) || s.meta.createdAt;
      s.meta.updatedAt = cleanStr(raw.meta.updatedAt, 40) || s.meta.updatedAt;
    }
    return { state: s, dropped: dropped, valid: true };
  }

  // ---------- 재산 합계 ----------
  function totals(assets) {
    let assetTotal = 0;
    let debtTotal = 0;
    const byType = {};
    assets.forEach(function (x) {
      if (x.type === '채무') debtTotal += x.value;
      else assetTotal += x.value;
      byType[x.type] = (byType[x.type] || 0) + x.value;
    });
    return { assetTotal: assetTotal, debtTotal: debtTotal, net: assetTotal - debtTotal, byType: byType };
  }

  // ---------- 받는 사람 ----------
  function recipientInfo(item, families) {
    let relation = '가족 외';
    let name = item.toName || '';
    if (item.toType === 'family') {
      const f = families.find(function (x) { return x.id === item.toId; });
      if (f) {
        relation = f.relation;
        name = f.name;
      }
    }
    let years;
    let basis;
    if (relation === '배우자' || relation === '자녀') {
      years = 10;
      basis = '상속인에 해당할 가능성이 높아 사망 전 10년 기준으로 검토';
    } else if (relation === '부모' || relation === '형제자매') {
      years = 10;
      basis = '상속인 해당 여부가 상속순위에 따라 달라져 보수적으로 10년 기준으로 표시 (전문가 확인)';
    } else {
      years = 5;
      basis = '상속인이 아닌 사람은 사망 전 5년 기준으로 검토';
    }
    return { relation: relation, name: name || '(이름 없음)', years: years, basis: basis };
  }

  // 사전증여 합산 검토 대상 여부.
  // "만약 assumeDate에 상속이 시작된다면" 이라는 가정 아래, 증여일이 기준일 전
  // 10년(상속인) 또는 5년(그 외) 이내인지를 분류한다. 경계일(정확히 N년 전)은 포함한다.
  // 실제 합산 여부와 세액 영향은 판단하지 않는다.
  function reviewGifts(gifts, families, assumeDate) {
    return gifts.map(function (g) {
      const info = recipientInfo(g, families);
      let status = 'unknown';
      let cutoff = '';
      if (parseDate(assumeDate) && parseDate(g.date)) {
        cutoff = addYears(assumeDate, -info.years);
        if (g.date > assumeDate) status = 'future';
        else if (g.date >= cutoff) status = 'in';
        else status = 'out';
      }
      return Object.assign({}, g, info, { cutoff: cutoff, status: status });
    });
  }

  // ---------- 준비도 점검 (규칙 기반, AI 미사용) ----------
  function assetStats(assets, today) {
    const unconfirmed = [];
    const stale = [];
    let good = 0;
    assets.forEach(function (a) {
      const isStale = daysBetween(a.asOf, today) > STALE_DAYS;
      const isUnconf = a.status !== '직접 확인';
      if (isUnconf) unconfirmed.push(a);
      if (isStale) stale.push(a);
      if (!isUnconf && !isStale) good++;
    });
    return { count: assets.length, unconfirmed: unconfirmed, stale: stale, good: good };
  }

  function readiness(state, today) {
    const t = today || todayStr();
    const assumeDate = state.assumeDate || t;
    const fam = state.families;
    const nonDebt = state.assets.filter(function (a) { return a.type !== '채무'; });
    const hasDebt = state.assets.some(function (a) { return a.type === '채무'; });
    const st = assetStats(state.assets, t);
    const checkedDocs = DOCS.filter(function (d) { return state.docs[d.id]; }).length;
    const review = reviewGifts(state.gifts, fam, assumeDate);
    const tot = totals(state.assets);
    const items = [];

    function add(id, label, max, earned, detail, tab) {
      items.push({ id: id, label: label, max: max, earned: earned, done: earned >= max, detail: detail, tab: tab });
    }

    if (fam.length === 0) add('family', '가족관계 등록·확인', 20, 0, '가족을 한 명 이상 등록하세요.', 'family');
    else if (!state.confirm.family) {
      add('family', '가족관계 등록·확인', 20, 10, fam.length + '명 등록. 구성이 맞는지 본인 확인이 필요합니다.', 'family');
    } else add('family', '가족관계 등록·확인', 20, 20, fam.length + '명 등록, 본인 확인 완료', 'family');

    if (nonDebt.length === 0) add('assets', '재산 등록', 20, 0, '부동산·예금 등 재산을 한 건 이상 입력하세요.', 'assets');
    else add('assets', '재산 등록', 20, 20, nonDebt.length + '건 등록', 'assets');

    if (st.count === 0) add('quality', '재산 정보의 확인상태·기준일', 15, 0, '재산을 입력하면 확인 상태를 점검합니다.', 'assets');
    else {
      const earned = Math.round((15 * st.good) / st.count);
      const detail =
        earned >= 15
          ? '모든 항목이 직접 확인되었고 기준일이 최근입니다.'
          : '직접 확인·최근 기준일 ' + st.good + '/' + st.count + '건 (추정 또는 나중에 확인 ' + st.unconfirmed.length + '건, 기준일 1년 초과 ' + st.stale.length + '건)';
      add('quality', '재산 정보의 확인상태·기준일', 15, earned, detail, 'assets');
    }

    if (hasDebt) add('debt', '채무 확인', 10, 10, '채무 입력됨', 'assets');
    else if (state.confirm.noDebt) add('debt', '채무 확인', 10, 10, '채무가 없음을 본인이 확인함', 'assets');
    else add('debt', '채무 확인', 10, 0, '채무를 입력하거나 "채무 없음"을 확인하세요.', 'assets');

    if (state.gifts.length > 0) add('gift', '과거 증여 기록', 15, 15, state.gifts.length + '건 기록', 'assets');
    else if (state.confirm.noGift) add('gift', '과거 증여 기록', 15, 15, '과거 증여가 없음을 본인이 확인함', 'assets');
    else add('gift', '과거 증여 기록', 15, 0, '기억나는 증여를 기록하거나 "증여 없음"을 확인하세요.', 'assets');

    if (state.will.items.length > 0) add('will', '유언 의사 정리', 10, 10, state.will.items.length + '건 정리 (법적 효력 없는 초안)', 'will');
    else add('will', '유언 의사 정리', 10, 0, '누구에게 무엇을 남기고 싶은지 정리해 보세요.', 'will');

    add(
      'docs',
      '상담 서류 챙기기',
      10,
      Math.round((10 * checkedDocs) / DOCS.length),
      checkedDocs + '/' + DOCS.length + '개 준비',
      'report'
    );

    const score = items.reduce(function (sum, i) { return sum + i.earned; }, 0);
    const next = items.find(function (i) { return !i.done; }) || null;

    const flags = [];
    if (state.gifts.some(function (g) { return g.date > t; })) {
      flags.push({ level: 'warn', text: '오늘 이후 날짜의 증여 기록이 있습니다. 날짜를 확인하세요.', tab: 'assets' });
    }
    if (st.unconfirmed.length > 0) {
      flags.push({
        level: 'warn',
        text: '"추정" 또는 "나중에 확인"인 항목이 ' + st.unconfirmed.length + '건 있습니다. 상담 전에 근거 자료로 확인하세요.',
        tab: 'assets'
      });
    }
    if (st.stale.length > 0) {
      flags.push({ level: 'warn', text: '기준일이 1년 넘게 지난 항목이 ' + st.stale.length + '건 있습니다. 최신 금액으로 갱신하세요.', tab: 'assets' });
    }
    const inWindow = review.filter(function (r) { return r.status === 'in'; });
    if (inWindow.length > 0) {
      flags.push({
        level: 'info',
        text: '가정 기준일(' + assumeDate + ') 기준으로 사전증여 합산 검토 대상이 ' + inWindow.length + '건 있습니다. 실제 합산 여부는 전문가가 판단합니다.',
        tab: 'check'
      });
    }
    if (review.some(function (r) { return r.relation === '가족 외'; })) {
      flags.push({ level: 'info', text: '가족 외 사람에게 준 증여가 있습니다. 상속인이 아닌 사람은 5년 기준으로 검토합니다.', tab: 'check' });
    }
    if (state.assets.some(function (a) { return a.type === '부동산'; })) {
      flags.push({ level: 'info', text: '부동산은 평가 방식에 따라 금액이 달라질 수 있어 상담 때 평가 기준을 확인하세요.', tab: 'scenario' });
    }
    if (tot.net < 0) {
      flags.push({
        level: 'warn',
        text: '입력 기준으로 채무가 재산보다 많습니다. 상속포기·한정승인 등 선택지를 전문가와 먼저 확인하세요.',
        tab: 'scenario'
      });
    }

    return {
      score: score,
      max: 100,
      items: items,
      next: next,
      flags: flags,
      review: review,
      stats: st,
      totals: tot,
      assumeDate: assumeDate
    };
  }

  // ---------- 상담 질문 (입력 상태에 따라 달라짐) ----------
  function buildQuestions(state, today) {
    const r = readiness(state, today);
    const q = [
      '누락된 재산이나 채무가 없는지, 있다면 어떤 방법으로 확인하나요?',
      '과거 증여가 앞으로의 상속·증여 계획에 어떤 영향을 줄 수 있나요?',
      '유언 의사를 법정 방식에 맞게 남기려면 어떤 절차가 필요한가요?',
      '우리 가족 상황에서 필요한 증빙 서류는 무엇인가요?'
    ];
    if (r.stats.unconfirmed.length > 0) {
      q.push(
        '확인이 덜 된 항목(' +
          r.stats.unconfirmed.slice(0, 3).map(function (a) { return a.name; }).join(', ') +
          ')의 금액과 기준일은 어떤 자료로 확정하나요?'
      );
    }
    if (state.assets.some(function (a) { return a.type === '부동산'; })) {
      q.push('부동산은 어떤 방식으로 평가하고, 어떤 자료를 준비해야 하나요?');
    }
    const inWin = r.review.filter(function (x) { return x.status === 'in'; });
    if (inWin.length > 0) {
      q.push('합산 검토 대상으로 표시된 증여 ' + inWin.length + '건이 실제로 합산되는지, 영향은 어떻게 확인하나요?');
    }
    const outsiders = r.review.filter(function (x) { return x.relation === '가족 외'; });
    if (outsiders.length > 0) {
      q.push('가족 외 수증자(' + outsiders.map(function (x) { return x.name; }).slice(0, 3).join(', ') + ')에게 한 증여는 어떤 기준으로 검토하나요?');
    }
    if (r.totals.net < 0) {
      q.push('입력 기준으로 채무가 더 많습니다. 상속포기·한정승인 등을 어떻게 검토해야 하나요?');
    }
    if (state.families.some(function (f) { return ['부모', '형제자매', '기타'].indexOf(f.relation) >= 0; })) {
      q.push('우리 가족 구성에서 법정 상속인의 범위와 순위는 어떻게 되나요?');
    }
    if (state.will.items.length > 0) {
      q.push('정리한 유언 의사가 가족에게 미칠 영향(유류분 등)은 어떻게 검토하나요?');
    }
    return q;
  }

  // ---------- 시나리오 비교 (교육용 정보. 결론·세액 없음) ----------
  const SCENARIOS = [
    {
      id: 'A',
      title: 'A. 지금 일부 증여',
      summary: '살아 있는 동안 일부 재산을 가족에게 넘기는 경우',
      taxes: '증여세 (재산을 받는 사람이 납세의무자)',
      inputs: ['넘기려는 재산의 종류와 평가 기준일', '받을 사람과 관계', '받을 사람별 과거 증여 내역', '증여 후 본인의 생활자금 계획'],
      rules: [
        '사전증여는 이후 상속 때 합산될 수 있습니다. 상속인은 사망 전 10년, 상속인이 아닌 사람은 5년 이내 증여가 검토 대상입니다.',
        '이 앱의 "준비 점검" 화면이 입력한 증여 기록을 이 기준으로 분류해 보여줍니다. (세액은 계산하지 않음)'
      ],
      uncertainties: ['재산 평가 방식에 따라 금액이 달라질 수 있음', '채무를 함께 넘기는 경우에는 별도 검토가 필요함', '증여 시점에 따라 합산 대상 여부가 달라질 수 있음'],
      expert: ['어떤 재산을 언제 넘기는 것이 가족 상황에 맞는지', '신고·납부 절차와 필요 서류']
    },
    {
      id: 'B',
      title: 'B. 향후 상속 준비',
      summary: '사망 후 상속으로 이전되는 경우를 대비해 정보를 정리하는 경우',
      taxes: '상속세 (상속인 등이 납세의무자)',
      inputs: ['법정 상속인 구성', '재산과 채무 현황', '과거 증여 내역', '유언 의사'],
      rules: [
        '상속세 신고기한은 일반적으로 상속 개시 후 약 6개월입니다. (상속세 및 증여세법 제67조, 정확한 기산점은 전문가 확인)',
        '상속포기·한정승인은 상속 개시를 안 날부터 3개월 안에 해야 합니다. (민법 제1019조)',
        '사망 후 재산 조회는 정부24의 안심상속 원스톱서비스(무료, 사망일이 속한 달의 말일부터 1년 이내 신청)를 이용할 수 있습니다. 조회 항목에 명시되지 않은 재산은 따로 확인이 필요할 수 있어 생전 기록이 도움이 됩니다.'
      ],
      uncertainties: ['재산 평가와 공제 요건은 사안별로 다름', '유언의 방식과 유효성 판단은 별도 절차가 필요함'],
      expert: ['상속 개시 후 해야 할 일의 순서와 기한', '유언 공증 등 법정 방식 선택']
    },
    {
      id: 'C',
      title: 'C. 가족별 배분 검토',
      summary: '누구에게 무엇을 남기고 싶은지 구상하고 쟁점을 살피는 경우',
      taxes: '배분 방식에 따라 증여세·상속세 모두 검토 가능',
      inputs: ['가족별로 남기고 싶은 것과 이유', '가족 간 이해관계와 합의 가능성', '이미 증여한 내역'],
      rules: [
        '유류분 등 상속인의 최소 몫과 관련한 법적 쟁점이 있을 수 있습니다. (민법 제1112조 이하)',
        '분배 방식은 정답이 하나가 아니며, 이 앱은 "최적 배분"을 제시하지 않습니다.'
      ],
      uncertainties: ['제도와 판례는 바뀔 수 있어 전문가가 최신 기준으로 확인해야 함', '가족 간 의견이 다르거나 강요가 의심되면 대면 상담이 우선'],
      expert: ['가족 구성에 맞는 배분 구상의 법적 쟁점', '합의·유언·증여 중 어떤 수단을 쓸지']
    }
  ];

  // ---------- 유언 방식별 핵심 요건 (요약. 유효성 판단은 전문가) ----------
  const WILL_GUIDE = {
    자필증서: {
      law: '민법 제1066조',
      points: ['유언자가 전문(전체 내용), 날짜, 주소, 성명을 직접 쓰고 날인합니다.', '내용을 고치거나 지울 때도 정해진 방식을 지켜야 합니다.']
    },
    녹음: {
      law: '민법 제1067조',
      points: ['유언의 취지, 성명, 날짜를 유언자가 구술하여 녹음합니다.', '증인이 유언이 정확함과 자신의 성명을 구술해야 합니다.']
    },
    공정증서: {
      law: '민법 제1068조',
      points: ['증인 2명이 참여한 가운데 공증인 앞에서 유언의 취지를 말합니다.', '공증인이 받아 적어 낭독하고, 유언자와 증인이 확인한 뒤 서명 또는 기명날인합니다.']
    },
    비밀증서: {
      law: '민법 제1069조',
      points: ['유언 내용을 적은 증서를 봉하고 날인한 뒤 증인 앞에서 자신의 유언서임을 밝힙니다.', '이후 공증인 또는 법원에 제출하는 절차가 따릅니다.']
    },
    구수증서: {
      law: '민법 제1070조',
      points: ['질병 등으로 다른 방식을 따르기 어려운 급박한 사정에서 쓰는 방식입니다.', '증인이 참여해 구술을 받아 적고, 이후 법원 검인 절차가 따릅니다.']
    }
  };

  function willDraft(state) {
    const lines = state.will.items.map(function (w) {
      const info = recipientInfo(w, state.families);
      return info.name + '(' + info.relation + ')에게: ' + w.what + (w.reason ? ' — 이유: ' + w.reason : '');
    });
    return lines;
  }

  // ---------- 샘플(가상) 데이터 ----------
  function sampleState(today) {
    const t = today || todayStr();
    const s = emptyState();
    s.sample = true;
    s.families = [
      { id: 'f1', name: '배우자(가명)', relation: '배우자' },
      { id: 'f2', name: '첫째 자녀(가명)', relation: '자녀' },
      { id: 'f3', name: '둘째 자녀(가명)', relation: '자녀' }
    ];
    s.assets = [
      { id: 'a1', type: '부동산', name: '서울 소재 아파트 (가상)', value: 500000000, asOf: addDays(t, -30), status: '직접 확인' },
      { id: 'a2', type: '예금', name: '정기예금 (가상)', value: 50000000, asOf: addDays(t, -10), status: '직접 확인' },
      { id: 'a3', type: '주식', name: '국내 주식 (가상)', value: 30000000, asOf: addDays(t, -400), status: '추정' },
      { id: 'a4', type: '채무', name: '주택담보대출 (가상)', value: 20000000, asOf: addDays(t, -30), status: '직접 확인' }
    ];
    s.gifts = [
      { id: 'g1', toType: 'family', toId: 'f2', toName: '첫째 자녀(가명)', date: addYears(t, -2), value: 30000000 },
      { id: 'g2', toType: 'family', toId: 'f3', toName: '둘째 자녀(가명)', date: addYears(t, -12), value: 20000000 },
      { id: 'g3', toType: 'other', toId: '', toName: '친척(가명)', date: addYears(t, -3), value: 5000000 }
    ];
    s.will.items = [
      { id: 'w1', toType: 'family', toId: 'f2', toName: '첫째 자녀(가명)', what: '예금 일부', reason: '결혼 준비 지원 (예시)' }
    ];
    s.docs = { family: true };
    return s;
  }

  const api = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    MAX_AMOUNT: MAX_AMOUNT,
    MAX_ITEMS: MAX_ITEMS,
    MAX_FAMILIES: MAX_FAMILIES,
    STALE_DAYS: STALE_DAYS,
    RELATIONS: RELATIONS,
    ASSET_TYPES: ASSET_TYPES,
    STATUSES: STATUSES,
    WILL_METHODS: WILL_METHODS,
    PRICE_CHOICES: PRICE_CHOICES,
    SCENARIO_IDS: SCENARIO_IDS,
    DOCS: DOCS,
    SCENARIOS: SCENARIOS,
    WILL_GUIDE: WILL_GUIDE,
    uid: uid,
    escapeHTML: escapeHTML,
    todayStr: todayStr,
    parseDate: parseDate,
    daysBetween: daysBetween,
    addDays: addDays,
    addYears: addYears,
    formatNumber: formatNumber,
    formatKRW: formatKRW,
    koreanAmount: koreanAmount,
    emptyState: emptyState,
    normalizeState: normalizeState,
    totals: totals,
    recipientInfo: recipientInfo,
    reviewGifts: reviewGifts,
    readiness: readiness,
    buildQuestions: buildQuestions,
    willDraft: willDraft,
    sampleState: sampleState
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.IEUM = api;
})(typeof window !== 'undefined' ? window : globalThis);
