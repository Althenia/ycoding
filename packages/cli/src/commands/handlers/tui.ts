import { TuiCommand } from "../tui"
import { Runtime } from "../../framework/runtime"
import { runTui } from "./tui-shared"

export default Runtime.handler(TuiCommand, runTui)
