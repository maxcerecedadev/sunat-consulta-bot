# Consulta SUNAT Bot

Herramienta local para **listar comprobantes ya emitidos o recibidos** desde el portal de SUNAT (SOL) y descargar su **XML, PDF y CDR** cuando SUNAT lo entrega. También extrae el **detalle por ítem** desde el XML.

Para **facturas/boletas emitidas y rechazadas** automatiza con Playwright el módulo **SEE - SOL**. Para **comprobantes recibidos** usa las APIs oficiales de **SIRE RCE** (listado del periodo) y **Consulta de Comprobante de Pago** (XML, PDF y CDR), autenticándose con el token que genera el menú SOL. No requiere crear credenciales de API SUNAT.

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

## Salida

```text
output/2026-10-20-22-30-00_tipo10/
├── comprobantes.json   # listado + detalle por ítem
├── comprobantes.csv    # resumen para Excel
├── items.csv           # una fila por ítem
├── errores.csv         # comprobantes con error
├── xml/                # XML firmado de cada comprobante
├── pdf/                # representación impresa
└── cdr/                # CDR, solo si SUNAT lo incluye
```

El JSON es el más completo: incluye emisor, cliente, totales, ítems y rutas de los archivos descargados.

## Cómo funciona

1. Inicia sesión en `api-seguridad.sunat.gob.pe` con RUC + usuario + clave SOL.
2. Según el tipo de consulta:
   - **Emitidas/rechazadas**: navega el menú SOL hasta **Empresas → Comprobantes de pago → SEE - SOL → Factura Electrónica → Consultar Factura y Nota** (facturas) o **Boleta de Venta Electrónica → Consultar Boleta de Venta y Nota** (boletas), detecta la URL real del iframe y consulta por rango de fechas.
   - **Recibidas (11/14/16)**: obtiene el token del menú SOL para **SIRE RCE**, descarga la propuesta del mes y la usa como lista de comprobantes. Luego consulta cada uno en **Consulta de Comprobante de Pago** y baja XML, PDF y CDR.
3. Extrae el detalle UBL 2.1 desde el XML de cada comprobante.
4. Guarda todo en la carpeta de salida. Las recibidas se procesan con concurrencia configurable (`SUNAT_CONCURRENCY`, default 3) porque SUNAT tarda ~10 s por archivo.

La sesión se reutiliza durante 10 minutos en `.session/<RUC>.json` para no iniciar sesión por cada archivo (las consultas a recibidas hacen login limpio).

## Notas y limitaciones

- **No es una API oficial**: SUNAT puede cambiar el portal o los selectores. Si eso pasa, habrá que actualizar los XPath del menú.
- SUNAT puede pedir **captcha** o bloquear intentos repetidos. Usa `--visible` para resolverlo manualmente.
- El **CDR** solo se guarda si viene dentro del ZIP que entrega el módulo. Si no viene, no hay forma de recuperarlo retroactivamente desde SUNAT.
- El detalle por ítem sale del **XML**; el listado del portal no lo incluye.
- Las **recibidas** se consultan por mes (SIRE RCE); no se puede pedir un rango de varios meses en una sola consulta.
- Las recibidas se procesan en paralelo (`SUNAT_CONCURRENCY`, default 3) porque SUNAT tarda ~10 s por archivo. Bájalo si SUNAT responde con errores.
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
