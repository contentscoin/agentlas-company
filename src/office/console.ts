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
 *
 * ## 관측 화면 (R10.1~R10.3)
 *
 * 승인 다음으로 원장 타임라인과 실행 상태를 붙였다. 둘 다 **합성하지
 * 않는다** — 원장에 있는 것만 그리고, 진행률처럼 우리가 모르는 값은 만들지
 * 않는다. 실행이 몇 퍼센트 남았는지 아는 방법이 없으므로 막대를 그리지
 * 않고 경과 시간과 증거 건수만 보여 준다.
 *
 * 원장에는 본문이 없고 digest 만 있다 (R9). 화면도 그 사실을 감추지 않는다.
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

  .tabs { display: flex; gap: .35rem; margin-bottom: 1rem; }
  .tab {
    flex: 1; padding: .55rem .4rem; font-size: .88rem;
    background: transparent; border: 1px solid var(--line);
    color: var(--muted); min-height: 40px;
  }
  .tab.on { background: var(--panel); color: var(--ink); border-color: #2f4a44; }
  .badge {
    display: inline-block; min-width: 1.2em; padding: 0 .3em;
    border-radius: 999px; background: #2f4a44; color: var(--accent);
    font-size: .72rem; margin-left: .2rem;
  }
  .badge:empty { display: none; }

  .run { border-left: 3px solid var(--accent); }
  .run .id { font-size: .72rem; color: var(--muted); }
  .kv { display: flex; gap: 1rem; margin-top: .5rem; flex-wrap: wrap; }
  .kv div { font-size: .8rem; color: var(--muted); }
  .kv b { display: block; color: var(--ink); font-weight: 600; font-size: .95rem; }

  .ev {
    display: grid; grid-template-columns: auto 1fr; gap: .6rem;
    padding: .55rem 0; border-bottom: 1px solid var(--line);
    font-size: .85rem;
  }
  .ev:last-child { border-bottom: 0; }
  .ev .when { color: var(--muted); font-size: .74rem; padding-top: .15rem; white-space: nowrap; }
  .ev .kind {
    display: inline-block; font-size: .68rem; font-weight: 700;
    padding: .1rem .35rem; border-radius: 3px; margin-right: .4rem;
    background: #24333a; color: var(--muted); vertical-align: .05em;
  }
  .ev .kind.deny { background: #3a2724; color: var(--danger); }
  .ev .kind.approval { background: #1d4d41; color: #a7ddcb; }
  .ev .kind.publish { background: #24333a; color: var(--accent); }
  .ev .kind.tainted { background: #3a3324; color: var(--warn); }
  .ev .who { color: var(--muted); font-size: .74rem; }

  h3 { font-size: .82rem; letter-spacing: .06em; text-transform: uppercase;
       color: var(--muted); margin: 1.4rem 0 .6rem; font-weight: 700; }
  h3:first-child { margin-top: 0; }

  table.m { width: 100%; border-collapse: collapse; font-size: .87rem; }
  table.m th {
    text-align: right; font-weight: 600; color: var(--muted);
    font-size: .72rem; padding: 0 0 .35rem; border-bottom: 1px solid var(--line);
  }
  table.m th:first-child { text-align: left; }
  table.m td { padding: .4rem 0; border-bottom: 1px solid var(--line); text-align: right; }
  table.m td:first-child { text-align: left; }
  table.m tr:last-child td { border-bottom: 0; }
  .miss { color: var(--muted); }
  .off { color: var(--warn); }
  .fail { color: var(--danger); }
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
      <h1 id="title">승인</h1>
      <span class="meta" id="meta">—</span>
    </header>

    <nav class="tabs" role="tablist">
      <button role="tab" class="tab on" data-view="approvals">승인 <span class="badge" id="b-appr"></span></button>
      <button role="tab" class="tab" data-view="warrooms">War Room <span class="badge" id="b-war"></span></button>
      <button role="tab" class="tab" data-view="runs">실행 <span class="badge" id="b-runs"></span></button>
      <button role="tab" class="tab" data-view="measure">측정</button>
      <button role="tab" class="tab" data-view="ledger">원장</button>
    </nav>

    <div id="msg"></div>
    <div id="list"></div>
    <div id="warrooms" class="hidden"></div>
    <div id="runs" class="hidden"></div>
    <div id="measure" class="hidden"></div>
    <div id="ledger" class="hidden"></div>
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
  var runs = [];
  var events = [];      // 최신 우선
  var lastSeq = 0;
  var view = 'approvals';
  var measure = null;   // null = 아직 안 읽음
  var warrooms = null;  // null = 아직 안 읽음. 배지를 채우려고 처음에 한 번 읽는다
  var MAX_EVENTS = 300; // 폰에서 무한히 쌓지 않는다

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

  function fmtElapsed(ms) {
    if (!isFinite(ms) || ms < 0) return '—';
    var s = Math.floor(ms / 1000);
    if (s < 60) return s + '초';
    var m = Math.floor(s / 60);
    if (m < 60) return m + '분';
    return Math.floor(m / 60) + '시간 ' + (m % 60) + '분';
  }

  function clock(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function renderRuns() {
    var el = $('runs');
    if (!runs.length) {
      el.innerHTML =
        '<div class="empty"><div class="big">진행 중인 실행이 없습니다</div>' +
        '<div>원장에 시작 기록이 있고 끝 기록이 없는 실행만 여기 나옵니다.</div></div>';
      return;
    }
    el.innerHTML = runs.map(function (r) {
      return (
        '<div class="card run">' +
          '<div class="row">' +
            '<span class="action">' + esc(r.task || '(작업명 없음)') + '</span>' +
            (r.tainted ? '<span class="tag">오염</span>' : '') +
          '</div>' +
          '<p class="id mono">' + esc(r.runId) + '</p>' +
          '<div class="kv">' +
            '<div>경과<b>' + esc(fmtElapsed(r.elapsedMs)) + '</b></div>' +
            '<div>증거<b>' + esc(String(r.evidenceCount)) + '건</b></div>' +
            '<div>주체<b>' + esc(r.seat || (r.actor && r.actor.id) || '—') + '</b></div>' +
          '</div>' +
        '</div>'
      );
    }).join('') +
    '<p class="sub">진행률은 표시하지 않습니다 — 남은 분량을 아는 방법이 없습니다.</p>';
  }

  function renderLedger() {
    var el = $('ledger');
    if (!events.length) {
      el.innerHTML = '<div class="empty"><div class="big">기록이 없습니다</div></div>';
      return;
    }
    el.innerHTML =
      '<div class="card">' +
      events.map(function (e) {
        var k = String(e.kind || '');
        // deny 만 붉게 칠한다. gate.verdict 는 PASS 도 FAIL 도 내므로
        // 종류만 보고 색을 정하면 통과를 실패로 읽게 된다 — 실제로 그렇게 보였다.
        var cls = k.indexOf('deny') === 0 ? 'deny'
          : k.indexOf('approval') === 0 ? 'approval'
          : k.indexOf('publish') === 0 ? 'publish' : '';
        return (
          '<div class="ev">' +
            '<span class="when mono">' + esc(clock(e.at)) + '</span>' +
            '<div>' +
              '<span class="kind ' + cls + '">' + esc(k) + '</span>' +
              (e.tainted ? '<span class="kind tainted">오염</span>' : '') +
              esc(e.summary || '(요약 없음)') +
              '<div class="who mono">#' + esc(String(e.seq)) + ' · ' +
                esc((e.actor && e.actor.id) || '?') +
                (e.level ? ' · ' + esc(e.level) : '') + '</div>' +
            '</div>' +
          '</div>'
        );
      }).join('') +
      '</div>' +
      '<p class="sub">원장에는 본문이 없습니다. 남는 것은 요약과 digest 뿐입니다.</p>';
  }

  /** 지표 한 건. 값은 있고, 못 잰 것은 0 이 아니라 "못 잼" 으로 적는다. */
  function collectionCard(c) {
    if (!c.ok) {
      return (
        '<div class="card">' +
          '<div class="row"><span class="action mono">' + esc(c.channel) + '</span>' +
          '<span class="tag">수집 실패</span></div>' +
          '<p class="summary fail">' + esc(c.detail) + '</p>' +
          '<p class="sub">' + esc(clock(c.at)) + ' · ' + esc(c.window.from) + ' ~ ' + esc(c.window.to) + '</p>' +
        '</div>'
      );
    }
    var keys = Object.keys(c.aggregate || {});
    var rows = keys.map(function (k) {
      return '<tr><td class="mono">' + esc(k) + '</td><td class="mono">' +
        esc(String(c.aggregate[k])) + '</td></tr>';
    }).join('');
    var missing = (c.uncollected || []).map(function (k) {
      return '<tr><td class="mono miss">' + esc(k) + '</td><td class="miss">못 잼</td></tr>';
    }).join('');
    return (
      '<div class="card">' +
        '<div class="row"><span class="action mono">' + esc(c.channel) + '</span></div>' +
        '<p class="sub">' + esc(clock(c.at)) + ' · ' + esc(c.window.from) + ' ~ ' + esc(c.window.to) + '</p>' +
        (keys.length || missing
          ? '<table class="m">' + rows + missing + '</table>'
          : '<p class="summary miss">수집된 지표 없음</p>') +
        ((c.dropped || []).length
          ? '<div class="digest"><b>경계에서 차단</b> ' + esc(c.dropped.join(', ')) +
            ' — 이름만 남습니다. 값은 좌석으로 넘어가지 않았습니다</div>'
          : '') +
      '</div>'
    );
  }

  function retroCard(r) {
    var rows = (r.gaps || []).map(function (g) {
      var actual = g.actual === null ? '<span class="miss">못 잼</span>' : esc(String(g.actual));
      var ratio = g.ratio === null ? '<span class="miss">—</span>'
        : '<span class="' + (g.ratio < 0.5 || g.ratio > 2 ? 'off' : '') + '">' +
          Math.round(g.ratio * 100) + '%</span>';
      return '<tr><td class="mono">' + esc(g.metric) + '</td><td class="mono">' +
        esc(String(g.expected)) + '</td><td class="mono">' + actual + '</td><td class="mono">' + ratio + '</td></tr>';
    }).join('');
    return (
      '<div class="card">' +
        '<div class="row"><span class="action">' + esc(r.subject) + '</span>' +
          (r.uncollected && r.uncollected.length
            ? '<span class="tag">미수집 ' + r.uncollected.length + '</span>' : '') +
        '</div>' +
        '<p class="sub">' + esc(clock(r.at)) + '</p>' +
        '<table class="m"><tr><th>지표</th><th>예측</th><th>실제</th><th>비율</th></tr>' + rows + '</table>' +
        (r.amendments || []).map(function (a) {
          return '<p class="sub">' + esc(a) + '</p>';
        }).join('') +
        (r.editCount
          ? '<div class="digest"><b>레시피 편집 제안 ' + r.editCount + '건</b> — ' +
            'company retro 로 diff 를 받아 적용은 직접 하세요</div>'
          : '') +
      '</div>'
    );
  }

  function renderMeasure() {
    var el = $('measure');
    if (measure === null) { el.innerHTML = '<div class="empty">읽는 중…</div>'; return; }
    if (!measure.configured) {
      el.innerHTML =
        '<div class="empty"><div class="big">측정 기록이 켜져 있지 않습니다</div>' +
        '<div>기록 없이도 수집은 됩니다. 다만 지난 값을 여기서 볼 수 없습니다.</div></div>';
      return;
    }
    var latest = measure.latest || [];
    var retros = measure.retros || [];
    var html = '<h3>채널별 최근 수집</h3>';
    html += latest.length
      ? latest.map(collectionCard).join('')
      : '<div class="empty"><div class="big">수집 기록이 없습니다</div>' +
        '<div>아직 지표를 한 번도 읽지 않았습니다.</div></div>';
    html += '<h3>복기</h3>';
    html += retros.length
      ? retros.map(retroCard).join('')
      : '<div class="empty"><div class="big">복기 기록이 없습니다</div>' +
        '<div>예측을 등록한 실행이 복기되면 여기 쌓입니다.</div></div>';
    html += '<p class="sub">값은 집계값입니다. 원본 레코드는 좌석으로도 여기로도 넘어오지 않습니다.</p>';
    el.innerHTML = html;
  }

  function loadMeasure() {
    return api('/api/measurements').then(function (r) {
      if (r.status !== 200) return;
      measure = r.body || { configured: false };
      if (view === 'measure') renderMeasure();
    });
  }

  /**
   * War Room 은 오너만 닫는다 (R3.7). 화면은 그 사실을 숨기지 않는다 —
   * 인증 코드와 종결 사유를 둘 다 받는다. 사유 없는 종결은 목록에서
   * 지우는 것과 같아서, 나중에 "왜 괜찮다고 판단했나" 에 답할 기록이 없다.
   */
  function warRoomCard(r) {
    var why = r.cause === 'critic-block' ? 'Critic BLOCK' : '동일 과제 반복 실패';
    return (
      '<div class="card irreversible" data-war="' + esc(r.id) + '">' +
        '<div class="row">' +
          '<span class="lvl L3">L3</span>' +
          '<span class="tag">' + esc(why) + '</span>' +
          '<span class="action mono">' + esc(r.id) + '</span>' +
        '</div>' +
        '<p class="summary">' + esc(r.subject || '(제목 없음)') + '</p>' +
        '<p class="sub">' + esc(r.reason) + '</p>' +
        '<p class="sub mono">소집 ' + esc(r.openedAt) + ' · run ' + esc(r.runId) + '</p>' +
        '<input id="wres-' + esc(r.id) + '" placeholder="종결 사유 — 무엇을 확인했는지" autocomplete="off">' +
        '<input id="wcode-' + esc(r.id) + '" placeholder="인증 코드 6자리" inputmode="numeric" autocomplete="one-time-code">' +
        '<div class="acts">' +
          '<button class="approve" data-close="' + esc(r.id) + '">종결</button>' +
        '</div>' +
      '</div>'
    );
  }

  function closedCard(r) {
    return (
      '<div class="card">' +
        '<p class="summary">' + esc(r.subject || '(제목 없음)') + '</p>' +
        '<p class="sub">' + esc(r.resolution) + '</p>' +
        '<p class="sub mono">' + esc(r.closedAt) + ' · ' + esc(r.closedBy) + '</p>' +
      '</div>'
    );
  }

  function renderWarRooms() {
    var el = $('warrooms');
    if (warrooms === null) { el.innerHTML = '<div class="empty">읽는 중…</div>'; return; }
    // 장부가 없는 것과 열린 방이 없는 것은 다른 사실이다. 섞지 않는다.
    if (!warrooms.configured) {
      el.innerHTML =
        '<div class="empty"><div class="big">War Room 장부가 붙어 있지 않습니다</div>' +
        '<div>소집이 일어나도 여기 남지 않습니다. 이상 없다는 뜻이 아닙니다.</div></div>';
      return;
    }
    var open = warrooms.open || [];
    var recent = warrooms.recent || [];
    var html = open.length
      ? open.map(warRoomCard).join('')
      : '<div class="empty"><div class="big">열린 War Room 이 없습니다</div>' +
        '<div>Critic 이 BLOCK 하거나 같은 과제가 두 번 실패하면 여기 열립니다.</div></div>';
    if (recent.length) {
      html += '<h3>최근 종결</h3>' + recent.map(closedCard).join('');
    }
    el.innerHTML = html;
  }

  function loadWarRooms() {
    return api('/api/warrooms').then(function (r) {
      if (r.status !== 200) return;
      warrooms = r.body || { configured: false };
      if (view === 'warrooms') renderWarRooms(); else paint();
    });
  }

  function closeWarRoom(id, btn) {
    var res = ($('wres-' + id) && $('wres-' + id).value || '').trim();
    var code = ($('wcode-' + id) && $('wcode-' + id).value || '').trim();
    if (!res) { say($('msg'), '종결 사유를 적어 주세요', 'err'); return; }
    if (!code) { say($('msg'), 'War Room 종결에는 인증 코드가 필요합니다', 'err'); return; }
    btn.disabled = true;
    api('/api/warrooms/' + encodeURIComponent(id) + '/close', {
      method: 'POST',
      body: { resolution: res, stepUp: code },
    })
      .then(function (r) {
        if (r.status === 200) say($('msg'), '종결했습니다', 'ok');
        else if (r.status === 403) say($('msg'), '인증 코드가 맞지 않습니다', 'err');
        else if (r.status === 409 && r.body && r.body.reason) say($('msg'), r.body.reason, 'err');
        else say($('msg'), (r.body && r.body.error) || '처리하지 못했습니다', 'err');
        return loadWarRooms();
      })
      .catch(function () { say($('msg'), '서버에 닿지 못했습니다', 'err'); })
      .then(function () { btn.disabled = false; });
  }

  function paint() {
    $('b-appr').textContent = cards.length ? String(cards.length) : '';
    $('b-runs').textContent = runs.length ? String(runs.length) : '';
    var openWar = warrooms && warrooms.open ? warrooms.open.length : 0;
    $('b-war').textContent = openWar ? String(openWar) : '';
    var meta = $('meta');
    if (view === 'approvals') {
      $('title').textContent = '승인';
      meta.textContent = cards.length ? cards.length + '건 대기' : '대기 없음';
      render();
    } else if (view === 'warrooms') {
      $('title').textContent = 'War Room';
      meta.textContent = warrooms && !warrooms.configured
        ? '장부 없음'
        : (openWar ? openWar + '건 열림' : '열린 방 없음');
      renderWarRooms();
    } else if (view === 'runs') {
      $('title').textContent = '실행';
      meta.textContent = runs.length ? runs.length + '건 진행 중' : '진행 중 없음';
      renderRuns();
    } else if (view === 'measure') {
      $('title').textContent = '측정';
      var n = measure && measure.latest ? measure.latest.length : 0;
      meta.textContent = n ? n + '개 채널' : '기록 없음';
      renderMeasure();
    } else {
      $('title').textContent = '원장';
      meta.textContent = lastSeq ? '#' + lastSeq + ' 까지' : '기록 없음';
      renderLedger();
    }
  }

  function switchTo(next) {
    view = next;
    if (next === 'measure' && measure === null) loadMeasure();
    if (next === 'warrooms' && warrooms === null) loadWarRooms();
    ['approvals', 'warrooms', 'runs', 'measure', 'ledger'].forEach(function (v) {
      var pane = $(v === 'approvals' ? 'list' : v);
      pane.classList.toggle('hidden', v !== next);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      t.classList.toggle('on', t.getAttribute('data-view') === next);
    });
    paint();
  }

  function loadState() {
    return api('/api/state').then(function (r) {
      if (r.status !== 200) return;
      runs = (r.body && r.body.running) || [];
      paint();
    });
  }

  /** SSE 로 받은 이벤트를 앞에 붙인다. seq 로 중복을 막는다. */
  function absorb(e) {
    if (!e || typeof e.seq !== 'number') return;
    if (events.length && events[0].seq >= e.seq) {
      if (events.some(function (x) { return x.seq === e.seq; })) return;
    }
    events.unshift(e);
    if (e.seq > lastSeq) lastSeq = e.seq;
    if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
  }

  function load() {
    return api('/api/approvals').then(function (r) {
      if (r.status === 401) { lock('토큰이 유효하지 않습니다'); return; }
      cards = (r.body && r.body.pending) || [];
      paint();
      return loadState()
        // 배지에 열린 방 수를 띄우려면 탭에 들어가기 전에 한 번 읽어야 한다.
        // 열려 있는데 안 보이면 오너가 그것을 모른다 — 그게 이 결함이었다.
        .then(loadWarRooms)
        .then(function () {
          // 수집·복기는 원장에 흔적을 남긴다. 원장이 움직였으면 측정도 다시 읽는다.
          if (measure !== null) return loadMeasure();
          return undefined;
        });
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
    es.onmessage = function (ev) {
      try { absorb(JSON.parse(ev.data)); } catch (_) { /* 못 읽은 줄은 버린다 */ }
      // 원장이 움직였다는 것은 승인·실행도 움직였을 수 있다는 뜻이다.
      load();
    };
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
    if (!e.target.closest) return;
    var war = e.target.closest('button[data-close]');
    if (war) { closeWarRoom(war.getAttribute('data-close'), war); return; }
    var btn = e.target.closest('button[data-act]');
    if (!btn) return;
    var card = btn.closest('.card');
    if (card) decide(card.getAttribute('data-id'), btn.getAttribute('data-act'), btn);
  });

  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
    t.addEventListener('click', function () { switchTo(t.getAttribute('data-view')); });
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
  setInterval(function () { if (token) paint(); }, 60000);

  var t = fromHash() || localStorage.getItem(KEY);
  if (t) unlock(t).then(function (ok) { if (!ok) lock(null); });
  else lock(null);
})();
</script>
</body>
</html>
`;
