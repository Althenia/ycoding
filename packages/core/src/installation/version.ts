declare global {
  const YCODING_VERSION: string
  const YCODING_CHANNEL: string
}

export const InstallationVersion = typeof YCODING_VERSION === "string" ? YCODING_VERSION : "local"
export const InstallationChannel = typeof YCODING_CHANNEL === "string" ? YCODING_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
