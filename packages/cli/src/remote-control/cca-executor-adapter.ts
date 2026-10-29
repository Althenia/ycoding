import { statSync } from "node:fs"
import os from "node:os"
import { type CcaRpcConnection, type CcaRpcHandler, type CcaEnvironmentCapabilities, type CcaEnvironmentInfo } from "./cca-executor-rpc"
import { discoverCcaCapabilityRoots, type CcaCapabilityFileSystem } from "./cca-capability-discovery"
import { createCcaCapabilityDiscoveryV2 } from "./cca-capability-discovery-v2"
import { readCcaEnvironmentConfig, type CcaEnvironmentConfigOptions } from "./cca-environment-config"
import { ccaRpcConnection } from "./cca-executor-connection"
import {
  CCA_NETWORK_POLICY_DECISION_METHOD,
  CCA_NETWORK_POLICY_TRANSPORT_MARGIN_MS,
  createCcaNetworkPolicyDecider,
  encodeCcaNetworkPolicyDecisionNotification,
} from "./cca-executor-process-wire"
import {
  createCcaExecutor,
  ccaEnvironmentInfo,
  type CcaExecutorHandler,
  type CcaExecutorOptions,
  type CcaNetworkPolicyHooks,
  type CcaNetworkPolicyInput,
} from "@ycoding-ai/core/cca/executor"
import { ccaNetworkProxyCapabilities, type CcaNetworkProxyCapabilities } from "@ycoding-ai/core/cca/network-proxy"
import { CcaPolicy } from "@ycoding-ai/core/cca/policy"

export interface CcaRpcAdapterEnvironmentInfoOverrides {
  readonly shell?: { readonly name: string; readonly path: string }
  readonly executorVersion?: string
  readonly providerId?: string
  readonly userHomeDir?: string
  readonly tempDir?: string
  readonly prependPathDirs?: readonly string[]
}

export interface CcaRpcAdapterOptions extends Omit<CcaExecutorOptions, "networkPolicy"> {
  readonly environmentInfo?: CcaRpcAdapterEnvironmentInfoOverrides
  readonly environmentConfig?: Partial<Omit<CcaEnvironmentConfigOptions, "homeDirectory">>
}

export interface CcaRpcAdapter {
  readonly handler: CcaRpcHandler
  readonly createDirectory: CcaExecutorHandler["createDirectory"]
  readonly environmentInfo: () => CcaEnvironmentInfo
  readonly close: () => Promise<void>
}

function existingDirectory(directory: string) {
  try {
    return statSync(directory).isDirectory()
  } catch {
    return false
  }
}

function officialCapabilities(
  base: CcaEnvironmentCapabilities,
  network: CcaNetworkProxyCapabilities,
  maskingAvailable: boolean,
): CcaEnvironmentCapabilities {
  return {
    networkProxyLaunch: network.networkProxyLaunch,
    ...(network.networkProxyReviewDomains ? { networkProxyReviewDomains: true } : {}),
    ...(maskingAvailable && network.credentialMasking ? { credentialMasking: true } : {}),
    ...(maskingAvailable && network.credentialMaskingCustomProviders ? { credentialMaskingCustomProviders: true } : {}),
    capabilityDiscoverySandbox: true,
    capabilityDiscoveryV2: true,
    environmentConfigRead: true,
    httpHeaderEnvVars: true,
    sandboxedFileStreaming: true,
    fileWriteStreaming: true,
    shellSnapshotV2: network.shellSnapshotV2,
    windowsMxc: base.windowsMxc ?? false,
    ...(base.linuxRootWritePreservesDevices ? { linuxRootWritePreservesDevices: true } : {}),
    ...(base.linuxApprovedRootWritePreservesRestrictions ? { linuxApprovedRootWritePreservesRestrictions: true } : {}),
  }
}

function networkPolicy({ processId, launch, call, notify, signal }: CcaNetworkPolicyInput): CcaNetworkPolicyHooks {
  const controllerTimeoutMs = launch.policyDecisionTimeoutMs
  return {
    ...(controllerTimeoutMs === undefined
      ? {}
      : {
          decider: createCcaNetworkPolicyDecider({
            processId,
            controllerTimeoutMs,
            signal,
            call: (method, params, abort) =>
              call(method, params, { signal: abort, timeoutMs: controllerTimeoutMs + CCA_NETWORK_POLICY_TRANSPORT_MARGIN_MS }),
          }),
        }),
    onPolicyDecision: (event) => notify(CCA_NETWORK_POLICY_DECISION_METHOD, encodeCcaNetworkPolicyDecisionNotification(processId, event)),
  }
}

export function createCcaRpcAdapter(options: CcaRpcAdapterOptions): CcaRpcAdapter {
  const executor = createCcaExecutor({ ...options, networkPolicy })

  const envOverrides = options.environmentInfo
  const userHomeDir = envOverrides?.userHomeDir ?? os.homedir()
  const base = ccaEnvironmentInfo({
    cwd: userHomeDir,
    ...(envOverrides?.shell ? { shell: envOverrides.shell } : {}),
    ...(envOverrides?.executorVersion ? { executorVersion: envOverrides.executorVersion } : {}),
    userHomeDir,
    tempDir: envOverrides?.tempDir ?? os.tmpdir(),
  })
  const prependPathDirs = (envOverrides?.prependPathDirs ?? []).filter(existingDirectory).map((directory) => CcaPolicy.toPathUri(directory))
  const info: CcaEnvironmentInfo = {
    shell: base.shell,
    ...(base.executorVersion === undefined ? {} : { executorVersion: base.executorVersion }),
    ...(envOverrides?.providerId === undefined ? {} : { providerId: envOverrides.providerId }),
    ...(base.cwd === undefined ? {} : { cwd: base.cwd }),
    ...(base.userHomeDir === undefined ? {} : { userHomeDir: base.userHomeDir }),
    ...(base.platformOs === undefined ? {} : { platformOs: base.platformOs }),
    ...(prependPathDirs.length === 0 ? {} : { prependPathDirs }),
    ...(base.temporaryDirectories === undefined ? {} : { temporaryDirectories: base.temporaryDirectories }),
    ...(base.tempDir === undefined ? {} : { tempDir: base.tempDir }),
    capabilities: officialCapabilities(
      base.capabilities,
      ccaNetworkProxyCapabilities({ shell: base.shell.path }),
      options.networkProxyCaDirectory !== undefined,
    ),
  }

  const capabilityFileSystem: CcaCapabilityFileSystem = { openReadTree: executor.openReadTree }

  const environmentConfig = (): CcaEnvironmentConfigOptions => ({
    homeDirectory: userHomeDir,
    ...(process.env.CODEX_HOME === undefined ? {} : { codexHomeEnv: process.env.CODEX_HOME }),
    ...options.environmentConfig,
  })

  const openRpcConnection = (): CcaRpcConnection => {
    const connection = ccaRpcConnection(executor.openConnection())
    const { homeDirectory, codexHomeEnv, systemConfigPath } = environmentConfig()
    const discovery = createCcaCapabilityDiscoveryV2({
      fs: capabilityFileSystem,
      environment: {
        homeDirectory,
        ...(codexHomeEnv === undefined ? {} : { codexHomeEnv }),
        ...(systemConfigPath === undefined ? {} : { systemConfigPath }),
      },
    })
    return {
      methods: {
        ...connection.methods,
        "capabilities/discoverV2": async (params, ctx) => ({ result: await discovery.discover(params, ctx) }),
      },
      close: async () => {
        await discovery.close()
        await connection.close()
      },
    }
  }

  const handler: CcaRpcHandler = {
    ...executor,
    readEnvironmentConfig: (params) => readCcaEnvironmentConfig(params, environmentConfig()),
    discoverCapabilityRoots: (params, ctx) => discoverCcaCapabilityRoots(capabilityFileSystem, params, ctx),
    openRpcConnection,
  }

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    await executor.close()
  }

  return {
    handler,
    createDirectory: executor.createDirectory,
    environmentInfo: () => info,
    close,
  }
}
