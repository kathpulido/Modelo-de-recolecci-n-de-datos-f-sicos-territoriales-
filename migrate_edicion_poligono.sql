-- ============================================================================
--  migrate_edicion_poligono.sql
--
--  Edición de polígonos desde el geovisor y unión automática de geometrías.
--
--  Hasta ahora el perímetro solo entraba por el bot: la comunidad dibujaba
--  el croquis o hacía el recorrido GPS, y lo que llegara quedaba como
--  geometría definitiva. Eso deja dos problemas sin salida desde el visor:
--
--    · huecos — al juntar las parcelas familiares quedan franjas vacías
--      entre una y otra, porque cada familia midió su lindero por separado
--      y dos recorridos GPS del mismo lindero nunca caen en el mismo sitio;
--
--    · traslapes — dos parcelas (o dos territorios vecinos) se montan la
--      una sobre la otra por el mismo motivo, y el área sumada cuenta de
--      más esa franja.
--
--  Esta migración agrega lo necesario para que la persona administradora
--  corrija ambas cosas sin salir del visor y sin tocar la base a mano:
--  una bitácora de cada cambio de geometría, y las funciones PostGIS que
--  hacen la unión y la limpieza.
--
--  Aplicar después de migrate_ladm.sql y migrate_familias.sql.
--  Es idempotente: se puede correr varias veces.
-- ============================================================================

BEGIN;

/* ===========================================================================
   1. BITÁCORA DE CAMBIOS DE GEOMETRÍA
   ---------------------------------------------------------------------------
   Toda edición guarda la geometría anterior completa. Es lo que permite
   deshacer un cambio y, para la tesis, poder mostrar que la geometría
   oficial tiene trazabilidad: quién la tocó, cuándo y por qué motivo.

   No se borra en cascada junto con el predio a propósito... salvo que el
   predio desaparezca del todo, en cuyo caso la bitácora ya no describe
   nada existente. Por eso sí lleva ON DELETE CASCADE.
=========================================================================== */
CREATE TABLE IF NOT EXISTS geo_edicion_poligono (
    id                SERIAL PRIMARY KEY,
    predio_id         INTEGER NOT NULL REFERENCES tpc_predio(id) ON DELETE CASCADE,

    usuario_id        INTEGER,
    usuario_nombre    VARCHAR(160),

    -- edicion_manual | union_parcelas | cierre_huecos | resolucion_traslape | reversion
    accion            VARCHAR(40)  NOT NULL,
    motivo            TEXT,

    geom_anterior     geometry(Geometry, 4326),
    geom_nueva        geometry(Geometry, 4326),

    area_anterior_ha  NUMERIC(14, 4),
    area_nueva_ha     NUMERIC(14, 4),

    -- Parámetros con los que se corrió la unión (tolerancia, qué predios
    -- entraron, cuántos huecos se cerraron). Sirve para repetir el cálculo
    -- igual y para explicarlo en el documento.
    detalle           JSONB,

    fecha             TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_geo_edicion_predio ON geo_edicion_poligono (predio_id, fecha DESC);
CREATE INDEX IF NOT EXISTS idx_geo_edicion_accion ON geo_edicion_poligono (accion);

COMMENT ON TABLE geo_edicion_poligono IS
    'Bitácora de cambios de geom_perimetro hechos desde el geovisor: guarda la geometría anterior completa, quién la cambió y con qué parámetros.';
COMMENT ON COLUMN geo_edicion_poligono.detalle IS
    'Parámetros de la operación: tolerancia en metros, predios de origen, huecos cerrados, hectáreas ganadas o perdidas.';


/* ===========================================================================
   2. UNIÓN QUE CIERRA HUECOS
   ---------------------------------------------------------------------------
   ST_Union a secas deja las franjas vacías: si dos parcelas vecinas no se
   tocan por 80 cm, la unión de las dos sigue teniendo esos 80 cm de hueco.

   El truco estándar es dilatar y volver a erosionar (buffer positivo y
   luego negativo del mismo tamaño): al dilatar, los bordes se alcanzan y
   la franja desaparece; al erosionar, el contorno exterior vuelve a su
   sitio pero el hueco ya quedó soldado. Cierra separaciones de hasta
   2 × tolerancia.

   El buffer se hace sobre geography, no sobre geometry: así la tolerancia
   se da en METROS de verdad. Con geometry en 4326 el buffer sería en
   grados, y un mismo número valdría distinto en Guajira que en Tolima.
=========================================================================== */
CREATE OR REPLACE FUNCTION fn_unir_y_cerrar(
    p_geoms  geometry[],
    p_tol_m  NUMERIC DEFAULT 2.0
) RETURNS geometry
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v_union geometry;
BEGIN
    SELECT ST_Union(ST_MakeValid(g))
      INTO v_union
      FROM unnest(p_geoms) AS g
     WHERE g IS NOT NULL AND NOT ST_IsEmpty(g);

    IF v_union IS NULL OR ST_IsEmpty(v_union) THEN
        RETURN NULL;
    END IF;

    -- Sin tolerancia es una unión normal: se respetan los huecos tal cual
    -- están. Se deja como opción porque a veces el hueco es real (una
    -- laguna, un predio de un tercero) y soldarlo sería falsear el dato.
    IF p_tol_m IS NULL OR p_tol_m <= 0 THEN
        RETURN ST_MakeValid(v_union);
    END IF;

    v_union := ST_Buffer(v_union::geography,  p_tol_m)::geometry;
    v_union := ST_Buffer(v_union::geography, -p_tol_m)::geometry;

    RETURN ST_MakeValid(v_union);
END $$;

COMMENT ON FUNCTION fn_unir_y_cerrar IS
    'Une varias geometrías cerrando de paso las separaciones menores a 2x la tolerancia (en metros reales, vía geography).';


/* ===========================================================================
   3. QUITAR HUECOS INTERIORES PEQUEÑOS
   ---------------------------------------------------------------------------
   Después de unir quedan huecos interiores diminutos que son ruido de
   medición, no vacíos reales. Se rellenan los que estén por debajo del
   umbral y se conservan los grandes, que sí suelen corresponder a algo
   (una finca ajena dentro del resguardo, un cuerpo de agua excluido).
=========================================================================== */
CREATE OR REPLACE FUNCTION fn_quitar_huecos(
    p_geom    geometry,
    p_min_ha  NUMERIC DEFAULT 0.25
) RETURNS geometry
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v_poly    geometry;
    v_anillos geometry[];
    v_salida  geometry[] := ARRAY[]::geometry[];
    v_ring    geometry;
    v_i       INTEGER;
BEGIN
    IF p_geom IS NULL OR ST_IsEmpty(p_geom) THEN
        RETURN p_geom;
    END IF;

    FOR v_poly IN
        SELECT (ST_Dump(p_geom)).geom
    LOOP
        IF GeometryType(v_poly) <> 'POLYGON' THEN
            CONTINUE;
        END IF;

        v_anillos := ARRAY[]::geometry[];

        FOR v_i IN 1 .. ST_NumInteriorRings(v_poly) LOOP
            v_ring := ST_InteriorRingN(v_poly, v_i);
            -- Se conserva el hueco solo si es grande: por debajo del
            -- umbral se considera ruido de medición y se rellena.
            IF ST_Area(ST_MakePolygon(v_ring)::geography) / 10000.0 >= p_min_ha THEN
                v_anillos := array_append(v_anillos, v_ring);
            END IF;
        END LOOP;

        IF array_length(v_anillos, 1) IS NULL THEN
            v_salida := array_append(v_salida, ST_MakePolygon(ST_ExteriorRing(v_poly)));
        ELSE
            v_salida := array_append(v_salida, ST_MakePolygon(ST_ExteriorRing(v_poly), v_anillos));
        END IF;
    END LOOP;

    IF array_length(v_salida, 1) IS NULL THEN
        RETURN p_geom;
    END IF;

    RETURN ST_SetSRID(ST_MakeValid(ST_Union(v_salida)), 4326);
END $$;

COMMENT ON FUNCTION fn_quitar_huecos IS
    'Rellena los huecos interiores menores al umbral en hectáreas y conserva los grandes, que suelen ser exclusiones reales.';


/* ===========================================================================
   4. DIAGNÓSTICO: QUÉ LE PASA A LA GEOMETRÍA DE UNA COMUNIDAD
   ---------------------------------------------------------------------------
   Devuelve una fila por problema encontrado, con la geometría del problema
   para poder pintarla en el mapa antes de decidir si se corrige.

   Tres tipos:
     hueco_entre_parcelas  — vacío interior en la unión de las parcelas
     traslape_parcelas     — dos parcelas de la misma comunidad montadas
     traslape_vecino       — el territorio se monta con el de otra comunidad
=========================================================================== */
CREATE OR REPLACE FUNCTION fn_diagnostico_geometria(
    p_comunidad_id  INTEGER,
    p_min_ha        NUMERIC DEFAULT 0.02
) RETURNS TABLE (
    tipo         TEXT,
    descripcion  TEXT,
    hectareas    NUMERIC,
    predio_a     INTEGER,
    predio_b     INTEGER,
    -- El visor identifica los territorios por comunidad, no por predio: sin
    -- esta columna, el desplegable de «fundir con el vecino» mandaría un id
    -- de predio donde el backend espera un id de comunidad.
    comunidad_b  INTEGER,
    geometria    JSON
)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_union     geometry;
    v_sin_hueco geometry;
BEGIN
    /* ---- huecos entre parcelas familiares ---- */
    SELECT ST_Union(ST_MakeValid(p.geom_perimetro))
      INTO v_union
      FROM tpc_predio p
     WHERE p.comunidad_id      = p_comunidad_id
       AND p.nivel_tenencia    = 'Familiar'
       AND p.geom_perimetro IS NOT NULL;

    IF v_union IS NOT NULL AND NOT ST_IsEmpty(v_union) THEN
        -- La diferencia entre "la unión con los huecos tapados" y "la unión
        -- tal como está" es exactamente el conjunto de huecos.
        v_sin_hueco := fn_quitar_huecos(v_union, 1e9);   -- umbral enorme = tapa todos

        RETURN QUERY
        SELECT
            'hueco_entre_parcelas'::TEXT,
            'Vacío entre parcelas familiares contiguas'::TEXT,
            ROUND((ST_Area(g.geom::geography) / 10000)::NUMERIC, 4),
            NULL::INTEGER,
            NULL::INTEGER,
            NULL::INTEGER,
            ST_AsGeoJSON(g.geom)::JSON
        FROM (SELECT (ST_Dump(ST_Difference(v_sin_hueco, v_union))).geom) g
        WHERE ST_Area(g.geom::geography) / 10000.0 >= p_min_ha;
    END IF;

    /* ---- traslapes entre parcelas de la misma comunidad ---- */
    RETURN QUERY
    SELECT
        'traslape_parcelas'::TEXT,
        ('Las parcelas ' || pa.id || ' y ' || pb.id || ' se superponen')::TEXT,
        ROUND((ST_Area(ST_Intersection(pa.geom_perimetro, pb.geom_perimetro)::geography) / 10000)::NUMERIC, 4),
        pa.id,
        pb.id,
        NULL::INTEGER,
        ST_AsGeoJSON(ST_Intersection(pa.geom_perimetro, pb.geom_perimetro))::JSON
    FROM tpc_predio pa
    JOIN tpc_predio pb
      ON pa.id < pb.id
     AND pa.comunidad_id   = pb.comunidad_id
     AND pa.nivel_tenencia = 'Familiar'
     AND pb.nivel_tenencia = 'Familiar'
     AND pa.geom_perimetro IS NOT NULL
     AND pb.geom_perimetro IS NOT NULL
     AND ST_Intersects(pa.geom_perimetro, pb.geom_perimetro)
     AND NOT ST_Touches(pa.geom_perimetro, pb.geom_perimetro)
    WHERE pa.comunidad_id = p_comunidad_id
      AND ST_Area(ST_Intersection(pa.geom_perimetro, pb.geom_perimetro)::geography) / 10000.0 >= p_min_ha;

    /* ---- traslapes con territorios vecinos ---- */
    RETURN QUERY
    SELECT
        'traslape_vecino'::TEXT,
        ('Se superpone con el territorio de ' || cb.nombre_comunidad)::TEXT,
        ROUND((ST_Area(ST_Intersection(pa.geom_perimetro, pb.geom_perimetro)::geography) / 10000)::NUMERIC, 4),
        pa.id,
        pb.id,
        cb.id,
        ST_AsGeoJSON(ST_Intersection(pa.geom_perimetro, pb.geom_perimetro))::JSON
    FROM tpc_predio pa
    JOIN tpc_predio pb
      ON pa.id <> pb.id
     AND pa.comunidad_id <> pb.comunidad_id
     AND COALESCE(pa.nivel_tenencia, 'Colectivo') = 'Colectivo'
     AND COALESCE(pb.nivel_tenencia, 'Colectivo') = 'Colectivo'
     AND pa.geom_perimetro IS NOT NULL
     AND pb.geom_perimetro IS NOT NULL
     AND ST_Intersects(pa.geom_perimetro, pb.geom_perimetro)
     AND NOT ST_Touches(pa.geom_perimetro, pb.geom_perimetro)
    JOIN tpc_interesado_comunidad cb ON cb.id = pb.comunidad_id
    WHERE pa.comunidad_id = p_comunidad_id
      AND ST_Area(ST_Intersection(pa.geom_perimetro, pb.geom_perimetro)::geography) / 10000.0 >= p_min_ha;
END $$;

COMMENT ON FUNCTION fn_diagnostico_geometria IS
    'Lista los problemas geométricos de una comunidad (huecos entre parcelas y traslapes) con la geometría de cada uno para pintarla en el mapa.';


/* ===========================================================================
   5. VISTA DE RESUMEN PARA LAS ALERTAS DEL VISOR
   ---------------------------------------------------------------------------
   Una fila por comunidad con cuántos problemas tiene y cuántas hectáreas
   están en discusión. La pestaña Informes ya lee alertas de calidad; esta
   vista le da las geométricas sin recalcular todo el diagnóstico.
=========================================================================== */
CREATE OR REPLACE VIEW vista_calidad_geometrica AS
SELECT
    c.id                                    AS comunidad_id,
    c.nombre_comunidad,
    COUNT(*) FILTER (WHERE d.tipo = 'hueco_entre_parcelas')  AS huecos,
    COUNT(*) FILTER (WHERE d.tipo LIKE 'traslape%')          AS traslapes,
    ROUND(COALESCE(SUM(d.hectareas) FILTER (WHERE d.tipo = 'hueco_entre_parcelas'), 0), 4) AS ha_en_huecos,
    ROUND(COALESCE(SUM(d.hectareas) FILTER (WHERE d.tipo LIKE 'traslape%'), 0), 4)         AS ha_en_traslapes
FROM tpc_interesado_comunidad c
LEFT JOIN LATERAL fn_diagnostico_geometria(c.id) d ON TRUE
GROUP BY c.id, c.nombre_comunidad;

COMMENT ON VIEW vista_calidad_geometrica IS
    'Resumen por comunidad de huecos y traslapes detectados, para las alertas de calidad del geovisor.';

COMMIT;

-- ============================================================================
--  Comprobación rápida después de aplicar:
--
--    SELECT * FROM fn_diagnostico_geometria(1);
--    SELECT * FROM vista_calidad_geometrica ORDER BY traslapes DESC;
--
--  Para deshacer una edición concreta (la bitácora guarda el polígono
--  anterior completo):
--
--    UPDATE tpc_predio p
--       SET geom_perimetro = e.geom_anterior
--      FROM geo_edicion_poligono e
--     WHERE e.id = <id de la edición> AND p.id = e.predio_id;
-- ============================================================================
