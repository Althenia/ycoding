import HomeFooter from "../feature-plugins/home/footer"
import SidebarContext from "../feature-plugins/sidebar/context"
import SidebarFooter from "../feature-plugins/sidebar/footer"
import SidebarMcp from "../feature-plugins/sidebar/mcp"
import SidebarShells from "../feature-plugins/sidebar/shells"
import SidebarSkills from "../feature-plugins/sidebar/skills"
import SidebarSubagents from "../feature-plugins/sidebar/subagents"
import SidebarTodo from "../feature-plugins/sidebar/todo"
import DiffViewer from "../feature-plugins/system/diff-viewer"
import Notifications from "../feature-plugins/system/notifications"
import Scrap from "../feature-plugins/system/scrap"

export const builtins = [
  Notifications,
  HomeFooter,
  SidebarContext,
  SidebarSubagents,
  SidebarShells,
  SidebarSkills,
  SidebarMcp,
  SidebarTodo,
  SidebarFooter,
  Scrap,
  DiffViewer,
]
