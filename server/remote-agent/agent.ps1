# YUNSEUL MEET - 원격 제어 에이전트 (Windows PowerShell 5.1+, 설치 불필요)
# 서버가 세션 정보(__WS_URL__ 등)를 채워서 .bat 로 내려줍니다.
$ErrorActionPreference = 'Stop'
$WsUrl     = '__WS_URL__'
$SessionId = '__SESSION_ID__'
$Token     = '__AGENT_TOKEN__'
$HostName  = '__HOST_NAME__'
$DryRun    = ($env:YM_DRYRUN -eq '1')

try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.ServicePointManager]::SecurityProtocol } catch {}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class YmInput {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint mapType);
}
"@
try { [void][YmInput]::SetProcessDPIAware() } catch {}

$ScreenW = [YmInput]::GetSystemMetrics(0)
$ScreenH = [YmInput]::GetSystemMetrics(1)

# KeyboardEvent.code -> Virtual-Key
$vk = @{
  Enter=0x0D; NumpadEnter=0x0D; Escape=0x1B; Backspace=0x08; Tab=0x09; Space=0x20
  ArrowLeft=0x25; ArrowUp=0x26; ArrowRight=0x27; ArrowDown=0x28
  Delete=0x2E; Insert=0x2D; Home=0x24; End=0x23; PageUp=0x21; PageDown=0x22
  ShiftLeft=0xA0; ShiftRight=0xA1; ControlLeft=0xA2; ControlRight=0xA3; AltLeft=0xA4; AltRight=0xA5
  MetaLeft=0x5B; MetaRight=0x5C; CapsLock=0x14; NumLock=0x90; ScrollLock=0x91; PrintScreen=0x2C; Pause=0x13
  ContextMenu=0x5D; Lang1=0x15; Lang2=0x19
  Minus=0xBD; Equal=0xBB; BracketLeft=0xDB; BracketRight=0xDD; Backslash=0xDC
  Semicolon=0xBA; Quote=0xDE; Comma=0xBC; Period=0xBE; Slash=0xBF; Backquote=0xC0
  NumpadAdd=0x6B; NumpadSubtract=0x6D; NumpadMultiply=0x6A; NumpadDivide=0x6F; NumpadDecimal=0x6E
}
for ($i = 0; $i -lt 26; $i++) { $vk["Key" + [char](65 + $i)] = 0x41 + $i }
for ($i = 0; $i -lt 10; $i++) { $vk["Digit$i"] = 0x30 + $i; $vk["Numpad$i"] = 0x60 + $i }
for ($i = 1; $i -le 12; $i++) { $vk["F$i"] = 0x6F + $i }
$extended = @('ArrowLeft','ArrowUp','ArrowRight','ArrowDown','Delete','Insert','Home','End','PageUp','PageDown','ControlRight','AltRight','NumpadEnter','NumpadDivide','MetaLeft','MetaRight','ContextMenu')

function Move-Mouse($nx, $ny) {
  $x = [int][Math]::Round([Math]::Max(0.0, [Math]::Min(1.0, [double]$nx)) * ($ScreenW - 1))
  $y = [int][Math]::Round([Math]::Max(0.0, [Math]::Min(1.0, [double]$ny)) * ($ScreenH - 1))
  if ($DryRun) { Write-Host "[dry] move $x,$y"; return }
  [void][YmInput]::SetCursorPos($x, $y)
}

function Apply-Event($ev) {
  switch ($ev.k) {
    'mm' { Move-Mouse $ev.x $ev.y }
    'md' {
      Move-Mouse $ev.x $ev.y
      $f = @(0x0002, 0x0020, 0x0008)[[int]$ev.b]
      if ($DryRun) { Write-Host "[dry] mouse down b=$($ev.b)" } else { [YmInput]::mouse_event($f, 0, 0, 0, [UIntPtr]::Zero) }
    }
    'mu' {
      Move-Mouse $ev.x $ev.y
      $f = @(0x0004, 0x0040, 0x0010)[[int]$ev.b]
      if ($DryRun) { Write-Host "[dry] mouse up b=$($ev.b)" } else { [YmInput]::mouse_event($f, 0, 0, 0, [UIntPtr]::Zero) }
    }
    'wh' {
      Move-Mouse $ev.x $ev.y
      $dy = [int](-1.2 * [double]$ev.dy)
      $dx = [int](1.2 * [double]$ev.dx)
      if ($DryRun) { Write-Host "[dry] wheel dx=$dx dy=$dy"; return }
      if ($dy -ne 0) { [YmInput]::mouse_event(0x0800, 0, 0, $dy, [UIntPtr]::Zero) }
      if ($dx -ne 0) { [YmInput]::mouse_event(0x1000, 0, 0, $dx, [UIntPtr]::Zero) }
    }
    'kd' { Send-Key $ev.c $false }
    'ku' { Send-Key $ev.c $true }
  }
}

function Send-Key($code, $up) {
  if (-not $vk.ContainsKey($code)) { return }
  $v = [byte]$vk[$code]
  $flags = 0
  if ($extended -contains $code) { $flags = $flags -bor 0x0001 }
  if ($up) { $flags = $flags -bor 0x0002 }
  $scan = [byte]([YmInput]::MapVirtualKey([uint32]$v, 0))
  if ($DryRun) { Write-Host "[dry] key $code up=$up vk=$v"; return }
  [YmInput]::keybd_event($v, $scan, [uint32]$flags, [UIntPtr]::Zero)
}

# ── 항상 보이는 안전 창: 참가자가 언제든 즉시 중지 ─────────────────────────
$script:stop = $false
$form = New-Object Windows.Forms.Form
$form.Text = 'YUNSEUL MEET 원격 제어'
$form.TopMost = $true
$form.FormBorderStyle = 'FixedToolWindow'
$form.StartPosition = 'Manual'
$form.Size = New-Object Drawing.Size(360, 150)
$form.Location = New-Object Drawing.Point(20, 20)
$form.BackColor = [Drawing.Color]::FromArgb(24, 30, 48)
$label = New-Object Windows.Forms.Label
$label.ForeColor = [Drawing.Color]::White
$label.Font = New-Object Drawing.Font('Malgun Gothic', 10, [Drawing.FontStyle]::Bold)
$label.Text = "연결 중... 호스트 '$HostName'"
$label.AutoSize = $false
$label.Size = New-Object Drawing.Size(330, 50)
$label.Location = New-Object Drawing.Point(12, 10)
$form.Controls.Add($label)
$btn = New-Object Windows.Forms.Button
$btn.Text = '제어 중지 (연결 끊기)'
$btn.BackColor = [Drawing.Color]::FromArgb(220, 38, 38)
$btn.ForeColor = [Drawing.Color]::White
$btn.FlatStyle = 'Flat'
$btn.Font = New-Object Drawing.Font('Malgun Gothic', 10, [Drawing.FontStyle]::Bold)
$btn.Size = New-Object Drawing.Size(330, 38)
$btn.Location = New-Object Drawing.Point(12, 68)
$btn.Add_Click({ $script:stop = $true })
$form.Controls.Add($btn)
$form.Add_FormClosing({ $script:stop = $true })
$form.Show()

$ws = New-Object Net.WebSockets.ClientWebSocket
$cts = New-Object Threading.CancellationTokenSource
$uri = [Uri]("$WsUrl" + "?s=" + [Uri]::EscapeDataString($SessionId) + "&k=" + [Uri]::EscapeDataString($Token))

function Send-Json($obj) {
  $json = ($obj | ConvertTo-Json -Compress -Depth 5)
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  $seg = New-Object 'ArraySegment[byte]' -ArgumentList (,$bytes)
  [void]$ws.SendAsync($seg, [Net.WebSockets.WebSocketMessageType]::Text, $true, $cts.Token).GetAwaiter().GetResult()
}

try {
  $connect = $ws.ConnectAsync($uri, $cts.Token)
  while (-not $connect.IsCompleted) { [Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 20 }
  if ($connect.IsFaulted) { throw $connect.Exception.GetBaseException() }
  Send-Json @{ t = 'hello'; w = $ScreenW; h = $ScreenH; dryRun = $DryRun }
  $label.Text = "호스트 '$HostName' 님이 이 PC를 제어 중입니다.`n중지하려면 아래 버튼을 누르세요."
  if ($DryRun) { $label.Text = '[테스트 모드] 실제 입력은 실행되지 않습니다.' }
  Write-Host "connected: $WsUrl screen=${ScreenW}x${ScreenH} dry=$DryRun"

  $buf = New-Object byte[] 65536
  $seg = New-Object 'ArraySegment[byte]' -ArgumentList (,$buf)
  $ms = New-Object IO.MemoryStream
  $recv = $ws.ReceiveAsync($seg, $cts.Token)
  while ($ws.State -eq [Net.WebSockets.WebSocketState]::Open -and -not $script:stop) {
    [Windows.Forms.Application]::DoEvents()
    if ($recv.IsCompleted) {
      if ($recv.IsFaulted -or $recv.IsCanceled) { break }
      $r = $recv.Result
      if ($r.MessageType -eq [Net.WebSockets.WebSocketMessageType]::Close) { break }
      $ms.Write($buf, 0, $r.Count)
      if ($r.EndOfMessage) {
        $text = [Text.Encoding]::UTF8.GetString($ms.ToArray())
        $ms.SetLength(0)
        try {
          $m = $text | ConvertFrom-Json
          if ($m.t -eq 'input') { foreach ($ev in $m.events) { Apply-Event $ev } }
          elseif ($m.t -eq 'ping') { Send-Json @{ t = 'pong' } }
          elseif ($m.t -eq 'stop') { $script:stop = $true }
        } catch { Write-Host "msg error: $_" }
      }
      $recv = $ws.ReceiveAsync($seg, $cts.Token)
    } else {
      Start-Sleep -Milliseconds 1
    }
  }
  if ($script:stop -and $ws.State -eq [Net.WebSockets.WebSocketState]::Open) {
    try { Send-Json @{ t = 'stopped' } } catch {}
  }
} catch {
  Write-Host "오류: $_"
  [Windows.Forms.MessageBox]::Show("호스트 서버에 연결하지 못했습니다.`n$_", 'YUNSEUL MEET 원격 제어') | Out-Null
} finally {
  try { $cts.Cancel() } catch {}
  try { $ws.Dispose() } catch {}
  try { $form.Close() } catch {}
  # 눌린 채로 남은 키 해제 (안전)
  if (-not $DryRun) {
    foreach ($k in @(0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0x5B)) { try { [YmInput]::keybd_event([byte]$k, 0, 2, [UIntPtr]::Zero) } catch {} }
  }
  Write-Host '원격 제어가 종료되었습니다.'
}
