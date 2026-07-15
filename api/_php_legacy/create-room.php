<?php
declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_response(['error' => 'POST만 허용됩니다.'], 405);
}

$code = make_room_code();
$hostToken = bin2hex(random_bytes(16));
$room = default_room($code, $hostToken);
save_room($code, $room);
file_put_contents(events_path($code), '');

json_response([
    'code' => $code,
    'hostToken' => $hostToken,
]);
