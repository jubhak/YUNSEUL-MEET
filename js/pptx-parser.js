const JSZIP_CANDIDATES = [
  'jszip',
  'https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm',
];
let JSZipClass = null;

async function getJSZip() {
  if (JSZipClass) return JSZipClass;
  let lastErr = null;
  for (const url of JSZIP_CANDIDATES) {
    try {
      const mod = await import(url);
      JSZipClass = mod.default || mod.JSZip;
      if (JSZipClass) return JSZipClass;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('JSZip 로드 실패');
}

const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const VIDEO_EXT = ['.mp4', '.webm', '.ogg', '.avi', '.wmv', '.m4v', '.mov'];
const AUDIO_EXT = ['.mp3', '.wav', '.m4a', '.aac', '.wma', '.ogg', '.oga', '.flac'];

function parseRelationships(relsXml) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(relsXml, 'application/xml');
  const rels = {};
  doc.querySelectorAll('Relationship').forEach((rel) => {
    rels[rel.getAttribute('Id')] = rel.getAttribute('Target');
  });
  return rels;
}

function isVideoName(name) {
  const lower = (name || '').toLowerCase();
  // .ogg 는 오디오/비디오 모두 가능 — audio 목록에 있으면 audio 우선은 호출측에서 구분
  return VIDEO_EXT.some((ext) => lower.endsWith(ext));
}

function isAudioName(name) {
  const lower = (name || '').toLowerCase();
  if (AUDIO_EXT.some((ext) => lower.endsWith(ext))) return true;
  // 확장자 없는 mediaN 은 아래에서 관계 타겟 기반
  return false;
}

function mediaKind(name) {
  if (isAudioName(name)) return 'audio';
  if (isVideoName(name)) return 'video';
  return null;
}

/**
 * 가벼운 메타데이터 파싱 — 미디어 blob을 풀지 않음 (대용량 PPT 멈춤 방지)
 */
export async function parsePptxMetadata(arrayBuffer, onProgress) {
  const t0 = performance.now();
  onProgress?.('ZIP 분석 중…');

  const JSZip = await getJSZip();
  const zip = await JSZip.loadAsync(arrayBuffer);
  onProgress?.(`ZIP 완료 (${Math.round(performance.now() - t0)}ms) — 슬라이드 목록…`);

  const mediaIndex = {};
  Object.keys(zip.files).forEach((path) => {
    if (!path.startsWith('ppt/media/') || zip.files[path].dir) return;
    const name = path.split('/').pop();
    const kind = mediaKind(name);
    mediaIndex[name] = {
      path,
      name,
      isVideo: kind === 'video',
      isAudio: kind === 'audio',
      url: null,
    };
  });

  const slideFiles = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => {
      const numA = parseInt(a.match(/slide(\d+)/)[1], 10);
      const numB = parseInt(b.match(/slide(\d+)/)[1], 10);
      return numA - numB;
    });

  const slides = [];

  for (let i = 0; i < slideFiles.length; i++) {
    const slidePath = slideFiles[i];
    const slideXml = await zip.file(slidePath).async('string');
    const relsPath = slidePath.replace('slides/', 'slides/_rels/') + '.rels';
    let rels = {};
    const relsFile = zip.file(relsPath);
    if (relsFile) {
      rels = parseRelationships(await relsFile.async('string'));
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(slideXml, 'application/xml');
    const links = [];
    const videos = [];
    const audios = [];

    // 슬라이드 전체에서 루프/가로지르기 힌트
    const acrossHint =
      /repeatCount\s*=\s*["']indefinite["']/i.test(slideXml) ||
      /p14:media/i.test(slideXml) && /across|share/i.test(slideXml);

    doc.querySelectorAll('a\\:hlinkClick, hlinkClick').forEach((linkEl) => {
      const rid = linkEl.getAttributeNS(NS_R, 'id') || linkEl.getAttribute('r:id');
      if (!rid || !rels[rid]) return;
      const target = rels[rid];
      if (target.startsWith('http')) {
        links.push({ url: target, type: 'external' });
      }
    });

    const ensureMedia = (mediaName, kind) => {
      if (!mediaIndex[mediaName]) {
        mediaIndex[mediaName] = {
          path: `ppt/media/${mediaName}`,
          name: mediaName,
          isVideo: kind === 'video',
          isAudio: kind === 'audio',
          url: null,
        };
      } else if (kind === 'audio') {
        mediaIndex[mediaName].isAudio = true;
        mediaIndex[mediaName].isVideo = false;
      } else if (kind === 'video') {
        mediaIndex[mediaName].isVideo = true;
      }
    };

    const pushByTarget = (target, forceKind = null) => {
      if (!target) return;
      const mediaName = target.split('/').pop();
      const kind = forceKind || mediaKind(mediaName);
      if (kind === 'video') {
        videos.push({ name: mediaName, url: null });
        ensureMedia(mediaName, 'video');
      } else if (kind === 'audio') {
        audios.push({
          name: mediaName,
          url: null,
          loop: acrossHint,
          across: acrossHint,
        });
        ensureMedia(mediaName, 'audio');
      }
    };

    doc.querySelectorAll('p\\:videoFile, videoFile').forEach((videoEl) => {
      const rid = videoEl.getAttributeNS(NS_R, 'link') || videoEl.getAttribute('r:link');
      if (rid && rels[rid]) pushByTarget(rels[rid], 'video');
    });

    doc.querySelectorAll('a\\:audioFile, audioFile, p\\:audioFile').forEach((audioEl) => {
      const rid =
        audioEl.getAttributeNS(NS_R, 'link') ||
        audioEl.getAttribute('r:link') ||
        audioEl.getAttributeNS(NS_R, 'embed') ||
        audioEl.getAttribute('r:embed');
      if (rid && rels[rid]) pushByTarget(rels[rid], 'audio');
    });

    // 관계 파일에서 미디어 직접 검색
    Object.values(rels).forEach((target) => {
      const name = (target || '').split('/').pop();
      const kind = mediaKind(name);
      if (kind === 'video') pushByTarget(target, 'video');
      if (kind === 'audio') pushByTarget(target, 'audio');
    });

    const uniqueVideos = [...new Map(videos.map((v) => [v.name, v])).values()];
    const uniqueAudios = [...new Map(audios.map((a) => [a.name, a])).values()];
    const uniqueLinks = [...new Map(links.map((l) => [l.url, l])).values()];

    slides.push({
      index: i,
      links: uniqueLinks,
      videos: uniqueVideos,
      audios: uniqueAudios,
    });
  }

  // 첫 슬라이드 오디오는 배경음악으로 간주 (다른 슬라이드에 오디오 없을 때 across)
  const anyLaterAudio = slides.slice(1).some((s) => s.audios.length > 0);
  if (!anyLaterAudio && slides[0]?.audios?.length) {
    slides[0].audios.forEach((a) => {
      a.across = true;
      a.loop = true;
    });
  }

  onProgress?.(`메타데이터 완료: 슬라이드 ${slideFiles.length}장 (${Math.round(performance.now() - t0)}ms)`);

  return {
    slideCount: slideFiles.length,
    slides,
    mediaFiles: mediaIndex,
    _zipBuffer: arrayBuffer,
  };
}
/**
 * 동영상만 필요할 때 추출 (클릭 시)
 */
export async function extractMediaUrl(arrayBuffer, mediaName) {
  if (!arrayBuffer || !mediaName) return null;
  const JSZip = await getJSZip();
  const zip = await JSZip.loadAsync(arrayBuffer);
  let file = zip.file(`ppt/media/${mediaName}`);
  if (!file) {
    const hit = Object.keys(zip.files).find((p) => p.endsWith('/' + mediaName) || p.endsWith(mediaName));
    if (hit) file = zip.file(hit);
  }
  if (!file) return null;
  const blob = await file.async('blob');
  const ext = mediaName.substring(mediaName.lastIndexOf('.')).toLowerCase();
  const mimeByExt = {
    '.webm': 'video/webm',
    '.ogg': 'video/ogg',
    '.oga': 'audio/ogg',
    '.mp4': 'video/mp4',
    '.m4v': 'video/mp4',
    '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.wma': 'audio/x-ms-wma',
    '.flac': 'audio/flac',
  };
  const type = mimeByExt[ext] || (AUDIO_EXT.includes(ext) ? 'audio/mpeg' : 'video/mp4');
  return URL.createObjectURL(new Blob([blob], { type }));
}

/**
 * PPT 로드 시 동영상·오디오를 한꺼번에 추출 (재생 시 지연 제거)
 * ZIP을 한 번만 열어 효율적으로 처리
 */
export async function extractAllMediaUrls(arrayBuffer, mediaFiles, onProgress) {
  if (!arrayBuffer || !mediaFiles) return;
  const entries = Object.values(mediaFiles).filter(
    (m) => m && (m.isVideo || m.isAudio) && !m.url && m.name
  );
  if (!entries.length) return;

  const JSZip = await getJSZip();
  onProgress?.(`미디어 준비 중… (${entries.length}개)`);
  const zip = await JSZip.loadAsync(arrayBuffer);

  const mimeByExt = {
    '.webm': 'video/webm',
    '.ogg': 'video/ogg',
    '.oga': 'audio/ogg',
    '.mp4': 'video/mp4',
    '.m4v': 'video/mp4',
    '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.wma': 'audio/x-ms-wma',
    '.flac': 'audio/flac',
  };

  for (let i = 0; i < entries.length; i++) {
    const m = entries[i];
    onProgress?.(`미디어 준비 ${i + 1}/${entries.length}: ${m.name}`);
    let file = zip.file(`ppt/media/${m.name}`);
    if (!file) {
      const hit = Object.keys(zip.files).find(
        (p) => p.endsWith('/' + m.name) || p.endsWith(m.name)
      );
      if (hit) file = zip.file(hit);
    }
    if (!file) continue;
    try {
      const blob = await file.async('blob');
      const ext = m.name.substring(m.name.lastIndexOf('.')).toLowerCase();
      const type = mimeByExt[ext] || (AUDIO_EXT.includes(ext) ? 'audio/mpeg' : 'video/mp4');
      if (m.url) URL.revokeObjectURL(m.url);
      m.url = URL.createObjectURL(new Blob([blob], { type }));
    } catch (err) {
      console.warn('[extractAllMediaUrls]', m.name, err);
    }
  }
  onProgress?.(`미디어 준비 완료 (${entries.length}개)`);
}

export function revokeMediaUrls(metadata) {
  if (!metadata?.mediaFiles) return;
  Object.values(metadata.mediaFiles).forEach((m) => {
    if (m.url) URL.revokeObjectURL(m.url);
  });
}
