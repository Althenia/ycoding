export function frontendBoundaryBaseline(source: string) {
  return (
    source
      .split("\nenum ConfigurationScope {")[0]
      .split("\nenum RemoteDeviceCredentialState {")[0]
      .split("\nmessage BackendPaths {")[0]
      .replace("last: 2062", "last: 2059")
      .replace("last: 3053", "last: 3052")
      .replace("  optional ConfigurationScope scope = 9;\n", "")
      .replace("  optional BackendPaths backendPaths = 4;\n", "")
      .replace("  optional RemoteDevice device = 3;\n", "")
      .trimEnd() + "\n"
  )
}

export function frontendBoundaryBaselineFields<T extends { name: string }>(name: string, fields: readonly T[]) {
  return fields.filter(
    (field) =>
      !(name === "Location_Info" && field.name === "backendPaths") &&
      !(name === "Skill_Info" && field.name === "scope") &&
      !(name === "remote_get_Result_data" && field.name === "device"),
  )
}
