# Modelo de recolección de datos físicos territoriales

Código y documentación técnica de la tesis sobre **recolección participativa de datos catastrales en territorios colectivos de comunidades étnicas en Colombia**, mediante un chatbot de WhatsApp y un geovisor web, alineado con el modelo LADM-COL.

## Componentes

| Componente | Descripción | Ubicación |
|---|---|---|
| Bot de WhatsApp | Formulario conversacional con voz, croquis y recorrido GPS | `src/app.ts` |
| Geovisor | Mapa, edición de polígonos, planchas PDF, validación comunitaria | `src/geovisor.ts`, `public/` |
| Base de datos | PostgreSQL + PostGIS (modelo LADM-COL y extensiones propias) | `schema.sql`, `setup_db.sql`, `migrate_*.sql` |
| Diagramas | Modelos ER, físico y de diseño del sistema (draw.io) | `public/*.drawio` |
| Documentación | Diccionario de datos, brechas LADM, cómo ejecutar | `DICCIONARIO_BD.md`, `BRECHAS_LADM.md`, `COMO_EJECUTAR.md` |

## Cómo ejecutarlo

1. Copia `.env.example` a `.env` y completa tus propios valores.
2. Aplica el esquema y las migraciones SQL en orden (ver `COMO_EJECUTAR.md`).
3. `npm install` y luego `npm run dev`.

Consulta `COMO_EJECUTAR.md` para el detalle y `PUBLICAR.md` para exponer el geovisor.

## Datos y privacidad

Este repositorio **no contiene datos reales de comunidades**, ni credenciales, sesiones de WhatsApp, audios, fotos ni respaldos de la base de datos. Los territorios y conocimientos de las comunidades participantes se manejan bajo acuerdos de gobernanza de datos y no se publican.

> Usuario inicial del geovisor (`admin`) con contraseña de ejemplo definida en `migrate_postgis.sql`: **cámbiala de inmediato** (`scripts/cambiar-password.mjs`) y define `GEOVISOR_JWT_SECRET` propio.

## Autoría

Deysa Katherine Pulido Valenzuela — Universidad Distrital Francisco José de Caldas, Bogotá, Colombia.
Director: Álvaro Enrique Ortiz Dávila.

Construido sobre [BuilderBot](https://builderbot.app/) (ver `README_builderbot_original.md`).
