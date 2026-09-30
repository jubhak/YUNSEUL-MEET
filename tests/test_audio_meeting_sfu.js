/**
 * 음성 미팅 SFU 다자간 오디오 라우팅 및 버튼 토글 시 화면/오디오 유지 검증 테스트
 *   node tests/test_audio_meeting_sfu.js
 */
const { spawn } = require('child_process');
const path = require('path');
const { io: ioClient } = require('socket.io-client');

const ROOT = path.resolve(__dirname, '..');
const PORT = 4892;
const BASE = `http://127.0.0.1:${PORT}`;
let pass = 0;
let fail = 0;
function assert(cond, msg) {
  if (cond) { pass += 1; console.log(`  ✅ ${msg}`); } else { fail += 1; console.log(`  ❌ ${msg}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect() {
  return new Promise((res, rej) => {
    const s = ioClient(BASE, { transports: ['websocket'], reconnection: false });
    s.on('connect', () => res(s));
    s.on('connect_error', rej);
  });
}
const emitAck = (s, ev, data) => new Promise((res) => s.emit(ev, data, res));

async function main() {
  const server = spawn('node', ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), MEDIASOUP_RTC_PORT: '54444', MEDIASOUP_WORKERS: '2', NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let ready = false;
  for (let i = 0; i < 40 && !ready; i += 1) {
    await sleep(250);
    try { ready = (await fetch(`${BASE}/api/host-url`)).status === 200; } catch { /* retry */ }
  }
  assert(ready, '테스트 서버 기동');
  if (!ready) { server.kill(); process.exit(1); }

  try {
    // 1. 방 생성 (양방향 + 마이크 필수)
    const cr = await (await fetch(`${BASE}/api/create-room`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interactionMode: 'bidirectional', requireMic: true }),
    })).json();
    assert(cr.ok && cr.code, '양방향 마이크 필수 방 생성');
    const { code, hostToken } = cr;

    // 2. 호스트 접속
    const host = await connect();
    const hJoin = await emitAck(host, 'join', { code, role: 'host', hostToken, clientId: 'host-1', name: '호스트' });
    assert(hJoin?.role === 'host', '호스트 입장 성공');

    // 3. SFU capabilities 및 트랜스포트 생성
    const hCaps = await emitAck(host, 'sfu-get-capabilities', {});
    assert(hCaps?.ok && hCaps.rtpCapabilities, '호스트 SFU capabilities 획득');

    const hSendTransport = await emitAck(host, 'sfu-create-transport', { direction: 'send', purpose: 'audio' });
    assert(hSendTransport?.ok && hSendTransport.id, '호스트 audio send transport 생성');

    const hRecvTransport = await emitAck(host, 'sfu-create-transport', { direction: 'recv' });
    assert(hRecvTransport?.ok && hRecvTransport.id, '호스트 recv transport 생성');

    // 4. 호스트 mic produce
    const hProduce = await emitAck(host, 'sfu-produce', {
      transportId: hSendTransport.id,
      kind: 'audio',
      rtpParameters: {
        codecs: [{ mimeType: 'audio/opus', payloadType: 111, clockRate: 48000, channels: 2 }],
        encodings: [{ ssrc: 11111 }],
      },
      appData: { source: 'mic', trackKind: 'mic' },
    });
    assert(hProduce?.ok && hProduce.id, '호스트 마이크 produce 성공');
    const hostMicProdId = hProduce.id;

    // 5. 뷰어1 접속
    const v1 = await connect();
    await emitAck(v1, 'join', { code, role: 'viewer', clientId: 'viewer-1', name: '뷰어1' });
    const v1SendT = await emitAck(v1, 'sfu-create-transport', { direction: 'send', purpose: 'audio' });
    const v1RecvT = await emitAck(v1, 'sfu-create-transport', { direction: 'recv' });
    assert(v1SendT?.ok && v1RecvT?.ok, '뷰어1 send/recv 트랜스포트 생성');

    // 뷰어1이 호스트 마이크 consume
    const v1ConsumeHost = await emitAck(v1, 'sfu-consume', {
      transportId: v1RecvT.id,
      producerId: hostMicProdId,
      rtpCapabilities: hCaps.rtpCapabilities,
    });
    assert(v1ConsumeHost?.ok && v1ConsumeHost.id, '뷰어1이 호스트 마이크 consume 성공');

    // 뷰어1 mic produce
    const v1Produce = await emitAck(v1, 'sfu-produce', {
      transportId: v1SendT.id,
      kind: 'audio',
      rtpParameters: {
        codecs: [{ mimeType: 'audio/opus', payloadType: 111, clockRate: 48000, channels: 2 }],
        encodings: [{ ssrc: 22222 }],
      },
      appData: { source: 'viewer-mic', trackKind: 'mic' },
    });
    assert(v1Produce?.ok && v1Produce.id, '뷰어1 viewer-mic produce 성공');
    const v1MicProdId = v1Produce.id;

    // 6. 뷰어2 접속
    const v2 = await connect();
    await emitAck(v2, 'join', { code, role: 'viewer', clientId: 'viewer-2', name: '뷰어2' });
    const v2SendT = await emitAck(v2, 'sfu-create-transport', { direction: 'send', purpose: 'audio' });
    const v2RecvT = await emitAck(v2, 'sfu-create-transport', { direction: 'recv' });

    // 뷰어2가 기존 프로듀서 목록 조회 시 호스트 mic와 뷰어1 mic를 모두 가져오는지 검증
    const v2Producers = await emitAck(v2, 'sfu-get-producers', {});
    assert(v2Producers?.ok && Array.isArray(v2Producers.producers), '뷰어2 프로듀서 목록 조회 성공');
    const v2ProdSources = v2Producers.producers.map((p) => p.appData?.source);
    assert(v2ProdSources.includes('mic') && v2ProdSources.includes('viewer-mic'), '뷰어2가 호스트 mic와 뷰어1 mic를 모두 조회함');

    // 뷰어2가 호스트 mic와 뷰어1 mic consume
    const v2ConsumeHost = await emitAck(v2, 'sfu-consume', {
      transportId: v2RecvT.id,
      producerId: hostMicProdId,
      rtpCapabilities: hCaps.rtpCapabilities,
    });
    const v2ConsumeV1 = await emitAck(v2, 'sfu-consume', {
      transportId: v2RecvT.id,
      producerId: v1MicProdId,
      rtpCapabilities: hCaps.rtpCapabilities,
    });
    assert(v2ConsumeHost?.ok && v2ConsumeV1?.ok, '뷰어2가 호스트 mic 및 뷰어1 mic 모두 consume 성공');

    // 뷰어2 mic produce
    const v2Produce = await emitAck(v2, 'sfu-produce', {
      transportId: v2SendT.id,
      kind: 'audio',
      rtpParameters: {
        codecs: [{ mimeType: 'audio/opus', payloadType: 111, clockRate: 48000, channels: 2 }],
        encodings: [{ ssrc: 33333 }],
      },
      appData: { source: 'viewer-mic', trackKind: 'mic' },
    });
    assert(v2Produce?.ok && v2Produce.id, '뷰어2 viewer-mic produce 성공');
    const v2MicProdId = v2Produce.id;

    // 7. 호스트와 뷰어1이 뷰어2 mic consume
    const hConsumeV2 = await emitAck(host, 'sfu-consume', {
      transportId: hRecvTransport.id,
      producerId: v2MicProdId,
      rtpCapabilities: hCaps.rtpCapabilities,
    });
    const v1ConsumeV2 = await emitAck(v1, 'sfu-consume', {
      transportId: v1RecvT.id,
      producerId: v2MicProdId,
      rtpCapabilities: hCaps.rtpCapabilities,
    });
    assert(hConsumeV2?.ok && v1ConsumeV2?.ok, '호스트 및 뷰어1이 뷰어2 mic 모두 consume 성공');

    // 8. 호스트 마이크 close 시 뷰어들에게 sfu-producer-closed 이벤트가 정상 도달하는지 확인
    let v1ProdClosed = null;
    v1.on('sfu-producer-closed', (d) => { v1ProdClosed = d; });
    await emitAck(host, 'sfu-close-producer', { producerId: hostMicProdId });
    await sleep(200);
    assert(v1ProdClosed?.producerId === hostMicProdId, '마이크 종료 시 뷰어에 sfu-producer-closed 도달');

    console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
    if (fail > 0) process.exit(1);
  } finally {
    server.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
