<?php
declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

$code = room_code($_GET['code'] ?? '');
$since = max(0, (int)($_GET['since'] ?? 0));

if ($code === '') {
    http_response_code(400);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'code required';
    exit;
}

if (load_room($code) === null) {
    http_response_code(404);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'room not found';
    exit;
}

@ini_set('zlib.output_compression', '0');
@ini_set('implicit_flush', '1');
while (ob_get_level() > 0) {
    ob_end_flush();
}
ob_implicit_flush(true);

header('Content-Type: text/event-stream; charset=utf-8');
header('Cache-Control: no-cache, no-store');
header('Connection: keep-alive');
header('X-Accel-Buffering: no');

$lastId = $since;
$started = time();
$maxSeconds = 55;
$lastCountPush = 0;

echo "retry: 2000\n\n";
echo "event: ping\ndata: " . json_encode(['ts' => time()]) . "\n\n";
flush();

while (!connection_aborted() && (time() - $started) < $maxSeconds) {
    $room = load_room($code);
    if ($room === null) {
        echo "event: error\ndata: " . json_encode(['message' => '방을 찾을 수 없습니다.'], JSON_UNESCAPED_UNICODE) . "\n\n";
        flush();
        break;
    }

    $events = read_events_since($code, $lastId);
    foreach ($events as $event) {
        $lastId = (int)$event['id'];
        echo 'id: ' . $lastId . "\n";
        echo 'event: ' . $event['type'] . "\n";
        echo 'data: ' . json_encode($event['payload'], JSON_UNESCAPED_UNICODE) . "\n\n";
    }

    // 참가자 수는 이벤트 유실 대비 주기적으로 스냅샷 전송 (id 없음 → since와 무관)
    $now = time();
    if ($now - $lastCountPush >= 2) {
        prune_viewers($room);
        echo "event: viewer-count\ndata: " . json_encode(['count' => viewer_count($room)], JSON_UNESCAPED_UNICODE) . "\n\n";
        $lastCountPush = $now;
    }

    echo "event: ping\ndata: " . json_encode(['ts' => $now, 'since' => $lastId]) . "\n\n";
    flush();

    usleep(200000);
}

echo "event: reconnect\ndata: " . json_encode(['since' => $lastId]) . "\n\n";
flush();
