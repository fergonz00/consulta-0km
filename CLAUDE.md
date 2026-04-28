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
