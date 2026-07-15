# YUNSEUL PPT (Apache 80/443 + Node Socket.io)

Apache가 **프론트(80/443)** 를 맡고, Node는 **뒤단(127.0.0.1:3000)** 에서 Socket.io를 처리합니다.

## 접속 주소

```
https://ppt.smrun.net/
```

(HTTP `http://ppt.smrun.net/` 은 HTTPS로 자동 이동)

## 실행 순서 (둘 다 필요)

1. **Node 서버** (항상 켜 두기)

```bat
START-SERVER.bat
```

또는:

```bat
npm install
npm start
```

2. **Apache** — `ppt.smrun.net` VirtualHost가 Node로 프록시됨  
   (이미 `httpd-ssl.conf` / `httpd-vhosts.conf` 에 설정됨)

Apache 설정 변경 후:

```bat
httpd -t
httpd -k restart
```

## 구조

```
브라우저 → Apache :443 (ppt.smrun.net)
              ↓ 리버스 프록시 + WebSocket
         Node.js :3000  (Socket.io + 업로드 + 정적파일)
```

## 로컬에서 Apache 없이 테스트

```
http://127.0.0.1:3000/
```
