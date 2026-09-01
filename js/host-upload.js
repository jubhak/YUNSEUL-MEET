/**
 * ES 모듈과 무관하게 동작하는 업로드 핸들러.
 * 프로그레스는 window.YunseulProgress (progress-bar.js) + 여기 직접 DOM fallback.
 */
(function () {
  'use strict';

  var roomCode = (sessionStorage.getItem('roomCode') || '').toUpperCase();
  var hostToken = sessionStorage.getItem('hostToken');
  var busy = false;

  function apiUrl(path) {
    var base = window.location.href.replace(/[#?].*$/, '').replace(/[^/]*$/, '');
    return base + path;
  }

  function setStatus(msg, isError) {
    var el = document.getElementById('upload-status');
    if (!el) return;
    el.textContent = msg;
    el.style.color = isError ? '#ff5c6c' : '';
    el.style.whiteSpace = 'pre-wrap';
    el.style.wordBreak = 'break-word';
  }

  function formatMb(bytes) {
    return (bytes / 1024 / 1024).toFixed(1) + 'MB';
  }

  /** 프로그레스 — 전역 API 실패해도 직접 오버레이를 그림 */
  function prog() {
    return window.YunseulProgress || null;
  }

  function showUploadProgress(percent, label) {
    var p = prog();
    if (p) {
      if (typeof p.showProgress === 'function') p.showProgress('PPT 업로드');
      if (typeof p.setProgress === 'function') p.setProgress(percent, label);
      return;
    }
    // fallback: 최소한의 오버레이
    var root = document.getElementById('load-progress');
    if (!root) {
      root = document.createElement('div');
      root.id = 'load-progress';
      root.style.cssText =
        'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;' +
        'justify-content:center;background:rgba(8,10,18,0.78);';
      root.innerHTML =
        '<div style="width:min(440px,90vw);padding:1.4rem;background:#1a1d27;border:1px solid #2e3345;border-radius:14px;color:#e8eaef">' +
        '<div style="font-weight:650;margin-bottom:0.9rem">PPT 업로드</div>' +
        '<div style="height:14px;background:#242836;border-radius:999px;overflow:hidden">' +
        '<div id="load-progress-fill" style="height:100%;width:0%;background:linear-gradient(90deg,#3d6aef,#2dd4a8)"></div></div>' +
        '<div style="display:flex;justify-content:space-between;margin-top:0.7rem;font-size:0.84rem;color:#9aa3b5">' +
        '<span id="load-progress-label"></span><span id="load-progress-pct" style="color:#2dd4a8;font-weight:700">0%</span></div></div>';
      document.body.appendChild(root);
    }
    root.style.display = 'flex';
    var fill = document.getElementById('load-progress-fill');
    var lab = document.getElementById('load-progress-label');
    var pct = document.getElementById('load-progress-pct');
    var n = Math.max(0, Math.min(100, Math.round(percent)));
    if (fill) fill.style.width = n + '%';
    if (pct) pct.textContent = n + '%';
    if (lab && label != null) lab.textContent = label;
  }

  function progressError(msg) {
    var p = prog();
    if (p && p.progressError) p.progressError(msg);
    else showUploadProgress(0, msg || '오류');
  }

  function explainServerText(text, status) {
    if (!text) return '서버 응답이 비었습니다. (HTTP ' + status + ')';
    if (/Content-Length|exceeds the limit|post_max_size|upload_max_filesize|POST Content-Length/i.test(text)) {
      return '파일이 PHP 업로드 용량 제한(기본 8MB)을 초과했습니다.\n' +
        'php.ini 에서 upload_max_filesize=100M, post_max_size=110M 으로 올린 뒤 Apache/PHP를 재시작하세요.';
    }
    if (/Warning|Fatal error|Parse error/i.test(text)) {
      var stripped = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      return 'PHP 오류: ' + stripped.slice(0, 240);
    }
    return '서버 응답 오류: ' + text.replace(/<[^>]+>/g, ' ').trim().slice(0, 200);
  }

  function isPptFile(file) {
    if (!file) return false;
    var name = (file.name || '').toLowerCase();
    return name.endsWith('.pptx') || name.endsWith('.ppt') ||
      (file.type || '').indexOf('presentation') >= 0;
  }

  function uploadWithXhr(file, onProgress) {
    return new Promise(function (resolve, reject) {
      var fd = new FormData();
      fd.append('presentation', file);
      fd.append('hostToken', hostToken);
      fd.append('code', roomCode);
      fd.append('slideCount', '1');

      var xhr = new XMLHttpRequest();
      xhr.open('POST', apiUrl('api/upload'));
      xhr.timeout = 180000;

      xhr.upload.onprogress = function (e) {
        if (!e.lengthComputable) {
          onProgress(8, '서버로 올리는 중…');
          return;
        }
        // 업로드는 전체의 0~70% 구간으로 표시
        var ratio = e.loaded / e.total;
        var pct = Math.round(ratio * 70);
        var loaded = formatMb(e.loaded);
        var total = formatMb(e.total);
        onProgress(pct, '업로드 중… ' + loaded + ' / ' + total);
      };

      xhr.upload.onload = function () {
        onProgress(72, '서버 처리 중…');
      };

      xhr.onerror = function () {
        reject(new Error('네트워크 오류로 업로드에 실패했습니다.'));
      };
      xhr.ontimeout = function () {
        reject(new Error('업로드 시간이 너무 길어 중단되었습니다.'));
      };
      xhr.onabort = function () {
        reject(new Error('업로드가 취소되었습니다.'));
      };

      xhr.onload = function () {
        var text = xhr.responseText || '';
        var data = null;
        try {
          data = text ? JSON.parse(text) : {};
        } catch (err) {
          reject(new Error(explainServerText(text, xhr.status)));
          return;
        }
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new Error(data.error || ('HTTP ' + xhr.status)));
          return;
        }
        if (!data.presentation || !data.presentation.url) {
          reject(new Error('업로드 응답에 presentation 정보가 없습니다.'));
          return;
        }
        resolve(data);
      };

      xhr.send(fd);
    });
  }

  function uploadFile(file) {
    if (!file || busy) return;

    if (!roomCode || !hostToken) {
      setStatus('오류: 방 정보가 없습니다. 메인에서 방을 다시 만드세요.', true);
      return;
    }
    if (!isPptFile(file)) {
      setStatus('오류: .pptx 파일만 업로드할 수 있습니다.', true);
      return;
    }
    if ((file.name || '').toLowerCase().endsWith('.ppt') && !(file.name || '').toLowerCase().endsWith('.pptx')) {
      setStatus('오류: .ppt(구버전)은 지원하지 않습니다. .pptx로 저장해 주세요.', true);
      return;
    }
    if (file.size > 100 * 1024 * 1024) {
      setStatus('오류: 파일이 100MB를 초과합니다. (' + formatMb(file.size) + ')', true);
      return;
    }

    busy = true;
    setStatus('로컬에서 PPT 여는 중: ' + file.name + ' (' + formatMb(file.size) + ')…', false);
    showUploadProgress(8, '로컬 파일 읽는 중…');

    file.arrayBuffer()
      .then(function (buffer) {
        var localPresentation = {
          filename: 'local-' + String(file.lastModified || Date.now()) + '-' + String(file.size || 0),
          originalName: file.name || 'presentation.pptx',
          url: '',
          slideCount: 1,
          localOnly: true,
        };
        showUploadProgress(25, '슬라이드 렌더링…');
        setStatus('슬라이드 준비 중…', false);
        window.dispatchEvent(new CustomEvent('ppt-uploaded', {
          detail: {
            presentation: localPresentation,
            buffer: buffer,
          },
        }));

        busy = false;
        var input = document.getElementById('file-input');
        if (input) input.value = '';

        // 서버 업로드는 백그라운드(방 메타·새로고침용) — 렌더를 막지 않음
        uploadWithXhr(file, function () { /* 조용히 */ })
          .then(function (data) {
            window.dispatchEvent(new CustomEvent('ppt-upload-saved', {
              detail: { presentation: data.presentation },
            }));
          })
          .catch(function (err) {
            console.warn('[upload] background save failed', err);
          });
      })
      .catch(function (err) {
        console.error('[upload] local open', err);
        var msg = '오류: ' + (err.message || '파일을 열 수 없습니다');
        setStatus(msg, true);
        progressError(msg);
        var panel = document.getElementById('upload-panel');
        if (panel) panel.classList.remove('hidden');
        busy = false;
        var input = document.getElementById('file-input');
        if (input) input.value = '';
      });
  }

  function pickPptFile() {
    var fileInput = document.getElementById('file-input');
    if (!fileInput) return false;
    if (busy) {
      setStatus('이미 업로드/로딩 중입니다. 잠시만 기다려 주세요.', true);
      return false;
    }
    fileInput.value = '';
    fileInput.click();
    return true;
  }

  window.YunseulUpload = {
    pickPptFile: pickPptFile,
    uploadFile: uploadFile,
    isBusy: function () { return busy; },
  };

  function init() {
    var fileInput = document.getElementById('file-input');
    var uploadBox = document.getElementById('upload-box');
    if (!fileInput || !uploadBox) return;

    setStatus('');

    fileInput.addEventListener('change', function () {
      if (fileInput.files && fileInput.files[0]) {
        uploadFile(fileInput.files[0]);
      }
    });

    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) {
      e.preventDefault();
      // 발표 중에도 PPTX 드롭으로 교체 가능
      if (!document.body.classList.contains('has-presentation')) return;
      if (e.target && e.target.closest && e.target.closest('#upload-box')) return;
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) uploadFile(f);
    });

    uploadBox.addEventListener('dragenter', function (e) {
      e.preventDefault();
      uploadBox.classList.add('drag-over');
    });
    uploadBox.addEventListener('dragover', function (e) {
      e.preventDefault();
      uploadBox.classList.add('drag-over');
    });
    uploadBox.addEventListener('dragleave', function (e) {
      e.preventDefault();
      uploadBox.classList.remove('drag-over');
    });
    uploadBox.addEventListener('drop', function (e) {
      e.preventDefault();
      uploadBox.classList.remove('drag-over');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
        uploadFile(e.dataTransfer.files[0]);
      }
    });

    uploadBox.addEventListener('click', function (e) {
      // 준비 화면에서는 카드 전체 클릭으로 파일 선택하지 않음
      if (uploadBox.classList.contains('ready-box')) return;
      if (e.target.closest('label') || e.target.closest('a') || e.target.closest('button')) return;
      fileInput.click();
    });
  }

  window.addEventListener('ppt-load-error', function (e) {
    setStatus('오류: ' + ((e.detail && e.detail.message) || 'PPT 표시 실패'), true);
    progressError((e.detail && e.detail.message) || 'PPT 표시 실패');
    busy = false;
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
