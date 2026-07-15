<?php
declare(strict_types=1);

// API 응답이 JSON이므로 Warning HTML이 섞이지 않게 함
ini_set('display_errors', '0');
error_reporting(E_ALL);

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

define('ROOT_DIR', dirname(__DIR__));
define('DATA_DIR', ROOT_DIR . DIRECTORY_SEPARATOR . 'data');
define('UPLOADS_DIR', ROOT_DIR . DIRECTORY_SEPARATOR . 'uploads');
define('ROOMS_DIR', DATA_DIR . DIRECTORY_SEPARATOR . 'rooms');

foreach ([DATA_DIR, UPLOADS_DIR, ROOMS_DIR] as $dir) {
    if (!is_dir($dir)) {
        mkdir($dir, 0775, true);
    }
}

function json_input(): array
{
    $raw = file_get_contents('php://input');
    if ($raw === false || $raw === '') {
        return $_POST ?: [];
    }
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

function json_response(array $data, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

function room_code(string $code): string
{
    return strtoupper(preg_replace('/[^A-Za-z0-9]/', '', $code) ?? '');
}

function room_path(string $code): string
{
    return ROOMS_DIR . DIRECTORY_SEPARATOR . $code . '.json';
}

function events_path(string $code): string
{
    return ROOMS_DIR . DIRECTORY_SEPARATOR . $code . '.events.jsonl';
}

function make_room_code(): string
{
    $chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    do {
        $code = '';
        for ($i = 0; $i < 6; $i++) {
            $code .= $chars[random_int(0, strlen($chars) - 1)];
        }
    } while (file_exists(room_path($code)));
    return $code;
}

function default_room(string $code, string $hostToken): array
{
    return [
        'code' => $code,
        'hostToken' => $hostToken,
        'hostConnected' => false,
        'hostLastSeen' => 0,
        'presentation' => null,
        'currentSlide' => 0,
        'drawings' => new stdClass(),
        'popup' => null,
        'video' => null,
        'viewers' => new stdClass(),
        'eventSeq' => 0,
        'createdAt' => time(),
    ];
}

function load_room(string $code): ?array
{
    $path = room_path($code);
    if (!file_exists($path)) {
        return null;
    }
    $raw = file_get_contents($path);
    $data = json_decode($raw ?: '', true);
    return is_array($data) ? $data : null;
}

function save_room(string $code, array $room): void
{
    $path = room_path($code);
    $tmp = $path . '.tmp';
    file_put_contents($tmp, json_encode($room, JSON_UNESCAPED_UNICODE), LOCK_EX);
    rename($tmp, $path);
}

/**
 * @template T
 * @param callable(array):T $fn
 * @return T
 */
function with_room_lock(string $code, callable $fn)
{
    $path = room_path($code);
    $lockPath = $path . '.lock';
    $lock = fopen($lockPath, 'c+');
    if ($lock === false) {
        throw new RuntimeException('방 잠금을 열 수 없습니다.');
    }
    try {
        if (!flock($lock, LOCK_EX)) {
            throw new RuntimeException('방 잠금에 실패했습니다.');
        }
        $room = load_room($code);
        if ($room === null) {
            throw new RuntimeException('NOT_FOUND');
        }
        $result = $fn($room);
        if (is_array($result) && isset($result['__room'])) {
            save_room($code, $result['__room']);
            return $result['__return'] ?? null;
        }
        return $result;
    } finally {
        flock($lock, LOCK_UN);
        fclose($lock);
    }
}

function prune_viewers(array &$room): void
{
    $now = time();
    $viewers = (array)($room['viewers'] ?? []);
    foreach ($viewers as $id => $info) {
        $last = is_array($info) ? (int)($info['lastSeen'] ?? 0) : 0;
        if ($now - $last > 30) {
            unset($viewers[$id]);
        }
    }
    $room['viewers'] = (object)$viewers;
    $room['hostConnected'] = ($now - (int)($room['hostLastSeen'] ?? 0)) <= 30;
}

function viewer_count(array $room): int
{
    return count((array)($room['viewers'] ?? []));
}

function public_state(array $room): array
{
    prune_viewers($room);
    $presentation = $room['presentation'];
    return [
        'code' => $room['code'],
        'hostConnected' => !empty($room['hostConnected']),
        'hasPresentation' => !empty($presentation),
        'presentation' => $presentation,
        'currentSlide' => (int)($room['currentSlide'] ?? 0),
        'viewerCount' => viewer_count($room),
        'ended' => !empty($room['ended']),
    ];
}

function append_event(string $code, string $type, array $payload = []): array
{
    return with_room_lock($code, function (array $room) use ($code, $type, $payload) {
        prune_viewers($room);
        $room['eventSeq'] = (int)($room['eventSeq'] ?? 0) + 1;
        $event = [
            'id' => $room['eventSeq'],
            'type' => $type,
            'payload' => $payload,
            'ts' => time(),
        ];

        file_put_contents(
            events_path($code),
            json_encode($event, JSON_UNESCAPED_UNICODE) . "\n",
            FILE_APPEND | LOCK_EX
        );

        return ['__room' => $room, '__return' => $event];
    });
}

function read_events_since(string $code, int $sinceId): array
{
    $path = events_path($code);
    if (!file_exists($path)) {
        return [];
    }

    $events = [];
    $fp = fopen($path, 'r');
    if ($fp === false) {
        return [];
    }
    while (($line = fgets($fp)) !== false) {
        $line = trim($line);
        if ($line === '') {
            continue;
        }
        $event = json_decode($line, true);
        if (!is_array($event)) {
            continue;
        }
        if ((int)($event['id'] ?? 0) > $sinceId) {
            $events[] = $event;
        }
    }
    fclose($fp);
    return $events;
}

function require_host(array $room, ?string $token): void
{
    if (!$token || !hash_equals((string)$room['hostToken'], $token)) {
        json_response(['error' => '호스트 권한이 없습니다.'], 403);
    }
}
