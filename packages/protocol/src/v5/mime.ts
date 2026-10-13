const token = "[!#$%&'*+.^_`|~0-9A-Za-z-]+"
const mime = new RegExp(`^ *${token}/${token}(?: *; *${token} *= *(?:${token}|"(?:[ !#-\\[\\]-~]|\\\\[ -~])*"))* *$`)

export function validAssetMime(value: string) {
  return value.length <= 256 && mime.test(value)
}
