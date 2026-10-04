import { Agent } from "@ycoding-ai/core/agent"
import { AISDK } from "@ycoding-ai/core/aisdk"
import { Catalog } from "@ycoding-ai/core/catalog"
import { Command } from "@ycoding-ai/core/command"
import { Credential } from "@ycoding-ai/core/credential"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@ycoding-ai/core/effect/app-node-platform"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { FileSystem } from "@ycoding-ai/core/filesystem"
import { FSUtil } from "@ycoding-ai/core/fs-util"
import { Global } from "@ycoding-ai/core/global"
import { Integration } from "@ycoding-ai/core/integration"
import { Location } from "@ycoding-ai/core/location"
import { Npm } from "@ycoding-ai/core/npm"
import { PluginRegistry } from "@ycoding-ai/core/plugin"
import { PluginHooks } from "@ycoding-ai/core/plugin/hooks"
import { PluginRuntime } from "@ycoding-ai/core/plugin/runtime"
import { ProviderUsageRuntime } from "@ycoding-ai/core/provider-usage"
import { Reference } from "@ycoding-ai/core/reference"
import { Skill } from "@ycoding-ai/core/skill"
import { ToolHooks } from "@ycoding-ai/core/tool/hooks"
import { ToolRegistry } from "@ycoding-ai/core/tool/registry"
import { Effect, Layer } from "effect"
import { tempLocationLayer } from "../fixture/location"

const npmLayer = Layer.succeed(
  Npm.Service,
  Npm.Service.of({
    add: () => Effect.succeed({ directory: "", entrypoint: undefined }),
    install: () => Effect.void,
    which: () => Effect.succeed(undefined),
  }),
)

const providerUsageLayer = Layer.succeed(
  ProviderUsageRuntime.Service,
  ProviderUsageRuntime.make({
    credentials: { all: () => Effect.succeed([]) },
    providers: { available: () => Effect.succeed([]) },
    adapters: {},
  }),
)

export const PluginTestLayer = AppNodeBuilder.build(
  LayerNode.group([
    FileSystem.node,
    FSUtil.node,
    Global.node,
    Location.node,
    Npm.node,
    Credential.node,
    EventRuntime.node,
    LayerNodePlatform.httpClient,
    PluginRegistry.node,
    Agent.node,
    AISDK.node,
    Catalog.node,
    Command.node,
    Integration.node,
    PluginRuntime.node,
    ProviderUsageRuntime.node,
    PluginHooks.node,
    Reference.node,
    Skill.node,
    ToolHooks.node,
    ToolRegistry.toolsNode,
  ]),
  [
    [Location.node, tempLocationLayer],
    [Npm.node, npmLayer],
    [ProviderUsageRuntime.node, providerUsageLayer],
  ],
) as unknown as Layer.Layer<unknown, never>
