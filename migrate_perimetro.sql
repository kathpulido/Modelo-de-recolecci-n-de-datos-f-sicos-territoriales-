-- =====================================================
-- MIGRACIÓN: Captura física del perímetro territorial
-- Añade soporte para el polígono del predio, capturado por
-- fuera de WhatsApp mediante croquis.html (dibujo manual) o
-- recorrido.html (recorrido GPS caminado) y enlazado al
-- registro mediante un token de un solo uso.
--
-- Requiere que migrate_postgis.sql ya se haya aplicado
-- (extensión PostGIS activa).
-- =====================================================

-- ─────────────────────────────────────────────────────
-- 1. Columnas nuevas en tpc_predio para el perímetro
-- ─────────────────────────────────────────────────────
ALTER TABLE tpc_predio
    ADD COLUMN IF NOT EXISTS geom_perimetro GEOMETRY(POLYGON, 4326),
    ADD COLUMN IF NOT EXISTS metodo_captura_perimetro VARCHAR(30)
        CHECK (metodo_captura_perimetro IN ('croquis_manual', 'recorrido_gps', 'no_capturado')),
    ADD COLUMN IF NOT EXISTS area_perimetro_calculada_ha NUMERIC(12,4),
    ADD COLUMN IF NOT EXISTS geojson_perimetro JSONB,
    ADD COLUMN IF NOT EXISTS puntos_recorrido_gps JSONB;

CREATE INDEX IF NOT EXISTS idx_tpc_predio_geom_perimetro
    ON tpc_predio USING GIST (geom_perimetro);

COMMENT ON COLUMN tpc_predio.geom_perimetro IS
    'Polígono del perímetro del predio (WGS-84). Capturado por croquis.html o recorrido.html, no por el chatbot directamente.';
COMMENT ON COLUMN tpc_predio.metodo_captura_perimetro IS
    'croquis_manual = dibujado sobre el mapa; recorrido_gps = trazado caminando el lindero; no_capturado = el declarante omitió este paso.';

-- ─────────────────────────────────────────────────────
-- 2. Tabla puente: la captura ocurre en un navegador
--    externo (no en WhatsApp), potencialmente en un momento
--    distinto al de la conversación. Este registro queda
--    "pendiente" hasta que el módulo de cierre del bot lo
--    vincula al predio definitivo usando el token.
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tpc_captura_perimetro_pendiente (
    id          SERIAL PRIMARY KEY,
    token       UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    metodo      VARCHAR(30) NOT NULL CHECK (metodo IN ('croquis_manual', 'recorrido_gps')),
    geojson     JSONB NOT NULL,
    puntos_gps  JSONB,              -- traza cruda de watchPosition() (solo recorrido_gps)
    area_ha     NUMERIC(12,4),
    vertices    INTEGER,
    creado_en   TIMESTAMP DEFAULT NOW(),
    usado       BOOLEAN DEFAULT false,
    usado_en    TIMESTAMP,
    predio_id   INTEGER REFERENCES tpc_predio(id)
);

CREATE INDEX IF NOT EXISTS idx_perimetro_pendiente_token
    ON tpc_captura_perimetro_pendiente (token)
    WHERE usado = false;

COMMENT ON TABLE tpc_captura_perimetro_pendiente IS
    'Cola de perímetros capturados fuera de WhatsApp (croquis.html / recorrido.html), a la espera de vincularse a un tpc_predio mediante el token compartido con la sesión del bot.';

-- ─────────────────────────────────────────────────────
-- 3. Cálculo automático del área geodésica (hectáreas)
--    cada vez que se inserta o actualiza el polígono.
--    Usa ::geography para que el área respete la curvatura
--    terrestre en vez de tratar los grados como un plano.
-- ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_calcular_area_perimetro()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.geom_perimetro IS NOT NULL THEN
        NEW.area_perimetro_calculada_ha := ST_Area(NEW.geom_perimetro::geography) / 10000.0;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trig_calcular_area_perimetro ON tpc_predio;
CREATE TRIGGER trig_calcular_area_perimetro
    BEFORE INSERT OR UPDATE OF geom_perimetro ON tpc_predio
    FOR EACH ROW
    EXECUTE FUNCTION fn_calcular_area_perimetro();

-- ─────────────────────────────────────────────────────
-- 4. Nota sobre vista_registros_completos:
--    si quieres exponer geom_perimetro / area_perimetro_calculada_ha
--    / metodo_captura_perimetro en esa vista, agrégalos a mano en su
--    definición (schema.sql / setup_db.sql) — aquí no se toca para
--    no arriesgar romper columnas que el geovisor ya consulta.
-- ─────────────────────────────────────────────────────

DO $$
BEGIN
    RAISE NOTICE 'Migración de perímetro territorial completada: geom_perimetro, tpc_captura_perimetro_pendiente y trigger de área listos.';
END $$;
