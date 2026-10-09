# Cobertura del perfil LADM-COL: qué faltaba y qué se cerró

Comparación entre el modelo de referencia LADM-COL y lo que hoy existe en la
base de datos y en el chatbot. Verificado directamente sobre `src/app.ts` y
los archivos `.sql`, no sobre la documentación.

La primera versión de este documento era solo el diagnóstico. Esta versión
incluye lo que se hizo después: `migrate_ladm.sql` cierra la mayoría de los
vacíos, y el chatbot ahora llena los campos que antes quedaban en blanco.

**Estado en una consulta:**

```sql
SELECT * FROM vista_ladm_cobertura;
```

Una fila por clase del modelo, diciendo si la tabla existe y cuántos
registros tiene.

---

## 1. Vacíos que se cerraron

### 1.1 `tpc_fuente_administrativa` nunca recibía datos — **resuelto**

Era el único hallazgo que rompía la coherencia del modelo ya implementado.
La tabla existía, pero `saveToDatabase` nunca insertaba en ella: el tipo de
acto administrativo, su número y su fecha se guardaban dentro de
`tpc_representante_legal`, como si fueran atributos de la persona.

En LADM-COL el acto administrativo es una **fuente** que sustenta el
derecho. Con el dato en el lugar equivocado, la cadena
`COL_Fuente → COL_DRR → COL_UnidadAdministrativaBasica` quedaba rota y el
visor no podía responder qué documento respalda cada territorio.

Ahora:

- El acto se inserta en `tpc_fuente_administrativa`, con `tipo_fuente`
  derivado del tipo de acto (un folio de matrícula es un documento público,
  no un acto administrativo; una sentencia es una fuente judicial).
- La tabla asociativa nueva **`col_rrrfuente`** enlaza esa fuente con el
  derecho y, si existe, con la restricción. Esa es la asociación que cierra
  la cadena.
- La ficha del visor trae ahora `fuentes_administrativas`.
- Se sigue guardando también en `tpc_representante_legal` para no romper el
  visor ni las vistas que ya lo consultaban de allá.

### 1.2 Datos que se declaraban pero nunca se preguntaban — **resuelto**

| Campo | Tabla | Cómo se llena ahora |
|---|---|---|
| `corregimiento` | `tpc_predio` | Pregunta propia después de la vereda (opcional: se responde *no*) |
| `numero_predial` | `tpc_predio` | Pregunta propia en el módulo 4 (opcional) |
| `telefono` | `tpc_representante_legal` | Pregunta propia al final del módulo 2 (opcional) |
| `tipo_documento` | `tpc_representante_legal` | Pregunta nueva antes del número de documento |

Antes la pregunta de ubicación decía "vereda o corregimiento" y mezclaba dos
niveles administrativos distintos en un solo campo. Ahora son dos preguntas
y dos columnas, como pide el modelo.

Las tres opcionales se saltan respondiendo *no*: en territorio rural exigir
un número predial que casi nadie tiene a mano detendría el registro.

`observaciones_plano` sigue sin llenarse. Es el único de la lista original
que quedó pendiente, y es menor.

### 1.3 Valores de enumeración que faltaban — **resuelto**

Los cuatro valores que impedían registrar situaciones reales ya están, tanto
en el catálogo como entre las opciones del chatbot:

| Enumeración | Valor agregado | Por qué importaba |
|---|---|---|
| `TPC_ProcedimientoTipo` | **Constitucion_ResguardosIndigenas** | Una comunidad en proceso de constituir su resguardo no tenía opción correcta |
| `TPC_ComunidadTipo` | **Comunidad_Indigena** | El modelo la distingue de *Cabildo* y *Resguardo* |
| `TPC_ActoAdministrativoTipo` | **Decreto** y **Sentencia** | Varias titulaciones colectivas se formalizaron así |
| `TPC_DocumentoTipo` | La enumeración completa | Se guardaba el número sin decir de qué documento era |

**Vocabulario alineado.** Los valores propios se tradujeron a los nombres
del estándar, y los datos ya guardados se migraron:

| Antes | Ahora |
|---|---|
| `croquis_manual` | `Metodo_Declarativo_y_Colaborativo` |
| `recorrido_gps` | `Metodo_Directo` |
| `no_capturado` | `Sin_Metodo` |
| `Mapa_Comunitario` | `Croquis_Campo` |

`Croquis_Campo` del estándar describe exactamente lo que produce el croquis
del chatbot, así que la traducción no es una aproximación: es el nombre
correcto.

Las páginas de captura y `tpc_captura_perimetro_pendiente` conservan a
propósito los nombres viejos. Son una cola técnica entre el navegador y el
bot, no clases del modelo; la traducción ocurre en el único punto donde el
dato pasa a ser un registro definitivo.

**`TPC_RestriccionTipo`.** El modelo lista catorce restricciones y la
implementación las había agrupado en seis. Ahora el catálogo tiene los
catorce, y el chatbot ofrece cada una por separado: oleoducto y gasoducto ya
no van juntos, ni acueducto con alcantarillado. Los dos valores agrupados
siguen siendo válidos, marcados como extensión y con su equivalencia
anotada, para no reinterpretar los registros hechos antes.

### 1.4 Enumeraciones como texto libre — **resuelto**

Este no estaba en el diagnóstico original y resultó ser el cambio de mayor
peso estructural.

Las enumeraciones vivían como columnas `VARCHAR` con un comentario al lado.
Nada impedía guardar un valor inexistente y no había forma de consultar
desde SQL qué valores son válidos. En LADM-COL cada `<<enumeration>>` se
materializa como una **tabla de catálogo**.

Ahora hay **20 catálogos** con la estructura que genera el modelo oficial
(`t_id`, `ilicode`, `dispname`, `descripcion`) más dos columnas propias:

- `es_extension` — si el valor es del estándar o propio de este trabajo.
- `equivalente_ladm` — a qué valor del estándar corresponde, cuando es propio.

Cada columna quedó con **llave foránea** hacia su catálogo. Un valor
inventado ya no entra:

```
ERROR: insert or update on table "tpc_derecho" violates foreign key
       constraint "fk_tpc_derecho_tipo_derecho"
DETAIL: Key (tipo_derecho)=(Valor_Inventado) is not present in
        table "col_derechotipo".
```

---

## 2. Clases del modelo que se implementaron

### 2.1 Topología del lindero — **resuelto**, y era la brecha más grande

El modelo descompone el límite en tres clases: **`COL_Punto`**,
**`COL_CadenaDeLimite`** y **`COL_CarasLindero`**. La implementación
guardaba el polígono completo pero no los vértices ni los tramos como
entidades propias. No se podía decir que *este* vértice se tomó con GPS y
*aquel otro* se declaró sobre el croquis, ni registrar la precisión punto
por punto.

Las tres clases existen ahora, y se llenan solas: un disparador sobre
`geom_perimetro` llama a `fn_generar_topologia_lindero`, que descompone el
polígono en sus vértices, sus tramos y su cara. Ni el chatbot ni las páginas
de captura tuvieron que cambiar para esto, y la topología se generó también
para los territorios que ya estaban guardados.

Lo que más importa: **la exactitud de cada vértice es un dato medido, no una
estimación**. Cuando el perímetro se caminó con GPS, la traza cruda trae la
precisión que reportó el receptor en cada lectura, y cada vértice hereda la
de la lectura más cercana. El croquis dibujado sobre el mapa queda con
exactitud nula, porque no tiene ninguna que declarar y ponerle un número
sería inventarlo.

La consulta que antes era imposible:

```sql
SELECT tramo, longitud_m, metodo_legible FROM vista_lindero_detalle;
```

```
 tramo | longitud_m |          metodo_legible
-------+------------+----------------------------------
     1 |     3308.2 | Método directo
     2 |     3496.3 | Método directo
```

Si alguien corrige el polígono, la topología se rehace; si lo borra, se
retira. No quedan vértices colgando de un lindero que ya no existe.

### 2.2 Agrupaciones — **resuelto**

- **`COL_AgrupacionInteresados`** y la clase asociativa **`col_miembros`**,
  para que varias comunidades compartan un mismo territorio. La
  participación se guarda como numerador y denominador, porque el estándar
  la define como una fracción; el decimal se calcula solo.
- **`COL_AgrupacionUnidadesEspaciales`**, con jerarquía y punto de
  referencia, para territorios compuestos por varios polígonos — lo normal
  cuando un resguardo tiene sectores discontinuos.

Las tablas existen y están listas; el chatbot todavía asume una comunidad
por territorio, así que se llenan a mano cuando haga falta.

### 2.3 Identificación y vigencia (`<<ObjetoVersionado>>`) — **resuelto**

Toda instancia del núcleo LADM lleva identificación (espacio de nombres +
identificador local) y vigencia (inicio y fin de versión). Es lo que permite
conservar el histórico en vez de sobrescribirlo.

Las ocho clases del núcleo tienen ahora `espacio_de_nombres`, `local_id`,
`comienzo_vida_util_version` y `fin_vida_util_version`, y un disparador los
completa en cada inserción sin que el chatbot tenga que ocuparse.

### 2.4 Atributos registrales de `TPC_Predio` — **columnas creadas**

`Matricula_Inmobiliaria`, `Codigo_ORIP`, `NUPRE`, `Numero_Predial_Anterior`,
`Codigo_Homologado`, `Codigo_Homologado_FMI`, `Interrelacionado`,
`Area_Reconstruccion`, `Responsable_Reconstruccion`, `Codigo_Reconstruccion`
y `Rango_Tolerancia` ya existen como columnas.

No se preguntan por WhatsApp: son datos de la Superintendencia de Notariado
y Registro, no de la comunidad. Quedan disponibles para cuando el registro
se cruce con el catastro oficial.

### 2.5 Nombre del representante — **resuelto**

`primer_nombre`, `segundo_nombre`, `primer_apellido` y `segundo_apellido` se
llenan con `fn_descomponer_nombre`, que aplica la convención colombiana de
dos apellidos al final. `nombres_autoridades` se conserva con el texto tal
como lo dictó la persona, porque la separación automática no es infalible.

### 2.6 Otras clases — **parcial**

- **`ExtDireccion`**: creada y poblada con la ubicación de cada predio.
- **`COL_UEFuente`**: creada; enlaza cada geometría con el insumo
  cartográfico que la produjo.
- Pendientes: `ExtInteresado` (huella, fotografía, firma), `ExtArchivo`,
  `ExtUnidadEdificacionFisica`, y los tipos estructurados `COL_AreaValor`,
  `COL_VolumenValor`, `COL_Transformacion`, `CC_MetodoOperacion`.

---

## 3. Qué queda pendiente

Poco, y todo defendible como delimitación del alcance:

1. **`observaciones_plano`** sigue sin llenarse.
2. **Las agrupaciones no se capturan por el chatbot.** Las tablas están; la
   conversación todavía asume una comunidad por territorio. Preguntar por
   territorios compartidos exigiría un módulo completo.
3. **Los atributos registrales no se preguntan**, por la razón dicha arriba.
4. **La descripción tramo por tramo del lindero** (`descripcion_lindero` en
   `col_cadenadelimite`) está vacía. La estructura permite registrar que un
   tramo sigue un río y otro un camino; capturarlo pediría recorrer el
   lindero pregunta por pregunta.
5. **Los tipos estructurados** de la sección 2.6.

---

## 4. Balance

De las clases del modelo de referencia, la implementación cubre ahora:

**Núcleo LADM completo** — la tripleta *interesado — derecho — unidad
administrativa*, más las fuentes, la unidad espacial y, desde esta
migración, **la topología del lindero y las asociaciones que las conectan**:

`COL_Interesado` con sus dos especializaciones · `COL_DRR` con derecho y
restricción · `COL_UnidadAdministrativaBasica` con predio y territorio ·
`COL_Fuente` con sus ramas administrativa y espacial · `COL_UnidadEspacial`
y `TPC_Terreno` con geometría real en PostGIS · `COL_Punto`,
`COL_CadenaDeLimite` y `COL_CarasLindero` · las dos agrupaciones ·
`RRRFuente` y `UEFuente`.

**Más seis clases propias** que el estándar no contempla, para registrar el
*proceso* de captura: historia narrada, uso del territorio, validación
comunitaria, transcripción de respuestas habladas, fotografías y captura del
perímetro. Todas marcadas como extensión en los catálogos, no confundidas
con el estándar.

Lo que sostiene el argumento de conformidad no es la lista de tablas, sino
que las llaves foráneas la hacen cumplir: la base ya no acepta un valor que
el modelo no contemple.
