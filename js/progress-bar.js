/**
 * ES 모듈 없이 동작하는 전역 프로그레스 바.
 * window.YunseulProgress 로 노출 — 업로드/로딩 어디서든 바로 호출.
 */
(function () {
  'use strict';

  var STYLE_ID = 'yunseul-progress-style';
  var ROOT_ID = 'load-progress';

  var STAGES = {
    idle: { pct: 0, label: '' },
    upload: { pct: 5, label: '업로드 중…' },
    download: { pct: 20, label: '파일 받는 중…' },
    zip: { pct: 30, label: 'ZIP 분석 중…' },
    meta: { pct: 40, label: '슬라이드 정보 읽는 중…' },
    renderer: { pct: 50, label: '렌더러 준비 중…' },
    render: { pct: 55, label: '슬라이드 렌더링 중…' },
    done: { pct: 100, label: '완료' },
    error: { pct: 0, label: '오류' },
  };

  var renderTimer = null;
  var renderPct = 55;
  var hideTimer = null;

  function injectCss() {
    if (document.getElementById(STYLE_ID)) return;
    var css = document.createElement('style');
    css.id = STYLE_ID;
    css.textContent = [
      '#load-progress.ys-progress,',
      '#load-progress.ys-progress * { box-sizing: border-box; }',
      '#load-progress.ys-progress {',
      '  position: fixed !important;',
      '  inset: 0 !important;',
      '  z-index: 99999 !important;',
      '  margin: 0 !important;',
      '  max-width: none !important;',
      '  width: 100% !important;',
      '  height: 100% !important;',
      '  display: none;',
      '  align-items: center;',
      '  justify-content: center;',
      '  background: rgba(8, 10, 18, 0.78);',
      '  backdrop-filter: blur(4px);',
      '  -webkit-backdrop-filter: blur(4px);',
      '  font-family: "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif;',
      '}',
      '#load-progress.ys-progress.ys-on { display: flex !important; }',
      '#load-progress.ys-progress .ys-box {',
      '  width: min(440px, 90vw);',
      '  padding: 1.4rem 1.5rem 1.3rem;',
      '  background: #1a1d27;',
      '  border: 1px solid #2e3345;',
      '  border-radius: 14px;',
      '  box-shadow: 0 16px 48px rgba(0,0,0,0.45);',
      '  color: #e8eaef;',
      '}',
      '#load-progress.ys-progress .ys-title {',
      '  font-size: 1rem;',
      '  font-weight: 650;',
      '  margin: 0 0 0.95rem;',
      '  letter-spacing: -0.01em;',
      '}',
      '#load-progress.ys-progress .ys-track {',
      '  position: relative;',
      '  height: 14px;',
      '  background: #242836;',
      '  border: 1px solid #2e3345;',
      '  border-radius: 999px;',
      '  overflow: hidden;',
      '}',
      '#load-progress.ys-progress .ys-fill {',
      '  height: 100%;',
      '  width: 0%;',
      '  border-radius: 999px;',
      '  background: linear-gradient(90deg, #3d6aef, #2dd4a8);',
      '  transition: width 0.18s ease;',
      '  position: relative;',
      '}',
      '#load-progress.ys-progress .ys-fill::after {',
      '  content: "";',
      '  position: absolute;',
      '  inset: 0;',
      '  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.28), transparent);',
      '  background-size: 200% 100%;',
      '  animation: ys-shimmer 1.2s linear infinite;',
      '}',
      '@keyframes ys-shimmer {',
      '  0% { background-position: 200% 0; }',
      '  100% { background-position: -200% 0; }',
      '}',
      '#load-progress.ys-progress .ys-meta {',
      '  display: flex;',
      '  justify-content: space-between;',
      '  gap: 0.75rem;',
      '  margin-top: 0.7rem;',
      '  font-size: 0.84rem;',
      '  color: #9aa3b5;',
      '}',
      '#load-progress.ys-progress .ys-pct {',
      '  color: #2dd4a8;',
      '  font-variant-numeric: tabular-nums;',
      '  font-weight: 700;',
      '  flex-shrink: 0;',
      '}',
      '#load-progress.ys-progress.ys-error .ys-fill {',
      '  background: linear-gradient(90deg, #ff5c6c, #ff8a5c);',
      '}',
      '#load-progress.ys-progress.ys-error .ys-pct { color: #ff5c6c; }',
    ].join('\n');
    (document.head || document.documentElement).appendChild(css);
  }

  function ensureDom() {
    injectCss();
    var root = document.getElementById(ROOT_ID);
    if (!root) {
      root = document.createElement('div');
      root.id = ROOT_ID;
      (document.body || document.documentElement).appendChild(root);
    }

    // 기존 HTML 마크업이 있어도 통일된 구조로 교체
    if (!root.querySelector('.ys-fill')) {
      root.className = 'ys-progress';
      root.setAttribute('aria-hidden', 'true');
      root.innerHTML =
        '<div class="ys-box">' +
        '  <div class="ys-title">PPT 로딩</div>' +
        '  <div class="ys-track"><div class="ys-fill" id="load-progress-fill"></div></div>' +
        '  <div class="ys-meta">' +
        '    <span class="ys-label" id="load-progress-label">준비 중…</span>' +
        '    <span class="ys-pct" id="load-progress-pct">0%</span>' +
        '  </div>' +
        '</div>';
    } else {
      root.classList.add('ys-progress');
    }

    if (root.parentElement !== document.body && document.body) {
      document.body.appendChild(root);
    }
    return root;
  }

  function els() {
    var root = ensureDom();
    return {
      root: root,
      fill: root.querySelector('.ys-fill') || document.getElementById('load-progress-fill'),
      label: root.querySelector('.ys-label') || document.getElementById('load-progress-label'),
      pct: root.querySelector('.ys-pct') || document.getElementById('load-progress-pct'),
      title: root.querySelector('.ys-title'),
    };
  }

  function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
  }

  function stopRenderPulse() {
    if (renderTimer) {
      clearInterval(renderTimer);
      renderTimer = null;
    }
  }

  function showProgress(title) {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    var e = els();
    e.root.classList.add('ys-on');
    e.root.classList.remove('ys-error');
    e.root.classList.remove('hidden');
    e.root.setAttribute('aria-hidden', 'false');
    if (title && e.title) e.title.textContent = title;
    // 인라인으로도 강제 (캐시된 CSS/충돌 대비)
    e.root.style.cssText =
      'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;' +
      'justify-content:center;background:rgba(8,10,18,0.78);margin:0;width:100%;height:100%;';
  }

  function hideProgress() {
    stopRenderPulse();
    var e = els();
    e.root.classList.remove('ys-on');
    e.root.setAttribute('aria-hidden', 'true');
    e.root.style.display = 'none';
  }

  function setProgress(percent, label) {
    var e = els();
    showProgress();
    var p = clamp(Math.round(Number(percent) || 0), 0, 100);
    if (e.fill) e.fill.style.width = p + '%';
    if (e.pct) e.pct.textContent = p + '%';
    if (e.label && label != null) e.label.textContent = label;
  }

  function setStage(stageKey, extraLabel) {
    var stage = STAGES[stageKey] || STAGES.idle;
    var label = extraLabel || stage.label;
    if (stageKey === 'render') {
      setProgress(renderPct || stage.pct, label);
      startRenderPulse(label);
      return;
    }
    stopRenderPulse();
    if (stageKey === 'done') {
      setProgress(100, label || '완료');
      hideTimer = setTimeout(hideProgress, 450);
      return;
    }
    if (stageKey === 'error') {
      stopRenderPulse();
      var e = els();
      e.root.classList.add('ys-error');
      setProgress(0, label || '오류');
      return;
    }
    setProgress(stage.pct, label);
  }

  function startRenderPulse(baseLabel) {
    stopRenderPulse();
    renderPct = 55;
    var started = Date.now();
    var label = baseLabel || '슬라이드 렌더링 중…';
    renderTimer = setInterval(function () {
      var elapsed = (Date.now() - started) / 1000;
      renderPct = Math.min(92, 55 + 37 * (1 - Math.exp(-elapsed / 22)));
      setProgress(renderPct, label);
    }, 200);
  }

  function progressFromMessage(msg) {
    if (!msg) return;
    if (/업로드/.test(msg)) return setStage('upload', String(msg).split('\n')[0]);
    if (/다운로드|파일 받는|파일 다운|불러오는/.test(msg)) return setStage('download', msg);
    if (/ZIP/.test(msg)) return setStage('zip', msg);
    if (/메타데이터|슬라이드 목록|슬라이드 정보/.test(msg)) return setStage('meta', msg);
    if (/렌더러 준비|라이브러리/.test(msg)) return setStage('renderer', msg);
    if (/렌더링 중|렌더 중/.test(msg)) return setStage('render', msg);
    if (/렌더 완료|화면 정리/.test(msg)) {
      stopRenderPulse();
      return setProgress(95, msg);
    }
    // 발표 중 클릭 추출용 메시지 — 오버레이 금지
    if (msg === '__media_done__') return hideProgress();
    if (/동영상\/음악 준비/.test(msg)) return;
    // PPT 로딩 중 미디어 사전 추출
    if (/미디어 준비/.test(msg)) return setProgress(92, msg);
    if (/오류|실패/.test(msg)) return setStage('error', msg);
    var e = els();
    if (e.label) e.label.textContent = msg;
    showProgress();
  }

  function progressError(message) {
    stopRenderPulse();
    setStage('error', message || '오류가 발생했습니다');
  }

  var api = {
    showProgress: showProgress,
    hideProgress: hideProgress,
    setProgress: setProgress,
    setStage: setStage,
    progressFromMessage: progressFromMessage,
    progressError: progressError,
  };

  window.YunseulProgress = api;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureDom);
  } else {
    ensureDom();
  }
})();
