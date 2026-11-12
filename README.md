# Consulta SUNAT Bot

Herramienta local para **listar comprobantes ya emitidos o recibidos** desde el portal de SUNAT (SOL) y descargar su **XML, PDF y CDR** cuando SUNAT lo entrega. También extrae el **detalle por ítem** desde el XML.

Incluye un módulo **multiempresa** para revisar el **Buzón SOL (Notificaciones y Mensajes)** y dejar cada aviso listo para enviar por **WhatsApp** (enlace `wa.me`) o enviarlo automáticamente por WhatsApp Web con Baileys.

Para **facturas/boletas emitidas y rechazadas** automatiza con Playwright el módulo **SEE - SOL**. Para **comprobantes recibidos** usa la API de **SIRE RCE** (listado del periodo) y el endpoint interno de **Consulta de Comprobante de Pago** (XML, PDF y CDR) que consume el portal de SUNAT, autenticándose con el token que genera el menú SOL. No requiere crear credenciales de API SUNAT ni usa la API pública de consulta (`validarcomprobante`).

## Requisitos

- Node.js 20 o superior.
- Clave SOL con acceso al portal de SUNAT.
- Chromium de Playwright.
- Ejecutarlo en tu PC (no en un servidor de producción).

## Instalación

```bash
cd sunat-consulta-bot
npm install
npx playwright install chromium
cp .env.example .env
```

Con pnpm:

```bash
pnpm install
pnpm exec playwright install chromium
cp .env.example .env
```

Edita `.env` con tu RUC, usuario y clave SOL, o déjalo vacío para que el bot los pida al iniciar.

## Uso

### Interfaz web local (recomendado)

```bash
npm run ui
# o con pnpm:
pnpm run ui
```

Compila la UI (React + shadcn/ui) y abre `http://127.0.0.1:3131` en el navegador. Desde ahí puedes ingresar RUC, usuario y clave SOL, elegir el periodo con un calendario shadcn, el documento (facturas/boletas), el tipo, ver el progreso, revisar el detalle por ítem y descargar XML/PDF/CDR. El servidor escucha solo en `127.0.0.1`.

Variables opcionales: `UI_PORT` (default `3131`) y `UI_OPEN=false` para no abrir el navegador automáticamente.

La UI inicia con Chromium oculto. Si SUNAT pide captcha, marca **Mostrar navegador** antes de consultar.

Si modificas la UI puedes recompilar con `npm run build:ui`. Para desarrollo con recarga en caliente usa `npm run dev:ui` (y el API en otra terminal con `node src/server.js`).

### CLI

Modo interactivo:

```bash
npm start
```

Consulta directa:

```bash
npm start -- --desde 2026-09-01 --hasta 2026-09-30 --tipo 10
npm start -- --documento boleta --desde 2026-09-01 --hasta 2026-09-30 --tipo 10
```

Ejemplo completo:

```bash
npm run consulta -- \
  --ruc 20123456789 \
  --user MIUSUARIO \
  --password "MI_CLAVE_SOL" \
  --desde 2026-09-01 \
  --hasta 2026-09-30 \
  --tipo 10
```

### Opciones

| Opción | Descripción |
|---|---|
| `--ruc` | RUC de la empresa (11 dígitos) |
| `--user` | Usuario SOL |
| `--password` | Clave SOL |
| `--desde` | Fecha inicial (`YYYY-MM-DD` o `DD/MM/YYYY`) |
| `--hasta` | Fecha final (`YYYY-MM-DD` o `DD/MM/YYYY`) |
| `--documento` | `factura` o `boleta` (default: `factura`) |
| `--tipo` | `10` emitidas, `11` recibidas, `12` rechazadas, `13/14` notas de crédito, `15/16` notas de débito |
| `--salida` | Carpeta de salida (default: `./output/<fecha>_tipo<código>`) |
| `--sin-pdf` | No descargar PDF |
| `--sin-xml` | No guardar XML (igual descarga para leer el detalle) |
| `--solo-listar` | Solo lista; no descarga ni parsea |
| `--max` | Procesar como máximo N comprobantes (útil para probar) |
| `--visible` | Fuerza el navegador visible (útil si SUNAT pide captcha) |
| `--headless` | Fuerza el navegador oculto (default) |
| `--doctor` | Diagnóstico de instalación |
| `--help` | Ayuda |

## Buzón SOL y WhatsApp (multiempresa)

La pestaña **Buzón SOL** de la interfaz permite registrar varias empresas (RUC, usuario SOL, clave y número de WhatsApp), revisar sus notificaciones y mensajes, y preparar el mensaje para WhatsApp.

Características:

- **Solo metadatos por defecto**: asunto, tipo, fecha, urgencia y cantidad de adjuntos. No abre el detalle, por lo que SUNAT **no marca los mensajes como leídos**.
- **Descarga opcional de adjuntos**: con el check **“Descargar adjuntos y marcar como leído”**, el bot abre el detalle (SUNAT lo marca como leído de forma irreversible), descarga los PDFs y los guarda en `buzon/attachments/`.
- **Multiempresa**: cada empresa tiene su propio RUC, credenciales, WhatsApp y revisión independiente.
- **Mensaje listo para enviar**: abre `wa.me` con el texto ya escrito, o cópialo. También puede marcar el aviso como enviado.
- **Envío automático opcional** por WhatsApp Web (Baileys) escaneando un QR desde la UI. Si los adjuntos están descargados, se envían como archivos junto al texto.
- **Línea base**: la primera revisión no envía nada; solo guarda el estado para detectar novedades desde la segunda revisión.
- **Scheduler opcional**: `BUZON_AUTO=true` revisa las empresas activas cada `BUZON_INTERVAL_MIN` minutos (default 15).

### Cómo usarlo

1. `npm run ui` y abre la pestaña **Buzón SOL**.
2. **Agregar empresa** con RUC, usuario SOL, clave SOL y WhatsApp con código de país (ej. `51987654321`).
3. Pulsa **Revisar todas** (o el botón de una empresa). La primera vez crea la línea base. Si SUNAT pide captcha, marca **Mostrar navegador**. Si quieres los PDFs adjuntos, edita la empresa y marca **Descargar adjuntos y marcar como leído** (la opción queda guardada por empresa).
4. En cada novedad pulsa **Preparar** para abrir el mensaje listo, copiarlo o abrir WhatsApp. Si hay adjuntos descargados, aparecen como enlaces y se envían por WhatsApp Web junto al texto.
5. Para envío automático, en el panel **WhatsApp** pulsa **Conectar WhatsApp** y escanea el QR desde *WhatsApp → Dispositivos vinculados*.

También puedes ejecutarlo sin la UI:

```bash
# Revisar todas las empresas activas y mostrar novedades
npm run buzon -- --all

# Revisar una empresa y enviar las novedades por WhatsApp Web
npm run buzon -- --empresa 20123456789 --enviar

# Revisar cada 15 minutos (cron interno)
npm run buzon:watch -- --all --enviar --interval 15
```

### Advertencia sobre WhatsApp

El envío automático usa **WhatsApp Web (Baileys)**, que **no es un canal oficial**. WhatsApp puede **bloquear el número** si detecta envíos masivos o no solicitados. Úsalo con moderación y solo para números que hayan dado su consentimiento. Para producción, usa la API oficial de WhatsApp Cloud o el modo de mensaje listo para enviar manualmente.

### Datos y seguridad

- `empresas.json` guarda las empresas con la clave SOL **cifrada** (AES-256-GCM) y permisos `0600`. La clave local `.buzon.key` se genera sola; puedes usar `SUNAT_MASTER_KEY` para tu propia clave maestra.
- El estado de avistamientos y lo enviado queda en `buzon/state.json`; la sesión de WhatsApp en `whatsapp-auth/`.
- `empresas.json`, `.buzon.key`, `whatsapp-auth/` y `buzon/` están en `.gitignore`.
- El servidor sigue escuchando solo en `127.0.0.1`.

## Salida

```text
output/2026-10-20-22-30-00_tipo10/
├── comprobantes.json   # listado + detalle por ítem
├── comprobantes.csv    # resumen para Excel
├── items.csv           # una fila por ítem
├── errores.csv         # comprobantes con error
├── LEEME.txt           # solo si no hubo archivos o quedaron errores
├── xml/                # XML firmado de cada comprobante
├── pdf/                # representación impresa
└── cdr/                # CDR, solo si SUNAT lo incluye
```

El JSON es el más completo: incluye emisor, cliente, totales, ítems y rutas de los archivos descargados.

En el historial de la app, cada consulta muestra los archivos descargados (`N archivo(s)`), los errores y los CDR faltantes. Si se ejecutó con **Solo listar (sin XML)**, el estado dice **Solo listado**; si no se descargó ningún archivo, dice **Sin archivos** (o **Error** si además hubo fallos). El botón de carpeta del historial abre la ubicación real de esa consulta.

## Cómo funciona

1. Inicia sesión en `api-seguridad.sunat.gob.pe` con RUC + usuario + clave SOL.
2. Según el tipo de consulta:
   - **Emitidas/rechazadas**: navega el menú SOL hasta **Empresas → Comprobantes de pago → SEE - SOL → Factura Electrónica → Consultar Factura y Nota** (facturas) o **Boleta de Venta Electrónica → Consultar Boleta de Venta y Nota** (boletas), detecta la URL real del iframe y consulta por rango de fechas.
   - **Recibidas (11/14/16)**: obtiene el token del menú SOL para **SIRE RCE**, descarga la propuesta del mes y la usa como lista de comprobantes. Luego consulta cada uno en **Consulta de Comprobante de Pago** y baja XML, PDF y CDR.
3. Extrae el detalle UBL 2.1 desde el XML de cada comprobante.
4. Guarda todo en la carpeta de salida. Las recibidas se procesan con concurrencia configurable (`SUNAT_CONCURRENCY`, default 2) porque SUNAT tarda ~10 s por archivo.

La sesión se reutiliza durante 10 minutos en `.session/<RUC>.json` para no iniciar sesión por cada archivo (las consultas a recibidas hacen login limpio).

## Notas y limitaciones

- **No es una API pública documentada**: usa el portal (Playwright) para emitidas y, para recibidas, la API de SIRE RCE (documentada) más el endpoint interno `consultacpe`, que no está documentado públicamente. SUNAT puede cambiar el portal, los selectores o `consultacpe` sin aviso. Si eso pasa, habrá que actualizar los XPath del menú o el flujo correspondiente.
- El **Buzón SOL** usa el visor interno `ww1.sunat.gob.pe/ol-ti-itvisornoti/visor`, que tampoco es una API documentada. Por defecto se consultan solo metadatos para no marcar los mensajes como leídos. Si habilitas **Descargar adjuntos y marcar como leído**, se abre el detalle y SUNAT lo marca como leído de forma irreversible.
- En algunos mensajes el visor legacy devuelve el mismo `codArchivo` para varios PDFs y entrega el mismo archivo. En ese caso el bot descarga el que SUNAT expone y avisa en la app que no pudo bajar el resto.
- SUNAT puede pedir **captcha** o bloquear intentos repetidos. Usa `--visible` para resolverlo manualmente.
- En **emitidas**, el **CDR** solo se guarda si viene dentro del ZIP que entrega el módulo. En **recibidas** se intenta descargar por separado (`/03`). Si SUNAT no lo tiene, no hay forma de recuperarlo retroactivamente.
- El detalle por ítem sale del **XML**; el listado del portal no lo incluye.
- Las **recibidas** se consultan por mes (SIRE RCE); no se puede pedir un rango de varios meses en una sola consulta.
- Las recibidas se procesan en paralelo (`SUNAT_CONCURRENCY`, default 2) porque SUNAT tarda ~10 s por archivo. Si SUNAT responde con error 500, el bot reintenta los fallidos al final; puedes bajar la concurrencia a 1.
- Las emitidas se procesan de forma secuencial para no saturar el portal.
- No compartas `.env` ni `.session/`: contienen credenciales o cookies de tu cuenta.

## Seguridad

- `.env`, `.session/` y `output/` están en `.gitignore`.
- Las credenciales no se guardan en disco; solo se guarda la sesión del navegador (cookies) en `.session/`. Puedes borrar esa carpeta cuando quieras.

## Empaquetar como aplicación de Windows

La app usa **Electron** para la ventana y empaqueta el servidor local + la UI + Chromium de Playwright.

Requisitos: hacer el build **en Windows** (para incluir los binarios de Chromium de Windows) con Node.js 20+.

```bash
pnpm install
pnpm run dist:win
```

`dist:win` compila la UI, instala Chromium local y genera en `dist-electron/`:

- `Consulta SUNAT-Setup-1.0.0-x64.exe` (instalador NSIS)
- `Consulta SUNAT-Portable-1.0.0-x64.exe` (versión portable)

Notas:

- `install:browsers:local` descarga Chromium en `playwright-browsers/`; es lo que se incluye en el paquete. El script `dist:win` ya lo ejecuta.
- El historial y los archivos se guardan en `%APPDATA%\Consulta SUNAT` (no dentro de `Program Files`).
- La app no está firmada digitalmente; Windows SmartScreen puede mostrar una advertencia. Para distribuirla sin advertencias hay que firmarla con un certificado de código.
- Para desarrollo de la ventana Electron: `pnpm run electron:dev`.

## GitHub Actions (build automático para Windows)

El workflow está en `.github/workflows/build-windows.yml`.

Requisitos: subir este proyecto como repositorio (con `package.json` en la raíz) y tener Actions habilitado.

Formas de ejecutarlo:

1. **Manual**: GitHub → Actions → **Build Windows** → **Run workflow**. Descarga los `.exe` desde los artifacts del run.
2. **Por tag**: crea y sube un tag, por ejemplo `v1.0.0`. Además de compilar, publica el instalador y el portable como assets del Release.

El workflow:
- Usa `windows-latest`, Node 22 y pnpm 11.
- Instala Chromium de Playwright para Windows.
- Genera el instalador NSIS y el portable.
- Sube `dist-electron/*.exe` como artifact.
- En tags `v*`, crea el Release con los `.exe`.
