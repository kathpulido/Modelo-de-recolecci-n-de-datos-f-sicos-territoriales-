-- =====================================================
-- MIGRACIÓN PostGIS – Catastro Étnico
-- Ejecutar UNA SOLA VEZ sobre la BD catastro_etnico
-- =====================================================

-- 1. Activar extensión PostGIS
CREATE EXTENSION IF NOT EXISTS postgis;

-- =====================================================
-- 2. Columna geom en tpc_predio
--    POINT WGS84 (EPSG:4326) — longitud, latitud
-- =====================================================
ALTER TABLE tpc_predio
    ADD COLUMN IF NOT EXISTS geom GEOMETRY(POINT, 4326);

-- Índice espacial GIST (obligatorio para consultas ST_*)
CREATE INDEX IF NOT EXISTS idx_predio_geom
    ON tpc_predio USING GIST (geom);

-- Poblar geom con los registros que ya tienen latitud/longitud
UPDATE tpc_predio
SET    geom = ST_SetSRID(ST_MakePoint(longitud, latitud), 4326)
WHERE  latitud  IS NOT NULL
  AND  longitud IS NOT NULL
  AND  geom     IS NULL;

-- =====================================================
-- 3. Trigger: actualiza geom automáticamente al
--    insertar o modificar latitud / longitud
-- =====================================================
CREATE OR REPLACE FUNCTION fn_actualizar_geom()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.latitud IS NOT NULL AND NEW.longitud IS NOT NULL THEN
        NEW.geom := ST_SetSRID(ST_MakePoint(NEW.longitud, NEW.latitud), 4326);
    ELSE
        NEW.geom := NULL;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trig_actualizar_geom ON tpc_predio;
CREATE TRIGGER trig_actualizar_geom
    BEFORE INSERT OR UPDATE OF latitud, longitud
    ON tpc_predio
    FOR EACH ROW EXECUTE FUNCTION fn_actualizar_geom();

-- =====================================================
-- 4. Trigger: NOTIFY al geovisor cuando llega un
--    nuevo registro de comunidad
-- =====================================================
CREATE OR REPLACE FUNCTION fn_notify_nuevo_registro()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify(
        'nuevo_registro',
        json_build_object(
            'id',               NEW.id,
            'nombre_comunidad', NEW.nombre_comunidad,
            'tipo_comunidad',   NEW.tipo_comunidad,
            'pueblo',           NEW.pueblo,
            'numero_personas',  NEW.numero_personas,
            'fecha_registro',   NEW.fecha_registro
        )::TEXT
    );
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trig_notify_nuevo_registro ON tpc_interesado_comunidad;
CREATE TRIGGER trig_notify_nuevo_registro
    AFTER INSERT ON tpc_interesado_comunidad
    FOR EACH ROW EXECUTE FUNCTION fn_notify_nuevo_registro();

-- =====================================================
-- 5. Tabla de usuarios del geovisor web
-- =====================================================
CREATE TABLE IF NOT EXISTS geovisor_users (
    id            SERIAL       PRIMARY KEY,
    username      VARCHAR(50)  UNIQUE NOT NULL,
    password_hash TEXT         NOT NULL,
    nombre        VARCHAR(100),
    rol           VARCHAR(20)  DEFAULT 'viewer',  -- viewer | admin
    activo        BOOLEAN      DEFAULT true,
    created_at    TIMESTAMP    DEFAULT NOW(),
    last_login    TIMESTAMP
);

-- Usuario admin por defecto (contraseña: admin123 — CAMBIAR INMEDIATAMENTE)
INSERT INTO geovisor_users (username, password_hash, nombre, rol)
VALUES (
    'admin',
    '$2b$10$.MXzu4/7Cox7D9eSYB40LugPVjpOn/8Zg9RGX6UL0SZJdUyD7strS',
    'Administrador',
    'admin'
)
ON CONFLICT (username) DO NOTHING;

-- =====================================================
-- 6. Vista actualizada con geom como GeoJSON inline
-- =====================================================
CREATE OR REPLACE VIEW vista_registros_geo AS
SELECT
    c.id                              AS registro_id,
    c.fecha_registro,
    c.nombre_comunidad,
    c.tipo_comunidad,
    c.tipo_organizacion_filial,
    c.pueblo                          AS pueblo_etnico,
    c.numero_familias,
    c.numero_personas,
    c.numero_mujeres,
    c.numero_hombres,
    c.consentimiento,
    r.nombres_autoridades,
    r.cargo,
    r.legitimidad,
    t.nombre_territorio,
    t.tipo_procedimiento,
    p.departamento,
    p.municipio,
    p.vereda,
    p.nombre_predio,
    p.area_acto_administrativo        AS area_ha,
    p.reconocimiento_estado,
    p.limites_territorio,
    p.zonas_especiales,
    ST_Y(p.geom)                      AS latitud,
    ST_X(p.geom)                      AS longitud,
    ST_AsGeoJSON(p.geom)::json        AS geometry,
    d.tipo_derecho,
    res.tipo_restriccion,
    fe.tipo_fuente_espacial,
    fe.numero_plano,
    h.antiguedad_territorio,
    h.descripcion_historia,
    h.audio_url                       AS audio_historia,
    u.tipo_uso,
    u.reglas_internas,
    v.validado_por_comunidad,
    v.observaciones_finales,
    v.audio_observaciones_url         AS audio_validacion,
    v.fecha_validacion
FROM tpc_interesado_comunidad             c
LEFT JOIN tpc_representante_legal         r   ON r.comunidad_id  = c.id
LEFT JOIN tpc_territorio_propiedad_colectiva t ON t.comunidad_id = c.id
LEFT JOIN tpc_predio                      p   ON p.comunidad_id  = c.id
LEFT JOIN tpc_derecho                     d   ON d.comunidad_id  = c.id
LEFT JOIN tpc_restriccion                 res ON res.comunidad_id= c.id
LEFT JOIN tpc_fuente_espacial             fe  ON fe.comunidad_id = c.id
LEFT JOIN ext_historia_territorio         h   ON h.comunidad_id  = c.id
LEFT JOIN ext_uso_territorio              u   ON u.predio_id     = p.id
LEFT JOIN ext_validacion_comunitaria      v   ON v.comunidad_id  = c.id;

-- =====================================================
-- 7. Verificación
-- =====================================================
DO $$
DECLARE
    col_existe BOOLEAN;
    trig_count INTEGER;
    user_count INTEGER;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'tpc_predio' AND column_name = 'geom'
    ) INTO col_existe;

    SELECT COUNT(*) INTO trig_count
    FROM information_schema.triggers
    WHERE trigger_name IN ('trig_actualizar_geom', 'trig_notify_nuevo_registro');

    SELECT COUNT(*) INTO user_count FROM geovisor_users;

    RAISE NOTICE '============================================';
    RAISE NOTICE '  Migración PostGIS completada';
    RAISE NOTICE '  Columna geom en tpc_predio : %', col_existe;
    RAISE NOTICE '  Triggers creados           : %', trig_count;
    RAISE NOTICE '  Usuarios geovisor          : %', user_count;
    RAISE NOTICE '============================================';
END $$;
