/** WebRTC ICE — 추후 TURN 추가 지점 */
export const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

/** trackKind: 향후 camera / mic / display 확장 */
export const TRACK_KIND = {
  DISPLAY: 'display',
  CAMERA: 'camera',
  MIC: 'mic',
};
