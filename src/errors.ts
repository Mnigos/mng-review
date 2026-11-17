/** A problem with `.mng/` files or CLI input. The CLI exits with code 2. */
export class ConfigError extends Error {
  override name = 'ConfigError'
}
