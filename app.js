/* =========================================================
   이음 IEUM - app.js
   화면·입력·저장 담당. 규칙과 계산은 logic.js(window.IEUM)를 사용합니다.
   - 서버 없음. 입력값은 이 기기 브라우저(localStorage)에만 저장
   - 모든 사용자 입력은 escapeHTML을 거쳐 화면에 표시
   ========================================================= */
(function () {
  'use strict';

  const L = window.IEUM;
  const h = L.escapeHTML;
  const KEY = 'ieum.v1.state';
  const PREF_KEY = 'ieum.v1.prefs';
  const TAB_IDS = ['home', 'family', 'assets', 'check', 'scenario', 'will', 'report', 'assistant', 'store', 'data', 'admin'];
  const renderHooks = [];
  const SOURCES = {
    flow: { name: '국세청 상속세 세액계산 흐름도', url: 'https://www.nts.go.kr/nts/cm/cntnts/cntntsView.do?mi=2326&cntntsId=7720' },
    onestop: { name: '정부24 안심상속', url: 'https://www.gov.kr/portal/onestopSvc/safeInheritance' }
  };
  const REVIEW_LABEL = { in: '합산 검토 대상', out: '검토 기간 밖', future: '기준일 이후 증여', unknown: '기준일 확인 필요' };
  const REVIEW_BADGE = { in: 'warn', out: 'ok', future: 'info', unknown: 'info' };

  let state = L.emptyState();
  let prefs = { size: 'normal', contrast: 'normal' };
  let storageOk = true;
  let notices = [];
  let currentTab = 'home';
  const editing = { family: null, asset: null, gift: null, will: null };

  const $ = function (id) { return document.getElementById(id); };

  // ---------- 저장 ----------
  function storageGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { storageOk = false; return null; }
  }
  function storageSet(key, val) {
    try { window.localStorage.setItem(key, val); return true; } catch (e) { return false; }
  }
  function storageRemove(key) {
    try { window.localStorage.removeItem(key); } catch (e) { /* 저장소를 쓸 수 없는 환경 */ }
  }

  function loadState() {
    const raw = storageGet(KEY);
    if (!raw) return;
    try {
      const res = L.normalizeState(JSON.parse(raw));
      if (res.valid) {
        state = res.state;
        if (res.dropped > 0) notices.push('저장된 데이터에서 형식이 맞지 않는 항목 ' + res.dropped + '건을 제외하고 불러왔습니다.');
        return;
      }
    } catch (e) { /* 아래에서 처리 */ }
    storageSet(KEY + '.corrupt', raw);
    notices.push('저장된 데이터를 읽지 못해 새로 시작합니다. (원본은 이 브라우저에 백업해 두었습니다)');
  }

  function loadPrefs() {
    const raw = storageGet(PREF_KEY);
    if (!raw) return;
    try {
      const p = JSON.parse(raw);
      if (['normal', 'large', 'xlarge'].indexOf(p.size) >= 0) prefs.size = p.size;
      if (['normal', 'high'].indexOf(p.contrast) >= 0) prefs.contrast = p.contrast;
    } catch (e) { /* 기본값 사용 */ }
  }

  function save() {
    state.meta.updatedAt = new Date().toISOString();
    storageOk = storageSet(KEY, JSON.stringify(state));
  }

  function commit(msg) {
    save();
    renderAll();
    if (msg) announce(msg);
  }

  function announce(msg) {
    const el = $('live');
    if (!el) return;
    el.textContent = '';
    setTimeout(function () { el.textContent = msg; }, 30);
  }

  function hasData() {
    return (
      state.families.length > 0 ||
      state.assets.length > 0 ||
      state.gifts.length > 0 ||
      state.will.items.length > 0 ||
      state.confirm.noDebt ||
      state.confirm.noGift
    );
  }

  // ---------- 화면 설정 ----------
  function applyPrefs() {
    const root = document.documentElement;
    root.dataset.size = prefs.size;
    root.dataset.contrast = prefs.contrast === 'high' ? 'high' : 'normal';
    document.querySelectorAll('[data-action="size"]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.size === prefs.size));
    });
    const c = document.querySelector('[data-action="contrast"]');
    if (c) c.setAttribute('aria-pressed', String(prefs.contrast === 'high'));
  }
  function savePrefs() { storageSet(PREF_KEY, JSON.stringify(prefs)); }

  // ---------- 탭 ----------
  function showTab(id, focus) {
    if (TAB_IDS.indexOf(id) < 0) id = 'home';
    currentTab = id;
    TAB_IDS.forEach(function (t) { $(t).hidden = t !== id; });
    document.querySelectorAll('.tabs [data-tab]').forEach(function (b) {
      if (b.dataset.tab === id) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    if (focus) {
      window.scrollTo(0, 0);
      const hd = $('h-' + id);
      if (hd) hd.focus({ preventScroll: true });
    }
  }

  function navigate(id) {
    if (TAB_IDS.indexOf(id) < 0) return;
    if (currentTab !== id) {
      try { history.pushState({ tab: id }, '', '#' + id); } catch (e) { /* 일부 환경에서는 주소 기록 없이 동작 */ }
    }
    showTab(id, true);
  }

  // ---------- 공통 보조 ----------
  function setError(errId, msg, focusId) {
    const el = $(errId);
    el.textContent = msg;
    if (focusId) {
      const f = $(focusId);
      f.setAttribute('aria-invalid', 'true');
      f.focus();
    }
  }
  function clearErrors(form) {
    form.querySelectorAll('.form-error').forEach(function (e) { e.textContent = ''; });
    form.querySelectorAll('[aria-invalid]').forEach(function (e) { e.removeAttribute('aria-invalid'); });
  }

  function readAmount(inputId, allowZero) {
    const el = $(inputId);
    if (el.validity && el.validity.badInput) return { err: '숫자만 입력하세요. (쉼표나 글자 없이)' };
    const raw = el.value.trim();
    if (raw === '') return { err: '금액을 입력하세요.' };
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n)) return { err: '금액은 원 단위 정수로 입력하세요. (소수점 없이)' };
    if (n < 0 || (!allowZero && n === 0)) return { err: allowZero ? '금액은 0원 이상이어야 합니다.' : '금액은 0원보다 커야 합니다.' };
    if (n > L.MAX_AMOUNT) return { err: '금액이 너무 큽니다. 최대 ' + L.koreanAmount(L.MAX_AMOUNT) + '까지 입력할 수 있습니다.' };
    return { value: n };
  }

  function showAmountHint(inputId, hintId) {
    const el = $(inputId);
    const n = el.valueAsNumber;
    let msg = '';
    if (el.validity && el.validity.badInput) msg = '숫자만 입력하세요. (쉼표 없이)';
    else if (Number.isFinite(n) && Number.isInteger(n) && n >= 0 && n <= L.MAX_AMOUNT) msg = '= ' + L.koreanAmount(n);
    $(hintId).textContent = msg;
  }

  function readDate(inputId, label) {
    const v = $(inputId).value;
    if (!L.parseDate(v)) return { err: label + '을(를) 날짜로 입력하세요. (예: 2026-03-15)' };
    if (v > L.todayStr()) return { err: label + '은(는) 오늘 이전 날짜여야 합니다.' };
    return { value: v };
  }

  function findById(arr, id) {
    return arr.find(function (x) { return x.id === id; });
  }

  function money(n) {
    return h(L.koreanAmount(n)) + ' <span class="sub">(' + h(L.formatKRW(n)) + ')</span>';
  }

  function emptyLi(msg) { return '<li class="empty">' + h(msg) + '</li>'; }

  // ---------- 받는 사람 선택 ----------
  function renderRecipientSelect(selId, wrapId) {
    const sel = $(selId);
    const prev = sel.value;
    let html = state.families
      .map(function (f) { return '<option value="f:' + h(f.id) + '">' + h(f.name) + ' (' + h(f.relation) + ')</option>'; })
      .join('');
    html += '<option value="other">가족 외 사람 (직접 입력)</option>';
    sel.innerHTML = html;
    // "가족 외 사람"은 이용자가 직접 고른 경우에만 유지하고, 그 밖에는 첫 번째 가족을 기본값으로 둔다.
    const keep = prev && (prev !== 'other' || sel.dataset.touched === '1');
    if (keep && Array.prototype.some.call(sel.options, function (o) { return o.value === prev; })) sel.value = prev;
    $(wrapId).hidden = sel.value !== 'other';
  }

  function readRecipient(selId, nameId, errId) {
    const v = $(selId).value;
    if (v.indexOf('f:') === 0) {
      const f = findById(state.families, v.slice(2));
      if (f) return { toType: 'family', toId: f.id, toName: f.name };
    }
    const name = $(nameId).value.trim();
    if (!name) {
      setError(errId, '받는 사람의 이름(가명)을 입력하세요.', nameId);
      return null;
    }
    return { toType: 'other', toId: '', toName: name.slice(0, 36) };
  }

  function setRecipientControls(selId, nameId, wrapId, item) {
    renderRecipientSelect(selId, wrapId);
    const sel = $(selId);
    if (item.toType === 'family' && findById(state.families, item.toId)) {
      sel.value = 'f:' + item.toId;
      $(nameId).value = '';
    } else {
      sel.value = 'other';
      $(nameId).value = item.toName || '';
    }
    sel.dataset.touched = sel.value === 'other' ? '1' : '';
    $(wrapId).hidden = sel.value !== 'other';
  }

  // ---------- 폼 초기화 ----------
  function setFormMode(kind, on, submitId, cancelId, addLabel) {
    $(submitId).textContent = on ? '수정 내용 저장' : addLabel;
    $(cancelId).hidden = !on;
  }

  function resetFamilyForm() {
    editing.family = null;
    $('familyForm').reset();
    clearErrors($('familyForm'));
    setFormMode('family', false, 'familySubmit', 'familyCancel', '가족 추가');
  }
  function resetAssetForm() {
    editing.asset = null;
    $('assetForm').reset();
    $('assetAsOf').value = L.todayStr();
    $('assetValueHint').textContent = '';
    clearErrors($('assetForm'));
    setFormMode('asset', false, 'assetSubmit', 'assetCancel', '추가');
  }
  function resetGiftForm() {
    editing.gift = null;
    $('giftForm').reset();
    $('giftAmountHint').textContent = '';
    clearErrors($('giftForm'));
    $('giftTo').dataset.touched = '';
    renderRecipientSelect('giftTo', 'giftOtherWrap');
    setFormMode('gift', false, 'giftSubmit', 'giftCancel', '증여 기록 추가');
  }
  function resetWillForm() {
    editing.will = null;
    $('willForm').reset();
    clearErrors($('willForm'));
    $('willTo').dataset.touched = '';
    renderRecipientSelect('willTo', 'willOtherWrap');
    setFormMode('will', false, 'willSubmit', 'willCancel', '추가');
  }
  function resetForms() {
    resetFamilyForm();
    resetAssetForm();
    resetGiftForm();
    resetWillForm();
  }

  // ---------- 제출 ----------
  function submitFamily(e) {
    e.preventDefault();
    const form = $('familyForm');
    clearErrors(form);
    const name = $('familyName').value.trim();
    const relation = $('familyRelation').value;
    if (!name) return setError('familyError', '표시 이름(가명 또는 호칭)을 입력하세요.', 'familyName');
    const target = editing.family ? findById(state.families, editing.family) : null;
    if (target) {
      target.name = name;
      target.relation = relation;
    } else {
      if (state.families.length >= L.MAX_FAMILIES) return setError('familyError', '가족은 최대 ' + L.MAX_FAMILIES + '명까지 등록할 수 있습니다.');
      state.families.push({ id: L.uid(), name: name, relation: relation });
    }
    state.confirm.family = false;
    resetFamilyForm();
    commit('가족 정보를 저장했습니다. 구성이 맞는지 다시 확인해 주세요.');
    $('familyName').focus();
  }

  function submitAsset(e) {
    e.preventDefault();
    const form = $('assetForm');
    clearErrors(form);
    const name = $('assetName').value.trim();
    if (!name) return setError('assetError', '항목명을 입력하세요.', 'assetName');
    const amt = readAmount('assetValue', true);
    if (amt.err) return setError('assetError', amt.err, 'assetValue');
    const d = readDate('assetAsOf', '금액 기준일');
    if (d.err) return setError('assetError', d.err, 'assetAsOf');
    const rec = {
      type: $('assetType').value,
      name: name.slice(0, 60),
      value: amt.value,
      asOf: d.value,
      status: $('assetStatus').value
    };
    const target = editing.asset ? findById(state.assets, editing.asset) : null;
    if (target) Object.assign(target, rec);
    else {
      if (state.assets.length >= L.MAX_ITEMS) return setError('assetError', '항목은 최대 ' + L.MAX_ITEMS + '건까지 입력할 수 있습니다.');
      state.assets.push(Object.assign({ id: L.uid() }, rec));
    }
    // 채무를 입력하면 "채무 없음" 확인은 더 이상 맞지 않는다.
    if (rec.type === '채무') state.confirm.noDebt = false;
    resetAssetForm();
    commit('재산·채무 항목을 저장했습니다.');
    $('assetName').focus();
  }

  function submitGift(e) {
    e.preventDefault();
    const form = $('giftForm');
    clearErrors(form);
    const to = readRecipient('giftTo', 'giftOtherName', 'giftError');
    if (!to) return;
    const d = readDate('giftDate', '증여일');
    if (d.err) return setError('giftError', d.err, 'giftDate');
    const amt = readAmount('giftAmount', false);
    if (amt.err) return setError('giftError', amt.err, 'giftAmount');
    const rec = Object.assign({ date: d.value, value: amt.value }, to);
    const target = editing.gift ? findById(state.gifts, editing.gift) : null;
    if (target) Object.assign(target, rec);
    else {
      if (state.gifts.length >= L.MAX_ITEMS) return setError('giftError', '증여 기록은 최대 ' + L.MAX_ITEMS + '건까지 입력할 수 있습니다.');
      state.gifts.push(Object.assign({ id: L.uid() }, rec));
    }
    state.confirm.noGift = false;
    resetGiftForm();
    commit('증여 기록을 저장했습니다.');
    $('giftDate').focus();
  }

  function submitWill(e) {
    e.preventDefault();
    const form = $('willForm');
    clearErrors(form);
    const to = readRecipient('willTo', 'willOtherName', 'willError');
    if (!to) return;
    const what = $('willWhat').value.trim();
    if (!what) return setError('willError', '무엇을 남기고 싶은지 적어 주세요.', 'willWhat');
    const rec = Object.assign({ what: what.slice(0, 120), reason: $('willReason').value.trim().slice(0, 200) }, to);
    const target = editing.will ? findById(state.will.items, editing.will) : null;
    if (target) Object.assign(target, rec);
    else {
      if (state.will.items.length >= L.MAX_ITEMS) return setError('willError', '항목은 최대 ' + L.MAX_ITEMS + '건까지 입력할 수 있습니다.');
      state.will.items.push(Object.assign({ id: L.uid() }, rec));
    }
    resetWillForm();
    commit('유언 의사 항목을 저장했습니다.');
    $('willWhat').focus();
  }

  // ---------- 수정·삭제 ----------
  function startEdit(kind, id) {
    if (kind === 'family') {
      const f = findById(state.families, id);
      if (!f) return;
      editing.family = id;
      $('familyRelation').value = f.relation;
      $('familyName').value = f.name;
      setFormMode('family', true, 'familySubmit', 'familyCancel', '가족 추가');
      $('familyName').focus();
    } else if (kind === 'asset') {
      const a = findById(state.assets, id);
      if (!a) return;
      editing.asset = id;
      $('assetType').value = a.type;
      $('assetName').value = a.name;
      $('assetValue').value = String(a.value);
      $('assetAsOf').value = a.asOf;
      $('assetStatus').value = a.status;
      showAmountHint('assetValue', 'assetValueHint');
      setFormMode('asset', true, 'assetSubmit', 'assetCancel', '추가');
      $('assetName').focus();
    } else if (kind === 'gift') {
      const g = findById(state.gifts, id);
      if (!g) return;
      editing.gift = id;
      setRecipientControls('giftTo', 'giftOtherName', 'giftOtherWrap', g);
      $('giftDate').value = g.date;
      $('giftAmount').value = String(g.value);
      showAmountHint('giftAmount', 'giftAmountHint');
      setFormMode('gift', true, 'giftSubmit', 'giftCancel', '증여 기록 추가');
      $('giftTo').focus();
    } else if (kind === 'will') {
      const w = findById(state.will.items, id);
      if (!w) return;
      editing.will = id;
      setRecipientControls('willTo', 'willOtherName', 'willOtherWrap', w);
      $('willWhat').value = w.what;
      $('willReason').value = w.reason || '';
      setFormMode('will', true, 'willSubmit', 'willCancel', '추가');
      $('willTo').focus();
    }
    const form = $(kind + 'Form');
    if (form && form.scrollIntoView) form.scrollIntoView({ block: 'center' });
  }

  function cancelEdit(kind) {
    if (kind === 'family') resetFamilyForm();
    if (kind === 'asset') resetAssetForm();
    if (kind === 'gift') resetGiftForm();
    if (kind === 'will') resetWillForm();
  }

  const LIST_IDS = { family: 'familyList', asset: 'assetList', gift: 'giftList', will: 'willList' };

  function deleteItem(kind, id) {
    if (kind === 'family') {
      const f = findById(state.families, id);
      if (!f) return;
      const refs =
        state.gifts.filter(function (g) { return g.toType === 'family' && g.toId === id; }).length +
        state.will.items.filter(function (w) { return w.toType === 'family' && w.toId === id; }).length;
      if (refs > 0) {
        window.alert(
          '"' + f.name + '"에게 연결된 증여·유언 기록이 ' + refs + '건 있어 삭제할 수 없습니다.\n' +
          '먼저 해당 기록을 삭제하거나 받는 사람을 바꿔 주세요. (관계에 따라 합산 검토 기간이 달라지기 때문입니다)'
        );
        return;
      }
      if (!window.confirm('"' + f.name + '"을(를) 삭제할까요?')) return;
      state.families = state.families.filter(function (x) { return x.id !== id; });
      state.confirm.family = false;
    } else if (kind === 'asset') {
      const a = findById(state.assets, id);
      if (!a || !window.confirm('"' + a.name + '"을(를) 삭제할까요?')) return;
      state.assets = state.assets.filter(function (x) { return x.id !== id; });
    } else if (kind === 'gift') {
      const g = findById(state.gifts, id);
      if (!g || !window.confirm(g.date + ' 증여 기록을 삭제할까요?')) return;
      state.gifts = state.gifts.filter(function (x) { return x.id !== id; });
    } else if (kind === 'will') {
      const w = findById(state.will.items, id);
      if (!w || !window.confirm('"' + w.what + '" 항목을 삭제할까요?')) return;
      state.will.items = state.will.items.filter(function (x) { return x.id !== id; });
    } else return;
    if (editing[kind] === id) cancelEdit(kind);
    commit('삭제했습니다.');
    if (kind === 'family') {
      renderRecipientSelect('giftTo', 'giftOtherWrap');
      renderRecipientSelect('willTo', 'willOtherWrap');
    }
    const list = $(LIST_IDS[kind]);
    if (list) list.focus();
  }

  // ---------- 화면 그리기 ----------
  function renderBanner() {
    const parts = [];
    notices.forEach(function (n, i) {
      parts.push(
        '<div class="banner warn"><p>' + h(n) + '</p><button type="button" class="link" data-action="dismiss-notice" data-idx="' + i + '">닫기</button></div>'
      );
    });
    if (!storageOk) {
      parts.push(
        '<div class="banner warn"><p>이 브라우저에서는 저장이 막혀 있어 새로고침하면 입력한 내용이 사라질 수 있습니다. 중요한 내용은 "내 데이터"에서 내려받아 두세요.</p></div>'
      );
    }
    if (state.sample) {
      parts.push(
        '<div class="banner"><p><b>가상 샘플 데이터</b>가 들어 있습니다. 실제 정보가 아닙니다.</p>' +
          '<button type="button" class="secondary small" data-action="clear-sample">샘플 지우고 직접 입력하기</button></div>'
      );
    }
    $('banner').innerHTML = parts.join('');
  }

  function scoreBlock(r) {
    return (
      '<div class="score"><div class="num" aria-label="준비도 100점 만점에 ' + r.score + '점">' + r.score + '<small> / 100</small></div>' +
      '<div class="bar" role="progressbar" aria-label="정보 준비도" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + r.score + '"><i style="width:' + r.score + '%"></i></div></div>'
    );
  }

  function nextBlock(r) {
    if (!r.next) {
      return '<p>모든 점검 항목을 채웠습니다. 상담 리포트를 만들어 보세요.</p><div class="btn-row"><button type="button" class="primary" data-action="tab" data-tab="report">상담 리포트 보기</button></div>';
    }
    return (
      '<p><b>다음으로 하면 좋은 일</b><br>' + h(r.next.label) + ' — ' + h(r.next.detail) + '</p>' +
      '<div class="btn-row"><button type="button" class="primary" data-action="tab" data-tab="' + h(r.next.tab) + '">바로 가기</button></div>'
    );
  }

  function renderHome() {
    const r = L.readiness(state);
    let html = '<h2>내 준비 현황</h2>';
    if (!hasData()) html += '<p class="muted">아직 입력한 정보가 없습니다. 가족부터 입력해 보세요. 부담되면 위의 "가상 샘플로 둘러보기"를 먼저 눌러 보세요.</p>';
    html += scoreBlock(r);
    html += '<p class="muted">입력 정보가 얼마나 갖춰졌는지를 고정된 규칙으로 점검한 값입니다. 세금이나 법적 결과와는 무관합니다.</p>';
    html += nextBlock(r);
    $('homeReadiness').innerHTML = html;
  }

  function renderFamily() {
    $('familyCount').textContent = state.families.length + '명';
    $('familyList').innerHTML = state.families.length
      ? state.families
          .map(function (f) {
            return (
              '<li><div class="main"><b>' + h(f.name) + '</b><span class="badge info">' + h(f.relation) + '</span></div>' +
              '<div class="actions"><button type="button" class="secondary small" data-action="edit" data-kind="family" data-id="' + h(f.id) + '" aria-label="' + h(f.name) + ' 수정">수정</button>' +
              '<button type="button" class="danger small" data-action="delete" data-kind="family" data-id="' + h(f.id) + '" aria-label="' + h(f.name) + ' 삭제">삭제</button></div></li>'
            );
          })
          .join('')
      : emptyLi('아직 등록한 가족이 없습니다.');
    $('confirmFamily').checked = state.confirm.family;
    $('confirmFamily').disabled = state.families.length === 0;
  }

  function renderAssets() {
    const today = L.todayStr();
    const t = L.totals(state.assets);
    $('assetSummary').innerHTML =
      '<div><span>재산 합계 (채무 제외)</span><b>' + h(L.koreanAmount(t.assetTotal)) + '</b></div>' +
      '<div><span>채무 합계</span><b>' + h(L.koreanAmount(t.debtTotal)) + '</b></div>' +
      '<div><span>단순 차액</span><b>' + h(L.koreanAmount(t.net)) + '</b></div>';

    $('assetList').innerHTML = state.assets.length
      ? state.assets
          .map(function (a) {
            const stale = L.daysBetween(a.asOf, today) > L.STALE_DAYS;
            const sb = a.status === '직접 확인' ? 'ok' : 'warn';
            return (
              '<li><div class="main"><b>' + h(a.name) + '</b><span class="badge info">' + h(a.type) + '</span>' +
              (a.src === 'ai' ? '<span class="badge ai">AI 추출</span>' : '') +
              '<span class="badge ' + sb + '">' + h(a.status) + '</span>' +
              (stale ? '<span class="badge warn">기준일 1년 초과</span>' : '') +
              '<div class="sub">' + money(a.value) + ' · 기준일 ' + h(a.asOf) + '</div></div>' +
              '<div class="actions"><button type="button" class="secondary small" data-action="edit" data-kind="asset" data-id="' + h(a.id) + '" aria-label="' + h(a.name) + ' 수정">수정</button>' +
              '<button type="button" class="danger small" data-action="delete" data-kind="asset" data-id="' + h(a.id) + '" aria-label="' + h(a.name) + ' 삭제">삭제</button></div></li>'
            );
          })
          .join('')
      : emptyLi('아직 입력한 재산·채무가 없습니다.');

    $('confirmNoDebt').checked = state.confirm.noDebt;
    $('confirmNoDebt').disabled = state.assets.some(function (a) { return a.type === '채무'; });

    renderRecipientSelect('giftTo', 'giftOtherWrap');
    const rv = L.reviewGifts(state.gifts, state.families, state.assumeDate || today);
    $('giftList').innerHTML = state.gifts.length
      ? rv
          .map(function (g) {
            return (
              '<li><div class="main"><b>' + h(g.name) + '</b><span class="badge info">' + h(g.relation) + '</span>' +
              '<div class="sub">' + h(g.date) + ' · ' + money(g.value) + '</div></div>' +
              '<div class="actions"><button type="button" class="secondary small" data-action="edit" data-kind="gift" data-id="' + h(g.id) + '" aria-label="' + h(g.date + ' ' + g.name) + ' 증여 수정">수정</button>' +
              '<button type="button" class="danger small" data-action="delete" data-kind="gift" data-id="' + h(g.id) + '" aria-label="' + h(g.date + ' ' + g.name) + ' 증여 삭제">삭제</button></div></li>'
            );
          })
          .join('')
      : emptyLi('아직 기록한 증여가 없습니다.');
    $('confirmNoGift').checked = state.confirm.noGift;
    $('confirmNoGift').disabled = state.gifts.length > 0;
  }

  function renderCheck() {
    const r = L.readiness(state);
    $('checkSummary').innerHTML = scoreBlock(r) + nextBlock(r);

    $('checkItems').innerHTML = r.items
      .map(function (i) {
        return (
          '<li class="' + (i.done ? 'done' : 'todo') + '"><div class="main"><b>' + h(i.label) + '</b> ' +
          '<span class="badge ' + (i.done ? 'ok' : 'warn') + '">' + (i.done ? '완료' : '보완 필요') + ' ' + i.earned + '/' + i.max + '</span>' +
          '<div class="sub">' + h(i.detail) + '</div></div>' +
          (i.done ? '' : '<div class="actions"><button type="button" class="secondary small" data-action="tab" data-tab="' + h(i.tab) + '">입력하러 가기</button></div>') +
          '</li>'
        );
      })
      .join('');

    $('checkFlags').innerHTML = r.flags.length
      ? r.flags
          .map(function (f) {
            return (
              '<li class="' + (f.level === 'warn' ? 'todo' : 'info') + '"><div class="main"><span class="badge ' + (f.level === 'warn' ? 'warn' : 'info') + '">' +
              (f.level === 'warn' ? '확인 필요' : '참고') + '</span> ' + h(f.text) + '</div>' +
              '<div class="actions"><button type="button" class="secondary small" data-action="tab" data-tab="' + h(f.tab) + '">관련 화면</button></div></li>'
            );
          })
          .join('')
      : emptyLi('지금 입력한 정보에서는 따로 표시할 사항이 없습니다.');

    if ($('assumeDate').value !== r.assumeDate) $('assumeDate').value = r.assumeDate;

    if (!r.review.length) {
      $('giftReview').innerHTML = '<p class="muted">기록한 증여가 없어 분류할 내용이 없습니다.</p>';
    } else {
      $('giftReview').innerHTML =
        '<table><thead><tr><th scope="col">받은 사람</th><th scope="col">증여일</th><th scope="col">금액</th><th scope="col">검토 기간</th><th scope="col">분류</th></tr></thead><tbody>' +
        r.review
          .map(function (g) {
            return (
              '<tr><th scope="row">' + h(g.name) + ' (' + h(g.relation) + ')</th><td>' + h(g.date) + '</td><td>' + h(L.koreanAmount(g.value)) + '</td>' +
              '<td>' + g.years + '년 (' + (g.cutoff ? h(g.cutoff) + ' ~' : '-') + ')</td>' +
              '<td><span class="badge ' + REVIEW_BADGE[g.status] + '">' + REVIEW_LABEL[g.status] + '</span></td></tr>'
            );
          })
          .join('') +
        '</tbody></table>';
    }
  }

  function listCell(arr) {
    return '<ul class="plain">' + arr.map(function (x) { return '<li>' + h(x) + '</li>'; }).join('') + '</ul>';
  }

  function renderScenario() {
    const pick = $('scenarioPick');
    if (!pick.children.length) {
      pick.innerHTML = L.SCENARIOS.map(function (s) {
        return '<button type="button" class="secondary" data-action="scenario" data-id="' + s.id + '" aria-pressed="false">' + h(s.title) + '</button>';
      }).join('');
    }
    Array.prototype.forEach.call(pick.children, function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.id === state.scenario));
    });

    const rows = [
      ['요약', function (s) { return h(s.summary); }],
      ['관련 세금', function (s) { return h(s.taxes); }],
      ['필요한 정보', function (s) { return listCell(s.inputs); }],
      ['확인할 규칙', function (s) { return listCell(s.rules); }],
      ['불확실한 점', function (s) { return listCell(s.uncertainties); }],
      ['전문가에게 확인할 점', function (s) { return listCell(s.expert); }]
    ];
    $('scenarioCompare').innerHTML =
      '<table><thead><tr><th scope="col">구분</th>' +
      L.SCENARIOS.map(function (s) {
        return '<th scope="col">' + h(s.title) + (s.id === state.scenario ? ' <span class="badge info">선택</span>' : '') + '</th>';
      }).join('') +
      '</tr></thead><tbody>' +
      rows
        .map(function (row) {
          return '<tr><th scope="row">' + h(row[0]) + '</th>' + L.SCENARIOS.map(function (s) { return '<td>' + row[1](s) + '</td>'; }).join('') + '</tr>';
        })
        .join('') +
      '</tbody></table>';

    const r = L.readiness(state);
    const s = L.SCENARIOS.find(function (x) { return x.id === state.scenario; }) || L.SCENARIOS[0];
    const t = r.totals;
    let html = '<h3>"' + h(s.title) + '"을 선택했을 때, 내 입력 기준 확인표</h3>';
    if (!hasData()) {
      html += '<p class="muted">입력한 정보가 없어 일반 안내만 표시합니다.</p><div class="btn-row"><button type="button" class="primary" data-action="tab" data-tab="family">가족부터 입력하기</button></div>';
      $('scenarioMine').innerHTML = html;
      return;
    }
    const li = [];
    li.push('입력한 재산(채무 제외) 단순 합계 ' + L.koreanAmount(t.assetTotal) + ', 채무 ' + L.koreanAmount(t.debtTotal) + ', 단순 차액 ' + L.koreanAmount(t.net) + ' (평가액이 아닙니다)');
    if (s.id === 'A') {
      const inWin = r.review.filter(function (x) { return x.status === 'in'; });
      const sum = inWin.reduce(function (a, x) { return a + x.value; }, 0);
      li.push('증여를 받을 수 있는 등록 가족: ' + state.families.length + '명');
      li.push('가정 기준일 ' + r.assumeDate + ' 기준 합산 검토 대상 증여: ' + inWin.length + '건' + (inWin.length ? ' (합계 ' + L.koreanAmount(sum) + ')' : ''));
      if (!state.gifts.length) li.push('기록한 과거 증여가 없습니다. 기억나는 증여를 먼저 기록하면 검토가 정확해집니다.');
    } else if (s.id === 'B') {
      const byRel = L.RELATIONS
        .map(function (rel) { return [rel, state.families.filter(function (f) { return f.relation === rel; }).length]; })
        .filter(function (x) { return x[1] > 0; })
        .map(function (x) { return x[0] + ' ' + x[1] + '명'; });
      li.push('등록 가족: ' + (byRel.length ? byRel.join(', ') : '없음') + ' (법정 상속인의 범위와 순위는 전문가가 확인)');
      li.push('"추정"·"나중에 확인" 재산 ' + r.stats.unconfirmed.length + '건, 기준일 1년 초과 ' + r.stats.stale.length + '건');
    } else {
      const noItem = state.families.filter(function (f) {
        return !state.will.items.some(function (w) { return w.toType === 'family' && w.toId === f.id; });
      });
      li.push('정리한 유언 의사: ' + state.will.items.length + '건');
      li.push('아직 남기고 싶은 것을 정리하지 않은 가족: ' + (noItem.length ? noItem.map(function (f) { return f.name; }).join(', ') : '없음'));
    }
    html += '<ul class="plain">' + li.map(function (x) { return '<li>' + h(x) + '</li>'; }).join('') + '</ul>';
    html += '<p class="muted">이 표는 입력 정보를 정리한 것이며, 어느 시나리오가 더 유리한지에 대한 판단이 아닙니다.</p>';
    html += nextBlock(r);
    $('scenarioMine').innerHTML = html;
  }

  function renderWill() {
    renderRecipientSelect('willTo', 'willOtherWrap');
    $('willList').innerHTML = state.will.items.length
      ? state.will.items
          .map(function (w) {
            const info = L.recipientInfo(w, state.families);
            return (
              '<li><div class="main"><b>' + h(info.name) + '</b><span class="badge info">' + h(info.relation) + '</span>' +
              '<div>' + h(w.what) + '</div>' + (w.reason ? '<div class="sub">이유: ' + h(w.reason) + '</div>' : '') + '</div>' +
              '<div class="actions"><button type="button" class="secondary small" data-action="edit" data-kind="will" data-id="' + h(w.id) + '" aria-label="' + h(info.name + ' ' + w.what) + ' 수정">수정</button>' +
              '<button type="button" class="danger small" data-action="delete" data-kind="will" data-id="' + h(w.id) + '" aria-label="' + h(info.name + ' ' + w.what) + ' 삭제">삭제</button></div></li>'
            );
          })
          .join('')
      : emptyLi('아직 정리한 유언 의사가 없습니다.');

    const q = $('willQuestions');
    if (document.activeElement !== q) q.value = state.will.questions;

    const sel = $('willMethod');
    if (!sel.options.length) {
      sel.innerHTML = L.WILL_METHODS.map(function (m) { return '<option value="' + h(m) + '">' + h(m) + '</option>'; }).join('');
    }
    sel.value = state.will.method;
    const g = L.WILL_GUIDE[state.will.method];
    $('willGuide').innerHTML = g
      ? '<h4 style="margin:10px 0 4px">' + h(state.will.method) + ' (' + h(g.law) + ')</h4>' + listCell(g.points)
      : '';
  }

  function table(headers, rows) {
    return (
      '<div class="table-wrap"><table><thead><tr>' +
      headers.map(function (x) { return '<th scope="col">' + h(x) + '</th>'; }).join('') +
      '</tr></thead><tbody>' +
      rows.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + c + '</td>'; }).join('') + '</tr>'; }).join('') +
      '</tbody></table></div>'
    );
  }

  // 리포트에서 제외한 항목은 질문·확인 사항에도 드러나지 않도록 복사본에서 비운다.
  function reportView() {
    const inc = state.report.include;
    const copy = JSON.parse(JSON.stringify(state));
    if (!inc.assets) copy.assets = [];
    if (!inc.gifts) copy.gifts = [];
    if (!inc.will) copy.will = { method: state.will.method, items: [], questions: '' };
    return copy;
  }

  // 리포트 내용이 바뀌었는지 판단하는 지문 (발급·AI 브리핑의 유효성 확인용)
  function hashStr(str) {
    let x = 5381;
    for (let i = 0; i < str.length; i++) x = ((x << 5) + x + str.charCodeAt(i)) | 0;
    return (x >>> 0).toString(36);
  }
  function factsStamp() {
    return hashStr(JSON.stringify(aiFacts()));
  }
  function contentStamp() {
    return hashStr(JSON.stringify([state.families, state.assets, state.gifts, state.confirm, state.will, state.docs, state.assumeDate, state.report.include, state.ai.briefing]));
  }

  // AI에게 보낼 정보: 리포트에 포함하기로 한 항목만, 가명 그대로. 식별번호는 원래 받지 않는다.
  function aiFacts() {
    const today = L.todayStr();
    const inc = state.report.include;
    const view = reportView();
    const r = L.readiness(view, today);
    const f = { 기준일: today, 준비점수: r.score + '/100' };
    if (inc.family) f.가족 = state.families.map(function (x) { return { 관계: x.relation, 이름: x.name }; });
    if (inc.assets) {
      f.재산채무 = state.assets.map(function (a) { return { 분류: a.type, 항목: a.name, 금액: L.formatKRW(a.value), 기준일: a.asOf, 확인상태: a.status }; });
      f.합계 = { 재산: L.formatKRW(r.totals.assetTotal), 채무: L.formatKRW(r.totals.debtTotal) };
    }
    if (inc.gifts) {
      f.과거증여 = r.review.map(function (g) { return { 받은사람관계: g.relation, 증여일: g.date, 금액: L.formatKRW(g.value), 합산검토분류: REVIEW_LABEL[g.status] }; });
      f.가정기준일 = r.assumeDate;
    }
    if (inc.will) f.유언의사 = state.will.items.length + '건 정리, 관심 방식 ' + state.will.method;
    f.보완필요 = r.items.filter(function (i) { return !i.done; }).map(function (i) { return i.label + ': ' + i.detail; });
    f.확인필요 = r.flags.map(function (x) { return x.text; });
    return f;
  }

  function briefingHTML(b, forReport) {
    if (!b) return '';
    let out = '<p>' + h(b.summary) + '</p>';
    if (b.missing.length) out += '<p><b>상담 전에 더 챙기면 좋은 것</b></p><ul>' + b.missing.map(function (m) { return '<li>' + h(m) + '</li>'; }).join('') + '</ul>';
    if (b.questions.length) {
      out += '<p><b>전문가에게 물어볼 질문</b></p><ol>' + b.questions.map(function (q) {
        return '<li>' + h(q.q) + (q.why ? '<br><span class="sub">이유: ' + h(q.why) + '</span>' : '') + '</li>';
      }).join('') + '</ol>';
    }
    out += '<p class="' + (forReport ? 'meta' : 'muted') + '">AI 작성 초안 (' + h(b.model || 'Gemini') + ', ' + h(fmtTime(b.at)) + ') · 사실 여부는 전문가와 확인하세요.' +
      (b.removed ? ' 규칙 안전장치가 ' + b.removed + '개 문장을 걸렀습니다.' : '') + '</p>';
    return out;
  }

  function buildReportHTML(issue) {
    const today = L.todayStr();
    const inc = state.report.include;
    const view = reportView();
    const r = L.readiness(view, today);
    const excluded = [['family', '가족'], ['assets', '재산·채무'], ['gifts', '과거 증여'], ['will', '유언 의사']]
      .filter(function (x) { return !inc[x[0]]; })
      .map(function (x) { return x[1]; });
    let out = '<div class="doc-head"><h2>상담 준비 리포트</h2>' +
      (issue ? '<span class="issue-no">발급번호 ' + h(issue.no) + '</span>' : '<span class="issue-no preview-tag">미리보기 · 발급 전</span>') + '</div>';
    out += '<p class="meta">작성일 ' + h(today) + (issue ? ' · 발급 ' + h(fmtTime(issue.at)) : '') + ' · 이음(IEUM) 시연용 프로토타입으로 작성' + (state.sample ? ' · <b>가상 샘플 데이터 (실제 정보 아님)</b>' : '') + '</p>';
    out +=
      '<div class="disclaimer">이 문서는 법률·세무 자문이 아니라, 이용자가 직접 입력한 정보를 정리한 상담 준비 자료입니다. 점수와 합산 검토 분류는 고정된 규칙으로, "AI 상담 브리핑"은 생성형 AI로 작성했으며 AI 작성 부분은 따로 표시했습니다. 세액은 계산하지 않았고, 금액은 이용자가 입력한 값으로 세법상 평가액이 아닙니다.</div>';

    out += '<h3>1. 준비 현황</h3>';
    out += excluded.length
      ? '<p>일부 항목(' + h(excluded.join(', ')) + ')은 이용자가 제외하고 출력했습니다. 포함한 항목에 대한 정보 준비도는 ' + r.score + '점입니다(제외 항목이 있어 참고용).</p>'
      : '<p>정보 준비도 ' + r.score + ' / 100 (입력 완성도를 규칙으로 점검한 값이며 세금·법적 결과와 무관)</p>';

    let n = 2;
    if (inc.family) {
      out += '<h3>' + n++ + '. 가족</h3>';
      out += state.families.length
        ? table(['관계', '표시 이름'], state.families.map(function (f) { return [h(f.relation), h(f.name)]; })) +
          '<p>가족 구성을 이용자가 직접 확인함: ' + (state.confirm.family ? '예' : '아니오') + '</p>'
        : '<p>등록한 가족이 없습니다.</p>';
    }
    if (inc.assets) {
      const t = L.totals(state.assets);
      out += '<h3>' + n++ + '. 재산·채무 (이용자 입력값)</h3>';
      if (state.assets.length) {
        out += table(
          ['분류', '항목', '금액', '금액 기준일', '확인 상태'],
          state.assets.map(function (a) { return [h(a.type), h(a.name), h(L.formatKRW(a.value)), h(a.asOf), h(a.status)]; })
        );
        out += '<p>재산 단순 합계(채무 제외) ' + h(L.formatKRW(t.assetTotal)) + ' · 채무 합계 ' + h(L.formatKRW(t.debtTotal)) + ' · 단순 차액 ' + h(L.formatKRW(t.net)) + ' (평가액·과세표준이 아님)</p>';
      } else out += '<p>입력한 재산·채무가 없습니다.</p>';
      if (state.confirm.noDebt) out += '<p>채무 없음을 이용자가 확인함</p>';
    }
    if (inc.gifts) {
      out += '<h3>' + n++ + '. 과거 증여와 사전증여 합산 검토 분류</h3>';
      if (r.review.length) {
        out += '<p>가정 기준일 ' + h(r.assumeDate) + ' ("이 날 상속이 시작된다면"이라는 가정). 상속인 10년·상속인이 아닌 사람 5년 이내 증여를 검토 대상으로 분류했으며, 합산 확정이 아닙니다.</p>';
        out += table(
          ['받은 사람(관계)', '증여일', '금액', '분류'],
          r.review.map(function (g) { return [h(g.name + ' (' + g.relation + ')'), h(g.date), h(L.formatKRW(g.value)), h(REVIEW_LABEL[g.status])]; })
        );
      } else out += state.confirm.noGift ? '<p>과거 증여가 없음을 이용자가 확인함</p>' : '<p>기록한 증여가 없습니다.</p>';
    }
    if (inc.will) {
      out += '<h3>' + n++ + '. 유언 의사 초안 (법적 효력 없음)</h3>';
      const lines = L.willDraft(view);
      out += lines.length ? '<ol>' + lines.map(function (x) { return '<li>' + h(x) + '</li>'; }).join('') + '</ol>' : '<p>정리한 항목이 없습니다.</p>';
      if (state.will.questions) out += '<p><b>남은 질문</b><br><span style="white-space:pre-wrap">' + h(state.will.questions) + '</span></p>';
      const g = L.WILL_GUIDE[state.will.method];
      out += '<p>관심 있는 유언 방식: ' + h(state.will.method) + (g ? ' (' + h(g.law) + ')' : '') + '. 법정 방식을 지켜야 효력이 생기며 유효성 판단은 전문가의 몫입니다.</p>';
    }

    if (inc.ai && state.ai.briefing) {
      out += '<h3>' + n++ + '. AI 상담 브리핑 <span class="badge ai">AI 작성</span></h3>';
      out += briefingHTML(state.ai.briefing, true);
    }

    out += '<h3>' + n++ + '. 확인이 필요한 사항</h3>';
    out += r.flags.length ? '<ul>' + r.flags.map(function (f) { return '<li>' + h(f.text) + '</li>'; }).join('') + '</ul>' : '<p>표시할 사항이 없습니다.</p>';

    out += '<h3>' + n++ + '. 전문가에게 물어볼 질문</h3>';
    out += '<ol>' + L.buildQuestions(view, today).map(function (q) { return '<li>' + h(q) + '</li>'; }).join('') + '</ol>';

    out += '<h3>' + n++ + '. 상담 때 챙길 서류 (예시)</h3>';
    out += '<ul>' + L.DOCS.map(function (d) { return '<li>' + (state.docs[d.id] ? '☑' : '☐') + ' ' + h(d.label) + '</li>'; }).join('') + '</ul>';

    out += '<h3>' + n++ + '. 기한·제도 안내 (일반 정보)</h3>';
    out += table(
      ['구분', '내용', '근거'],
      [
        ['사전증여 합산 검토', '상속인은 사망 전 10년, 상속인이 아닌 사람은 5년 이내 증여를 검토', h(SOURCES.flow.name + ' ' + SOURCES.flow.url)],
        ['상속세 신고·납부', '일반적으로 상속 개시일이 속하는 달의 말일부터 6개월 (해외 거주 등 예외는 전문가 확인)', '상속세 및 증여세법 제67조'],
        ['상속포기·한정승인', '상속 개시를 안 날부터 3개월 이내', '민법 제1019조'],
        ['사망 후 재산 조회', '정부24 안심상속 원스톱서비스(무료). 신청은 사망일이 속한 달의 말일부터 1년 이내. 조회 항목(금융·토지·자동차·세금·연금 등)에 명시되지 않은 재산은 따로 확인이 필요할 수 있음', h(SOURCES.onestop.name + ' ' + SOURCES.onestop.url)]
      ]
    );
    out += '<p class="meta">법령 번호와 기한은 요약이며 최신 기준은 전문가가 확인해야 합니다. 이 리포트는 법률·세무 자문이 아닙니다.</p>';
    return out;
  }

  function renderReport() {
    document.querySelectorAll('[data-include]').forEach(function (c) { c.checked = !!state.report.include[c.dataset.include]; });
    const S = window.IEUM_STORE;
    const issue = S ? S.activeIssue(contentStamp()) : null;
    const doc = $('reportDoc');
    doc.innerHTML = buildReportHTML(issue);
    doc.classList.toggle('preview', !issue);
    renderIssueBox(issue);
    renderBriefing();
  }

  function renderIssueBox(issue) {
    const S = window.IEUM_STORE;
    const box = $('issueBox');
    if (!S) {
      box.innerHTML = '';
      return;
    }
    if (issue) {
      box.innerHTML =
        '<div class="issue-row"><div><span class="badge ok">발급 완료</span> <b>' + h(issue.no) + '</b><div class="sub">' + h(fmtTime(issue.at)) +
        (issue.unlimited ? ' · 연간 플랜으로 발급' : '') + ' · 내용을 바꾸면 다시 발급해야 합니다.</div></div>' +
        '<button type="button" class="primary" data-action="print">인쇄하거나 PDF로 저장</button></div>';
      return;
    }
    const can = S.canIssue();
    box.innerHTML =
      '<div class="issue-row"><div><b>발급 전 미리보기입니다.</b><div class="sub">발급하면 "미리보기" 표시가 사라지고 발급번호가 붙습니다. ' +
      h(S.issueHint()) + '</div></div>' +
      (can
        ? '<button type="button" class="primary" data-action="issue">리포트 발급하기</button>'
        : '<button type="button" class="primary" data-action="tab" data-tab="store">발급권 구매하기</button>') +
      '</div>';
  }

  function renderBriefing() {
    const b = state.ai.briefing;
    const view = $('aiBriefView');
    if (!view) return;
    $('aiBriefDel').hidden = !b;
    if (!b) {
      view.innerHTML = '';
      return;
    }
    const stale = b.stamp && b.stamp !== factsStamp();
    view.innerHTML = '<div class="brief">' + (stale ? '<p class="notice">브리핑을 만든 뒤 입력 내용이 바뀌었습니다. 다시 만드는 것을 권합니다.</p>' : '') + briefingHTML(b, false) + '</div>';
  }

  function issueReport() {
    const S = window.IEUM_STORE;
    if (!S) return;
    const r = S.issue(contentStamp());
    if (!r.ok) {
      window.alert(r.error);
      return;
    }
    renderReport();
    announce('리포트를 발급했습니다. 발급번호 ' + r.issue.no);
    printReport();
  }

  function renderDocs() {
    $('docList').innerHTML = L.DOCS.map(function (d) {
      return (
        '<li><label class="check"><input type="checkbox" data-doc="' + h(d.id) + '"' + (state.docs[d.id] ? ' checked' : '') + '> ' + h(d.label) + '</label></li>'
      );
    }).join('');
  }

  function fmtTime(iso) {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '-' : d.toLocaleString('ko-KR');
  }

  function renderData() {
    const li = [];
    li.push('저장 상태: ' + (storageOk ? '이 기기 브라우저에 자동 저장' : '저장 불가 (내용이 새로고침하면 사라질 수 있음)'));
    li.push('입력 현황: 가족 ' + state.families.length + '명 · 재산·채무 ' + state.assets.length + '건 · 증여 ' + state.gifts.length + '건 · 유언 의사 ' + state.will.items.length + '건');
    li.push('마지막 수정: ' + (hasData() ? fmtTime(state.meta.updatedAt) : '아직 저장한 내용 없음'));
    if (state.sample) li.push('현재 가상 샘플 데이터가 들어 있습니다.');
    $('dataStatus').innerHTML = '<ul class="plain">' + li.map(function (x) { return '<li>' + h(x) + '</li>'; }).join('') + '</ul>';
    document.querySelectorAll('input[name="price"]').forEach(function (r) { r.checked = r.value === state.pilot.price; });
  }

  function renderAll() {
    renderBanner();
    renderHome();
    renderFamily();
    renderAssets();
    renderCheck();
    renderScenario();
    renderWill();
    renderDocs();
    renderReport();
    renderData();
    renderHooks.forEach(function (fn) { fn(); });
  }

  // 체크박스 포커스를 유지하기 위해 서류 목록은 다시 그리지 않는다.
  function renderAfterDocChange() {
    renderHome();
    renderCheck();
    renderScenario();
    renderReport();
  }

  // ---------- 데이터 내보내기·가져오기·삭제 ----------
  function exportData() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ieum-data-' + L.todayStr() + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    announce('데이터 파일을 내려받았습니다. 파일에는 입력한 정보가 그대로 들어 있으니 보관에 주의하세요.');
  }

  function importData(file) {
    const err = $('dataError');
    err.textContent = '';
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      err.textContent = '파일이 너무 큽니다. (최대 2MB)';
      return;
    }
    const fr = new FileReader();
    fr.onerror = function () { err.textContent = '파일을 읽지 못했습니다.'; };
    fr.onload = function () {
      let data;
      try { data = JSON.parse(String(fr.result)); } catch (e) {
        err.textContent = '이음에서 내려받은 JSON 파일이 아닙니다.';
        return;
      }
      if (!data || typeof data !== 'object' || typeof data.version !== 'number') {
        err.textContent = '이음에서 내려받은 파일이 아닙니다. (버전 정보가 없습니다)';
        return;
      }
      if (data.version > L.SCHEMA_VERSION) {
        err.textContent = '더 새로운 버전에서 만든 파일이라 불러올 수 없습니다.';
        return;
      }
      const res = L.normalizeState(data);
      if (!res.valid) {
        err.textContent = '파일 내용을 읽지 못했습니다.';
        return;
      }
      if (hasData() && !window.confirm('현재 입력한 내용이 불러온 파일의 내용으로 대체됩니다. 계속할까요?')) return;
      state = res.state;
      resetForms();
      notices = res.dropped > 0 ? ['불러온 파일에서 형식이 맞지 않는 항목 ' + res.dropped + '건을 제외했습니다.'] : [];
      commit('파일에서 데이터를 불러왔습니다.');
    };
    fr.readAsText(file);
  }

  function wipe() {
    state = L.emptyState();
    notices = [];
    storageRemove(KEY);
    storageRemove(KEY + '.corrupt');
    resetForms();
    renderAll();
  }

  function resetAll() {
    if (!window.confirm('이 기기에 저장된 모든 입력 내용을 삭제합니다. 되돌릴 수 없습니다. 삭제할까요?')) return;
    wipe();
    announce('모든 데이터를 삭제했습니다.');
  }

  function loadSample() {
    if (hasData() && !state.sample && !window.confirm('현재 입력한 내용이 가상 샘플로 대체됩니다. 필요하면 먼저 "내 데이터"에서 내려받아 두세요. 계속할까요?')) return;
    state = L.sampleState();
    notices = [];
    resetForms();
    commit('가상 샘플 데이터를 불러왔습니다.');
    navigate('check');
  }

  function printReport() {
    const old = document.title;
    document.title = '이음 상담 준비 리포트 ' + L.todayStr();
    window.addEventListener('afterprint', function restore() {
      document.title = old;
      window.removeEventListener('afterprint', restore);
    });
    window.print();
  }

  // ---------- 이벤트 ----------
  function onClick(e) {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    if (el.tagName === 'A') e.preventDefault();
    const act = el.dataset.action;
    if (act === 'tab') navigate(el.dataset.tab);
    else if (act === 'size') {
      prefs.size = el.dataset.size;
      applyPrefs();
      savePrefs();
    } else if (act === 'contrast') {
      prefs.contrast = prefs.contrast === 'high' ? 'normal' : 'high';
      applyPrefs();
      savePrefs();
    } else if (act === 'edit') startEdit(el.dataset.kind, el.dataset.id);
    else if (act === 'delete') deleteItem(el.dataset.kind, el.dataset.id);
    else if (act === 'cancel-edit') cancelEdit(el.dataset.kind);
    else if (act === 'scenario') {
      state.scenario = el.dataset.id;
      save();
      renderScenario();
    } else if (act === 'load-sample') loadSample();
    else if (act === 'clear-sample') {
      wipe();
      announce('샘플 데이터를 지웠습니다.');
      navigate('family');
    } else if (act === 'dismiss-notice') {
      notices.splice(Number(el.dataset.idx), 1);
      renderBanner();
    } else if (act === 'export') exportData();
    else if (act === 'import') $('importFile').click();
    else if (act === 'reset-all') resetAll();
    else if (act === 'print') printReport();
    else if (act === 'issue') issueReport();
  }

  function onChange(e) {
    const t = e.target;
    if (t.id === 'confirmFamily') {
      state.confirm.family = t.checked && state.families.length > 0;
      commit();
    } else if (t.id === 'confirmNoDebt') {
      state.confirm.noDebt = t.checked;
      commit();
    } else if (t.id === 'confirmNoGift') {
      state.confirm.noGift = t.checked;
      commit();
    } else if (t.id === 'assumeDate') {
      if (t.value === '') state.assumeDate = '';
      else if (L.parseDate(t.value)) state.assumeDate = t.value;
      else return;
      commit();
    } else if (t.id === 'giftTo' || t.id === 'willTo') {
      t.dataset.touched = '1';
      $(t.id === 'giftTo' ? 'giftOtherWrap' : 'willOtherWrap').hidden = t.value !== 'other';
    }
    else if (t.id === 'willMethod') {
      if (L.WILL_METHODS.indexOf(t.value) >= 0) state.will.method = t.value;
      save();
      renderWill();
      renderReport();
    } else if (t.dataset && t.dataset.include) {
      state.report.include[t.dataset.include] = t.checked;
      save();
      renderReport();
    } else if (t.dataset && t.dataset.doc) {
      if (t.checked) state.docs[t.dataset.doc] = true;
      else delete state.docs[t.dataset.doc];
      save();
      renderAfterDocChange();
    } else if (t.name === 'price') {
      if (L.PRICE_CHOICES.indexOf(t.value) >= 0) state.pilot.price = t.value;
      save();
      renderData();
    } else if (t.id === 'importFile') {
      importData(t.files && t.files[0]);
      t.value = '';
    }
  }

  function onInput(e) {
    const t = e.target;
    if (t.id === 'assetValue') showAmountHint('assetValue', 'assetValueHint');
    else if (t.id === 'giftAmount') showAmountHint('giftAmount', 'giftAmountHint');
    else if (t.id === 'willQuestions') {
      state.will.questions = t.value.slice(0, 1000);
      save();
      renderReport();
    }
    if (t.hasAttribute && t.hasAttribute('aria-invalid')) t.removeAttribute('aria-invalid');
  }

  function onStorage(e) {
    if (e.key !== KEY) return;
    const raw = e.newValue;
    if (!raw) state = L.emptyState();
    else {
      try {
        const res = L.normalizeState(JSON.parse(raw));
        if (res.valid) state = res.state;
      } catch (err) { return; }
    }
    resetForms();
    renderAll();
  }

  function onPop() {
    const id = location.hash.slice(1);
    if (TAB_IDS.indexOf(id) >= 0) showTab(id, true);
    else if (!id) showTab('home', true);
  }

  function init() {
    if (!L) {
      document.body.innerHTML = '<p style="padding:20px">앱을 불러오지 못했습니다. 파일이 모두 같은 폴더에 있는지 확인하세요.</p>';
      return;
    }
    const live = document.createElement('div');
    live.id = 'live';
    live.className = 'sr';
    live.setAttribute('aria-live', 'polite');
    document.body.appendChild(live);

    loadPrefs();
    loadState();
    applyPrefs();

    ['familyList', 'assetList', 'giftList', 'willList'].forEach(function (id) { $(id).setAttribute('tabindex', '-1'); });
    $('assetAsOf').setAttribute('max', L.todayStr());
    $('giftDate').setAttribute('max', L.todayStr());
    $('assetAsOf').value = L.todayStr();

    document.addEventListener('click', onClick);
    document.addEventListener('change', onChange);
    document.addEventListener('input', onInput);
    window.addEventListener('storage', onStorage);
    window.addEventListener('popstate', onPop);
    $('familyForm').addEventListener('submit', submitFamily);
    $('assetForm').addEventListener('submit', submitAsset);
    $('giftForm').addEventListener('submit', submitGift);
    $('willForm').addEventListener('submit', submitWill);

    renderAll();
    const first = location.hash.slice(1);
    showTab(TAB_IDS.indexOf(first) >= 0 ? first : 'home', false);
  }

  // 다른 화면 모듈(shop-ui.js, ai-ui.js)이 쓰는 내부 기능
  window.IEUM_APP = {
    state: function () { return state; },
    save: save,
    commit: commit,
    renderAll: renderAll,
    renderReport: renderReport,
    navigate: navigate,
    announce: announce,
    hasData: hasData,
    aiFacts: aiFacts,
    factsStamp: factsStamp,
    contentStamp: contentStamp,
    fmtTime: fmtTime,
    onRender: function (fn) { renderHooks.push(fn); },
    addAssets: function (items) {
      items.forEach(function (it) { state.assets.push(Object.assign({ id: L.uid() }, it)); });
      if (items.some(function (it) { return it.type === '채무'; })) state.confirm.noDebt = false;
      commit(items.length + '건을 재산 목록에 저장했습니다.');
    },
    setBriefing: function (b) {
      state.ai.briefing = b;
      commit(b ? 'AI 상담 브리핑을 만들었습니다.' : 'AI 상담 브리핑을 지웠습니다.');
    }
  };

  init();
})();
