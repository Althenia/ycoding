import HomeFooter from "../feature-plugins/home/footer"
import SidebarContext from "../feature-plugins/sidebar/context"
import SidebarFooter from "../feature-plugins/sidebar/footer"
import SidebarMcp from "../feature-plugins/sidebar/mcp"
import SidebarSubagents from "../feature-plugins/sidebar/subagents"
import SidebarTodo from "../feature-plugins/sidebar/todo"
import DiffViewer from "../feature-plugins/system/diff-viewer"
import { createNotifications } from "../feature-plugins/system/notifications"
import type { ExternalNotificationKind } from "../util/coordination"
import Scrap from "../feature-plugins/system/scrap"

export const createBuiltins = (externalAllowed?: (sessionID: string, kind: ExternalNotificationKind) => boolean) => [
  createNotifications(undefined, externalAllowed),
  HomeFooter,
  SidebarContext,
  SidebarTodo,
  SidebarSubagents,
  SidebarMcp,
  SidebarFooter,
  Scrap,
  DiffViewer,
]

export const builtins = createBuiltins()
