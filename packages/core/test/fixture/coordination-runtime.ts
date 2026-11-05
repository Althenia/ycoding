import { Layer } from "effect"
import { makeGlobalNode } from "../../src/effect/app-node"
import { CoordinationRuntime } from "../../src/session/coordination-runtime"

export const inertRuntime = [
  CoordinationRuntime.node,
  makeGlobalNode({ service: CoordinationRuntime.Service, layer: Layer.mock(CoordinationRuntime.Service, {}), deps: [] }),
] as const
