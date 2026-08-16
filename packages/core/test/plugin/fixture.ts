import { AgentV2 } from "@ycoding-ai/core/agent"
import { AISDK } from "@ycoding-ai/core/aisdk"
import { Catalog } from "@ycoding-ai/core/catalog"
import { CommandV2 } from "@ycoding-ai/core/command"
import { Credential } from "@ycoding-ai/core/credential"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@ycoding-ai/core/effect/app-node-platform"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventV2 } from "@ycoding-ai/core/event"
import { FileSystem } from "@ycoding-ai/core/filesystem"
import { FSUtil } from "@ycoding-ai/core/fs-util"
import { Integration } from "@ycoding-ai/core/integration"
import { Location } from "@ycoding-ai/core/location"
import { Npm } from "@ycoding-ai/core/npm"
import { PluginV2 } from "@ycoding-ai/core/plugin"
import { PluginHooks } from "@ycoding-ai/core/plugin/hooks"
import { PluginRuntime } from "@ycoding-ai/core/plugin/runtime"
import { ProviderUsageV2 } from "@ycoding-ai/core/provider-usage"
import { Reference } from "@ycoding-ai/core/reference"
import { SkillV2 } from "@ycoding-ai/core/skill"
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
  ProviderUsageV2.Service,
  ProviderUsageV2.make({
    credentials: { all: () => Effect.succeed([]) },
    adapters: {},
  }),
)

export const PluginTestLayer = AppNodeBuilder.build(
  LayerNode.group([
    FileSystem.node,
    FSUtil.node,
    Location.node,
    Npm.node,
    Credential.node,
    EventV2.node,
    LayerNodePlatform.httpClient,
    PluginV2.node,
    AgentV2.node,
    AISDK.node,
    Catalog.node,
    CommandV2.node,
    Integration.node,
    PluginRuntime.node,
    ProviderUsageV2.node,
    PluginHooks.node,
    Reference.node,
    SkillV2.node,
    ToolHooks.node,
    ToolRegistry.toolsNode,
  ]),
  [
    [Location.node, tempLocationLayer],
    [Npm.node, npmLayer],
    [ProviderUsageV2.node, providerUsageLayer],
  ],
) as unknown as Layer.Layer<unknown, never>
