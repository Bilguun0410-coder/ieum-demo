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
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
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
    assert.match(full, /AI를 사용하지 않고/);
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

  await step('모바일 폭(375px)에서 모든 탭이 가로로 넘치지 않는다', async () => {
    await tab('home');
    await page.click('.hero [data-action="load-sample"]');
    await page.setViewportSize({ width: 375, height: 800 });
    const ids = ['home', 'family', 'assets', 'check', 'scenario', 'will', 'report', 'data'];
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
