<?php
declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_response(['error' => 'POST만 허용됩니다.'], 405);
}

$input = json_input();
$code = room_code($input['code'] ?? '');
$role = $input['role'] ?? 'viewer';
$hostToken = $input['hostToken'] ?? null;
$name = trim((string)($input['name'] ?? '참가자'));
$clientId = trim((string)($input['clientId'] ?? ''));

if ($code === '') {
    json_response(['error' => '방 코드가 필요합니다.'], 400);
}
if ($clientId === '') {
    $clientId = bin2hex(random_bytes(8));
}

try {
    $result = with_room_lock($code, function (array $room) use ($role, $hostToken, $name, $clientId) {
        prune_viewers($room);
        $now = time();

        if (!empty($room['ended']) && $role !== 'host') {
            return [
                'error' => '이미 종료된 발표입니다.',
                'status' => 410,
                'ended' => true,
            ];
        }

        if ($role === 'host') {
            if (!$hostToken || !hash_equals((string)$room['hostToken'], (string)$hostToken)) {
                return ['__return' => ['error' => '호스트 토큰이 올바르지 않습니다.', 'status' => 403]];
            }
            $room['hostConnected'] = true;
            $room['hostLastSeen'] = $now;
        } else {
            $viewers = (array)($room['viewers'] ?? []);
            $viewers[$clientId] = [
                'name' => $name !== '' ? $name : '참가자',
                'lastSeen' => $now,
            ];
            $room['viewers'] = (object)$viewers;
        }

        $drawings = $room['drawings'] ?? new stdClass();
        if (is_array($drawings)) {
            $drawings = (object)$drawings;
        }

        $payload = [
            'clientId' => $clientId,
            'role' => $role === 'host' ? 'host' : 'viewer',
            'state' => public_state($room),
            'drawings' => $drawings,
            'popup' => $room['popup'],
            'video' => $room['video'],
            'eventSeq' => (int)($room['eventSeq'] ?? 0),
        ];

        $room['eventSeq'] = (int)($room['eventSeq'] ?? 0) + 1;
        $event = [
            'id' => $room['eventSeq'],
            'type' => 'viewer-count',
            'payload' => ['count' => viewer_count($room)],
            'ts' => $now,
        ];
        file_put_contents(
            events_path($room['code']),
            json_encode($event, JSON_UNESCAPED_UNICODE) . "\n",
            FILE_APPEND | LOCK_EX
        );

        return ['__room' => $room, '__return' => $payload];
    });
} catch (RuntimeException $e) {
    if ($e->getMessage() === 'NOT_FOUND') {
        json_response(['error' => '방을 찾을 수 없습니다.'], 404);
    }
    json_response(['error' => $e->getMessage()], 500);
}

if (isset($result['error'])) {
    json_response(['error' => $result['error']], (int)($result['status'] ?? 400));
}

json_response($result);
