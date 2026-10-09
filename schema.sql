-- =====================================================
-- ESQUEMA BASE DE DATOS - CATASTRO ÉTNICO
-- Alineado con LADM-COL TPC v1.0.0
-- =====================================================

-- Extensión para geometría (PostGIS)
-- CREATE EXTENSION IF NOT EXISTS postgis;

-- =====================================================
-- 1. TPC_INTERESADO_COMUNIDAD
-- =====================================================
CREATE TABLE IF NOT EXISTS tpc_interesado_comunidad (
  id                      SERIAL PRIMARY KEY,
  nombre_comunidad        VARCHAR(200) NOT NULL,
  tipo_comunidad          VARCHAR(50),   -- TPC_ComunidadTipo
  tipo_organizacion_filial VARCHAR(200),
  pueblo                  VARCHAR(200),
  numero_familias         INTEGER,
  numero_personas         INTEGER,
  numero_mujeres          INTEGER,
  numero_hombres          INTEGER,
  consentimiento          VARCHAR(5)  DEFAULT 'Sí',
  fecha_registro          TIMESTAMP  DEFAULT NOW()
);

-- =====================================================
-- 2. TPC_REPRESENTANTE_LEGAL
-- =====================================================
CREATE TABLE IF NOT EXISTS tpc_representante_legal (
  id                          SERIAL PRIMARY KEY,
  comunidad_id                INTEGER NOT NULL REFERENCES tpc_interesado_comunidad(id),
  nombres_autoridades         TEXT,
  cargo                       VARCHAR(100),  -- Gobernador, Capitan, etc.
  legitimidad                 VARCHAR(50),
  numero_documento_representante VARCHAR(50),
  tipo_acto_administrativo    VARCHAR(50),   -- TPC_ActoAdministrativoTipo
  numero_acto_administrativo  VARCHAR(100),
  fecha_acto_administrativo   VARCHAR(50),
  telefono                    VARCHAR(20)
);

-- =====================================================
-- 3. TPC_TERRITORIO_PROPIEDAD_COLECTIVA
-- =====================================================
CREATE TABLE IF NOT EXISTS tpc_territorio_propiedad_colectiva (
  id                  SERIAL PRIMARY KEY,
  comunidad_id        INTEGER NOT NULL REFERENCES tpc_interesado_comunidad(id),
  nombre_territorio   VARCHAR(300),
  tipo_procedimiento  VARCHAR(100)  -- TPC_ProcedimientoTipo
);

-- =====================================================
-- 4. TPC_PREDIO
-- =====================================================
CREATE TABLE IF NOT EXISTS tpc_predio (
  id                        SERIAL PRIMARY KEY,
  comunidad_id              INTEGER NOT NULL REFERENCES tpc_interesado_comunidad(id),
  departamento              VARCHAR(100),
  municipio                 VARCHAR(100),
  vereda                    VARCHAR(100),
  corregimiento             VARCHAR(100),
  nombre_predio             VARCHAR(300),
  numero_predial            VARCHAR(30),
  area_acto_administrativo  NUMERIC(12,4),
  reconocimiento_estado     VARCHAR(50),
  limites_territorio        VARCHAR(100),
  zonas_especiales          VARCHAR(5),
  latitud                   NUMERIC(10,7),
  longitud                  NUMERIC(10,7)
  -- geom GEOMETRY(POLYGON, 4326)  -- activar si tiene PostGIS
);

-- =====================================================
-- 5. TPC_DERECHO
-- =====================================================
CREATE TABLE IF NOT EXISTS tpc_derecho (
  id           SERIAL PRIMARY KEY,
  comunidad_id INTEGER NOT NULL REFERENCES tpc_interesado_comunidad(id),
  tipo_derecho VARCHAR(100)  -- TPC_DerechoTipo
);

-- =====================================================
-- 6. TPC_RESTRICCION
-- =====================================================
CREATE TABLE IF NOT EXISTS tpc_restriccion (
  id               SERIAL PRIMARY KEY,
  comunidad_id     INTEGER NOT NULL REFERENCES tpc_interesado_comunidad(id),
  tipo_restriccion VARCHAR(100)  -- TPC_RestriccionTipo
);

-- =====================================================
-- 7. TPC_FUENTE_ADMINISTRATIVA
-- =====================================================
CREATE TABLE IF NOT EXISTS tpc_fuente_administrativa (
  id                          SERIAL PRIMARY KEY,
  comunidad_id                INTEGER NOT NULL REFERENCES tpc_interesado_comunidad(id),
  tipo_fuente                 VARCHAR(50),
  tipo_acto_administrativo    VARCHAR(50),
  numero_acto_administrativo  VARCHAR(100),
  fecha_acto_administrativo   VARCHAR(50),
  observaciones               TEXT
);

-- =====================================================
-- 8. TPC_FUENTE_ESPACIAL
-- =====================================================
CREATE TABLE IF NOT EXISTS tpc_fuente_espacial (
  id                  SERIAL PRIMARY KEY,
  comunidad_id        INTEGER NOT NULL REFERENCES tpc_interesado_comunidad(id),
  tipo_fuente_espacial VARCHAR(100),
  numero_plano        VARCHAR(100),
  observaciones_plano TEXT
);

-- =====================================================
-- 9. EXT_HISTORIA_TERRITORIO (extensión propia)
-- =====================================================
CREATE TABLE IF NOT EXISTS ext_historia_territorio (
  id                     SERIAL PRIMARY KEY,
  comunidad_id           INTEGER NOT NULL REFERENCES tpc_interesado_comunidad(id),
  antiguedad_territorio  VARCHAR(100),
  descripcion_historia   TEXT,
  audio_url              TEXT  -- ruta del archivo de audio guardado
);

-- =====================================================
-- 10. EXT_USO_TERRITORIO (extensión propia)
-- =====================================================
CREATE TABLE IF NOT EXISTS ext_uso_territorio (
  id               SERIAL PRIMARY KEY,
  predio_id        INTEGER NOT NULL REFERENCES tpc_predio(id),
  tipo_uso         VARCHAR(100),
  reglas_internas  VARCHAR(5)
);

-- =====================================================
-- 11. EXT_VALIDACION_COMUNITARIA (extensión propia)
-- =====================================================
CREATE TABLE IF NOT EXISTS ext_validacion_comunitaria (
  id                       SERIAL PRIMARY KEY,
  comunidad_id             INTEGER NOT NULL REFERENCES tpc_interesado_comunidad(id),
  validado_por_comunidad   VARCHAR(50),
  observaciones_finales    TEXT,
  audio_observaciones_url  TEXT,
  fecha_validacion         TIMESTAMP DEFAULT NOW()
);

-- =====================================================
-- VISTA CONSOLIDADA (útil para visualización en tiempo real)
-- =====================================================
CREATE OR REPLACE VIEW vista_registros_completos AS
SELECT
  c.id,
  c.nombre_comunidad,
  c.tipo_comunidad,
  c.pueblo,
  c.numero_familias,
  c.numero_personas,
  c.numero_mujeres,
  c.numero_hombres,
  c.fecha_registro,
  r.nombres_autoridades,
  r.cargo,
  r.legitimidad,
  t.nombre_territorio,
  t.tipo_procedimiento,
  p.departamento,
  p.municipio,
  p.vereda,
  p.area_acto_administrativo,
  p.latitud,
  p.longitud,
  d.tipo_derecho,
  res.tipo_restriccion,
  fe.tipo_fuente_espacial,
  h.antiguedad_territorio,
  h.audio_url          AS audio_historia,
  u.tipo_uso,
  u.reglas_internas,
  v.validado_por_comunidad,
  v.observaciones_finales,
  v.audio_observaciones_url,
  v.fecha_validacion
FROM tpc_interesado_comunidad c
LEFT JOIN tpc_representante_legal         r   ON r.comunidad_id  = c.id
LEFT JOIN tpc_territorio_propiedad_colectiva t ON t.comunidad_id = c.id
LEFT JOIN tpc_predio                      p   ON p.comunidad_id  = c.id
LEFT JOIN tpc_derecho                     d   ON d.comunidad_id  = c.id
LEFT JOIN tpc_restriccion                 res ON res.comunidad_id= c.id
LEFT JOIN tpc_fuente_espacial             fe  ON fe.comunidad_id = c.id
LEFT JOIN ext_historia_territorio         h   ON h.comunidad_id  = c.id
LEFT JOIN ext_uso_territorio              u   ON u.predio_id     = p.id
LEFT JOIN ext_validacion_comunitaria      v   ON v.comunidad_id  = c.id;
