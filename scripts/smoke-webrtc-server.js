/**
 * Smoke: worker + WebRtcServer on MEDIASOUP_RTC_PORT then close
 */
const path = require('path');
const fs = require('fs');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    const key = t.slice(0, i).trim();
    let val = t.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

const sfu = require('../server/sfu');

(async () => {
  const w = await sfu.getWorker();
  const server = await sfu.getWebRtcServer();
  console.log(`SMOKE_OK rtcPort=${sfu.getRtcPort()} worker=${w.pid} webrtcServer=${!!server && !server.closed}`);
  try { server.close(); } catch { /* ignore */ }
  try { w.close(); } catch { /* ignore */ }
  process.exit(0);
})().catch((err) => {
  console.error('SMOKE_FAIL', err);
  process.exit(1);
});
