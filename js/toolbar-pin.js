/**
 * 툴바 표시 보조 — fixed 오버레이 금지.
 * body = column flex, 툴바는 흐름 안(relative)에 두고 본문이 나머지를 채움.
 */
(function () {
  'use strict';

  function pinToolbar() {
    var toolbar = document.getElementById('main-toolbar') || document.querySelector('.toolbar');
    if (!toolbar) return toolbar;

    if (!toolbar.id) toolbar.id = 'main-toolbar';

    if (toolbar.parentElement && toolbar.parentElement.id === 'app') {
      document.body.insertBefore(toolbar, document.body.firstChild);
    } else if (toolbar.parentElement !== document.body) {
      document.body.insertBefore(toolbar, document.body.firstChild);
    }

    toolbar.style.setProperty('position', 'relative', 'important');
    toolbar.style.setProperty('top', 'auto', 'important');
    toolbar.style.setProperty('left', 'auto', 'important');
    toolbar.style.setProperty('right', 'auto', 'important');
    toolbar.style.setProperty('bottom', 'auto', 'important');
    toolbar.style.setProperty('width', '100%', 'important');
    toolbar.style.setProperty('flex', '0 0 auto', 'important');
    toolbar.style.setProperty('z-index', '20', 'important');
    toolbar.style.setProperty('display', 'flex', 'important');
    toolbar.style.setProperty('opacity', '1', 'important');
    toolbar.style.setProperty('visibility', 'visible', 'important');
    toolbar.style.setProperty('pointer-events', 'auto', 'important');
    toolbar.style.setProperty('transform', 'none', 'important');

    return toolbar;
  }

  function showGroup(el) {
    if (!el) return;
    el.style.setProperty('display', 'inline-flex', 'important');
    el.style.setProperty('visibility', 'visible', 'important');
    el.style.setProperty('opacity', '1', 'important');
  }

  function showTools() {
    var toolbar = pinToolbar();
    document.body.classList.add('has-presentation');

    showGroup(document.getElementById('slide-controls'));
    showGroup(document.getElementById('draw-tools'));
    showGroup(document.getElementById('av-tools'));
    var av = document.getElementById('av-tools');
    if (av) {
      av.style.setProperty('display', 'inline-flex', 'important');
      av.style.setProperty('visibility', 'visible', 'important');
      av.style.setProperty('opacity', '1', 'important');
    }
    var reloadBtn = document.getElementById('btn-reload-ppt');
    if (reloadBtn) {
      reloadBtn.style.setProperty('display', '', 'important');
      reloadBtn.style.setProperty('visibility', 'visible', 'important');
    }
    toolbar && toolbar.querySelectorAll('#btn-pen, #btn-av-speaker, #btn-av-mic').forEach(function (btn) {
      btn.style.setProperty('display', 'inline-flex', 'important');
      btn.style.setProperty('visibility', 'visible', 'important');
      btn.style.setProperty('opacity', '1', 'important');
    });

    var groups = toolbar && toolbar.querySelector('.toolbar-groups');
    if (groups) {
      groups.style.setProperty('display', 'flex', 'important');
      groups.style.setProperty('flex-wrap', 'wrap', 'important');
      groups.style.setProperty('width', '100%', 'important');
    }

    toolbar && toolbar.querySelectorAll('.tb-sep').forEach(function (sep) {
      sep.style.setProperty('display', 'block', 'important');
      sep.style.setProperty('visibility', 'visible', 'important');
      sep.style.setProperty('opacity', '1', 'important');
    });

    var room = document.getElementById('room-code');
    if (room && room.parentElement) {
      room.parentElement.style.setProperty('display', 'inline-flex', 'important');
    }
  }

  window.YunseulToolbar = { pin: pinToolbar, showTools: showTools };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', pinToolbar);
  } else {
    pinToolbar();
  }
})();
