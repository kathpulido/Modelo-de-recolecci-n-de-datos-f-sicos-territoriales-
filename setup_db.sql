-- =====================================================
-- BASE DE DATOS: catastro_etnico
-- Bot WhatsApp – Registro Territorial Comunitario
-- Alineado con LADM-COL TPC v1.0.0
-- =====================================================

-- ─────────────────────────────────────────────────
-- EXTENSIONES (opcionales)
-- PostGIS: descomentár si se instala PostGIS y se
--          quiere almacenar geometrías reales.
-- ─────────────────────────────────────────────────
-- CREATE EXTENSION IF NOT EXISTS postgis;
-- CREATE EXTENSION IF NOT EXISTS unaccent;   -- búsquedas sin tildes

-- =====================================================
-- 1. TPC_INTERESADO_COMUNIDAD
--    Identificación de la comunidad o pueblo étnico
-- =====================================================
CREATE TABLE IF NOT EXISTS tpc_interesado_comunidad (
    id                       SERIAL         PRIMARY KEY,
    nombre_comunidad         VARCHAR(200)   NOT NULL,
    tipo_comunidad           VARCHAR(50),   -- Comunidad_Negra | Cabildo | Parcialidad | Resguardo_Indigena | Territorio_Colectivo
    tipo_organizacion_filial VARCHAR(200),  -- Cabildo | Autoridades_Tradicionales | Asamblea_Comunitaria | Consejo_Comunitario | Otro
    pueblo                   VARCHAR(200),  -- nombre del pueblo indígena / grupo étnico
    numero_familias          INTEGER,
    numero_personas          INTEGER,
    numero_mujeres           INTEGER,
    numero_hombres           INTEGER,
    consentimiento           VARCHAR(5)     DEFAULT 'Sí',  -- Sí | No
    fecha_registro           TIMESTAMP      DEFAULT NOW()
);

COMMENT ON TABLE  tpc_interesado_comunidad IS 'Identifica la comunidad, pueblo o grupo étnico titular del territorio colectivo.';
COMMENT ON COLUMN tpc_interesado_comunidad.tipo_comunidad IS 'TPC_ComunidadTipo según LADM-COL: Comunidad_Negra, Cabildo, Parcialidad, Resguardo_Indigena, Territorio_Colectivo.';

-- =====================================================
-- 2. TPC_REPRESENTANTE_LEGAL
--    Autoridades y representante legal de la comunidad
-- =====================================================
CREATE TABLE IF NOT EXISTS tpc_representante_legal (
    id                               SERIAL       PRIMARY KEY,
    comunidad_id                     INTEGER      NOT NULL REFERENCES tpc_interesado_comunidad(id) ON DELETE CASCADE,
    nombres_autoridades              TEXT,        -- nombre completo del representante / autoridad
    cargo                            VARCHAR(100),-- Gobernador | Capitan | Cacique | Autoridad_Tradicional | Representante_Legal_CC | Otro
    legitimidad                      VARCHAR(50), -- Sí (elegida) | En_Proceso
    numero_documento_representante   VARCHAR(50),
    tipo_acto_administrativo         VARCHAR(50), -- Resolucion | Acuerdo | Folio_Matricula | Sin_Documento
    numero_acto_administrativo       VARCHAR(100),
    fecha_acto_administrativo        VARCHAR(50), -- dd/mm/aaaa o 'desconocida'
    telefono                         VARCHAR(20)  -- futuro: canal de contacto
);

COMMENT ON TABLE tpc_representante_legal IS 'Representante legal o autoridad principal que diligencia el registro.';

-- =====================================================
-- 3. TPC_TERRITORIO_PROPIEDAD_COLECTIVA
--    Identificación del territorio como objeto jurídico
-- =====================================================
CREATE TABLE IF NOT EXISTS tpc_territorio_propiedad_colectiva (
    id                  SERIAL       PRIMARY KEY,
    comunidad_id        INTEGER      NOT NULL REFERENCES tpc_interesado_comunidad(id) ON DELETE CASCADE,
    nombre_territorio   VARCHAR(300),
    tipo_procedimiento  VARCHAR(100) -- TPC_ProcedimientoTipo
                                     -- Ampliacion_ResguardosIndigenas | Ampliacion_Saneamiento_ResguardosIndigenas
                                     -- Reestructuracion_ResguardosIndigenas | Conversion_Reservas_Resguardos
                                     -- Titulacion_Comunidades_Negras | En_Proceso
);

COMMENT ON TABLE tpc_territorio_propiedad_colectiva IS 'Representa el territorio como propiedad colectiva reconocida o en proceso.';

-- =====================================================
-- 4. TPC_PREDIO
--    Información catastral y geográfica del predio
-- =====================================================
CREATE TABLE IF NOT EXISTS tpc_predio (
    id                        SERIAL          PRIMARY KEY,
    comunidad_id              INTEGER         NOT NULL REFERENCES tpc_interesado_comunidad(id) ON DELETE CASCADE,
    departamento              VARCHAR(100),
    municipio                 VARCHAR(100),
    vereda                    VARCHAR(100),
    corregimiento             VARCHAR(100),
    nombre_predio             VARCHAR(300),
    numero_predial            VARCHAR(30),    -- NUPRE (si existe)
    area_acto_administrativo  NUMERIC(12, 4), -- hectáreas
    reconocimiento_estado     VARCHAR(50),    -- Sí | No | No_Sabemos
    limites_territorio        VARCHAR(100),   -- Rios | Montanas | Caminos | Hitos_Naturales | Documentos_Oficiales | Combinacion
    zonas_especiales          VARCHAR(5),     -- Sí | No
    latitud                   NUMERIC(10, 7), -- grados decimales WGS84
    longitud                  NUMERIC(10, 7)
    -- geom GEOMETRY(POINT, 4326)  -- activar si se instala PostGIS
);

COMMENT ON TABLE  tpc_predio IS 'Datos catastrales del predio colectivo: ubicación, área y límites.';
COMMENT ON COLUMN tpc_predio.latitud  IS 'Latitud en grados decimales WGS84. Obtenida por GPS del usuario vía WhatsApp o ingresada manualmente.';
COMMENT ON COLUMN tpc_predio.longitud IS 'Longitud en grados decimales WGS84.';

-- =====================================================
-- 5. TPC_DERECHO
--    Tipo de derecho que tiene la comunidad
-- =====================================================
CREATE TABLE IF NOT EXISTS tpc_derecho (
    id           SERIAL       PRIMARY KEY,
    comunidad_id INTEGER      NOT NULL REFERENCES tpc_interesado_comunidad(id) ON DELETE CASCADE,
    tipo_derecho VARCHAR(100) -- Propiedad_Colectiva | Posesion_Ancestral | Uso_Usufructo | En_Proceso | Desconocido
);

COMMENT ON TABLE tpc_derecho IS 'TPC_DerechoTipo: derecho que ejerce la comunidad sobre el territorio.';

-- =====================================================
-- 6. TPC_RESTRICCION
--    Restricciones o servidumbres sobre el territorio
-- =====================================================
CREATE TABLE IF NOT EXISTS tpc_restriccion (
    id               SERIAL       PRIMARY KEY,
    comunidad_id     INTEGER      NOT NULL REFERENCES tpc_interesado_comunidad(id) ON DELETE CASCADE,
    tipo_restriccion VARCHAR(100) -- Minera | Oleoducto_Gasoducto | Energia_Electrica
                                  -- Acueducto_Alcantarillado | Legal_Hidrocarburos | Ninguna
);

COMMENT ON TABLE tpc_restriccion IS 'TPC_RestriccionTipo: servidumbres, restricciones legales o de uso sobre el territorio.';

-- =====================================================
-- 7. TPC_FUENTE_ADMINISTRATIVA
--    Documentos legales que reconocen el territorio
-- =====================================================
CREATE TABLE IF NOT EXISTS tpc_fuente_administrativa (
    id                          SERIAL       PRIMARY KEY,
    comunidad_id                INTEGER      NOT NULL REFERENCES tpc_interesado_comunidad(id) ON DELETE CASCADE,
    tipo_fuente                 VARCHAR(50),
    tipo_acto_administrativo    VARCHAR(50), -- Resolucion | Acuerdo | Folio_Matricula | Sin_Documento
    numero_acto_administrativo  VARCHAR(100),
    fecha_acto_administrativo   VARCHAR(50),
    observaciones               TEXT
);

COMMENT ON TABLE tpc_fuente_administrativa IS 'Actos administrativos (resoluciones, acuerdos) que reconocen el territorio.';

-- =====================================================
-- 8. TPC_FUENTE_ESPACIAL
--    Cartografía y planos del territorio
-- =====================================================
CREATE TABLE IF NOT EXISTS tpc_fuente_espacial (
    id                   SERIAL       PRIMARY KEY,
    comunidad_id         INTEGER      NOT NULL REFERENCES tpc_interesado_comunidad(id) ON DELETE CASCADE,
    tipo_fuente_espacial VARCHAR(100),-- Plano_Oficial | Mapa_Comunitario | Sin_Mapa
    numero_plano         VARCHAR(100),
    observaciones_plano  TEXT
);

COMMENT ON TABLE tpc_fuente_espacial IS 'Fuentes cartográficas: planos IGAC, mapas comunitarios, etc.';

-- =====================================================
-- 9. EXT_HISTORIA_TERRITORIO  (extensión propia)
--    Historia oral y escrita de la ocupación territorial
-- =====================================================
CREATE TABLE IF NOT EXISTS ext_historia_territorio (
    id                     SERIAL       PRIMARY KEY,
    comunidad_id           INTEGER      NOT NULL REFERENCES tpc_interesado_comunidad(id) ON DELETE CASCADE,
    antiguedad_territorio  VARCHAR(100),-- Desde_Siempre | Desde_Hace_Muchos_Anos | Desde_Fecha_Aproximada | Desconocida
    descripcion_historia   TEXT,        -- texto escrito o transcripción Whisper del audio
    audio_url              TEXT         -- ruta local del archivo OGG grabado por el usuario
);

COMMENT ON TABLE  ext_historia_territorio IS 'Extensión LADM: historia oral de la comunidad sobre la ocupación del territorio.';
COMMENT ON COLUMN ext_historia_territorio.descripcion_historia IS 'Texto escrito por el usuario o transcripción automática (Groq Whisper) del audio de voz.';
COMMENT ON COLUMN ext_historia_territorio.audio_url IS 'Ruta al archivo OGG/opus enviado por WhatsApp y guardado localmente.';

-- =====================================================
-- 10. EXT_USO_TERRITORIO  (extensión propia)
--     Uso actual y normas internas del territorio
-- =====================================================
CREATE TABLE IF NOT EXISTS ext_uso_territorio (
    id              SERIAL       PRIMARY KEY,
    predio_id       INTEGER      NOT NULL REFERENCES tpc_predio(id) ON DELETE CASCADE,
    tipo_uso        VARCHAR(100),-- Uso_Colectivo | Uso_Tradicional | Zonas_Compartidas | Uso_Mixto
    reglas_internas VARCHAR(5)   -- Sí | No
);

COMMENT ON TABLE ext_uso_territorio IS 'Extensión LADM: tipo de uso del territorio y existencia de normas internas comunitarias.';

-- =====================================================
-- 11. EXT_VALIDACION_COMUNITARIA  (extensión propia)
--     Validación del registro por la comunidad
-- =====================================================
CREATE TABLE IF NOT EXISTS ext_validacion_comunitaria (
    id                       SERIAL       PRIMARY KEY,
    comunidad_id             INTEGER      NOT NULL REFERENCES tpc_interesado_comunidad(id) ON DELETE CASCADE,
    validado_por_comunidad   VARCHAR(50), -- Validada_Asamblea | Revisada_Autoridades | Pendiente
    observaciones_finales    TEXT,        -- texto o transcripción Whisper
    audio_observaciones_url  TEXT,        -- ruta al OGG de validación
    fecha_validacion         TIMESTAMP    DEFAULT NOW()
);

COMMENT ON TABLE ext_validacion_comunitaria IS 'Extensión LADM: validación del registro territorial por parte de la asamblea o autoridades de la comunidad.';

-- =====================================================
-- ÍNDICES para mejorar las consultas frecuentes
-- =====================================================

-- Búsqueda por nombre de comunidad (el más frecuente)
CREATE INDEX IF NOT EXISTS idx_comunidad_nombre
    ON tpc_interesado_comunidad (nombre_comunidad);

-- Búsqueda por departamento y municipio
CREATE INDEX IF NOT EXISTS idx_predio_ubicacion
    ON tpc_predio (departamento, municipio);

-- Filtrar por coordenadas (rango geográfico)
CREATE INDEX IF NOT EXISTS idx_predio_coords
    ON tpc_predio (latitud, longitud)
    WHERE latitud IS NOT NULL AND longitud IS NOT NULL;

-- Búsqueda por fecha de registro
CREATE INDEX IF NOT EXISTS idx_comunidad_fecha
    ON tpc_interesado_comunidad (fecha_registro);

-- Integridad referencial (FKs ya tienen índice implícito en PG, pero mejora JOINs)
CREATE INDEX IF NOT EXISTS idx_rep_legal_comunidad  ON tpc_representante_legal(comunidad_id);
CREATE INDEX IF NOT EXISTS idx_territorio_comunidad ON tpc_territorio_propiedad_colectiva(comunidad_id);
CREATE INDEX IF NOT EXISTS idx_predio_comunidad     ON tpc_predio(comunidad_id);
CREATE INDEX IF NOT EXISTS idx_derecho_comunidad    ON tpc_derecho(comunidad_id);
CREATE INDEX IF NOT EXISTS idx_restriccion_comunidad ON tpc_restriccion(comunidad_id);
CREATE INDEX IF NOT EXISTS idx_fuente_esp_comunidad ON tpc_fuente_espacial(comunidad_id);
CREATE INDEX IF NOT EXISTS idx_historia_comunidad   ON ext_historia_territorio(comunidad_id);
CREATE INDEX IF NOT EXISTS idx_uso_predio           ON ext_uso_territorio(predio_id);
CREATE INDEX IF NOT EXISTS idx_validacion_comunidad ON ext_validacion_comunitaria(comunidad_id);

-- =====================================================
-- VISTA CONSOLIDADA
--   Combina todas las tablas en una sola fila por comunidad.
--   Útil para exportar a Excel, dashboards o reportes.
-- =====================================================
CREATE OR REPLACE VIEW vista_registros_completos AS
SELECT
    c.id                             AS registro_id,
    c.fecha_registro,
    -- Comunidad
    c.nombre_comunidad,
    c.tipo_comunidad,
    c.tipo_organizacion_filial,
    c.pueblo                         AS pueblo_etnico,
    c.numero_familias,
    c.numero_personas,
    c.numero_mujeres,
    c.numero_hombres,
    c.consentimiento,
    -- Representante legal
    r.nombres_autoridades,
    r.cargo,
    r.legitimidad,
    r.numero_documento_representante,
    r.tipo_acto_administrativo       AS doc_tipo,
    r.numero_acto_administrativo     AS doc_numero,
    r.fecha_acto_administrativo      AS doc_fecha,
    -- Territorio
    t.nombre_territorio,
    t.tipo_procedimiento,
    -- Predio / ubicación
    p.departamento,
    p.municipio,
    p.vereda,
    p.corregimiento,
    p.nombre_predio,
    p.area_acto_administrativo       AS area_ha,
    p.reconocimiento_estado,
    p.limites_territorio,
    p.zonas_especiales,
    p.latitud,
    p.longitud,
    -- Derecho
    d.tipo_derecho,
    -- Restricción
    res.tipo_restriccion,
    -- Fuente espacial
    fe.tipo_fuente_espacial,
    fe.numero_plano,
    -- Historia
    h.antiguedad_territorio,
    h.descripcion_historia,
    h.audio_url                      AS audio_historia,
    -- Uso del territorio
    u.tipo_uso,
    u.reglas_internas,
    -- Validación comunitaria
    v.validado_por_comunidad,
    v.observaciones_finales,
    v.audio_observaciones_url        AS audio_validacion,
    v.fecha_validacion
FROM tpc_interesado_comunidad            c
LEFT JOIN tpc_representante_legal        r   ON r.comunidad_id  = c.id
LEFT JOIN tpc_territorio_propiedad_colectiva t ON t.comunidad_id = c.id
LEFT JOIN tpc_predio                     p   ON p.comunidad_id  = c.id
LEFT JOIN tpc_derecho                    d   ON d.comunidad_id  = c.id
LEFT JOIN tpc_restriccion                res ON res.comunidad_id = c.id
LEFT JOIN tpc_fuente_espacial            fe  ON fe.comunidad_id = c.id
LEFT JOIN ext_historia_territorio        h   ON h.comunidad_id  = c.id
LEFT JOIN ext_uso_territorio             u   ON u.predio_id     = p.id
LEFT JOIN ext_validacion_comunitaria     v   ON v.comunidad_id  = c.id;

COMMENT ON VIEW vista_registros_completos IS 'Vista consolidada de todos los módulos. Una fila por comunidad registrada. Útil para reportes y exportaciones.';

-- =====================================================
-- VISTA DE RESUMEN ESTADÍSTICO
--   Conteos rápidos para el panel de administración
-- =====================================================
CREATE OR REPLACE VIEW vista_estadisticas AS
SELECT
    COUNT(*)                                               AS total_registros,
    COUNT(*) FILTER (WHERE tipo_comunidad = 'Resguardo_Indigena')   AS resguardos,
    COUNT(*) FILTER (WHERE tipo_comunidad = 'Comunidad_Negra')      AS comunidades_negras,
    COUNT(*) FILTER (WHERE tipo_comunidad = 'Cabildo')              AS cabildos,
    COUNT(*) FILTER (WHERE tipo_comunidad = 'Parcialidad')          AS parcialidades,
    COUNT(*) FILTER (WHERE tipo_comunidad = 'Territorio_Colectivo') AS territorios_colectivos,
    SUM(numero_personas)                                   AS total_personas,
    SUM(numero_familias)                                   AS total_familias,
    MIN(fecha_registro)                                    AS primer_registro,
    MAX(fecha_registro)                                    AS ultimo_registro
FROM tpc_interesado_comunidad;

COMMENT ON VIEW vista_estadisticas IS 'Resumen estadístico general: totales por tipo de comunidad, personas registradas y fechas.';

-- =====================================================
-- FUNCIÓN: resumen de un registro por ID
--   Útil para verificar qué quedó guardado.
-- =====================================================
CREATE OR REPLACE FUNCTION fn_resumen_registro(p_id INTEGER)
RETURNS TABLE (
    campo  TEXT,
    valor  TEXT
) LANGUAGE sql AS $$
    SELECT 'Comunidad',           nombre_comunidad                 FROM tpc_interesado_comunidad WHERE id = p_id
    UNION ALL
    SELECT 'Tipo comunidad',      tipo_comunidad                   FROM tpc_interesado_comunidad WHERE id = p_id
    UNION ALL
    SELECT 'Pueblo étnico',       pueblo                           FROM tpc_interesado_comunidad WHERE id = p_id
    UNION ALL
    SELECT 'Personas',            numero_personas::TEXT            FROM tpc_interesado_comunidad WHERE id = p_id
    UNION ALL
    SELECT 'Representante',       nombres_autoridades              FROM tpc_representante_legal  WHERE comunidad_id = p_id
    UNION ALL
    SELECT 'Cargo',               cargo                            FROM tpc_representante_legal  WHERE comunidad_id = p_id
    UNION ALL
    SELECT 'Territorio',          nombre_territorio                FROM tpc_territorio_propiedad_colectiva WHERE comunidad_id = p_id
    UNION ALL
    SELECT 'Departamento',        departamento                     FROM tpc_predio WHERE comunidad_id = p_id
    UNION ALL
    SELECT 'Municipio',           municipio                        FROM tpc_predio WHERE comunidad_id = p_id
    UNION ALL
    SELECT 'Área (ha)',           area_acto_administrativo::TEXT   FROM tpc_predio WHERE comunidad_id = p_id
    UNION ALL
    SELECT 'Derecho',             tipo_derecho                     FROM tpc_derecho WHERE comunidad_id = p_id
    UNION ALL
    SELECT 'Validación',          validado_por_comunidad           FROM ext_validacion_comunitaria WHERE comunidad_id = p_id;
$$;

COMMENT ON FUNCTION fn_resumen_registro IS 'Devuelve un resumen en pares campo/valor de un registro completo dado su ID.';

-- =====================================================
-- VERIFICACIÓN FINAL
-- =====================================================
DO $$
DECLARE
    n_tablas INTEGER;
    n_vistas INTEGER;
BEGIN
    SELECT COUNT(*) INTO n_tablas
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename IN (
          'tpc_interesado_comunidad', 'tpc_representante_legal',
          'tpc_territorio_propiedad_colectiva', 'tpc_predio',
          'tpc_derecho', 'tpc_restriccion', 'tpc_fuente_administrativa',
          'tpc_fuente_espacial', 'ext_historia_territorio',
          'ext_uso_territorio', 'ext_validacion_comunitaria'
      );

    SELECT COUNT(*) INTO n_vistas
    FROM pg_views
    WHERE schemaname = 'public'
      AND viewname IN ('vista_registros_completos', 'vista_estadisticas');

    RAISE NOTICE '';
    RAISE NOTICE '====================================================';
    RAISE NOTICE '  Catastro Étnico – Base de datos lista';
    RAISE NOTICE '====================================================';
    RAISE NOTICE '  Tablas creadas    : % / 11', n_tablas;
    RAISE NOTICE '  Vistas creadas    : % / 2',  n_vistas;
    RAISE NOTICE '====================================================';

    IF n_tablas < 11 THEN
        RAISE WARNING 'Faltan % tabla(s). Revise los errores anteriores.', 11 - n_tablas;
    END IF;
END $$;
