<?php
declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

$code = room_code($_GET['code'] ?? '');
if ($code === '') {
    json_response(['error' => '방 코드가 필요합니다.'], 400);
}

$room = load_room($code);
if ($room === null) {
    json_response(['error' => '방을 찾을 수 없습니다.'], 404);
}

json_response(public_state($room));
