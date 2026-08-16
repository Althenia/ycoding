import type { EventApi } from "@ycoding-ai/client/effect/api"

export interface EventDomain extends Pick<EventApi<unknown>, "subscribe"> {}
