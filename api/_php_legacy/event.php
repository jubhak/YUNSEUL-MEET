<?php
declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_response(['error' => 'POST만 허용됩니다.'], 405);
}

$input = json_input();
$code = room_code($input['code'] ?? '');
$hostToken = $input['hostToken'] ?? null;
$type = (string)($input['type'] ?? '');
$payload = $input['payload'] ?? [];

if ($code === '' || $type === '') {
    json_response(['error' => '잘못된 요청입니다.'], 400);
}
if (!is_array($payload)) {
    $payload = [];
}

$allowed = [
    'slide-change',
    'draw-start',
    'draw-move',
    'draw-end',
    'clear-drawings',
    'clear-all-drawings',
    'open-link',
    'close-link',
    'play-video',
    'video-control',
    'close-video',
    'session-end',
];

if (!in_array($type, $allowed, true)) {
    json_response(['error' => '허용되지 않은 이벤트입니다.'], 400);
}

try {
    with_room_lock($code, function (array $room) use ($hostToken, $type, $payload) {
        require_host($room, $hostToken);
        prune_viewers($room);

        switch ($type) {
            case 'slide-change':
                $room['currentSlide'] = (int)($payload['slideIndex'] ?? 0);
                break;
            case 'draw-end':
                $slideIndex = (string)($payload['slideIndex'] ?? 0);
                $stroke = $payload['stroke'] ?? null;
                $drawings = (array)($room['drawings'] ?? []);
                if (!isset($drawings[$slideIndex]) || !is_array($drawings[$slideIndex])) {
                    $drawings[$slideIndex] = [];
                }
                if ($stroke) {
                    $drawings[$slideIndex][] = $stroke;
                }
                $room['drawings'] = (object)$drawings;
                break;
            case 'clear-drawings':
                $slideIndex = (string)($payload['slideIndex'] ?? 0);
                $drawings = (array)($room['drawings'] ?? []);
                $drawings[$slideIndex] = [];
                $room['drawings'] = (object)$drawings;
                break;
            case 'clear-all-drawings':
                $room['drawings'] = new stdClass();
                break;
            case 'open-link':
                $room['popup'] = $payload;
                break;
            case 'close-link':
                $room['popup'] = null;
                break;
            case 'play-video':
                $room['video'] = $payload;
                break;
            case 'close-video':
                $room['video'] = null;
                break;
            case 'session-end':
                $room['ended'] = true;
                $room['endedAt'] = time();
                $room['popup'] = null;
                $room['video'] = null;
                $payload = array_merge($payload, [
                    'message' => $payload['message'] ?? '호스트가 발표를 종료했습니다.',
                ]);
                break;
        }

        $room['eventSeq'] = (int)($room['eventSeq'] ?? 0) + 1;
        $event = [
            'id' => $room['eventSeq'],
            'type' => $type,
            'payload' => $payload,
            'ts' => time(),
        ];
        file_put_contents(
            events_path($room['code']),
            json_encode($event, JSON_UNESCAPED_UNICODE) . "\n",
            FILE_APPEND | LOCK_EX
        );

        return ['__room' => $room, '__return' => $event];
    });
} catch (RuntimeException $e) {
    if ($e->getMessage() === 'NOT_FOUND') {
        json_response(['error' => '방을 찾을 수 없습니다.'], 404);
    }
    json_response(['error' => $e->getMessage()], 500);
}

json_response(['ok' => true]);
