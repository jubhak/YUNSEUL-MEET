/**
 * pptx-preview가 echarts를 무조건 import 하므로,
 * 무거운 CDN(~1MB) 대신 빈 스텁을 써서 로딩을 줄입니다.
 * (차트 슬라이드는 빈 영역으로 남을 수 있음)
 */
export function init() {
  return {
    setOption() {},
    resize() {},
    dispose() {},
    clear() {},
    on() {},
    off() {},
  };
}

const api = { init };
export default api;
