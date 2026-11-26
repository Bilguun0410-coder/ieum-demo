/* 브라우저 통합 점검 (선택 실행)
   - 준비: Node 18+, npm install --no-save playwright && npx playwright install chromium
   - 실행: node tests/smoke.js   (설치된 Chrome을 쓰려면 환경변수 CHROME_PATH에 경로 지정)
   index.html을 file:// 로 열어 핵심 흐름을 자동으로 확인합니다. */
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  console.error('playwright가 필요합니다. 먼저 실행: npm install --no-save playwright && npx playwright install chromium');
  process.exit(1);
}

const URL = 'file://' + path.resolve(__dirname, '..', 'index.html');
let passed = 0;
async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log('ok   - ' + name);
  } catch (e) {
    console.log('FAIL - ' + name + '\n       ' + String(e.message).split('\n').join('\n       '));
    process.exitCode = 1;
  }
}

(async () => {
  const opts = { args: ['--no-sandbox'] };
  if (process.env.CHROME_PATH) opts.executablePath = process.env.CHROME_PATH;
  const browser = await chromium.launch(opts);
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const url = (m.location() && m.location().url) || '';
    if (/jsdelivr/.test(url) || /Failed to load resource/.test(m.text())) return; // 오프라인 테스트 환경의 웹폰트 로드 실패는 무시
    errors.push('console: ' + m.text());
  });
  // 실제 Gemini 대신 가짜 응답 (요청 형식 확인용)
  const aiCalls = [];
  let aiMode = 'ok';
  await page.route('https://generativelanguage.googleapis.com/**', async (route) => {
    const req = route.request();
    const body = JSON.parse(req.postData() || '{}');
    aiCalls.push({ url: req.url(), key: req.headers()['x-goog-api-key'], body });
    if (aiMode === 'quota') return route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Resource exhausted' } }) });
    const text = JSON.stringify(body);
    let out;
    if (/inlineData/.test(text)) {
      out = JSON.stringify({ docType: '예금 잔액 증명서', items: [
        { type: '예금', name: '정기예금 110-234-567890', value: 50000000, asOf: '2026-11-20', evidence: '잔액 50,000,000원', confidence: 'high' },
        { type: '예금', name: '보통예금', value: 3215400, asOf: '', evidence: '잔액 3,215,400원', confidence: 'medium' }
      ] });
    } else if (/상담 준비 브리핑/.test(text)) {
      out = JSON.stringify({ summary: '가족과 재산 정보가 정리되어 있습니다. 상속세는 약 2억원이 예상됩니다.', missing: ['주식 잔고 확인 자료'], questions: [{ q: '합산 검토 대상 증여는 어떻게 확인하나요?', why: '최근 증여 기록이 있습니다.' }] });
    } else if (/연결 확인/.test(text)) {
      out = '연결됨';
    } else {
      out = '유류분은 상속인에게 법이 보장하는 최소한의 몫입니다. 지금 증여하시는 게 더 좋습니다. 자세한 내용은 전문가와 확인하세요.';
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ candidates: [{ content: { parts: [{ text: out }] }, finishReason: 'STOP' }] }) });
  });
  let dialogMsg = '';
  let dialogAccept = true;
  page.on('dialog', async (d) => {
    dialogMsg = d.message();
    if (dialogAccept) await d.accept(); else await d.dismiss();
  });

  const tab = (id) => page.click('.tabs [data-tab="' + id + '"]');
  const stateOf = () => page.evaluate(() => JSON.parse(localStorage.getItem('ieum.v1.state') || 'null'));

  await page.goto(URL);

  await step('첫 화면이 열리고 오류가 없다', async () => {
    assert.equal(await page.locator('#home').isVisible(), true);
    assert.equal(await page.locator('#family').isVisible(), false);
    assert.match(await page.textContent('#homeReadiness'), /0\s*\/ 100/);
    assert.deepEqual(errors, []);
  });

  await step('샘플 불러오기 → 준비 점검 화면, 점수 77', async () => {
    await page.click('.hero [data-action="load-sample"]');
    assert.equal(await page.locator('#check').isVisible(), true);
    assert.match(await page.textContent('#checkSummary'), /77\s*\/ 100/);
    const rows = await page.locator('#giftReview tbody tr').allTextContents();
    assert.equal(rows.length, 3);
    assert.match(rows[0], /합산 검토 대상/);
    assert.match(rows[1], /검토 기간 밖/);
    assert.match(rows[2], /가족 외/);
    assert.match(rows[2], /합산 검토 대상/);
    assert.equal(await page.locator('#banner .banner').count(), 1);
  });

  await step('새로고침해도 입력이 유지된다', async () => {
    await page.reload();
    await tab('assets');
    assert.equal(await page.locator('#assetList li').count(), 4);
    assert.equal((await stateOf()).sample, true);
  });

  await step('가정 기준일을 바꾸면 분류가 달라진다', async () => {
    await tab('check');
    await page.fill('#assumeDate', '2040-01-01');
    await page.dispatchEvent('#assumeDate', 'change');
    const rows = await page.locator('#giftReview tbody tr').allTextContents();
    assert.match(rows[0], /검토 기간 밖/);
  });

  await step('샘플을 지우고 빈 상태에서 시작', async () => {
    await page.click('#banner [data-action="clear-sample"]');
    assert.equal(await page.locator('#family').isVisible(), true);
    assert.equal(await page.locator('#familyList li.empty').count(), 1);
    assert.equal(await stateOf(), null);
  });

  await step('가족: 빈 이름은 오류, 정상 입력은 저장, 본인 확인', async () => {
    await page.click('#familySubmit');
    assert.match(await page.textContent('#familyError'), /이름/);
    await page.selectOption('#familyRelation', '자녀');
    await page.fill('#familyName', '첫째');
    await page.click('#familySubmit');
    assert.equal(await page.locator('#familyList li:not(.empty)').count(), 1);
    await page.check('#confirmFamily');
    assert.equal((await stateOf()).confirm.family, true);
    // 가족을 더 추가하면 확인이 풀린다
    await page.fill('#familyName', '배우자 호칭');
    await page.selectOption('#familyRelation', '배우자');
    await page.click('#familySubmit');
    assert.equal((await stateOf()).confirm.family, false);
    assert.equal(await page.isChecked('#confirmFamily'), false);
  });

  await step('스크립트 삽입 시도는 글자로만 표시된다', async () => {
    await page.fill('#familyName', '<img src=x onerror="window.__x=1">');
    await page.click('#familySubmit');
    assert.equal(await page.evaluate(() => window.__x), undefined);
    assert.equal(await page.locator('#familyList img').count(), 0);
    assert.match(await page.textContent('#familyList'), /<img src=x/);
    // 정리
    page.once('dialog', () => {});
    await page.locator('#familyList li', { hasText: '<img' }).locator('[data-action="delete"]').click();
    assert.equal(await page.locator('#familyList li:not(.empty)').count(), 2);
  });

  await step('재산: 소수·음수·미래 기준일은 거부, 정상 입력은 저장', async () => {
    await tab('assets');
    await page.fill('#assetName', '테스트 예금');
    await page.fill('#assetValue', '1000.5');
    await page.click('#assetSubmit');
    assert.match(await page.textContent('#assetError'), /정수/);
    await page.fill('#assetValue', '-5');
    await page.click('#assetSubmit');
    assert.match(await page.textContent('#assetError'), /0원 이상/);
    await page.fill('#assetValue', '99999999999999');
    await page.click('#assetSubmit');
    assert.match(await page.textContent('#assetError'), /너무 큽니다/);
    await page.fill('#assetValue', '50000000');
    assert.match(await page.textContent('#assetValueHint'), /5,000만원/);
    await page.fill('#assetAsOf', '2999-01-01');
    await page.click('#assetSubmit');
    assert.match(await page.textContent('#assetError'), /오늘 이전/);
    await page.fill('#assetAsOf', '2026-01-15');
    await page.click('#assetSubmit');
    assert.equal(await page.locator('#assetList li:not(.empty)').count(), 1);
    assert.match(await page.textContent('#assetSummary'), /5,000만원/);
  });

  await step('재산 수정 후 저장', async () => {
    await page.click('#assetList [data-action="edit"]');
    assert.equal(await page.inputValue('#assetName'), '테스트 예금');
    assert.equal(await page.locator('#assetCancel').isVisible(), true);
    await page.fill('#assetValue', '70000000');
    await page.selectOption('#assetStatus', '추정');
    await page.click('#assetSubmit');
    const s = await stateOf();
    assert.equal(s.assets.length, 1);
    assert.equal(s.assets[0].value, 70000000);
    assert.equal(s.assets[0].status, '추정');
  });

  await step('증여: 가족 외 수신자는 이름 필수, 미래 날짜 거부', async () => {
    await page.selectOption('#giftTo', 'other');
    assert.equal(await page.locator('#giftOtherWrap').isVisible(), true);
    await page.fill('#giftDate', '2025-05-01');
    await page.fill('#giftAmount', '3000000');
    await page.click('#giftSubmit');
    assert.match(await page.textContent('#giftError'), /이름/);
    await page.fill('#giftOtherName', '지인(가명)');
    await page.fill('#giftDate', '2999-01-01');
    await page.click('#giftSubmit');
    assert.match(await page.textContent('#giftError'), /오늘 이전/);
    await page.fill('#giftDate', '2025-05-01');
    await page.click('#giftSubmit');
    assert.equal(await page.locator('#giftList li:not(.empty)').count(), 1);
  });

  await step('연결된 기록이 있는 가족은 삭제할 수 없다', async () => {
    await page.selectOption('#giftTo', { index: 0 });
    await page.fill('#giftDate', '2024-05-01');
    await page.fill('#giftAmount', '1000000');
    await page.click('#giftSubmit');
    await tab('family');
    dialogMsg = '';
    await page.locator('#familyList li', { hasText: '첫째' }).locator('[data-action="delete"]').click();
    assert.match(dialogMsg, /삭제할 수 없습니다/);
    assert.equal(await page.locator('#familyList li:not(.empty)').count(), 2);
  });

  await step('시나리오 선택이 저장되고 표에 세액 숫자가 없다', async () => {
    await tab('scenario');
    await page.click('#scenarioPick [data-id="C"]');
    assert.equal((await stateOf()).scenario, 'C');
    assert.equal(await page.getAttribute('#scenarioPick [data-id="C"]', 'aria-pressed'), 'true');
    const txt = await page.textContent('#scenarioCompare');
    assert.doesNotMatch(txt, /세액은\s*\d|\d+\s*원\s*(납부|환급)/);
  });

  await step('받는 사람 기본값은 첫 번째 가족이다 (가족 외가 아님)', async () => {
    await tab('will');
    assert.match(await page.inputValue('#willTo'), /^f:/);
    assert.equal(await page.locator('#willOtherWrap').isVisible(), false);
  });

  await step('유언 의사: 추가와 방식 안내, 법적 효력 없음 고지', async () => {
    await tab('will');
    assert.match(await page.textContent('#will'), /법적 효력이 있는 유언장이 아닙니다/);
    await page.fill('#willWhat', '예금 일부');
    await page.click('#willSubmit');
    assert.equal(await page.locator('#willList li:not(.empty)').count(), 1);
    await page.selectOption('#willMethod', '공정증서');
    assert.match(await page.textContent('#willGuide'), /공증인/);
    await page.fill('#willQuestions', '유류분이 걱정됩니다');
    assert.equal((await stateOf()).will.questions, '유류분이 걱정됩니다');
  });

  await step('리포트: 제외한 항목은 질문·본문 어디에도 나타나지 않는다', async () => {
    await tab('report');
    const full = await page.textContent('#reportDoc');
    assert.match(full, /테스트 예금/);
    assert.match(full, /법률·세무 자문이 아니라/);
    assert.match(full, /AI 작성 부분은 따로 표시/);
    await page.uncheck('[data-include="assets"]');
    await page.uncheck('[data-include="gifts"]');
    const part = await page.textContent('#reportDoc');
    assert.doesNotMatch(part, /테스트 예금/);
    assert.doesNotMatch(part, /지인\(가명\)/);
    assert.match(part, /제외하고 출력/);
    await page.check('[data-include="assets"]');
    await page.check('[data-include="gifts"]');
  });

  await step('서류 체크는 키보드 포커스를 유지하고 점수에 반영된다', async () => {
    const box = page.locator('[data-doc="realestate"]');
    await box.focus();
    await page.keyboard.press('Space');
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.dataset.doc), 'realestate');
    assert.equal((await stateOf()).docs.realestate, true);
    assert.match(await page.textContent('#reportDoc'), /☑ 부동산/);
  });

  await step('인쇄 화면에서는 리포트만 보인다', async () => {
    await page.emulateMedia({ media: 'print' });
    assert.equal(await page.locator('#reportDoc').isVisible(), true);
    assert.equal(await page.locator('.site-header').isVisible(), false);
    assert.equal(await page.locator('.tabs').isVisible(), false);
    assert.equal(await page.locator('#report .no-print').first().isVisible(), false);
    await page.emulateMedia({ media: 'screen' });
  });

  await step('내려받기 → 전체 삭제 → 불러오기로 복원', async () => {
    await tab('data');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="export"]')]);
    const file = path.join(os.tmpdir(), 'ieum-smoke.json');
    await dl.saveAs(file);
    const before = await stateOf();
    await page.click('[data-action="reset-all"]');
    assert.equal(await stateOf(), null);
    assert.equal(await page.locator('#dataStatus').textContent().then((t) => /가족 0명/.test(t)), true);
    await page.setInputFiles('#importFile', file);
    await page.waitForFunction(() => /가족 2명/.test(document.getElementById('dataStatus').textContent));
    const after = await stateOf();
    assert.deepEqual(after.families, before.families);
    assert.deepEqual(after.assets, before.assets);
    assert.deepEqual(after.gifts, before.gifts);
  });

  await step('잘못된 파일은 거부하고 기존 데이터는 그대로 둔다', async () => {
    const bad = path.join(os.tmpdir(), 'ieum-bad.json');
    fs.writeFileSync(bad, '{"hello":"world"}');
    await page.setInputFiles('#importFile', bad);
    await page.waitForFunction(() => document.getElementById('dataError').textContent.length > 0);
    assert.match(await page.textContent('#dataError'), /이음에서 내려받은 파일이 아닙니다/);
    const garbage = path.join(os.tmpdir(), 'ieum-garbage.json');
    fs.writeFileSync(garbage, 'not json at all');
    await page.setInputFiles('#importFile', garbage);
    await page.waitForFunction(() => /JSON/.test(document.getElementById('dataError').textContent));
    assert.equal((await stateOf()).families.length, 2);
  });

  await step('손상된 저장값은 백업하고 새로 시작한다', async () => {
    await page.evaluate(() => localStorage.setItem('ieum.v1.state', '{broken'));
    await page.reload();
    assert.match(await page.textContent('#banner'), /읽지 못해/);
    assert.equal(await page.evaluate(() => localStorage.getItem('ieum.v1.state.corrupt')), '{broken');
  });

  await step('글자 크기·고대비 설정이 적용되고 유지된다', async () => {
    await page.click('[data-action="size"][data-size="xlarge"]');
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize), '25px');
    await page.click('[data-action="contrast"]');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.contrast), 'high');
    await page.reload();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.size), 'xlarge');
    await page.click('[data-action="size"][data-size="normal"]');
    await page.click('[data-action="contrast"]');
  });


  // ===================== 이용권·모의 결제 =====================
  const wallet = () => page.textContent('#walletChip');
  await page.evaluate(() => { window.print = () => { window.__printed = (window.__printed || 0) + 1; }; });

  await step('처음 이용권: AI 3회, 발급권 0장, 리포트는 미리보기', async () => {
    await page.evaluate(() => localStorage.removeItem('ieum.v1.shop'));
    await page.reload();
    await page.evaluate(() => { window.print = () => { window.__printed = (window.__printed || 0) + 1; }; });
    assert.match(await wallet(), /AI 3회/);
    assert.match(await wallet(), /발급권 0장/);
    await tab('report');
    assert.equal(await page.locator('#reportDoc.preview').count(), 1);
    assert.match(await page.textContent('#issueBox'), /발급 전 미리보기/);
    assert.equal(await page.locator('#issueBox [data-tab="store"]').count(), 1, '발급권이 없으면 구매 버튼');
  });

  await step('모의 결제: 결제 수단·확인 없이는 진행 안 됨, 완료 후 이용권 지급', async () => {
    await tab('store');
    await page.click('#productGrid [data-id="package"]');
    assert.equal(await page.locator('#checkoutDlg').isVisible(), true);
    await page.click('#coPay');
    assert.match(await page.textContent('#coError'), /결제 수단/);
    await page.check('input[name="coMethod"][value="card"]');
    await page.click('#coPay');
    assert.match(await page.textContent('#coError'), /모의 결제임을 확인/);
    assert.equal(await page.locator('input[name="coMethod"][value="balance"]').isDisabled(), true, '잔액 부족');
    await page.check('#coAgree');
    await page.click('#coPay');
    await page.waitForSelector('text=결제가 완료되었습니다');
    assert.match(await page.textContent('#checkoutBody'), /IEUM-\d{8}-0001/);
    await page.click('#checkoutBody [data-action="dlg-close"]');
    assert.match(await wallet(), /AI 33회/);
    assert.match(await wallet(), /발급권 1장/);
    assert.match(await page.textContent('#orderList'), /자산승계 준비 패키지/);
  });

  await step('리포트 발급: 발급권 1장 사용, 미리보기 해제, 인쇄 호출, 내용 바뀌면 다시 미리보기', async () => {
    await tab('report');
    await page.click('#issueBox [data-action="issue"]');
    assert.equal(await page.locator('#reportDoc.preview').count(), 0);
    assert.match(await page.textContent('#reportDoc'), /발급번호 IEUM-R-\d{4}-00001/);
    assert.equal(await page.evaluate(() => window.__printed), 1);
    assert.match(await wallet(), /발급권 0장/);
    await page.check('[data-doc="stock"]');
    assert.equal(await page.locator('#reportDoc.preview').count(), 1);
    await page.uncheck('[data-doc="stock"]');
  });

  let giftCode = '';
  await step('금액권: 선물용 구매 → 코드 발급 → 등록하면 잔액 충전, 재등록 불가', async () => {
    await tab('store');
    await page.click('#productGrid [data-id="gift50"]');
    await page.check('input[name="coMethod"][value="easy"]');
    await page.check('#coAgree');
    await page.click('#coPay');
    await page.waitForSelector('#giftCode');
    giftCode = (await page.textContent('#giftCode')).trim();
    assert.match(giftCode, /^IEUM-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    await page.click('#checkoutBody [data-action="dlg-close"]');
    await page.fill('#redeemCode', giftCode.toLowerCase());
    await page.click('#redeemForm button[type="submit"]');
    assert.match(await page.textContent('#walletView'), /50,000원/);
    await page.fill('#redeemCode', giftCode);
    await page.click('#redeemForm button[type="submit"]');
    assert.match(await page.textContent('#redeemError'), /이미 사용한/);
  });

  await step('연간 상품 구매 후 미사용 상태에서 환불', async () => {
    await page.click('#productGrid [data-id="family"]');
    await page.check('input[name="coMethod"][value="card"]');
    await page.check('#coAgree');
    await page.click('#coPay');
    await page.waitForSelector('text=결제가 완료되었습니다');
    await page.click('#checkoutBody [data-action="dlg-close"]');
    assert.match(await wallet(), /리포트 무제한/);
    const row = page.locator('#orderList tr', { hasText: '가족 기록관리' });
    await row.locator('[data-action="refund"]').click();
    assert.match(await row.textContent(), /환불됨/);
    assert.match(await wallet(), /발급권 0장/);
    const pkgRow = page.locator('#orderList tr', { hasText: '자산승계 준비 패키지' });
    assert.equal(await pkgRow.locator('[data-action="refund"]').count(), 0, '발급권을 쓴 주문은 환불 버튼 없음');
  });

  // ===================== 관리자 =====================
  await step('관리자: 비밀번호 만들기(불일치 오류) → 관리자 탭 표시, 매출 집계', async () => {
    assert.equal(await page.locator('#adminTab').isVisible(), false);
    await page.click('#adminBtn');
    assert.match(await page.textContent('#adminDlgTitle'), /만들기/);
    await page.fill('#adminPw', 'demo1234');
    await page.fill('#adminPw2', 'demo9999');
    await page.click('#adminSubmit');
    assert.match(await page.textContent('#adminError'), /서로 다릅니다/);
    await page.fill('#adminPw2', 'demo1234');
    await page.click('#adminSubmit');
    await page.waitForSelector('#adminBody:not([hidden])');
    assert.equal(await page.locator('#adminTab').isVisible(), true);
    const stats = await page.textContent('#adminStats');
    assert.match(stats, /89,000원/);
    assert.match(stats, /1 \/ 279건/);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('ieum.v1.shop')).admin);
    assert.match(saved.hash, /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(saved).includes('demo1234'), false, '비밀번호 원문 저장 안 함');
  });

  await step('관리자: 가격 변경·상품 추가·금액권 발급·이용권 지급이 이용자 화면에 반영', async () => {
    await page.fill('#price-package', '79000');
    await page.click('[data-action="p-price"][data-id="package"]');
    await page.fill('#pName', 'AI 추가 10회권');
    await page.fill('#pPrice', '9900');
    await page.fill('#pAi', '10');
    await page.click('#productForm button[type="submit"]');
    await page.fill('#codeAmount', '100000');
    await page.fill('#codeMemo', '발표 시연');
    await page.click('#codeForm button[type="submit"]');
    assert.match(await page.textContent('#adminCodes'), /IEUM-[A-Z0-9]{4}-[A-Z0-9]{4}/);
    const before = await wallet();
    await page.fill('#grantAi', '5');
    await page.fill('#grantReport', '1');
    await page.click('#grantForm button[type="submit"]');
    assert.notEqual(await wallet(), before);
    assert.match(await wallet(), /발급권 1장/);
    await tab('store');
    assert.match(await page.textContent('#productGrid'), /79,000원/);
    assert.match(await page.textContent('#productGrid'), /AI 추가 10회권/);
  });

  await step('관리자: 로그아웃 후 틀린 비밀번호는 거부, 맞으면 접속', async () => {
    await tab('admin');
    await page.click('[data-action="admin-logout"]');
    assert.equal(await page.locator('#adminTab').isVisible(), false);
    await page.click('#adminBtn');
    await page.fill('#adminPw', 'wrongpass');
    await page.click('#adminSubmit');
    assert.match(await page.textContent('#adminError'), /맞지 않습니다/);
    await page.fill('#adminPw', 'demo1234');
    await page.click('#adminSubmit');
    await page.waitForSelector('#adminBody:not([hidden])');
  });

  // ===================== AI (가짜 응답) =====================
  await step('AI 키 없이 누르면 안내만 하고 요청하지 않는다', async () => {
    await tab('assistant');
    await page.click('#quickQs .chip-q');
    assert.match(await page.textContent('#chatStatus'), /AI 연결이 아직/);
    assert.equal(aiCalls.length, 0);
  });

  await step('관리자 AI 설정: 키 저장(화면에 다시 표시 안 함), 연결 테스트는 횟수 차감 없음', async () => {
    await tab('admin');
    await page.fill('#aiKey', 'TEST-KEY-1234');
    await page.fill('#aiModel', 'gemini-3.5-flash-lite');
    await page.click('#aiKeyForm button[type="submit"]');
    assert.equal(await page.inputValue('#aiKey'), '');
    assert.match(await page.getAttribute('#aiKey', 'placeholder'), /1234/);
    const before = await wallet();
    await page.click('[data-action="ai-ping"]');
    await page.waitForFunction(() => /연결됨/.test(document.getElementById('aiKeyStatus').textContent));
    assert.equal(await wallet(), before);
    assert.equal(aiCalls.at(-1).key, 'TEST-KEY-1234');
    assert.match(aiCalls.at(-1).url, /models\/gemini-3\.5-flash-lite:generateContent$/);
  });

  await step('AI 서류 읽기: 견본 선택 → 동의 → 추출 → 기준일 빠진 항목 검증 → 저장(AI 추출 표시)', async () => {
    await tab('assets');
    await page.waitForSelector('#sampleRow .sample');
    await page.click('#sampleRow [data-id="deposit"]');
    assert.equal(await page.locator('#aiReadBtn').isDisabled(), true, '동의 전에는 비활성');
    await page.check('#aiConsent');
    const aiBefore = Number((await wallet()).match(/AI (\d+)회/)[1]);
    await page.click('#aiReadBtn');
    await page.waitForSelector('#aiReviewForm');
    const sent = aiCalls.at(-1).body;
    assert.equal(sent.contents[0].parts[0].inlineData.mimeType, 'image/jpeg');
    assert.ok(sent.generationConfig.responseSchema);
    assert.equal(await page.locator('.extract-item').count(), 2);
    assert.equal(await page.inputValue('#x-name-0'), '정기예금 ••••', '계좌번호 가림');
    await page.check('[data-x="verified"][data-i="0"]');
    await page.click('#aiReviewForm button[type="submit"]');
    assert.match(await page.textContent('#aiReviewError'), /항목 2: 기준일/);
    await page.fill('#x-asof-1', '2026-11-20');
    await page.click('#aiReviewForm button[type="submit"]');
    const assets = (await stateOf()).assets.filter((a) => a.src === 'ai');
    assert.equal(assets.length, 2);
    assert.equal(assets[0].status, '직접 확인');
    assert.equal(assets[1].status, '나중에 확인');
    assert.equal(await page.locator('#assetList .badge.ai').count(), 2);
    assert.equal(Number((await wallet()).match(/AI (\d+)회/)[1]), aiBefore - 1);
  });

  await step('AI 상담 브리핑: 안전장치가 세액 추정 문장을 가리고 리포트에 AI 작성 표시', async () => {
    await tab('report');
    await page.click('#aiBriefBtn');
    await page.waitForFunction(() => /브리핑을 만들었습니다/.test(document.getElementById('aiBriefStatus').textContent));
    const sent = JSON.stringify(aiCalls.at(-1).body);
    assert.match(sent, /상담 준비 브리핑/);
    const view = await page.textContent('#aiBriefView');
    assert.doesNotMatch(view, /2억원/);
    assert.match(view, /전문가 확인이 필요한 내용이라/);
    assert.match(view, /1개 문장을 걸렀습니다/);
    assert.match(await page.textContent('#reportDoc'), /\d+\. AI 상담 브리핑\s*AI 작성/);
    await page.uncheck('[data-include="ai"]');
    assert.doesNotMatch(await page.textContent('#reportDoc'), /\d+\. AI 상담 브리핑/);
    await page.check('[data-include="ai"]');
  });

  await step('AI 브리핑 요청에는 리포트에서 뺀 항목이 들어가지 않는다', async () => {
    await page.uncheck('[data-include="assets"]');
    await page.click('#aiBriefBtn');
    await page.waitForFunction(() => /브리핑을 만들었습니다/.test(document.getElementById('aiBriefStatus').textContent));
    assert.doesNotMatch(JSON.stringify(aiCalls.at(-1).body), /재산채무/);
    await page.check('[data-include="assets"]');
  });

  await step('AI 도우미: 답변 표시 + 유불리 권유 문장 차단, 실패 시 횟수 차감 없음', async () => {
    await tab('assistant');
    await page.click('#quickQs .chip-q');
    await page.waitForSelector('.msg.ai');
    const ans = await page.textContent('.msg.ai .bubble');
    assert.match(ans, /유류분은/);
    assert.doesNotMatch(ans, /더 좋습니다/);
    assert.match(ans, /1개 문장을 걸렀습니다/);
    aiMode = 'quota';
    const before = await wallet();
    await page.fill('#chatInput', '다른 질문');
    await page.click('#chatSend');
    await page.waitForSelector('.msg.sys');
    assert.match(await page.textContent('.msg.sys'), /무료 사용량/);
    assert.equal(await wallet(), before);
    aiMode = 'ok';
  });

  await step('내려받은 데이터 파일에 API 키·관리자 정보가 없다', async () => {
    await tab('data');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="export"]')]);
    const file = path.join(os.tmpdir(), 'ieum-smoke2.json');
    await dl.saveAs(file);
    const txt = fs.readFileSync(file, 'utf8');
    assert.equal(txt.includes('TEST-KEY'), false);
    assert.equal(txt.includes('hash'), false);
  });

  await step('모바일 폭(375px)에서 모든 탭이 가로로 넘치지 않는다', async () => {
    await tab('home');
    await page.click('.hero [data-action="load-sample"]');
    await page.setViewportSize({ width: 375, height: 800 });
    const ids = ['home', 'family', 'assets', 'check', 'scenario', 'will', 'report', 'assistant', 'store', 'data', 'admin'];
    for (const id of ids) {
      await tab(id);
      const over = await page.evaluate(() => {
        const vis = document.querySelector('.panel:not([hidden])');
        return document.documentElement.scrollWidth - document.documentElement.clientWidth + ':' + (vis ? vis.id : '');
      });
      const n = Number(over.split(':')[0]);
      assert.ok(n <= 1, id + ' 탭이 ' + n + 'px 넘칩니다');
    }
  });

  await step('최소 터치 영역 44px을 지킨다 (버튼·입력)', async () => {
    await page.setViewportSize({ width: 1100, height: 900 });
    await tab('assets');
    const small = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('.panel:not([hidden]) button, .panel:not([hidden]) input:not([type=checkbox]):not([type=radio]):not([hidden]), .panel:not([hidden]) select').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.height < 43.5) out.push((el.id || el.textContent.trim()).slice(0, 20) + ':' + Math.round(r.height));
      });
      return out;
    });
    assert.deepEqual(small, []);
  });

  await step('전 과정에서 콘솔 오류가 없다', async () => {
    assert.deepEqual(errors, []);
  });

  await browser.close();
  console.log('\n' + passed + ' 단계 통과' + (process.exitCode ? ', 실패 있음' : ''));
})();
