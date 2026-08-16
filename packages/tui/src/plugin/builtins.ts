import HomeFooter from "../feature-plugins/home/footer"
import SidebarContext from "../feature-plugins/sidebar/context"
import SidebarFooter from "../feature-plugins/sidebar/footer"
import SidebarGuardrails from "../feature-plugins/sidebar/guardrails"
import SidebarLsp from "../feature-plugins/sidebar/lsp"
import SidebarMcp from "../feature-plugins/sidebar/mcp"
import SidebarTodo from "../feature-plugins/sidebar/todo"
import DiffViewer from "../feature-plugins/system/diff-viewer"
import Notifications from "../feature-plugins/system/notifications"
import Scrap from "../feature-plugins/system/scrap"

export const builtins = [
  Notifications,
  HomeFooter,
  SidebarContext,
  SidebarGuardrails,
  SidebarMcp,
  SidebarTodo,
  SidebarLsp,
  SidebarFooter,
  Scrap,
  DiffViewer,
]
