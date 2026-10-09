# Cómo ejecutar todo

Guía completa del sistema: chatbot de WhatsApp + visor geográfico.

---

# PARTE 1 — Una sola vez

Estos pasos se hacen una vez y no se repiten (salvo que cambies de computador).

## 1.1 Migraciones de la base de datos

Cinco archivos, **en este orden**. Desde la carpeta del proyecto, en PowerShell:

```powershell
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -d catastro_etnico -f migrate_postgis.sql
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -d catastro_etnico -f migrate_perimetro.sql
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -d catastro_etnico -f migrate_voz_fotos.sql
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -d catastro_etnico -f migrate_ladm.sql
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -d catastro_etnico -f migrate_familias.sql
```

> Si instalaste una versión distinta de PostgreSQL, cambia el `18` por el
> número que corresponda (por ejemplo `17`). Puedes confirmar cuál tienes
> abriendo la carpeta `C:\Program Files\PostgreSQL\` en el explorador.

> El `&` del inicio es obligatorio en PowerShell cuando la ruta va entre
> comillas; sin él lo interpreta como texto y no como programa.

Te pedirá la contraseña de `postgres` en cada uno. Son seguras de correr más
de una vez: si ya estaban aplicadas, no dañan nada.

**Cómo saber si quedaron bien:** al arrancar el visor debe decir
`✅ Migraciones al día`. Si falta alguna, te dice cuál.

| Archivo | Para qué |
|---|---|
| `migrate_postgis.sql` | Activa PostGIS, la columna de coordenadas y el usuario del visor |
| `migrate_perimetro.sql` | Los polígonos del territorio (croquis y recorrido GPS) |
| `migrate_voz_fotos.sql` | Transcripciones de las respuestas habladas y las fotos |
| `migrate_ladm.sql` | Alineación con el modelo LADM-COL: catálogos de enumeración, topología del lindero y las clases que faltaban |
| `migrate_familias.sql` | Levantamiento por familias dentro del territorio colectivo, y el censo declarado frente al medido |

Al final, para ver qué tanto del modelo quedó cubierto y cómo va el censo:

```powershell
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -d catastro_etnico -c "SELECT * FROM vista_ladm_cobertura;"
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -d catastro_etnico -c "SELECT * FROM vista_censo_comunidad;"
```

## 1.2 Cambiar la contraseña del administrador

```powershell
node scripts/cambiar-password.mjs
```

La migración crea `admin` con `admin123`. Cámbiala antes de publicar el
visor: con esa clave cualquiera puede entrar y usar el endpoint que envía
mensajes de WhatsApp desde tu número.

## 1.3 Los audios de las preguntas

Ya están generados (47 archivos en `Preguntas/`). Solo hay que regenerarlos
si cambias el texto de alguna pregunta:

```powershell
node generar_audios_azure.mjs
```

Los que ya existen se omiten; para rehacer todos, borra la carpeta primero.

## 1.4 Revisar el .env

Debe tener estas claves:

```
POSTGRES_DB_HOST, POSTGRES_DB_USER, POSTGRES_DB_NAME,
POSTGRES_DB_PASSWORD, POSTGRES_DB_PORT     → base de datos
META_JWT_TOKEN, META_NUMBER_ID, META_VERIFY_TOKEN   → WhatsApp
GROQ_API_KEY                → transcripción de las notas de voz
AZURE_SPEECH_KEY, AZURE_SPEECH_REGION      → generar los audios
MAPBOX_TOKEN                → mapa base del visor
NGROK_STATIC_DOMAIN         → dirección fija del visor
GEOVISOR_PORT, GEOVISOR_JWT_SECRET         → visor
```

---

# PARTE 2 — Cada vez que trabajes

Son **dos terminales**, cada una con lo suyo. Ábrelas en la carpeta del
proyecto.

## Terminal 1 — El chatbot

```powershell
npm run start:all
```

Levanta el túnel de Cloudflare y luego el bot. Está listo cuando ves:

```
🌐 URL pública (Cloudflare Tunnel): https://algo.trycloudflare.com
🔊 Audio cache: 47 archivo(s) en Preguntas/
✅ PostgreSQL conectado correctamente
✅ Connected Provider
```

⚠️ **Copia esa URL**: mientras uses el túnel temporal, cambia en cada
reinicio y hay que actualizarla en Meta (ver 2.3). Para que deje de
cambiar, ver `PUBLICAR.md`.

## Terminal 2 — El visor geográfico

Para trabajar tú sola en el computador:

```powershell
npm run geovisor
```

→ <http://localhost:3009>

Para que otros lo abran desde internet (dirección fija de ngrok):

```powershell
npm run geovisor:publico
```

→ `https://TU-DOMINIO.ngrok-free.dev`

Está listo cuando ves `✅ PostgreSQL conectado`, `✅ Migraciones al día` y
`📡 PostgreSQL LISTEN activo`.

## 2.3 Actualizar el webhook en Meta

Solo hace falta **si la URL del túnel cambió** (es decir, si reiniciaste la
Terminal 1 y usas el túnel temporal).

En **Meta for Developers → tu App → WhatsApp → Configuración → Webhook**:

- **Callback URL:** la URL de la Terminal 1 + `/webhook`
- **Verify token:** el valor de `META_VERIFY_TOKEN` de tu `.env`

Y revisa que el campo **`messages`** esté activado en *Webhook fields*; sin
eso Meta no te entrega los mensajes entrantes.

---

# PARTE 3 — Probar que todo funciona

1. Escríbele **hola** al número del bot desde WhatsApp.
2. En la Terminal 1 debe aparecer `👤 Remitente identificado` y `📤 Enviado`.
3. Avanza el registro: comparte la ubicación cuando la pida, prueba
   responder alguna pregunta con **nota de voz** (debe contestarte
   `🎙️ Audio transcrito:` con lo que entendió), y llega hasta el croquis.
4. Abre el enlace del croquis, dibuja el polígono y guarda.
5. Termina el registro en WhatsApp.
6. En el visor, el aviso 🔔 debe saltar solo con el registro nuevo, y el
   territorio aparece en el mapa. Tócalo para ver la ficha completa.

---

# Si algo falla

| Síntoma | Causa más probable |
|---|---|
| `"cloudflared" no se reconoce` | Falta instalarlo: `winget install --id Cloudflare.cloudflared`, y abrir una terminal **nueva** |
| El bot no responde y la consola no muestra nada | El webhook de Meta apunta a una URL vieja (paso 2.3) |
| `Audio cache: 0 archivo(s)` | Falta correr `node generar_audios_azure.mjs` |
| El visor dice que faltan migraciones | Correr la que indique (paso 1.1) |
| El visor abre pero sin datos | ¿Hay registros completos en la base? Se guardan solo al terminar el registro |
| La ficha no muestra fotos ni transcripciones | Falta `migrate_voz_fotos.sql` |
| El mapa del visor sale vacío | Revisa `MAPBOX_TOKEN` en el `.env`; sin él usa OpenStreetMap igual |

---

# Resumen para el día a día

```powershell
# Terminal 1
npm run start:all

# Terminal 2
npm run geovisor:publico
```

Y actualizar el webhook en Meta solo si cambió la URL del túnel.
