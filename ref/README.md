# WebRTC SFU Reference Repositories & Architecture Guide

이 디렉터리(`ref/`)는 Mediasoup 공식 오픈소스 레퍼런스 프로젝트 및 안정성 구현 사례를 비교·분석하고 동기화하여 서비스의 비디오 스트리밍을 안정화하기 위한 참조 저장소입니다.

---

## 1. 동기화된 공식 레퍼런스 저장소

### `ref/mediasoup-demo`
- **저장소**: [versatica/mediasoup-demo](https://github.com/versatica/mediasoup-demo) (공식 Mediasoup v3 저자 Inaki Baz Castillo & Jose Luis Millan 개발)
- **동기화 일자**: 2026-09-26
- **주요 참조 위치**:
  - `server/src/Peer.ts`: 서버 측 WebRTC Transport, Producer, Consumer 생성 및 제어 로직
  - `server/config.example.mjs`: 공식 WebRtcTransportOptions, Router MediaCodecs, BWE 대역폭 최적화 설정
  - `app/src/RoomClient.js`: 클라이언트 측 mediasoup-client 송수신 파이프라인, contentHint, RTX 및 지연 최적화

---

## 2. 레퍼런스 분석을 통한 핵심 안정화 적용 내역

### 1) RFC 4588 RTX 패킷 재전송 활성화 (`enableRtx: true`)
- **레퍼런스 코드** (`ref/mediasoup-demo/server/src/Peer.ts` L328-331):
  ```typescript
  consumer = await transport.consume({
    producerId: producer.id,
    rtpCapabilities: this.#rtpCapabilities!,
    enableRtx: true, // Enable NACK for video and OPUS audio
    paused: true,
    ignoreDtx: true,
  });
  ```
- **개선 효과**: 패킷 손실 시 NACK를 통한 RTX 고속 재전송을 활성화하여 비디오 디코더가 프레임을 기다리다 멈추는(Freeze) 현상 완벽 방지.

### 2) WebRtcTransport 대역폭 파라미터 표준화
- **레퍼런스 코드** (`ref/mediasoup-demo/server/config.example.mjs` L158-166):
  - `initialAvailableOutgoingBitrate: 1000000` (1 Mbps 초기 대역폭으로 빠른 초기 접속 보장)
  - `minimumAvailableOutgoingBitrate: 300000` (최소 300 kbps 하한 보장으로 모바일 무선 혼잡 시 붕괴 방지)

### 3) 정지 슬라이드 0-FPS 프리즈 방지 (`contentHint: 'motion'`)
- **레퍼런스 코드** (`ref/mediasoup-demo/app/src/RoomClient.js` L1250, L1617):
  - `track.contentHint = 'motion'` 및 `degradationPreference = 'maintain-framerate'`
  - 크로미움 브라우저가 화면 변화가 없을 때 프레임레이트를 0으로 떨어뜨려 발생하는 UDP NAT 타임아웃 및 화면 멈춤 원천 방지.

### 4) 백그라운드 탭 렌더링 하이브리드 하트비트
- 브라우저가 탭 비활성화 시 `requestAnimationFrame`을 중단하여 웹캠/아바타 영상이 멈추는 문제를 방지하기 위해 50ms 주기 하이브리드 하트비트 타이머 탑재.
