<?php
declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

$file = basename((string)($_GET['f'] ?? ''));
if ($file === '' || !preg_match('/^[a-f0-9]{32}\.(pptx|ppt)$/i', $file)) {
    http_response_code(400);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'invalid file';
    exit;
}

$path = UPLOADS_DIR . DIRECTORY_SEPARATOR . $file;
if (!is_file($path)) {
    http_response_code(404);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'not found';
    exit;
}

$fp = fopen($path, 'rb');
if ($fp === false) {
    http_response_code(500);
    echo 'read error';
    exit;
}

$header = fread($fp, 4);
fclose($fp);

// PPTX = ZIP (PK). Old .ppt is OLE compound — not supported by browser preview.
$isZip = $header === "PK\x03\x04" || $header === "PK\x05\x06" || $header === "PK\x07\x08";
if (!$isZip) {
    http_response_code(415);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode([
        'error' => '이 파일은 브라우저에서 열 수 없는 형식입니다. .pptx 로 저장한 뒤 다시 업로드하세요.',
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

$size = filesize($path);
header('Content-Type: application/vnd.openxmlformats-officedocument.presentationml.presentation');
header('Content-Length: ' . $size);
header('Content-Disposition: inline; filename="' . $file . '"');
header('Cache-Control: private, max-age=3600');
header('X-Content-Type-Options: nosniff');

readfile($path);
exit;
