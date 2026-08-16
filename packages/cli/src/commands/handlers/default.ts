import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { runTui } from "./tui-shared"

export default Runtime.handler(Commands, runTui)
