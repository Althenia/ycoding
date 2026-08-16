import { getComponentCatalogue } from "@opentui/solid/components"
import { registerSpinner } from "opentui-spinner/solid"

export function registerYCodingSpinner() {
  if (!getComponentCatalogue().spinner) registerSpinner()
}
