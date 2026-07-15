<?php
declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

$checks = [];

$checks['php_version'] = [
    'ok' => version_compare(PHP_VERSION, '8.0.0', '>='),
    'value' => PHP_VERSION,
];

$checks['data_writable'] = [
    'ok' => is_dir(DATA_DIR) && is_writable(DATA_DIR),
    'value' => DATA_DIR,
];

$checks['uploads_writable'] = [
    'ok' => is_dir(UPLOADS_DIR) && is_writable(UPLOADS_DIR),
    'value' => UPLOADS_DIR,
];

$checks['rooms_writable'] = [
    'ok' => is_dir(ROOMS_DIR) && is_writable(ROOMS_DIR),
    'value' => ROOMS_DIR,
];

$uploadMax = ini_get('upload_max_filesize');
$postMax = ini_get('post_max_size');
function health_size_to_bytes(string $val): int {
    $val = trim($val);
    if ($val === '') return 0;
    $num = (float)$val;
    $unit = strtoupper(substr($val, -1));
    return match ($unit) {
        'G' => (int)($num * 1024 * 1024 * 1024),
        'M' => (int)($num * 1024 * 1024),
        'K' => (int)($num * 1024),
        default => (int)$val,
    };
}
$postBytes = health_size_to_bytes((string)$postMax);
$checks['upload_limits'] = [
    'ok' => $postBytes <= 0 || $postBytes >= 20 * 1024 * 1024,
    'value' => [
        'upload_max_filesize' => $uploadMax,
        'post_max_size' => $postMax,
        'hint' => ($postBytes > 0 && $postBytes < 20 * 1024 * 1024)
            ? '8~20MB 미만이면 큰 PPT가 실패합니다. php.ini에서 100M으로 올리세요.'
            : 'ok',
    ],
];

$allOk = true;
foreach ($checks as $c) {
    if (empty($c['ok'])) {
        $allOk = false;
        break;
    }
}

json_response([
    'ok' => $allOk,
    'checks' => $checks,
    'time' => time(),
]);
