/* =========================================================
   이음 IEUM - shop-ui.js
   이용권 화면, 모의 결제창, 금액권, 관리자 모드 화면
   (규칙은 commerce.js, 저장은 이 기기 localStorage. 실제 결제·실제 보안 아님)
   ========================================================= */
(function () {
  'use strict';

  const S = window.IEUM_SHOP;
  const APP = window.IEUM_APP;
  const L = window.IEUM;
  if (!S || !APP || !L) return;
  const h = L.escapeHTML;
  const KEY = 'ieum.v1.shop';
  const SESSION = 'ieum.v1.admin';
  const $ = function (id) { return document.getElementById(id); };

  let shop = S.emptyShop();
  let co = null; // 결제창 상태 {productId, done, order}
  let adminMode = 'login';
  let failCount = 0;
  let lockUntil = 0;
  let lastCode = '';

  function pad(n) { return String(n).padStart(2, '0'); }
  // 이 기기 시간대 기준 'YYYY-MM-DDTHH:MM:SS'
  function nowLocal() {
    const d = new Date();
    return L.todayStr(d) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function won(n) { return L.formatNumber(n) + '원'; }

  // ---------- 저장 ----------
  function load() {
    try {
      const raw = window.localStorage.getItem(KEY);
      if (raw) {
        const r = S.normalizeShop(JSON.parse(raw));
        if (r.valid) shop = r.shop;
      }
    } catch (e) { /* 새로 시작 */ }
  }
  function persist() {
    try { window.localStorage.setItem(KEY, JSON.stringify(shop)); } catch (e) { /* 저장 불가 환경 */ }
  }
  function changed(msg) {
    persist();
    renderShop();
    APP.renderReport();
    if (msg) APP.announce(msg);
  }

  function isAdmin() {
    try { return window.sessionStorage.getItem(SESSION) === '1'; } catch (e) { return false; }
  }
  function setAdmin(on) {
    try {
      if (on) window.sessionStorage.setItem(SESSION, '1');
      else window.sessionStorage.removeItem(SESSION);
    } catch (e) { /* 무시 */ }
  }

  // ---------- 다른 모듈용 ----------
  window.IEUM_STORE = {
    activeIssue: function (stamp) { return S.activeIssue(shop, stamp); },
    canIssue: function () { return S.canUse(shop, 'report', L.todayStr()); },
    issueHint: function () {
      if (S.unlimitedActive(shop, L.todayStr())) return '가족 기록관리(연간) 이용 중이라 발급권이 차감되지 않습니다.';
      return '남은 발급권 ' + shop.wallet.report + '장 (발급할 때 1장 사용)';
    },
    issue: function (stamp) {
      const r = S.issueReport(shop, nowLocal(), stamp);
      if (r.ok) {
        persist();
        renderWallet();
      }
      return r;
    },
    aiLeft: function () { return shop.wallet.ai; },
    useAi: function (detail) {
      const r = S.useAi(shop, nowLocal(), detail);
      if (r.ok) {
        persist();
        renderShop();
      }
      return r;
    },
    isAdmin: isAdmin
  };

  // ---------- 이용권 화면 ----------
  function renderWallet() {
    const w = shop.wallet;
    const unlimited = S.unlimitedActive(shop, L.todayStr());
    $('walletChip').innerHTML =
      '<span class="chip-ai">AI ' + w.ai + '회</span><span class="chip-sep" aria-hidden="true">·</span>' +
      (unlimited ? '<span>리포트 무제한</span>' : '<span>발급권 ' + w.report + '장</span>');
    $('walletChip').setAttribute('aria-label', '내 이용권: AI ' + w.ai + '회, ' + (unlimited ? '리포트 무제한' : '리포트 발급권 ' + w.report + '장') + '. 이용권 화면으로 이동');
    $('walletView').innerHTML =
      tile('AI 이용', w.ai + '회', '서류 읽기·브리핑·도우미 1번에 1회') +
      tile('리포트 발급권', unlimited ? '무제한' : w.report + '장', unlimited ? w.unlimitedUntil + '까지' : '발급 1번에 1장') +
      tile('가족 기록관리', unlimited ? '이용 중' : '없음', unlimited ? '~ ' + w.unlimitedUntil : '연간 상품') +
      tile('금액권 잔액', won(w.balance), '이용권 결제에 사용');
  }
  function tile(label, value, sub) {
    return '<div class="tile"><span>' + h(label) + '</span><b>' + h(value) + '</b><small>' + h(sub) + '</small></div>';
  }

  function renderProducts() {
    $('productGrid').innerHTML = shop.products
      .filter(function (p) { return p.active; })
      .map(function (p) {
        const blocked = p.requires && !S.hasPurchased(shop, p.requires);
        const req = blocked ? shop.products.find(function (x) { return x.id === p.requires; }) : null;
        return (
          '<div class="product' + (p.id === 'package' ? ' featured' : '') + '">' +
          '<div class="product-top"><span class="badge ' + (p.kind === 'gift' ? 'gift' : 'info') + '">' + (p.kind === 'gift' ? '금액권' : '이용권') + '</span>' +
          (p.id === 'package' ? '<span class="badge ai">기본 상품</span>' : '') + '</div>' +
          '<h4>' + h(p.name) + '</h4><p class="price">' + won(p.price) + '</p><p class="sub">' + h(p.desc) + '</p>' +
          (blocked ? '<p class="sub warn-text">"' + h(req ? req.name : p.requires) + '" 구매 후 이용할 수 있습니다.</p>' : '') +
          '<button type="button" class="primary" data-action="buy" data-id="' + h(p.id) + '"' + (blocked ? ' disabled' : '') + '>' +
          (p.kind === 'gift' ? '선물용으로 구매' : '구매하기') + '</button></div>'
        );
      })
      .join('') || '<p class="muted">판매 중인 상품이 없습니다.</p>';
  }

  function statusLabel(o) {
    return o.status === 'paid' ? '<span class="badge ok">결제 완료</span>' : '<span class="badge">환불됨</span>';
  }

  function renderOrders() {
    if (!shop.orders.length) {
      $('orderList').innerHTML = '<p class="muted">아직 주문이 없습니다.</p>';
      return;
    }
    $('orderList').innerHTML =
      '<table><thead><tr><th scope="col">주문번호</th><th scope="col">상품</th><th scope="col">금액</th><th scope="col">결제 수단</th><th scope="col">상태</th><th scope="col">금액권 번호</th><th scope="col"><span class="sr">환불</span></th></tr></thead><tbody>' +
      shop.orders.slice(0, 50).map(function (o) {
        const can = o.status === 'paid' && S.refundable(shop, o.id).ok;
        const code = o.code ? shop.codes.find(function (c) { return c.code === o.code; }) : null;
        return (
          '<tr><td class="mono">' + h(o.no) + '<div class="sub">' + h(APP.fmtTime(o.at)) + '</div></td><td>' + h(o.name) + '</td><td>' + won(o.price) + '</td><td>' + h(S.METHODS[o.method]) + '</td><td>' + statusLabel(o) + '</td>' +
          '<td>' + (o.code ? '<span class="mono">' + h(o.code) + '</span><div class="sub">' + h(codeStatus(code)) + '</div>' : '—') + '</td>' +
          '<td>' + (can ? '<button type="button" class="secondary small" data-action="refund" data-id="' + h(o.id) + '">환불</button>' : '') + '</td></tr>'
        );
      }).join('') +
      '</tbody></table>';
  }
  function codeStatus(c) {
    if (!c) return '';
    return c.status === 'issued' ? '미사용' : c.status === 'used' ? '등록 완료' : '취소됨';
  }

  // ---------- 결제창 ----------
  function openCheckout(productId) {
    const p = shop.products.find(function (x) { return x.id === productId; });
    if (!p) return;
    co = { productId: productId, done: false, order: null };
    renderCheckout();
    const dlg = $('checkoutDlg');
    if (dlg.showModal) dlg.showModal();
    else dlg.setAttribute('open', '');
    const first = dlg.querySelector('input[name="coMethod"]:not([disabled])');
    if (first) first.focus();
  }

  function renderCheckout(error) {
    const p = shop.products.find(function (x) { return x.id === co.productId; });
    const body = $('checkoutBody');
    if (co.done) {
      const o = co.order;
      let given = '';
      if (o.kind === 'pass') {
        const g = [];
        if (o.grants.report) g.push('리포트 발급권 ' + o.grants.report + '장');
        if (o.grants.days) g.push(o.grants.days + '일간 리포트 무제한');
        if (o.grants.ai) g.push('AI ' + o.grants.ai + '회');
        given = '<p>지급 완료: <b>' + h(g.join(', ')) + '</b></p>';
      } else {
        given = '<p>금액권 번호</p><div class="code-box mono" id="giftCode">' + h(o.code) + '</div>' +
          '<button type="button" class="secondary small" data-action="copy-code" data-code="' + h(o.code) + '">번호 복사</button>' +
          '<p class="muted">선물할 분께 번호를 전달하세요. 이용권 화면의 "금액권 등록"에서 잔액으로 바꿀 수 있습니다.</p>';
      }
      body.innerHTML =
        '<div class="co-done"><div class="done-mark" aria-hidden="true">✓</div><h2 id="checkoutTitle" tabindex="-1">결제가 완료되었습니다</h2>' +
        '<p class="muted">모의 결제 · 실제 청구 없음</p>' +
        '<dl class="receipt"><dt>주문번호</dt><dd class="mono">' + h(o.no) + '</dd><dt>상품</dt><dd>' + h(o.name) + '</dd><dt>결제 금액</dt><dd>' + won(o.price) + '</dd><dt>결제 수단</dt><dd>' + h(S.METHODS[o.method]) + '</dd></dl>' +
        given +
        '<div class="btn-row"><button type="button" class="primary" data-action="dlg-close" data-dlg="checkoutDlg">확인</button></div></div>';
      const t = $('checkoutTitle');
      if (t) t.focus();
      return;
    }
    const bal = shop.wallet.balance;
    const balOk = p.kind !== 'gift' && bal >= p.price;
    body.innerHTML =
      '<h2 id="checkoutTitle">결제하기 <span class="badge warn">모의 결제</span></h2>' +
      '<div class="co-item"><div><b>' + h(p.name) + '</b><div class="sub">' + h(p.desc) + '</div></div><strong>' + won(p.price) + '</strong></div>' +
      '<fieldset class="include"><legend>결제 수단</legend>' +
      '<label class="check"><input type="radio" name="coMethod" value="card"> 모의 신용카드 <span class="sub">(카드번호 입력 없음)</span></label>' +
      '<label class="check"><input type="radio" name="coMethod" value="easy"> 모의 간편결제</label>' +
      '<label class="check"><input type="radio" name="coMethod" value="balance"' + (balOk ? '' : ' disabled') + '> 금액권 잔액 <span class="sub">(잔액 ' + won(bal) + (p.kind === 'gift' ? ', 금액권 구매에는 사용 불가' : '') + ')</span></label>' +
      '</fieldset>' +
      '<label class="check"><input type="checkbox" id="coAgree"> 실제 결제가 아닌 <b>시연용 모의 결제</b>임을 확인했습니다</label>' +
      '<p class="form-error" id="coError" role="alert">' + h(error || '') + '</p>' +
      '<div class="btn-row"><button type="button" class="primary" id="coPay" data-action="co-pay">' + won(p.price) + ' 결제하기</button>' +
      '<button type="button" class="secondary" data-action="dlg-close" data-dlg="checkoutDlg">취소</button></div>';
  }

  function pay() {
    const m = document.querySelector('input[name="coMethod"]:checked');
    if (!m) return renderCheckout('결제 수단을 선택하세요.');
    if (!$('coAgree').checked) {
      $('coError').textContent = '모의 결제임을 확인해 주세요.';
      $('coAgree').focus();
      return;
    }
    const btn = $('coPay');
    btn.disabled = true;
    btn.textContent = '결제 처리 중…';
    btn.setAttribute('aria-busy', 'true');
    setTimeout(function () {
      const r = S.purchase(shop, co.productId, m.value, nowLocal());
      if (!r.ok) {
        renderCheckout(r.error);
        return;
      }
      co.done = true;
      co.order = r.order;
      changed(r.order.name + ' 결제가 완료되었습니다.');
      renderCheckout();
    }, 700);
  }

  function copyCode(code) {
    const done = function () { APP.announce('금액권 번호를 복사했습니다.'); };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).then(done, function () { selectCode(); });
        return;
      }
    } catch (e) { /* 아래로 */ }
    selectCode();
  }
  function selectCode() {
    const el = $('giftCode') || $('lastCode');
    if (!el) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    APP.announce('번호를 선택했습니다. Ctrl+C로 복사하세요.');
  }

  // ---------- 관리자 ----------
  function hex(buf) {
    return Array.prototype.map.call(new Uint8Array(buf), function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }
  async function digest(salt, pw) {
    const data = new TextEncoder().encode(salt + ':' + pw);
    return hex(await window.crypto.subtle.digest('SHA-256', data));
  }
  function cryptoOk() {
    return !!(window.crypto && window.crypto.subtle && window.TextEncoder);
  }

  function openAdmin() {
    if (isAdmin()) {
      APP.navigate('admin');
      return;
    }
    adminMode = shop.admin.hash ? 'login' : 'setup';
    $('adminDlgTitle').textContent = adminMode === 'setup' ? '관리자 비밀번호 만들기' : '관리자 로그인';
    $('adminDlgDesc').textContent =
      adminMode === 'setup'
        ? '이 기기에서 처음 쓰는 관리자 비밀번호를 정하세요 (6자 이상). 비밀번호는 원문이 아닌 해시값으로만 이 기기에 저장됩니다.'
        : '이 기기에서 정한 관리자 비밀번호를 입력하세요.';
    $('adminPw2Wrap').hidden = adminMode !== 'setup';
    $('adminSubmit').textContent = adminMode === 'setup' ? '만들고 로그인' : '로그인';
    $('adminPw').value = '';
    $('adminPw2').value = '';
    $('adminPw').setAttribute('autocomplete', adminMode === 'setup' ? 'new-password' : 'current-password');
    $('adminError').textContent = '';
    const dlg = $('adminDlg');
    if (dlg.showModal) dlg.showModal();
    else dlg.setAttribute('open', '');
    $('adminPw').focus();
  }

  async function submitAdmin(e) {
    e.preventDefault();
    const err = $('adminError');
    err.textContent = '';
    if (!cryptoOk()) {
      err.textContent = '이 브라우저에서는 관리자 기능을 쓸 수 없습니다. (https 주소나 최신 브라우저에서 열어 주세요)';
      return;
    }
    if (Date.now() < lockUntil) {
      err.textContent = '비밀번호를 여러 번 틀렸습니다. ' + Math.ceil((lockUntil - Date.now()) / 1000) + '초 뒤 다시 시도하세요.';
      return;
    }
    const pw = $('adminPw').value;
    if (pw.length < 6) {
      err.textContent = '비밀번호는 6자 이상이어야 합니다.';
      $('adminPw').focus();
      return;
    }
    if (adminMode === 'setup') {
      if (pw !== $('adminPw2').value) {
        err.textContent = '두 비밀번호가 서로 다릅니다.';
        $('adminPw2').focus();
        return;
      }
      const salt = hex(window.crypto.getRandomValues(new Uint8Array(16)));
      shop.admin = { salt: salt, hash: await digest(salt, pw) };
      persist();
    } else {
      const got = await digest(shop.admin.salt, pw);
      if (got !== shop.admin.hash) {
        failCount += 1;
        if (failCount >= 5) {
          lockUntil = Date.now() + 30000;
          failCount = 0;
        }
        err.textContent = '비밀번호가 맞지 않습니다.';
        $('adminPw').select();
        return;
      }
    }
    failCount = 0;
    $('adminPw').value = '';
    $('adminPw2').value = '';
    setAdmin(true);
    $('adminDlg').close();
    renderShop();
    APP.navigate('admin');
    APP.announce('관리자 모드로 접속했습니다.');
  }

  function logout() {
    setAdmin(false);
    renderShop();
    APP.navigate('home');
    APP.announce('관리자 모드에서 로그아웃했습니다.');
  }

  function renderAdmin() {
    const on = isAdmin();
    $('adminTab').hidden = !on;
    $('adminBtn').textContent = on ? '관리자 모드' : '관리자';
    $('adminBtn').classList.toggle('on', on);
    $('adminBody').hidden = !on;
    $('adminGate').innerHTML = on
      ? '<p class="muted">관리자 모드로 접속 중입니다. 이 화면은 시연용이며, 실제 서비스에서는 서버 인증과 권한 관리가 필요합니다.</p>'
      : '<p>관리자 로그인이 필요합니다.</p><button type="button" class="primary" data-action="admin-open">로그인</button>';
    if (!on) return;

    const st = S.stats(shop);
    const pct = Math.round(st.bepRate * 1000) / 10;
    $('adminStats').innerHTML =
      '<div class="wallet">' +
      tile('이용권 매출 (VAT 포함)', won(st.revenue), '공급가 ' + won(st.supply)) +
      tile('결제 / 환불', st.orders + '건 / ' + st.refunds + '건', '모의 주문 기준') +
      tile('금액권 판매', won(st.giftSales), '미사용 잔액 ' + won(st.outstandingGift)) +
      tile('준비 패키지 판매', st.packages + '건', '추정 공헌이익 ' + won(st.contribution)) +
      '</div>' +
      '<div class="bep"><div class="bep-head"><b>월 손익분기까지</b><span>' + st.packages + ' / ' + st.bep + '건 (' + pct + '%)</span></div>' +
      '<div class="bar" role="progressbar" aria-label="손익분기 진행률" aria-valuemin="0" aria-valuemax="' + st.bep + '" aria-valuenow="' + st.packages + '"><i style="width:' + Math.max(pct, st.packages ? 1 : 0) + '%"></i></div>' +
      '<p class="muted">계획서 가정: 패키지 89,000원(공급가 80,909원) − 변동비 15,000원 − 고객 확보비 30,000원 = 건당 공헌이익 ' + won(st.unitContribution) + ', 월 고정비 1,000만원 → 월 279건. 금액권은 선수금이라 쓰일 때 매출로 잡습니다.</p></div>';

    $('adminProducts').innerHTML =
      '<table><thead><tr><th scope="col">상품</th><th scope="col">구분</th><th scope="col">가격</th><th scope="col">판매</th></tr></thead><tbody>' +
      shop.products.map(function (p) {
        const priceCell = p.kind === 'gift'
          ? won(p.price) + '<div class="sub">액면가 고정</div>'
          : '<div class="inline-form tight"><label class="sr" for="price-' + h(p.id) + '">' + h(p.name) + ' 가격</label><input id="price-' + h(p.id) + '" type="number" min="0" step="100" value="' + p.price + '">' +
            '<button type="button" class="secondary small" data-action="p-price" data-id="' + h(p.id) + '">저장</button></div>';
        return '<tr><td><b>' + h(p.name) + '</b><div class="sub">' + h(p.desc) + '</div></td><td>' + (p.kind === 'gift' ? '금액권' : '이용권') + '</td><td>' + priceCell + '</td>' +
          '<td><button type="button" class="' + (p.active ? 'secondary' : 'danger') + ' small" data-action="p-toggle" data-id="' + h(p.id) + '" aria-pressed="' + p.active + '">' + (p.active ? '판매 중' : '판매 중지') + '</button></td></tr>';
      }).join('') +
      '</tbody></table>';

    $('adminCodes').innerHTML =
      (lastCode ? '<p>방금 발급한 번호: <span class="code-box mono inline" id="lastCode">' + h(lastCode) + '</span> <button type="button" class="secondary small" data-action="copy-code" data-code="' + h(lastCode) + '">복사</button></p>' : '') +
      (shop.codes.length
        ? '<table><thead><tr><th scope="col">번호</th><th scope="col">금액</th><th scope="col">상태</th><th scope="col">발급</th></tr></thead><tbody>' +
          shop.codes.slice(0, 30).map(function (c) {
            return '<tr><td class="mono">' + h(c.code) + '</td><td>' + won(c.amount) + '</td><td>' + h(codeStatus(c)) + '</td><td>' + (c.source === 'admin' ? '관리자' : '구매') + ' · ' + h(c.memo) + '</td></tr>';
          }).join('') + '</tbody></table>'
        : '<p class="muted">발급한 금액권이 없습니다.</p>');

    $('adminLog').innerHTML = shop.log.length
      ? shop.log.slice(0, 20).map(function (l) { return '<li><span class="sub">' + h(APP.fmtTime(l.at)) + '</span> ' + h(l.text) + '</li>'; }).join('')
      : '<li class="sub">기록이 없습니다.</li>';
  }

  function renderShop() {
    renderWallet();
    renderProducts();
    renderOrders();
    renderAdmin();
  }

  function intVal(id) {
    const v = $(id).value.trim();
    if (v === '') return NaN;
    const n = Number(v);
    return Number.isInteger(n) ? n : NaN;
  }

  // ---------- 이벤트 ----------
  document.addEventListener('click', function (e) {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const act = el.dataset.action;
    const now = nowLocal();
    if (act === 'buy') openCheckout(el.dataset.id);
    else if (act === 'co-pay') pay();
    else if (act === 'dlg-close') {
      const d = $(el.dataset.dlg);
      if (d && d.close) d.close();
    } else if (act === 'copy-code') copyCode(el.dataset.code);
    else if (act === 'refund') {
      const o = shop.orders.find(function (x) { return x.id === el.dataset.id; });
      if (!o || !window.confirm('"' + o.name + '" 주문(' + won(o.price) + ')을 환불할까요? 모의 결제라 실제 돈은 오가지 않습니다.')) return;
      const r = S.refund(shop, o.id, now);
      if (!r.ok) window.alert(r.error);
      else changed('환불했습니다.');
    } else if (act === 'admin-open') openAdmin();
    else if (act === 'admin-logout') logout();
    else if (act === 'p-price') {
      const r = S.adminSetPrice(shop, el.dataset.id, intVal('price-' + el.dataset.id), now);
      if (!r.ok) window.alert(r.error);
      else changed('가격을 바꿨습니다.');
    } else if (act === 'p-toggle') {
      const r = S.adminToggle(shop, el.dataset.id, now);
      if (r.ok) changed(r.active ? '판매를 다시 시작했습니다.' : '판매를 중지했습니다.');
    } else if (act === 'shop-reset') {
      if (!window.confirm('이용권, 주문, 금액권, 활동 기록을 모두 처음 상태로 되돌릴까요? (관리자 비밀번호와 AI 설정은 유지)')) return;
      const keep = shop.admin;
      shop = S.emptyShop();
      shop.admin = keep;
      lastCode = '';
      changed('이용권·주문 기록을 초기화했습니다.');
    }
  });

  $('adminBtn').addEventListener('click', openAdmin);
  $('adminForm').addEventListener('submit', submitAdmin);

  $('redeemForm').addEventListener('submit', function (e) {
    e.preventDefault();
    const r = S.redeem(shop, $('redeemCode').value, nowLocal());
    $('redeemError').textContent = r.ok ? '' : r.error;
    if (r.ok) {
      $('redeemCode').value = '';
      changed(L.formatNumber(r.amount) + '원이 금액권 잔액으로 충전되었습니다.');
    }
  });

  $('productForm').addEventListener('submit', function (e) {
    e.preventDefault();
    const r = S.adminAddProduct(shop, { name: $('pName').value, price: intVal('pPrice'), ai: intVal('pAi'), report: intVal('pReport'), days: intVal('pDays') }, nowLocal());
    $('productError').textContent = r.ok ? '' : r.error;
    if (r.ok) {
      $('productForm').reset();
      changed('"' + r.product.name + '" 상품을 추가했습니다.');
    }
  });

  $('codeForm').addEventListener('submit', function (e) {
    e.preventDefault();
    const r = S.adminIssueCode(shop, intVal('codeAmount'), $('codeMemo').value, nowLocal());
    $('codeError').textContent = r.ok ? '' : r.error;
    if (r.ok) {
      lastCode = r.code;
      $('codeForm').reset();
      changed('금액권을 발급했습니다: ' + r.code);
    }
  });

  $('grantForm').addEventListener('submit', function (e) {
    e.preventDefault();
    const r = S.adminGrant(shop, intVal('grantAi'), intVal('grantReport'), nowLocal());
    $('grantError').textContent = r.ok ? '' : r.error;
    if (r.ok) changed('이용권을 지급했습니다.');
  });

  window.addEventListener('storage', function (e) {
    if (e.key !== KEY) return;
    load();
    renderShop();
    APP.renderReport();
  });

  load();
  persist();
  APP.onRender(renderShop);
  APP.renderAll();
})();
