/* =========================================================
   이음 IEUM - ai-ui.js
   AI 기능 화면: 서류 읽기(사진 → 재산 항목), 상담 브리핑, AI 도우미, 관리자 AI 설정
   AI 호출·검증은 ai.js, 이용 횟수 차감은 shop-ui.js(IEUM_STORE)
   ========================================================= */
(function () {
  'use strict';

  const AI = window.IEUM_AI;
  const APP = window.IEUM_APP;
  const STORE = window.IEUM_STORE;
  const L = window.IEUM;
  if (!AI || !APP || !STORE || !L) return;
  const h = L.escapeHTML;
  const KEY = 'ieum.v1.ai';
  const $ = function (id) { return document.getElementById(id); };
  const QUICK = ['유류분이 뭐예요?', '사전증여 합산이 무슨 뜻인가요?', '상담 갈 때 무엇을 챙겨야 하나요?', '유언은 어떤 방식으로 남기나요?'];
  const CONF = { high: ['확신 높음', 'ok'], medium: ['확신 보통', 'warn'], low: ['확신 낮음', 'danger'] };

  let settings = { key: '', model: AI.DEFAULT_MODEL };
  let doc = null; // {mime, base64, name, preview}
  let extracted = null;
  let chat = []; // {role:'user'|'model'|'error', text, removed}
  let busy = false;

  // ---------- 설정 ----------
  function loadSettings() {
    try {
      const raw = window.localStorage.getItem(KEY);
      if (raw) {
        const s = JSON.parse(raw);
        if (typeof s.key === 'string') settings.key = s.key.slice(0, 200);
        if (typeof s.model === 'string' && /^[a-z0-9][a-z0-9.-]{2,60}$/.test(s.model)) settings.model = s.model;
      }
    } catch (e) { /* 기본값 */ }
  }
  function saveSettings() {
    try { window.localStorage.setItem(KEY, JSON.stringify(settings)); } catch (e) { /* 무시 */ }
  }
  function opts() {
    return { key: settings.key, model: settings.model };
  }

  // 실행 전 공통 확인: 키, 이용 횟수
  function precheck(statusId) {
    if (busy) return false;
    if (!settings.key) {
      setStatus(statusId, 'AI 연결이 아직 설정되지 않았습니다. 관리자 화면의 "AI 설정"에서 API 키를 입력하세요.', 'warn');
      return false;
    }
    if (STORE.aiLeft() <= 0) {
      setStatus(statusId, 'AI 이용 횟수가 남아 있지 않습니다. 이용권 화면에서 구매하세요.', 'warn');
      return false;
    }
    return true;
  }

  function setStatus(id, text, level) {
    const el = $(id);
    if (!el) return;
    el.textContent = text || '';
    el.className = 'ai-status' + (level ? ' ' + level : '');
  }

  function setBusy(on, btnId, label) {
    busy = on;
    ['aiReadBtn', 'aiBriefBtn', 'chatSend'].forEach(function (id) {
      const b = $(id);
      if (b) b.disabled = on || (id === 'aiReadBtn' && !(doc && $('aiConsent').checked));
    });
    const b = $(btnId);
    if (b) {
      if (on) {
        b.dataset.label = b.innerHTML;
        b.innerHTML = '<span class="spinner" aria-hidden="true"></span>' + h(label);
        b.setAttribute('aria-busy', 'true');
      } else if (b.dataset.label) {
        b.innerHTML = b.dataset.label;
        b.removeAttribute('aria-busy');
      }
    }
  }

  const CONN_MSG = 'AI 연결 전 · 관리자 > AI 설정에서 키를 입력하면 실제 AI가 동작합니다.';
  function connText() {
    return settings.key ? '' : CONN_MSG;
  }

  // ---------- 서류 읽기 ----------
  function loadSamples(cb) {
    if (window.IEUM_SAMPLES) return cb();
    const s = document.createElement('script');
    s.src = 'samples.js';
    s.onload = cb;
    s.onerror = function () { $('sampleRow').innerHTML = '<p class="muted">견본 서류를 불러오지 못했습니다.</p>'; };
    document.body.appendChild(s);
  }

  function renderSamples() {
    const list = window.IEUM_SAMPLES || [];
    $('sampleRow').innerHTML =
      '<span class="sample-label">견본 서류로 해보기 (가상)</span>' +
      list.map(function (x) {
        return '<button type="button" class="sample" data-action="ai-sample" data-id="' + h(x.id) + '"><img alt="" src="data:' + h(x.mime) + ';base64,' + x.data + '"><span>' + h(x.title) + '</span></button>';
      }).join('');
  }

  function setDoc(d) {
    doc = d;
    extracted = null;
    $('aiDocResult').innerHTML = '';
    const pv = $('aiDocPreview');
    if (!d) {
      pv.hidden = true;
      pv.innerHTML = '';
    } else {
      pv.hidden = false;
      pv.innerHTML =
        (d.mime.indexOf('image/') === 0 ? '<img src="data:' + h(d.mime) + ';base64,' + d.base64 + '" alt="선택한 서류: ' + h(d.name) + '">' : '<div class="pdf-icon" aria-hidden="true">PDF</div>') +
        '<div><b>' + h(d.name) + '</b><div class="sub">' + (d.sample ? '앱에 들어 있는 가상 견본' : '이 기기에서 고른 파일 · 저장하지 않음') + '</div>' +
        '<button type="button" class="link" data-action="ai-doc-clear">다른 서류 고르기</button></div>';
    }
    refreshReadBtn();
    setStatus('aiDocStatus', d ? (settings.key ? '"AI로 읽기"를 누르세요.' : connText()) : '');
  }

  function refreshReadBtn() {
    $('aiReadBtn').disabled = busy || !doc || !$('aiConsent').checked;
    $('aiReadBtn').innerHTML = 'AI로 읽기 <small>(AI 1회 사용 · 남은 ' + STORE.aiLeft() + '회)</small>';
  }

  function readFile(file) {
    if (!file) return;
    const okType = /^image\//.test(file.type) || file.type === 'application/pdf';
    if (!okType) return setStatus('aiDocStatus', '사진(JPG·PNG 등)이나 PDF만 올릴 수 있습니다.', 'warn');
    if (file.size > AI.MAX_IMAGE_BYTES) return setStatus('aiDocStatus', '파일이 너무 큽니다. (최대 8MB)', 'warn');
    const fr = new FileReader();
    fr.onerror = function () { setStatus('aiDocStatus', '파일을 읽지 못했습니다.', 'warn'); };
    fr.onload = function () {
      const url = String(fr.result);
      if (file.type === 'application/pdf' || file.type === 'image/gif') {
        setDoc({ mime: file.type, base64: url.split(',')[1], name: file.name.slice(0, 60), sample: false });
        return;
      }
      // 큰 사진은 줄여서 보낸다 (전송량·속도)
      const img = new Image();
      img.onload = function () {
        const max = 1600;
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        const out = c.toDataURL('image/jpeg', 0.85);
        setDoc({ mime: 'image/jpeg', base64: out.split(',')[1], name: file.name.slice(0, 60), sample: false });
      };
      img.onerror = function () { setStatus('aiDocStatus', '이미지를 열지 못했습니다.', 'warn'); };
      img.src = url;
    };
    fr.readAsDataURL(file);
  }

  async function runExtract() {
    if (!doc) return;
    if (!$('aiConsent').checked) return setStatus('aiDocStatus', '가상 자료이며 AI로 전송된다는 데 먼저 동의해 주세요.', 'warn');
    if (!precheck('aiDocStatus')) return;
    setBusy(true, 'aiReadBtn', 'AI가 서류를 읽는 중…');
    setStatus('aiDocStatus', 'AI가 서류를 읽고 있습니다. 10~30초 걸릴 수 있습니다.');
    const r = await AI.extract(opts(), doc.mime, doc.base64);
    setBusy(false, 'aiReadBtn');
    if (!r.ok) {
      setStatus('aiDocStatus', r.error, 'warn');
      refreshReadBtn();
      return;
    }
    STORE.useAi('서류 읽기');
    extracted = r;
    setStatus('aiDocStatus', 'AI가 ' + r.items.length + '개 항목을 찾았습니다. 원문과 대조한 뒤 저장하세요.', 'ok');
    renderExtract();
    refreshReadBtn();
    const head = $('aiResultHead');
    if (head) head.focus();
  }

  function renderExtract() {
    const box = $('aiDocResult');
    if (!extracted) {
      box.innerHTML = '';
      return;
    }
    const r = extracted;
    let html = '<div class="extract"><h3 id="aiResultHead" tabindex="-1">AI가 읽은 결과</h3>' +
      '<p class="sub">문서 종류: ' + h(r.docType || '알 수 없음') + ' · 모델 ' + h(r.model || '') + (r.dropped ? ' · 형식이 맞지 않아 뺀 항목 ' + r.dropped + '개' : '') + '</p>';
    if (r.note) html += '<p class="notice">' + h(r.note) + '</p>';
    if (!r.items.length) {
      box.innerHTML = html + '<p>재산이나 채무 항목을 찾지 못했습니다. 다른 서류로 다시 해 보세요.</p></div>';
      return;
    }
    html += '<form id="aiReviewForm" novalidate>';
    r.items.forEach(function (it, i) {
      const c = CONF[it.confidence] || CONF.low;
      html +=
        '<fieldset class="extract-item"><legend>항목 ' + (i + 1) + ' <span class="badge ' + c[1] + '">' + c[0] + '</span></legend>' +
        '<label class="check"><input type="checkbox" data-x="use" data-i="' + i + '" checked> 이 항목을 재산 목록에 저장</label>' +
        '<div class="form-grid">' +
        '<div><label for="x-type-' + i + '">분류</label><select id="x-type-' + i + '" data-x="type" data-i="' + i + '">' +
        ['부동산', '예금', '주식', '보험', '기타', '채무'].map(function (t) { return '<option' + (t === it.type ? ' selected' : '') + '>' + t + '</option>'; }).join('') + '</select></div>' +
        '<div><label for="x-name-' + i + '">항목명</label><input id="x-name-' + i + '" data-x="name" data-i="' + i + '" maxlength="60" value="' + h(it.name) + '"></div>' +
        '<div><label for="x-value-' + i + '">금액 (원)</label><input id="x-value-' + i + '" data-x="value" data-i="' + i + '" type="number" min="0" step="1" value="' + it.value + '"><p class="hint">= ' + h(L.koreanAmount(it.value)) + '</p></div>' +
        '<div><label for="x-asof-' + i + '">기준일</label><input id="x-asof-' + i + '" data-x="asOf" data-i="' + i + '" type="date" value="' + h(it.asOf) + '" max="' + L.todayStr() + '">' + (it.asOf ? '' : '<p class="hint warn-text">문서에서 기준일을 찾지 못했습니다. 직접 입력하세요.</p>') + '</div>' +
        '</div>' +
        '<p class="evidence"><span>AI가 읽은 원문</span> “' + h(it.evidence || '(원문 문구 없음)') + '”</p>' +
        '<label class="check"><input type="checkbox" data-x="verified" data-i="' + i + '"> 원문과 대조해 금액·기준일이 맞는 것을 확인했습니다 <span class="sub">(확인하지 않으면 "나중에 확인"으로 저장)</span></label>' +
        '</fieldset>';
    });
    html += '<p class="form-error" id="aiReviewError" role="alert"></p>' +
      '<div class="btn-row"><button type="submit" class="primary">선택한 항목 저장</button><button type="button" class="secondary" data-action="ai-discard">저장하지 않고 버리기</button></div>' +
      '<p class="muted">서류 원본 이미지는 저장하지 않습니다. AI가 읽은 값은 틀릴 수 있으니 반드시 원문과 대조하세요.</p></form></div>';
    box.innerHTML = html;
  }

  function saveExtract(e) {
    e.preventDefault();
    const form = e.target;
    const err = $('aiReviewError');
    err.textContent = '';
    form.querySelectorAll('[aria-invalid]').forEach(function (x) { x.removeAttribute('aria-invalid'); });
    const today = L.todayStr();
    const out = [];
    for (let i = 0; i < extracted.items.length; i++) {
      const get = function (x) { return form.querySelector('[data-x="' + x + '"][data-i="' + i + '"]'); };
      if (!get('use').checked) continue;
      const name = get('name').value.trim();
      const vEl = get('value');
      const value = Number(vEl.value);
      const asOf = get('asOf').value;
      const fail = function (el, msg) {
        err.textContent = '항목 ' + (i + 1) + ': ' + msg;
        el.setAttribute('aria-invalid', 'true');
        el.focus();
      };
      if (!name) return fail(get('name'), '항목명을 입력하세요.');
      if (vEl.value === '' || !Number.isSafeInteger(value) || value < 0 || value > 9999999999999) return fail(vEl, '금액은 0원 이상의 정수로 입력하세요.');
      if (!L.parseDate(asOf) || asOf > today) return fail(get('asOf'), '기준일을 오늘 이전 날짜로 입력하세요.');
      out.push({ type: get('type').value, name: name.slice(0, 60), value: value, asOf: asOf, status: get('verified').checked ? '직접 확인' : '나중에 확인', src: 'ai' });
    }
    if (!out.length) {
      err.textContent = '저장할 항목을 하나 이상 선택하세요.';
      return;
    }
    APP.addAssets(out);
    extracted = null;
    setDoc(null);
    setStatus('aiDocStatus', out.length + '건을 재산 목록에 저장했습니다.', 'ok');
    const list = $('assetList');
    if (list && list.scrollIntoView) list.scrollIntoView({ block: 'center' });
  }

  // ---------- 상담 브리핑 ----------
  async function runBriefing() {
    if (!APP.hasData()) return setStatus('aiBriefStatus', '먼저 가족이나 재산을 입력하세요. (가상 샘플로도 해볼 수 있습니다)', 'warn');
    if (!precheck('aiBriefStatus')) return;
    const facts = APP.aiFacts();
    const stamp = APP.factsStamp();
    setBusy(true, 'aiBriefBtn', 'AI가 브리핑을 쓰는 중…');
    setStatus('aiBriefStatus', '리포트에 포함한 정보만 AI로 보내는 중입니다.');
    const r = await AI.briefing(opts(), facts);
    setBusy(false, 'aiBriefBtn');
    if (!r.ok) return setStatus('aiBriefStatus', r.error, 'warn');
    STORE.useAi('상담 브리핑');
    APP.setBriefing({ summary: r.summary, missing: r.missing, questions: r.questions, removed: r.removed.length, model: r.model, at: new Date().toISOString(), stamp: stamp });
    setStatus('aiBriefStatus', '브리핑을 만들었습니다.' + (r.removed.length ? ' 안전장치가 ' + r.removed.length + '개 문장을 걸렀습니다.' : ''), 'ok');
    refreshButtons();
  }

  // ---------- AI 도우미 ----------
  function renderChat() {
    const log = $('chatLog');
    if (!chat.length) {
      log.innerHTML = '<p class="chat-empty">무엇이든 물어보세요. 아래 예시를 눌러도 됩니다.</p>';
      return;
    }
    const canSpeak = 'speechSynthesis' in window;
    log.innerHTML = chat.map(function (m, i) {
      if (m.role === 'user') return '<div class="msg me"><div class="bubble">' + h(m.text) + '</div></div>';
      if (m.role === 'error') return '<div class="msg sys"><div class="bubble">' + h(m.text) + '</div></div>';
      return '<div class="msg ai"><span class="avatar" aria-hidden="true">AI</span><div class="bubble">' + h(m.text) +
        (m.removed ? '<div class="sub">안전장치가 ' + m.removed + '개 문장을 걸렀습니다.</div>' : '') +
        (canSpeak ? '<button type="button" class="link small" data-action="speak" data-i="' + i + '">🔊 읽어주기</button>' : '') + '</div></div>';
    }).join('');
    log.scrollTop = log.scrollHeight;
  }

  async function ask(question) {
    const q = String(question || '').trim();
    if (!q) return setStatus('chatStatus', '질문을 입력하세요.', 'warn');
    if (!precheck('chatStatus')) return;
    const history = chat.filter(function (m) { return m.role === 'user' || m.role === 'model'; });
    chat.push({ role: 'user', text: q });
    renderChat();
    $('chatInput').value = '';
    setBusy(true, 'chatSend', '답을 쓰는 중…');
    setStatus('chatStatus', 'AI가 답을 쓰고 있습니다.');
    const r = await AI.chat(opts(), history, q, $('chatContext').checked ? APP.aiFacts() : null);
    setBusy(false, 'chatSend');
    if (!r.ok) {
      chat.push({ role: 'error', text: r.error });
      setStatus('chatStatus', '');
    } else {
      STORE.useAi('도우미 질문');
      chat.push({ role: 'model', text: r.text, removed: r.removed.length });
      setStatus('chatStatus', '');
    }
    renderChat();
    refreshButtons();
  }

  function speak(i) {
    const m = chat[i];
    if (!m || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const u = new window.SpeechSynthesisUtterance(m.text.replace(/\[[^\]]+\]/g, '전문가 확인이 필요한 내용은 생략했습니다.'));
    u.lang = 'ko-KR';
    u.rate = 0.95;
    window.speechSynthesis.speak(u);
  }

  let rec = null;
  function setupMic() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    $('micBtn').hidden = false;
    rec = new SR();
    rec.lang = 'ko-KR';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onresult = function (e) {
      const t = e.results[0] && e.results[0][0] ? e.results[0][0].transcript : '';
      $('chatInput').value = t;
      setStatus('chatStatus', t ? '받아 적었습니다. 내용을 확인하고 "물어보기"를 누르세요.' : '');
    };
    rec.onend = function () { $('micBtn').setAttribute('aria-pressed', 'false'); };
    rec.onerror = function () { setStatus('chatStatus', '음성을 인식하지 못했습니다. 마이크 권한을 확인하세요.', 'warn'); };
  }

  // ---------- 관리자 AI 설정 ----------
  function renderSettings() {
    const sel = $('aiModel');
    const models = AI.MODELS.slice();
    if (models.indexOf(settings.model) < 0) models.push(settings.model);
    sel.innerHTML = models.map(function (m) { return '<option value="' + h(m) + '">' + h(m) + (m === AI.DEFAULT_MODEL ? ' (기본, 최신 Flash 자동)' : '') + '</option>'; }).join('');
    sel.value = settings.model;
    $('aiKey').placeholder = settings.key ? '저장된 키 있음 (끝자리 ' + settings.key.slice(-4) + ') · 바꾸려면 새 키 입력' : '키를 붙여 넣으세요';
  }

  function refreshButtons() {
    refreshReadBtn();
    $('aiBriefBtn').innerHTML = 'AI 브리핑 만들기 <small>(AI 1회 사용 · 남은 ' + STORE.aiLeft() + '회)</small>';
    $('chatSend').innerHTML = '물어보기 <small>(AI 1회 · 남은 ' + STORE.aiLeft() + '회)</small>';
    if (!busy) {
      ['aiBriefStatus', 'chatStatus', 'aiDocStatus'].forEach(function (id) {
        const t = $(id).textContent;
        if (!t || t === CONN_MSG) setStatus(id, connText());
      });
    }
  }

  // ---------- 이벤트 ----------
  document.addEventListener('click', function (e) {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const act = el.dataset.action;
    if (act === 'ai-pick') $('aiDocFile').click();
    else if (act === 'ai-sample') {
      const x = (window.IEUM_SAMPLES || []).find(function (s) { return s.id === el.dataset.id; });
      if (x) setDoc({ mime: x.mime, base64: x.data, name: x.title + ' (견본)', sample: true });
    } else if (act === 'ai-doc-clear') {
      setDoc(null);
      $('aiDocFile').value = '';
    } else if (act === 'ai-read') runExtract();
    else if (act === 'ai-discard') {
      extracted = null;
      renderExtract();
      setStatus('aiDocStatus', 'AI 결과를 버렸습니다.');
    } else if (act === 'ai-brief') runBriefing();
    else if (act === 'ai-brief-del') {
      if (window.confirm('AI 상담 브리핑을 지울까요?')) APP.setBriefing(null);
    } else if (act === 'ask') ask(el.dataset.q);
    else if (act === 'speak') speak(Number(el.dataset.i));
    else if (act === 'chat-clear') {
      chat = [];
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
      renderChat();
    } else if (act === 'mic' && rec) {
      try {
        rec.start();
        el.setAttribute('aria-pressed', 'true');
        setStatus('chatStatus', '말씀하세요. 듣고 있습니다…');
      } catch (err) { /* 이미 듣는 중 */ }
    } else if (act === 'ai-ping') {
      setStatus('aiKeyStatus', '연결을 확인하는 중…');
      AI.ping(opts()).then(function (r) {
        setStatus('aiKeyStatus', r.ok ? '연결됨 · 모델 ' + r.model + ' (AI 이용 횟수는 차감하지 않음)' : r.error, r.ok ? 'ok' : 'warn');
      });
    } else if (act === 'ai-key-del') {
      if (!window.confirm('저장된 API 키를 이 기기에서 지울까요?')) return;
      settings.key = '';
      saveSettings();
      renderSettings();
      refreshButtons();
      setStatus('aiKeyStatus', 'API 키를 지웠습니다.');
    }
  });

  document.addEventListener('change', function (e) {
    const t = e.target;
    if (t.id === 'aiDocFile') readFile(t.files && t.files[0]);
    else if (t.id === 'aiConsent') refreshReadBtn();
    else if (t.dataset && t.dataset.x === 'value') {
      const hint = t.parentNode.querySelector('.hint');
      const n = Number(t.value);
      if (hint) hint.textContent = Number.isSafeInteger(n) && n >= 0 ? '= ' + L.koreanAmount(n) : '';
    }
  });

  document.addEventListener('submit', function (e) {
    if (e.target.id === 'aiReviewForm') saveExtract(e);
  });

  $('chatForm').addEventListener('submit', function (e) {
    e.preventDefault();
    ask($('chatInput').value);
  });
  $('chatInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      ask($('chatInput').value);
    }
  });

  $('aiKeyForm').addEventListener('submit', function (e) {
    e.preventDefault();
    const k = $('aiKey').value.trim();
    if (k) settings.key = k.slice(0, 200);
    settings.model = $('aiModel').value || AI.DEFAULT_MODEL;
    saveSettings();
    $('aiKey').value = '';
    renderSettings();
    refreshButtons();
    setStatus('aiKeyStatus', settings.key ? '저장했습니다. "연결 테스트"로 확인해 보세요.' : '모델을 저장했습니다. API 키가 아직 없습니다.', settings.key ? 'ok' : 'warn');
  });

  $('quickQs').innerHTML = QUICK.map(function (q) {
    return '<button type="button" class="chip-q" data-action="ask" data-q="' + h(q) + '">' + h(q) + '</button>';
  }).join('');

  loadSettings();
  renderSettings();
  renderChat();
  setupMic();
  setDoc(null);
  APP.onRender(refreshButtons);
  refreshButtons();
  loadSamples(renderSamples);
})();
