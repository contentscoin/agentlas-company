/**
 * 승인 콘솔 (R14.4, R14.7)
 *
 * 오너 승인이 이 시스템의 병목이다. 설계상 승인 없이는 아무것도 나가지
 * 않는데, 지금까지 승인하려면 터미널에서 64자 digest 를 손으로 옮겨야 했다.
 * 카드 TTL 이 12시간이라 폰에서 몇 초 안에 결정하지 못하면 무인 운영이
 * 성립하지 않는다.
 *
 * **사람이 해시를 옮기지 않는다.** 화면은 digest 를 보여 주되 전송은 페이지가
 * 한다. 손으로 옮기면 잘라 붙이게 되고, 잘린 digest 는 불일치로 판정되어
 * 카드를 무효화한다 — 이 프로젝트에서 실제로 그렇게 카드를 하나 날렸다.
 *
 * **콘솔은 두 번째 통제 경로가 아니다.** 여기 있는 것은 화면뿐이고 판정은
 * 전부 서버가 한다 — 토큰 인증, L3 단계별 인증, 사설망 바인딩, 정책 등급.
 * 페이지를 고쳐도 통제가 느슨해지지 않아야 한다.
 *
 * 빌드 단계를 두지 않는다. 문자열 하나로 서빙하면 오피스 서버만 띄우면 되고,
 * 번들러가 죽어서 승인이 막히는 경로가 생기지 않는다.
 */

export const CONSOLE_HTML = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>승인 콘솔</title>
<style>
  :root {
    --bg: #0f1417;
    --panel: #161d21;
    --panel-2: #1c2529;
    --line: #263136;
    --ink: #e2e9e7;
    --muted: #8a9b96;
    --accent: #4fae95;
    --warn: #e0a34a;
    --danger: #e0736c;
    --radius: 10px;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--ink);
    font-family: -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", Pretendard,
      "Noto Sans KR", system-ui, sans-serif;
    line-height: 1.6;
    -webkit-text-size-adjust: 100%;
    padding: env(safe-area-inset-top) 0 calc(env(safe-area-inset-bottom) + 5rem);
  }
  .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-variant-numeric: tabular-nums;
  }
  .wrap { max-width: 34rem; margin: 0 auto; padding: 0 1rem; }

  header {
    display: flex; align-items: baseline; gap: .6rem;
    padding: 1.25rem 0 1rem;
  }
  header h1 { font-size: 1.05rem; margin: 0; font-weight: 700; letter-spacing: -.01em; }
  header .dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--muted); flex: none; align-self: center;
  }
  header .dot.live { background: var(--accent); }
  header .meta { margin-left: auto; font-size: .75rem; color: var(--muted); }

  .card {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: 1rem;
    margin-bottom: .85rem;
  }
  .card.irreversible { border-color: #4a2f2d; }

  .row { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
  .lvl {
    font-size: .7rem; font-weight: 700; letter-spacing: .06em;
    padding: .15rem .45rem; border-radius: 4px;
    background: #24333a; color: var(--accent);
  }
  .lvl.L3 { background: #3a2724; color: var(--danger); }
  .lvl.L2 { background: #3a3324; color: var(--warn); }
  .tag {
    font-size: .7rem; font-weight: 700; letter-spacing: .06em;
    padding: .15rem .45rem; border-radius: 4px;
    background: #3a2724; color: var(--danger);
  }
  .action { font-weight: 700; font-size: 1.02rem; }
  .summary { margin: .55rem 0 0; color: var(--ink); }
  .sub { color: var(--muted); font-size: .82rem; margin: .3rem 0 0; }

  .digest {
    margin-top: .7rem; padding: .5rem .6rem;
    background: var(--panel-2); border-radius: 6px;
    font-size: .72rem; color: var(--muted);
    word-break: break-all; line-height: 1.5;
  }
  .digest b { color: var(--ink); font-weight: 600; }

  .totp { margin-top: .8rem; }
  .totp label { display: block; font-size: .78rem; color: var(--muted); margin-bottom: .3rem; }
  input[type="text"], input[type="password"] {
    width: 100%; padding: .7rem .75rem;
    background: var(--panel-2); border: 1px solid var(--line);
    border-radius: 8px; color: var(--ink); font-size: 1rem;
  }
  input:focus-visible, button:focus-visible {
    outline: 2px solid var(--accent); outline-offset: 2px;
  }
  input.code { letter-spacing: .3em; text-align: center; font-size: 1.3rem; }

  .actions { display: flex; gap: .55rem; margin-top: .9rem; }
  button {
    flex: 1; padding: .8rem .5rem;
    border: 1px solid var(--line); border-radius: 8px;
    background: var(--panel-2); color: var(--ink);
    font-size: .95rem; font-weight: 600; font-family: inherit;
    cursor: pointer; min-height: 44px;
  }
  button.approve { background: #1d4d41; border-color: #276353; color: #cdece2; }
  button.reject { color: var(--muted); }
  button.panic {
    background: transparent; border-color: #4a2f2d; color: var(--danger);
    font-size: .85rem; padding: .6rem;
  }
  button:disabled { opacity: .45; cursor: not-allowed; }
  button:active:not(:disabled) { transform: translateY(1px); }

  .empty { text-align: center; color: var(--muted); padding: 3rem 1rem; }
  .empty .big { font-size: 1.05rem; color: var(--ink); margin-bottom: .4rem; }

  .msg {
    padding: .7rem .85rem; border-radius: 8px; margin-bottom: .85rem;
    font-size: .88rem; border: 1px solid var(--line); background: var(--panel);
  }
  .msg.err { border-color: #4a2f2d; color: var(--danger); }
  .msg.ok { border-color: #276353; color: var(--accent); }

  .foot { margin-top: 1.5rem; padding-top: 1rem; border-top: 1px solid var(--line); }
  .foot p { font-size: .75rem; color: var(--muted); margin: .6rem 0 0; }
  #lock { padding-top: 2.5rem; }
  #lock h2 { font-size: 1.15rem; margin: 0 0 .4rem; }
  #lock p { color: var(--muted); font-size: .88rem; margin: 0 0 1.2rem; }
  .hidden { display: none !important; }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>
</head>
<body>
<div class="wrap">

  <div id="lock" class="hidden">
    <h2>기기 토큰</h2>
    <p>이 콘솔은 오너 기기에서만 열립니다. <span class="mono">company office device add</span> 로 발급한 토큰을 넣으세요.</p>
    <input id="tok" type="password" inputmode="text" autocomplete="off" placeholder="기기 토큰">
    <div class="actions"><button id="unlock" class="approve">열기</button></div>
    <div id="lockmsg"></div>
  </div>

  <div id="app" class="hidden">
    <header>
      <span class="dot" id="dot"></span>
      <h1>승인</h1>
      <span class="meta" id="meta">—</span>
    </header>
    <div id="msg"></div>
    <div id="list"></div>
    <div class="foot">
      <button class="panic" id="panic">전체 차단 — 모든 능력 스위치를 끕니다</button>
      <p>승인은 화면에 보이는 내용에 묶입니다. 목록이 바뀐 뒤에 누르면 그 승인은 거부됩니다.</p>
      <p><button id="forget" style="all:unset;cursor:pointer;text-decoration:underline">이 기기에서 토큰 지우기</button></p>
    </div>
  </div>

</div>
<script>
(function () {
  'use strict';
  var KEY = 'agentlas.office.token';
  var $ = function (id) { return document.getElementById(id); };
  var token = null;
  var es = null;
  var cards = [];

  // 주소창 조각(#token=…)으로 한 번에 넣을 수 있게 한다. 조각은 서버로
  // 전송되지 않으므로 토큰이 접근 로그에 남지 않는다.
  function fromHash() {
    var m = /token=([^&]+)/.exec(location.hash || '');
    if (!m) return null;
    history.replaceState(null, '', location.pathname + location.search);
    return decodeURIComponent(m[1]);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function api(path, opts) {
    opts = opts || {};
    return fetch(path, {
      method: opts.method || 'GET',
      headers: {
        authorization: 'Bearer ' + token,
        'content-type': 'application/json',
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (b) {
        return { status: r.status, body: b };
      });
    });
  }

  function say(el, text, kind) {
    el.innerHTML = text ? '<div class="msg ' + kind + '">' + esc(text) + '</div>' : '';
  }

  function remain(iso) {
    var ms = new Date(iso).getTime() - Date.now();
    if (!isFinite(ms)) return '';
    if (ms <= 0) return '만료됨';
    var h = Math.floor(ms / 3600000);
    var m = Math.floor((ms % 3600000) / 60000);
    return h > 0 ? h + '시간 ' + m + '분 남음' : m + '분 남음';
  }

  function render() {
    var list = $('list');
    if (!cards.length) {
      list.innerHTML =
        '<div class="empty"><div class="big">대기 중인 승인이 없습니다</div>' +
        '<div>승인이 필요한 작업이 생기면 여기에 바로 나타납니다.</div></div>';
      return;
    }
    list.innerHTML = cards.map(function (c) {
      var isL3 = c.level === 'L3';
      return (
        '<div class="card' + (c.irreversible ? ' irreversible' : '') + '" data-id="' + esc(c.id) + '">' +
          '<div class="row">' +
            '<span class="lvl ' + esc(c.level) + '">' + esc(c.level) + '</span>' +
            (c.irreversible ? '<span class="tag">비가역</span>' : '') +
            '<span class="action mono">' + esc(c.action) + '</span>' +
          '</div>' +
          '<p class="summary">' + esc(c.summary || '(설명 없음)') + '</p>' +
          '<p class="sub">' + esc(remain(c.expiresAt)) + '</p>' +
          '<div class="digest mono"><b>대상</b> ' + esc(c.payloadDigest) + '</div>' +
          (isL3
            ? '<div class="totp"><label for="code-' + esc(c.id) + '">L3 은 인증 코드가 필요합니다</label>' +
              '<input class="code mono" id="code-' + esc(c.id) + '" type="text" inputmode="numeric" ' +
              'autocomplete="one-time-code" maxlength="6" placeholder="000000"></div>'
            : '') +
          '<div class="actions">' +
            '<button class="reject" data-act="reject">거부</button>' +
            '<button class="approve" data-act="approve">승인</button>' +
          '</div>' +
        '</div>'
      );
    }).join('');
  }

  function load() {
    return api('/api/approvals').then(function (r) {
      if (r.status === 401) { lock('토큰이 유효하지 않습니다'); return; }
      cards = (r.body && r.body.pending) || [];
      $('meta').textContent = cards.length ? cards.length + '건 대기' : '대기 없음';
      render();
    });
  }

  function decide(id, act, btn) {
    var card = cards.filter(function (c) { return c.id === id; })[0];
    if (!card) return;
    var body = { digest: card.payloadDigest };
    if (act === 'reject') body.reason = '오너 거부';
    if (card.level === 'L3') {
      var input = $('code-' + id);
      var code = (input && input.value || '').trim();
      if (!code) { say($('msg'), 'L3 승인에는 인증 코드가 필요합니다', 'err'); return; }
      body.stepUp = code;
    }
    btn.disabled = true;
    api('/api/approvals/' + encodeURIComponent(id) + '/' + act, { method: 'POST', body: body })
      .then(function (r) {
        if (r.status === 200) {
          say($('msg'), act === 'approve' ? '승인했습니다' : '거부했습니다', 'ok');
        } else if (r.status === 403) {
          say($('msg'), '인증 코드가 맞지 않습니다', 'err');
        } else if (r.status === 409 && r.body && r.body.reason) {
          say($('msg'), r.body.reason, 'err');
        } else {
          say($('msg'), (r.body && (r.body.error || r.body.reason)) || '처리하지 못했습니다', 'err');
        }
        return load();
      })
      .catch(function () { say($('msg'), '서버에 닿지 못했습니다', 'err'); })
      .then(function () { btn.disabled = false; });
  }

  function stream() {
    if (es) es.close();
    // EventSource 는 헤더를 못 싣는다. 토큰을 질의 문자열로 보낸다 —
    // 서버가 같은 검증기를 쓰고, 연결은 사설망/루프백으로 제한된다.
    es = new EventSource('/api/events?token=' + encodeURIComponent(token));
    es.onopen = function () { $('dot').classList.add('live'); };
    es.onerror = function () { $('dot').classList.remove('live'); };
    es.onmessage = function () { load(); };
  }

  function unlock(t) {
    token = t;
    return api('/api/approvals').then(function (r) {
      if (r.status !== 200) {
        token = null;
        say($('lockmsg'), '토큰이 거부되었습니다', 'err');
        return false;
      }
      localStorage.setItem(KEY, t);
      $('lock').classList.add('hidden');
      $('app').classList.remove('hidden');
      load();
      stream();
      return true;
    }).catch(function () {
      say($('lockmsg'), '서버에 닿지 못했습니다', 'err');
      return false;
    });
  }

  function lock(why) {
    token = null;
    if (es) { es.close(); es = null; }
    localStorage.removeItem(KEY);
    $('app').classList.add('hidden');
    $('lock').classList.remove('hidden');
    if (why) say($('lockmsg'), why, 'err');
  }

  document.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('button[data-act]') : null;
    if (!btn) return;
    var card = btn.closest('.card');
    if (card) decide(card.getAttribute('data-id'), btn.getAttribute('data-act'), btn);
  });

  $('unlock').addEventListener('click', function () {
    var v = $('tok').value.trim();
    if (v) unlock(v);
  });
  $('tok').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') $('unlock').click();
  });
  $('forget').addEventListener('click', function () { lock(null); });
  $('panic').addEventListener('click', function () {
    if (!confirm('모든 능력 스위치를 끕니다. 진행할까요?')) return;
    api('/api/panic', { method: 'POST', body: { reason: '콘솔에서 전체 차단' } }).then(function () {
      say($('msg'), '전체 차단했습니다', 'ok');
    });
  });

  // 남은 시간을 1분마다 다시 그린다.
  setInterval(function () { if (token) render(); }, 60000);

  var t = fromHash() || localStorage.getItem(KEY);
  if (t) unlock(t).then(function (ok) { if (!ok) lock(null); });
  else lock(null);
})();
</script>
</body>
</html>
`;
