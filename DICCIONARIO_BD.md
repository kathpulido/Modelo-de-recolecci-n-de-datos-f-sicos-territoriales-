# Diccionario de datos — `catastro_etnico`

Generado directamente desde la base de datos, después de aplicar `setup_db.sql` y las
cinco migraciones (`migrate_postgis`, `migrate_perimetro`, `migrate_voz_fotos`,
`migrate_ladm`, `migrate_familias`). Todo lo que aparece aquí es lo que la base tiene
de verdad, no lo que debería tener.

## Resumen

| | |
|---|---:|
| Tablas de datos | 26 |
| Tablas de catálogo (enumeraciones LADM) | 22 |
| Vistas | 8 |
| Llaves foráneas | 66 |
| Reglas CHECK | 6 |
| Índices (sin contar los de llave primaria) | 58 |
| Funciones | 15 |
| Disparadores | 15 |

**Convenciones de las tablas de columnas**

- `PK` llave primaria · `FK` llave foránea · `U` valor único
- `NN` la columna no admite nulos · `GEN` la calcula la base de datos sola
- Las columnas `espacio_de_nombres`, `local_id`, `comienzo_vida_util_version` y
  `fin_vida_util_version` vienen de `<<ObjetoVersionado>>` del estándar: identifican
  el objeto de forma global y guardan desde cuándo y hasta cuándo vale esa versión.

---

## Interesados — quién es titular

### `tpc_interesado_comunidad`

Identifica la comunidad, pueblo o grupo étnico titular del territorio colectivo.

| Columna | Tipo | Marcas | Referencia / nota |
|---|---|---|---|
| `id` | integer | PK NN |  |
| `nombre_comunidad` | character varying(200) | NN |  |
| `tipo_comunidad` | character varying(50) | FK | → `tpc_comunidadtipo.ilicode` · TPC_ComunidadTipo según LADM-COL: Comunidad_Negra, Cabildo, Parcialidad, Resguardo_Indigena, Territorio_Colectivo. |
| `tipo_organizacion_filial` | character varying(200) | FK | → `tpc_organizacionfilialtipo.ilicode` |
| `pueblo` | character varying(200) |  |  |
| `numero_familias` | integer |  |  |
| `numero_personas` | integer |  |  |
| `numero_mujeres` | integer |  |  |
| `numero_hombres` | integer |  |  |
| `consentimiento` | character varying(5) |  |  |
| `fecha_registro` | timestamp without time zone |  |  |
| `espacio_de_nombres` | character varying(255) |  |  |
| `local_id` | character varying(255) |  |  |
| `comienzo_vida_util_version` | timestamp without time zone |  |  |
| `fin_vida_util_version` | timestamp without time zone |  |  |

Índices:

- `idx_comunidad_fecha` — `INDEX idx_comunidad_fecha ON public.tpc_interesado_comunidad USING btree (fecha_registro)`
- `idx_comunidad_nombre` — `INDEX idx_comunidad_nombre ON public.tpc_interesado_comunidad USING btree (nombre_comunidad)`

Disparadores:

- `trig_notify_nuevo_registro`
- `trig_versionado`

### `tpc_representante_legal`

Representante legal o autoridad principal que diligencia el registro.

| Columna | Tipo | Marcas | Referencia / nota |
|---|---|---|---|
| `id` | integer | PK NN |  |
| `comunidad_id` | integer | FK NN | → `tpc_interesado_comunidad.id` |
| `nombres_autoridades` | text |  |  |
| `cargo` | character varying(100) | FK | → `tpc_cargotipo.ilicode` |
| `legitimidad` | character varying(50) |  |  |
| `numero_documento_representante` | character varying(50) |  |  |
| `tipo_acto_administrativo` | character varying(50) | FK | → `tpc_actoadministrativotipo.ilicode` |
| `numero_acto_administrativo` | character varying(100) |  |  |
| `fecha_acto_administrativo` | character varying(50) |  |  |
| `telefono` | character varying(20) |  |  |
| `espacio_de_nombres` | character varying(255) |  |  |
| `local_id` | character varying(255) |  |  |
| `comienzo_vida_util_version` | timestamp without time zone |  |  |
| `fin_vida_util_version` | timestamp without time zone |  |  |
| `primer_nombre` | character varying(100) |  | El modelo pide el nombre en cuatro campos separados para poder cruzarlo contra registros civiles. nombres_autoridades se conserva como el texto tal cual lo dictó la persona. |
| `segundo_nombre` | character varying(100) |  |  |
| `primer_apellido` | character varying(100) |  |  |
| `segundo_apellido` | character varying(100) |  |  |
| `tipo_documento` | character varying(60) | FK | → `tpc_documentotipo.ilicode` |

Índices:

- `idx_rep_legal_comunidad` — `INDEX idx_rep_legal_comunidad ON public.tpc_representante_legal USING btree (comunidad_id)`

Disparadores:

- `trig_versionado`

### `tpc_interesado_familia`

COL_Interesado — la familia como titular de un derecho de uso dentro del territorio colectivo. Especialización propia, paralela a tpc_interesado_comunidad.

| Columna | Tipo | Marcas | Referencia / nota |
|---|---|---|---|
| `id` | integer | PK NN |  |
| `comunidad_id` | integer | FK NN | → `tpc_interesado_comunidad.id` |
| `nombre_familia` | character varying(200) |  |  |
| `jefe_hogar` | character varying(200) |  |  |
| `primer_nombre` | character varying(100) |  |  |
| `segundo_nombre` | character varying(100) |  |  |
| `primer_apellido` | character varying(100) |  |  |
| `segundo_apellido` | character varying(100) |  |  |
| `tipo_documento` | character varying(60) | FK | → `tpc_documentotipo.ilicode` |
| `numero_documento` | character varying(50) |  |  |
| `telefono` | character varying(20) |  |  |
| `numero_personas` | integer |  |  |
| `numero_mujeres` | integer |  |  |
| `numero_hombres` | integer |  |  |
| `numero_menores` | integer |  |  |
| `antiguedad_ocupacion` | character varying(100) | FK | → `ext_antiguedadtipo.ilicode` |
| `origen_asignacion` | character varying(60) | FK | → `tpc_origenasignaciontipo.ilicode` · Cómo llegó la familia a ocupar ese lugar: asignación de la asamblea, herencia, ocupación antigua. Extensión propia: el estándar no modela la asignación interna. |
| `fecha_registro` | timestamp without time zone |  |  |
| `espacio_de_nombres` | character varying(255) |  |  |
| `local_id` | character varying(255) |  |  |
| `comienzo_vida_util_version` | timestamp without time zone |  |  |
| `fin_vida_util_version` | timestamp without time zone |  |  |

Reglas:

- `chk_familia_suma` — `CHECK (((numero_personas IS NULL) OR ((COALESCE(numero_mujeres, 0) + COALESCE(numero_hombres, 0)) <= numero_personas)))`

Índices:

- `idx_familia_comunidad` — `INDEX idx_familia_comunidad ON public.tpc_interesado_familia USING btree (comunidad_id)`

Disparadores:

- `trig_versionado`

### `col_agrupacioninteresados`

COL_AgrupacionInteresados — conjunto de comunidades que comparten derechos sobre un mismo territorio.

| Columna | Tipo | Marcas | Referencia / nota |
|---|---|---|---|
| `t_id` | integer | PK NN |  |
| `nombre` | character varying(255) | NN |  |
| `tipo` | character varying(60) |  |  |
| `observaciones` | text |  |  |
| `espacio_de_nombres` | character varying(255) |  |  |
| `local_id` | character varying(255) |  |  |
| `comienzo_vida_util_version` | timestamp without time zone |  |  |
| `fin_vida_util_version` | timestamp without time zone |  |  |

### `col_miembros`

Clase asociativa entre la agrupación y cada comunidad, con su participación.

| Columna | Tipo | Marcas | Referencia / nota |
|---|---|---|---|
| `t_id` | integer | PK NN |  |
| `agrupacion_id` | integer | FK U NN | → `col_agrupacioninteresados.t_id` |
| `comunidad_id` | integer | FK U NN | → `tpc_interesado_comunidad.id` |
| `participacion_numerador` | integer |  |  |
| `participacion_denominador` | integer |  |  |
| `participacion` | numeric(9,6) | GEN | El estándar define la participación como una fracción; por eso se guardan numerador y denominador, y el decimal se calcula solo. |

Índices:

- `col_miembros_agrupacion_id_comunidad_id_key` — `UNIQUE INDEX col_miembros_agrupacion_id_comunidad_id_key ON public.col_miembros USING btree (agrupacion_id, comunidad_id)`

## Unidad espacial — el territorio y las parcelas

### `tpc_predio`

Datos catastrales del predio colectivo: ubicación, área y límites.

| Columna | Tipo | Marcas | Referencia / nota |
|---|---|---|---|
| `id` | integer | PK NN |  |
| `comunidad_id` | integer | FK NN | → `tpc_interesado_comunidad.id` |
| `departamento` | character varying(100) |  |  |
| `municipio` | character varying(100) |  |  |
| `vereda` | character varying(100) |  |  |
| `corregimiento` | character varying(100) |  |  |
| `nombre_predio` | character varying(300) |  |  |
| `numero_predial` | character varying(30) |  |  |
| `area_acto_administrativo` | numeric(12,4) |  |  |
| `reconocimiento_estado` | character varying(50) | FK | → `ext_reconocimientotipo.ilicode` |
| `limites_territorio` | character varying(100) | FK | → `ext_limitestipo.ilicode` |
| `zonas_especiales` | character varying(5) |  |  |
| `latitud` | numeric(10,7) |  | Latitud en grados decimales WGS84. Obtenida por GPS del usuario vía WhatsApp o ingresada manualmente. |
| `longitud` | numeric(10,7) |  | Longitud en grados decimales WGS84. |
| `geom` | geometry |  |  |
| `geom_perimetro` | geometry |  | Polígono del perímetro del predio (WGS-84). Capturado por croquis.html o recorrido.html, no por el chatbot directamente. |
| `metodo_captura_perimetro` | character varying(120) | FK | → `col_metodoproducciontipo.ilicode` · croquis_manual = dibujado sobre el mapa; recorrido_gps = trazado caminando el lindero; no_capturado = el declarante omitió este paso. |
| `area_perimetro_calculada_ha` | numeric(12,4) |  |  |
| `geojson_perimetro` | jsonb |  |  |
| `puntos_recorrido_gps` | jsonb |  |  |
| `espacio_de_nombres` | character varying(255) |  |  |
| `local_id` | character varying(255) |  |  |
| `comienzo_vida_util_version` | timestamp without time zone |  |  |
| `fin_vida_util_version` | timestamp without time zone |  |  |
| `matricula_inmobiliaria` | character varying(50) |  |  |
| `codigo_orip` | character varying(10) |  |  |
| `nupre` | character varying(30) |  | Número Único Predial. En el estándar es el identificador que amarra el predio con el registro. |
| `numero_predial_anterior` | character varying(30) |  |  |
| `codigo_homologado` | character varying(50) |  |  |
| `codigo_homologado_fmi` | character varying(50) |  |  |
| `interrelacionado` | boolean |  |  |
| `area_reconstruccion` | numeric(16,4) |  |  |
| `responsable_reconstruccion` | character varying(200) |  |  |
| `codigo_reconstruccion` | character varying(50) |  |  |
| `rango_tolerancia` | numeric(10,4) |  |  |
| `estructura_geometrica` | character varying(60) | FK | → `col_estructuratipo.ilicode` · COL_EstructuraTipo: cómo está representada la unidad espacial (solo punto, polígono, o topología de puntos y cadenas). |
| `predio_matriz_id` | integer | FK | → `tpc_predio.id` · Predio del que esta unidad forma parte. Nulo en el territorio colectivo; apunta a él en cada parcela familiar. |
| `nivel_tenencia` | character varying(30) | FK | → `tpc_niveltenenciatipo.ilicode` · Colectivo = lindero de todo el territorio. Familiar = parcela ocupada por una familia dentro de él. |

Reglas:

- `chk_predio_matriz_distinto` — `CHECK (((predio_matriz_id IS NULL) OR (predio_matriz_id <> id)))`

Índices:

- `idx_predio_comunidad` — `INDEX idx_predio_comunidad ON public.tpc_predio USING btree (comunidad_id)`
- `idx_predio_coords` — `INDEX idx_predio_coords ON public.tpc_predio USING btree (latitud, longitud) WHERE ((latitud IS NOT NULL) AND (longitud IS NOT NULL))`
- `idx_predio_geom` — `INDEX idx_predio_geom ON public.tpc_predio USING gist (geom)`
- `idx_predio_matriz` — `INDEX idx_predio_matriz ON public.tpc_predio USING btree (predio_matriz_id) WHERE (predio_matriz_id IS NOT NULL)`
- `idx_predio_ubicacion` — `INDEX idx_predio_ubicacion ON public.tpc_predio USING btree (departamento, municipio)`
- `idx_tpc_predio_geom_perimetro` — `INDEX idx_tpc_predio_geom_perimetro ON public.tpc_predio USING gist (geom_perimetro)`

Disparadores:

- `trig_actualizar_geom`
- `trig_agrupacion_espacial`
- `trig_calcular_area_perimetro`
- `trig_sincronizar_direccion`
- `trig_topologia_lindero`
- `trig_versionado`

### `tpc_territorio_propiedad_colectiva`

Representa el territorio como propiedad colectiva reconocida o en proceso.

| Columna | Tipo | Marcas | Referencia / nota |
|---|---|---|---|
| `id` | integer | PK NN |  |
| `comunidad_id` | integer | FK NN | → `tpc_interesado_comunidad.id` |
| `nombre_territorio` | character varying(300) |  |  |
| `tipo_procedimiento` | character varying(100) | FK | → `tpc_procedimientotipo.ilicode` |
| `espacio_de_nombres` | character varying(255) |  |  |
| `local_id` | character varying(255) |  |  |
| `comienzo_vida_util_version` | timestamp without time zone |  |  |
| `fin_vida_util_version` | timestamp without time zone |  |  |

Índices:

- `idx_territorio_comunidad` — `INDEX idx_territorio_comunidad ON public.tpc_territorio_propiedad_colectiva USING btree (comunidad_id)`

Disparadores:

- `trig_versionado`

### `col_agrupacionunidadesespaciales`

COL_AgrupacionUnidadesEspaciales — territorio compuesto por varios polígonos, con jerarquía y punto de referencia.

| Columna | Tipo | Marcas | Referencia / nota |
|---|---|---|---|
| `t_id` | integer | PK NN |  |
| `nombre` | character varying(255) | NN |  |
| `nivel_jerarquico` | integer |  |  |
| `punto_referencia` | geometry |  |  |
| `agrupacion_padre_id` | integer | FK | → `col_agrupacionunidadesespaciales.t_id` |
| `espacio_de_nombres` | character varying(255) |  |  |
| `local_id` | character varying(255) |  |  |
| `comienzo_vida_util_version` | timestamp without time zone |  |  |
| `fin_vida_util_version` | timestamp without time zone |  |  |

### `col_ue_agrupacion`

| Columna | Tipo | Marcas | Referencia / nota |
|---|---|---|---|
| `t_id` | integer | PK NN |  |
| `agrupacion_id` | integer | FK U NN | → `col_agrupacionunidadesespaciales.t_id` |
| `predio_id` | integer | FK U NN | → `tpc_predio.id` |

Índices:

- `col_ue_agrupacion_agrupacion_id_predio_id_key` — `UNIQUE INDEX col_ue_agrupacion_agrupacion_id_predio_id_key ON public.col_ue_agrupacion USING btree (agrupacion_id, predio_id)`

### `tpc_captura_perimetro_pendiente`

Cola de perímetros capturados fuera de WhatsApp (croquis.html / recorrido.html), a la espera de vincularse a un tpc_predio mediante el token compartido con la sesión del bot.

| Columna | Tipo | Marcas | Referencia / nota |
|---|---|---|---|
| `id` | integer | PK NN |  |
| `token` | uuid | U NN |  |
| `metodo` | character varying(30) | NN |  |
| `geojson` | jsonb | NN |  |
| `puntos_gps` | jsonb |  |  |
| `area_ha` | numeric(12,4) |  |  |
| `vertices` | integer |  |  |
| `creado_en` | timestamp without time zone |  |  |
| `usado` | boolean |  |  |
| `usado_en` | timestamp without time zone |  |  |
| `predio_id` | integer | FK | → `tpc_predio.id` |

Reglas:

- `tpc_captura_perimetro_pendiente_metodo_check` — `CHECK (((metodo)::text = ANY ((ARRAY['croquis_manual'::character varying, 'recorrido_gps'::character varying])::text[])))`

Índices:

- `idx_perimetro_pendiente_token` — `INDEX idx_perimetro_pendiente_token ON public.tpc_captura_perimetro_pendiente USING btree (token) WHERE (usado = false)`
- `tpc_captura_perimetro_pendiente_token_key` — `UNIQUE INDEX tpc_captura_perimetro_pendiente_token_key ON public.tpc_captura_perimetro_pendiente USING btree (token)`

## Topología del lindero

### `col_punto`

COL_Punto — vértice del lindero, con su método de producción y su exactitud.

| Columna | Tipo | Marcas | Referencia / nota |
|---|---|---|---|
| `t_id` | integer | PK NN |  |
| `predio_id` | integer | FK | → `tpc_predio.id` |
| `anillo` | integer |  | 0 = lindero exterior; 1, 2, ... = huecos interiores (enclaves dentro del territorio). |
| `orden` | integer |  | Posición del vértice dentro de su anillo, empezando en 1. |
| `tipo_punto` | character varying(60) | FK | → `col_puntotipo.ilicode` |
| `metodo_produccion` | character varying(120) | FK | → `col_metodoproducciontipo.ilicode` |
| `interpolacion` | character varying(60) | FK | → `col_interpolaciontipo.ilicode` |
| `exactitud_horizontal` | numeric(10,3) |  | Precisión horizontal en metros. En el recorrido GPS viene del propio receptor; en el croquis dibujado no aplica. |
| `exactitud_vertical` | numeric(10,3) |  |  |
| `posicion` | geometry | NN |  |
| `fuente_espacial_id` | integer | FK | → `tpc_fuente_espacial.id` |
| `espacio_de_nombres` | character varying(255) |  |  |
| `local_id` | character varying(255) |  |  |
| `comienzo_vida_util_version` | timestamp without time zone |  |  |
| `fin_vida_util_version` | timestamp without time zone |  |  |

Índices:

- `idx_col_punto_posicion` — `INDEX idx_col_punto_posicion ON public.col_punto USING gist (posicion)`
- `idx_col_punto_predio` — `INDEX idx_col_punto_predio ON public.col_punto USING btree (predio_id)`

### `col_cadenadelimite`

COL_CadenaDeLimite — tramo de lindero entre dos vértices consecutivos.

| Columna | Tipo | Marcas | Referencia / nota |
|---|---|---|---|
| `t_id` | integer | PK NN |  |
| `predio_id` | integer | FK | → `tpc_predio.id` |
| `anillo` | integer |  |  |
| `orden` | integer |  |  |
| `geometria` | geometry | NN |  |
| `punto_inicial` | integer | FK | → `col_punto.t_id` |
| `punto_final` | integer | FK | → `col_punto.t_id` |
| `metodo_produccion` | character varying(120) | FK | → `col_metodoproducciontipo.ilicode` |
| `interpolacion` | character varying(60) | FK | → `col_interpolaciontipo.ilicode` |
| `longitud_m` | numeric(14,3) |  |  |
| `descripcion_lindero` | text |  | Qué hay en ese tramo según la comunidad: un río, un camino, una cerca. Se puede llenar tramo por tramo más adelante. |
| `espacio_de_nombres` | character varying(255) |  |  |
| `local_id` | character varying(255) |  |  |
| `comienzo_vida_util_version` | timestamp without time zone |  |  |
| `fin_vida_util_version` | timestamp without time zone |  |  |

Índices:

- `idx_col_cadena_geom` — `INDEX idx_col_cadena_geom ON public.col_cadenadelimite USING gist (geometria)`
- `idx_col_cadena_predio` — `INDEX idx_col_cadena_predio ON public.col_cadenadelimite USING btree (predio_id)`

### `col_caraslindero`

COL_CarasLindero — superficie delimitada por el conjunto de cadenas de lindero.

| Columna | Tipo | Marcas | Referencia / nota |
|---|---|---|---|
| `t_id` | integer | PK NN |  |
| `predio_id` | integer | FK | → `tpc_predio.id` |
| `geometria` | geometry | NN |  |
| `metodo_produccion` | character varying(120) | FK | → `col_metodoproducciontipo.ilicode` |
| `area_m2` | numeric(18,3) |  |  |
| `perimetro_m` | numeric(18,3) |  |  |
| `espacio_de_nombres` | character varying(255) |  |  |
| `local_id` | character varying(255) |  |  |
| `comienzo_vida_util_version` | timestamp without time zone |  |  |
| `fin_vida_util_version` | timestamp without time zone |  |  |

Índices:

- `idx_col_caras_geom` — `INDEX idx_col_caras_geom ON public.col_caraslindero USING gist (geometria)`
- `idx_col_caras_predio` — `INDEX idx_col_caras_predio ON public.col_caraslindero USING btree (predio_id)`

## Derechos, restricciones y responsabilidades (RRR)

### `tpc_derecho`

TPC_DerechoTipo: derecho que ejerce la comunidad sobre el territorio.

| Columna | Tipo | Marcas | Referencia / nota |
|---|---|---|---|
| `id` | integer | PK NN |  |
| `comunidad_id` | integer | FK NN | → `tpc_interesado_comunidad.id` |
| `tipo_derecho` | character varying(100) | FK | → `col_derechotipo.ilicode` |
| `espacio_de_nombres` | character varying(255) |  |  |
| `local_id` | character varying(255) |  |  |
| `comienzo_vida_util_version` | timestamp without time zone |  |  |
| `fin_vida_util_version` | timestamp without time zone |  |  |
| `predio_id` | integer | FK | → `tpc_predio.id` · Unidad sobre la que recae el derecho. En el nivel colectivo es el territorio; en el familiar, la parcela. |
| `familia_id` | integer | FK | → `tpc_interesado_familia.id` · Titular cuando el derecho es de una familia. Nulo cuando el titular es la comunidad entera. |

Índices:

- `idx_derecho_comunidad` — `INDEX idx_derecho_comunidad ON public.tpc_derecho USING btree (comunidad_id)`
- `idx_derecho_familia` — `INDEX idx_derecho_familia ON public.tpc_derecho USING btree (familia_id) WHERE (familia_id IS NOT NULL)`
- `idx_derecho_predio` — `INDEX idx_derecho_predio ON public.tpc_derecho USING btree (predio_id) WHERE (predio_id IS NOT NULL)`

Disparadores:

- `trig_versionado`

### `tpc_restriccion`

TPC_RestriccionTipo: servidumbres, restricciones legales o de uso sobre el territorio.

| Columna | Tipo | Marcas | Referencia / nota |
|---|---|---|---|
| `id` | integer | PK NN |  |
| `comunidad_id` | integer | FK NN | → `tpc_interesado_comunidad.id` |
| `tipo_restriccion` | character varying(100) | FK | → `col_restricciontipo.ilicode` |
| `espacio_de_nombres` | character varying(255) |  |  |
| `local_id` | character varying(255) |  |  |
| `comienzo_vida_util_version` | timestamp without time zone |  |  |
| `fin_vida_util_version` | timestamp without time zone |  |  |

Índices:

- `idx_restriccion_comunidad` — `INDEX idx_restriccion_comunidad ON public.tpc_restriccion USING btree (comunidad_id)`

Disparadores:

- `trig_versionado`

### `col_rrrfuente`

Asociación entre la fuente administrativa y el derecho o la restricción que sustenta. Es lo que permite responder "¿qué documento respalda este derecho?".

| Columna | Tipo | Marcas | Referencia / nota |
|---|---|---|---|
| `t_id` | integer | PK NN |  |
| `fuente_administrativa_id` | integer | FK NN | → `tpc_fuente_administrativa.id` |
| `derecho_id` | integer | FK | → `tpc_derecho.id` |
| `restriccion_id` | integer | FK | → `tpc_restriccion.id` |

Reglas:

- `chk_rrrfuente_destino` — `CHECK (((derecho_id IS NOT NULL) OR (restriccion_id IS NOT NULL)))`

## Fuentes

### `tpc_fuente_administrativa`

Actos administrativos (resoluciones, acuerdos) que reconocen el territorio.

| Columna | Tipo | Marcas | Referencia / nota |
|---|---|---|---|
| `id` | integer | PK NN |  |
| `comunidad_id` | integer | FK NN | → `tpc_interesado_comunidad.id` |
| `tipo_fuente` | character varying(50) | FK | → `col_fuenteadministrativatipo.ilicode` |
| `tipo_acto_administrativo` | character varying(50) | FK | → `tpc_actoadministrativotipo.ilicode` |
| `numero_acto_administrativo` | character varying(100) |  |  |
| `fecha_acto_administrativo` | character varying(50) |  |  |
| `observaciones` | text |  |  |
| `espacio_de_nombres` | character varying(255) |  |  |
| `local_id` | character varying(255) |  |  |
| `comienzo_vida_util_version` | timestamp without time zone |  |  |
| `fin_vida_util_version` | timestamp without time zone |  |  |
| `fecha_documento` | date |  | Fecha real del acto administrativo. fecha_acto_administrativo se conserva como el texto que dictó la persona, que a veces es "no recuerdo". |
| `ente_emisor` | character varying(200) |  |  |

Disparadores:

- `trig_versionado`

### `tpc_fuente_espacial`

Fuentes cartográficas: planos IGAC, mapas comunitarios, etc.

| Columna | Tipo | Marcas | Referencia / nota |
|---|---|---|---|
| `id` | integer | PK NN |  |
| `comunidad_id` | integer | FK NN | → `tpc_interesado_comunidad.id` |
| `tipo_fuente_espacial` | character varying(100) | FK | → `col_fuenteespacialtipo.ilicode` |
| `numero_plano` | character varying(100) |  |  |
| `observaciones_plano` | text |  |  |
| `espacio_de_nombres` | character varying(255) |  |  |
| `local_id` | character varying(255) |  |  |
| `comienzo_vida_util_version` | timestamp without time zone |  |  |
| `fin_vida_util_version` | timestamp without time zone |  |  |
| `metodo_produccion` | character varying(120) | FK | → `col_metodoproducciontipo.ilicode` |
| `fecha_documento` | date |  |  |

Índices:

- `idx_fuente_esp_comunidad` — `INDEX idx_fuente_esp_comunidad ON public.tpc_fuente_espacial USING btree (comunidad_id)`

Disparadores:

- `trig_versionado`

### `col_uefuente`

Asociación entre la fuente espacial y la unidad espacial cuya geometría produjo.

| Columna | Tipo | Marcas | Referencia / nota |
|---|---|---|---|
| `t_id` | integer | PK NN |  |
| `fuente_espacial_id` | integer | FK U NN | → `tpc_fuente_espacial.id` |
| `predio_id` | integer | FK U NN | → `tpc_predio.id` |

Índices:

- `col_uefuente_fuente_espacial_id_predio_id_key` — `UNIQUE INDEX col_uefuente_fuente_espacial_id_predio_id_key ON public.col_uefuente USING btree (fuente_espacial_id, predio_id)`

## Extensiones propias del proyecto (EXT)

### `ext_direccion`

ExtDireccion — dirección estructurada del interesado o del predio. En territorio rural casi siempre es departamento / municipio / corregimiento / vereda.

| Columna | Tipo | Marcas | Referencia / nota |
|---|---|---|---|
| `id` | integer | PK NN |  |
| `comunidad_id` | integer | FK | → `tpc_interesado_comunidad.id` |
| `predio_id` | integer | FK | → `tpc_predio.id` |
| `tipo_direccion` | character varying(30) |  |  |
| `departamento` | character varying(100) |  |  |
| `municipio` | character varying(100) |  |  |
| `corregimiento` | character varying(100) |  |  |
| `vereda` | character varying(100) |  |  |
| `texto_direccion` | text |  |  |
| `geom` | geometry |  |  |

Reglas:

- `chk_direccion_destino` — `CHECK (((comunidad_id IS NOT NULL) OR (predio_id IS NOT NULL)))`

Índices:

- `uq_ext_direccion_predio` — `UNIQUE INDEX uq_ext_direccion_predio ON public.ext_direccion USING btree (predio_id) WHERE (predio_id IS NOT NULL)`

### `ext_historia_territorio`

Extensión LADM: historia oral de la comunidad sobre la ocupación del territorio.

| Columna | Tipo | Marcas | Referencia / nota |
|---|---|---|---|
| `id` | integer | PK NN |  |
| `comunidad_id` | integer | FK NN | → `tpc_interesado_comunidad.id` |
| `antiguedad_territorio` | character varying(100) | FK | → `ext_antiguedadtipo.ilicode` |
| `descripcion_historia` | text |  | Texto escrito por el usuario o transcripción automática (Groq Whisper) del audio de voz. |
| `audio_url` | text |  | Ruta al archivo OGG/opus enviado por WhatsApp y guardado localmente. |

Índices:

- `idx_historia_comunidad` — `INDEX idx_historia_comunidad ON public.ext_historia_territorio USING btree (comunidad_id)`

### `ext_uso_territorio`

Extensión LADM: tipo de uso del territorio y existencia de normas internas comunitarias.

| Columna | Tipo | Marcas | Referencia / nota |
|---|---|---|---|
| `id` | integer | PK NN |  |
| `predio_id` | integer | FK NN | → `tpc_predio.id` |
| `tipo_uso` | character varying(100) | FK | → `ext_usotipo.ilicode` |
| `reglas_internas` | character varying(5) |  |  |

Índices:

- `idx_uso_predio` — `INDEX idx_uso_predio ON public.ext_uso_territorio USING btree (predio_id)`

### `ext_validacion_comunitaria`

Extensión LADM: validación del registro territorial por parte de la asamblea o autoridades de la comunidad.

| Columna | Tipo | Marcas | Referencia / nota |
|---|---|---|---|
| `id` | integer | PK NN |  |
| `comunidad_id` | integer | FK NN | → `tpc_interesado_comunidad.id` |
| `validado_por_comunidad` | character varying(50) | FK | → `ext_validaciontipo.ilicode` |
| `observaciones_finales` | text |  |  |
| `audio_observaciones_url` | text |  |  |
| `fecha_validacion` | timestamp without time zone |  |  |

Índices:

- `idx_validacion_comunidad` — `INDEX idx_validacion_comunidad ON public.ext_validacion_comunitaria USING btree (comunidad_id)`

### `ext_transcripcion_respuesta`

| Columna | Tipo | Marcas | Referencia / nota |
|---|---|---|---|
| `id` | integer | PK NN |  |
| `comunidad_id` | integer | FK NN | → `tpc_interesado_comunidad.id` |
| `pregunta_clave` | character varying(80) | NN |  |
| `transcripcion` | text | NN |  |
| `valor_interpretado` | text |  |  |
| `fecha` | timestamp without time zone |  |  |

Índices:

- `idx_transcripcion_comunidad` — `INDEX idx_transcripcion_comunidad ON public.ext_transcripcion_respuesta USING btree (comunidad_id)`
- `idx_transcripcion_pregunta` — `INDEX idx_transcripcion_pregunta ON public.ext_transcripcion_respuesta USING btree (pregunta_clave)`

### `ext_foto_registro`

| Columna | Tipo | Marcas | Referencia / nota |
|---|---|---|---|
| `id` | integer | PK NN |  |
| `comunidad_id` | integer | FK NN | → `tpc_interesado_comunidad.id` |
| `predio_id` | integer | FK | → `tpc_predio.id` |
| `categoria` | character varying(60) | FK NN | → `ext_fotocategoria.ilicode` |
| `ruta_archivo` | text | NN |  |
| `descripcion` | text |  |  |
| `fecha` | timestamp without time zone |  |  |

Índices:

- `idx_foto_categoria` — `INDEX idx_foto_categoria ON public.ext_foto_registro USING btree (categoria)`
- `idx_foto_comunidad` — `INDEX idx_foto_comunidad ON public.ext_foto_registro USING btree (comunidad_id)`

## Operación del visor

### `geovisor_users`

| Columna | Tipo | Marcas | Referencia / nota |
|---|---|---|---|
| `id` | integer | PK NN |  |
| `username` | character varying(50) | U NN |  |
| `password_hash` | text | NN |  |
| `nombre` | character varying(100) |  |  |
| `rol` | character varying(20) |  |  |
| `activo` | boolean |  |  |
| `created_at` | timestamp without time zone |  |  |
| `last_login` | timestamp without time zone |  |  |

Índices:

- `geovisor_users_username_key` — `UNIQUE INDEX geovisor_users_username_key ON public.geovisor_users USING btree (username)`

---

## Catálogos de enumeración

Las enumeraciones del estándar se guardan como tablas, tal como manda LADM. Todas
tienen la misma forma: `t_id`, `ilicode` (el código del estándar), `dispname` (el texto
que ve la persona), `descripcion`, `es_extension`, `equivalente_ladm` y `activo`.

`[EXT]` marca los valores que no están en LADM-COL y que este proyecto añadió; el
resto son valores del estándar.

### `col_derechotipo`

COL_DerechoTipo — derecho que ejerce el interesado sobre la unidad administrativa básica.

Lo usa: `tpc_derecho.tipo_derecho`

- Propiedad_Colectiva
- Posesion_Ancestral
- Uso_Usufructo
- En_Proceso **[EXT]**
- Desconocido **[EXT]**

### `col_estructuratipo`

COL_EstructuraTipo — estructura geométrica con que se representa la unidad espacial.

Lo usa: `tpc_predio.estructura_geometrica`

- No_Poligono
- Poligono
- Topologia
- Malla

### `col_fuenteadministrativatipo`

COL_FuenteAdministrativaTipo — naturaleza jurídica del documento que sustenta el derecho.

Lo usa: `tpc_fuente_administrativa.tipo_fuente`

- Acto_Administrativo
- Escritura_Publica
- Sentencia_Judicial
- Documento_Publico
- Documento_Privado
- Sin_Documento **[EXT]**

### `col_fuenteespacialtipo`

COL_FuenteEspacialTipo — clase de insumo cartográfico del que proviene la geometría.

Lo usa: `tpc_fuente_espacial.tipo_fuente_espacial`

- Croquis_Campo
- Datos_Crudos
- Ortofoto
- Informe_Tecnico
- Registro_Fotografico
- Plano_Oficial **[EXT]**
- Sin_Mapa **[EXT]**

### `col_interpolaciontipo`

COL_InterpolacionTipo — forma en que se interpola el tramo entre dos puntos del lindero.

Lo usa: `col_cadenadelimite.interpolacion`, `col_punto.interpolacion`

- Ninguna
- Recta
- Curva
- Circular

### `col_metodoproducciontipo`

COL_MetodoProduccionTipo — cómo se determinó la posición de un objeto espacial.

Lo usa: `col_cadenadelimite.metodo_produccion`, `col_caraslindero.metodo_produccion`, `col_punto.metodo_produccion`, `tpc_fuente_espacial.metodo_produccion`, `tpc_predio.metodo_captura_perimetro`

- Metodo_Directo
- Metodo_Declarativo_y_Colaborativo
- Metodo_Indirecto
- Sin_Metodo **[EXT]**

### `col_puntotipo`

COL_PuntoTipo — función del punto dentro del levantamiento.

Lo usa: `col_punto.tipo_punto`

- Limite
- Levantamiento
- Control

### `col_restricciontipo`

COL_RestriccionTipo — restricciones y servidumbres que pesan sobre el territorio.

Lo usa: `tpc_restriccion.tipo_restriccion`

- Servidumbre
- Transito
- Aguas_Negras
- Aire
- Luz
- Agua
- Medianera
- Oleoducto
- Gasoducto
- Acueducto
- Alcantarillado
- Minera
- Energia_Electrica
- Legal_Hidrocarburos
- Oleoducto_Gasoducto **[EXT]**
- Acueducto_Alcantarillado **[EXT]**
- Ninguna **[EXT]**

### `ext_antiguedadtipo`

Antigüedad de la ocupación del territorio. Extensión propia (EXT_HistoriaTerritorio).

Lo usa: `ext_historia_territorio.antiguedad_territorio`, `tpc_interesado_familia.antiguedad_ocupacion`

- Desde_Siempre **[EXT]**
- Desde_Hace_Muchos_Anos **[EXT]**
- Desde_Fecha_Aproximada **[EXT]**
- Desconocida **[EXT]**

### `ext_fotocategoria`

Categoría de las fotografías adjuntas durante el registro. Extensión propia.

Lo usa: `ext_foto_registro.categoria`

- documento_legal **[EXT]**
- plano_mapa **[EXT]**
- limites_territorio **[EXT]**
- zonas_especiales **[EXT]**
- restriccion **[EXT]**
- territorio **[EXT]**
- comunidad_reunida **[EXT]**
- sin_categoria **[EXT]**

### `ext_limitestipo`

Elemento con que la comunidad describe sus linderos. Extensión propia.

Lo usa: `tpc_predio.limites_territorio`

- Rios **[EXT]**
- Montanas **[EXT]**
- Caminos **[EXT]**
- Hitos_Naturales **[EXT]**
- Documentos_Oficiales **[EXT]**
- Combinacion **[EXT]**

### `ext_reconocimientotipo`

Estado de reconocimiento del territorio por el Estado. Extensión propia.

Lo usa: `tpc_predio.reconocimiento_estado`

- Sí **[EXT]**
- No **[EXT]**
- No_Sabemos **[EXT]**

### `ext_usotipo`

Tipo de uso colectivo del territorio. Extensión propia (EXT_UsoTerritorio).

Lo usa: `ext_uso_territorio.tipo_uso`

- Uso_Colectivo **[EXT]**
- Uso_Tradicional **[EXT]**
- Zonas_Compartidas **[EXT]**
- Uso_Mixto **[EXT]**
- Vivienda **[EXT]**
- Cultivo **[EXT]**
- Vivienda_y_Cultivo **[EXT]**
- Ganaderia **[EXT]**
- Bosque_Conservacion **[EXT]**

### `ext_validaciontipo`

Estado de validación comunitaria del registro. Extensión propia (EXT_ValidacionComunitaria).

Lo usa: `ext_validacion_comunitaria.validado_por_comunidad`

- Validada_Asamblea **[EXT]**
- Revisada_Autoridades **[EXT]**
- Pendiente **[EXT]**

### `tpc_actoadministrativotipo`

TPC_ActoAdministrativoTipo — clase de acto administrativo que soporta la fuente.

Lo usa: `tpc_fuente_administrativa.tipo_acto_administrativo`, `tpc_representante_legal.tipo_acto_administrativo`

- Resolucion
- Acuerdo
- Decreto
- Sentencia
- Folio_Matricula **[EXT]**
- Sin_Documento **[EXT]**

### `tpc_cargotipo`

Cargo de la autoridad que representa a la comunidad. Extensión propia sobre COL_Interesado.

Lo usa: `tpc_representante_legal.cargo`

- Gobernador **[EXT]**
- Capitan **[EXT]**
- Cacique **[EXT]**
- Autoridad_Tradicional **[EXT]**
- Representante_Legal_CC **[EXT]**
- Otro **[EXT]**

### `tpc_comunidadtipo`

TPC_ComunidadTipo — tipo de comunidad o grupo étnico titular.

Lo usa: `tpc_interesado_comunidad.tipo_comunidad`

- Comunidad_Negra
- Comunidad_Indigena
- Cabildo
- Parcialidad
- Resguardo_Indigena
- Territorio_Colectivo

### `tpc_documentotipo`

TPC_DocumentoTipo — tipo de documento de identificación del interesado.

Lo usa: `tpc_interesado_familia.tipo_documento`, `tpc_representante_legal.tipo_documento`

- Cedula_Ciudadania
- Cedula_Extranjeria
- Tarjeta_Identidad
- Pasaporte
- NIT
- NUIP
- Secuencial

### `tpc_niveltenenciatipo`

Nivel en que se levantó la unidad espacial: el territorio colectivo completo o la parcela de una familia dentro de él. Extensión propia.

Lo usa: `tpc_predio.nivel_tenencia`

- Colectivo **[EXT]**
- Familiar **[EXT]**

### `tpc_organizacionfilialtipo`

Forma organizativa de la comunidad. Extensión propia.

Lo usa: `tpc_interesado_comunidad.tipo_organizacion_filial`

- Cabildo **[EXT]**
- Autoridades_Tradicionales **[EXT]**
- Asamblea_Comunitaria **[EXT]**
- Consejo_Comunitario **[EXT]**
- Otro **[EXT]**

### `tpc_origenasignaciontipo`

Cómo la familia llegó a ocupar su parcela dentro del territorio colectivo. Extensión propia.

Lo usa: `tpc_interesado_familia.origen_asignacion`

- Asignacion_Asamblea **[EXT]**
- Herencia_Familiar **[EXT]**
- Ocupacion_Antigua **[EXT]**
- Permuta_Interna **[EXT]**
- Desconocido **[EXT]**

### `tpc_procedimientotipo`

TPC_ProcedimientoTipo — procedimiento agrario por el que se constituye o modifica el territorio.

Lo usa: `tpc_territorio_propiedad_colectiva.tipo_procedimiento`

- Constitucion_ResguardosIndigenas
- Ampliacion_ResguardosIndigenas
- Ampliacion_Saneamiento_ResguardosIndigenas
- Reestructuracion_ResguardosIndigenas
- Conversion_Reservas_Resguardos
- Titulacion_Comunidades_Negras
- En_Proceso **[EXT]**

---

## Vistas

- **`vista_censo_comunidad`** — Compara la población que estimó la autoridad con la que suman las familias efectivamente registradas. La cobertura dice qué tanto del territorio se ha levantado casa por casa.
- **`vista_estadisticas`** — Resumen estadístico general: totales por tipo de comunidad, personas registradas y fechas.
- **`vista_ladm_cobertura`** — Una fila por clase del modelo: si la tabla existe y cuántos registros tiene. Distingue el núcleo del estándar de las extensiones propias de este trabajo.
- **`vista_lindero_detalle`** — Cada tramo del lindero con su método de producción y su longitud real en metros.
- **`vista_parcelas_familiares`** — Una fila por parcela familiar, con su hogar, su derecho de uso y su superficie medida.
- **`vista_predio_colectivo`** — tpc_predio sin las parcelas familiares. Es la que debe usar cualquier consulta que asuma un predio por comunidad.
- **`vista_registros_completos`** — Vista consolidada de todos los módulos. Una fila por comunidad registrada. Útil para reportes y exportaciones.
- **`vista_registros_geo`** — sin descripción registrada

## Funciones

- **`fn_actualizar_geom()`** — sin descripción registrada
- **`fn_calcular_area_perimetro()`** — sin descripción registrada
- **`fn_contar_filas(p_tabla text)`** — sin descripción registrada
- **`fn_crear_catalogo(p_nombre text, p_comentario text)`** — Crea una tabla de catálogo de enumeración con la estructura LADM/INTERLIS (t_id, ilicode, dispname, descripcion).
- **`fn_descomponer_nombre(p_completo text)`** — Separa un nombre completo en los cuatro campos que pide LADM, con la convención colombiana de dos apellidos al final.
- **`fn_generar_topologia_lindero(p_predio_id integer)`** — Descompone geom_perimetro en COL_Punto, COL_CadenaDeLimite y COL_CarasLindero, recorriendo el anillo exterior y los huecos. Devuelve cuántos vértices generó.
- **`fn_notify_nuevo_registro()`** — sin descripción registrada
- **`fn_objeto_versionado()`** — Completa los atributos de <<ObjetoVersionado>> (espacio de nombres, identificador local y comienzo de vigencia) en cada inserción.
- **`fn_resumen_registro(p_id integer)`** — Devuelve un resumen en pares campo/valor de un registro completo dado su ID.
- **`fn_sincronizar_agrupacion_espacial()`** — Mantiene COL_AgrupacionUnidadesEspaciales al día: cada parcela familiar entra como miembro de la agrupación de su territorio.
- **`fn_sincronizar_direccion()`** — sin descripción registrada
- **`fn_texto_a_fecha(p_texto text)`** — sin descripción registrada
- **`fn_trig_topologia_lindero()`** — sin descripción registrada
- **`fn_valor_catalogo(p_cat text, p_ilicode text, p_dispname text, p_desc text DEFAULT NULL::text, p_ext boolean DEFAULT false, p_equiv text DEFAULT NULL::text)`** — Inserta o actualiza un valor de enumeración. es_extension marca los valores propios, equivalente_ladm su correspondencia con el estándar.
- **`fn_vincular_catalogo(p_tabla text, p_columna text, p_catalogo text)`** — Crea la llave foránea de una columna hacia su catálogo, absorbiendo primero los valores heredados para que la migración no falle.

## Disparadores

- `trig_versionado` sobre `tpc_derecho`
- `trig_versionado` sobre `tpc_fuente_administrativa`
- `trig_versionado` sobre `tpc_fuente_espacial`
- `trig_notify_nuevo_registro` sobre `tpc_interesado_comunidad`
- `trig_versionado` sobre `tpc_interesado_comunidad`
- `trig_versionado` sobre `tpc_interesado_familia`
- `trig_actualizar_geom` sobre `tpc_predio`
- `trig_agrupacion_espacial` sobre `tpc_predio`
- `trig_calcular_area_perimetro` sobre `tpc_predio`
- `trig_sincronizar_direccion` sobre `tpc_predio`
- `trig_topologia_lindero` sobre `tpc_predio`
- `trig_versionado` sobre `tpc_predio`
- `trig_versionado` sobre `tpc_representante_legal`
- `trig_versionado` sobre `tpc_restriccion`
- `trig_versionado` sobre `tpc_territorio_propiedad_colectiva`
