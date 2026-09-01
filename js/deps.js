/**
 * PPT 렌더러 사전 로드 (가벼운 경로).
 * echarts는 로컬 스텁으로 대체해 ~1MB CDN을 피합니다.
 */
const STATUS = {
  ready: false,
  error: null,
  init: null,
  loading: null,
};

function setUi(msg, isError) {
  // 화면 공유 자동 시작 중에는 PPT 준비 문구를 올리지 않음 (팝업처럼 깜빡임 방지)
  const panel = document.getElementById('upload-panel');
  if (!panel || panel.classList.contains('hidden')) return;
  if (panel.querySelector('.share-prompt-box') && !window.__yunseulShowDepsStatus) return;

  const el = document.getElementById('upload-status') || document.getElementById('sync-status');
  if (!el) return;
  const cur = el.textContent || '';
  if (cur.includes('업로드') || cur.includes('불러오는') || cur.startsWith('오류:')) return;
  el.textContent = msg;
  el.style.color = isError ? 'var(--danger, #ff5c6c)' : '';
}

export async function ensurePptxReady() {
  if (STATUS.ready && STATUS.init) return STATUS.init;
  if (STATUS.loading) return STATUS.loading;
  if (STATUS.error) throw STATUS.error;

      setUi('PPT 라이브러리 준비 중…', false);

  STATUS.loading = (async () => {
    try {
      const mod = await import('pptx-preview');
      if (!mod || typeof mod.init !== 'function') {
        throw new Error('pptx-preview init()이 없습니다.');
      }
      STATUS.init = mod.init;
      STATUS.ready = true;
      STATUS.error = null;
      window.__yunseulPptxInit = mod.init;
      window.__yunseulDepsReady = true;
      setUi('준비 완료', false);
      return mod.init;
    } catch (err) {
      console.warn('[deps]', err);
      const error = new Error(
        'PPT 라이브러리 로드 실패: ' + (err.message || 'unknown') +
        ' — 인터넷에서 esm.sh / jsdelivr 접속이 필요합니다. check.html을 확인하세요.'
      );
      STATUS.error = error;
      window.__yunseulDepsReady = false;
      setUi('오류: ' + error.message, true);
      throw error;
    } finally {
      STATUS.loading = null;
    }
  })();

  return STATUS.loading;
}

// 백그라운드 사전 로드 (업로드 전에 끝내 두기)
ensurePptxReady().catch(() => {});
