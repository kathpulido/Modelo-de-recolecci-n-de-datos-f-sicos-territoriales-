-- ══════════════════════════════════════════════════════════════════
--  MIGRACIÓN: respuestas por voz (transcripciones) y fotos del registro
--
--  Ejecutar una sola vez sobre la base existente:
--      psql -U postgres -d catastro_etnico -f migrate_voz_fotos.sql
--
--  Es segura de correr más de una vez: todo usa IF NOT EXISTS y no
--  modifica ni borra datos que ya estén guardados.
--
--  Qué agrega:
--    1. ext_transcripcion_respuesta — lo que la persona dijo textualmente
--       en cada pregunta que respondió hablando. NO se guarda el audio:
--       el archivo se borra apenas se transcribe, solo queda el texto.
--    2. ext_foto_registro — las fotos opcionales que adjunta la comunidad
--       (documento legal, plano, linderos, zonas especiales, restricciones,
--       el territorio y la comunidad reunida).
-- ══════════════════════════════════════════════════════════════════

BEGIN;

-- ──────────────────────────────────────────────────────────────
-- 1. Transcripción de las respuestas habladas
--
--    Una fila por pregunta respondida con nota de voz. Guarda tanto lo
--    que la persona dijo literalmente (transcripcion) como el valor que
--    el bot interpretó y guardó en su columna normal (valor_interpretado).
--    Tener ambos permite auditar después si la interpretación fue
--    correcta, sin depender de conservar los audios.
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ext_transcripcion_respuesta (
    id                 SERIAL       PRIMARY KEY,
    comunidad_id       INTEGER      NOT NULL REFERENCES tpc_interesado_comunidad(id) ON DELETE CASCADE,
    pregunta_clave     VARCHAR(80)  NOT NULL,  -- p.ej. 'tipo_comunidad', 'familias_aprox'
    transcripcion      TEXT         NOT NULL,  -- lo que dijo, tal cual lo entendió Whisper
    valor_interpretado TEXT,                   -- lo que quedó guardado en su columna
    fecha              TIMESTAMP    DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transcripcion_comunidad
    ON ext_transcripcion_respuesta (comunidad_id);
CREATE INDEX IF NOT EXISTS idx_transcripcion_pregunta
    ON ext_transcripcion_respuesta (pregunta_clave);

-- ──────────────────────────────────────────────────────────────
-- 2. Fotos del registro (todas opcionales)
--
--    predio_id queda nulo si la foto no corresponde a un predio concreto
--    (por ejemplo la foto de la comunidad reunida).
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ext_foto_registro (
    id           SERIAL       PRIMARY KEY,
    comunidad_id INTEGER      NOT NULL REFERENCES tpc_interesado_comunidad(id) ON DELETE CASCADE,
    predio_id    INTEGER      REFERENCES tpc_predio(id) ON DELETE CASCADE,
    categoria    VARCHAR(60)  NOT NULL,  -- documento_legal | plano_mapa | limites_territorio |
                                         -- zonas_especiales | restriccion | territorio | comunidad_reunida
    ruta_archivo TEXT         NOT NULL,  -- ruta local del .jpg dentro de la carpeta fotos/
    descripcion  TEXT,                   -- el texto que la persona escribió junto a la foto
    fecha        TIMESTAMP    DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_foto_comunidad ON ext_foto_registro (comunidad_id);
CREATE INDEX IF NOT EXISTS idx_foto_categoria ON ext_foto_registro (categoria);

COMMIT;

-- ──────────────────────────────────────────────────────────────
-- Comprobación rápida (opcional): muestra si quedaron creadas
-- ──────────────────────────────────────────────────────────────
SELECT table_name AS tabla_creada
FROM information_schema.tables
WHERE table_name IN ('ext_transcripcion_respuesta', 'ext_foto_registro')
ORDER BY table_name;
