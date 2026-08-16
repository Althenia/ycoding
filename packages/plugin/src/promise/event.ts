import type { EventApi } from "@ycoding-ai/client/promise/api"

export interface EventDomain extends Pick<EventApi, "subscribe"> {}
