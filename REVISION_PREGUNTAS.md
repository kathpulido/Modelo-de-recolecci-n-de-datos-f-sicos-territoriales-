# Revisión de las preguntas del chatbot frente a LADM-COL

Inventario de las 47 preguntas que hace hoy el chatbot, cuáles se pisan entre
sí, cuáles quedan fuera del modelo, y cómo LADM-COL representa el nivel
familiar dentro de un territorio colectivo.

---

## 1. Los tres nombres

Es el solapamiento que notaste. En realidad son **tres preguntas distintas
que caen en tres clases distintas** del modelo:

| Pregunta | Se guarda en | Clase LADM | Qué identifica |
|---|---|---|---|
| ¿Cuál es el nombre con el que se identifica su comunidad? | `tpc_interesado_comunidad.nombre_comunidad` | **COL_Interesado** | **quién** tiene el derecho |
| ¿Cuál es el nombre oficial del territorio o resguardo? | `tpc_territorio_propiedad_colectiva.nombre_territorio` | **COL_UnidadAdministrativaBasica** | **sobre qué** recae el derecho |
| ¿Cuál es el nombre del predio según documentos oficiales? | `tpc_predio.nombre_predio` | **TPC_Predio** | la parcela catastral |

Así que técnicamente ninguna sobra. Pero en la práctica colombiana la primera
y la segunda casi siempre coinciden — *"Resguardo Indígena de Cañamomo"* es a
la vez el nombre de la comunidad y del territorio — y la persona que responde
no tiene por qué saber que le están preguntando por dos objetos distintos del
modelo. Por eso se sienten repetidas.

**Cuál conviene conservar, si hubiera que elegir una:**

`nombre_comunidad` es la que **no se puede quitar**. En LADM el interesado es
el sujeto del derecho: sin nombre del interesado, la tripleta
*interesado — derecho — unidad administrativa* queda coja. El territorio, en
cambio, se identifica formalmente por su acto administrativo y su número
predial, no por su nombre.

**La más prescindible es la tercera.** `nombre_predio` no aporta nada que
`numero_predial` no haga mejor: LADM identifica el predio por el NUPRE, no
por un nombre. Y en territorios colectivos ese nombre casi siempre se
responde *"sin nombre"*.

**Recomendación:** conservar las dos primeras pero redactar la segunda de
modo que la diferencia se vea, y permitir heredar la respuesta:

> 📛 Ya registré la comunidad como *Consejo Comunitario La Esperanza*.
> ¿El **territorio** tiene un nombre oficial distinto — el que aparece en la
> resolución o el título?
> Si es el mismo, responda *el mismo*.

Y quitar la tercera, o dejarla solo cuando la persona dijo que sí tiene
documento oficial.

---

## 2. Otros solapamientos reales

### 2.1 `reconocimiento_estado` duplica el acto administrativo — y se contradice

Hoy se pregunta dos veces lo mismo por caminos distintos:

- *¿El territorio ha sido reconocido oficialmente por el Estado?* → Sí / No / No sabemos
- *¿Existe algún documento oficial que reconozca el territorio?* → Resolución / Acuerdo / Decreto / …

La segunda **ya contesta la primera**: si hay una resolución con número y
fecha, el territorio está reconocido. Peor aún, nada impide que alguien
responda *"No está reconocido"* y tres preguntas después dicte el número de
la resolución que lo reconoce — y las dos respuestas contradictorias quedan
guardadas.

Además `reconocimiento_estado` no corresponde a ninguna clase LADM: es un
campo propio en `tpc_predio`.

**Recomendación:** dejar de preguntarla y derivarla. Si
`tipo_acto_administrativo` es distinto de `Sin_Documento`, el territorio está
reconocido. Eso elimina una pregunta y elimina la posibilidad de
contradicción.

### 2.2 Los cuatro números de población

| Pregunta | Columna |
|---|---|
| ¿Cuántas familias viven aproximadamente en el territorio? | `numero_familias` |
| ¿Cuántas personas viven aproximadamente en el territorio? | `numero_personas` |
| ¿Cuántas son mujeres? | `numero_mujeres` |
| ¿Y cuántos son hombres? | `numero_hombres` |

Tres problemas:

1. **Ninguna está en LADM-COL.** El modelo describe derechos sobre la tierra,
   no demografía. Son extensiones propias, legítimas, pero conviene decirlo.
2. **`mujeres + hombres` debería dar `personas`, y nadie lo verifica.** Hoy se
   pueden guardar 180 personas, 90 mujeres y 200 hombres sin que el sistema
   diga nada.
3. **Son una estimación.** Como bien dices, muchas veces la autoridad no tiene
   un censo real.

Esto conecta directamente con lo siguiente.

### 2.3 Dos que se quedaron cortas

- **`limites_territorio`** (*¿Cómo describe su comunidad los límites?* →
  Ríos / Montañas / Caminos…) guarda **una sola respuesta para todo el
  perímetro**. Pero desde la migración LADM existe
  `col_cadenadelimite.descripcion_lindero`, que permite decir que *este* tramo
  sigue el río y *aquel otro* la carretera. La pregunta actual es la versión
  aplanada de algo que el modelo ya sabe guardar con detalle.

- **`zonas_especiales`** es un Sí/No sin seguimiento. Si responden que sí,
  no se pregunta cuáles ni dónde, así que el dato no sirve para nada salvo
  saber que existen. O se completa, o no vale la pena preguntarla.

---

## 3. La propuesta: dos niveles de levantamiento

Tienes toda la razón en que el croquis puede ser dos cosas muy distintas: el
lindero de todo el territorio colectivo, o la parcela que una familia ocupa
dentro de él. Hoy el sistema no distingue, y eso es una pérdida real de
información.

### 3.1 Cómo lo modela LADM-COL

Esto **no requiere salirse del modelo** — al contrario, es exactamente para lo
que existen las clases que ya agregamos y que hoy están vacías.

En un territorio colectivo el título es *inalienable, imprescriptible e
inembargable*: las familias **no son propietarias** de su parcela. Tienen un
**derecho de uso o usufructo asignado por la autoridad de la comunidad**,
regido por el reglamento interno. Esa distinción jurídica es precisamente la
que LADM sabe representar:

| Nivel | Interesado | Derecho (COL_DRR) | Unidad |
|---|---|---|---|
| **Colectivo** | La comunidad | `Propiedad_Colectiva` | El territorio completo |
| **Familiar** | La familia | `Uso_Usufructo` | La parcela, **dentro** del territorio |

Es la misma tripleta *interesado — derecho — unidad administrativa*, aplicada
dos veces en dos niveles. La jerarquía entre las dos unidades espaciales es lo
que guarda `COL_AgrupacionUnidadesEspaciales`, con su `nivel_jerarquico` y su
`agrupacion_padre_id` — la clase que creamos en la migración y que hasta ahora
no tenía para qué llenarse.

La familia como interesado colectivo es `COL_AgrupacionInteresados` con
`col_miembros`, también ya creada.

### 3.2 Qué pregunta va a cada nivel

**Solo colectivo** — se preguntan una vez, para todo el territorio:

nombre de la comunidad · tipo de comunidad · pueblo · forma de organización ·
representante legal (nombre, cargo, documento, legitimidad, teléfono) ·
historia y antigüedad · nombre del territorio · tipo de procedimiento ·
número predial · área del acto administrativo · tipo de derecho colectivo ·
acto administrativo (tipo, número, fecha) · restricciones y servidumbres ·
reglas internas · validación comunitaria

**Solo familiar** — se repiten por cada familia:

nombre de la familia o del jefe/jefa de hogar · documento · **cuántas
personas viven en esa familia, cuántas mujeres y cuántos hombres** · desde
cuándo ocupa ese lugar · con qué figura lo ocupa (asignación de la asamblea,
herencia familiar, posesión antigua) · uso de la parcela (vivienda, cultivo,
ambos)

**En los dos, según el nivel que se esté levantando:**

la ubicación GPS · **el croquis o el recorrido** · las fotos · la descripción
del lindero

### 3.3 El censo deja de ser una estimación

Esta es la parte que más te sirve para la tesis.

Hoy `numero_personas` es un número que la autoridad estima. Si además se
registran las familias una por una, la suma de sus integrantes es un **censo
medido**, no declarado. Quedan los dos valores, y la diferencia entre ellos es
un dato en sí mismo.

Es exactamente el mismo patrón que ya tienes con el área: el modelo guarda
`area_acto_administrativo` (lo que dice el documento) junto a
`area_real_ha` (lo que mide el polígono en PostGIS), y compararlas es parte
del análisis. Aplicar esa misma dualidad *declarado vs. medido* a la población
—y no solo a la superficie— es un argumento metodológico sólido y propio.

### 3.4 Qué habría que cambiar en la base

Poco, y todo dentro del modelo:

1. `tpc_predio.predio_matriz_id` — autorreferencia, para que la parcela
   familiar cuelgue del territorio colectivo.
2. `tpc_predio.nivel_tenencia` — `Colectivo` o `Familiar`.
3. `tpc_derecho.predio_id` — hoy el derecho se ata solo a la comunidad, no a
   una unidad concreta. En LADM el DRR conecta interesado **con una unidad
   administrativa básica**, así que este campo faltaba de todos modos.
4. Una tabla de grupo familiar, o reutilizar `col_agrupacioninteresados` con
   `tipo = 'Familia'` — que ya existe.

Ninguna clase nueva fuera del estándar.

---

## 4. Qué se hizo con cada una

Todo lo de esta lista quedó aplicado.

| # | Pregunta | Qué se hizo |
|---|---|---|
| 1 | `nombre_predio` | **Se movió al módulo 7**, después de saber que existe un documento. Antes se le pedía a todo el mundo el nombre que figura en un papel que la mayoría no tiene |
| 2 | `nombre_territorio` | **Reescrita**: recuerda el nombre que ya se anotó de la comunidad y pregunta solo por la diferencia. Se puede responder *el mismo* |
| 3 | `reconocimiento_estado` | **Quitada.** Se deriva del acto administrativo en `saveToDatabase` |
| 4 | `zonas_especiales` | **Quitada**, conservando la foto que venía después — una foto con descripción captura más que aquel sí o no |
| 5 | `limites_territorio` | **Se conserva** como resumen del perímetro. El detalle por tramo vive en `col_cadenadelimite.descripcion_lindero`, disponible desde la migración LADM |
| 6 | Población | **Las dos cifras conviven**: la estimación de la autoridad y la suma de los hogares registrados, en `vista_censo_comunidad` |
| 7 | Nivel familiar | **Implementado.** Ver la sección 3 |

### Lo que apareció al hacerlo

Tres cosas que no estaban en el diagnóstico y salieron al tocar el código:

- **La lista de actos administrativos mentía.** El texto de la pregunta
  estaba escrito a mano con cuatro opciones cuando el catálogo ya tenía
  seis. Quien respondía «3» creía estar diciendo *folio de matrícula* y se
  guardaba *decreto*. Ahora la lista se arma sola desde las opciones reales.

- **Se pedía el número y la fecha de un documento que acababan de decir que
  no existe.** Ahora, si responden que no hay documento oficial, el bot lo
  reconoce y salta directo a ofrecer que fotografíen lo que sí tengan —un
  acta de asamblea, una solicitud radicada— porque aunque no sea un acto
  administrativo, es lo que sostiene su reclamación.

- **«Ninguno» no se entendía como ausencia de dato.** En las preguntas
  opcionales (corregimiento, número predial, teléfono, nombre del predio)
  se guardaba la palabra *ninguno* como si fuera el nombre. Se separó en un
  helper propio, `sinDatoQueDar`, y no en `esNegacion`: esa otra significa
  «no, se equivocó» dentro del ciclo de confirmación, donde *ninguna* sí es
  una respuesta legítima —la pregunta de restricciones tiene justamente esa
  opción— y mezclarlas habría hecho que confirmar «Ninguna» se leyera como
  un rechazo.
