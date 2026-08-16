import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { runServe } from "./serve-shared"

export default Runtime.handler(Commands.commands.serve, runServe)
