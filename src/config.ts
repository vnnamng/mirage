// YAML → mirage Workspace.
//
// A workspace file declares mounts (what backs each virtual path), runtimes
// (which engine answers python3, and with which packages), and the workspace
// options that make sense in a config file. Everything is validated with a
// strict schema so a typo in a key fails loudly with its path, instead of
// silently falling back to a default.
//
//   name: analyst
//   mode: exec                      # default mount mode: read | write | exec
//   mounts:
//     /data:
//       type: ram
//       description: Inputs, in memory only.
//       seed:
//         sales.csv: |              # inline text
//           region,units
//           north,10
//         notes.txt: { file: ./fixtures/notes.txt }   # host file, relative to the yaml
//     /out:
//       type: disk
//       root: ./vfs/${TENANT_ID}    # ${VAR} from vars, then the environment
//       mode: write                 # per-mount override
//       clean: [summary.csv]        # delete these under root before start
//   runtimes:
//     - type: pyodide
//       config:
//         packages: [numpy, pandas] # preloaded at init
//         denyPackages: [requests]  # import fails inside the guest
//     - vfs                         # the shell's own builtins
//
// Values may contain ${NAME} or ${NAME:-default}. Names resolve from the
// `vars` passed by the caller first, then process.env.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import type { Resource } from '@struktoai/mirage-core/resource/base'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import {
  DiskResource,
  Mount,
  OpsRegistry,
  PathSpec,
  RAMResource,
  RedisResource,
  S3Resource,
  Workspace,
  type MountMode,
} from '@struktoai/mirage-node'
import { PyodideRuntime } from '@struktoai/mirage-core/runtime/python/pyodide'

// ── schema ───────────────────────────────────────────────────

/**
 * Paths the Pyodide interpreter owns inside its Emscripten filesystem. A mount
 * at /lib hides the stdlib and the preloaded site-packages, so `import numpy`
 * fails with no hint of why; /dev and /proc are the kernel's.
 */
const RESERVED_PREFIXES = new Set(['/lib', '/dev', '/proc', ''])

const ModeSchema = z.enum(['read', 'write', 'exec'])
const BackendSchema = z.enum(['vfs', 'fuse', 'fskit'])

/** A seed file: inline text, or a host file (text or binary) to copy in. */
const SeedSchema = z.union([z.string(), z.strictObject({ file: z.string() })])

const mountCommon = {
  /** Shown to the agent in the system prompt's mount table. */
  description: z.string().optional(),
  /** Per-mount mode; falls back to the workspace `mode`. */
  mode: ModeSchema.optional(),
  /** vfs (default) keeps the mount inside mirage; fuse/fskit also expose a kernel mountpoint. */
  backend: BackendSchema.optional(),
  /** Kernel mountpoint for fuse/fskit; ignored for vfs. */
  mountpoint: z.string().optional(),
  /** Files to create under this mount before it is mounted (so read-only mounts can be seeded too). */
  seed: z.record(z.string().min(1), SeedSchema).optional(),
  /**
   * Host directory whose whole tree is copied into the mount root before it
   * is mounted (relative to the yaml). For vendored code, fixtures, or any
   * tree that must live in RAM.
   */
  seedDir: z.string().min(1).optional(),
}

const RamMountSchema = z.strictObject({ type: z.literal('ram'), ...mountCommon })

const DiskMountSchema = z.strictObject({
  type: z.literal('disk'),
  /** Host directory; relative paths resolve against the yaml file's directory. */
  root: z.string().min(1),
  /** Delete the whole root before start. */
  wipe: z.boolean().optional(),
  /** Delete these files (relative to root) before start. */
  clean: z.array(z.string().min(1)).optional(),
  ...mountCommon,
})

// Passed to the resource constructor as-is. Not exercised by this project's
// tests; consult @struktoai/mirage-node for the accepted keys.
const S3MountSchema = z.strictObject({ type: z.literal('s3'), options: z.record(z.string(), z.unknown()), ...mountCommon })
const RedisMountSchema = z.strictObject({ type: z.literal('redis'), options: z.record(z.string(), z.unknown()), ...mountCommon })

const MountSchema = z.discriminatedUnion('type', [RamMountSchema, DiskMountSchema, S3MountSchema, RedisMountSchema])

/** Every knob the Pyodide runtime accepts (mirrors PyodideConfig). */
const PyodideConfigSchema = z.strictObject({
  /**
   * Loaded at init, before the first run. Each entry is a distribution
   * package name, an https URL to a wheel, or a path to a wheel on the host
   * (relative to the yaml). URL and path entries may be compiled wasm32
   * wheels, but only ones built for this interpreter's ABI
   * (cp314, pyemscripten_2026_0); pure-python wheels also work here.
   */
  packages: z.array(z.string().min(1)).optional(),
  /** Imports of these fail inside the guest, and their wheels are never fetched. */
  denyPackages: z.array(z.string().min(1)).optional(),
  /** Fetch wheels lazily for imports the code mentions (default true). */
  autoLoadFromImports: z.boolean().optional(),
  /** Python run once after the interpreter loads. */
  bootstrapCode: z.string().optional(),
  /** Mount paths (or .whl files) prepended to sys.path, so `import x` finds vendored code. */
  sysPath: z.array(z.string().min(1)).optional(),
  /** Where the pyodide distribution lives (indexURL). Default: the npm package. */
  home: z.string().optional(),
  /** Base URL for package wheels. */
  packageBaseUrl: z.string().optional(),
  /** Lock file URL for the package index. */
  lockFileURL: z.string().optional(),
})

const PyodideRuntimeSchema = z.strictObject({
  type: z.literal('pyodide'),
  /** Commands this runtime claims; default python3 and python. */
  captures: z.array(z.string().min(1)).optional(),
  config: PyodideConfigSchema.optional(),
})

/** A runtime entry: a mirage shorthand name (vfs, quickjs, ...) or a configured engine. */
const RuntimeSchema = z.union([z.string().min(1), PyodideRuntimeSchema])

export const WorkspaceConfigSchema = z.strictObject({
  /** Free label, echoed in errors and the chat banner. */
  name: z.string().optional(),
  /** Default mount mode. exec is required for python3 to run scripts from a mount. */
  mode: ModeSchema.default('exec'),
  mounts: z.record(z.string(), MountSchema).superRefine((m, ctx) => {
    if (Object.keys(m).length === 0) ctx.addIssue({ code: 'custom', message: 'at least one mount is required' })
    for (const prefix of Object.keys(m)) {
      if (!/^\/[^\s]*$/.test(prefix)) {
        ctx.addIssue({ code: 'custom', path: [prefix], message: 'mount prefix must be an absolute path like /data' })
      } else if (RESERVED_PREFIXES.has(prefix.replace(/\/+$/, ''))) {
        ctx.addIssue({
          code: 'custom',
          path: [prefix],
          message: `${prefix} is reserved by the Pyodide interpreter (/lib holds the stdlib and site-packages); mounting there shadows it`,
        })
      }
    }
  }),
  /**
   * Ordered runtime world; the first entry that captures a command wins.
   * Omitted = mirage's default world (pyodide with no preloaded packages, quickjs, vfs).
   */
  runtimes: z.array(RuntimeSchema).optional(),
  /** Workspace-level python defaults, applied when no pyodide entry overrides them. */
  python: z
    .strictObject({
      autoLoadFromImports: z.boolean().optional(),
      bootstrapCode: z.string().optional(),
      denyPackages: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  /** Scalar Workspace options that make sense in a file. */
  options: z
    .strictObject({
      workspaceId: z.string().optional(),
      agentId: z.string().optional(),
      sessionId: z.string().optional(),
      cacheLimit: z.union([z.string(), z.number()]).optional(),
    })
    .optional(),
})

export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>
export type MountConfig = z.infer<typeof MountSchema>
export type PyodideConfig = z.infer<typeof PyodideConfigSchema>

// ── variables ────────────────────────────────────────────────

const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g

/** Replace ${NAME} / ${NAME:-default} in every string of a parsed document. */
export function substituteVars(value: unknown, vars: Record<string, string>, path = '$'): unknown {
  if (typeof value === 'string') {
    return value.replace(VAR_RE, (_, name: string, fallback: string | undefined) => {
      const v = vars[name] ?? process.env[name] ?? fallback
      if (v === undefined) throw new WorkspaceConfigError(`${path}: unresolved variable \${${name}}`)
      return v
    })
  }
  if (Array.isArray(value)) return value.map((v, i) => substituteVars(v, vars, `${path}[${i}]`))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, substituteVars(v, vars, `${path}.${k}`)]),
    )
  }
  return value
}

export class WorkspaceConfigError extends Error {
  override name = 'WorkspaceConfigError'
}

// ── parse ────────────────────────────────────────────────────

export interface ParseOptions {
  /** Values for ${NAME} references; the environment is the fallback. */
  vars?: Record<string, string>
  /** Used in error messages. */
  source?: string
}

export function parseWorkspaceConfig(yamlText: string, options: ParseOptions = {}): WorkspaceConfig {
  const label = options.source ?? '<yaml>'
  let doc: unknown
  try {
    doc = parseYaml(yamlText)
  } catch (err) {
    throw new WorkspaceConfigError(`${label}: invalid YAML: ${(err as Error).message}`)
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new WorkspaceConfigError(`${label}: top level must be a mapping`)
  }
  const substituted = substituteVars(doc, options.vars ?? {})
  const result = WorkspaceConfigSchema.safeParse(substituted)
  if (!result.success) {
    throw new WorkspaceConfigError(`${label}: invalid workspace config\n${z.prettifyError(result.error)}`)
  }
  return result.data
}

// ── build ────────────────────────────────────────────────────

export interface BuildOptions {
  /** Directory relative paths (disk roots, seed files) resolve against. */
  baseDir?: string
}

export interface BuiltWorkspace {
  ws: Workspace
  config: WorkspaceConfig
  /** Prefix → description, for buildSystemPrompt({ mountInfo }). */
  mountInfo: Record<string, string>
  /** Prefix → resolved host root for disk mounts. */
  diskRoots: Record<string, string>
}

function resolveFrom(baseDir: string, p: string): string {
  return isAbsolute(p) ? p : resolve(baseDir, p)
}

function describe(prefix: string, m: MountConfig): string {
  if (m.description) return m.description
  switch (m.type) {
    case 'ram':
      return `In-memory filesystem at ${prefix}.`
    case 'disk':
      return `Disk-backed filesystem at ${prefix}.`
    default:
      return `${m.type} mount at ${prefix}.`
  }
}

function buildResource(prefix: string, m: MountConfig, baseDir: string, diskRoots: Record<string, string>) {
  switch (m.type) {
    case 'ram':
      return new RAMResource()
    case 'disk': {
      const root = resolveFrom(baseDir, m.root)
      if (m.wipe) rmSync(root, { recursive: true, force: true })
      mkdirSync(root, { recursive: true })
      for (const name of m.clean ?? []) rmSync(join(root, name), { force: true })
      diskRoots[prefix] = root
      return new DiskResource({ root })
    }
    case 's3':
      return new S3Resource(m.options as any)
    case 'redis':
      return new RedisResource(m.options as any)
  }
}

/** A distribution name, an https URL, or a host wheel path made absolute. */
function resolvePackage(entry: string, baseDir: string): string {
  if (/^https?:\/\//.test(entry)) return entry
  if (!entry.endsWith('.whl')) return entry
  const path = resolveFrom(baseDir, entry)
  if (!existsSync(path)) throw new WorkspaceConfigError(`packages: wheel not found: ${path}`)
  return path
}

function buildRuntime(entry: z.infer<typeof RuntimeSchema>, baseDir: string) {
  if (typeof entry === 'string') return entry
  switch (entry.type) {
    case 'pyodide': {
      const config = entry.config
        ? { ...entry.config, ...(entry.config.packages ? { packages: entry.config.packages.map((p) => resolvePackage(p, baseDir)) } : {}) }
        : undefined
      return new PyodideRuntime({
        ...(entry.captures ? { captures: entry.captures } : {}),
        ...(config ? { config } : {}),
      })
    }
  }
}

/** Instantiate the workspace a config describes and apply its seeds. */
export async function buildWorkspace(config: WorkspaceConfig, options: BuildOptions = {}): Promise<BuiltWorkspace> {
  const baseDir = options.baseDir ?? process.cwd()
  const ops = new OpsRegistry()
  const resources: Record<string, Mount> = {}
  const mountInfo: Record<string, string> = {}
  const diskRoots: Record<string, string> = {}

  for (const [prefix, m] of Object.entries(config.mounts)) {
    const resource = buildResource(prefix, m, baseDir, diskRoots)
    // Seeds go straight into the resource, before any mount mode applies.
    if (m.seedDir) await seedResource(resource, prefix, collectDir(resolveFrom(baseDir, m.seedDir), prefix), baseDir)
    await seedResource(resource, prefix, m.seed ?? {}, baseDir)
    for (const op of resource.ops()) ops.register(op)
    resources[prefix] = new Mount(resource, {
      ...(m.mode ? { mode: m.mode as MountMode } : {}),
      ...(m.backend ? { backend: m.backend } : {}),
      ...(m.mountpoint ? { mountpoint: m.mountpoint } : {}),
    })
    mountInfo[prefix] = describe(prefix, m)
  }

  const ws = new Workspace(resources, {
    mode: config.mode as MountMode,
    ops,
    ...(config.runtimes ? { runtimes: config.runtimes.map((r) => buildRuntime(r, baseDir)) } : {}),
    ...(config.python ? { python: config.python } : {}),
    ...(config.options ?? {}),
  })

  return { ws, config, mountInfo, diskRoots }
}

type Seed = z.infer<typeof SeedSchema>

async function seedResource(resource: Resource, prefix: string, seeds: Record<string, Seed>, baseDir: string): Promise<void> {
  const names = Object.keys(seeds)
  if (names.length === 0) return
  if (typeof resource.writeFile !== 'function') {
    throw new WorkspaceConfigError(`${prefix}: this mount type cannot be seeded`)
  }
  const base = prefix.replace(/\/$/, '')
  for (const name of names) {
    const rel = name.replace(/^\/+/, '')
    const seed = seeds[name]
    const bytes =
      typeof seed === 'string' ? new TextEncoder().encode(seed) : readSeedFile(resolveFrom(baseDir, seed.file), prefix, name)
    const slash = rel.lastIndexOf('/')
    if (slash > 0 && typeof resource.mkdir === 'function') {
      const dir = rel.slice(0, slash)
      await resource.mkdir(PathSpec.fromStrPath(`${base}/${dir}`, dir), { recursive: true })
    }
    await resource.writeFile(PathSpec.fromStrPath(`${base}/${rel}`, rel), bytes)
  }
}

/** Every file under `dir` as a seed map keyed by mount-relative path. */
function collectDir(dir: string, prefix: string): Record<string, Seed> {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new WorkspaceConfigError(`${prefix}: seedDir is not a directory: ${dir}`)
  }
  const out: Record<string, Seed> = {}
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(relPath)
      else if (entry.isFile()) out[relPath] = { file: join(dir, relPath) }
    }
  }
  walk('')
  return out
}

function readSeedFile(path: string, prefix: string, name: string): Uint8Array {
  if (!existsSync(path)) {
    throw new WorkspaceConfigError(`seed ${prefix}/${name}: host file not found: ${path}`)
  }
  return new Uint8Array(readFileSync(path))
}

/** Read, validate, and build a workspace from a yaml file. */
export async function loadWorkspace(file: string, options: ParseOptions & BuildOptions = {}): Promise<BuiltWorkspace> {
  const path = resolve(file)
  if (!existsSync(path)) throw new WorkspaceConfigError(`workspace file not found: ${path}`)
  const config = parseWorkspaceConfig(readFileSync(path, 'utf8'), { vars: options.vars, source: path })
  return buildWorkspace(config, { baseDir: options.baseDir ?? dirname(path) })
}
