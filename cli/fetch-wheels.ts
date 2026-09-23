// Downloads the pure-python wheels that workspaces/scientific.yaml vendors
// through `sysPath` (packages the Pyodide distribution does not carry) and
// extracts them into workspaces/wheels/site-packages/ (gitignored).
//
//   npm run fetch:wheels
//
// Extracted rather than left as .whl files: zipimport can import a module
// from a wheel, but a package that open()s a data file next to its own
// __file__ (plotly's validators JSON, for one) needs real files.
//
// Each wheel is pinned to a version and verified against the sha256 PyPI
// publishes for it. Only `none-any` wheels are accepted: anything with
// compiled code would need a Pyodide build, not a PyPI one.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { unzipSync } from 'fflate'

export interface WheelSpec {
  name: string
  version: string
}

/**
 * Pure-python packages vendored for the scientific workspace, and why. Each
 * one's dependencies are either in the Pyodide distribution (and preloaded
 * by scientific.yaml) or listed here too.
 */
export const WHEELS: readonly WheelSpec[] = [
  { name: 'seaborn', version: '0.13.2' }, // statistical plots on matplotlib
  { name: 'plotly', version: '7.1.0' }, // interactive figures (HTML/JSON); needs narwhals + packaging, both in the distribution
  { name: 'openpyxl', version: '3.1.5' }, // .xlsx read/write, also pandas to_excel/read_excel
  { name: 'et_xmlfile', version: '2.0.0' }, // openpyxl's only dependency
  { name: 'dask', version: '2026.8.0' }, // parallel arrays/dataframes (single-threaded scheduler here); needs click, cloudpickle, fsspec, packaging, pyyaml, toolz from the distribution
  { name: 'partd', version: '1.4.2' }, // dask dependency
  { name: 'locket', version: '1.0.0' }, // partd dependency
  { name: 'autograd', version: '1.9.1' }, // automatic differentiation over numpy
  { name: 'pint', version: '0.26.1' }, // physical units; needs platformdirs + typing-extensions from the distribution
  { name: 'flexcache', version: '0.3' }, // pint dependency
  { name: 'flexparser', version: '0.4' }, // pint dependency
  { name: 'tifffile', version: '2026.9.15' }, // TIFF read/write for scientific imaging
  { name: 'scikit-posthocs', version: '0.17.0' }, // post-hoc statistical tests; needs statsmodels, seaborn
]

/**
 * Compiled packages that publish a wheel for this interpreter's ABI on PyPI
 * (cp314, pyemscripten_2026_0_wasm32, see PEP 783). These are not unpacked:
 * a compiled wheel is installed by the Pyodide loader, so scientific.yaml
 * names the file in `packages`. jiter is a small, fast JSON parser that
 * pydantic uses; it is here as the proof that the route works.
 */
export const WASM_WHEELS: readonly WheelSpec[] = [{ name: 'jiter', version: '0.17.0' }]
export const WASM_TAG = 'cp314-cp314-pyemscripten_2026_0_wasm32'

export const WHEELS_DIR = fileURLToPath(new URL('../workspaces/wheels/', import.meta.url))
/** Where the pure wheels are unpacked; this is what goes on sys.path. */
export const SITE_PACKAGES = join(WHEELS_DIR, 'site-packages')
/** Where compiled wheels are kept as files, for `packages` entries. */
export const WASM_DIR = join(WHEELS_DIR, 'wasm')

interface PypiFile {
  filename: string
  packagetype: string
  url: string
  digests: { sha256: string }
  size: number
}

/** Wheel file names and dist-info directories use the normalised name (PEP 427: `-` becomes `_`). */
export function wheelBase(spec: WheelSpec): string {
  return `${spec.name.replace(/[-.]+/g, '_')}-${spec.version}`
}

/** The `<name>-<version>.dist-info` directory a wheel unpacks to. */
function distInfo(spec: WheelSpec, site: string): string {
  return join(site, `${wheelBase(spec)}.dist-info`)
}

function extract(wheel: string, bytes: Uint8Array, site: string): number {
  const entries = unzipSync(bytes)
  let n = 0
  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith('/')) continue
    if (name.includes('..')) throw new Error(`${wheel}: refusing entry ${name}`)
    const target = join(site, name)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, data)
    n++
  }
  return n
}

async function fetchOne(spec: WheelSpec, dir: string, site: string): Promise<string> {
  const existing = readdirSync(dir).find((f) => f.startsWith(`${wheelBase(spec)}-`) && f.endsWith('.whl'))
  if (existing) {
    const path = join(dir, existing)
    if (!existsSync(distInfo(spec, site))) {
      const n = extract(existing, new Uint8Array(readFileSync(path)), site)
      console.log(`extracted ${existing}: ${n} files`)
    }
    return path
  }

  const meta = await fetch(`https://pypi.org/pypi/${spec.name}/${spec.version}/json`)
  if (!meta.ok) throw new Error(`${spec.name}==${spec.version}: PyPI returned ${meta.status}`)
  const { urls } = (await meta.json()) as { urls: PypiFile[] }
  const file = urls.find((u) => u.packagetype === 'bdist_wheel' && u.filename.endsWith('none-any.whl'))
  if (!file) throw new Error(`${spec.name}==${spec.version}: no pure-python (none-any) wheel on PyPI`)

  const res = await fetch(file.url)
  if (!res.ok) throw new Error(`${file.filename}: download failed with ${res.status}`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  const sha = createHash('sha256').update(bytes).digest('hex')
  if (sha !== file.digests.sha256) throw new Error(`${file.filename}: sha256 mismatch`)

  const path = join(dir, file.filename)
  writeFileSync(path, bytes)
  const n = extract(file.filename, bytes, site)
  console.log(`fetched ${file.filename} (${(file.size / 1024).toFixed(0)} KB), extracted ${n} files`)
  return path
}

function wasmWheelName(spec: WheelSpec): string {
  return `${wheelBase(spec)}-${WASM_TAG}.whl`
}

/** Download a compiled wheel for this ABI into `wasmDir`, kept as a file. */
async function fetchWasmOne(spec: WheelSpec, wasmDir: string): Promise<string> {
  const path = join(wasmDir, wasmWheelName(spec))
  if (existsSync(path)) return path
  const meta = await fetch(`https://pypi.org/pypi/${spec.name}/${spec.version}/json`)
  if (!meta.ok) throw new Error(`${spec.name}==${spec.version}: PyPI returned ${meta.status}`)
  const { urls } = (await meta.json()) as { urls: PypiFile[] }
  const file = urls.find((u) => u.filename === wasmWheelName(spec))
  if (!file) throw new Error(`${spec.name}==${spec.version}: no ${WASM_TAG} wheel on PyPI`)
  const res = await fetch(file.url)
  if (!res.ok) throw new Error(`${file.filename}: download failed with ${res.status}`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  const sha = createHash('sha256').update(bytes).digest('hex')
  if (sha !== file.digests.sha256) throw new Error(`${file.filename}: sha256 mismatch`)
  writeFileSync(path, bytes)
  console.log(`fetched ${file.filename} (${(file.size / 1024).toFixed(0)} KB), compiled wasm32`)
  return path
}

/**
 * Ensure every pure wheel in WHEELS is downloaded under `dir` and unpacked
 * into `dir`/site-packages, and every compiled wheel in WASM_WHEELS is
 * downloaded into `dir`/wasm; returns the wheel paths.
 */
export async function fetchWheels(dir = WHEELS_DIR): Promise<string[]> {
  const site = join(dir, 'site-packages')
  const wasm = join(dir, 'wasm')
  mkdirSync(site, { recursive: true })
  mkdirSync(wasm, { recursive: true })
  const paths: string[] = []
  for (const spec of WHEELS) paths.push(await fetchOne(spec, dir, site))
  for (const spec of WASM_WHEELS) paths.push(await fetchWasmOne(spec, wasm))
  return paths
}

/** True when every pinned wheel is already unpacked (pure) or present (compiled). */
export function wheelsPresent(dir = WHEELS_DIR): boolean {
  const site = join(dir, 'site-packages')
  const wasm = join(dir, 'wasm')
  return WHEELS.every((w) => existsSync(distInfo(w, site))) && WASM_WHEELS.every((w) => existsSync(join(wasm, wasmWheelName(w))))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  fetchWheels().then(
    (paths) => {
      console.log(`${paths.length} wheels unpacked into ${SITE_PACKAGES}`)
    },
    (err) => {
      console.error(err)
      process.exit(1)
    },
  )
}
