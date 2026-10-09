# Publicar el sistema en un dominio fijo

Guía para que el chatbot y el visor geográfico queden en direcciones que
**no cambian nunca**, sirviendo desde tu propio computador.

---

## Por qué no lo subimos a un hosting gratuito

Se evaluó Render, Railway y Fly.io. Tu sistema tiene tres cosas que sus
planes gratuitos rompen:

1. **Las fotos se guardan en disco** (`fotos/`). Esas plataformas usan disco
   efímero: en cada reinicio se borran los archivos y las fichas quedarían con
   imágenes rotas.
2. **El aviso en vivo** usa `LISTEN/NOTIFY` de PostgreSQL con una conexión
   permanente. El plan gratuito de Render duerme el servicio a los 15 minutos
   de inactividad y tarda cerca de un minuto en despertar.
3. **La base de datos gratuita de Render se elimina a los 30 días de creada.**
   Para una tesis eso significa perder el trabajo a mitad de semestre.

Tu computador ya tiene PostGIS, las fotos y los dos servicios funcionando.
Lo único que falta es la puerta de entrada — y eso lo resuelve el túnel.

---

## Paso 1 — Cambiar la contraseña del administrador (antes de publicar)

La migración inicial creó el usuario `admin` con la contraseña `admin123`.
Publicar el visor sin cambiarla deja los datos de las comunidades —
polígonos, nombres y documentos de sus autoridades — al alcance de
cualquiera que la adivine.

```
node scripts/cambiar-password.mjs
```

Pide una contraseña nueva (no se ve mientras la escribes) y la guarda
cifrada. **No sigas al paso 2 sin haber hecho esto.**

---

## Paso 2 — Conseguir el dominio

Tres caminos, de más barato a más confiable:

### Opción A — `.eu.org` (gratis y permanente)

Registro gratuito en <https://nic.eu.org>. Te queda algo como
`catastroetnico.eu.org` y permite apuntar los nameservers a Cloudflare,
que es lo que el túnel necesita.

**Contra:** la aprobación es manual y puede tardar de días a semanas. Si tu
sustentación está cerca, no te la juegues con esta opción.

### Opción B — Dominio propio barato (lo recomendado para la tesis)

Entre 3 y 12 dólares al año. Queda listo en minutos, es tuyo, y en una
sustentación se ve mejor que un subdominio gratuito. Cloudflare mismo los
vende a precio de costo en <https://dash.cloudflare.com> → *Domain Registration*.

### Opción C — Tu dominio fijo de ngrok (ya lo tienes, cero costo)

Sirve bien para el **visor**, porque tú y el jurado lo abrirán desde
computador, donde la pantalla de aviso de ngrok sí deja pasar. El problema
que tuvimos era en Safari de celular, y eso afecta al croquis del chatbot,
no al visor. Si eliges esta, no necesitas nada de lo que sigue.

---

## Paso 3 — Conectar el dominio a Cloudflare

1. Entra a <https://dash.cloudflare.com>, crea una cuenta gratuita y elige
   **Add a site**. Escribe tu dominio y toma el plan **Free**.
2. Cloudflare te dará dos nameservers. Cámbialos donde compraste el dominio
   (en `.eu.org` se hace desde su panel). Tarda entre minutos y unas horas
   en propagarse.

---

## Paso 4 — Crear el túnel fijo

En una terminal, dentro de la carpeta del proyecto:

```
cloudflared tunnel login
```

Se abre el navegador: elige tu dominio y autoriza. Luego:

```
cloudflared tunnel create catastro
```

Ese comando imprime un **ID** y la ruta del archivo `.json` de credenciales.
Anótalos, los necesitas en el paso siguiente.

Ahora se le dicen a Cloudflare los dos nombres que va a atender:

```
cloudflared tunnel route dns catastro bot.TU-DOMINIO
cloudflared tunnel route dns catastro visor.TU-DOMINIO
```

---

## Paso 5 — Configurar qué atiende cada nombre

Copia el archivo `cloudflared-config.yml.ejemplo` de este proyecto a:

```
C:\Users\TU_USUARIO\.cloudflared\config.yml
```

y reemplaza adentro `NOMBRE-DEL-TUNEL`, `EL-ID-DEL-TUNEL`, `TU_USUARIO` y
`TU-DOMINIO` por los tuyos.

Queda así:

| Dirección | Atiende |
|---|---|
| `https://bot.TU-DOMINIO` | El chatbot: webhook de WhatsApp y las páginas de croquis y recorrido |
| `https://visor.TU-DOMINIO` | El visor geográfico |

---

## Paso 6 — Decirle al proyecto que use el túnel fijo

Agrega estas dos líneas a tu `.env`:

```
TUNEL_NOMBRE=catastro
TUNEL_DOMINIO=TU-DOMINIO
```

Con eso, `npm run start:all` deja de crear un túnel temporal y usa el fijo.
`BOT_PUBLIC_URL` se ajusta solo a `https://bot.TU-DOMINIO`.

---

## Paso 7 — Configurar el webhook en Meta, una última vez

En **Meta for Developers → tu App → WhatsApp → Configuración → Webhook**:

- **Callback URL:** `https://bot.TU-DOMINIO/webhook`
- **Verify token:** el valor de `META_VERIFY_TOKEN` en tu `.env`

Esta vez es definitiva: como la dirección ya no cambia, no hay que volver a
tocarla en cada reinicio.

---

## Cómo queda el arranque diario

```
npm run start:all     → chatbot + túnel   (bot.TU-DOMINIO)
npm run geovisor      → visor geográfico  (visor.TU-DOMINIO)
```

Son dos procesos distintos, cada uno en su terminal. El túnel del primero
publica ambos, porque el `config.yml` enruta los dos nombres.

---

## Antes de compartir el enlace del visor

Este sistema muestra polígonos exactos de territorios de comunidades
étnicas, con nombres y documentos de sus autoridades y fotos del lugar. En
Colombia esa información tiene valor para minería ilegal, actores armados y
conflictos de linderos.

Vale la pena revisar tres cosas antes de repartir la dirección:

- La contraseña del administrador ya cambiada (paso 1).
- A quién le entregas el enlace y la clave. El visor pide autenticación, así
  que no basta con tener la URL, pero sí basta con tener las credenciales.
- Que lo que vas a mostrar públicamente sea consistente con lo que el bot le
  prometió a la gente al pedir su consentimiento: que los datos se usarían
  para el reconocimiento y la protección de sus derechos territoriales.

Si en algún momento sospechas que alguien más entró, cambia también
`GEOVISOR_JWT_SECRET` en el `.env`: eso cierra de inmediato todas las
sesiones abiertas.
