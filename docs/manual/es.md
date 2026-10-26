---
title: SonicRoom — manual para usuarios de lector de pantalla
subtitle: Cómo configurar tu lector de pantalla, cómo funciona el teclado y todos los atajos
lang: es
---

# Lee esto antes que nada

**SonicRoom es una aplicación, no una página web.**

Esa sola frase explica casi todos los problemas con los que se topa la gente.
SonicRoom se ejecuta en un navegador, pero nada dentro de ella se comporta como
un artículo que se lee. No hay un documento por el que desplazarse. Hay barras de
herramientas, listas y diálogos, y se manejan como se maneja un programa de
escritorio: **el tabulador se mueve entre las partes y las flechas se mueven
dentro de cada parte**.

Los lectores de pantalla no saben esto por sí solos. Tal como vienen de fábrica,
NVDA, JAWS, el Narrador y Orca ponen delante de ti una _copia virtual_ de la
página e interceptan tus teclas, de modo que la `H` salta a un encabezado y la
`B` salta a un botón. Eso está muy bien en un periódico y muy mal aquí, porque en
SonicRoom la `M` silencia tu micrófono, la `R` inicia una grabación y la `W` te
dice quién ha estado hablando. Si tu lector de pantalla se traga esas teclas,
nunca llegarán a la aplicación.

Así que lo primero, antes de entrar en ninguna sala, es poner el lector de
pantalla en el modo en que la aplicación recibe las pulsaciones. Cada lector lo
llama de una manera. La sección siguiente explica cómo.

Si solo recuerdas una cosa, que sea esta: **cuando una letra suelta no hace nada,
estás en el modo equivocado.**

---

# Configurar tu lector de pantalla

## NVDA

NVDA llama a los dos modos **modo exploración** y **modo foco**.

- El modo exploración es el modo de lectura. Las letras sueltas son órdenes de
  navegación y nunca llegan a la página.
- El modo foco pasa cada pulsación directamente a la aplicación. Este es el modo
  que SonicRoom necesita.

**Se alterna con `NVDA` + `Espacio`.** Oirás un sonido grave y corto al entrar en
modo foco, y otro más agudo al volver al modo exploración. Algunas voces además
dicen «modo foco» y «modo exploración» en voz alta.

NVDA ya pasa solo a modo foco cuando aterrizas en un cuadro de edición o en un
control parecido, así que a menudo estarás en modo foco sin pedirlo. Lo que
**no** hará por sí solo es cambiar cuando estás sobre un botón normal — y ese es
justamente el momento en que quieres pulsar `M` o `R`. Pulsa `NVDA` + `Espacio` y
quédate en modo foco durante toda la llamada.

Si quieres que NVDA sea más decidido, abre **menú de NVDA → Preferencias →
Opciones → Modo exploración** (o pulsa `NVDA` + `Control` + `B`) y activa _Modo
foco automático al cambiar el foco_ y _Modo foco automático al mover el cursor_.

## JAWS

JAWS llama a su modo de lectura **cursor virtual** (a veces «cursor virtual de
PC») y a su modo de paso **modo formularios**.

**Lo recomendable en SonicRoom es desactivar el cursor virtual del todo: pulsa
`tecla JAWS` + `Z`** (la tecla JAWS es `Insert` de forma predeterminada, o
`Bloq Mayús` en la distribución de portátil). JAWS dirá «cursor virtual de PC
desactivado». A partir de ahí, todas las teclas que pulses van a SonicRoom.

También _puedes_ confiar en el modo formularios automático — JAWS entra en modo
formularios al pulsar `Enter` sobre un control y sale con el `+` del teclado
numérico. Funciona, pero aquí te complica la vida por dos motivos: las órdenes de
una sola letra de SonicRoom no están asociadas a controles de formulario, así que
el modo formularios automático no se activará para ellas; y SonicRoom usa
`Escape` para cosas de verdad (cerrar el chat, cerrar un diálogo, detener un
archivo que está sonando), tecla que el modo formularios puede interceptar.

Desactivar el cursor virtual con `tecla JAWS` + `Z` evita los dos problemas.
Vuelve a pulsarlo para recuperar el cursor virtual al salir de la llamada.

## Narrador (Windows)

El Narrador llama a su modo de lectura **modo de exploración** (_Scan Mode_).
**Desactívalo** con `Bloq Mayús` + `Espacio`. El Narrador dirá «exploración
desactivada». Con el modo de exploración desactivado, el tabulador y las flechas
se comportan como describe este manual y las letras sueltas llegan a la
aplicación.

## VoiceOver (macOS)

La trampa equivalente en VoiceOver es la **Navegación rápida**. Con la navegación
rápida activada, las flechas son órdenes de VoiceOver y nunca llegan a la página.

**Desactívala pulsando a la vez las flechas izquierda y derecha.** VoiceOver dirá
«Navegación rápida desactivada».

Después de eso:

- `Tab` y `Mayús` + `Tab` se mueven entre las partes de la aplicación.
- Las flechas se mueven dentro de una barra de herramientas o de una lista, tal
  como se describe más abajo.
- Las letras sueltas (`M`, `A`, `R`, `W`…) llegan a SonicRoom siempre que el foco
  del teclado no esté dentro de un campo de texto.

`VO` en los atajos significa `Control` + `Opción`. Puede que necesites
`VO` + `Mayús` + `Flecha abajo` para interactuar con el grupo de contenido web
antes de que VoiceOver siga el foco dentro de la aplicación.

## Orca (Linux)

Orca tiene **modo navegación** y **modo foco** en el contenido web, igual que
NVDA. Orca cambia solo a modo foco en los controles de formulario; para cambiar a
mano, pulsa `modificador de Orca` + `A` (el modificador de Orca es `Insert` en la
distribución de escritorio y `Bloq Mayús` en la de portátil).

## iPhone, iPad y Android

SonicRoom funciona con VoiceOver y TalkBack, y todos los botones, listas y
diálogos están etiquetados. Los atajos de una sola letra necesitan un teclado
físico, así que en una pantalla táctil usa los botones: todo lo que hace un atajo
tiene un botón en la barra de herramientas o en la lista de participantes.

Dos cosas se comportan distinto en iOS: Safari no puede mostrar el vídeo a
pantalla completa (la aplicación lo dice en voz alta en lugar de dejar un botón
muerto), y el motor de audio solo arranca después de que toques la pantalla una
vez, algo de lo que SonicRoom se encarga en tu primer toque.

## Una prueba de diez segundos

Entra en una sala tú solo, asegúrate de que el foco **no** está en el cuadro de
chat y pulsa `M`. Si oyes el sonido de silencio y «Micrófono silenciado», estás
listo. Si tu lector de pantalla dice algo sobre un encabezado, una lista o «no
hay siguiente elemento», sigues en el modo de lectura: vuelve atrás y cámbialo.

---

# Cómo funciona el teclado en toda la aplicación

Tres reglas cubren la aplicación entera.

**1. El tabulador se mueve entre partes. Las flechas se mueven dentro de una
parte.**

Una barra de herramientas de once botones es **una sola** parada del tabulador,
no once. Una lista de veinte participantes es una sola parada. Esto es a
propósito: significa que puedes recorrer toda la aplicación en cinco o seis
pulsaciones de tabulador en lugar de cuarenta, y es como han funcionado siempre
las aplicaciones de escritorio. También significa que pulsar el tabulador dentro
de una barra de herramientas **no** te lleva al botón siguiente: eso lo hace la
`Flecha derecha`.

**2. Barras de herramientas: `Flecha izquierda` y `Flecha derecha`.**

SonicRoom tiene dos barras de herramientas, ambas al final de la llamada: los
controles de audio (siempre) y los controles de vídeo (solo en videollamadas).
Dentro de cualquiera de las dos:

| Tecla               | Hace                                                     |
| ------------------- | -------------------------------------------------------- |
| `Flecha derecha`    | Botón siguiente (vuelve al primero al llegar al final)   |
| `Flecha izquierda`  | Botón anterior (vuelve al último al llegar al principio) |
| `Inicio`            | Primer botón                                             |
| `Fin`               | Último botón                                             |
| `Enter` o `Espacio` | Pulsar el botón en el que estás                          |
| `Tab`               | Salir de la barra de herramientas                        |

**3. Listas: `Flecha arriba` y `Flecha abajo`, y luego `Enter`.**

La lista de participantes, el historial de chat, la lista de salas públicas del
vestíbulo y el explorador de archivos del servidor son todas listas del mismo
estilo:

| Tecla                            | Hace                                                                             |
| -------------------------------- | -------------------------------------------------------------------------------- |
| `Flecha abajo` / `Flecha arriba` | Elemento siguiente / anterior                                                    |
| `Inicio` / `Fin`                 | Primer / último elemento                                                         |
| `Enter` o `Espacio`              | Abrir o activar el elemento                                                      |
| `Escape` o `Retroceso`           | Volver un nivel (en las opciones de participante y en el explorador de archivos) |

Tu lector de pantalla anuncia cada elemento a medida que llegas a él, junto con
su estado: silenciado, hablando, compartiendo vídeo, etc.

**Los deslizadores** (tu nivel de micrófono, el volumen de otra persona) están
dentro de la lista de opciones de participante. Sobre un deslizador, la `Flecha
izquierda` y la `Flecha derecha` cambian el valor y dicen el porcentaje nuevo;
`Inicio` y `Fin` saltan al mínimo y al máximo. Las flechas arriba y abajo
conservan su función habitual de pasar a la opción siguiente.

**`Escape` cierra cosas.** El panel de chat, los ajustes de audio, los ajustes de
retransmisión, el selector de origen de audio, el cuadro de la clave de API, el
reproductor de archivo y la pantalla completa de vídeo se cierran todos con
`Escape`, y el foco vuelve al control desde el que los abriste. La única
excepción es el diálogo de «alguien quiere entrar», que hay que responder.

---

# El vestíbulo

El vestíbulo es la primera pantalla. Es un formulario corriente, así que puedes
leerlo en modo exploración si lo prefieres, pero la lista de salas públicas
necesita las flechas, con lo que el modo foco sigue siendo más cómodo.

En orden, de arriba abajo:

1. **Idioma** — un cuadro combinado. Cambiarlo reetiqueta todo al momento, en el
   vestíbulo y en una llamada, sin recargar nada.
2. **Nombre de la sala** — letras, números, guiones y guiones bajos, hasta 64
   caracteres. Cualquier otra cosa se descarta mientras escribes. Si todavía no
   hay nadie en una sala con ese nombre, al escribirlo la creas.
3. **Tipo de sala** — dos botones de opción, **Llamada de audio** y
   **Videollamada**. El audio es siempre lo predeterminado. Se elige con las
   flechas. Esta decisión es permanente durante toda la vida de la sala, y decide
   si las cámaras existen siquiera.
4. **Fondo de vídeo** — solo aparece si has elegido _Videollamada_. Véase
   [Videollamadas](#videollamadas).
5. **Nombre visible** — el nombre que oirán todos cuando entres, hables o envíes
   un mensaje.
6. **Salas públicas** — una lista de las salas abiertas a cualquiera en este
   momento, con quién está en cada una. Solo aparece si hay al menos una. Llega
   con las flechas a una sala y pulsa `Enter` para que su nombre se rellene
   solo; el foco vuelve al nombre visible para que solo tengas que escribir tu
   nombre.
7. **Nivel de micrófono** — un botón **Probar**, un deslizador de **nivel de
   micrófono** y un medidor de nivel en vivo. Pulsa Probar y te oirás a ti mismo
   (usa auriculares); tu lector de pantalla te avisará cuando el nivel pase entre
   _silencio_, _bajo_, _bueno_ y _alto_. Sube el deslizador hasta que diga bueno.
   Ese nivel se lleva a la llamada. Merece la pena hacerlo una vez: muchísimos
   micrófonos de portátil suenan demasiado bajos de fábrica.
8. **Desactivar P2P** — una casilla. Con dos personas, SonicRoom os conecta
   normalmente de forma directa. Marca esto para pasar siempre por el servidor.
   Casi nadie lo necesita.
9. **Hacer pública esta sala** — una casilla. Aparece en la lista pública y activa
   las reglas de llamar a la puerta y de votación para expulsar que se describen
   más abajo. En cuanto alguien hace pública una sala, sigue siéndolo hasta que
   se vaya todo el mundo; desmarcarlo después no lo deshace.
10. **Entrar sin micrófono** — una casilla. Escuchas y usas el chat de texto, y
    el navegador nunca pide permiso para el micrófono. Si no tienes micrófono, o
    rechazas el permiso, acabas en este modo de todas formas.
11. **Entrar en la sala** — el botón de envío. También vale pulsar `Enter` desde
    cualquiera de los campos de texto.

**El formulario es más corto cuando la sala ya existe.** El tipo de sala, los
ajustes de P2P y de sala pública y las opciones de administración son de quien
la crea. Por eso, en cuanto el nombre del campo es el de una sala que está
abierta ahora mismo — lo hayas escrito, elegido en la lista pública o hayas
llegado por un enlace —, el vestíbulo deja solo lo que te toca a ti cambiar: tu
nombre visible, la prueba de micrófono, _Entrar sin micrófono_, el fondo de vídeo
si es una videollamada y el botón de entrar. Tu lector de pantalla lo dice en el
momento («Has puesto una sala que ya existe, …: vas a unirte a ella. Ocultando
las opciones de sala.»), y la misma explicación queda bajo el campo del nombre
de la sala, de modo que se vuelve a leer cada vez que llegas a él. Cambia el
nombre por uno que no use nadie y las opciones vuelven, también con aviso. El
vestíbulo lo comprueba un instante después de que dejes de escribir y lo sigue
comprobando mientras estás en la página, así que el formulario también puede
cambiar solo si entretanto la sala se abre o se queda vacía. Una
[sala reservada](#salas-reservadas-una-sala-que-te-han-dado-de-antemano) que su anfitrión aún no ha abierto se
comporta igual: ahí no hay nada que te toque elegir, simplemente esperarás al
anfitrión.

---

# La sala, parte por parte

## Cabecera

Dice el nombre de la sala y el nombre de esta instancia de SonicRoom, después las
etiquetas que correspondan — **VÍDEO** en una videollamada, **REC** mientras se
graba la llamada, **LIVE** mientras se retransmite hacia fuera —, después el
número de personas presentes, después el botón de **chat** (que además lleva en
su nombre el número de mensajes sin leer) y por último el cuadro combinado de
idioma.

## Lista de participantes

El corazón de la aplicación. Es **una** lista que contiene **primero a ti y
después a los demás**, y luego una fila por cada cosa adicional que se envía a la
sala: un emisor de música, el audio de una pantalla compartida, un archivo que
alguien está emitiendo, un micrófono adicional.

Cada fila se lee como el nombre de la persona seguido de lo que sea cierto en ese
momento, por ejemplo:

> Ana (tú), silenciado, compartiendo vídeo, pulsa Enter para abrir las opciones
> de este participante

Los fragmentos que puedes oír son: _tú_, _solo texto_ (entró sin micrófono),
_silenciado_, _hablando_, _compartiendo vídeo_, _compartiendo pantalla_,
_fijado_, _silenciado por ti_, y un recuento de votos cuando hay una votación en
marcha para expulsar a esa persona.

Pulsa `Enter` sobre una fila para abrir las opciones de esa persona. Eso
sustituye la lista por una segunda lista, y `Escape` o `Retroceso` te devuelve.

## Opciones de participante

Lo que encuentras aquí depende de la fila que hayas abierto.

**En tu propia fila:**

- **Tu nivel de micrófono** — un deslizador. `Izquierda`/`Derecha` para cambiar,
  `Inicio`/`Fin` para el mínimo y el máximo. Es una ganancia que se aplica antes
  de que tu voz salga de tu equipo, así que cambia lo que oye todo el mundo.
- **Describir mi vídeo** y **Fijar mi vídeo** — solo en videollamadas.

**En la fila de otra persona:**

- **Volumen de _nombre_** — un deslizador. Solo cambia lo que oyes _tú_.
- **Silenciar a _nombre_ para mí** / **Dejar de silenciar a _nombre_ para mí** —
  la calla solo para ti. A esa persona no se le dice nada. La etiqueta cambia
  para decir qué hará la próxima pulsación.
- **Fijar el vídeo de _nombre_** / **Fijar la pantalla de _nombre_** — solo en
  videollamadas, y es puramente un cambio en tu propia pantalla; a la persona que
  fijas nunca se le dice.
- **Describir el vídeo de _nombre_** / **Describir la pantalla de _nombre_** —
  solo en videollamadas. Véase [Videollamadas](#videollamadas).
- **Expulsar a _nombre_** — solo en salas públicas con tres o más personas. Véase
  [Salas públicas, llamar a la puerta y votar](#salas-públicas-llamar-a-la-puerta-y-votar).
- **Expulsar emisor** — quita una fuente que está emitiendo música.
- **Detener esta transmisión** — detiene un archivo compartido, el audio de una
  pantalla compartida o un micrófono adicional.

## Panel de chat

Se abre con el botón de chat de la cabecera. El panel está dispuesto con **el
historial primero y el cuadro de mensaje después**, a propósito, para que
aterrices en lo que se ha dicho y no en un campo de edición vacío.

- La lista de mensajes es una lista: `Arriba`/`Abajo`, `Inicio`/`Fin`.
- `Control` + `C` (o `Cmd` + `C`) sobre un mensaje lo copia.
- En el cuadro de mensaje, `Enter` envía y `Mayús` + `Enter` hace un salto de
  línea.
- **Anunciar mensajes nuevos** es un cuadro combinado en la cabecera del panel
  con cuatro opciones: _Cortés_ (se dice cuando tu lector de pantalla haga la
  siguiente pausa), _Asertivo_ (interrumpe), _En voz alta_ (la voz del propio
  navegador, para quien no usa lector de pantalla) y _Desactivado_.
- `Escape` cierra el panel y devuelve el foco al botón de chat.

No hace falta que dejes el panel abierto. Todo lo que ocurre en la sala se
escribe también en el historial de chat además de decirse en voz alta, y `Alt`
más un número lo relee desde donde estés — véase
[Enterarte de lo que pasa](#enterarte-de-lo-que-pasa).

## La barra de controles de audio

Al final de la ventana. Una sola parada del tabulador;
`Izquierda`/`Derecha` para recorrerla. En orden:

| Botón                    | Atajo       | Qué hace                                                                                                                         |
| ------------------------ | ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Silenciar micrófono      | `M`         | Te silencia y te vuelve a activar. Desactivado, pero legible, si entraste sin micrófono.                                         |
| Compartir audio          | `A`         | Comparte el sonido de una pantalla o de una pestaña. El navegador pregunta cuál, y hay que marcar su casilla de compartir audio. |
| Emitir audio             | `F`         | Abre el selector de origen: un archivo de tu ordenador, un enlace o un archivo guardado en el servidor.                          |
| Atenuado automático      | `D`         | Activa o desactiva la bajada automática de la música cuando alguien habla, **para toda la sala**.                                |
| Grabar llamada           | `R`         | Inicia y detiene una grabación de todos en el servidor.                                                                          |
| Descargar                | —           | Aparece cuando existe una grabación. Descarga toda la llamada mezclada.                                                          |
| Pistas                   | —           | Aparece cuando existe una grabación. Descarga un zip con un archivo por persona, alineados y rellenados a la misma duración.     |
| Retransmisión en directo | —           | Abre el panel donde escribes los datos de un servidor Icecast y empiezas a retransmitir la llamada hacia fuera.                  |
| Quién habla              | `W`         | Dice quién habla ahora o ha hablado hace poco, numerados.                                                                        |
| Notas compartidas        | `Alt` + `N` | Abre el bloc de notas compartido de esta sala en una pestaña nueva. Solo está si esta instancia tiene la función configurada.    |
| Ajustes de audio         | —           | Selectores de micrófono y altavoces, procesamiento de voz, voz de alta fidelidad, micrófonos adicionales.                        |
| Salir                    | —           | Sale de la llamada y vuelve al vestíbulo.                                                                                        |

## Pie de página

Un enlace al proyecto SonicRoom y el enlace a este manual.

---

# Todos los atajos de teclado

Funcionan en cualquier punto de la llamada **siempre que el foco del teclado no
esté dentro de un cuadro de texto** y tu lector de pantalla esté dejando pasar
las teclas. Dejan de funcionar mientras hay abierto un diálogo de «alguien quiere
entrar», porque ese diálogo hay que responderlo primero.

## Letras sueltas

| Tecla | Acción                                                          |
| ----- | --------------------------------------------------------------- |
| `M`   | Silenciar / activar tu micrófono                                |
| `A`   | Empezar / dejar de compartir el audio de una pantalla o pestaña |
| `F`   | Abrir el selector de «Emitir audio»                             |
| `D`   | Atenuado automático activado / desactivado para toda la sala    |
| `R`   | Iniciar / detener la grabación                                  |
| `W`   | Quién habla: anuncia a quienes han hablado hace poco, numerados |
| `V`   | Cámara activada / desactivada — **solo en videollamadas**       |
| `E`   | Vídeo a pantalla completa — **solo en videollamadas**           |

`V` y `E` no hacen nada en una llamada de audio, así que esas letras quedan
libres allí.

## Con Alt

En un Mac, `Alt` es la tecla **Opción** (la que está junto a Comando): todo lo
de abajo funciona igual con ella, y allí la aplicación llama «Opción» a estos
atajos.

| Tecla                                      | Acción                                                                                   |
| ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `Alt` + `1` … `Alt` + `9`                  | Lee los últimos mensajes en voz alta. `1` es el más reciente, `2` el anterior, y así.    |
| `Alt` + `0`                                | Lee el décimo mensaje más reciente.                                                      |
| El mismo `Alt` + número dos veces seguidas | Copia ese mensaje al portapapeles.                                                       |
| `Alt` + `N`                                | Abre las notas compartidas de la sala en una pestaña nueva.                              |
| `Ctrl` + `Mayús` + `M`                     | Silencia los micrófonos de todos: **solo en salas moderadas**, y solo si tienes permiso. |

La relectura con `Alt` + número es el único conjunto de atajos que **también
funciona mientras escribes en el cuadro de chat**, y funciona esté el panel
abierto o cerrado. Lee las teclas numéricas físicas, así que le da igual que uses
AZERTY, Dvorak o cualquier otra distribución.

## Navegación y cierre

| Tecla                   | Acción                                                    |
| ----------------------- | --------------------------------------------------------- |
| `Tab` / `Mayús` + `Tab` | Entre las partes de la aplicación                         |
| `Izquierda` / `Derecha` | Recorrer una barra de herramientas; cambiar un deslizador |
| `Arriba` / `Abajo`      | Recorrer una lista                                        |
| `Inicio` / `Fin`        | Primero / último; mínimo / máximo                         |
| `Enter` / `Espacio`     | Activar lo que tienes delante                             |
| `Escape`                | Cerrar el panel, el diálogo o la pantalla completa        |
| `Retroceso`             | Salir de las opciones; subir una carpeta                  |
| `Enter`                 | Enviar un mensaje de chat                                 |
| `Mayús` + `Enter`       | Salto de línea en un mensaje                              |
| `Control` / `Cmd` + `C` | Copiar el mensaje en el que estás                         |

---

# Enterarte de lo que pasa

SonicRoom está construido en torno a una regla: **todo lo que se le dice a la
sala se puede volver a leer después.**

Cada suceso de la sala — alguien ha entrado, ha
empezado una grabación, ha empezado a sonar un archivo, han expulsado a alguien —
se dice por una región activa _y además_ se escribe en el historial del chat como
mensaje del sistema. Nada se anuncia una vez y se pierde. Si tu lector de
pantalla estaba ocupado, o estabas escribiendo, o simplemente se te escapó, pulsa
`Alt` + `1` y recorre el historial hacia atrás.

Tres cosas se dicen pero a propósito _no_ se escriben en el chat, porque afectan a
tu vista y no a la sala: tus cambios de volumen locales, silenciar a alguien solo
para ti, y fijar un vídeo. Nadie más se ve afectado, así que no pintan nada en una
línea de tiempo compartida.

**Que otra persona se silencie o se active es un sonido, no una frase.** En una
sala con gente la tecla de silencio no para quieta, y «fulanito ha silenciado su
micrófono» una y otra vez entierra todo lo que merece la pena oír. Así que cuando
otra persona se silencia o se activa oyes el aviso corto de silencio o de
activación y no se dice nada; su fila en la lista de participantes sigue leyéndose
«silenciado», y `W` te sigue diciendo quién habla. Que un administrador silencie a
alguien _para toda la sala_ es otra cosa: eso sí es un suceso de la sala, se dice y
se escribe en el chat, con el nombre de quien lo ha hecho.

**Señales sonoras.** Suenan avisos cortos al silenciar y activar el micrófono, al
entrar o salir alguien, al llegar un mensaje de chat, al empezar o terminar una
compartición, cuando alguien llama a la puerta y cuando una cámara se enciende o
se apaga. Son locales — la sala no los oye nunca — y están diseñados para
distinguirse del habla.

**«Quién habla» (`W`).** Las voces van y vienen y un lector de pantalla no puede
seguirlas. Pulsa `W` y SonicRoom nombra a quienes hablan ahora o han hablado hace
poco, numerados: «1. Ana, 2. Luis, 3. Marta», del más reciente al más antiguo. Los
mismos números aparecen un momento en sus fichas, así que quien esté a tu lado ve
la misma lista.

---

# Hablar y escuchar

**Silénciate** con `M`, o con el primer botón de la barra. El silencio afecta
solo a tu voz. Si además estás emitiendo un archivo, compartiendo el audio de una
pantalla o usando micrófonos adicionales, todo eso sigue sonando: se detiene
deteniéndolo, no silenciándote.

**Tu propio nivel** es el deslizador de tu fila en la lista de participantes, y
también el del vestíbulo. Súbelo si te dicen que se te oye poco.

**El nivel de otra persona** es el deslizador de _su_ fila en la lista de
participantes. Ese solo cambia lo que oyes tú.

**El atenuado automático (`D`)** hace que la música baje sola cuando alguien
habla y vuelva a subir cuando calla. Viene activado y es un ajuste de toda la
sala, así que desactivarlo lo desactiva para todos. Se anuncia en ambos sentidos.

**Ajustes de audio** (el engranaje de la barra) contiene:

- **Micrófono** y **Altavoces** — cuadros combinados de dispositivo. Los cambios
  se aplican al momento, en mitad de la llamada, y se recuerdan. Los nombres de
  los dispositivos solo aparecen cuando has concedido permiso para el micrófono.
- **Procesamiento de voz** — cancelación de eco, supresión de ruido y nivelado
  automático. Activado de forma predeterminada. Desactívalo si estás enviando
  música o tocando un instrumento, porque te va a estorbar.
- **Voz de alta fidelidad (estéreo)** — envía estéreo a más bitrate. Desactivado
  de forma predeterminada, porque la mayoría de los micrófonos son mono y le
  cuesta ancho de banda a todos los demás. Se aplica a tu **siguiente** llamada,
  no a la que estás.
- **Micrófonos adicionales para emitir** — una lista de casillas, una por cada
  dispositivo de entrada que tengas aparte del micrófono principal, cada una con
  un par de botones de opción **Mono** / **Estéreo**. Marca uno y se envía a la
  sala como una transmisión propia, junto a tu voz, apareciendo como una fila
  propia en la lista de participantes de todo el mundo. Así es como se manda una
  mesa de mezclas, un instrumento o un cable de audio virtual. Silenciarte no los
  silencia; para pararlos, desmárcalos.

---

# Meter audio en la sala

## Audio de pantalla o pestaña (`A`)

Pulsa `A` y el navegador abre su propio selector — un diálogo del sistema, no de
SonicRoom, así que tu lector de pantalla lo trata como una ventana aparte. Elige
una pantalla, ventana o pestaña **y marca la casilla que comparte su audio**; sin
esa casilla la compartición va muda. Chrome y Edge son los que mejor lo hacen; el
soporte de Firefox para compartir el audio del sistema es limitado o inexistente
según la plataforma.

El audio compartido se salta el procesamiento y el limitador de tu micrófono,
para que la música conserve su dinámica. En una llamada de audio la imagen se
descarta y solo se envía el sonido. `A` otra vez lo detiene.

## Un archivo, un enlace o un archivo del servidor (`F`)

`F` abre el diálogo **Emitir audio**, que ofrece tres orígenes:

- **Elegir del ordenador** — un selector de archivos.
- **URL de audio** — un cuadro de edición. Pega cualquier enlace público: un MP3
  directo, una radio por internet o una página de un sitio de vídeo o de música,
  de la que el servidor extrae el audio por ti.
- **Archivos del servidor** — un árbol de carpetas de audio guardado en el
  servidor, que puedes explorar. Recórrelo con las flechas, `Enter` en una
  carpeta para entrar, `Enter` en un archivo para reproducirlo, `Retroceso` para
  subir una carpeta. Los nombres largos se recortan visualmente pero se leen
  enteros.

En cuanto algo suena aparece una ventanita de **Emisión de archivo** y el foco
cae en su botón de reproducir/pausar, así que `Espacio` pausa al instante. También
tiene un deslizador de **tu volumen**, que solo cambia tu propia escucha — la
sala oye siempre el archivo a nivel completo — y un botón de parar. `Escape` en
cualquier punto de esa ventana detiene la emisión y la cierra.

Pulsar `F` otra vez mientras algo suena vuelve a abrir el selector y te deja
cambiar de origen sin reiniciar la emisión.

---

# Grabar y retransmitir en directo

**La grabación (`R`)** se hace en el servidor, así que captura a todo el mundo a
plena calidad independientemente de lo que haga tu equipo. Empezar y parar se
anuncia a toda la sala y aparece una etiqueta **REC** en la cabecera: a nadie se
le graba sin decírselo.

En cuanto existe una grabación aparecen dos botones más en la barra:

- **Descargar** — toda la llamada mezclada en un archivo. Puedes pulsarlo con la
  grabación todavía en marcha: descarga todo lo grabado hasta ese momento y la
  grabación continúa.
- **Pistas** — un zip con un archivo por persona, cada uno rellenado y alineado
  en el tiempo para que cuadren al soltarlos en un editor de audio.

En una videollamada, la descarga de la llamada entera es un archivo de vídeo con
las cámaras y las pantallas de todos en una cuadrícula; en una llamada de audio
es un archivo de audio, como siempre.

**La retransmisión en directo** (el botón de radio de la barra) envía toda la
llamada mezclada a un servidor Icecast que indiques tú. El panel pide servidor,
puerto, punto de montaje, usuario, contraseña, formato y bitrate, y los recuerda
en este navegador. Esos datos no se le enseñan nunca al resto de la sala: lo
único que reciben es una etiqueta **LIVE** y el aviso de que ha empezado la
retransmisión, y de quién.

---

# Videollamadas

Una sala es una videollamada solo si se creó como tal — el botón de opción
**Videollamada** del vestíbulo, que después ya no se puede deshacer. En una
llamada de audio nada de esto existe: ni cámara, ni `V`, ni `E`, y compartir tu
pantalla sigue enviando solo su sonido.

**Todo el mundo entra con la cámara apagada**, siempre. Nada enciende tu cámara
salvo tú.

- **`V`** enciende y apaga tu cámara. Se le dice a todo el mundo, en voz alta y
  en el historial del chat.
- **`E`** hace que el área de vídeo ocupe la pantalla; `E` otra vez o `Escape`
  sale. Se anuncia en los dos sentidos. En Safari de iOS, que no tiene pantalla
  completa para elementos de la página, SonicRoom lo dice en lugar de no hacer
  nada.
- **Fijar** hace que una cámara o una pantalla ocupe el área de vídeo solo para
  ti. Está en las opciones de cada participante («Fijar el vídeo de _nombre_»),
  no se comunica a nadie, y a la persona que fijas no se le dice. Si apaga su
  cámara, la fijación se mantiene y espera: se te avisa de que está esperando, y
  se te avisa otra vez cuando la imagen vuelve.

**La guía para centrar la cara** es el botón que hay junto al de la cámara,
activado de forma predeterminada. Mientras tu cámara está encendida, SonicRoom
observa tu propia imagen y dice correcciones cortas — «muévete a tu derecha»,
«muévete hacia arriba», «estás centrado», «tu cara no se ve en el encuadre» — en
una región activa asertiva, para que interrumpan en lugar de hacer cola. Las
direcciones se dan desde tu punto de vista, no desde el de la imagen. Repite la
misma indicación cada tres segundos mientras siga siendo válida, dice «centrado»
una vez cuando lo consigues, y se calla. Desactívala con el mismo botón cuando
hayas terminado de colocarte.

**«Describir el vídeo de _nombre_»** está en las opciones de cada participante,
incluida la tuya. Toma un solo fotograma y le pide a Claude que lo describa en
unas frases, leyendo el texto que se vea, en el idioma en que tengas la interfaz.
La descripción se registra en el chat como todo lo demás, así que `Alt` + `1` la
vuelve a leer.

Para esto hace falta **tu propia clave de API de Claude**, que se introduce con el
botón de la llave de la barra de vídeo. Se guarda solo en este navegador y la
petición va de tu navegador directamente a Claude: nunca pasa por el servidor de
SonicRoom.

**Los fondos de vídeo** se eligen en el **vestíbulo**, bajo el botón de opción
_Videollamada_, y nunca dentro de la llamada — así la imagen queda decidida antes
de enviar nada. Las opciones son sin fondo, desenfoque, una de seis imágenes
incluidas, o una imagen tuya. Todo se hace dentro de tu navegador, así que la
sala solo recibe la imagen ya compuesta y nunca tu entorno real. Si tu navegador
no puede hacerlo, SonicRoom lo dice en voz alta y envía tu cámara tal cual en
lugar de fallar en silencio.

---

# Salas públicas, llamar a la puerta y votar

**En las salas normales de SonicRoom no hay moderadores ni dueños.** Nadie
puede expulsar a nadie por su cuenta. A cambio, las salas públicas tienen dos
reglas colectivas. (Las **salas moderadas**, con administradores, son otra cosa:
véase el capítulo siguiente.)

**Llamar a la puerta.** Cuando una sala es pública y alguien nuevo pide entrar,
todos los que ya están dentro oyen unos golpes y reciben un diálogo con el nombre
de esa persona y los botones **Permitir** y **Rechazar** (y **Permitir a todos** /
**Rechazar a todos** cuando hay varios esperando). El foco va directo al primer
botón Permitir, y el tabulador da vueltas dentro del diálogo. No se puede cerrar
con `Escape`: es el único diálogo que hay que responder. Puede responderlo
cualquiera; vale la primera respuesta. Rechazar a alguien también le impide
volver a esa sala.

Mientras tanto, quien llama oye «Esperando a que alguien de la sala te deje
entrar…» y tiene un botón de cancelar.

**Votar para expulsar.** Solo en salas públicas, y solo con **tres o más
personas** presentes. Por debajo de tres la opción ni se ofrece, así que nunca
puede usarla una persona contra otra. El umbral es _al menos la mitad_, contando
a la persona afectada: 2 votos de 3, 2 de 4, 3 de 5.

La opción está en la lista de opciones de cada participante. Su nombre lleva el
recuento en marcha — «Expulsar a Ana (2 votos)» — y cada voto y cada retirada se
anuncia a toda la sala, con nombres. Elegirla otra vez retira tu voto. Como el
umbral depende de cuánta gente hay, que alguien se vaya puede ser justo lo que
haga que una votación ya iniciada llegue al límite.

---

# Salas moderadas (con administradores)

Además de las salas privadas y públicas, que no tienen moderadores, puedes
crear una **sala moderada**: una sala con **administradores**, pensada para
tertulias y programas con presentador, donde alguien tiene que poder silenciar
a quien se ha olvidado de mutearse o expulsar a un trol al instante. Todo lo
que sigue solo existe en este tipo de sala; una sala normal no cambia en nada.

**Crearla.** En el vestíbulo, marca la casilla **«Opciones de
administrador»**. Se despliega un grupo llamado **«Privilegios de
participantes»** con una casilla («Permitir varios administradores») y una
lista desplegable por cada acción: grabar, compartir audio, emitir audio,
activar o desactivar el atenuado automático, retransmitir en directo, aprobar la
entrada de nuevos participantes, usar el chat, abrir las notas compartidas,
silenciar a un participante para todos, silenciar los micrófonos de todos y
expulsar. En cada una eliges **Solo
administradores**, **Todos** o **Nadie** (expulsar añade **con votación**). La
última casilla oculta el enlace «Con tecnología de SonicRoom» dentro de la sala.
Estas opciones se fijan al crear la sala y no cambian mientras exista; el
navegador recuerda tu última configuración para la próxima vez.

**Quién es administrador.** Quien crea la sala. Si has permitido varios
administradores, en las opciones de cualquier participante encontrarás
**«Nombrar administrador»** (y **«Quitar administrador»** para deshacerlo). Los
administradores llevan la palabra «administrador» en su fila de la lista. Si te
recargas o pierdes la conexión, recuperas el cargo al volver.

**Si se van todos los administradores** y queda gente dentro, la sala **deja de
estar moderada**: se anuncia a todo el mundo («El último administrador se ha
ido: esta sala ya no está moderada»), a todos les vuelven todos los botones, el
chat se reabre y la sala sigue como una sala privada o pública normal el resto
de su vida. No se nombra a nadie en su lugar, y un antiguo administrador que
vuelva entra como participante normal. Si quieres que la sala sobreviva a tu
ausencia con sus reglas intactas, nombra a un segundo administrador antes de
irte.

**La puerta.** En una sala moderada **siempre** se llama a la puerta, sea
pública o no. La opción «Aprobar la entrada de nuevos participantes» decide
quién oye los golpes y recibe el diálogo de Permitir / Rechazar: solo los
administradores, o todos. Los administradores entran sin llamar.

**Silenciar a alguien para todos.** En las opciones del participante:
**«Silenciar para todos»**. Su micrófono se corta para toda la sala y se le
anuncia quién lo ha hecho. Es un silencio _suave_: la persona puede volver a
activar su micrófono con `M` cuando vaya a hablar (así se resuelve el clásico
«se te oye hablar con la vecina» sin pedir la palabra). En la barra de
controles, quien tenga permiso ve además **«Silenciar los micrófonos de
todos»**, que hace lo mismo con todos los demás de golpe. Su atajo es `Ctrl` +
`Mayús` + `M`: una combinación de tres teclas a propósito, para que no se pulse
por error al lado de la `M`. Solo existe en una sala moderada; en las demás esa
combinación se la queda el navegador.

**Expulsar.** Según la opción elegida: los administradores (o todos) expulsan
directamente desde las opciones del participante con **«Expulsar de la sala»**,
sin votación; o bien se vota como en una sala pública (con **al menos tres**
votantes con derecho a voto; si solo votan los administradores, cuentan solo
ellos). Nadie puede expulsarse a sí mismo. A un administrador solo puede
silenciarlo o expulsarlo otro administrador.

**Lo que no te dejan hacer, no aparece.** Si tu papel no permite grabar,
compartir o emitir audio, cambiar el atenuado, retransmitir o escribir en el
chat, ese botón no está en la barra y la letra correspondiente (`R`, `A`, `F`,
`D`) responde «No puedes hacer eso en esta sala». El panel de chat sigue
abriéndose aunque no puedas escribir, porque ahí siguen quedando todos los
avisos. Lo mismo vale para los botones **Descargar** y **Pistas** de una
grabación: solo aparecen a quien tiene permiso para grabar — los demás oyen
igualmente que la llamada se está grabando y ven el distintivo **REC**, pero
nunca se les entrega el archivo. A quien nombran administrador mientras existe
una grabación reservada a administradores se le avisa de que ya puede
descargarla.

La sala lleva la insignia **MOD** en la cabecera, y al entrar se anuncia que es
moderada y quiénes son los administradores. Todos los cambios (nombramientos,
silencios, expulsiones) se anuncian y quedan en el chat.

## Salas reservadas (una sala que te han dado de antemano)

Normalmente una sala solo existe mientras hay alguien dentro, y la crea quien
llega primero. Eso es un problema cuando anuncias un enlace con antelación:
cualquiera podría abrir «tu» sala antes que tú y convertirse en su
administrador, o la sala moderada podría desaparecer sin más en cuanto se
vacíe. Una **sala reservada** lo resuelve. El operador de la instancia reserva
un nombre de sala para ti y te da **dos enlaces**:

- el **enlace de anfitrión**, que contiene una clave secreta. Guárdalo para ti;
  quien abre la sala con él es su **administrador**, siempre, incluso después
  de salir y volver;
- el **enlace público**, la dirección normal de la sala, que es el que anuncias.

Hasta que abras la sala con el enlace de anfitrión, quien siga el enlace
público oye «Esta sala está reservada y su anfitrión aún no la ha abierto» y
espera en esa pantalla; entra automáticamente en cuanto llegas (y entonces
llama a la puerta como cualquiera que entra en una sala moderada, así que tú
decides quién pasa). Una sala reservada es siempre una sala moderada, con los
privilegios de participante que el operador fijó al reservarla, y **sigue
siendo moderada** mientras no estás: nadie puede quedársela, y vuelves como su
administrador.

Tu navegador recuerda la clave en esa pestaña, así que puedes recargar la
página o pasar por el vestíbulo para poner tu nombre sin perderla, y se quita
de la barra de direcciones al momento para que un enlace copiado nunca la
lleve. Si pierdes el enlace de anfitrión, pide al operador uno nuevo (el
antiguo deja de funcionar).

---

# Notas compartidas

Si esta instancia de SonicRoom tiene las notas configuradas, la barra tiene un
botón de **Notas compartidas** y `Alt` + `N` hace lo mismo. Abre un único bloc de
notas colaborativo para la sala **en una pestaña nueva del navegador** — nunca en
un marco dentro de la llamada, así que tu lector de pantalla se encuentra con un
documento editable normal y corriente.

La primera pulsación crea la nota; la de todos los demás abre la misma, y el
hecho de que exista se anuncia y se registra en el chat con el enlace. Vuelve a la
pestaña de SonicRoom y la llamada sigue en marcha.

---

# Opciones que puedes poner en la barra de direcciones

Todo lo que va después de `?` en un enlace de sala fija una opción, y se pueden
combinar varias con `&`.

| Opción             | Efecto                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| `?displayName=Ana` | Entra con este nombre, saltándose el vestíbulo                                                      |
| `?video=on`        | La convierte en videollamada                                                                        |
| `?public=true`     | Hace pública la sala                                                                                |
| `?mic=off`         | Entra sin micrófono: solo escuchar y chat                                                           |
| `?p2p=off`         | Pasa siempre por el servidor, incluso con dos personas                                              |
| `?lang=es`         | Fuerza el idioma de la interfaz (`en`, `es`, `fr`)                                                  |
| `?ios=on`          | Fuerza la ruta de audio de iOS en cualquier navegador (un apaño para problemas de audio tercos)     |
| `?host=…`          | Abre una sala reservada como su anfitrión (ver «Salas reservadas»); se quita de la barra al momento |

Por ejemplo, un enlace que mete a alguien directamente en una videollamada en
francés como «Ana»:

```
https://tu-instancia.example/room/estudio?video=on&lang=fr&displayName=Ana
```

---

# Cuando algo no funciona

**Una letra suelta no escribe nada y no hace nada.**
Tu lector de pantalla está en modo de lectura y se come la tecla. `NVDA` +
`Espacio`, `tecla JAWS` + `Z`, `Bloq Mayús` + `Espacio` para el Narrador, o
desactiva la navegación rápida en VoiceOver. Este es con diferencia el problema
más frecuente.

**La letra aparece escrita en el cuadro de chat.**
El foco está en el cuadro de mensaje. Es a propósito: tienes que poder escribir la
letra M en un mensaje. Pulsa `Escape` para cerrar el chat, o sal del cuadro con el
tabulador, y vuelve a intentarlo. `Alt` + número es el único atajo que sigue
funcionando desde dentro del cuadro.

**El tabulador no me lleva al botón siguiente de la barra.**
No es su función. La barra entera es una sola parada; usa la `Flecha derecha`. El
tabulador sale de la barra.

**`Alt` + un número dice «No hay mensaje 1».**
Todavía no se ha dicho nada en la sala. Los sucesos de sala cuentan como
mensajes, así que la primera entrada de alguien ya lo llena.

**No oigo a nadie.**
Comprueba el cuadro combinado de **Altavoces** en los ajustes de audio: los
navegadores no siempre siguen el dispositivo predeterminado del sistema.
Comprueba después que no has silenciado a esa persona para ti: su fila diría
«silenciado por ti».

**Me dicen que se me oye muy bajo.**
Sube **tu nivel de micrófono** en tu propia fila de la lista de participantes, o
usa el botón Probar del vestíbulo, que va diciendo la banda de nivel mientras
ajustas.

**Mi micrófono adicional no ha arrancado.**
SonicRoom pide exactamente ese dispositivo en lugar de aceptar un sustituto, así
que si lo está usando otro programa o está desconectado, falla en vez de enviar
dos veces tu micrófono principal sin avisar. Cierra lo que esté ocupando el
dispositivo y vuelve a marcarlo.

**Comparto una pantalla y no va sonido.**
No se marcó la casilla de audio en el diálogo de compartir del propio navegador.
Ese diálogo es del navegador, no de SonicRoom. Prueba con Chrome o Edge si el
tuyo ni siquiera ofrece la opción.

**«Describir vídeo» dice que añada una clave de API.**
Esa función usa tu propia clave de API de Claude, que se introduce con el botón de
la llave de la barra de vídeo. Se guarda solo en este navegador.

---

# Referencia rápida de teclas

| Tecla                                     | Acción                                                        |
| ----------------------------------------- | ------------------------------------------------------------- |
| `M`                                       | Silenciar / activar micrófono                                 |
| `A`                                       | Compartir / dejar de compartir el audio de pantalla o pestaña |
| `F`                                       | Emitir audio: abre el selector de origen                      |
| `D`                                       | Atenuado automático (toda la sala)                            |
| `R`                                       | Iniciar / detener grabación                                   |
| `W`                                       | Quién habla                                                   |
| `V`                                       | Cámara (videollamadas)                                        |
| `E`                                       | Vídeo a pantalla completa (videollamadas)                     |
| `Alt` + `1`…`9`, `0`                      | Leer los diez últimos mensajes, del más nuevo al más viejo    |
| El mismo `Alt` + número dos veces         | Copiar ese mensaje                                            |
| `Alt` + `N`                               | Notas compartidas en una pestaña nueva                        |
| `Ctrl` + `Mayús` + `M`                    | Silenciar a todos (salas moderadas)                           |
| `Tab` / `Mayús` + `Tab`                   | Entre las partes de la aplicación                             |
| `Izquierda` / `Derecha`                   | Recorrer una barra; cambiar un deslizador                     |
| `Arriba` / `Abajo`                        | Recorrer una lista                                            |
| `Inicio` / `Fin`                          | Primero / último; mínimo / máximo                             |
| `Enter` / `Espacio`                       | Activar                                                       |
| `Escape`                                  | Cerrar panel, diálogo o pantalla completa                     |
| `Retroceso`                               | Salir de las opciones; subir una carpeta                      |
| `Enter` en el cuadro de mensaje           | Enviar                                                        |
| `Mayús` + `Enter` en el cuadro de mensaje | Salto de línea                                                |
| `Control` / `Cmd` + `C` sobre un mensaje  | Copiarlo                                                      |
| `NVDA` + `Espacio`                        | NVDA: modo exploración ↔ modo foco                            |
| `tecla JAWS` + `Z`                        | JAWS: cursor virtual desactivado / activado                   |
| `Bloq Mayús` + `Espacio`                  | Narrador: modo de exploración desactivado / activado          |
| `Izquierda` + `Derecha` a la vez          | VoiceOver: navegación rápida desactivada / activada           |
| `modificador de Orca` + `A`               | Orca: modo navegación ↔ modo foco                             |
