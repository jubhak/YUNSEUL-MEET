/**
 * 툴바를 body 직속으로 올리고 항상 보이게 고정.
 * 슬라이드 transform/overflow 때문에 가려지는 문제 방지.
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

    toolbar.style.setProperty('position', 'fixed', 'important');
    toolbar.style.setProperty('top', '0', 'important');
    toolbar.style.setProperty('left', '0', 'important');
    toolbar.style.setProperty('right', '0', 'important');
    toolbar.style.setProperty('width', '100%', 'important');
    toolbar.style.setProperty('z-index', '9000', 'important');
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
      room.parentElement.style.setProperty('visibility', 'visible', 'important');
      room.parentElement.style.setProperty('opacity', '1', 'important');
    }
    return toolbar;
  }

  window.YunseulToolbar = { pin: pinToolbar, showTools: showTools };

  function boot() {
    pinToolbar();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.addEventListener('ppt-ready', function () {
    showTools();
    document.body.classList.add('has-presentation');
  });
})();
