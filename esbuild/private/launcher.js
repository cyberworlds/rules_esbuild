const { readFileSync, writeFileSync } = require('fs')
const { pathToFileURL } = require('url')
const { join } = require('path')
const esbuild = require('esbuild')
const { bazelSandboxPlugin } = require('./plugins/bazel-sandbox.js')

function getFlag(flag, required = true) {
  const argvFlag = process.argv.find((arg) => arg.startsWith(`${flag}=`))
  if (!argvFlag) {
    if (required) {
      console.error(`Expected flag '${flag}' passed to launcher, but not found`)
      process.exit(1)
    }
    return
  }
  return argvFlag.split('=')[1]
}

function getEsbuildArgs(paramsFilePath) {
  try {
    return JSON.parse(readFileSync(paramsFilePath, { encoding: 'utf8' }))
  } catch (e) {
    console.error('Error while reading esbuild flags param file', e)
    process.exit(1)
  }
}

async function processConfigFile(configFilePath, existingArgs = {}) {
  const fullConfigFileUrl = pathToFileURL(join(process.cwd(), configFilePath))
  let config
  try {
    config = await import(fullConfigFileUrl)
  } catch (e) {
    console.error(
      `Error while loading configuration '${fullConfigFileUrl}':\n`,
      e
    )
    process.exit(1)
  }

  if (!config.default) {
    console.error(
      `Config file '${configFilePath}' was loaded, but did not export a configuration object as default`
    )
    process.exit(1)
  }

  config = config.default

  // These keys of the config can not be overriden
  const IGNORED_CONFIG_KEYS = [
    'bundle',
    'entryPoints',
    'external',
    'metafile',
    'outdir',
    'outfile',
    'preserveSymlinks',
    'sourcemap',
    'splitting',
  ]

  const MERGE_CONFIG_KEYS = ['define']

  return Object.entries(config).reduce((prev, [key, value]) => {
    if (value === null || value === void 0) {
      return prev
    }

    if (IGNORED_CONFIG_KEYS.includes(key)) {
      console.error(
        `[WARNING] esbuild configuration property '${key}' from '${configFilePath}' will be ignored and overridden`
      )
    } else if (
      MERGE_CONFIG_KEYS.includes(key) &&
      existingArgs.hasOwnProperty(key)
    ) {
      // values from the rule override the config file
      // perform a naive merge
      if (Array.isArray(value)) {
        prev[key] = [...value, ...existingArgs[key]]
      } else if (typeof value === 'object') {
        prev[key] = {
          ...value,
          ...existingArgs[key],
        }
      } else {
        // can't merge
        console.error(
          `[WARNING] esbuild configuration property '${key}' from '${configFilePath}' could not be merged`
        )
      }
    } else {
      prev[key] = value
    }
    return prev
  }, {})
}

if (!process.env.ESBUILD_BINARY_PATH) {
  console.error('Expected environment variable ESBUILD_BINARY_PATH to be set')
  process.exit(1)
}

async function runOneBuild(args, userArgsFilePath, configFilePath) {
  if (userArgsFilePath) {
    args = {
      ...args,
      ...getEsbuildArgs(userArgsFilePath),
    }
  }

  if (configFilePath) {
    const config = await processConfigFile(configFilePath, args)
    args = {
      ...args,
      ...config,
    }
  }

  const plugins = []
  if (!!process.env.ESBUILD_BAZEL_SANDBOX_PLUGIN) {
    // onResolve plugin, must be first to occur.
    plugins.push(bazelSandboxPlugin())
  }
  if (args.plugins !== undefined) {
    plugins.push(...args.plugins)
  }
  args.plugins = plugins

  try {
    const result = await esbuild.build(args)
    if (result.metafile) {
      const metafile = getFlag('--metafile')
      writeFileSync(metafile, JSON.stringify(result.metafile))
    }
  } catch (e) {
    // NOTE(calebmer): Simplify error message. If `args.logLevel` is not silent
    // then any build errors will have already been logged. Don't log them again.
    // There may be cases where we silence errors that's thrown in JavaScript
    // that's not logged by esbuild's native error logger. We'll address those
    // issues as we see them.
    //
    // This is the error message we're silencing:
    // https://github.com/evanw/esbuild/blob/9eca46464ed5615cb36a3beb3f7a7b9a8ffbe7cf/lib/shared/common.ts#L975
    const hasAlreadyLogged =
      args.logLevel !== "silent" &&
      e instanceof Error &&
      /Build failed with \d+ errors?:/.test(e.message)

    if (!hasAlreadyLogged) console.error(e)
    process.exit(1)
  }
}

runOneBuild(
  getEsbuildArgs(getFlag('--esbuild_args')),
  getFlag('--user_args', false),
  getFlag('--config_file', false)
)
