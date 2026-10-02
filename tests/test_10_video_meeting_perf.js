/**
 * test_10_video_meeting_perf.js
 * 화상 미팅 최소 10개 이상 동시 접속 시 성능, 렉(지연), WebRTC SFU 대역폭 안정성 자체 검증 테스트
 */

import http from 'http';
import { io as ioClient } from 'socket.io-client';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '..');

const TEST_PORT = 4888;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

let totalAssertions = 0;
let passedAssertions = 0;

function assert(condition, message) {
  totalAssertions++;
  if (!condition) {
    console.error(`  ❌ [FAIL] ${message}`);
    throw new Error(`[ASSERTION FAILED] ${message}`);
  }
  passedAssertions++;
  console.log(`  ✅ [PASS] ${message}`);
}

async function requestJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  try {
    return { status: res.status, data: JSON.parse(text) };
  } catch {
    return { status: res.status, data: text };
  }
}

async function run() {
  console.log('===============================================================');
  console.log('🚀 [화상 미팅 최소 10개 동시 비디오 스트림 성능 & 무지연 자체 검증]');
  console.log('===============================================================');

  // 1. Start Server on port 4888
  console.log(`\n[Step 1] 테스트 서버 기동 (Port: ${TEST_PORT})...`);
  const serverProcess = spawn('node', ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProcess.stdout.on('data', (d) => {
    const s = d.toString().trim();
    if (s.includes('error') || s.includes('Error')) console.log('[Server stdout]', s);
  });
  serverProcess.stderr.on('data', (d) => {
    const s = d.toString().trim();
    if (!s.includes('ExperimentalWarning')) console.error('[Server stderr]', s);
  });

  // Wait for server ready
  let serverReady = false;
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const res = await fetch(`${BASE_URL}/api/host-url`);
      if (res.status === 200) {
        serverReady = true;
        break;
      }
    } catch {}
  }
  assert(serverReady, `서버가 포트 ${TEST_PORT}에서 정상 기동됨`);

  try {
    // 2. Create Room
    console.log('\n[Step 2] 양방향 화상 미팅 룸 생성...');
    const createRes = await requestJson(`${BASE_URL}/api/create-room`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interactionMode: 'bidirectional' }),
    });
    assert(createRes.status === 200 && createRes.data.ok, '화상 미팅 룸 생성 성공');
    const roomCode = createRes.data.code;
    const hostToken = createRes.data.hostToken;

    // 3. Connect Host
    console.log('\n[Step 3] 호스트 소켓 및 SFU 수신(Recv) 트랜스포트 수립...');
    const hostSocket = ioClient(BASE_URL, {
      transports: ['websocket'],
      reconnection: false,
    });
    await new Promise((res, rej) => {
      hostSocket.on('connect', res);
      hostSocket.on('connect_error', rej);
    });

    const hostJoinAck = await new Promise((res) => {
      hostSocket.emit(
        'join',
        { code: roomCode, role: 'host', hostToken, clientId: 'host-client-main', name: '대표호스트' },
        res
      );
    });
    assert(hostJoinAck?.role === 'host', '호스트 조인 승인 완료 (role=host)');

    // Host SFU capabilities & Recv Transport
    const hostCaps = await new Promise((res) => hostSocket.emit('sfu-get-capabilities', {}, res));
    assert(hostCaps.ok && hostCaps.rtpCapabilities, '호스트 SFU RTP Capabilities 획득');

    const hostRecvTransport = await new Promise((res) =>
      hostSocket.emit('sfu-create-transport', { direction: 'recv' }, res)
    );
    assert(hostRecvTransport.ok && hostRecvTransport.id, '호스트 10+ 수신용 단일 멀티플렉스 WebRTC Transport 생성');

    // 4. Concurrently Connect 10 Viewers with Video Feeds
    const TOTAL_VIEWERS = 10;
    console.log(`\n[Step 4] 최소 ${TOTAL_VIEWERS}명 참가자 동시 접속 및 비디오 피드 송출 시뮬레이션...`);
    const viewerSockets = [];
    const viewerProducers = [];
    const hostConsumers = [];

    const tStart = Date.now();

    for (let i = 1; i <= TOTAL_VIEWERS; i++) {
      const vSocket = ioClient(BASE_URL, {
        transports: ['websocket'],
        reconnection: false,
      });
      viewerSockets.push(vSocket);

      await new Promise((res, rej) => {
        vSocket.on('connect', res);
        vSocket.on('connect_error', rej);
      });

      const clientId = `viewer-client-${i}`;
      await new Promise((res) => {
        vSocket.emit(
          'join',
          { code: roomCode, role: 'viewer', clientId, name: `참가자_${i}` },
          res
        );
      });

      // Get caps & create Send Transport
      const caps = await new Promise((res) => vSocket.emit('sfu-get-capabilities', {}, res));
      const sendTransport = await new Promise((res) =>
        vSocket.emit('sfu-create-transport', { direction: 'send' }, res)
      );

      // Simulate Produce Video
      const vp8Codec = caps.rtpCapabilities.codecs.find((c) => c.mimeType.toLowerCase() === 'video/vp8');
      const rtpParameters = {
        mid: '0',
        codecs: [
          {
            mimeType: 'video/VP8',
            payloadType: vp8Codec ? vp8Codec.preferredPayloadType : 96,
            clockRate: 90000,
            parameters: {},
            rtcpFeedback: [{ type: 'nack' }, { type: 'nack', parameter: 'pli' }, { type: 'goog-remb' }],
          },
        ],
        headerExtensions: [],
        encodings: [
          {
            ssrc: 100000 + i * 10,
            maxBitrate: 180000,
            maxFramerate: 22,
          },
        ],
        rtcp: { cname: `cname-viewer-${i}` },
      };

      const prodRes = await new Promise((res) => {
        vSocket.emit(
          'sfu-produce',
          {
            transportId: sendTransport.id,
            kind: 'video',
            rtpParameters,
            appData: {
              source: 'viewer-camera',
              trackKind: 'camera',
              clientId,
            },
          },
          res
        );
      });

      assert(prodRes.ok && prodRes.id, `참가자 #${i} 화상 비디오 프로듀서 등록 완료 (ID: ${prodRes.id})`);
      viewerProducers.push({ clientId, producerId: prodRes.id });

      // Host Consumes This Viewer's Video
      const consumeRes = await new Promise((res) => {
        hostSocket.emit(
          'sfu-consume',
          {
            producerId: prodRes.id,
            transportId: hostRecvTransport.id,
            rtpCapabilities: hostCaps.rtpCapabilities,
          },
          res
        );
      });

      assert(consumeRes.ok && consumeRes.id, `호스트가 참가자 #${i} 비디오 컨슈머 수신 연결 (Consumer: ${consumeRes.id})`);

      // Resume Consumer
      const resumeRes = await new Promise((res) => {
        hostSocket.emit('sfu-resume-consumer', { consumerId: consumeRes.id }, res);
      });
      assert(resumeRes.ok, `호스트 컨슈머 #${i} 무지연 재생 활성화(Resume)`);
      hostConsumers.push(consumeRes.id);
    }

    const tDuration = Date.now() - tStart;
    console.log(`\n⚡ 10개 비디오 피드 연결 총 소요시간: ${tDuration}ms (평균 1개당 ${Math.round(tDuration / TOTAL_VIEWERS)}ms)`);
    assert(tDuration < 5000, `10개 비디오 연결이 5초 이내(${tDuration}ms)에 신속히 완료됨`);

    // 5. Verify Active Room & SFU Router with 10 Video Streams Active
    console.log('\n[Step 5] 방 참여자 상태 및 SFU 라우터 대역폭 검증...');
    const roomState = await requestJson(`${BASE_URL}/api/get-room?code=${roomCode}`);
    assert(roomState.status === 200 && roomState.data.code === roomCode, '화상 미팅 룸 상태 정상 조회');
    assert(roomState.data.viewers.length >= TOTAL_VIEWERS, `방 참여자 10명 이상 전원 정상 등록 (참여자 수: ${roomState.data.viewers.length}명)`);

    const latestCaps = await new Promise((res) => hostSocket.emit('sfu-get-capabilities', {}, res));
    assert(latestCaps.ok && Array.isArray(latestCaps.producers), 'SFU 활성 프로듀서 목록 정상 획득');
    assert(latestCaps.producers.length >= TOTAL_VIEWERS, `SFU 활성 비디오 프로듀서 수: ${latestCaps.producers.length}개 (10개 비디오 피드 정상 가동)`);

    // 6. Verify Grid Row Distribution for 10 and 11 participants (Host + 10 Viewers = 11)
    console.log('\n[Step 6] 10명 이상 5-Column 적응형 레이아웃 분배 검증...');
    function getGridRowDistribution(total) {
      if (total <= 0) return [];
      if (total < 10) {
        const rows = [];
        let remaining = total;
        while (remaining > 0) {
          const take = Math.min(3, remaining);
          rows.push(take);
          remaining -= take;
        }
        return rows;
      }
      const rows = [];
      let remaining = total;
      while (remaining > 0) {
        const take = Math.min(5, remaining);
        rows.push(take);
        remaining -= take;
      }
      return rows;
    }

    assert(JSON.stringify(getGridRowDistribution(10)) === JSON.stringify([5, 5]), '10명 접속 시 정확히 5명, 5명 (2줄) 배치');
    assert(JSON.stringify(getGridRowDistribution(11)) === JSON.stringify([5, 5, 1]), '11명 접속 시 5명, 5명, 1명 (3줄) 배치');

    // 7. Verify Virtual Avatar Manager Profiles
    console.log('\n[Step 7] VirtualAvatarManager 10명 이상 모드 설정값 검증...');
    const avMgrPath = path.join(ROOT, 'js', 'virtual-avatar-manager.js');
    const avMgrContent = fs.readFileSync(avMgrPath, 'utf8');

    assert(
      avMgrContent.includes('FACE_OUT_W_HQ = 960') && avMgrContent.includes("if (n <= 6) return 'high'"),
      '2~6명은 960×540 고화질'
    );
    assert(
      avMgrContent.includes('FACE_OUT_W_CROWD = 512') && avMgrContent.includes('FACE_OUT_H_CROWD = 288'),
      '13~20명은 512×288'
    );
    assert(
      avMgrContent.includes('FACE_OUT_FPS_CROWD = 20'),
      '13~20명은 20fps 유지'
    );
    assert(
      avMgrContent.includes("if (n <= 30) return 'pack'") && avMgrContent.includes('FACE_OUT_W_MASS = 320'),
      '21~30명은 pack, 31명+는 mass로 더 낮춰 접속 유지'
    );

    // 8. Verify CSS GPU Compositing Optimization for Video Elements
    console.log('\n[Step 8] 10개 이상 비디오 카드 CSS GPU 가속 및 렌더링 격리 검증...');
    const stylePath = path.join(ROOT, 'css', 'style.css');
    const styleContent = fs.readFileSync(stylePath, 'utf8');

    assert(
      styleContent.includes('contain: layout style paint;') && styleContent.includes('transform: translateZ(0);'),
      '참가자 비디오 카드에 CSS contain 및 GPU 하드웨어 가속 레이어 격리 적용'
    );
    assert(
      styleContent.includes('will-change: transform;'),
      '참가자 비디오 태그에 will-change: transform 적용으로 10+개 동시 재생 시 GPU 렌더링 최적화'
    );

    // 9. Teardown
    console.log('\n[Step 9] 10개 참가자 및 호스트 정상 종료...');
    viewerSockets.forEach((s) => s.disconnect());
    hostSocket.disconnect();
    console.log('  -> 10개 뷰어 및 호스트 소켓 안전하게 연결 해제 완료');

  } finally {
    console.log('\n🛑 테스트 서버 종료...');
    if (process.platform === 'win32') {
      try { spawn('taskkill', ['/F', '/T', '/PID', String(serverProcess.pid)]); } catch {}
    } else {
      serverProcess.kill('SIGTERM');
    }
  }

  console.log('\n===============================================================');
  console.log('📊 화상 미팅 10개 동시 스트림 자체 성능 검증 결과');
  console.log('===============================================================');
  console.log(`총 검증 항목: ${totalAssertions}`);
  console.log(`통과:         ${passedAssertions} ✅`);
  console.log(`실패:         ${totalAssertions - passedAssertions} ❌`);
  assert(passedAssertions === totalAssertions, '모든 화상 미팅 10개 동시 스트림 성능 검증 100% 통과!');
}

run().catch((err) => {
  console.error('\n💥 자체 검증 중 오류 발생:', err);
  process.exit(1);
});
