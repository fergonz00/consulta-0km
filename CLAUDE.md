# Consulta 0KM — Contexto del proyecto para Claude Code

## Qué es

Módulo independiente para que los **vendedores de Tito González Automotores (TGA)** carguen consultas de mejora de precio de 0km, con pre-análisis automático que replica la planilla manual de Fer. A futuro lo va a integrar Mati en el CRM.

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
- `consultas_0km_items` — hasta 3 unidades por consulta. JSONB `chasis` con snapshot.
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
2. `cantidad-unidades` — 1, 2 o 3 unidades
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
- `consulta_0km_nueva` (1 var = id) → al admin (Fer fijo en config)
- `consulta_0km_respondida` (2 vars = id + resultado) → vendedor + todos los gerentes activos

Configuración inicial cargada en `consultas_0km_notif_config`. Reusa env vars del tasador (`WA_TASADOR_PHONE_ID`, `WA_TASADOR_TOKEN`, `SUPABASE_SERVICE_ROLE_KEY`).

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

## Estado al cierre de sesión 2026-04-28

✅ Producción operativa en consulta0km.titogonzalez.online.
✅ Schema corrido en Supabase.
✅ Edge Function deployada.
✅ Daniel López con rol vendedor + gerente cargado.
✅ Panel admin de usuarios funcionando.
✅ Pre-llenar precio admin con oferta vigente.
✅ Botón "Cambiar perfil" en header para usuarios con múltiples roles.
✅ WA de "consulta nueva" funcionando end-to-end (templates re-creados en WABA correcta).
⏳ Falta verificar end-to-end el WA de "consulta respondida" (admin acepta/rechaza → llega a vendedor + gerentes).
