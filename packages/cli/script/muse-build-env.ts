export function museBuildDefinitions(env: Record<string, string | undefined> = process.env) {
  return {
    YCODING_MUSE_OAUTH: JSON.stringify({
      clientID: env.YCODING_MUSE_CLIENT_ID,
      clientSecret: env.YCODING_MUSE_CLIENT_SECRET,
    }),
  }
}
