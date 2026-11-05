# URLBridge Server

Servidor relé en Node.js para conectar la extensión de Chrome **URLBridge** con otros dispositivos.

## Despliegue en Render.com

1. Sube estos archivos a un nuevo repositorio de GitHub.
2. Entra a [Render.com](https://render.com) y crea un nuevo **Web Service**.
3. Conecta tu repositorio de GitHub.
4. Render detectará automáticamente Node.js. Asegúrate de configurar:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
5. Al finalizar el despliegue, copia la URL que te asigna Render (ejemplo: `https://urlbridge-server.onrender.com`).
6. Pega esa URL en la sección **⚙︎ Ajustes > Servidor (relé)** de la extensión en Chrome.
