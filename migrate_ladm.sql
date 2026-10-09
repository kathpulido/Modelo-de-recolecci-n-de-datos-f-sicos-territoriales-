-- ======================================================================
--  MIGRACIÓN: acercar la base de datos al modelo LADM-COL (ISO 19152)
--
--  Ejecutar una sola vez, DESPUÉS de las otras tres migraciones:
--      psql -U postgres -d catastro_etnico -f migrate_ladm.sql
--
--  Es segura de correr más de una vez: todo lo que hace es agregar, y los
--  pocos valores que renombra quedan registrados en los catálogos con su
--  equivalencia.
--
--  Una advertencia honesta: la topología del lindero (COL_Punto y
--  COL_CadenaDeLimite) se rehace desde cero cada vez que cambia el
--  polígono de un territorio. Si alguien escribió a mano la descripción de
--  un tramo o corrigió la exactitud de un vértice, corregir después ese
--  polígono borra esas anotaciones. Volver a correr esta migración NO las
--  borra — solo genera topología donde todavía no hay.
--
--  Qué cambia, en resumen:
--    1. Catálogos de enumeración estilo LADM (ilicode / dispname), con
--       llave foránea desde las columnas que hoy son texto libre.
--    2. Atributos de <<ObjetoVersionado>> en las clases del núcleo.
--    3. Topología del lindero: COL_Punto, COL_CadenaDeLimite y
--       COL_CarasLindero, generadas automáticamente desde el perímetro.
--    4. Las agrupaciones (COL_AgrupacionInteresados con su participación,
--       y COL_AgrupacionUnidadesEspaciales).
--    5. Las asociaciones fuente↔derecho y fuente espacial↔unidad espacial.
--    6. Los atributos registrales de TPC_Predio y el nombre del
--       representante descompuesto.
--
--  Lo que NO cambia: las tablas EXT_ propias de este trabajo se conservan
--  tal cual, y solo se les agrega el catálogo de sus enumeraciones.
-- ======================================================================

BEGIN;

-- ======================================================================
--  0. HERRAMIENTAS INTERNAS
--
--  Tres funciones auxiliares para no repetir el mismo bloque veinte
--  veces. Se usan solo durante la migración; quedan en la base porque
--  también sirven para agregar valores nuevos a un catálogo más adelante.
-- ======================================================================

-- Crea una tabla de catálogo con la estructura que el modelo LADM-COL
-- genera para cada enumeración. Los nombres de columna siguen la
-- convención INTERLIS (t_id, iliCode, dispName) en minúscula, que es como
-- PostgreSQL las guarda de todos modos.
CREATE OR REPLACE FUNCTION fn_crear_catalogo(p_nombre TEXT, p_comentario TEXT)
RETURNS VOID LANGUAGE plpgsql AS $fn$
BEGIN
    EXECUTE format($f$
        CREATE TABLE IF NOT EXISTS %I (
            t_id             SERIAL       PRIMARY KEY,
            ilicode          VARCHAR(120) NOT NULL UNIQUE,
            dispname         VARCHAR(200) NOT NULL,
            descripcion      TEXT,
            es_extension     BOOLEAN      NOT NULL DEFAULT false,
            equivalente_ladm VARCHAR(200),
            activo           BOOLEAN      NOT NULL DEFAULT true
        )
    $f$, p_nombre);

    EXECUTE format('COMMENT ON TABLE %I IS %L', p_nombre, p_comentario);
END
$fn$;

COMMENT ON FUNCTION fn_crear_catalogo IS
    'Crea una tabla de catálogo de enumeración con la estructura LADM/INTERLIS (t_id, ilicode, dispname, descripcion).';

-- Agrega o actualiza un valor dentro de un catálogo.
--   p_ext   = true  → es un valor propio de esta implementación, no del estándar
--   p_equiv         → a qué valor del estándar corresponde, cuando es extensión
CREATE OR REPLACE FUNCTION fn_valor_catalogo(
    p_cat      TEXT,
    p_ilicode  TEXT,
    p_dispname TEXT,
    p_desc     TEXT    DEFAULT NULL,
    p_ext      BOOLEAN DEFAULT false,
    p_equiv    TEXT    DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql AS $fn$
BEGIN
    EXECUTE format($f$
        INSERT INTO %I (ilicode, dispname, descripcion, es_extension, equivalente_ladm, activo)
        VALUES ($1, $2, $3, $4, $5, true)
        ON CONFLICT (ilicode) DO UPDATE SET
            dispname         = EXCLUDED.dispname,
            descripcion      = COALESCE(EXCLUDED.descripcion, %I.descripcion),
            es_extension     = EXCLUDED.es_extension,
            equivalente_ladm = EXCLUDED.equivalente_ladm,
            activo           = true
    $f$, p_cat, p_cat)
    USING p_ilicode, p_dispname, p_desc, p_ext, p_equiv;
END
$fn$;

COMMENT ON FUNCTION fn_valor_catalogo IS
    'Inserta o actualiza un valor de enumeración. es_extension marca los valores propios, equivalente_ladm su correspondencia con el estándar.';

-- Enlaza una columna de texto con su catálogo mediante llave foránea.
--
-- Antes de crear la llave, cualquier valor que ya esté guardado y no
-- figure en el catálogo se agrega como "valor heredado" (inactivo). Así la
-- migración nunca falla por datos viejos, y al mismo tiempo queda a la
-- vista qué vocabulario se usaba antes.
CREATE OR REPLACE FUNCTION fn_vincular_catalogo(p_tabla TEXT, p_columna TEXT, p_catalogo TEXT)
RETURNS VOID LANGUAGE plpgsql AS $fn$
DECLARE
    v_fk TEXT := left(format('fk_%s_%s', p_tabla, p_columna), 63);
BEGIN
    EXECUTE format($f$
        INSERT INTO %I (ilicode, dispname, descripcion, es_extension, activo)
        SELECT DISTINCT t.%I, t.%I,
               'Valor heredado de la implementación anterior a la alineación con LADM-COL',
               true, false
        FROM %I t
        WHERE t.%I IS NOT NULL
          AND btrim(t.%I) <> ''
          AND NOT EXISTS (SELECT 1 FROM %I c WHERE c.ilicode = t.%I)
    $f$, p_catalogo, p_columna, p_columna, p_tabla, p_columna, p_columna, p_catalogo, p_columna);

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = v_fk AND conrelid = p_tabla::regclass
    ) THEN
        EXECUTE format(
            'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I(ilicode) ON UPDATE CASCADE',
            p_tabla, v_fk, p_columna, p_catalogo
        );
    END IF;
END
$fn$;

COMMENT ON FUNCTION fn_vincular_catalogo IS
    'Crea la llave foránea de una columna hacia su catálogo, absorbiendo primero los valores heredados para que la migración no falle.';


-- ======================================================================
--  1. CATÁLOGOS DE ENUMERACIÓN
--
--  En el modelo LADM-COL cada <<enumeration>> se materializa como una
--  tabla de catálogo. Hasta ahora estos valores vivían como texto libre
--  con un comentario al lado: nada impedía guardar un valor inexistente,
--  ni había forma de consultar desde SQL qué valores son válidos.
-- ======================================================================

SELECT fn_crear_catalogo('tpc_comunidadtipo',            'TPC_ComunidadTipo — tipo de comunidad o grupo étnico titular.');
SELECT fn_crear_catalogo('tpc_procedimientotipo',        'TPC_ProcedimientoTipo — procedimiento agrario por el que se constituye o modifica el territorio.');
SELECT fn_crear_catalogo('tpc_actoadministrativotipo',   'TPC_ActoAdministrativoTipo — clase de acto administrativo que soporta la fuente.');
SELECT fn_crear_catalogo('tpc_documentotipo',            'TPC_DocumentoTipo — tipo de documento de identificación del interesado.');
SELECT fn_crear_catalogo('tpc_cargotipo',                'Cargo de la autoridad que representa a la comunidad. Extensión propia sobre COL_Interesado.');
SELECT fn_crear_catalogo('tpc_organizacionfilialtipo',   'Forma organizativa de la comunidad. Extensión propia.');
SELECT fn_crear_catalogo('col_derechotipo',              'COL_DerechoTipo — derecho que ejerce el interesado sobre la unidad administrativa básica.');
SELECT fn_crear_catalogo('col_restricciontipo',          'COL_RestriccionTipo — restricciones y servidumbres que pesan sobre el territorio.');
SELECT fn_crear_catalogo('col_fuenteadministrativatipo', 'COL_FuenteAdministrativaTipo — naturaleza jurídica del documento que sustenta el derecho.');
SELECT fn_crear_catalogo('col_fuenteespacialtipo',       'COL_FuenteEspacialTipo — clase de insumo cartográfico del que proviene la geometría.');
SELECT fn_crear_catalogo('col_metodoproducciontipo',     'COL_MetodoProduccionTipo — cómo se determinó la posición de un objeto espacial.');
SELECT fn_crear_catalogo('col_interpolaciontipo',        'COL_InterpolacionTipo — forma en que se interpola el tramo entre dos puntos del lindero.');
SELECT fn_crear_catalogo('col_puntotipo',                'COL_PuntoTipo — función del punto dentro del levantamiento.');
SELECT fn_crear_catalogo('col_estructuratipo',           'COL_EstructuraTipo — estructura geométrica con que se representa la unidad espacial.');
SELECT fn_crear_catalogo('ext_antiguedadtipo',           'Antigüedad de la ocupación del territorio. Extensión propia (EXT_HistoriaTerritorio).');
SELECT fn_crear_catalogo('ext_usotipo',                  'Tipo de uso colectivo del territorio. Extensión propia (EXT_UsoTerritorio).');
SELECT fn_crear_catalogo('ext_validaciontipo',           'Estado de validación comunitaria del registro. Extensión propia (EXT_ValidacionComunitaria).');
SELECT fn_crear_catalogo('ext_limitestipo',              'Elemento con que la comunidad describe sus linderos. Extensión propia.');
SELECT fn_crear_catalogo('ext_reconocimientotipo',       'Estado de reconocimiento del territorio por el Estado. Extensión propia.');
SELECT fn_crear_catalogo('ext_fotocategoria',            'Categoría de las fotografías adjuntas durante el registro. Extensión propia.');


-- ─── TPC_ComunidadTipo ────────────────────────────────────────────────
SELECT fn_valor_catalogo('tpc_comunidadtipo', 'Comunidad_Negra',      'Comunidad negra',            'Consejo comunitario de comunidades negras, afrocolombianas, raizales o palenqueras.');
SELECT fn_valor_catalogo('tpc_comunidadtipo', 'Comunidad_Indigena',   'Comunidad indígena',         'Comunidad indígena sin resguardo constituido. Faltaba en la implementación anterior.');
SELECT fn_valor_catalogo('tpc_comunidadtipo', 'Cabildo',              'Cabildo indígena',           'Entidad pública especial de gobierno propio.');
SELECT fn_valor_catalogo('tpc_comunidadtipo', 'Parcialidad',          'Parcialidad indígena',       'Grupo indígena que no ha constituido resguardo ni cabildo.');
SELECT fn_valor_catalogo('tpc_comunidadtipo', 'Resguardo_Indigena',   'Resguardo indígena',         'Territorio con título colectivo de propiedad reconocido por el Estado.');
SELECT fn_valor_catalogo('tpc_comunidadtipo', 'Territorio_Colectivo', 'Territorio colectivo',       'Territorio colectivo titulado a comunidades negras.');

-- ─── TPC_ProcedimientoTipo ────────────────────────────────────────────
SELECT fn_valor_catalogo('tpc_procedimientotipo', 'Constitucion_ResguardosIndigenas',            'Constitución de resguardo indígena',        'Procedimiento por el que se crea un resguardo nuevo. Faltaba en la implementación anterior.');
SELECT fn_valor_catalogo('tpc_procedimientotipo', 'Ampliacion_ResguardosIndigenas',              'Ampliación de resguardo indígena',          NULL);
SELECT fn_valor_catalogo('tpc_procedimientotipo', 'Ampliacion_Saneamiento_ResguardosIndigenas',  'Ampliación y saneamiento de resguardo',     NULL);
SELECT fn_valor_catalogo('tpc_procedimientotipo', 'Reestructuracion_ResguardosIndigenas',        'Reestructuración de resguardo',             NULL);
SELECT fn_valor_catalogo('tpc_procedimientotipo', 'Conversion_Reservas_Resguardos',              'Conversión de reserva en resguardo',        NULL);
SELECT fn_valor_catalogo('tpc_procedimientotipo', 'Titulacion_Comunidades_Negras',               'Titulación de comunidades negras',          NULL);
SELECT fn_valor_catalogo('tpc_procedimientotipo', 'En_Proceso',                                  'En proceso / aún no reconocido',            'Valor propio: el modelo no contempla el territorio sin procedimiento iniciado, pero la captura comunitaria sí lo encuentra.', true, NULL);

-- ─── TPC_ActoAdministrativoTipo ───────────────────────────────────────
SELECT fn_valor_catalogo('tpc_actoadministrativotipo', 'Resolucion',      'Resolución',                        NULL);
SELECT fn_valor_catalogo('tpc_actoadministrativotipo', 'Acuerdo',         'Acuerdo',                           NULL);
SELECT fn_valor_catalogo('tpc_actoadministrativotipo', 'Decreto',         'Decreto',                           'Varias titulaciones colectivas se formalizaron por decreto. Faltaba en la implementación anterior.');
SELECT fn_valor_catalogo('tpc_actoadministrativotipo', 'Sentencia',       'Sentencia judicial',                'Restitución de tierras y fallos de tutela con efectos territoriales.');
SELECT fn_valor_catalogo('tpc_actoadministrativotipo', 'Folio_Matricula', 'Folio de matrícula inmobiliaria',   'Valor propio: en el estándar el folio es una fuente registral, no un acto administrativo.', true, 'Documento_Publico');
SELECT fn_valor_catalogo('tpc_actoadministrativotipo', 'Sin_Documento',   'No existe documento oficial',       'Valor propio: registra la ausencia de soporte documental, situación frecuente en territorios no titulados.', true, NULL);

-- ─── TPC_DocumentoTipo ────────────────────────────────────────────────
SELECT fn_valor_catalogo('tpc_documentotipo', 'Cedula_Ciudadania',  'Cédula de ciudadanía',   NULL);
SELECT fn_valor_catalogo('tpc_documentotipo', 'Cedula_Extranjeria', 'Cédula de extranjería',  NULL);
SELECT fn_valor_catalogo('tpc_documentotipo', 'Tarjeta_Identidad',  'Tarjeta de identidad',   NULL);
SELECT fn_valor_catalogo('tpc_documentotipo', 'Pasaporte',          'Pasaporte',              NULL);
SELECT fn_valor_catalogo('tpc_documentotipo', 'NIT',                'NIT',                    'Número de identificación tributaria, para el consejo comunitario o cabildo como persona jurídica.');
SELECT fn_valor_catalogo('tpc_documentotipo', 'NUIP',               'NUIP',                   NULL);
SELECT fn_valor_catalogo('tpc_documentotipo', 'Secuencial',         'Secuencial',             'Identificador provisional cuando la persona no cuenta con documento.');

-- ─── Cargo de la autoridad (extensión) ────────────────────────────────
SELECT fn_valor_catalogo('tpc_cargotipo', 'Gobernador',             'Gobernador o Gobernadora',                    NULL, true, NULL);
SELECT fn_valor_catalogo('tpc_cargotipo', 'Capitan',                'Capitán',                                     NULL, true, NULL);
SELECT fn_valor_catalogo('tpc_cargotipo', 'Cacique',                'Cacique',                                     NULL, true, NULL);
SELECT fn_valor_catalogo('tpc_cargotipo', 'Autoridad_Tradicional',  'Autoridad tradicional',                       NULL, true, NULL);
SELECT fn_valor_catalogo('tpc_cargotipo', 'Representante_Legal_CC', 'Representante legal del consejo comunitario', NULL, true, NULL);
SELECT fn_valor_catalogo('tpc_cargotipo', 'Otro',                   'Otro cargo',                                  NULL, true, NULL);

-- ─── Organización filial (extensión) ──────────────────────────────────
SELECT fn_valor_catalogo('tpc_organizacionfilialtipo', 'Cabildo',                   'Cabildo',                    NULL, true, NULL);
SELECT fn_valor_catalogo('tpc_organizacionfilialtipo', 'Autoridades_Tradicionales', 'Autoridades tradicionales',  NULL, true, NULL);
SELECT fn_valor_catalogo('tpc_organizacionfilialtipo', 'Asamblea_Comunitaria',      'Asamblea comunitaria',       NULL, true, NULL);
SELECT fn_valor_catalogo('tpc_organizacionfilialtipo', 'Consejo_Comunitario',       'Consejo comunitario',        NULL, true, NULL);
SELECT fn_valor_catalogo('tpc_organizacionfilialtipo', 'Otro',                      'Otro tipo de organización',  NULL, true, NULL);

-- ─── COL_DerechoTipo ──────────────────────────────────────────────────
SELECT fn_valor_catalogo('col_derechotipo', 'Propiedad_Colectiva', 'Propiedad colectiva reconocida',   NULL);
SELECT fn_valor_catalogo('col_derechotipo', 'Posesion_Ancestral',  'Posesión ancestral sin título',    'Ocupación histórica sin acto administrativo que la formalice.');
SELECT fn_valor_catalogo('col_derechotipo', 'Uso_Usufructo',       'Uso y usufructo',                  NULL);
SELECT fn_valor_catalogo('col_derechotipo', 'En_Proceso',          'En proceso de legalización',       NULL, true, NULL);
SELECT fn_valor_catalogo('col_derechotipo', 'Desconocido',         'Desconocido',                      'Valor propio: la comunidad no sabe bajo qué figura ocupa el territorio.', true, NULL);

-- ─── COL_RestriccionTipo ──────────────────────────────────────────────
-- El modelo distingue catorce restricciones. La conversación por WhatsApp
-- ofrecía seis opciones que agrupaban varias de ellas; esos valores
-- agrupados se conservan como extensión (con su equivalencia anotada) para
-- no perder ni reinterpretar los registros ya hechos.
SELECT fn_valor_catalogo('col_restricciontipo', 'Servidumbre',        'Servidumbre',                       NULL);
SELECT fn_valor_catalogo('col_restricciontipo', 'Transito',           'Servidumbre de tránsito',           NULL);
SELECT fn_valor_catalogo('col_restricciontipo', 'Aguas_Negras',       'Servidumbre de aguas negras',       NULL);
SELECT fn_valor_catalogo('col_restricciontipo', 'Aire',               'Servidumbre de aire',               NULL);
SELECT fn_valor_catalogo('col_restricciontipo', 'Luz',                'Servidumbre de luz',                NULL);
SELECT fn_valor_catalogo('col_restricciontipo', 'Agua',               'Servidumbre de agua',               NULL);
SELECT fn_valor_catalogo('col_restricciontipo', 'Medianera',          'Medianera',                         NULL);
SELECT fn_valor_catalogo('col_restricciontipo', 'Oleoducto',          'Oleoducto',                         NULL);
SELECT fn_valor_catalogo('col_restricciontipo', 'Gasoducto',          'Gasoducto',                         NULL);
SELECT fn_valor_catalogo('col_restricciontipo', 'Acueducto',          'Acueducto',                         NULL);
SELECT fn_valor_catalogo('col_restricciontipo', 'Alcantarillado',     'Alcantarillado',                    NULL);
SELECT fn_valor_catalogo('col_restricciontipo', 'Minera',             'Actividad minera',                  NULL);
SELECT fn_valor_catalogo('col_restricciontipo', 'Energia_Electrica',  'Línea de energía eléctrica',        NULL);
SELECT fn_valor_catalogo('col_restricciontipo', 'Legal_Hidrocarburos','Restricción legal por hidrocarburos', NULL);
SELECT fn_valor_catalogo('col_restricciontipo', 'Oleoducto_Gasoducto','Oleoducto o gasoducto (agrupado)',
    'Opción agrupada de la captura por WhatsApp: la persona no siempre distingue el tipo de ducto que cruza el territorio.', true, 'Oleoducto | Gasoducto');
SELECT fn_valor_catalogo('col_restricciontipo', 'Acueducto_Alcantarillado', 'Acueducto o alcantarillado (agrupado)',
    'Opción agrupada de la captura por WhatsApp.', true, 'Acueducto | Alcantarillado');
SELECT fn_valor_catalogo('col_restricciontipo', 'Ninguna',            'No hay restricciones',
    'Valor propio: el estándar expresa la ausencia de restricción no creando la instancia.', true, NULL);

-- ─── COL_FuenteAdministrativaTipo ─────────────────────────────────────
SELECT fn_valor_catalogo('col_fuenteadministrativatipo', 'Acto_Administrativo', 'Acto administrativo',   'Resolución, acuerdo o decreto de la autoridad de tierras.');
SELECT fn_valor_catalogo('col_fuenteadministrativatipo', 'Escritura_Publica',   'Escritura pública',     NULL);
SELECT fn_valor_catalogo('col_fuenteadministrativatipo', 'Sentencia_Judicial',  'Sentencia judicial',    NULL);
SELECT fn_valor_catalogo('col_fuenteadministrativatipo', 'Documento_Publico',   'Documento público',     NULL);
SELECT fn_valor_catalogo('col_fuenteadministrativatipo', 'Documento_Privado',   'Documento privado',     NULL);
SELECT fn_valor_catalogo('col_fuenteadministrativatipo', 'Sin_Documento',       'Sin documento',         'La comunidad declara no contar con soporte documental.', true, NULL);

-- ─── COL_FuenteEspacialTipo ───────────────────────────────────────────
SELECT fn_valor_catalogo('col_fuenteespacialtipo', 'Croquis_Campo',       'Croquis de campo',
    'Dibujo del lindero hecho por la propia comunidad. Es exactamente lo que produce el croquis del chatbot.');
SELECT fn_valor_catalogo('col_fuenteespacialtipo', 'Datos_Crudos',        'Datos crudos de levantamiento',
    'Traza sin procesar de un instrumento de medición; aquí, los puntos del recorrido GPS.');
SELECT fn_valor_catalogo('col_fuenteespacialtipo', 'Ortofoto',            'Ortofoto',            NULL);
SELECT fn_valor_catalogo('col_fuenteespacialtipo', 'Informe_Tecnico',     'Informe técnico',     NULL);
SELECT fn_valor_catalogo('col_fuenteespacialtipo', 'Registro_Fotografico','Registro fotográfico',NULL);
SELECT fn_valor_catalogo('col_fuenteespacialtipo', 'Plano_Oficial',       'Plano oficial (IGAC u otra entidad)',
    'Valor propio: el plano levantado por la autoridad catastral no tiene equivalente exacto entre los cinco del estándar.', true, 'Informe_Tecnico');
SELECT fn_valor_catalogo('col_fuenteespacialtipo', 'Sin_Mapa',            'No existe cartografía',
    'Valor propio: expresa la ausencia de fuente espacial, que el estándar representaría no creando la instancia.', true, NULL);

-- ─── COL_MetodoProduccionTipo ─────────────────────────────────────────
SELECT fn_valor_catalogo('col_metodoproducciontipo', 'Metodo_Directo', 'Método directo',
    'Medición en terreno sobre el objeto mismo. Corresponde al recorrido GPS caminando el lindero.');
SELECT fn_valor_catalogo('col_metodoproducciontipo', 'Metodo_Declarativo_y_Colaborativo', 'Método declarativo y colaborativo',
    'La posición la declara la comunidad sobre una imagen o mapa. Corresponde al croquis dibujado.');
SELECT fn_valor_catalogo('col_metodoproducciontipo', 'Metodo_Indirecto', 'Método indirecto',
    'Posición derivada de otra fuente cartográfica ya existente.');
SELECT fn_valor_catalogo('col_metodoproducciontipo', 'Sin_Metodo', 'Sin captura',
    'Valor propio: el declarante omitió el paso de captura del perímetro.', true, NULL);

-- ─── COL_InterpolacionTipo / COL_PuntoTipo / COL_EstructuraTipo ───────
SELECT fn_valor_catalogo('col_interpolaciontipo', 'Ninguna',  'Ninguna',                   'El tramo no se interpola: solo existen los puntos.');
SELECT fn_valor_catalogo('col_interpolaciontipo', 'Recta',    'Línea recta',               'Los dos puntos se unen por el segmento más corto.');
SELECT fn_valor_catalogo('col_interpolaciontipo', 'Curva',    'Curva',                     'El lindero sigue un rasgo curvo, típicamente un río.');
SELECT fn_valor_catalogo('col_interpolaciontipo', 'Circular', 'Arco circular',             NULL);

SELECT fn_valor_catalogo('col_puntotipo', 'Limite',       'Punto de lindero',       'Vértice que define el límite del territorio.');
SELECT fn_valor_catalogo('col_puntotipo', 'Levantamiento','Punto de levantamiento', NULL);
SELECT fn_valor_catalogo('col_puntotipo', 'Control',      'Punto de control',       NULL);

SELECT fn_valor_catalogo('col_estructuratipo', 'No_Poligono','Sin polígono',        'Solo se conoce el punto de ubicación del territorio.');
SELECT fn_valor_catalogo('col_estructuratipo', 'Poligono',   'Polígono',            'Geometría cerrada sin topología compartida.');
SELECT fn_valor_catalogo('col_estructuratipo', 'Topologia',  'Topología',           'Geometría construida a partir de puntos y cadenas de lindero.');
SELECT fn_valor_catalogo('col_estructuratipo', 'Malla',      'Malla',               NULL);

-- ─── Catálogos de las extensiones propias ─────────────────────────────
SELECT fn_valor_catalogo('ext_antiguedadtipo', 'Desde_Siempre',           'Desde siempre — territorio ancestral', NULL, true, NULL);
SELECT fn_valor_catalogo('ext_antiguedadtipo', 'Desde_Hace_Muchos_Anos',  'Desde hace muchos años',               NULL, true, NULL);
SELECT fn_valor_catalogo('ext_antiguedadtipo', 'Desde_Fecha_Aproximada',  'Desde una fecha aproximada',           NULL, true, NULL);
SELECT fn_valor_catalogo('ext_antiguedadtipo', 'Desconocida',             'No se conoce la fecha',                NULL, true, NULL);

SELECT fn_valor_catalogo('ext_usotipo', 'Uso_Colectivo',     'Uso colectivo comunitario',              NULL, true, NULL);
SELECT fn_valor_catalogo('ext_usotipo', 'Uso_Tradicional',   'Uso tradicional y cultural',             NULL, true, NULL);
SELECT fn_valor_catalogo('ext_usotipo', 'Zonas_Compartidas', 'Zonas compartidas con otras comunidades',NULL, true, NULL);
SELECT fn_valor_catalogo('ext_usotipo', 'Uso_Mixto',         'Uso mixto (colectivo y familiar)',       NULL, true, NULL);

SELECT fn_valor_catalogo('ext_validaciontipo', 'Validada_Asamblea',    'Validada en asamblea comunitaria', NULL, true, NULL);
SELECT fn_valor_catalogo('ext_validaciontipo', 'Revisada_Autoridades', 'Revisada por las autoridades',     NULL, true, NULL);
SELECT fn_valor_catalogo('ext_validaciontipo', 'Pendiente',            'Aún no validada',                  NULL, true, NULL);

SELECT fn_valor_catalogo('ext_limitestipo', 'Rios',                 'Ríos y quebradas',                 NULL, true, NULL);
SELECT fn_valor_catalogo('ext_limitestipo', 'Montanas',             'Montañas y cerros',                NULL, true, NULL);
SELECT fn_valor_catalogo('ext_limitestipo', 'Caminos',              'Caminos y senderos',               NULL, true, NULL);
SELECT fn_valor_catalogo('ext_limitestipo', 'Hitos_Naturales',      'Hitos naturales',                  NULL, true, NULL);
SELECT fn_valor_catalogo('ext_limitestipo', 'Documentos_Oficiales', 'Documentos oficiales',             NULL, true, NULL);
SELECT fn_valor_catalogo('ext_limitestipo', 'Combinacion',          'Combinación de los anteriores',    NULL, true, NULL);

SELECT fn_valor_catalogo('ext_reconocimientotipo', 'Sí',         'Reconocido por el Estado', NULL, true, NULL);
SELECT fn_valor_catalogo('ext_reconocimientotipo', 'No',         'No reconocido',            NULL, true, NULL);
SELECT fn_valor_catalogo('ext_reconocimientotipo', 'No_Sabemos', 'No se sabe',               NULL, true, NULL);

SELECT fn_valor_catalogo('ext_fotocategoria', 'documento_legal',    'Documento legal',                NULL, true, NULL);
SELECT fn_valor_catalogo('ext_fotocategoria', 'plano_mapa',         'Plano o mapa',                   NULL, true, NULL);
SELECT fn_valor_catalogo('ext_fotocategoria', 'limites_territorio', 'Lindero del territorio',         NULL, true, NULL);
SELECT fn_valor_catalogo('ext_fotocategoria', 'zonas_especiales',   'Zona especial o sagrada',        NULL, true, NULL);
SELECT fn_valor_catalogo('ext_fotocategoria', 'restriccion',        'Restricción sobre el territorio',NULL, true, NULL);
SELECT fn_valor_catalogo('ext_fotocategoria', 'territorio',         'Vista del territorio',           NULL, true, NULL);
SELECT fn_valor_catalogo('ext_fotocategoria', 'comunidad_reunida',  'Comunidad reunida',              NULL, true, NULL);
SELECT fn_valor_catalogo('ext_fotocategoria', 'sin_categoria',      'Sin categoría',                  NULL, true, NULL);

COMMIT;


-- ======================================================================
--  2. ALINEACIÓN DEL VOCABULARIO
--
--  Los datos ya guardados se traducen a los nombres del estándar. Son
--  renombramientos uno a uno, sin pérdida ni reinterpretación: el croquis
--  siempre fue un método declarativo y el recorrido GPS siempre fue
--  medición directa, solo se llamaban de otra manera.
-- ======================================================================

BEGIN;

-- La restricción CHECK de migrate_perimetro.sql solo admitía los nombres
-- viejos; hay que retirarla antes de traducir, y no se vuelve a poner
-- porque ahora el catálogo cumple esa función.
DO $$
DECLARE r RECORD;
BEGIN
    FOR r IN
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'tpc_predio'::regclass
          AND contype  = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%croquis_manual%'
    LOOP
        EXECUTE format('ALTER TABLE tpc_predio DROP CONSTRAINT %I', r.conname);
    END LOOP;
END $$;

-- Los nombres del estándar son más largos que los que se usaban antes:
-- 'Metodo_Declarativo_y_Colaborativo' tiene 33 caracteres y la columna
-- estaba declarada de 30.
--
-- PostgreSQL no deja ampliar una columna de la que dependa una vista. Si
-- alguien agregó metodo_captura_perimetro a vista_registros_completos —
-- cosa que migrate_perimetro.sql sugiere hacer — el ALTER falla y la
-- migración quedaría a medias. Mejor detenerse aquí con un mensaje que
-- diga qué hacer, que abortar sin explicación.
DO $$
DECLARE v_vistas TEXT;
BEGIN
    SELECT string_agg(DISTINCT dep.relname, ', ')
      INTO v_vistas
      FROM pg_depend d
      JOIN pg_rewrite rw  ON rw.oid = d.objid
      JOIN pg_class   dep ON dep.oid = rw.ev_class
     WHERE d.refobjid = 'tpc_predio'::regclass
       AND d.refobjsubid = (SELECT attnum FROM pg_attribute
                            WHERE attrelid = 'tpc_predio'::regclass
                              AND attname  = 'metodo_captura_perimetro')
       AND dep.relkind = 'v';

    IF v_vistas IS NOT NULL THEN
        RAISE EXCEPTION
            'La columna metodo_captura_perimetro la usan estas vistas: %. Bórralas con DROP VIEW, vuelve a correr esta migración y créalas de nuevo después.',
            v_vistas;
    END IF;
END $$;

-- Un disparador que vigile esta columna también bloquea el ALTER. En la
-- segunda corrida de esta migración el de topología ya existe, así que se
-- retira aquí y la sección 5 lo vuelve a crear.
DROP TRIGGER IF EXISTS trig_topologia_lindero ON tpc_predio;

ALTER TABLE tpc_predio ALTER COLUMN metodo_captura_perimetro TYPE VARCHAR(120);

UPDATE tpc_predio SET metodo_captura_perimetro = 'Metodo_Declarativo_y_Colaborativo' WHERE metodo_captura_perimetro = 'croquis_manual';
UPDATE tpc_predio SET metodo_captura_perimetro = 'Metodo_Directo'                    WHERE metodo_captura_perimetro = 'recorrido_gps';
UPDATE tpc_predio SET metodo_captura_perimetro = 'Sin_Metodo'                        WHERE metodo_captura_perimetro = 'no_capturado';

-- El mapa dibujado por la comunidad es, en el vocabulario del estándar,
-- un croquis de campo.
UPDATE tpc_fuente_espacial SET tipo_fuente_espacial = 'Croquis_Campo' WHERE tipo_fuente_espacial = 'Mapa_Comunitario';

-- tpc_captura_perimetro_pendiente conserva a propósito los nombres
-- 'croquis_manual' / 'recorrido_gps': es una cola técnica entre el
-- navegador y el bot, no una clase del modelo, y las páginas web envían
-- esos valores. La traducción ocurre al pasar el dato a tpc_predio.

COMMIT;


-- ======================================================================
--  3. ATRIBUTOS DE <<ObjetoVersionado>>
--
--  En LADM toda instancia del núcleo lleva identificación (espacio de
--  nombres + identificador local) y vigencia (inicio y fin de la versión).
--  Es lo que permite conservar el histórico en vez de sobrescribirlo: una
--  corrección cierra la versión anterior y abre una nueva.
-- ======================================================================

BEGIN;

DO $$
DECLARE
    t TEXT;
    tablas TEXT[] := ARRAY[
        'tpc_interesado_comunidad', 'tpc_representante_legal',
        'tpc_territorio_propiedad_colectiva', 'tpc_predio',
        'tpc_derecho', 'tpc_restriccion',
        'tpc_fuente_administrativa', 'tpc_fuente_espacial'
    ];
BEGIN
    FOREACH t IN ARRAY tablas LOOP
        EXECUTE format($f$
            ALTER TABLE %I
                ADD COLUMN IF NOT EXISTS espacio_de_nombres         VARCHAR(255) DEFAULT 'CATASTRO_ETNICO',
                ADD COLUMN IF NOT EXISTS local_id                   VARCHAR(255),
                ADD COLUMN IF NOT EXISTS comienzo_vida_util_version TIMESTAMP    DEFAULT NOW(),
                ADD COLUMN IF NOT EXISTS fin_vida_util_version      TIMESTAMP
        $f$, t);

        -- Identificador local para las filas que ya existían
        EXECUTE format(
            'UPDATE %I SET local_id = %L || id::TEXT WHERE local_id IS NULL',
            t, upper(t) || '_'
        );
    END LOOP;
END $$;

-- Rellena identificación y vigencia en cada fila nueva, sin que el
-- chatbot tenga que ocuparse de ello.
CREATE OR REPLACE FUNCTION fn_objeto_versionado()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.espacio_de_nombres IS NULL THEN
        NEW.espacio_de_nombres := 'CATASTRO_ETNICO';
    END IF;
    IF NEW.comienzo_vida_util_version IS NULL THEN
        NEW.comienzo_vida_util_version := NOW();
    END IF;
    IF NEW.local_id IS NULL THEN
        NEW.local_id := upper(TG_TABLE_NAME) || '_' || NEW.id::TEXT;
    END IF;
    RETURN NEW;
END $$;

COMMENT ON FUNCTION fn_objeto_versionado IS
    'Completa los atributos de <<ObjetoVersionado>> (espacio de nombres, identificador local y comienzo de vigencia) en cada inserción.';

DO $$
DECLARE
    t TEXT;
    tablas TEXT[] := ARRAY[
        'tpc_interesado_comunidad', 'tpc_representante_legal',
        'tpc_territorio_propiedad_colectiva', 'tpc_predio',
        'tpc_derecho', 'tpc_restriccion',
        'tpc_fuente_administrativa', 'tpc_fuente_espacial'
    ];
BEGIN
    FOREACH t IN ARRAY tablas LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS trig_versionado ON %I', t);
        -- AFTER no sirve: local_id se arma con el id, que solo existe una
        -- vez asignado el SERIAL, y eso ya ocurrió en BEFORE INSERT.
        EXECUTE format(
            'CREATE TRIGGER trig_versionado BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION fn_objeto_versionado()',
            t
        );
    END LOOP;
END $$;

COMMIT;


-- ======================================================================
--  4. ATRIBUTOS QUE FALTABAN EN LAS CLASES EXISTENTES
-- ======================================================================

BEGIN;

-- ─── TPC_Predio: identificación registral ─────────────────────────────
-- Son los campos que conectan este registro con la Superintendencia de
-- Notariado y Registro y con el catastro oficial. Quedan disponibles
-- aunque la captura comunitaria no siempre pueda llenarlos.
ALTER TABLE tpc_predio
    ADD COLUMN IF NOT EXISTS matricula_inmobiliaria    VARCHAR(50),
    ADD COLUMN IF NOT EXISTS codigo_orip               VARCHAR(10),
    ADD COLUMN IF NOT EXISTS nupre                     VARCHAR(30),
    ADD COLUMN IF NOT EXISTS numero_predial_anterior   VARCHAR(30),
    ADD COLUMN IF NOT EXISTS codigo_homologado         VARCHAR(50),
    ADD COLUMN IF NOT EXISTS codigo_homologado_fmi     VARCHAR(50),
    ADD COLUMN IF NOT EXISTS interrelacionado          BOOLEAN,
    ADD COLUMN IF NOT EXISTS area_reconstruccion       NUMERIC(16,4),
    ADD COLUMN IF NOT EXISTS responsable_reconstruccion VARCHAR(200),
    ADD COLUMN IF NOT EXISTS codigo_reconstruccion     VARCHAR(50),
    ADD COLUMN IF NOT EXISTS rango_tolerancia          NUMERIC(10,4),
    ADD COLUMN IF NOT EXISTS estructura_geometrica     VARCHAR(60);

COMMENT ON COLUMN tpc_predio.nupre IS
    'Número Único Predial. En el estándar es el identificador que amarra el predio con el registro.';
COMMENT ON COLUMN tpc_predio.estructura_geometrica IS
    'COL_EstructuraTipo: cómo está representada la unidad espacial (solo punto, polígono, o topología de puntos y cadenas).';

-- La estructura se deduce de lo que realmente se capturó.
UPDATE tpc_predio
SET estructura_geometrica = CASE
        WHEN geom_perimetro IS NOT NULL THEN 'Topologia'
        WHEN geom           IS NOT NULL THEN 'No_Poligono'
        ELSE NULL
    END
WHERE estructura_geometrica IS NULL;

-- ─── TPC_RepresentanteLegal: nombre descompuesto y contacto ───────────
ALTER TABLE tpc_representante_legal
    ADD COLUMN IF NOT EXISTS primer_nombre    VARCHAR(100),
    ADD COLUMN IF NOT EXISTS segundo_nombre   VARCHAR(100),
    ADD COLUMN IF NOT EXISTS primer_apellido  VARCHAR(100),
    ADD COLUMN IF NOT EXISTS segundo_apellido VARCHAR(100),
    ADD COLUMN IF NOT EXISTS tipo_documento   VARCHAR(60);

COMMENT ON COLUMN tpc_representante_legal.primer_nombre IS
    'El modelo pide el nombre en cuatro campos separados para poder cruzarlo contra registros civiles. nombres_autoridades se conserva como el texto tal cual lo dictó la persona.';

-- Reparte un nombre completo en los cuatro campos siguiendo la
-- convención colombiana: los dos últimos tokens son los apellidos.
-- Con tres palabras se asume nombre + dos apellidos, que es lo más
-- frecuente. No es infalible, por eso nombres_autoridades sigue ahí.
CREATE OR REPLACE FUNCTION fn_descomponer_nombre(p_completo TEXT)
RETURNS TABLE (primer_nombre TEXT, segundo_nombre TEXT, primer_apellido TEXT, segundo_apellido TEXT)
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    p TEXT[];
    n INTEGER;
BEGIN
    IF p_completo IS NULL OR btrim(p_completo) = '' THEN
        RETURN QUERY SELECT NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT;
        RETURN;
    END IF;

    p := regexp_split_to_array(btrim(regexp_replace(p_completo, '\s+', ' ', 'g')), ' ');
    n := array_length(p, 1);

    IF    n = 1 THEN RETURN QUERY SELECT p[1], NULL::TEXT, NULL::TEXT, NULL::TEXT;
    ELSIF n = 2 THEN RETURN QUERY SELECT p[1], NULL::TEXT, p[2],       NULL::TEXT;
    ELSIF n = 3 THEN RETURN QUERY SELECT p[1], NULL::TEXT, p[2],       p[3];
    ELSE             RETURN QUERY SELECT p[1], array_to_string(p[2:n-2], ' '), p[n-1], p[n];
    END IF;
END $$;

COMMENT ON FUNCTION fn_descomponer_nombre IS
    'Separa un nombre completo en los cuatro campos que pide LADM, con la convención colombiana de dos apellidos al final.';

UPDATE tpc_representante_legal r
SET primer_nombre    = x.primer_nombre,
    segundo_nombre   = x.segundo_nombre,
    primer_apellido  = x.primer_apellido,
    segundo_apellido = x.segundo_apellido
FROM (
    SELECT t.id, d.*
    FROM tpc_representante_legal t
    CROSS JOIN LATERAL fn_descomponer_nombre(t.nombres_autoridades) d
) x
WHERE x.id = r.id
  AND r.nombres_autoridades IS NOT NULL
  AND r.primer_nombre IS NULL;

-- ─── TPC_FuenteAdministrativa: fecha como fecha ───────────────────────
ALTER TABLE tpc_fuente_administrativa
    ADD COLUMN IF NOT EXISTS fecha_documento DATE,
    ADD COLUMN IF NOT EXISTS ente_emisor     VARCHAR(200);

COMMENT ON COLUMN tpc_fuente_administrativa.fecha_documento IS
    'Fecha real del acto administrativo. fecha_acto_administrativo se conserva como el texto que dictó la persona, que a veces es "no recuerdo".';

-- Convierte a fecha lo que se pueda de los textos ya guardados; lo que no
-- tenga forma de fecha simplemente queda nulo.
CREATE OR REPLACE FUNCTION fn_texto_a_fecha(p_texto TEXT)
RETURNS DATE LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE d DATE;
BEGIN
    IF p_texto IS NULL OR btrim(p_texto) = '' THEN RETURN NULL; END IF;
    BEGIN
        IF p_texto ~ '^\s*\d{1,2}[/-]\d{1,2}[/-]\d{4}\s*$' THEN
            d := to_date(regexp_replace(btrim(p_texto), '-', '/', 'g'), 'DD/MM/YYYY');
        ELSIF p_texto ~ '^\s*\d{4}-\d{2}-\d{2}\s*$' THEN
            d := btrim(p_texto)::DATE;
        ELSIF p_texto ~ '^\s*\d{4}\s*$' THEN
            d := to_date(btrim(p_texto) || '-01-01', 'YYYY-MM-DD');
        ELSE
            d := NULL;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        d := NULL;
    END;
    RETURN d;
END $$;

-- Solo en la fuente administrativa: allí fecha_documento es la fecha del
-- acto. En tpc_representante_legal ese campo significaría la fecha del
-- documento de identidad, que es otra cosa, así que no se rellena.
UPDATE tpc_fuente_administrativa
SET fecha_documento = fn_texto_a_fecha(fecha_acto_administrativo)
WHERE fecha_documento IS NULL;

-- ─── TPC_FuenteEspacial: método de producción ─────────────────────────
ALTER TABLE tpc_fuente_espacial
    ADD COLUMN IF NOT EXISTS metodo_produccion VARCHAR(120),
    ADD COLUMN IF NOT EXISTS fecha_documento   DATE;

COMMIT;


-- ======================================================================
--  5. TOPOLOGÍA DEL LINDERO
--
--  Era la brecha más grande frente al modelo: se guardaba el polígono
--  completo, pero no los vértices ni los tramos como objetos propios. Sin
--  ellos no se puede decir que *este* vértice se midió con GPS y *aquel*
--  se declaró sobre el croquis, ni registrar la precisión punto por punto.
-- ======================================================================

BEGIN;

-- ─── COL_Punto ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS col_punto (
    t_id                       SERIAL       PRIMARY KEY,
    predio_id                  INTEGER      REFERENCES tpc_predio(id) ON DELETE CASCADE,
    anillo                     INTEGER      DEFAULT 0,
    orden                      INTEGER,
    tipo_punto                 VARCHAR(60)  DEFAULT 'Limite',
    metodo_produccion          VARCHAR(120),
    interpolacion              VARCHAR(60),
    exactitud_horizontal       NUMERIC(10,3),
    exactitud_vertical         NUMERIC(10,3),
    posicion                   GEOMETRY(POINT, 4326) NOT NULL,
    fuente_espacial_id         INTEGER      REFERENCES tpc_fuente_espacial(id) ON DELETE SET NULL,
    espacio_de_nombres         VARCHAR(255) DEFAULT 'CATASTRO_ETNICO',
    local_id                   VARCHAR(255),
    comienzo_vida_util_version TIMESTAMP    DEFAULT NOW(),
    fin_vida_util_version      TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_col_punto_predio   ON col_punto (predio_id);
CREATE INDEX IF NOT EXISTS idx_col_punto_posicion ON col_punto USING GIST (posicion);

COMMENT ON TABLE  col_punto IS 'COL_Punto — vértice del lindero, con su método de producción y su exactitud.';
COMMENT ON COLUMN col_punto.exactitud_horizontal IS 'Precisión horizontal en metros. En el recorrido GPS viene del propio receptor; en el croquis dibujado no aplica.';
COMMENT ON COLUMN col_punto.orden  IS 'Posición del vértice dentro de su anillo, empezando en 1.';
COMMENT ON COLUMN col_punto.anillo IS '0 = lindero exterior; 1, 2, ... = huecos interiores (enclaves dentro del territorio).';

-- ─── COL_CadenaDeLimite ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS col_cadenadelimite (
    t_id                       SERIAL       PRIMARY KEY,
    predio_id                  INTEGER      REFERENCES tpc_predio(id) ON DELETE CASCADE,
    anillo                     INTEGER      DEFAULT 0,
    orden                      INTEGER,
    geometria                  GEOMETRY(LINESTRING, 4326) NOT NULL,
    punto_inicial              INTEGER      REFERENCES col_punto(t_id) ON DELETE SET NULL,
    punto_final                INTEGER      REFERENCES col_punto(t_id) ON DELETE SET NULL,
    metodo_produccion          VARCHAR(120),
    interpolacion              VARCHAR(60)  DEFAULT 'Recta',
    longitud_m                 NUMERIC(14,3),
    descripcion_lindero        TEXT,
    espacio_de_nombres         VARCHAR(255) DEFAULT 'CATASTRO_ETNICO',
    local_id                   VARCHAR(255),
    comienzo_vida_util_version TIMESTAMP    DEFAULT NOW(),
    fin_vida_util_version      TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_col_cadena_predio ON col_cadenadelimite (predio_id);
CREATE INDEX IF NOT EXISTS idx_col_cadena_geom   ON col_cadenadelimite USING GIST (geometria);

COMMENT ON TABLE  col_cadenadelimite IS 'COL_CadenaDeLimite — tramo de lindero entre dos vértices consecutivos.';
COMMENT ON COLUMN col_cadenadelimite.descripcion_lindero IS 'Qué hay en ese tramo según la comunidad: un río, un camino, una cerca. Se puede llenar tramo por tramo más adelante.';

-- ─── COL_CarasLindero ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS col_caraslindero (
    t_id                       SERIAL       PRIMARY KEY,
    predio_id                  INTEGER      REFERENCES tpc_predio(id) ON DELETE CASCADE,
    geometria                  GEOMETRY(POLYGON, 4326) NOT NULL,
    metodo_produccion          VARCHAR(120),
    area_m2                    NUMERIC(18,3),
    perimetro_m                NUMERIC(18,3),
    espacio_de_nombres         VARCHAR(255) DEFAULT 'CATASTRO_ETNICO',
    local_id                   VARCHAR(255),
    comienzo_vida_util_version TIMESTAMP    DEFAULT NOW(),
    fin_vida_util_version      TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_col_caras_predio ON col_caraslindero (predio_id);
CREATE INDEX IF NOT EXISTS idx_col_caras_geom   ON col_caraslindero USING GIST (geometria);

COMMENT ON TABLE col_caraslindero IS 'COL_CarasLindero — superficie delimitada por el conjunto de cadenas de lindero.';

-- ─── Generación automática de la topología ────────────────────────────
--
-- Descompone el polígono capturado en sus tres objetos LADM. Se ejecuta
-- sola cada vez que se guarda o corrige un perímetro, así que ni el
-- chatbot ni las páginas de captura tienen que saber que esto existe.
CREATE OR REPLACE FUNCTION fn_generar_topologia_lindero(p_predio_id INTEGER)
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
    v_geom       GEOMETRY;
    v_metodo     TEXT;
    v_gps        JSONB;
    v_anillo     GEOMETRY;
    v_vertice    GEOMETRY;
    v_segmento   GEOMETRY;
    v_n          INTEGER;
    v_i          INTEGER;
    v_a          INTEGER;
    v_n_int      INTEGER;
    v_ids        INTEGER[];
    v_id         INTEGER;
    v_exactitud  NUMERIC;
    v_total      INTEGER := 0;
BEGIN
    SELECT geom_perimetro, metodo_captura_perimetro, puntos_recorrido_gps
      INTO v_geom, v_metodo, v_gps
      FROM tpc_predio WHERE id = p_predio_id;

    -- Se rehace desde cero: si el polígono cambió, los vértices viejos ya
    -- no describen nada. Ojo — esto también borra lo que se haya escrito a
    -- mano en descripcion_lindero o en la exactitud de un punto, así que
    -- solo debe correrse cuando la geometría de verdad cambió.
    DELETE FROM col_caraslindero   WHERE predio_id = p_predio_id;
    DELETE FROM col_cadenadelimite WHERE predio_id = p_predio_id;
    DELETE FROM col_punto          WHERE predio_id = p_predio_id;

    -- Un polígono vacío o inexistente no tiene lindero que describir; se
    -- sale sin crear ni siquiera la cara, para no dejar una superficie sin
    -- vértices ni tramos.
    IF v_geom IS NULL OR ST_IsEmpty(v_geom) OR GeometryType(v_geom) <> 'POLYGON' THEN
        RETURN 0;
    END IF;

    IF v_metodo IS NULL OR v_metodo NOT IN ('Metodo_Directo', 'Metodo_Declarativo_y_Colaborativo', 'Metodo_Indirecto') THEN
        v_metodo := 'Metodo_Declarativo_y_Colaborativo';
    END IF;

    -- Si el perímetro se caminó con GPS, la traza cruda trae la precisión
    -- que reportó el receptor en cada lectura. La exactitud de cada
    -- vértice se toma de la lectura más cercana a él: es un dato medido,
    -- no una estimación. El croquis dibujado sobre el mapa no tiene
    -- exactitud que declarar, y ponerle un número sería inventarlo.
    IF v_gps IS NULL OR jsonb_typeof(v_gps) <> 'array' THEN
        v_gps := NULL;
    END IF;

    -- Anillo 0 = lindero exterior. Los siguientes son huecos: enclaves
    -- que quedan por dentro del territorio pero fuera de él (un predio
    -- privado, una laguna excluida del título). También son lindero, y sin
    -- ellos las cadenas no cerrarían la superficie que guarda la cara.
    v_n_int := ST_NumInteriorRings(v_geom);

    FOR v_a IN 0..v_n_int LOOP
        v_anillo := CASE WHEN v_a = 0 THEN ST_ExteriorRing(v_geom)
                         ELSE ST_InteriorRingN(v_geom, v_a) END;
        v_n      := ST_NPoints(v_anillo);
        v_ids    := '{}';

        CONTINUE WHEN v_n < 4;   -- un anillo válido cierra con 4 puntos como mínimo

        -- El último punto del anillo repite el primero para cerrarlo; como
        -- vértice es el mismo, así que no se guarda dos veces.
        FOR v_i IN 1..(v_n - 1) LOOP
            v_vertice   := ST_PointN(v_anillo, v_i);
            v_exactitud := NULL;

            IF v_gps IS NOT NULL THEN
                SELECT (e->>'acc')::NUMERIC
                  INTO v_exactitud
                  FROM jsonb_array_elements(v_gps) e
                 WHERE e ? 'acc' AND e ? 'lat' AND e ? 'lng'
                 ORDER BY ST_Distance(
                            ST_SetSRID(ST_MakePoint((e->>'lng')::FLOAT8, (e->>'lat')::FLOAT8), 4326)::geography,
                            v_vertice::geography)
                 LIMIT 1;
            END IF;

            INSERT INTO col_punto (
                predio_id, anillo, orden, tipo_punto, metodo_produccion,
                interpolacion, exactitud_horizontal, posicion, local_id
            ) VALUES (
                p_predio_id, v_a, v_i, 'Limite', v_metodo,
                'Recta', v_exactitud, v_vertice,
                'PUNTO_' || p_predio_id || '_' || v_a || '_' || v_i
            )
            RETURNING t_id INTO v_id;

            v_ids := array_append(v_ids, v_id);
        END LOOP;

        -- Un tramo por cada par de vértices consecutivos, cerrando el
        -- anillo con el tramo que va del último al primero.
        FOR v_i IN 1..(v_n - 1) LOOP
            v_segmento := ST_SetSRID(
                ST_MakeLine(ST_PointN(v_anillo, v_i), ST_PointN(v_anillo, v_i + 1)), 4326);

            INSERT INTO col_cadenadelimite (
                predio_id, anillo, orden, geometria, punto_inicial, punto_final,
                metodo_produccion, interpolacion, longitud_m, local_id
            ) VALUES (
                p_predio_id, v_a, v_i, v_segmento,
                v_ids[v_i],
                v_ids[CASE WHEN v_i = v_n - 1 THEN 1 ELSE v_i + 1 END],
                v_metodo, 'Recta',
                ST_Length(v_segmento::geography),
                'CADENA_' || p_predio_id || '_' || v_a || '_' || v_i
            );
        END LOOP;

        v_total := v_total + (v_n - 1);
    END LOOP;

    IF v_total = 0 THEN
        RETURN 0;
    END IF;

    INSERT INTO col_caraslindero (
        predio_id, geometria, metodo_produccion, area_m2, perimetro_m, local_id
    ) VALUES (
        p_predio_id,
        v_geom,
        v_metodo,
        ST_Area(v_geom::geography),
        ST_Perimeter(v_geom::geography),
        'CARA_' || p_predio_id
    );

    RETURN v_total;
END $$;

COMMENT ON FUNCTION fn_generar_topologia_lindero IS
    'Descompone geom_perimetro en COL_Punto, COL_CadenaDeLimite y COL_CarasLindero, recorriendo el anillo exterior y los huecos. Devuelve cuántos vértices generó.';

CREATE OR REPLACE FUNCTION fn_trig_topologia_lindero()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    PERFORM fn_generar_topologia_lindero(NEW.id);
    RETURN NULL;
END $$;

-- migrate_perimetro.sql calculaba el área solo cuando había polígono; al
-- borrarlo, el área vieja se quedaba ahí y el visor mostraba un territorio
-- sin geometría pero con hectáreas. Se redefine para que también limpie, y
-- de paso mantiene al día la estructura geométrica.
CREATE OR REPLACE FUNCTION fn_calcular_area_perimetro()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.geom_perimetro IS NOT NULL THEN
        NEW.area_perimetro_calculada_ha := ST_Area(NEW.geom_perimetro::geography) / 10000.0;
        NEW.estructura_geometrica       := 'Topologia';
    ELSE
        NEW.area_perimetro_calculada_ha := NULL;
        NEW.estructura_geometrica       := CASE WHEN NEW.geom IS NOT NULL THEN 'No_Poligono' ELSE NULL END;
    END IF;
    RETURN NEW;
END $$;

-- El trigger original solo miraba geom_perimetro. Si se borra el polígono
-- hay que recalcular igual, así que se vuelve a crear sin restricción de
-- columnas.
DROP TRIGGER IF EXISTS trig_calcular_area_perimetro ON tpc_predio;
CREATE TRIGGER trig_calcular_area_perimetro
    BEFORE INSERT OR UPDATE OF geom_perimetro, geom ON tpc_predio
    FOR EACH ROW EXECUTE FUNCTION fn_calcular_area_perimetro();

-- Sin condición WHEN a propósito: si alguien borra el polígono, la
-- función tiene que correr igual para retirar la topología vieja. Con un
-- WHEN sobre NEW.geom_perimetro IS NOT NULL quedarían vértices colgando
-- de un lindero que ya no existe.
--
-- Se vigilan también el método de captura y la traza GPS, porque de ellos
-- salen el método de producción y la exactitud de cada vértice.
DROP TRIGGER IF EXISTS trig_topologia_lindero ON tpc_predio;
CREATE TRIGGER trig_topologia_lindero
    AFTER INSERT OR UPDATE OF geom_perimetro, metodo_captura_perimetro, puntos_recorrido_gps
    ON tpc_predio
    FOR EACH ROW
    EXECUTE FUNCTION fn_trig_topologia_lindero();

-- Generar la topología de los territorios que ya estaban capturados.
--
-- Solo donde todavía no exista: la función rehace desde cero, y volver a
-- correr esta migración no debe borrar lo que alguien haya escrito a mano
-- sobre un tramo del lindero.
DO $$
DECLARE
    r        RECORD;
    v_total  INTEGER := 0;
    v_predios INTEGER := 0;
BEGIN
    FOR r IN
        SELECT p.id FROM tpc_predio p
        WHERE p.geom_perimetro IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM col_punto cp WHERE cp.predio_id = p.id)
    LOOP
        v_total   := v_total + fn_generar_topologia_lindero(r.id);
        v_predios := v_predios + 1;
    END LOOP;
    RAISE NOTICE 'Topología generada para % territorio(s): % vértices en total.', v_predios, v_total;
END $$;

COMMIT;


-- ======================================================================
--  6. AGRUPACIONES Y ASOCIACIONES QUE FALTABAN
-- ======================================================================

BEGIN;

-- ─── COL_AgrupacionInteresados + col_miembros ─────────────────────────
-- Permite que varias comunidades compartan un mismo territorio con un
-- porcentaje de participación cada una. Hasta ahora el modelo asumía
-- siempre una comunidad por territorio.
CREATE TABLE IF NOT EXISTS col_agrupacioninteresados (
    t_id                       SERIAL       PRIMARY KEY,
    nombre                     VARCHAR(255) NOT NULL,
    tipo                       VARCHAR(60)  DEFAULT 'Comunidad_Multiple',
    observaciones              TEXT,
    espacio_de_nombres         VARCHAR(255) DEFAULT 'CATASTRO_ETNICO',
    local_id                   VARCHAR(255),
    comienzo_vida_util_version TIMESTAMP    DEFAULT NOW(),
    fin_vida_util_version      TIMESTAMP
);

COMMENT ON TABLE col_agrupacioninteresados IS
    'COL_AgrupacionInteresados — conjunto de comunidades que comparten derechos sobre un mismo territorio.';

CREATE TABLE IF NOT EXISTS col_miembros (
    t_id                      SERIAL  PRIMARY KEY,
    agrupacion_id             INTEGER NOT NULL REFERENCES col_agrupacioninteresados(t_id) ON DELETE CASCADE,
    comunidad_id              INTEGER NOT NULL REFERENCES tpc_interesado_comunidad(id)     ON DELETE CASCADE,
    participacion_numerador   INTEGER,
    participacion_denominador INTEGER,
    participacion             NUMERIC(9,6) GENERATED ALWAYS AS (
        CASE WHEN participacion_denominador IS NOT NULL AND participacion_denominador > 0
             THEN participacion_numerador::NUMERIC / participacion_denominador
             ELSE NULL END
    ) STORED,
    UNIQUE (agrupacion_id, comunidad_id)
);

COMMENT ON TABLE  col_miembros IS
    'Clase asociativa entre la agrupación y cada comunidad, con su participación.';
COMMENT ON COLUMN col_miembros.participacion IS
    'El estándar define la participación como una fracción; por eso se guardan numerador y denominador, y el decimal se calcula solo.';

-- ─── COL_AgrupacionUnidadesEspaciales ─────────────────────────────────
-- Para territorios formados por varios polígonos separados, que es lo
-- normal cuando un resguardo tiene sectores discontinuos.
CREATE TABLE IF NOT EXISTS col_agrupacionunidadesespaciales (
    t_id                       SERIAL       PRIMARY KEY,
    nombre                     VARCHAR(255) NOT NULL,
    nivel_jerarquico           INTEGER      DEFAULT 0,
    punto_referencia           GEOMETRY(POINT, 4326),
    agrupacion_padre_id        INTEGER      REFERENCES col_agrupacionunidadesespaciales(t_id) ON DELETE SET NULL,
    espacio_de_nombres         VARCHAR(255) DEFAULT 'CATASTRO_ETNICO',
    local_id                   VARCHAR(255),
    comienzo_vida_util_version TIMESTAMP    DEFAULT NOW(),
    fin_vida_util_version      TIMESTAMP
);

COMMENT ON TABLE col_agrupacionunidadesespaciales IS
    'COL_AgrupacionUnidadesEspaciales — territorio compuesto por varios polígonos, con jerarquía y punto de referencia.';

CREATE TABLE IF NOT EXISTS col_ue_agrupacion (
    t_id          SERIAL  PRIMARY KEY,
    agrupacion_id INTEGER NOT NULL REFERENCES col_agrupacionunidadesespaciales(t_id) ON DELETE CASCADE,
    predio_id     INTEGER NOT NULL REFERENCES tpc_predio(id) ON DELETE CASCADE,
    UNIQUE (agrupacion_id, predio_id)
);

-- ─── COL_RRRFuente: qué documento sustenta cada derecho ───────────────
-- Esta es la asociación que cerraba la cadena
--     COL_Fuente → COL_DRR → COL_UnidadAdministrativaBasica
-- y que hasta ahora no existía.
CREATE TABLE IF NOT EXISTS col_rrrfuente (
    t_id                     SERIAL  PRIMARY KEY,
    fuente_administrativa_id INTEGER NOT NULL REFERENCES tpc_fuente_administrativa(id) ON DELETE CASCADE,
    derecho_id               INTEGER REFERENCES tpc_derecho(id)     ON DELETE CASCADE,
    restriccion_id           INTEGER REFERENCES tpc_restriccion(id) ON DELETE CASCADE,
    CONSTRAINT chk_rrrfuente_destino CHECK (derecho_id IS NOT NULL OR restriccion_id IS NOT NULL)
);

COMMENT ON TABLE col_rrrfuente IS
    'Asociación entre la fuente administrativa y el derecho o la restricción que sustenta. Es lo que permite responder "¿qué documento respalda este derecho?".';

-- Recuperar los actos administrativos de los registros ya hechos.
--
-- Hasta ahora el acto se guardaba dentro de tpc_representante_legal y esta
-- tabla quedaba vacía. Aquí se crea la fuente que faltaba para cada
-- registro anterior, sin tocar el dato original, y se enlaza con su
-- derecho. Así los territorios ya capturados también quedan con la cadena
-- COL_Fuente → COL_DRR completa.
INSERT INTO tpc_fuente_administrativa
    (comunidad_id, tipo_fuente, tipo_acto_administrativo,
     numero_acto_administrativo, fecha_acto_administrativo, fecha_documento, observaciones)
SELECT r.comunidad_id,
       CASE r.tipo_acto_administrativo
            WHEN 'Sin_Documento'   THEN 'Sin_Documento'
            WHEN 'Folio_Matricula' THEN 'Documento_Publico'
            WHEN 'Sentencia'       THEN 'Sentencia_Judicial'
            ELSE 'Acto_Administrativo' END,
       r.tipo_acto_administrativo,
       r.numero_acto_administrativo,
       r.fecha_acto_administrativo,
       fn_texto_a_fecha(r.fecha_acto_administrativo),
       'Recuperado de tpc_representante_legal por migrate_ladm.sql'
FROM tpc_representante_legal r
WHERE r.tipo_acto_administrativo IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM tpc_fuente_administrativa f WHERE f.comunidad_id = r.comunidad_id
  );

INSERT INTO col_rrrfuente (fuente_administrativa_id, derecho_id)
SELECT f.id, d.id
FROM tpc_fuente_administrativa f
JOIN tpc_derecho d ON d.comunidad_id = f.comunidad_id
WHERE NOT EXISTS (
    SELECT 1 FROM col_rrrfuente x
    WHERE x.fuente_administrativa_id = f.id AND x.derecho_id = d.id
);

INSERT INTO col_rrrfuente (fuente_administrativa_id, restriccion_id)
SELECT f.id, res.id
FROM tpc_fuente_administrativa f
JOIN tpc_restriccion res ON res.comunidad_id = f.comunidad_id
WHERE NOT EXISTS (
    SELECT 1 FROM col_rrrfuente x
    WHERE x.fuente_administrativa_id = f.id AND x.restriccion_id = res.id
);

-- ─── COL_UEFuente: qué insumo produjo cada geometría ──────────────────
CREATE TABLE IF NOT EXISTS col_uefuente (
    t_id               SERIAL  PRIMARY KEY,
    fuente_espacial_id INTEGER NOT NULL REFERENCES tpc_fuente_espacial(id) ON DELETE CASCADE,
    predio_id          INTEGER NOT NULL REFERENCES tpc_predio(id)          ON DELETE CASCADE,
    UNIQUE (fuente_espacial_id, predio_id)
);

COMMENT ON TABLE col_uefuente IS
    'Asociación entre la fuente espacial y la unidad espacial cuya geometría produjo.';

INSERT INTO col_uefuente (fuente_espacial_id, predio_id)
SELECT fe.id, p.id
FROM tpc_fuente_espacial fe
JOIN tpc_predio p ON p.comunidad_id = fe.comunidad_id
ON CONFLICT DO NOTHING;

-- El método de producción de la fuente espacial es el mismo con que se
-- capturó el perímetro del predio que produjo.
UPDATE tpc_fuente_espacial fe
SET metodo_produccion = p.metodo_captura_perimetro
FROM tpc_predio p
WHERE p.comunidad_id = fe.comunidad_id
  AND fe.metodo_produccion IS NULL
  AND p.metodo_captura_perimetro IS NOT NULL;

-- ─── ExtDireccion ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ext_direccion (
    id             SERIAL      PRIMARY KEY,
    comunidad_id   INTEGER     REFERENCES tpc_interesado_comunidad(id) ON DELETE CASCADE,
    predio_id      INTEGER     REFERENCES tpc_predio(id)               ON DELETE CASCADE,
    tipo_direccion VARCHAR(30) DEFAULT 'Rural',
    departamento   VARCHAR(100),
    municipio      VARCHAR(100),
    corregimiento  VARCHAR(100),
    vereda         VARCHAR(100),
    texto_direccion TEXT,
    geom           GEOMETRY(POINT, 4326),
    CONSTRAINT chk_direccion_destino CHECK (comunidad_id IS NOT NULL OR predio_id IS NOT NULL)
);

COMMENT ON TABLE ext_direccion IS
    'ExtDireccion — dirección estructurada del interesado o del predio. En territorio rural casi siempre es departamento / municipio / corregimiento / vereda.';

-- Poblarla con la ubicación que ya tiene cada predio registrado.
INSERT INTO ext_direccion (comunidad_id, predio_id, tipo_direccion, departamento, municipio, corregimiento, vereda, geom)
SELECT p.comunidad_id, p.id, 'Rural', p.departamento, p.municipio, p.corregimiento, p.vereda, p.geom
FROM tpc_predio p
WHERE NOT EXISTS (SELECT 1 FROM ext_direccion d WHERE d.predio_id = p.id);

-- Y mantenerla al día sola. Sin esto, ExtDireccion quedaría congelada el
-- día de la migración: el chatbot no la conoce, así que ningún registro
-- posterior tendría dirección.
CREATE OR REPLACE FUNCTION fn_sincronizar_direccion()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO ext_direccion (comunidad_id, predio_id, tipo_direccion,
                               departamento, municipio, corregimiento, vereda, geom)
    VALUES (NEW.comunidad_id, NEW.id, 'Rural',
            NEW.departamento, NEW.municipio, NEW.corregimiento, NEW.vereda, NEW.geom)
    ON CONFLICT (predio_id) WHERE predio_id IS NOT NULL DO UPDATE SET
        departamento  = EXCLUDED.departamento,
        municipio     = EXCLUDED.municipio,
        corregimiento = EXCLUDED.corregimiento,
        vereda        = EXCLUDED.vereda,
        geom          = EXCLUDED.geom;
    RETURN NULL;
END $$;

-- ON CONFLICT necesita una restricción única sobre la que apoyarse.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ext_direccion_predio
    ON ext_direccion (predio_id) WHERE predio_id IS NOT NULL;

DROP TRIGGER IF EXISTS trig_sincronizar_direccion ON tpc_predio;
CREATE TRIGGER trig_sincronizar_direccion
    AFTER INSERT OR UPDATE OF departamento, municipio, corregimiento, vereda, geom
    ON tpc_predio
    FOR EACH ROW EXECUTE FUNCTION fn_sincronizar_direccion();

COMMIT;


-- ======================================================================
--  7. LLAVES FORÁNEAS HACIA LOS CATÁLOGOS
--
--  Se hace al final, cuando los valores ya están traducidos, para que
--  ningún dato existente quede fuera. Lo que no figure en el catálogo
--  entra marcado como valor heredado en vez de romper la migración.
-- ======================================================================

BEGIN;

SELECT fn_vincular_catalogo('tpc_interesado_comunidad',           'tipo_comunidad',            'tpc_comunidadtipo');
SELECT fn_vincular_catalogo('tpc_interesado_comunidad',           'tipo_organizacion_filial',  'tpc_organizacionfilialtipo');
SELECT fn_vincular_catalogo('tpc_representante_legal',            'cargo',                     'tpc_cargotipo');
SELECT fn_vincular_catalogo('tpc_representante_legal',            'tipo_documento',            'tpc_documentotipo');
SELECT fn_vincular_catalogo('tpc_representante_legal',            'tipo_acto_administrativo',  'tpc_actoadministrativotipo');
SELECT fn_vincular_catalogo('tpc_territorio_propiedad_colectiva', 'tipo_procedimiento',        'tpc_procedimientotipo');
SELECT fn_vincular_catalogo('tpc_predio',                         'reconocimiento_estado',     'ext_reconocimientotipo');
SELECT fn_vincular_catalogo('tpc_predio',                         'limites_territorio',        'ext_limitestipo');
SELECT fn_vincular_catalogo('tpc_predio',                         'metodo_captura_perimetro',  'col_metodoproducciontipo');
SELECT fn_vincular_catalogo('tpc_predio',                         'estructura_geometrica',     'col_estructuratipo');
SELECT fn_vincular_catalogo('tpc_derecho',                        'tipo_derecho',              'col_derechotipo');
SELECT fn_vincular_catalogo('tpc_restriccion',                    'tipo_restriccion',          'col_restricciontipo');
SELECT fn_vincular_catalogo('tpc_fuente_administrativa',          'tipo_fuente',               'col_fuenteadministrativatipo');
SELECT fn_vincular_catalogo('tpc_fuente_administrativa',          'tipo_acto_administrativo',  'tpc_actoadministrativotipo');
SELECT fn_vincular_catalogo('tpc_fuente_espacial',                'tipo_fuente_espacial',      'col_fuenteespacialtipo');
SELECT fn_vincular_catalogo('tpc_fuente_espacial',                'metodo_produccion',         'col_metodoproducciontipo');
SELECT fn_vincular_catalogo('col_punto',                          'tipo_punto',                'col_puntotipo');
SELECT fn_vincular_catalogo('col_punto',                          'metodo_produccion',         'col_metodoproducciontipo');
SELECT fn_vincular_catalogo('col_punto',                          'interpolacion',             'col_interpolaciontipo');
SELECT fn_vincular_catalogo('col_cadenadelimite',                 'metodo_produccion',         'col_metodoproducciontipo');
SELECT fn_vincular_catalogo('col_cadenadelimite',                 'interpolacion',             'col_interpolaciontipo');
SELECT fn_vincular_catalogo('col_caraslindero',                   'metodo_produccion',         'col_metodoproducciontipo');
SELECT fn_vincular_catalogo('ext_historia_territorio',            'antiguedad_territorio',     'ext_antiguedadtipo');
SELECT fn_vincular_catalogo('ext_uso_territorio',                 'tipo_uso',                  'ext_usotipo');
SELECT fn_vincular_catalogo('ext_validacion_comunitaria',         'validado_por_comunidad',    'ext_validaciontipo');
SELECT fn_vincular_catalogo('ext_foto_registro',                  'categoria',                 'ext_fotocategoria');

COMMIT;


-- ======================================================================
--  8. VISTAS DE APOYO
-- ======================================================================

BEGIN;

-- Conteo exacto, no la estimación de pg_stat_user_tables: esa puede decir
-- cero en una tabla recién poblada si el autoanalyze todavía no ha pasado,
-- y estas cifras son para sustentar, no para monitorear.
CREATE OR REPLACE FUNCTION fn_contar_filas(p_tabla TEXT)
RETURNS BIGINT LANGUAGE plpgsql STABLE AS $$
DECLARE n BIGINT;
BEGIN
    IF to_regclass('public.' || p_tabla) IS NULL THEN RETURN 0; END IF;
    EXECUTE format('SELECT count(*) FROM %I', p_tabla) INTO n;
    RETURN n;
END $$;

-- Cuánto del modelo está efectivamente poblado. Sirve para sustentar la
-- conformidad con datos en la mano en vez de con una afirmación.
CREATE OR REPLACE VIEW vista_ladm_cobertura AS
WITH clases(clase_ladm, tabla, naturaleza) AS (VALUES
    ('COL_Interesado / TPC_InteresadoComunidad', 'tpc_interesado_comunidad',           'Núcleo LADM'),
    ('COL_Interesado / Representante legal',     'tpc_representante_legal',            'Núcleo LADM'),
    ('COL_UnidadAdministrativaBasica / Territorio','tpc_territorio_propiedad_colectiva','Núcleo LADM'),
    ('COL_UnidadAdministrativaBasica / TPC_Predio','tpc_predio',                       'Núcleo LADM'),
    ('COL_DRR / Derecho',                        'tpc_derecho',                        'Núcleo LADM'),
    ('COL_DRR / Restricción',                    'tpc_restriccion',                    'Núcleo LADM'),
    ('COL_Fuente / Administrativa',              'tpc_fuente_administrativa',          'Núcleo LADM'),
    ('COL_Fuente / Espacial',                    'tpc_fuente_espacial',                'Núcleo LADM'),
    ('COL_Punto',                                'col_punto',                          'Topología del lindero'),
    ('COL_CadenaDeLimite',                       'col_cadenadelimite',                 'Topología del lindero'),
    ('COL_CarasLindero',                         'col_caraslindero',                   'Topología del lindero'),
    ('COL_AgrupacionInteresados',                'col_agrupacioninteresados',          'Agrupaciones'),
    ('COL_Miembros',                             'col_miembros',                       'Agrupaciones'),
    ('COL_AgrupacionUnidadesEspaciales',         'col_agrupacionunidadesespaciales',   'Agrupaciones'),
    ('RRRFuente',                                'col_rrrfuente',                      'Asociaciones'),
    ('UEFuente',                                 'col_uefuente',                       'Asociaciones'),
    ('ExtDireccion',                             'ext_direccion',                      'Extensión propia'),
    ('EXT_HistoriaTerritorio',                   'ext_historia_territorio',            'Extensión propia'),
    ('EXT_UsoTerritorio',                        'ext_uso_territorio',                 'Extensión propia'),
    ('EXT_ValidacionComunitaria',                'ext_validacion_comunitaria',         'Extensión propia'),
    ('EXT_TranscripcionRespuesta',               'ext_transcripcion_respuesta',        'Extensión propia'),
    ('EXT_FotoRegistro',                         'ext_foto_registro',                  'Extensión propia')
)
SELECT
    c.clase_ladm,
    c.tabla,
    c.naturaleza,
    to_regclass('public.' || c.tabla) IS NOT NULL AS existe,
    fn_contar_filas(c.tabla)                      AS filas
FROM clases c;

COMMENT ON VIEW vista_ladm_cobertura IS
    'Una fila por clase del modelo: si la tabla existe y cuántos registros tiene. Útil para mostrar el grado de implementación.';

-- El lindero tramo por tramo, con su método de producción, que es
-- justamente lo que antes no se podía consultar.
CREATE OR REPLACE VIEW vista_lindero_detalle AS
SELECT
    p.id                       AS predio_id,
    c.nombre_comunidad,
    ca.orden                   AS tramo,
    ca.longitud_m,
    ca.metodo_produccion,
    mp.dispname                AS metodo_legible,
    ca.interpolacion,
    ca.descripcion_lindero,
    pi.orden                   AS vertice_inicial,
    pf.orden                   AS vertice_final,
    ST_AsGeoJSON(ca.geometria)::json AS geometry
FROM col_cadenadelimite ca
JOIN tpc_predio p                ON p.id = ca.predio_id
JOIN tpc_interesado_comunidad c  ON c.id = p.comunidad_id
LEFT JOIN col_punto pi           ON pi.t_id = ca.punto_inicial
LEFT JOIN col_punto pf           ON pf.t_id = ca.punto_final
LEFT JOIN col_metodoproducciontipo mp ON mp.ilicode = ca.metodo_produccion
ORDER BY p.id, ca.orden;

COMMENT ON VIEW vista_lindero_detalle IS
    'Cada tramo del lindero con su método de producción y su longitud real en metros.';

COMMIT;


-- ======================================================================
--  9. VERIFICACIÓN
-- ======================================================================

DO $$
DECLARE
    n_catalogos INTEGER;
    n_clases    INTEGER;
    n_fks       INTEGER;
    n_puntos    INTEGER;
BEGIN
    SELECT COUNT(*) INTO n_catalogos
    FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'ilicode';

    SELECT COUNT(*) INTO n_clases
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename IN ('col_punto','col_cadenadelimite','col_caraslindero',
                        'col_agrupacioninteresados','col_miembros',
                        'col_agrupacionunidadesespaciales','col_ue_agrupacion',
                        'col_rrrfuente','col_uefuente','ext_direccion');

    SELECT COUNT(*) INTO n_fks
    FROM pg_constraint WHERE conname LIKE 'fk\_%' AND contype = 'f';

    SELECT COUNT(*) INTO n_puntos FROM col_punto;

    RAISE NOTICE '';
    RAISE NOTICE '======================================================';
    RAISE NOTICE '  Alineación con LADM-COL completada';
    RAISE NOTICE '======================================================';
    RAISE NOTICE '  Catálogos de enumeración   : %', n_catalogos;
    RAISE NOTICE '  Clases nuevas del modelo   : % / 10', n_clases;
    RAISE NOTICE '  Llaves foráneas a catálogo : %', n_fks;
    RAISE NOTICE '  Vértices de lindero        : %', n_puntos;
    RAISE NOTICE '======================================================';
    RAISE NOTICE '  Para ver el estado:  SELECT * FROM vista_ladm_cobertura;';
    RAISE NOTICE '';

    IF n_clases < 10 THEN
        RAISE WARNING 'Faltan % clase(s) por crear. Revise los errores anteriores.', 10 - n_clases;
    END IF;
END $$;
