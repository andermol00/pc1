const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const rooms = new Map();

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.post('/api/room/create', (req, res) => {
  const { pin, autoApprove, startUrl } = req.body || {};
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const deviceToken = Math.random().toString(36).substring(2) + Date.now().toString(36);

  rooms.set(code, {
    code,
    pin: pin || null,
    autoApprove: autoApprove !== false,
    startUrl: startUrl || 'about:blank',
    deviceWs: null,
    deviceToken,
    pendings: new Map()
  });

  res.json({ ok: true, code, deviceToken });
});

app.get('/api/qr.png', async (req, res) => {
  const { code } = req.query;
  if (!code || !rooms.has(code)) return res.status(404).send('Sala no encontrada');
  const host = req.headers['x-forwarded-host'] || req.get('host');
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const targetUrl = `${proto}://${host}/v?c=${code}`;

  try {
    res.setHeader('Content-Type', 'image/png');
    QRCode.toStream(res, targetUrl, { width: 180, margin: 1 }, (err) => {
      if (err && !res.headersSent) res.status(500).send('Error QR');
    });
  } catch {
    if (!res.headersSent) res.status(500).send('Error interno');
  }
});

// Pantalla de acceso y PIN
app.get('/v', (req, res) => {
  const code = req.query.c;
  if (!code || !rooms.has(code)) {
    return res.send(`<h2>Sala no encontrada o expirada</h2>`);
  }
  const room = rooms.get(code);

  res.send(`
    <!doctype html>
    <html lang="es">
    <head>
      <meta charset="utf-8">
      <title>URLBridge Viewer - Sala ${code}</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { margin: 0; background: #0b1020; color: #e8ecf8; font-family: sans-serif; display: grid; place-items: center; min-height: 100vh; }
        .card { background: #131a30; border: 1px solid #26304d; border-radius: 14px; padding: 24px; max-width: 360px; width: 90%; text-align: center; }
        h1 { font-size: 18px; margin-top: 0; color: #4f7cff; }
        input { width: 100%; box-sizing: border-box; padding: 10px; border-radius: 8px; border: 1px solid #26304d; background: #0b1020; color: #fff; font-size: 16px; margin: 12px 0; text-align: center; }
        button { width: 100%; padding: 10px; background: #4f7cff; border: none; border-radius: 8px; color: #fff; font-weight: bold; cursor: pointer; font-size: 15px; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>URLBridge Visor</h1>
        <p style="font-size:13px;color:#9aa6c4">Conectando a la sala <b>${code}</b></p>
        ${room.pin ? `
          <input type="password" id="pinInput" placeholder="Introduce el PIN" maxlength="12" />
          <button onclick="verificarPin()">Entrar</button>
        ` : `
          <button onclick="cargarSitio()">Ver pantalla</button>
        `}
      </div>
      <script>
        function verificarPin() {
          const pinIngresado = document.getElementById('pinInput').value;
          if (pinIngresado === "${room.pin}") {
            cargarSitio();
          } else {
            alert("PIN incorrecto");
          }
        }
        function cargarSitio() {
          document.body.innerHTML = '<iframe src="/p?c=${code}" style="width:100vw;height:100vh;border:none;position:fixed;top:0;left:0;"></iframe>';
        }
      </script>
    </body>
    </html>
  `);
});

// Proxy Universal para capturar HTML, CSS, JS, imágenes y llamadas de botones (Fetch/XHR)
app.all('/p', async (req, res) => {
  const code = req.query.c;
  const subUrl = req.query.url;
  const room = rooms.get(code);

  if (!room || !room.deviceWs || room.deviceWs.readyState !== 1) {
    return res.status(503).send('La extensión en la computadora no está conectada.');
  }

  const reqId = Math.random().toString(36).substring(2);
  const targetUrl = subUrl || room.startUrl || 'about:blank';

  const promise = new Promise((resolve) => {
    room.pendings.set(reqId, { resolve });
    setTimeout(() => {
      if (room.pendings.has(reqId)) {
        room.pendings.delete(reqId);
        resolve({ ok: false, error: 'Tiempo de espera agotado.' });
      }
    }, 20000);
  });

  room.deviceWs.send(JSON.stringify({
    type: 'req',
    id: reqId,
    url: targetUrl,
    method: req.method,
    headers: req.headers,
    body: req.body
  }));

  const data = await promise;
  if (!data.ok) return res.status(500).send(data.error || 'Error en el recurso.');

  if (data.contentType) res.setHeader('Content-Type', data.contentType);

  if (data.text) {
    let output = data.text;
    // Reescribe enlaces internos para que las interacciones y clics sigan pasando por el proxy
    if (/^text\/html/i.test(data.contentType)) {
      output = output.replace(/(href|src|action)=["']([^"']+)["']/g, (match, attr, val) => {
        if (val.startsWith('http') || val.startsWith('//') || val.startsWith('data:') || val.startsWith('#')) return match;
        try {
          const resolved = new URL(val, targetUrl).toString();
          return `${attr}="/p?c=${code}&url=${encodeURIComponent(resolved)}"`;
        } catch {
          return match;
        }
      });
    }
    res.send(output);
  } else if (data.base64) {
    res.send(Buffer.from(data.base64, 'base64'));
  } else {
    res.send('');
  }
});

wss.on('connection', (ws, req) => {
  const urlParams = new URLSearchParams(req.url.split('?')[1]);
  const code = urlParams.get('code');
  const dt = urlParams.get('dt');

  const room = rooms.get(code);
  if (!room || room.deviceToken !== dt) {
    ws.send(JSON.stringify({ type: 'error', error: 'Token inválido.' }));
    ws.close();
    return;
  }

  room.deviceWs = ws;
  ws.send(JSON.stringify({ type: 'ready' }));

  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message);
      if (msg.type === 'res' && room.pendings.has(msg.id)) {
        const p = room.pendings.get(msg.id);
        room.pendings.delete(msg.id);
        p.resolve(msg);
      }
    } catch {}
  });

  ws.on('close', () => {
    if (room.deviceWs === ws) room.deviceWs = null;
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT);