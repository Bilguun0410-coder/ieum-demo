/* =========================================================
   이음 IEUM - 앱 로직
   데이터는 현재 브라우저 메모리에만 있고, 새로고침하면 사라집니다.
   ========================================================= */

// ---------- 데이터 ----------
const cases = [{ name: '홍OO 가족 상속 준비 (예시)', status: '자료 수집 중' }];
const docs = ['가족관계 확인 서류', '사망 사실 확인 서류', '재산 관련 자료', '채무 관련 자료'];
const checked = new Set();

const families = [];
const assets = [];
const gifts = [];

// ---------- 공통 유틸 ----------
function element(id) {
  return document.getElementById(id);
}

function escapeHTML(s) {
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

function safe(s) {
  return escapeHTML(String(s));
}

const amount = n => Math.round(Number(n) || 0).toLocaleString('ko-KR') + '원';

function emptyMsg(arr) {
  return arr.length === 0 ? '등록된 항목이 없습니다.' : '';
}

// ---------- 탭 전환 ----------
function tab(name) {
  document.querySelectorAll('.panel').forEach(x => x.classList.toggle('active', x.id === name));
  document.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('active', x.dataset.tab === name));
}

// ---------- 사건·서류 화면 ----------
function render() {
  renderExtra();

  element('count').textContent = cases.length;
  element('done').textContent = `${checked.size}/${docs.length}`;

  const html = cases.map((c, i) =>
    `<div class="item"><span><strong>${escapeHTML(c.name)}</strong><br>` +
    `<span class="muted">${escapeHTML(c.status)}</span></span>` +
    `<span class="pill">사건 ${i + 1}</span></div>`
  ).join('');
  element('caseList').innerHTML = html;
  element('recent').innerHTML = html;

  element('docList').innerHTML = docs.map((d, i) =>
    `<div class="item"><label><input type="checkbox" style="width:auto;margin-right:9px" data-doc="${i}" ${checked.has(i) ? 'checked' : ''}>${d}</label>` +
    `<span class="pill">${checked.has(i) ? '확인 완료' : '미확인'}</span></div>`
  ).join('');

  document.querySelectorAll('[data-doc]').forEach(x => x.addEventListener('change', e => {
    const i = Number(e.target.dataset.doc);
    e.target.checked ? checked.add(i) : checked.delete(i);
    render();
  }));
}

// ---------- 가족·재산·증여·리포트 화면 ----------
function renderExtra() {
  // 가족
  element('familyCount').textContent = families.length + '명';
  element('familyList').innerHTML = emptyMsg(families) || families.map((f, i) =>
    '<div class="item"><span>' + safe(f.relation) + ' · ' + safe(f.name) + '</span>' +
    '<button class="btn-quiet" type="button" onclick="removeItem(\'families\',' + i + ')">삭제</button></div>'
  ).join('');

  // 재산·채무 합계
  let total = 0;
  let debt = 0;
  for (const a of assets) {
    if (a.type === '채무') debt += a.value;
    else total += a.value;
  }
  element('assetTotal').textContent = amount(total);
  element('debtTotal').textContent = amount(debt);
  element('netTotal').textContent = amount(total - debt);

  element('assetList').innerHTML = emptyMsg(assets) || assets.map((a, i) =>
    '<div class="item"><span><b>' + safe(a.type) + '</b> · ' + safe(a.name) + '</span>' +
    '<span>' + amount(a.value) + ' <button class="btn-quiet" type="button" onclick="removeItem(\'assets\',' + i + ')">삭제</button></span></div>'
  ).join('');

  // 증여
  element('giftList').innerHTML = emptyMsg(gifts) || gifts.map((g, i) =>
    '<div class="item"><span>' + safe(g.date) + ' · ' + safe(g.to) + '</span>' +
    '<span>' + amount(g.value) + ' <button class="btn-quiet" type="button" onclick="removeItem(\'gifts\',' + i + ')">삭제</button></span></div>'
  ).join('');

  // 리포트
  const complete = [
    families.length > 0,
    assets.some(a => a.type !== '채무'),
    assets.some(a => a.type === '채무'),
    gifts.length > 0,
    checked.size === docs.length
  ];

  element('reportFamily').innerHTML = '<p><b>등록 가족:</b> ' +
    (families.length ? families.map(f => safe(f.relation) + ' ' + safe(f.name)).join(', ') : '미입력') + '</p>';

  element('reportAssets').innerHTML =
    '<p><b>입력 자산:</b> ' + amount(total) + ' / <b>입력 채무:</b> ' + amount(debt) +
    ' / <b>단순 차액:</b> ' + amount(total - debt) + '</p>' +
    '<p><b>과거 증여 기록:</b> ' + gifts.length + '건</p>';

  const checks = ['가족관계', '재산 목록', '채무 현황', '과거 증여 기록', '예시 서류 체크리스트'];
  element('reportChecklist').innerHTML =
    '<p>예시 준비도 ' + complete.filter(Boolean).length + '/5개 항목 확인 (입력 건수만 반영)</p>' +
    checks.map((v, i) =>
      '<div class="item"><span>' + (complete[i] ? '✓' : '○') + ' ' + v + '</span>' +
      '<span class="pill">' + (complete[i] ? '입력/확인' : '확인 필요') + '</span></div>'
    ).join('');
}

// ---------- 삭제 / 초기화 ----------
function removeItem(type, i) {
  const map = { families, assets, gifts };
  if (!map[type]) return;
  map[type].splice(i, 1);
  renderExtra();
}

function resetDemo() {
  if (!confirm('입력한 가족·재산·증여 기록을 모두 지우시겠습니까?')) return;
  families.length = 0;
  assets.length = 0;
  gifts.length = 0;
  renderExtra();
}

// ---------- 폼 이벤트 ----------
element('caseForm').addEventListener('submit', e => {
  e.preventDefault();
  cases.push({
    name: element('caseName').value.trim(),
    status: element('caseStatus').value
  });
  e.target.reset();
  render();
  tab('cases');
});

element('familyForm').addEventListener('submit', e => {
  e.preventDefault();
  const name = element('familyName').value.trim();
  if (!name) return;
  families.push({ name, relation: element('familyRelation').value });
  e.target.reset();
  renderExtra();
});

element('assetForm').addEventListener('submit', e => {
  e.preventDefault();
  const name = element('assetName').value.trim();
  const value = Number(element('assetValue').value);
  if (!name || !Number.isSafeInteger(value) || value < 0) return alert('금액을 올바르게 입력하세요.');
  assets.push({ name, type: element('assetType').value, value });
  e.target.reset();
  renderExtra();
});

element('giftForm').addEventListener('submit', e => {
  e.preventDefault();
  const to = element('giftTo').value.trim();
  const date = element('giftDate').value;
  const value = Number(element('giftAmount').value);
  if (!to || !date || !Number.isSafeInteger(value) || value < 0) return alert('증여 정보를 확인하세요.');
  gifts.push({ to, date, value });
  e.target.reset();
  renderExtra();
});

// ---------- 시작 ----------
render();
