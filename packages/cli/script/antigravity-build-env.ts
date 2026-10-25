export function antigravityBuildDefinitions(env: Record<string, string | undefined> = process.env) {
  return {
    YCODING_ANTIGRAVITY_OAUTH: JSON.stringify({
      clientID: env.YCODING_ANTIGRAVITY_CLIENT_ID,
      clientSecret: env.YCODING_ANTIGRAVITY_CLIENT_SECRET,
    }),
  }
}
