/**
 * SFU 로드 경로 검증 (CDN 없이 로컬 번들 + 서버 caps)
 * 실행: node scripts/verify-sfu-load.mjs
 */
import http from 'http';
import https from 'https';
import { pathToFileURL } from 'url';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const failures = [];

function get(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: 10000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          body: Buffer.concat(chunks).toString('utf8'),
          headers: res.headers,
        });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout ' + url));
    });
  });
}

function assert(cond, msg) {
  if (!cond) {
    failures.push(msg);
    console.error('FAIL:', msg);
  } else {
    console.log('OK  :', msg);
  }
}

async function main() {
  // 1) 로컬 파일 번들 Device export
  const fileUrl = pathToFileURL(path.join(ROOT, 'js/vendor/mediasoup-client.js')).href;
  const mod = await import(fileUrl);
  const Device = mod.Device || mod.default?.Device || mod.default;
  assert(typeof Device === 'function', 'local bundle exports Device');

  // 2) 로컬 서버 HTTP로 번들 제공
  const local = await get('http://127.0.0.1:3000/js/vendor/mediasoup-client.js?v=20260826local');
  assert(local.status === 200, `local HTTP vendor status=${local.status}`);
  assert(local.body.includes('Device') || local.body.length > 100000, 'local HTTP vendor body looks like bundle');

  // 3) sfu-client가 CDN이 아닌 vendor를 가리키는지
  const sfuClient = await get('http://127.0.0.1:3000/js/webrtc/sfu-client.js?v=20260826sfu5');
  assert(sfuClient.status === 200, `sfu-client HTTP status=${sfuClient.status}`);
  assert(sfuClient.body.includes('vendor/mediasoup-client.js'), 'sfu-client imports local vendor');
  assert(!sfuClient.body.includes('cdn.jsdelivr.net'), 'sfu-client has no jsdelivr');
  assert(!sfuClient.body.includes('esm.sh'), 'sfu-client has no esm.sh');

  // 4) host.html 캐시버스트
  const hostHtml = await get('http://127.0.0.1:3000/host.html');
  assert(hostHtml.body.includes('host.js?v=20260826sfu5'), 'host.html uses sfu5');

  // 5) 공개 URL (프록시) — 실패해도 경고만 (CF 캐시 지연 가능)
  try {
    const pubVendor = await get('https://ppt.smrun.net/js/vendor/mediasoup-client.js?v=20260826local');
    assert(pubVendor.status === 200, `public vendor status=${pubVendor.status}`);
    assert(pubVendor.body.length > 100000, 'public vendor size ok');
    const pubSfu = await get('https://ppt.smrun.net/js/webrtc/sfu-client.js?v=20260826sfu5');
    assert(pubSfu.body.includes('vendor/mediasoup-client.js'), 'public sfu-client uses vendor');
  } catch (err) {
    failures.push('public URL check: ' + err.message);
    console.error('FAIL:', 'public URL check:', err.message);
  }

  // 6) SFU worker/router capabilities (서버 모듈)
  const { createRequire } = await import('module');
  const require = createRequire(path.join(ROOT, 'package.json'));
  const { getOrCreateRoom, detectAnnouncedIp } = require('./server/sfu.js');
  const room = await getOrCreateRoom('verify-tmp');
  assert(!!room?.router?.rtpCapabilities?.codecs?.length, 'sfu router rtpCapabilities ok');
  const ip = detectAnnouncedIp();
  assert(!!ip && ip !== '127.0.0.1', `announcedIp=${ip}`);
  console.log('OK  : announcedIp', ip);

  if (failures.length) {
    console.error('\n검증 실패', failures.length, '건');
    process.exit(1);
  }
  console.log('\n검증 통과');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
