-- ======================================================================
--  MIGRACIÓN: levantamiento por familias dentro del territorio colectivo
--
--  Ejecutar una sola vez, DESPUÉS de migrate_ladm.sql:
--      psql -U postgres -d catastro_etnico -f migrate_familias.sql
--
--  Es segura de correr más de una vez y no borra información.
--
--  ─────────────────────────────────────────────────────────────────────
--  POR QUÉ ESTO CABE DENTRO DE LADM-COL
--
--  En un territorio colectivo el título es inalienable, imprescriptible e
--  inembargable: las familias NO son propietarias de su parcela. Tienen un
--  derecho de uso o usufructo asignado por la autoridad de la comunidad y
--  regido por el reglamento interno.
--
--  Esa distinción es exactamente la que el modelo sabe representar: es la
--  misma tripleta interesado — derecho — unidad administrativa, aplicada
--  en dos niveles.
--
--      Nivel        Interesado        Derecho              Unidad
--      ---------    --------------    -----------------    -------------------
--      Colectivo    La comunidad      Propiedad_Colectiva  Territorio completo
--      Familiar     La familia        Uso_Usufructo        Parcela, dentro de él
--
--  No se crea ninguna clase fuera del estándar. La jerarquía entre las dos
--  unidades espaciales es COL_AgrupacionUnidadesEspaciales, que ya existía
--  desde migrate_ladm.sql y hasta ahora estaba vacía.
-- ======================================================================

BEGIN;

-- ======================================================================
--  1. NIVEL DE TENENCIA
-- ======================================================================

SELECT fn_crear_catalogo(
    'tpc_niveltenenciatipo',
    'Nivel en que se levantó la unidad espacial: el territorio colectivo completo o la parcela de una familia dentro de él. Extensión propia.'
);

SELECT fn_valor_catalogo('tpc_niveltenenciatipo', 'Colectivo', 'Territorio colectivo',
    'El lindero de toda la propiedad colectiva, cuyo titular es la comunidad.', true, NULL);
SELECT fn_valor_catalogo('tpc_niveltenenciatipo', 'Familiar', 'Parcela familiar',
    'El lugar que una familia ocupa dentro del territorio colectivo, por asignación de la comunidad.', true, NULL);

-- ======================================================================
--  2. JERARQUÍA ENTRE PREDIOS
--
--  Una parcela familiar es un predio cuyo padre es el predio colectivo.
--  Es la forma más directa de consultarlo; abajo se mantiene además la
--  clase COL_AgrupacionUnidadesEspaciales del estándar, sincronizada por
--  un disparador, para que la jerarquía también quede expresada como el
--  modelo la define.
-- ======================================================================

ALTER TABLE tpc_predio
    ADD COLUMN IF NOT EXISTS predio_matriz_id INTEGER REFERENCES tpc_predio(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS nivel_tenencia   VARCHAR(30) DEFAULT 'Colectivo';

COMMENT ON COLUMN tpc_predio.predio_matriz_id IS
    'Predio del que esta unidad forma parte. Nulo en el territorio colectivo; apunta a él en cada parcela familiar.';
COMMENT ON COLUMN tpc_predio.nivel_tenencia IS
    'Colectivo = lindero de todo el territorio. Familiar = parcela ocupada por una familia dentro de él.';

-- Todo lo que ya estaba registrado es, por definición, del nivel colectivo:
-- hasta ahora el chatbot no podía capturar otra cosa.
UPDATE tpc_predio SET nivel_tenencia = 'Colectivo' WHERE nivel_tenencia IS NULL;

CREATE INDEX IF NOT EXISTS idx_predio_matriz ON tpc_predio (predio_matriz_id)
    WHERE predio_matriz_id IS NOT NULL;

-- Un predio no puede ser su propio padre.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_predio_matriz_distinto') THEN
        ALTER TABLE tpc_predio ADD CONSTRAINT chk_predio_matriz_distinto
            CHECK (predio_matriz_id IS NULL OR predio_matriz_id <> id);
    END IF;
END $$;

-- ======================================================================
--  3. LA FAMILIA COMO INTERESADO
--
--  Es una especialización de COL_Interesado, igual que
--  tpc_interesado_comunidad. Se registra el hogar como unidad, con su
--  jefe o jefa y el conteo de quienes lo componen — no persona por
--  persona, porque eso es lo que la conversación por WhatsApp puede
--  capturar de forma confiable.
-- ======================================================================

CREATE TABLE IF NOT EXISTS tpc_interesado_familia (
    id                         SERIAL       PRIMARY KEY,
    comunidad_id               INTEGER      NOT NULL REFERENCES tpc_interesado_comunidad(id) ON DELETE CASCADE,

    nombre_familia             VARCHAR(200),
    -- Jefatura del hogar, con el nombre descompuesto como pide el modelo
    jefe_hogar                 VARCHAR(200),
    primer_nombre              VARCHAR(100),
    segundo_nombre             VARCHAR(100),
    primer_apellido            VARCHAR(100),
    segundo_apellido           VARCHAR(100),
    tipo_documento             VARCHAR(60),
    numero_documento           VARCHAR(50),
    telefono                   VARCHAR(20),

    -- El censo real de este hogar
    numero_personas            INTEGER,
    numero_mujeres             INTEGER,
    numero_hombres             INTEGER,
    numero_menores             INTEGER,

    -- Desde cuándo ocupa este lugar
    antiguedad_ocupacion       VARCHAR(100),
    origen_asignacion          VARCHAR(60),

    fecha_registro             TIMESTAMP    DEFAULT NOW(),

    -- <<ObjetoVersionado>>
    espacio_de_nombres         VARCHAR(255) DEFAULT 'CATASTRO_ETNICO',
    local_id                   VARCHAR(255),
    comienzo_vida_util_version TIMESTAMP    DEFAULT NOW(),
    fin_vida_util_version      TIMESTAMP,

    -- Mujeres y hombres no pueden sumar más que el total del hogar.
    -- Antes, a nivel comunidad, nada impedía guardar 180 personas de las
    -- cuales 90 mujeres y 200 hombres.
    CONSTRAINT chk_familia_suma CHECK (
        numero_personas IS NULL
        OR COALESCE(numero_mujeres, 0) + COALESCE(numero_hombres, 0) <= numero_personas
    )
);

COMMENT ON TABLE tpc_interesado_familia IS
    'COL_Interesado — la familia como titular de un derecho de uso dentro del territorio colectivo. Especialización propia, paralela a tpc_interesado_comunidad.';
COMMENT ON COLUMN tpc_interesado_familia.origen_asignacion IS
    'Cómo llegó la familia a ocupar ese lugar: asignación de la asamblea, herencia, ocupación antigua. Extensión propia: el estándar no modela la asignación interna.';

CREATE INDEX IF NOT EXISTS idx_familia_comunidad ON tpc_interesado_familia (comunidad_id);

SELECT fn_crear_catalogo('tpc_origenasignaciontipo',
    'Cómo la familia llegó a ocupar su parcela dentro del territorio colectivo. Extensión propia.');

SELECT fn_valor_catalogo('tpc_origenasignaciontipo', 'Asignacion_Asamblea', 'Asignada por la asamblea',
    'La autoridad de la comunidad le adjudicó el lugar conforme al reglamento interno.', true, NULL);
SELECT fn_valor_catalogo('tpc_origenasignaciontipo', 'Herencia_Familiar', 'Heredada en la familia',
    'Pasó de padres a hijos dentro del mismo hogar.', true, NULL);
SELECT fn_valor_catalogo('tpc_origenasignaciontipo', 'Ocupacion_Antigua', 'Ocupación anterior al título',
    'La familia ya estaba allí antes de que se titulara el territorio colectivo.', true, NULL);
SELECT fn_valor_catalogo('tpc_origenasignaciontipo', 'Permuta_Interna', 'Intercambio entre familias',
    'Permuta o cesión acordada entre familias y avalada por la comunidad.', true, NULL);
SELECT fn_valor_catalogo('tpc_origenasignaciontipo', 'Desconocido', 'No se sabe', NULL, true, NULL);

-- El uso de una parcela familiar no se parece al uso del territorio
-- colectivo: allá se habla de uso comunitario o tradicional, aquí de si
-- la familia vive, siembra o las dos cosas. Se agregan al mismo catálogo
-- para no partir la enumeración en dos.
SELECT fn_valor_catalogo('ext_usotipo', 'Vivienda',            'Vivienda de la familia',        'La parcela es principalmente el lugar donde vive el hogar.', true, NULL);
SELECT fn_valor_catalogo('ext_usotipo', 'Cultivo',             'Cultivo o pancoger',            'Se usa sobre todo para sembrar.', true, NULL);
SELECT fn_valor_catalogo('ext_usotipo', 'Vivienda_y_Cultivo',  'Vivienda y cultivo',            'La casa y la siembra en el mismo lugar, lo más frecuente.', true, NULL);
SELECT fn_valor_catalogo('ext_usotipo', 'Ganaderia',           'Cría de animales',              NULL, true, NULL);
SELECT fn_valor_catalogo('ext_usotipo', 'Bosque_Conservacion', 'Bosque o área de conservación', 'La familia la cuida sin explotarla.', true, NULL);

SELECT fn_vincular_catalogo('tpc_interesado_familia', 'origen_asignacion', 'tpc_origenasignaciontipo');
SELECT fn_vincular_catalogo('tpc_interesado_familia', 'tipo_documento',    'tpc_documentotipo');
SELECT fn_vincular_catalogo('tpc_interesado_familia', 'antiguedad_ocupacion', 'ext_antiguedadtipo');
SELECT fn_vincular_catalogo('tpc_predio',             'nivel_tenencia',    'tpc_niveltenenciatipo');

-- Identificación y vigencia automáticas, igual que en las demás clases.
DROP TRIGGER IF EXISTS trig_versionado ON tpc_interesado_familia;
CREATE TRIGGER trig_versionado BEFORE INSERT ON tpc_interesado_familia
    FOR EACH ROW EXECUTE FUNCTION fn_objeto_versionado();

COMMIT;


-- ======================================================================
--  4. EL DERECHO APUNTA A UNA UNIDAD CONCRETA
--
--  Hasta ahora tpc_derecho colgaba solo de la comunidad, sin decir sobre
--  qué unidad recaía. En LADM el COL_DRR conecta un interesado con una
--  unidad administrativa básica, así que este campo faltaba desde antes
--  de pensar en familias: sin él no se puede expresar que la comunidad
--  tiene propiedad sobre el territorio y una familia uso sobre su parcela.
-- ======================================================================

BEGIN;

ALTER TABLE tpc_derecho
    ADD COLUMN IF NOT EXISTS predio_id  INTEGER REFERENCES tpc_predio(id)             ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS familia_id INTEGER REFERENCES tpc_interesado_familia(id) ON DELETE CASCADE;

COMMENT ON COLUMN tpc_derecho.predio_id IS
    'Unidad sobre la que recae el derecho. En el nivel colectivo es el territorio; en el familiar, la parcela.';
COMMENT ON COLUMN tpc_derecho.familia_id IS
    'Titular cuando el derecho es de una familia. Nulo cuando el titular es la comunidad entera.';

CREATE INDEX IF NOT EXISTS idx_derecho_predio  ON tpc_derecho (predio_id)  WHERE predio_id  IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_derecho_familia ON tpc_derecho (familia_id) WHERE familia_id IS NOT NULL;

-- Atar los derechos ya guardados a su predio colectivo.
UPDATE tpc_derecho d
SET predio_id = p.id
FROM tpc_predio p
WHERE p.comunidad_id = d.comunidad_id
  AND p.nivel_tenencia = 'Colectivo'
  AND d.predio_id IS NULL;

COMMIT;


-- ======================================================================
--  5. LA JERARQUÍA, EXPRESADA COMO LA DEFINE EL ESTÁNDAR
--
--  predio_matriz_id resuelve la consulta del día a día. Pero el modelo
--  define la agrupación de unidades espaciales como una clase propia, así
--  que se mantiene poblada automáticamente: cada territorio colectivo que
--  tenga parcelas familiares genera su agrupación, y cada parcela entra
--  como miembro. Así la clase no queda decorativa.
-- ======================================================================

BEGIN;

CREATE OR REPLACE FUNCTION fn_sincronizar_agrupacion_espacial()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_agrupacion_id INTEGER;
    v_nombre        TEXT;
BEGIN
    IF NEW.predio_matriz_id IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT COALESCE(t.nombre_territorio, c.nombre_comunidad, 'Territorio ' || p.id)
      INTO v_nombre
      FROM tpc_predio p
      JOIN tpc_interesado_comunidad c ON c.id = p.comunidad_id
      LEFT JOIN tpc_territorio_propiedad_colectiva t ON t.comunidad_id = c.id
     WHERE p.id = NEW.predio_matriz_id;

    SELECT a.t_id INTO v_agrupacion_id
      FROM col_agrupacionunidadesespaciales a
     WHERE a.local_id = 'AGRUP_UE_' || NEW.predio_matriz_id;

    IF v_agrupacion_id IS NULL THEN
        INSERT INTO col_agrupacionunidadesespaciales (nombre, nivel_jerarquico, punto_referencia, local_id)
        SELECT 'Parcelas de ' || v_nombre, 1, p.geom, 'AGRUP_UE_' || NEW.predio_matriz_id
        FROM tpc_predio p WHERE p.id = NEW.predio_matriz_id
        RETURNING t_id INTO v_agrupacion_id;
    END IF;

    INSERT INTO col_ue_agrupacion (agrupacion_id, predio_id)
    VALUES (v_agrupacion_id, NEW.id)
    ON CONFLICT (agrupacion_id, predio_id) DO NOTHING;

    RETURN NULL;
END $$;

COMMENT ON FUNCTION fn_sincronizar_agrupacion_espacial IS
    'Mantiene COL_AgrupacionUnidadesEspaciales al día: cada parcela familiar entra como miembro de la agrupación de su territorio.';

DROP TRIGGER IF EXISTS trig_agrupacion_espacial ON tpc_predio;
CREATE TRIGGER trig_agrupacion_espacial
    AFTER INSERT OR UPDATE OF predio_matriz_id ON tpc_predio
    FOR EACH ROW EXECUTE FUNCTION fn_sincronizar_agrupacion_espacial();

COMMIT;


-- ======================================================================
--  6. VISTAS
-- ======================================================================

BEGIN;

-- El censo declarado frente al censo medido.
--
-- Es el mismo patrón que ya existe con la superficie: el área del acto
-- administrativo (lo que dice el documento) junto al área geodésica del
-- polígono (lo que se midió). Aquí, la estimación que dio la autoridad
-- junto a la suma real de los hogares registrados.
CREATE OR REPLACE VIEW vista_censo_comunidad AS
SELECT
    c.id                                        AS comunidad_id,
    c.nombre_comunidad,
    c.numero_familias                           AS familias_declaradas,
    COUNT(f.id)                                 AS familias_registradas,
    c.numero_personas                           AS personas_declaradas,
    SUM(f.numero_personas)                      AS personas_registradas,
    c.numero_mujeres                            AS mujeres_declaradas,
    SUM(f.numero_mujeres)                       AS mujeres_registradas,
    c.numero_hombres                            AS hombres_declarados,
    SUM(f.numero_hombres)                       AS hombres_registrados,
    CASE
        WHEN COUNT(f.id) = 0 THEN NULL
        WHEN c.numero_personas IS NULL OR c.numero_personas = 0 THEN NULL
        ELSE ROUND((SUM(f.numero_personas)::NUMERIC / c.numero_personas) * 100, 1)
    END                                         AS cobertura_censo_pct
FROM tpc_interesado_comunidad c
LEFT JOIN tpc_interesado_familia f ON f.comunidad_id = c.id
GROUP BY c.id, c.nombre_comunidad, c.numero_familias,
         c.numero_personas, c.numero_mujeres, c.numero_hombres;

COMMENT ON VIEW vista_censo_comunidad IS
    'Compara la población que estimó la autoridad con la que suman las familias efectivamente registradas. La cobertura dice qué tanto del territorio se ha levantado casa por casa.';

-- Solo los territorios colectivos.
--
-- Hace falta porque el visor une tpc_predio con la comunidad en casi todas
-- sus consultas, dando por hecho que hay un predio por comunidad. Con
-- parcelas familiares en la misma tabla eso deja de ser cierto: cada
-- comunidad pasaría a tener varias filas, los totales se contarían de más,
-- y el análisis de traslapes reportaría que cada parcela se superpone con
-- su propio territorio. El visor consulta esta vista en lugar de la tabla.
CREATE OR REPLACE VIEW vista_predio_colectivo AS
SELECT * FROM tpc_predio WHERE nivel_tenencia = 'Colectivo' OR nivel_tenencia IS NULL;

COMMENT ON VIEW vista_predio_colectivo IS
    'tpc_predio sin las parcelas familiares. Es la que debe usar cualquier consulta que asuma un predio por comunidad.';

-- Las parcelas familiares con su familia y su superficie real.
CREATE OR REPLACE VIEW vista_parcelas_familiares AS
SELECT
    p.id                              AS predio_id,
    p.predio_matriz_id,
    c.id                              AS comunidad_id,
    c.nombre_comunidad,
    f.id                              AS familia_id,
    f.nombre_familia,
    f.jefe_hogar,
    f.numero_personas,
    f.numero_mujeres,
    f.numero_hombres,
    f.antiguedad_ocupacion,
    f.origen_asignacion,
    d.tipo_derecho,
    p.vereda,
    p.metodo_captura_perimetro,
    CASE WHEN p.geom_perimetro IS NULL THEN NULL ELSE
        ROUND((ST_Area(p.geom_perimetro::geography) / 10000)::NUMERIC, 4) END AS area_real_ha,
    ST_AsGeoJSON(p.geom_perimetro)::json AS poligono,
    ST_Y(p.geom)                      AS latitud,
    ST_X(p.geom)                      AS longitud
FROM tpc_predio p
JOIN tpc_interesado_comunidad c ON c.id = p.comunidad_id
LEFT JOIN tpc_derecho d          ON d.predio_id = p.id
LEFT JOIN tpc_interesado_familia f ON f.id = d.familia_id
WHERE p.nivel_tenencia = 'Familiar';

COMMENT ON VIEW vista_parcelas_familiares IS
    'Una fila por parcela familiar, con su hogar, su derecho de uso y su superficie medida.';

-- El informe de cobertura tiene que incluir lo que agrega esta migración;
-- si no, diría que faltan clases que sí están implementadas. Se redefine
-- aquí, con el nivel familiar añadido y marcado como lo que es: una
-- extensión propia, no una clase del estándar.
CREATE OR REPLACE VIEW vista_ladm_cobertura AS
WITH clases(clase_ladm, tabla, naturaleza) AS (VALUES
    ('COL_Interesado / TPC_InteresadoComunidad',   'tpc_interesado_comunidad',           'Núcleo LADM'),
    ('COL_Interesado / Representante legal',       'tpc_representante_legal',            'Núcleo LADM'),
    ('COL_UnidadAdministrativaBasica / Territorio','tpc_territorio_propiedad_colectiva', 'Núcleo LADM'),
    ('COL_UnidadAdministrativaBasica / TPC_Predio','tpc_predio',                         'Núcleo LADM'),
    ('COL_DRR / Derecho',                          'tpc_derecho',                        'Núcleo LADM'),
    ('COL_DRR / Restricción',                      'tpc_restriccion',                    'Núcleo LADM'),
    ('COL_Fuente / Administrativa',                'tpc_fuente_administrativa',          'Núcleo LADM'),
    ('COL_Fuente / Espacial',                      'tpc_fuente_espacial',                'Núcleo LADM'),
    ('COL_Punto',                                  'col_punto',                          'Topología del lindero'),
    ('COL_CadenaDeLimite',                         'col_cadenadelimite',                 'Topología del lindero'),
    ('COL_CarasLindero',                           'col_caraslindero',                   'Topología del lindero'),
    ('COL_AgrupacionInteresados',                  'col_agrupacioninteresados',          'Agrupaciones'),
    ('COL_Miembros',                               'col_miembros',                       'Agrupaciones'),
    ('COL_AgrupacionUnidadesEspaciales',           'col_agrupacionunidadesespaciales',   'Agrupaciones'),
    ('COL_UEAgrupacion',                           'col_ue_agrupacion',                  'Agrupaciones'),
    ('RRRFuente',                                  'col_rrrfuente',                      'Asociaciones'),
    ('UEFuente',                                   'col_uefuente',                       'Asociaciones'),
    -- Nivel familiar: la familia es un interesado más, con su derecho de
    -- uso sobre una unidad espacial que está dentro del territorio. La
    -- tripleta es la del estándar; la especialización «familia» es propia,
    -- igual que lo es «comunidad».
    ('COL_Interesado / La familia',                'tpc_interesado_familia',             'Extensión propia'),
    ('ExtDireccion',                               'ext_direccion',                      'Extensión propia'),
    ('EXT_HistoriaTerritorio',                     'ext_historia_territorio',            'Extensión propia'),
    ('EXT_UsoTerritorio',                          'ext_uso_territorio',                 'Extensión propia'),
    ('EXT_ValidacionComunitaria',                  'ext_validacion_comunitaria',         'Extensión propia'),
    ('EXT_TranscripcionRespuesta',                 'ext_transcripcion_respuesta',        'Extensión propia'),
    ('EXT_FotoRegistro',                           'ext_foto_registro',                  'Extensión propia')
)
SELECT
    c.clase_ladm,
    c.tabla,
    c.naturaleza,
    to_regclass('public.' || c.tabla) IS NOT NULL AS existe,
    fn_contar_filas(c.tabla)                      AS filas
FROM clases c;

COMMENT ON VIEW vista_ladm_cobertura IS
    'Una fila por clase del modelo: si la tabla existe y cuántos registros tiene. Distingue el núcleo del estándar de las extensiones propias de este trabajo.';

COMMIT;


-- ======================================================================
--  7. VERIFICACIÓN
-- ======================================================================

DO $$
DECLARE
    n_col       INTEGER;
    n_fam       INTEGER;
    n_familias  INTEGER;
    tiene_pred  BOOLEAN;
BEGIN
    SELECT COUNT(*) INTO n_col FROM tpc_predio WHERE nivel_tenencia = 'Colectivo';
    SELECT COUNT(*) INTO n_fam FROM tpc_predio WHERE nivel_tenencia = 'Familiar';
    SELECT COUNT(*) INTO n_familias FROM tpc_interesado_familia;
    SELECT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'tpc_derecho' AND column_name = 'predio_id') INTO tiene_pred;

    RAISE NOTICE '';
    RAISE NOTICE '======================================================';
    RAISE NOTICE '  Levantamiento por familias habilitado';
    RAISE NOTICE '======================================================';
    RAISE NOTICE '  Territorios colectivos     : %', n_col;
    RAISE NOTICE '  Parcelas familiares        : %', n_fam;
    RAISE NOTICE '  Familias registradas       : %', n_familias;
    RAISE NOTICE '  Derecho atado a la unidad  : %', tiene_pred;
    RAISE NOTICE '======================================================';
    RAISE NOTICE '  Censo:     SELECT * FROM vista_censo_comunidad;';
    RAISE NOTICE '  Parcelas:  SELECT * FROM vista_parcelas_familiares;';
    RAISE NOTICE '';
END $$;
