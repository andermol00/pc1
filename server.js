const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());

// Almacén en memoria de salas activas
const rooms = new Map();

// 1. Health check (para que Render y la extensión sepan que está activo)
app.get('/health', (req, res) => {
  res.json({ ok: true });
});

// 2. Crear nueva sala desde la extensión (Compu 1)
app.post('/api/room/create', (req, res) => {
  const { pin, autoApprove, startUrl, deviceName } = req.body || {};
  
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

// 3. Generador de código QR
app.get('/api/qr.png', async (req, res) => {
  const { code } = req.query;
  if (!code || !rooms.has(code)) {
    return res.status(404).send('Sala no encontrada');
  }
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

// 4. Interfaz web del visor (/v)
app.get('/v', (req, res) => {
  const code = req.query.c;
  if (!code || !rooms.has(code)) {
    return res.send(`
      <!doctype html>
      <html>
      <head><meta charset="utf-8"><title>URLBridge</title></head>
      <body style="background:#0b1020;color:#e8ecf8;font-family:sans-serif;text-align:center;padding:50px;">
        <h2>Sala no encontrada o expirada</h2>
        <p style="color:#9aa6c4">Abre la extensión en tu computadora y genera una sala nueva.</p>
      </body>
      </html>
    `);
  }

  const room = rooms.get(code);

  // Formulario para ingresar el PIN si la sala requiere PIN
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

// 5. Proxy para solicitar páginas a la Compu 1
app.get('/p', (req, res) => {
  const code = req.query.c;
  const room = rooms.get(code);

  if (!room || !room.deviceWs || room.deviceWs.readyState !== 1) {
    return res.status(503).send('La Compu 1 (extensión) no está conectada a la sala.');
  }

  const reqId = Math.random().toString(36).substring(2);
  const targetUrl = room.startUrl || 'about:blank';

  const promise = new Promise((resolve, reject) => {
    room.pendings.set(reqId, { resolve, reject });
    setTimeout(() => {
      if (room.pendings.has(reqId)) {
        room.pendings.delete(reqId);
        resolve({ ok: false, error: 'Tiempo de espera agotado al obtener respuesta de la Compu 1.' });
      }
    }, 15000);
  });

  // Enviar orden de fetch a la extensión
  room.deviceWs.send(JSON.stringify({
    type: 'req',
    id: reqId,
    url: targetUrl,
    method: 'GET'
  }));

  promise.then((data) => {
    if (!data.ok) return res.status(500).send(data.error || 'Error al descargar la página.');
    if (data.contentType) res.setHeader('Content-Type', data.contentType);
    if (data.text) {
      res.send(data.text);
    } else if (data.base64) {
      res.send(Buffer.from(data.base64, 'base64'));
    } else {
      res.send('');
    }
  });
});

// 6. Conexión WebSocket para la extensión
wss.on('connection', (ws, req) => {
  const urlParams = new URLSearchParams(req.url.split('?')[1]);
  const code = urlParams.get('code');
  const dt = urlParams.get('dt');

  const room = rooms.get(code);
  if (!room || room.deviceToken !== dt) {
    ws.send(JSON.stringify({ type: 'error', error: 'La sala o el token no son válidos.' }));
    ws.close();
    return;
  }

  room.deviceWs = ws;
  console.log(`[+] Extensión conectada a la sala ${code}`);
  ws.send(JSON.stringify({ type: 'ready' }));

  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message);
      if (msg.type === 'res' && room.pendings.has(msg.id)) {
        const p = room.pendings.get(msg.id);
        room.pendings.delete(msg.id);
        p.resolve(msg);
      }
    } catch (e) {
      console.error('Error procesando mensaje:', e);
    }
  });

  ws.on('close', () => {
    if (room.deviceWs === ws) {
      room.deviceWs = null;
      console.log(`[-] Extensión desconectada de la sala ${code}`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor URLBridge activo en puerto ${PORT}`);
});