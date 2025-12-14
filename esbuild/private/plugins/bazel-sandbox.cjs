const path = require('path')
const process = require('process')
const fs = require('fs/promises')

const bindir = process.env.BAZEL_BINDIR
const execroot = process.env.JS_BINARY__EXECROOT

// Under Bazel, esbuild will follow symlinks out of the sandbox when the sandbox is enabled. See https://github.com/aspect-build/rules_esbuild/issues/58.
// This plugin using a separate resolver to detect if the the resolution has left the execroot (which is the root of the sandbox
// when sandboxing is enabled) and patches the resolution back into the sandbox.
function bazelSandboxPlugin() {
  return {
    name: 'bazel-sandbox',
    setup(build) {
      build.onResolve(
        { filter: /./, namespace: 'file' },
        async ({ path: importPath, ...otherOptions }) => {
          // NB: these lines are to prevent infinite recursion when we call `build.resolve`.
          if (otherOptions.pluginData) {
            if (otherOptions.pluginData.executedSandboxPlugin) {
              return
            }
          } else {
            otherOptions.pluginData = {}
          }
          otherOptions.pluginData.executedSandboxPlugin = true

          return await resolveInExecroot(build, importPath, otherOptions)
        }
      )
    },
  }
}

async function resolveInExecroot(build, importPath, otherOptions) {
  let result;

  // NOTE(calebmer): Relative imports are easy to resolve ourselves without
  // calling `build.resolve()`. This dramatically improves performance since
  // `build.resolve()` requires an IPC call to esbuild's go code. It takes our
  // `//app:app_client_optimize_deps` rule from building in ~40s to building
  // in ~4.
  if (importPath.startsWith(".")) {
    let resolvedPath = path.join(otherOptions.resolveDir, importPath);
    try {
      if ((await fs.lstat(resolvedPath)).isSymbolicLink()) {
        resolvedPath = await fs.readlink(path.join(otherOptions.resolveDir, importPath));
      }
      result = {path: resolvedPath};
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  if (!result) {
    result = await build.resolve(importPath, otherOptions);
  }

  if (result.errors && result.errors.length) {
    // There was an error resolving, just return the error as-is.
    return result
  }

  if (
    !result.path.startsWith('.') &&
    !result.path.startsWith('/') &&
    !result.path.startsWith('\\')
  ) {
    // Not a relative or absolute path. Likely a module resolution that is marked "external"
    return result
  }

  // If esbuild attempts to leave the execroot, map the path back into the execroot.
  if (!result.path.startsWith(execroot)) {
    // If it tried to leave bazel-bin, error out completely.
    if (!result.path.includes(bindir)) {
      throw new Error(
        `Error: esbuild resolved a path outside of BAZEL_BINDIR (${bindir}): ${result.path}`
      )
    }
    // Otherwise remap the bindir-relative path
    const correctedPath = path.join(
      execroot,
      result.path.substring(result.path.indexOf(bindir))
    )
    if (!!process.env.JS_BINARY__LOG_DEBUG) {
      console.error(
        `DEBUG: [bazel-sandbox] correcting esbuild resolution ${result.path} that left the sandbox to ${correctedPath}.`
      )
    }
    result.path = correctedPath
  }
  return result
}

module.exports = { bazelSandboxPlugin }
