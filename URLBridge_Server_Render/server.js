const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());

// Almacén en memoria de las salas activas
const rooms = new Map();

// 1. Ruta de comprobación (Health Check)
app.get('/health', (req, res) => {
  res.json({ ok: true });
});

// 2. Crear nueva sala
app.post('/api/room/create', (req, res) => {
  const { pin, autoApprove, startUrl, deviceName } = req.body || {};
  
  // Código único de 6 dígitos y token de seguridad para la Compu 1
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

// 3. Generar código QR dinámico
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
      if (err && !res.headersSent) res.status(500).send('Error al generar QR');
    });
  } catch {
    if (!res.headersSent) res.status(500).send('Error interno');
  }
});

// 4. Interfaz del visor (/v)
app.get('/v', (req, res) => {
  const code = req.query.c;
  if (!code || !rooms.has(code)) {
    return res.send(`
      <!doctype html>
      <html>
      <head><meta charset="utf-8"><title>URLBridge</title></head>
      <body style="background:#0b1020;color:#e8ecf8;font-family:sans-serif;text-align:center;padding:50px;">
        <h2>Sala no encontrada o expirada</h2>
        <p style="color:#9aa6c4">Verifica el código o vuelve a generar una sala desde la extensión.</p>
      </body>
      </html>
    `);
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
        body { margin: 0; background: #0b1020; color: #e8ecf8; font-family: -apple-system, sans-serif; display: grid; place-items: center; min-height: 100vh; }
        .card { background: #131a30; border: 1px solid #26304d; border-radius: 14px; padding: 24px; max-width: 380px; width: 90%; text-align: center; }
        h1 { font-size: 18px; margin-top: 0; color: #4f7cff; }
        .code { font-family: monospace; font-size: 28px; font-weight: bold; letter-spacing: 4px; color: #b9c9ff; margin: 12px 0; }
        .status { font-size: 13px; color: #86efac; background: #12251a; border: 1px solid #2f5236; border-radius: 20px; padding: 4px 12px; display: inline-block; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>URLBridge Relé</h1>
        <div class="status">● Conectado a la sala</div>
        <div class="code">${code}</div>
        <p style="font-size: 13px; color: #9aa6c4;">URL publicada originalmente:<br><b style="color:#fff">${room.startUrl}</b></p>
      </div>
    </body>
    </html>
  `);
});

// 5. Endpoint WebSocket para la extensión de Chrome
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
  console.log(`[+] Extensión (Compu 1) conectada exitosamente a la sala ${code}`);

  // Confirmar conexión lista
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

  ws.on.call(ws, 'close', () => {
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
