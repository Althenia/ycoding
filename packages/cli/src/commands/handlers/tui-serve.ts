import { TuiCommand } from "../tui"
import { Runtime } from "../../framework/runtime"
import { runServe } from "./serve-shared"

export default Runtime.handler(TuiCommand.commands.serve, runServe)
