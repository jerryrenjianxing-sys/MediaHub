# Platform operations

All requests use `scripts/mediahub.ps1 -Method <name> -ParamsJson '<JSON>'`. Add `-ConnectionFile '<absolute path>'` for an isolated profile.

| Method | Parameters | Result |
| --- | --- | --- |
| `tools.list` | `{}`; `{"refresh":true}` verifies a new signed catalog | Current installation and version records |
| `tools.status` | `{"toolId":"hyperframes"}` | One tool record |
| `tools.install` | `{"toolId":"hyperframes"}` | Operation ID; poll `tasks.get` |
| `tools.open` | `{"toolId":"...","projectId":"..."}` | Original application or component preview |
| `tools.updateEntry` / `tools.uninstallEntry` | `{"toolId":"..."}` | Component operation, or original application's management entry |
| `workspace.get` | `{}` | Current shared space |
| `projects.list` | `{}` | Projects, including absolute paths |
| `projects.create` | `{"name":"Campaign","orientation":"landscape"}` | New project; portrait also supported |
| `assets.import` | `{"path":"C:/assets/logo.png","projectId":"..."}` | Copied original in shared asset library, with stable asset ID |
| `assets.list` / `artifacts.list` | Optional `projectId` | Shared assets or registered outputs |
| `capabilities.list` | `{}` | Actual available capability IDs |
| `capabilities.describe` | `{"capabilityId":"hyperframes.render"}` | Inputs and detailed reference |
| `capabilities.invoke` | `{"capabilityId":"...","projectId":"...","options":{}}` | Task ID |
| `tasks.get` / `tasks.cancel` | `{"taskId":"..."}` | Current state; cancel waits for actual shutdown |

Task states: queued, running, cancelling, completed, failed, cancelled, interrupted. Errors have `code` and `message`. Original software retains its own account and data management; a management entry opened by MediaHub does not mean installation, update or uninstall has completed.
