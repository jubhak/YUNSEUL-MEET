<?php
declare(strict_types=1);

// Request Startup Warning HTML이 JSON을 깨지 않게
@ini_set('display_errors', '0');
@ini_set('html_errors', '0');

require __DIR__ . '/bootstrap.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_response(['error' => 'POST만 허용됩니다.'], 405);
}

$contentLength = (int)($_SERVER['CONTENT_LENGTH'] ?? 0);
$postMax = ini_get('post_max_size');
$uploadMax = ini_get('upload_max_filesize');

function size_to_bytes(string $val): int
{
    $val = trim($val);
    if ($val === '') {
        return 0;
    }
    $num = (float)$val;
    $unit = strtoupper(substr($val, -1));
    return match ($unit) {
        'G' => (int)($num * 1024 * 1024 * 1024),
        'M' => (int)($num * 1024 * 1024),
        'K' => (int)($num * 1024),
        default => (int)$val,
    };
}

$postMaxBytes = size_to_bytes((string)$postMax);
$uploadMaxBytes = size_to_bytes((string)$uploadMax);

// post_max_size 초과 시 PHP가 $_POST/$_FILES 를 비움
if ($contentLength > 0 && $postMaxBytes > 0 && $contentLength > $postMaxBytes) {
    json_response([
        'error' => sprintf(
            '파일이 서버 POST 제한(%s)을 초과했습니다. (전송 %dMB) php.ini 의 post_max_size / upload_max_filesize 를 100M 이상으로 올리세요.',
            $postMax,
            (int)ceil($contentLength / 1024 / 1024)
        ),
        'limits' => [
            'post_max_size' => $postMax,
            'upload_max_filesize' => $uploadMax,
            'content_length' => $contentLength,
        ],
    ], 413);
}

$code = room_code($_POST['code'] ?? ($_GET['code'] ?? ''));
$hostToken = $_POST['hostToken'] ?? '';

if ($code === '' && empty($_POST) && empty($_FILES) && $contentLength > 0) {
    json_response([
        'error' => sprintf(
            '업로드가 거부되었습니다. PHP 용량 제한(post_max_size=%s, upload_max_filesize=%s)을 확인하세요. 현재 기본값이 8M이면 10MB PPT는 실패합니다.',
            $postMax ?: '?',
            $uploadMax ?: '?'
        ),
        'limits' => [
            'post_max_size' => $postMax,
            'upload_max_filesize' => $uploadMax,
            'content_length' => $contentLength,
        ],
    ], 413);
}

if ($code === '') {
    json_response(['error' => '방 코드가 필요합니다.'], 400);
}

$room = load_room($code);
if ($room === null) {
    json_response(['error' => '방을 찾을 수 없습니다.'], 404);
}
require_host($room, $hostToken);

if (!isset($_FILES['presentation'])) {
    json_response([
        'error' => '파일이 전송되지 않았습니다. (PHP post_max_size=' . ($postMax ?: '?') .
            ', upload_max_filesize=' . ($uploadMax ?: '?') . ' — 제한 초과 시 파일이 비어 도착합니다)',
        'limits' => [
            'post_max_size' => $postMax,
            'upload_max_filesize' => $uploadMax,
            'content_length' => $contentLength,
        ],
    ], 400);
}

$uploadError = (int)$_FILES['presentation']['error'];
if ($uploadError !== UPLOAD_ERR_OK) {
    $messages = [
        UPLOAD_ERR_INI_SIZE => 'php.ini upload_max_filesize(' . ($uploadMax ?: '?') . ') 초과 — php.ini에서 100M으로 올리세요',
        UPLOAD_ERR_FORM_SIZE => '폼 최대 크기 초과',
        UPLOAD_ERR_PARTIAL => '파일이 일부만 업로드됨',
        UPLOAD_ERR_NO_FILE => '파일 없음',
        UPLOAD_ERR_NO_TMP_DIR => '임시 폴더 없음',
        UPLOAD_ERR_CANT_WRITE => '디스크 쓰기 실패',
        UPLOAD_ERR_EXTENSION => 'PHP 확장에 의해 차단됨',
    ];
    $msg = $messages[$uploadError] ?? ('업로드 오류 코드 ' . $uploadError);
    json_response(['error' => '파일 업로드 실패: ' . $msg], 400);
}

$file = $_FILES['presentation'];
$originalName = basename((string)($file['name'] ?? 'presentation.pptx'));
$ext = strtolower(pathinfo($originalName, PATHINFO_EXTENSION));
if (!in_array($ext, ['pptx', 'ppt'], true)) {
    json_response(['error' => 'PPTX 파일만 업로드 가능합니다.'], 400);
}

if (($file['size'] ?? 0) > 100 * 1024 * 1024) {
    json_response(['error' => '파일 크기는 100MB 이하여야 합니다.'], 400);
}

$filename = bin2hex(random_bytes(16)) . '.' . $ext;
$dest = UPLOADS_DIR . DIRECTORY_SEPARATOR . $filename;
if (!move_uploaded_file($file['tmp_name'], $dest)) {
    json_response(['error' => '파일 저장에 실패했습니다. uploads 폴더 쓰기 권한을 확인하세요.'], 500);
}

$slideCount = max(1, (int)($_POST['slideCount'] ?? 1));
$presentation = [
    'filename' => $filename,
    'originalName' => $originalName,
    'url' => 'api/get-file.php?f=' . rawurlencode($filename),
    'slideCount' => $slideCount,
];

$probe = fopen($dest, 'rb');
$magic = $probe ? fread($probe, 4) : '';
if ($probe) {
    fclose($probe);
}
if ($magic !== "PK\x03\x04" && $magic !== "PK\x05\x06") {
    @unlink($dest);
    json_response([
        'error' => '유효한 .pptx(ZIP) 파일이 아닙니다. PowerPoint에서 .pptx로 저장 후 다시 올려주세요.',
    ], 400);
}

try {
    with_room_lock($code, function (array $room) use ($presentation) {
        $room['presentation'] = $presentation;
        $room['currentSlide'] = 0;
        $room['drawings'] = new stdClass();
        $room['popup'] = null;
        $room['video'] = null;
        return ['__room' => $room, '__return' => true];
    });
} catch (RuntimeException $e) {
    @unlink($dest);
    json_response(['error' => '방을 찾을 수 없습니다.'], 404);
}

append_event($code, 'presentation-ready', [
    'presentation' => $presentation,
    'currentSlide' => 0,
    'drawings' => new stdClass(),
]);

json_response([
    'success' => true,
    'presentation' => $presentation,
    'limits' => [
        'post_max_size' => $postMax,
        'upload_max_filesize' => $uploadMax,
    ],
]);
