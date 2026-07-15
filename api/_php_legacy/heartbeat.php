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
$clientId = trim((string)($input['clientId'] ?? ''));

if ($code === '' || $clientId === '') {
    json_response(['error' => '잘못된 요청입니다.'], 400);
}

try {
    $viewerCount = with_room_lock($code, function (array $room) use ($role, $hostToken, $clientId) {
        prune_viewers($room);
        $now = time();

        if ($role === 'host') {
            require_host($room, $hostToken);
            $room['hostConnected'] = true;
            $room['hostLastSeen'] = $now;
        } else {
            $viewers = (array)($room['viewers'] ?? []);
            if (isset($viewers[$clientId]) && is_array($viewers[$clientId])) {
                $viewers[$clientId]['lastSeen'] = $now;
            } else {
                $viewers[$clientId] = ['name' => '참가자', 'lastSeen' => $now];
            }
            $room['viewers'] = (object)$viewers;
        }

        return [
            '__room' => $room,
            '__return' => viewer_count($room),
        ];
    });
} catch (RuntimeException $e) {
    if ($e->getMessage() === 'NOT_FOUND') {
        json_response(['error' => '방을 찾을 수 없습니다.'], 404);
    }
    json_response(['error' => $e->getMessage()], 500);
}

json_response(['ok' => true, 'viewerCount' => (int)$viewerCount]);
