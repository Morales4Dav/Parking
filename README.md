# Parking Center

Software de gestión de parking que integra equipos de diferentes fabricantes
(cámaras LPR, barreras, relés IP) bajo un único motor de control de accesos,
tarifas y abonados.

## Funcionalidades

- **Control de accesos por matrícula**: entrada/salida automática, lista blanca, lista negra, abonados con periodo de validez, anti-passback opcional, filtro de lecturas duplicadas.
- **Ocupación por zonas** con aforo máximo (deniega visitantes con el parking completo).
- **Tarifas** por fracciones con minutos de cortesía, máximo diario y margen de salida tras el pago.
- **Cobro** desde el panel (las salidas no pagadas quedan bloqueadas o se abren según configuración).
- **Panel web** en tiempo real (SSE): ocupación, eventos, apertura/cierre manual de barreras, lectura manual de matrículas.
- **Informes**: entradas, salidas, recaudación, accesos denegados y errores de barrera.
- **Auditoría**: todos los eventos y decisiones quedan registrados.

## Fabricantes soportados

| Driver | Lectura de matrículas | Barrera |
|---|---|---|
| `hikvision` | Alarm Server HTTP (ISAPI `EventNotificationAlert` ANPR, XML/multipart/JSON) | `PUT /ISAPI/Parking/channels/<canal>/barrierGate` |
| `dahua` | HTTP Upload / Event Push (JSON con `PlateNumber`) | `trafficSnap.cgi?action=openStrobe` |
| `milesight` | HTTP Post JSON | URL de relé (`options.openUrl`) |
| `generic-http` | JSON con campo configurable o `?plate=` | URL de relé (Shelly, controladoras IP, PLC…) |
| `simulator` | Desde el panel | Virtual |

La autenticación Digest/Basic hacia los equipos está incluida. Todo driver acepta
`options.openUrl` para abrir mediante un relé externo en lugar de la propia cámara.

> Los formatos de evento de cada fabricante varían según modelo y firmware.
> Los parsers son tolerantes, pero hay que validarlos con los equipos reales antes de una instalación.

### Añadir un fabricante

Crear `src/drivers/<marca>.js` con una clase que extienda `BaseDriver` e implemente
`parseEvent()`, `openBarrier()`, `closeBarrier()` y `testConnection()`, y registrarla en
`src/drivers/index.js`.

## Puesta en marcha

Requisitos: Node.js 22.5 o superior. Sin dependencias externas (usa SQLite nativo de Node).

```bash
npm start
```

Abre http://localhost:8080. Si la base de datos está vacía se cargan datos de demo
(carriles `E1`/`S1` con cámaras simuladas, abonado `1234ABC`, lista negra `6666XXX`).

Variables de entorno:

| Variable | Descripción | Defecto |
|---|---|---|
| `PORT` | Puerto HTTP | `8080` |
| `PARKING_DB` | Ruta de la base de datos SQLite | `data/parking.db` |
| `PARKING_ADMIN_PASSWORD` | Contraseña (Basic auth) para panel y API | sin autenticación |
| `PARKING_INGEST_TOKEN` | Token exigido en `/api/ingest/<id>?token=…` | sin token |

## Configurar una instalación

1. **Dispositivos**: alta de cada cámara/controladora con su driver, IP y credenciales. Botón *Probar* para verificar conexión.
2. En cada cámara, configurar el envío de eventos HTTP a `http://<servidor>:8080/api/ingest/<ID del dispositivo>`.
3. **Zonas**: plazas de cada zona.
4. **Carriles**: sentido (entrada/salida), cámara que lee, barrera que actúa (si se deja vacío, actúa la propia cámara) y zona.
5. **Abonados y listas** y **Tarifas y acceso** según el cliente.

## API principal

| Método | Ruta | Uso |
|---|---|---|
| POST/GET | `/api/ingest/:deviceId` | Recepción de eventos de los equipos |
| GET | `/api/status` | Ocupación |
| GET | `/api/stream` | Eventos en tiempo real (SSE) |
| GET/POST/PUT/DELETE | `/api/devices[/:id]` | Dispositivos (`POST /:id/test` prueba conexión) |
| GET/POST/DELETE | `/api/zones`, `/api/lanes` | Zonas y carriles |
| POST | `/api/lanes/:id/open` · `/close` · `/read` | Barrera manual / lectura manual |
| GET/POST/DELETE | `/api/vehicles[/:plate]` | Abonados, lista blanca y negra |
| GET | `/api/stays?status=inside` | Estancias |
| GET/POST | `/api/stays/:id/quote` · `/pay` · `/cancel` | Cobro y anulación |
| GET | `/api/events`, `/api/reports/summary` | Auditoría e informes |
| GET/PUT | `/api/settings` | Tarifa y reglas de acceso |

## Tests

```bash
npm test
```

## Estructura

```
src/
  server.js        API REST, ingesta, SSE y ficheros estáticos
  engine.js        Motor de decisiones (entradas, salidas, cobros, ocupación)
  tariff.js        Cálculo de tarifas
  db.js            Esquema SQLite y configuración
  lib/http-client  Cliente HTTP con Digest/Basic
  drivers/         Un driver por fabricante
public/            Panel web
test/              Tests (node:test)
```
