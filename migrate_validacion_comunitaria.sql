-- ============================================================================
--  migrate_validacion_comunitaria.sql
--
--  Validación comunitaria de lo levantado, por WhatsApp.
--
--  El registro ya preguntaba por la validación al final del formulario, pero
--  ahí la comunidad todavía no había visto el resultado: contestaba sobre
--  datos que acababa de dictar, sin el lindero dibujado delante. Con la
--  plancha ya generada se puede cerrar el círculo — mandarles el mapa de lo
--  que quedó capturado y esperar a que digan si están de acuerdo.
--
--  Tres cosas que esta migración resuelve y que son la parte difícil del
--  asunto:
--
--   1. QUÉ se validó. Una aprobación tiene que quedar amarrada a la
--      geometría exacta que la comunidad vio. Desde que el visor permite
--      corregir linderos, un territorio podría aparecer «validado»
--      mostrando un polígono que nadie aprobó. Por eso cada solicitud
--      guarda la huella de la geometría, y un disparador marca la
--      validación como caduca si el lindero cambia después.
--
--   2. QUIÉN validó. Solo el número registrado de la comunidad puede
--      responder, y queda anotado desde qué teléfono llegó el sí.
--
--   3. CON QUÉ RESPALDO. Un sí que llega de un teléfono es la revisión de
--      una autoridad, no el acuerdo de una asamblea. El catálogo
--      ext_validaciontipo ya distinguía las dos cosas; aquí se respeta esa
--      distinción en lugar de inflar el dato: WhatsApp escribe
--      «Revisada_Autoridades», y «Validada_Asamblea» queda reservado para
--      cuando exista un acta que lo respalde.
--
--  Aplicar después de migrate_ladm.sql y migrate_edicion_poligono.sql.
--  Es idempotente.
-- ============================================================================

BEGIN;

/* ===========================================================================
   1. HUELLA DE LA GEOMETRÍA
   ---------------------------------------------------------------------------
   Identifica una versión concreta del lindero. Si el polígono cambia aunque
   sea en un vértice, la huella cambia, y la validación que se dio sobre la
   versión anterior deja de aplicar.

   Se usa ST_AsBinary y no ST_AsText porque el texto arrastra diferencias de
   formato de números que harían cambiar la huella sin que la geometría
   hubiera cambiado de verdad.
=========================================================================== */
CREATE OR REPLACE FUNCTION fn_huella_geometria(p_predio_id INTEGER)
RETURNS TEXT
LANGUAGE sql STABLE AS $$
    SELECT CASE
             WHEN geom_perimetro IS NULL THEN NULL
             ELSE md5(ST_AsBinary(geom_perimetro))
           END
      FROM tpc_predio WHERE id = p_predio_id
$$;

COMMENT ON FUNCTION fn_huella_geometria IS
    'Huella md5 del perímetro de un predio. Sirve para saber si una validación comunitaria sigue correspondiendo a la geometría que la comunidad aprobó.';


/* ===========================================================================
   2. SOLICITUDES DE VALIDACIÓN
=========================================================================== */
CREATE TABLE IF NOT EXISTS ext_solicitud_validacion (
    id                  SERIAL PRIMARY KEY,
    comunidad_id        INTEGER NOT NULL REFERENCES tpc_interesado_comunidad(id) ON DELETE CASCADE,
    predio_id           INTEGER          REFERENCES tpc_predio(id) ON DELETE CASCADE,

    -- Token de la imagen que se le manda al teléfono. El bot y el navegador
    -- de la comunidad la piden sin iniciar sesión, así que la URL lleva este
    -- azar en vez del id del predio: sin él no se puede adivinar.
    token               VARCHAR(64) NOT NULL UNIQUE,

    huella_geometria    TEXT,
    area_ha_enviada     NUMERIC(14, 4),

    telefono_destino    VARCHAR(30),
    enviada_por         VARCHAR(160),
    fecha_envio         TIMESTAMP DEFAULT NOW(),
    vence_en            TIMESTAMP,

    -- enviada | aprobada | rechazada | caduca | vencida
    estado              VARCHAR(20) NOT NULL DEFAULT 'enviada',

    -- Respuesta sección por sección: {"lindero": true, "area": false, ...}
    -- Un «no» sobre todo el documento no le dice nada a quien tiene que
    -- corregir; separado por secciones, el rechazo ya llega diciendo dónde
    -- está el problema.
    secciones           JSONB,

    respuesta_texto     TEXT,
    audio_url           TEXT,
    transcripcion       TEXT,
    telefono_respuesta  VARCHAR(30),
    fecha_respuesta     TIMESTAMP,

    recordatorios       INTEGER DEFAULT 0,
    recordatorio_en     TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_solicitud_val_comunidad ON ext_solicitud_validacion (comunidad_id, fecha_envio DESC);
CREATE INDEX IF NOT EXISTS idx_solicitud_val_estado    ON ext_solicitud_validacion (estado);
CREATE INDEX IF NOT EXISTS idx_solicitud_val_telefono  ON ext_solicitud_validacion (telefono_destino, estado);

COMMENT ON TABLE ext_solicitud_validacion IS
    'Extensión LADM: envíos del levantamiento a la comunidad para su validación, con la versión de geometría que se envió y la respuesta recibida.';
COMMENT ON COLUMN ext_solicitud_validacion.huella_geometria IS
    'Huella del perímetro en el momento del envío. Si el lindero cambia después, la solicitud pasa a caduca.';
COMMENT ON COLUMN ext_solicitud_validacion.secciones IS
    'Respuesta por partes del documento: lindero, área, datos de la comunidad y derechos.';


/* ===========================================================================
   3. TRAZABILIDAD EN LA VALIDACIÓN QUE YA EXISTÍA
   ---------------------------------------------------------------------------
   ext_validacion_comunitaria ya guardaba el estado y las observaciones. Le
   faltaba de dónde salió ese estado: si de una asamblea presencial, de un
   mensaje de WhatsApp, y sobre qué versión del lindero.
=========================================================================== */
ALTER TABLE ext_validacion_comunitaria
    ADD COLUMN IF NOT EXISTS solicitud_id        INTEGER REFERENCES ext_solicitud_validacion(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS predio_id           INTEGER REFERENCES tpc_predio(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS huella_geometria    TEXT,
    ADD COLUMN IF NOT EXISTS origen              VARCHAR(30),   -- whatsapp | formulario | presencial
    ADD COLUMN IF NOT EXISTS telefono_aprobacion VARCHAR(30),
    ADD COLUMN IF NOT EXISTS vigente             BOOLEAN DEFAULT TRUE;

COMMENT ON COLUMN ext_validacion_comunitaria.origen IS
    'Por dónde llegó la validación. Importa para el peso probatorio: un sí por WhatsApp es la revisión de una autoridad, no el acuerdo de una asamblea.';
COMMENT ON COLUMN ext_validacion_comunitaria.vigente IS
    'FALSE cuando el lindero cambió después de la validación: lo aprobado ya no corresponde a lo que está guardado.';


/* ===========================================================================
   4. CADUCIDAD AUTOMÁTICA AL CAMBIAR EL LINDERO
   ---------------------------------------------------------------------------
   Es el disparador que sostiene toda la idea. Sin él, alguien corrige un
   polígono desde el visor y el territorio sigue diciendo «validado por la
   comunidad» sobre un lindero que la comunidad nunca vio.
=========================================================================== */
CREATE OR REPLACE FUNCTION fn_caducar_validacion()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_huella TEXT;
BEGIN
    -- Solo importa si la geometría cambió de verdad.
    IF NEW.geom_perimetro IS NOT DISTINCT FROM OLD.geom_perimetro THEN
        RETURN NULL;
    END IF;

    v_huella := CASE WHEN NEW.geom_perimetro IS NULL
                     THEN NULL ELSE md5(ST_AsBinary(NEW.geom_perimetro)) END;

    -- Las solicitudes que esperaban respuesta sobre la versión vieja ya no
    -- tienen sentido: lo que la comunidad está mirando en su teléfono no es
    -- lo que hay guardado.
    UPDATE ext_solicitud_validacion
       SET estado = 'caduca'
     WHERE predio_id = NEW.id
       AND estado IN ('enviada', 'aprobada')
       AND huella_geometria IS DISTINCT FROM v_huella;

    -- Y la validación vigente deja de estarlo.
    UPDATE ext_validacion_comunitaria
       SET vigente = FALSE
     WHERE predio_id = NEW.id
       AND vigente
       AND huella_geometria IS DISTINCT FROM v_huella;

    RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trig_caducar_validacion ON tpc_predio;
CREATE TRIGGER trig_caducar_validacion
    AFTER UPDATE OF geom_perimetro ON tpc_predio
    FOR EACH ROW EXECUTE FUNCTION fn_caducar_validacion();

COMMENT ON FUNCTION fn_caducar_validacion IS
    'Invalida solicitudes y validaciones cuando el lindero cambia: lo aprobado dejó de corresponder a la geometría guardada.';


/* ===========================================================================
   5. ESTADO DE VALIDACIÓN, PARA EL VISOR
=========================================================================== */
CREATE OR REPLACE VIEW vista_estado_validacion AS
SELECT
    c.id                                   AS comunidad_id,
    c.nombre_comunidad,
    p.id                                   AS predio_id,
    fn_huella_geometria(p.id)              AS huella_actual,

    s.id                                   AS solicitud_id,
    s.estado                               AS estado_solicitud,
    s.fecha_envio,
    s.fecha_respuesta,
    s.telefono_destino,
    s.vence_en,
    s.secciones,
    s.respuesta_texto,
    s.transcripcion,

    v.validado_por_comunidad,
    v.vigente                              AS validacion_vigente,
    v.origen                               AS origen_validacion,
    v.fecha_validacion,

    /* Resumen legible, que es lo que se pinta en la ficha y en las alertas */
    CASE
        WHEN p.geom_perimetro IS NULL                          THEN 'sin_lindero'
        WHEN v.validado_por_comunidad = 'Validada_Asamblea'
             AND COALESCE(v.vigente, TRUE)                     THEN 'validada_asamblea'
        WHEN v.validado_por_comunidad = 'Revisada_Autoridades'
             AND COALESCE(v.vigente, TRUE)                     THEN 'revisada_autoridades'
        WHEN v.id IS NOT NULL AND v.vigente = FALSE            THEN 'caduca'
        WHEN s.estado = 'enviada'                              THEN 'esperando_respuesta'
        WHEN s.estado = 'rechazada'                            THEN 'con_observaciones'
        WHEN s.estado = 'caduca'                               THEN 'caduca'
        ELSE 'sin_enviar'
    END                                    AS estado
FROM tpc_interesado_comunidad c
LEFT JOIN tpc_predio p
       ON p.comunidad_id = c.id
      AND (p.nivel_tenencia = 'Colectivo' OR p.nivel_tenencia IS NULL)
/* La última solicitud de cada comunidad */
LEFT JOIN LATERAL (
    SELECT * FROM ext_solicitud_validacion s2
     WHERE s2.comunidad_id = c.id
     ORDER BY s2.fecha_envio DESC LIMIT 1
) s ON TRUE
/* Y su validación más reciente */
LEFT JOIN LATERAL (
    SELECT * FROM ext_validacion_comunitaria v2
     WHERE v2.comunidad_id = c.id
     ORDER BY v2.fecha_validacion DESC NULLS LAST, v2.id DESC LIMIT 1
) v ON TRUE;

COMMENT ON VIEW vista_estado_validacion IS
    'Una fila por comunidad con en qué punto va su validación comunitaria y si sigue correspondiendo al lindero guardado.';

COMMIT;

-- ============================================================================
--  Comprobación después de aplicar:
--
--    SELECT comunidad_id, nombre_comunidad, estado, validacion_vigente
--      FROM vista_estado_validacion ORDER BY estado;
--
--  Para comprobar la caducidad: valide un territorio, mueva un vértice desde
--  el visor y vuelva a consultar — debe quedar en 'caduca'.
-- ============================================================================
