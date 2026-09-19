# Linear Crew

Control plane local para coordinar equipos de agentes de IA. Sustituye el uso de issues y comentarios de GitLab como bus de coordinación con entidades transaccionales para outcomes, delegaciones, sesiones, reuniones, leases, handoffs, intervenciones, evidencia y aceptación independiente.

El proyecto requiere Bun 1.4 o superior y no usa APIs `node:*`.

## Estado

El MVP incluye:

- jerarquía `milestone -> epic -> issue -> task`;
- roles con capabilities;
- workflows secuenciales configurables por proyecto;
- repositorios y workspaces explícitos;
- topologías `single-repo`, `monorepo` y `multi-repo` con context roots independientes;
- sesiones durables y adoptables enlazables con runtimes externos;
- delegaciones ancladas a outcome y revisión;
- leases de escritura exclusivos por workspace con fencing token;
- handoffs con reconocimiento o rechazo;
- mensajes directos y solicitudes de intervención;
- notas de contexto humanas dirigidas a sesiones o work items;
- reuniones de planificación multirol con rondas, contribuciones y síntesis durables;
- entregas versionadas, evidencia y aceptación/rechazo independiente;
- event log auditable en SQLite;
- API Elysia 2, CLI Bunli, dashboard OpenTUI y plugin OpenCode.
- scheduler OpenCode para crear, continuar y reconciliar sesiones por subdirectorio.
- comando `runtime` para administrar conjuntamente el servidor OpenCode y el scheduler.

El plugin crea y coordina sesiones mediante el servidor OpenCode y evita volver a usar al PO como relay. El diseño completo está en [`docs/design-docs/index.md`](docs/design-docs/index.md).

## Instalación

```bash
bun install
bun run typecheck
bun test
bun run build
```

El build genera JavaScript ESM para el runtime de Bun en `dist/cli.js` y `dist/opencode-plugin.js`. No usa `--compile` ni produce ejecutables nativos.

### Link local del CLI

Desde el repositorio de Linear Crew:

```bash
bun run build
bun link
linear-crew --help
```

`package.json` registra el bin `linear-crew` sobre `dist/cli.js`, cuyo shebang usa `/usr/bin/env bun`. En otro proyecto puede enlazarse como dependencia con:

```bash
bun link linear-crew
```

## CLI

```bash
linear-crew --help
linear-crew project-create --name "Mi proyecto"
linear-crew project-list
linear-crew guide --project <id>
linear-crew role-add --project <id> --key po --name "Product Owner" --capabilities grant-lease
linear-crew work-add --project <id> --title "Nueva feature" --outcome "Comportamiento observable y aceptado"
linear-crew status --project <id>
linear-crew opencode-configure --project <id>
linear-crew tui --project <id>
linear-crew runtime --project <id>
```

La base por defecto es `linear-crew.sqlite`. Puede cambiarse con `--database` o `LINEAR_CREW_DB`.

## OpenCode

El plugin local está registrado en `.opencode/plugins/linear-crew.ts`. OpenCode lo descubre automáticamente al iniciar desde este proyecto.

El paquete exporta el plugin como default y como `LinearCrewPlugin` desde `linear-crew`, `linear-crew/plugin` y el entrypoint estándar `linear-crew/server`.

Para usar el plugin mediante link local en otro proyecto, primero ejecute `bun link linear-crew` allí y cree `.opencode/plugins/linear-crew.ts`:

```ts
export { default } from "linear-crew/server";
```

Una versión publicada se instala automáticamente por OpenCode al declararla en `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["linear-crew"]
}
```

Después de crear el proyecto del control plane, genera su binding local:

```bash
linear-crew opencode-configure --project <id>
opencode .
```

Un agente que no conozca Linear Crew debe comenzar con `crew_guide`. La tool funciona antes de registrar la sesión y devuelve el propósito del control plane, la topología y configuración real del proyecto, roles, workspaces, workflows, invariantes, catálogo de tools y el flujo obligatorio de implementación. El mismo documento está disponible para humanos con `linear-crew guide --project <id>` y por HTTP en `GET /projects/:id/guide`.

Después, el agente llama `crew_register_session` con su `roleKey` si la sesión todavía no fue enlazada. A partir de ahí puede utilizar tools `crew_*` para leer contexto durable, administrar trabajo y delegaciones, coordinar leases, comunicarse, gestionar intervenciones y handoffs, y completar el ciclo de evidencia y aceptación.

El PO puede usar `crew_start_delegation` para crear una sesión primaria en el context root de la delegación, `crew_start_delegations` para iniciar varios análisis independientes en paralelo, `crew_continue_delegation` para reanudar una sesión y `crew_reconcile_sessions` para sincronizar estados. Una sesión que termina su turno despierta automáticamente a su coordinador. Mensajes, intervenciones y notas humanas también despiertan directamente a la sesión destinataria.

Las reuniones se crean con `crew_meeting_create` y se inician con `crew_meeting_start`. Cada participante recibe una sesión aislada y de solo lectura en su context root, publica una contribución por ronda con `crew_meeting_contribute` y recibe las propuestas de los demás para la ronda siguiente. Al terminar, el facilitador recibe el transcript completo y publica el feature brief mediante `crew_meeting_complete`.

`crew_context` y el hook de compactación usan una vista curada: incluyen solamente el work item y sus ancestros, delegaciones relacionadas, reuniones activas, síntesis recientes vinculadas, handoffs pendientes y las 20 notas o mensajes relevantes más recientes. La respuesta indica cuántos elementos antiguos omitió. No incorpora el event log, leases históricos, sesiones ajenas ni ruido de herramientas.

El contexto completo sigue disponible sin contaminar el prompt normal:

- `crew_context_history`: pagina notas y mensajes antiguos de una sesión, work item o reunión concreta.
- `crew_operational_context`: muestra explícitamente sesiones, leases, intervenciones y eventos recientes para diagnosticar el runtime.

Las notas de producto se clasifican como `context`, `decision` o `constraint`. Leases, reintentos, fallos al ejecutar comandos y cambios de estado permanecen como telemetría estructurada; no se convierten en notas del producto.

Para cargar el plugin desde otro repositorio, ese proyecto debe registrar un loader equivalente en `.opencode/plugins/` que exporte `LinearCrewPlugin` y compartir la base mediante `.linear-crew.json` o `LINEAR_CREW_DB`. La distribución como paquete instalable se hará junto con el adapter que cree sesiones OpenCode automáticamente.

## Topología

Linear Crew mantiene un solo proyecto y un solo grafo de trabajo aunque existan varios repositorios Git:

- `single-repo`: un repositorio y un context root.
- `monorepo`: un repositorio Git con varios context roots; las sesiones se aíslan por workspace y el lease de escritura protege el checkout compartido.
- `multi-repo`: un root de coordinación y conocimiento con repositorios hijos independientes, incluidos submódulos.

Cada workspace define su ruta, repositorio, herencia de contexto y si exige un perfil local en `.opencode/agents`. Cada rol declara `workspaceKeys`; el scheduler rechaza delegaciones fuera de esa lista.

Ejemplo de bootstrap multiproyecto:

```bash
linear-crew project-create --name AVANCE --topology multi-repo --root C:/projects/avance
linear-crew repository-add --project <id> --key knowledge --name Knowledge --path . --relationship root
linear-crew repository-add --project <id> --key api --name API --path api_v2 --relationship submodule
linear-crew workspace-add --project <id> --repository <repository-id> --key api --name API --path api_v2
linear-crew role-add --project <id> --key backend-engineer --name Backend --workspaces api
linear-crew opencode-configure --project <id>
```

`.linear-crew.json` contiene el modo de topología, root absoluto, servidor OpenCode e inventario de context roots. El estado operativo continúa en SQLite.

Para reconciliación continua contra un servidor headless:

```bash
opencode serve --hostname 127.0.0.1 --port 4096
linear-crew scheduler --project <id> --root C:/projects/avance --opencode http://127.0.0.1:4096
```

Como alternativa recomendada, Linear Crew puede ser dueño del ciclo de vida del servidor y cerrarlo junto con el scheduler:

```bash
linear-crew runtime
```

Ejecutado desde el root configurado, `runtime` obtiene `projectId`, database, root, hostname y port de `.linear-crew.json`. Los flags explícitos sobrescriben esos valores. Antes de iniciar OpenCode valida el proyecto y que el puerto esté libre; si ya existe un servidor en ese puerto, use otro `--port` o conecte el comando `scheduler` al servidor existente.

El warning `OPENCODE_SERVER_PASSWORD is not set` es informativo y no detiene servidores enlazados a `127.0.0.1`, `localhost` o `::1`. Para exponer OpenCode fuera de loopback, Linear Crew exige autenticación:

```powershell
$env:OPENCODE_SERVER_USERNAME = "opencode"
$env:OPENCODE_SERVER_PASSWORD = "<secret>"
linear-crew runtime --hostname 0.0.0.0
```

El scheduler y el plugin generan automáticamente el header Basic Auth desde esas variables. Los demás clientes que se conecten a ese servidor también deben proporcionar las mismas credenciales.

Las sesiones delegadas se crean sin `parentID` para que permanezcan como sesiones primarias visibles y reanudables. El scheduler siempre pasa el `directory` exacto del workspace, por lo que OpenCode carga la configuración, agentes, skills, LSP y MCP del subproyecto correspondiente.

## TUI

```bash
linear-crew tui --project <id>
```

El dashboard muestra work items, sesiones, reuniones activas, leases, handoffs, intervenciones y el event stream.

- `Ctrl+R`: actualizar.
- `Ctrl+Q`: salir.
- `/note <session-id> <contexto>`: publicar contexto humano auditable para una sesión.
- `/meeting <meeting-id> <contexto>`: publicar contexto auditable para el facilitador y todos los participantes de una reunión.
- `/work <work-item-id> <contexto>`: añadir contexto de producto a un work item.
- `/decision <work-item-id> <decisión>`: registrar una decisión durable.
- `/constraint <work-item-id> <restricción>`: registrar una restricción durable.

## API

```bash
bun run serve
```

El servidor escucha en `127.0.0.1:4317` por defecto.

```bash
curl -X POST http://127.0.0.1:4317/projects \
  -H "content-type: application/json" \
  -d '{"name":"Mi proyecto"}'
```

Las superficies principales están bajo `/projects/:projectId`; las transiciones de agregados usan rutas como `/leases/:leaseId/grant`, `/handoffs/:handoffId/acknowledge` y `/acceptances/:acceptanceId/review`. El catálogo se documenta en el design doc.

## Principio del dominio

Cada responsabilidad se liga a un outcome y revisión concretos; cada ejecución a una sesión y workspace; cada escritura a un lease vigente; cada transferencia a un handoff reconocido; y cada cierre a una aceptación independiente sobre evidencia inmutable.
