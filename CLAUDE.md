# Consulta 0KM — Contexto del proyecto para Claude Code

## Qué es

Módulo independiente para que los **vendedores de Tito Gonzalez Automotores (TGA)** carguen consultas de mejora de precio de 0km, con pre-análisis automático que replica la planilla manual de Fer. A futuro lo va a integrar Mati en el CRM.

Producción: https://consulta0km.titogonzalez.online (GitHub Pages + dominio custom vía 4 registros A en Donweb).

## Stack

- HTML único `index.html` (~2000 líneas), vanilla JS + CSS inline, sin build/framework.
- Supabase REST directa con fetch (sin SDK). Project: `wjfglsafgaltusmbnccl`.
- Edge Function `notify-whatsapp-consulta` (en `supabase/functions/`) → Meta WhatsApp Cloud API con templates aprobados.
- Repo **público** (`fergonz00/consulta-0km`, GitHub Pages no tiene Pages gratis para repos privados; no hay secretos reales en el código — la anon key de Supabase es de diseño público).

## Constantes de negocio

- `FYF = 1.110.000` (flete y formulario, todos los precios incluyen FyF).
- Reglas modelo `roles` en tasador_usuarios: es **TEXT[]** (no JSONB). Castear con `ARRAY['vendedor','gerente']::text[]`.

## Roles

Login compartido con tasador (tabla `tasador_usuarios`). Roles relevantes acá:

| Rol      | Quién(es)        | Ve                              | Hace                            |
|----------|------------------|---------------------------------|---------------------------------|
| vendedor | todos            | sus consultas, sin gcia ni %    | crea consultas                  |
| gerente  | dlopez           | consultas que él cargó, sin gcia| crea consultas eligiendo vendedor primero |
| admin    | fngonzalez       | todas, con gcia y %             | acepta/rechaza, gestiona usuarios |

`fngonzalez` y `dlopez` tienen ambos rol vendedor + el rol especial. Al loguearse, mode-select pregunta desde qué rol entrar.

## Tablas

Ver `schema.sql`. Resumen:
- `consultas_0km` — cabecera. PK `id BIGSERIAL`. Tiene `cargada_por_id`/`cargada_por_nombre` para auditoría cuando un gerente carga por otro.
- `consultas_0km_items` — hasta 4 unidades por consulta. JSONB `chasis` con snapshot.
- `consultas_0km_notif_config` — destinatarios por evento.
- `consultas_0km_notif_log` — log de envíos WA.

RLS deshabilitado en las 4 tablas. Patrón heredado del tasador.

## Datos de stock

Sheet espejo público "Tito — espejo público consulta0km" (CSV publicado), IMPORTRANGE desde el sheet maestro privado `1KvuRZzHuVpWSppZqT8xDf8WSrplR-vYzeY0gQPftlpQ`. El espejo no trae costo histórico ni paga/impaga.

URLs CSV (constantes en `index.html`):
- stock (gid=0): `https://docs.google.com/spreadsheets/d/e/2PACX-1vRxMSuaIaQ9krTGnAYj73w1H9BuQnIyTQo1f9WwOgRVCAcf3eniWiCji7GFR2Ts__HtCvoFZkjbC5o1/pub?gid=0&single=true&output=csv`
- stock_limitado (gid=1137307261): misma URL con otro gid.
- competencia (gid=132095265): IMPORTRANGE de `Resumen Competencia 2!A:K` del maestro. Lee modelo (col A), precio ElCeroKm c/fyf (col D) y precio Espasa c/fyf (col H). Solo se muestra al admin en el detalle de cada unidad.

Columnas `stock`: `serie, fecha_factura, modelo, color, disponibilidad, oferta_baratito, gcia_actual, precio_lista, dto_baratito` (9).
Columnas `stock_limitado`: `serie, dto_nuevo, gcia_resultante, oferta_final_fyf` (4).

Reglas:
- `disponibilidad === '#N/A'` → libre. Otro valor → vendida (típicamente vuelve el modelo).
- Si serie está en stock_limitado, gana esa oferta sobre baratito (siempre baja el precio). Pero si en stock figura vendida, descartar.
- Chasis libres ordenados por `fecha_factura` ASC (más viejos primero) para que el vendedor priorice unidades antiguas.

## Fórmulas

```
oferta_vigente = oferta_final_fyf si chasis está en stock_limitado, sino oferta_baratito
gcia_vigente   = gcia_resultante  si en stock_limitado, sino gcia_actual
dto_extra_pedido = (oferta_vigente_min − precio_pedido) / precio_lista
gcia_resultante  = gcia_vigente_min − dto_extra_pedido
% financiación   = monto_a_financiar / (precio_pedido_unidad_1 − FYF)
```

Cuando hay múltiples chasis en una unidad, se usa la `oferta_vigente` MÁS BAJA (peor caso para el concesionario). El % financiación se calcula sobre la primera unidad de la consulta (simplificación).

**Mostrar al admin solamente**: gcia_actual, gcia_resultante, % financiación. El vendedor y el gerente NO ven esos campos.

**Pre-llenar input "mejor precio máximo"** del admin al abrir el modal: con `oferta_vigente_min` de la primera unidad. Auto-ejecuta el cálculo del hint.

## Wizard del vendedor (step-by-step)

Una pregunta por pantalla, auto-avance al elegir radios. Inputs de texto requieren botón Siguiente.

Pasos:
1. (solo gerente) `gerente-vendedor` — dropdown nativo para elegir vendedor
2. `cantidad-unidades` — 1, 2, 3 o 4 unidades
3. `modelos` — un select por unidad EN PARALELO (todas en una pantalla)
4. `colores` — lista chasis por unidad en paralelo
5. `precios` — input + análisis live (solo dto_extra_pedido + oferta_vigente)
6. `tipo-cliente` → particular o reventa
7. `cliente-nombre` (particular) o `reventa-nombre`
8. `ubicacion` — provincia + localidad
9. (particular) `fuente-dato` → si "otro", `fuente-otro`
10. (particular) `tiene-usado`
11. `financia` (label varía: reventa = "¿Financia con VWFS?", particular = "¿Financia?")
12. (si financia y particular) `fin-entidad` → si "otros", `fin-entidad-otro`
13. (si financia) `fin-monto` — monto, sin mostrar % al vendedor
14. `vs-otro` → si "sí", `concesionario` (nombre + precio)
15. `resumen` → submit

## Vista admin (fngonzalez)

- Tabs Pendientes / Resueltas
- Botón en header `👥 Usuarios` → vista aparte (`usuariosView`) con lista, crear, editar, reset clave, "entrar como" sin password (con banner naranja para volver), activar/desactivar.

## Notificaciones WhatsApp

Edge Function `notify-whatsapp-consulta` con templates Meta aprobados:

**`consulta_0km_nueva`** (3 vars = vendedor, modelo, dto%) — actualmente Meta tiene aprobada la v1 con cuerpo equivocado y 24h de cooldown bloqueado. Se está usando un template alternativo `consulta_0km_nueva_v2` con el cuerpo correcto. La Edge Function tiene `EVENT_TO_TEMPLATE` map que traduce `consulta_0km_nueva` → `consulta_0km_nueva_v2` al enviar a Meta. Una vez que se pueda eliminar el template viejo y recrear con el nombre original, sacar el map.

**`consulta_0km_respondida`** (4 vars = modelo, vendedor, estado, monto) — aprobado y funcionando. El estado es "Aceptada", "Rechazada" o "Contraoferta (revisá el comentario en el portal)". El monto es:
- Aceptada → precio_pedido del primer item.
- Rechazada → precio_max_admin.
- Contraoferta → precio_max_admin si hay; "—" si no.

Destinatarios:
- **Nueva**: fngonzalez (admin) + todos los gerentes activos (Daniel López). NO al vendedor que la creó.
- **Respondida**: vendedor original + todos los gerentes + admin que respondió (sumado dinámicamente desde `con.admin_user_id` en la Edge Function).

Configuración base en `consultas_0km_notif_config`. Reusa env vars del tasador (`WA_TASADOR_PHONE_ID`, `WA_TASADOR_TOKEN`, `SUPABASE_SERVICE_ROLE_KEY`).

### Recordatorios de consultas SIN RESPONDER (28/07/2026)

**`consulta_0km_sin_responder`** — si una consulta queda en `estado='pendiente'` más de **60 min**, se manda un recordatorio, y otro cada 60 min hasta un **tope de 5**. Corre 24/7. Aceptar / rechazar / contraofertar corta la cadena sola (la fila deja de matchear `estado='pendiente'`): **no hay que marcar nada**.

- El motor es la Edge Function **`notify-sin-responder`**, que vive en el repo del **tasador** (`C:\proyectos\tasador-tga\supabase\functions\notify-sin-responder\`) porque barre las dos tablas (`tasaciones` + `consultas_0km`) del mismo proyecto Supabase. **pg_cron cada 10 min, jobid 5.** Doc completa en el `CLAUDE.md` del tasador, "Cambio 11".
- **Destinatarios**: hereda la config de `consulta_0km_nueva` vía el map `CONFIG_EVENTO` de esta Edge Function. No hay fila propia en `consultas_0km_notif_config` — a propósito, para no mantener dos configs.
- **Template**: todavía no tiene uno propio. `EVENT_TO_TEMPLATE` lo manda como `consulta_0km_nueva_v2` y el aviso va adentro de `{{1}}`: `⏰ SIN RESPONDER hace 2 h (aviso 3) — Juan Pérez`. Cuando se cree el template dedicado en la WABA `1183788370595856`, cambiar esa línea y redeployar.
- **Agrupa por submit**: como cada unidad pedida es 1 consulta separada, el sweeper junta las del mismo vendedor creadas con <30 s de diferencia y manda **UN** recordatorio con todos los modelos (`Polo Track + Nivus Comfortline`), no N. Le pasa los `grupo_ids` en el body y esta función lee los items de todas para armar la variable de modelos.
- **Ojo con el deploy**: esta función tiene **verify_jwt = ON**. Deployar **sin** `--no-verify-jwt` (al revés que las del tasador).
- Columnas nuevas en `consultas_0km`: `recordatorios_enviados`, `ultimo_recordatorio_at`. Parámetros en la tabla `recordatorios_config` (fila `consulta_0km`): `activo`, `intervalo_min`, `max_recordatorios`, `desde`.

## Consultas de USADOS (2026-08-19)

El mismo circuito que las de 0km — el vendedor pide mejor precio, Fer acepta / rechaza / contraoferta, el vendedor marca después si se vendió — pero sobre **una unidad usada concreta del stock**. Pedido de Fer el 19/08/2026.

Se entra por el **switch `🚗 0km` / `🔑 Usados`** arriba de todo (`#seccionTabs`). Son **dos tablas distintas** (`consultas_0km` y `consultas_usados`), por eso se cambia de lista entera en vez de mezclarlas: los `id` de las dos se pisan y un borrado o un PATCH podría ir a la fila equivocada.

**Lo que NO tiene, a propósito** (pedido textual de Fer: *"sin el análisis que hay atrás de lo del 0km"*): competencia, rotación, stock del modelo, reparto y vendidos del mes. Un usado es una unidad única — no hay "otros chasis" ni ritmo de venta del modelo. **Lo único que se analiza es la ganancia nueva** contra el precio pedido.

**El costo sale de OVERSOFT** (`usados.preciodetoma` = lo que se tomó real). Aclaración explícita de Fer: **no** se cae al `precio_toma_final` del tasador si Oversoft viene en 0 — ahí la pantalla dice "no tiene costo de toma cargado en Oversoft" y no calcula nada. Del tasador se usan solo km real, color y el `total_arreglos` del análisis físico, que va como **segunda lectura etiquetada** ("con arreglos del análisis físico, dato del tasador"), nunca pisando el número principal.

**Margen**, con la definición de Fer: `(venta − costo) / costo` (costo 10M, venta 15M = 50%). Al lado, en chico, el margen sobre la venta (33,3%), que es el contable. Verde ≥10%, ámbar <10%, rojo negativo. El bloque muestra: costo de toma · precio publicado hoy con su margen · precio pedido con su margen · **cuánta ganancia resigna**.

**Historial POR UNIDAD** (pedido: *"si antes pasé contraofertas por ese usado me figuren"*). A diferencia del 0km (que cruza por **modelo**), acá el cruce es por **`usadoid`**: es la misma unidad física, así que lo autorizado antes es directamente comparable. Lista todas las consultas ya respondidas de ese usado con fecha, vendedor, estado, precio autorizado, el **margen recalculado con el costo de hoy** y si terminó vendida.

### COSTO BLINDADO — la regla que no hay que romper
El costo y el margen **nunca** se guardan en `consultas_usados` ni viajan al browser del vendedor:
- La tabla **no tiene columna de costo a propósito**. RLS está deshabilitado (patrón heredado) y el vendedor lee la tabla con la anon key: cualquier columna que guardemos ahí la puede leer.
- El costo lo sirve la Edge Function **`usados-disponibles`**, que lo adjunta **solo** si las credenciales `{usuario, clave}` del POST son de `COSTO_USUARIOS` (`fngonzalez`, `fgonzalez`, `cgonzalez`) — mismo patrón que la gcia en `stock-disponible`. Vendedor, gerente, cualquier otro admin y cualquier GET reciben la lista sin costo, y con `usadosCostoOk = false` el front no puede calcular ningún margen.
- Verificado el 19/08/2026 en producción: sin credenciales la respuesta no trae `costo_toma`; con las de Fer sí.

### Piezas
- **Tabla `consultas_usados`** (wjfgl). Snapshot de la unidad (usadoid, patente, unidad, modelo, año, km, color, estado_unidad) + `precio_publicado` (el precio al momento de pedir) + `precio_pedido` + cliente + observaciones + el bloque de respuesta/resultado igual que el 0km. Constraint de `estado` en (pendiente, aceptada, rechazada, contraoferta).
- **Edge Function `usados-disponibles`**: mismo universo que la solapa `/usados` de portal-precios (estado=Activado, fechadeventa null, alta ≤18 meses, sin ocultas ni vendidas de `portal_usados`), físicas **y** a recibir. Precio publicado = override de `portal_usados.precio_venta` si existe, sino `preciodeventa` de Oversoft.
- **`notify-whatsapp-consulta`**: eventos `consulta_usado_nueva` / `consulta_usado_respondida` leyendo la tabla nueva (sin items: un usado es una unidad). Config propia en `consultas_0km_notif_config`, clonada de la del 0km → **hereda los mismos destinatarios** (Fer + gerentes).
- **`index.html`**: wizard de 5 pasos (unidad → precio → cliente → observaciones → resumen; +1 si es gerente), lista propia, y detalle del admin con ganancia + historial.

### Templates de Meta propios (✅ 19/08/2026)

Los tres están creados y **APPROVED** en la WABA `1183788370595856`: `consulta_usado_nueva` (3 vars), `consulta_usado_respondida` (4 vars) y `consulta_usado_sin_responder` (3 vars).

Se crean/listan **desde la propia Edge Function**, porque el token de Meta solo existe como secret de Supabase:
```
POST /functions/v1/notify-whatsapp-consulta  {"accion":"crear_templates_usado"}   # saltea los que ya existen
POST /functions/v1/notify-whatsapp-consulta  {"accion":"listar_templates"}        # nombre + estado de todos
```

**Gotcha de Meta**: rechaza cuerpos que **empiezan o terminan con una variable** (`error_subcode 2388299`, "las variables no pueden estar al principio ni al final"). El primer intento de `consulta_usado_nueva` falló por arrancar con `{{1}}`. Siempre texto en los dos extremos.

**Respaldo automático de template.** Si Meta rechaza el template propio (todavía en PENDING, o pausado más adelante), el envío **se reintenta una vez** con el del 0km (`TEMPLATE_FALLBACK`), que está aprobado hace meses. Sin esto, un template en PENDING = aviso perdido en silencio. Los códigos que disparan el reintento son los de template (132000/132001/132005/132007), no los de número inválido.

El texto se acomoda solo: `usaTemplatePropio()` mira si el evento apunta a un template con su mismo nombre. Con el propio, el encabezado ya dice "usado" y `{{1}}` va limpio; con el respaldo se antepone `USADO —` adentro de la variable. **Probado de verdad el 19/08/2026** apuntando a propósito a un template inexistente: cayó al del 0km y el texto salió con el marcador.

### Recordatorios de "sin responder" (✅ 19/08/2026)

`notify-sin-responder` (repo del **tasador**, pg_cron jobid 5, cada 10 min) ahora barre **tres** fuentes: `tasador`, `consulta_0km` y **`consulta_usado`**. Fila propia en `recordatorios_config` (intervalo 60 min, tope 5 avisos, `desde` = 19/08/2026).

**No agrupa, a diferencia del 0km.** El wizard de usados guarda **una fila por consulta** (un usado es una unidad única, no se piden varios de una), así que cada una insiste por su cuenta. Si se agruparan, dos pedidos por dos autos distintos se sellarían con un solo aviso que nombra uno solo.

Corta solo: en cuanto la consulta deja de estar `pendiente` (aceptada / rechazada / contraoferta) sale del barrido. Verificado end-to-end el 19/08/2026 con `intervalo_min=0` y una fila aislada.

**⚠️ Ojo al deployar `notify-sin-responder`**: va **con `--no-verify-jwt`**. El pg_cron la llama sin header de auth; si se deploya sin el flag, el cron empieza a devolver `UNAUTHORIZED_NO_AUTH_HEADER` y los recordatorios mueren en silencio. (Pasó el 19/08/2026 y se corrigió en el momento.) Es al revés que `notify-whatsapp-consulta`, que sí lleva verify_jwt ON.

**Verificado el 19/08/2026**: alta/PATCH/constraint por REST; los dos WhatsApps end-to-end (limitados temporalmente a Fer para no molestar a Daniel, config restaurada después); el cálculo de margen, el historial por unidad y los tres pasos del wizard corridos en el navegador contra producción, sin errores de consola. Filas de prueba borradas y la secuencia reiniciada en 1.

**Ojo con el stock real**: al 19/08/2026 hay **una sola** unidad consultable (Chevrolet Cruze AF935MN, a recibir, $25.900.000). El resto del stock reciente ya está vendido y la chatarra vieja cae por la ventana de 18 meses. Que la lista salga casi vacía no es un bug.

## Convenciones heredadas del tasador

- Login NO hashea claves (deuda técnica conocida, NO arreglar acá sin avisar).
- Tabla `tasador_usuarios` campos: `usuario`, `clave`, `activo`, `roles` (TEXT[]), `rol`, `nombre`, `email`, `telefono_wa`, `callmebot_key`, `debe_cambiar_clave`.
- Patrón `sbFetch(path, options)` directo a `/rest/v1/`.
- CSS variables VW (`--vw-blue: #001E50`).
- Fonts: DM Sans + JetBrains Mono.

## WhatsApp / WABAs (importante)

El usuario tiene **múltiples WhatsApp Business Accounts** en su Business Manager. Los templates de Cloud API SOLO funcionan si están en la misma WABA donde está registrado el número de teléfono.

- **WABA correcta**: `Tito Gonzalez | Tasador` — id `1183788370595856`. Ahí está el número real `+54 9 11 2177-7447` ("Tito Gonzalez | Postventa") y los templates del tasador (`tasacion_pendiente_carga`, etc).
- **WABA incorrecta (no usar)**: `Test WhatsApp Business Account` — id `26096047046744727`. Tiene un número de prueba `+1 555-...`. Los templates `consulta_0km_nueva` y `consulta_0km_respondida` quedaron acá por error al crearlos.

**Sesión 2026-04-28** — el WA de "consulta nueva" no llegaba: los templates estaban aprobados pero en la WABA "Test" en lugar de la WABA del Tasador (que es donde vive el número real). Meta respondía error 132001 "template name does not exist in es_AR" porque buscaba los templates en la WABA del número, no en donde estaban realmente. **Resuelto**: re-creados en la WABA correcta. Quedan dos copias en la WABA "Test" sin uso (se pueden borrar pero no molestan).

Link a templates de la WABA correcta: https://business.facebook.com/wa/manage/message-templates/?asset_id=1183788370595856

## Permisología

Tres niveles, con dos arrays de configuración en `index.html`:

- `SUPERADMINS_USUARIOS = ['fngonzalez']` — god mode. Helper `_esSuperadmin()`.
- `RESET_CLAVES_USUARIOS = ['fngonzalez', 'mlubrano']` — puede resetear claves. Helper `_puedeResetClaves()`.
- Cualquier otro admin (no en arrays) — solo aceptar/rechazar/contraofertar consultas.

Capacidades por nivel:
| Acción | superadmin | mlubrano (reset) | otro admin |
|---|---|---|---|
| Aceptar / Rechazar / Contraofertar | ✅ | ✅ | ✅ |
| Eliminar consultas (single + bulk) | ✅ | ❌ | ❌ |
| Botón "👥 Usuarios" visible | ✅ | ✅ | ❌ |
| Reset clave | ✅ | ✅ | ❌ |
| Crear / Editar usuarios | ✅ | ❌ | ❌ |
| Activar / Desactivar | ✅ | ❌ | ❌ |
| "Entrar como" otro usuario | ✅ | ❌ | ❌ |

Defensa en profundidad: cada función sensible re-checkea el helper al entrar.

## Convenciones de naming / dominio

- **"Tito Gonzalez"** se escribe SIN tilde en la A. Es el nombre comercial. No corregirlo a "González" en copy/UI/samples nuevos. (Hay archivos viejos con tilde — no migrar retroactivamente sin pedido explícito.)

## Decisiones de diseño importantes

### Cada unidad pedida = 1 consulta separada
Si el vendedor pide precio para 2/3/4 modelos en el wizard, el `submitConsulta` los **divide en N consultas separadas** (cada una con 1 item). El admin las responde independientemente, cada una dispara su propio WA. Datos compartidos (cliente, ubicación, financia, observaciones) se duplican en cada cabecera. Implementación en `submitConsulta` con loop sobre `f.unidades`.

### Resultado de venta (lo carga el vendedor)
Después que el admin responde, el vendedor abre el detalle y marca:
- **Vendida** → solo confirma.
- **No vendida** → motivo obligatorio.

Una vez cargado, queda fijo (no editable). Aparece como badge en las cards (verde "✓ VENDIDA" o rojo "✗ NO VENDIDA").

### Tab "Respondidas" del gerente
El gerente (Daniel) tiene 2 tabs:
- "Mis cargas" — consultas que él cargó.
- "Respondidas" — todas las consultas con estado != pendiente, con dropdown filtro x vendedor. Ve la vista del vendedor (sin gcia ni % financiación).

### Stock comparado en detalle admin
Solo en modo admin, abajo del análisis de cada unidad: bloque "📦 Stock actual del modelo" con todos los chasis libres ordenados de más viejo a más nuevo. El chasis pedido va resaltado con fondo amarillo + tag "PEDIDO". Lee de `stockData` (en vivo, no del snapshot del item).

## Estado al cierre de sesión 2026-04-28 (noche)

### ✅ Funcionando
- Producción en https://consulta0km.titogonzalez.online (HTTPS habilitado, cert OK).
- Schema completo, todas las migraciones corridas en Supabase.
- Edge Function `notify-whatsapp-consulta` deployada con map evento→template.
- WA de "consulta nueva" llegando: vendedor + modelo + dto%.
- WA de "consulta respondida" llegando: modelo + vendedor + estado + monto.
- Cuando el vendedor pide N modelos → N consultas separadas → N WAs independientes (verificado end-to-end).
- Permisología 3 niveles (superadmin / reset claves / admin común).
- Daniel López con rol vendedor + gerente, ve el tab "Respondidas".
- Botón "Cambiar perfil" para usuarios multi-rol.
- Eliminar consultas (single + bulk) — solo fngonzalez.
- Pre-llenar precio admin con oferta vigente.
- Resultado de venta (vendida / no vendida + motivo) — vendedor lo marca tras respuesta del admin.
- Contraoferta como 3er estado, con comentario opcional (mientras haya precio o comentario, alguno de los dos).
- Hasta 4 unidades por consulta en el wizard.
- Modelos en wizard ordenados por gama (Polo → Tera → Virtus → Nivus → T-Cross → Taos → Vento → Tiguan → Saveiro → Amarok) via `MODELOS_ORDEN`.
- Observaciones del vendedor (paso opcional al final del wizard).
- Stock comparado por modelo en detalle del admin con fechas de factura (espejo arregló la columna `fecha_factura`).

### ⏳ Pendiente / a futuro
- **Borrar templates viejos en WABA "Test"** (`consulta_0km_nueva` y `consulta_0km_respondida` que quedaron del primer intento, no se usan).
- **Cuando expire el cooldown de 24h** del template `consulta_0km_nueva` original (el que quedó con cuerpo equivocado, ~29-04-2026 noche), eliminarlo y recrearlo con el nombre original + cuerpo correcto. Después sacar el map `EVENT_TO_TEMPLATE` de la Edge Function para volver a usar el nombre original directo.
- **Verificar propagación DNS final**: GitHub Pages todavía mostraba "DNS check unsuccessful" cuando se cerró la sesión, aunque el cert estaba OK y HTTPS andaba. Es solo cosmético — Google DNS aún no propagó la 4ta IP. TTL de 14400s (4hs), debería estar limpio al volver mañana.
- **WA "nueva consulta" multiplica WAs** cuando el vendedor pide N autos: ahora llega 1 WA por auto. Si resulta ruidoso, evaluar consolidar (1 WA por submit con resumen).

## Sesión 2026-04-29

### ✅ Agregado en esta sesión
- **Editar respuesta en Resueltas** (commit `aae56ec`): admin abre una consulta cerrada → botón ✏️ Editar respuesta → reabre el mismo formulario que pendientes pre-llenado con `precio_max_admin` + `observaciones_admin` actuales. Banner naranja avisa "se reenviará el WhatsApp". Al guardar (aceptar/rechazar/contraofertar), el PATCH actualiza la fila y `notifyVendedorRespuesta()` dispara la Edge Function que reenvía el WA con el mismo template `consulta_0km_respondida` y datos frescos del DB. `aceptarMejora` ahora también setea `precio_max_admin: null` para limpiar el precio anterior si se editó desde rechazada/contraoferta → aceptada.
- **📊 Vs competencia en detalle admin** (commits `00f409c` + `d674c56` + `cb8d905`): bloque por unidad, solo modo admin. Compara `precio_pedido` vs ElCeroKm (col D) y EspasaOnline (col H) leyendo del nuevo tab `competencia` del espejo público (gid `132095265`, IMPORTRANGE de `Resumen Competencia 2!A:K` del maestro). Match exacto por nombre de modelo (col A). Muestra: `<Competidor> $precio (±$diff) X% más barato/caro` con verde/rojo. Si el modelo no aparece o no tiene precio, no muestra la sección. Constante en `index.html:380` (`COMPETENCIA_CSV`); cargado en paralelo con stock vía `cargarCompetencia()`. Tolerante a fallos (silently skip).
- **Input precio en formato pesos + monto en palabras** (commits `9d9b45d` + `0ecc8fb`): tanto el `precioPedido` del wizard del vendedor como el `adminPrecioMax` del modal de admin ahora son font-size:20px bold con padding:14px y muestran abajo en cursiva `≈ N millones M mil` (helper `numToTextES`). Objetivo: evitar errores de un cero de más/menos al tipear.

### ⏳ Pendiente / a futuro (sesión 2026-04-29)
- **Probar end-to-end el reenvío del WA** al editar una respuesta desde Resueltas (no se verificó con un envío real al cierre de sesión).
- **Modelos sin match exacto en competencia**: si el sheet maestro tiene variaciones de nombre (ej. "Polo Track" vs "VW Polo Track MSI MT G1 MY26"), no van a cruzar. Hoy hay match exacto. Si aparece el problema, implementar mapeo o normalización (toLowerCase + trim).

## Sesión 2026-08-18 — Unidades EN REPARTO consultables por el vendedor

**Problema**: los autos que VW ya nos asignó en el reparto pero que todavía no entraron a Oversoft no se podían consultar. El selector del wizard mostraba solo modelos con chasis libre en Oversoft + una lista de "modelos en reparto" sacada del CSV espejo (`REPARTO_CSV`, gid 978193397) filtrada a `stock_actual == 0`. Ese CSV ya no coincide con `reparto_vw`: ofrecía modelos que no están asignados (Amarok Comfortline TDI **MT** 4x2) y se comía los que sí (Vento GLI, porque el sheet le marcaba stock 2). El reparto en vivo ya existía en la Edge Function pero estaba dentro de `if (includeGcia)` → solo admin.

**Solución**: `stock-disponible` ahora devuelve **`repartoUnidades`** a todos los roles — una fila por unidad con el mismo shape que `unidades` (serie = últimos 8 del VIN, color desde `reparto_colores`/`REPARTO_COLORES_BASE`, precio del snapshot del Motor Baratito), además del agregado `reparto` que ya usaba el bloque del admin. La **ganancia sigue blindada**: `gcia_actual`/`gcia_vigente` solo si `includeGcia`.

En `index.html`, `cargarStockOversoft()` concatena esas filas a `stockData` con `enReparto: true` y `estadoReparto` (`a_pedir` | `pedida`). A partir de ahí **todo el resto funciona sin cambios**: el vendedor elige la unidad de reparto como si fuera un chasis de stock (color + serie), el análisis usa la oferta del Baratito y el `chasisSnapshot` guarda `enReparto`. Se distinguen con el badge **EN REPARTO** (violeta) vs **A RECIBIR** (ámbar, ya en Oversoft) — helpers `badgeChasis()` / `txtEstadoReparto()`.

- El selector muestra el desglose: `Polo Track (8 + 7 en reparto)`, `Vento GLI (2 en reparto)`.
- Los chasis de reparto no tienen fecha de factura → quedan al final del listado de colores (primero lo viejo del físico).
- `es_reparto` del item ahora también se marca cuando todos los chasis elegidos son de reparto.
- `u.esReparto` (unidad sin chasis) quedó como camino legacy: solo se activa en el **fallback CSV**, cuando la Edge está caída. Ahí también se corrigió el filtro: `stock > 0` en vez de `stock !== 0` (un stock negativo también es "sin stock").

**Estado al cierre**: 68 unidades de Oversoft + 56 en reparto (21 modelos). Tres modelos sin ningún chasis físico pasaron a ser consultables: Vento GLI 350TSI DSG G2 (Gris Ártico, Gris Platino), Amarok Comfortline TDI AT 4x2 G2 (Blanco Puro, Plata Pirita) y Amarok Highline TDI AT 4x2 G2 (Plata Pirita).

⏳ **Pendiente**: probar el circuito completo logueado como vendedor (se verificó la Edge en producción y las funciones del wizard contra los datos reales, pero no el submit end-to-end desde el navegador).
