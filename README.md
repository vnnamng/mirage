# mirage RAM + disk VFS with Pyodide runtime tests

Tests for the [strukto-ai/mirage](https://github.com/strukto-ai/mirage) TypeScript
package: a RAM mount at `/data` for inputs and a disk mount at `/out` (the `vfs/` folder) for outputs, with `python3`
answered by the Pyodide runtime (CPython compiled to WebAssembly) and numpy + pandas
preloaded.

Two test files:

| File | Needs API key | What it proves |
| --- | --- | --- |
| `tests/pyodide-direct.test.ts` | no | `python3` runs inside Pyodide, sees both mounts, numpy solves a linear system (solve / inv / det / eigvals), pandas `read_csv` reads a seeded CSV, aggregates, and `to_csv` writes to `/out`, which lands in `vfs/` on the host disk. |
| `tests/deepagents-pyodide.test.ts` | yes | A [deepagents](https://github.com/langchain-ai/deepagentsjs) agent on the Anthropic API, with the mirage workspace as its sandbox backend, is asked to do the same numpy and pandas work and write `/out/solution.json` and `/out/summary.csv`. The test asserts the files' contents and that the agent actually ran python through the `execute` tool. Skipped when `ANTHROPIC_API_KEY` is unset. |
| `tests/multi-tenant.test.ts` | partly | Two tenants (`user-alice-001`, `user-bob-002`), each with its own RAM `/data`, its own disk `/out` rooted at `vfs/tenants/<id>/`, and its own Pyodide interpreter. Suite 1 (no key) runs a python probe for both tenants at once that walks the whole Emscripten tree, tries `/out/..`, `/tmp`, glob, and the other tenant's host path, and must find nothing of the other tenant. Suite 2 (key) runs one deepagents agent per tenant with a different prompt, asks each to hunt for the other user's secret, and asserts both finish their own work in their own folder and report `NOT_FOUND`. |
| `tests/yaml-config.test.ts` | no | The YAML → Workspace converter: strict schema errors name the offending key, `${VAR}` substitution, and the three example files under `workspaces/` build real workspaces. `numpy-only.yaml` proves package selection: numpy imports, pandas is denied. `tenant.yaml` proves seeds from inline text, host files and nested paths, a read-only mount, and a per-tenant disk root from a variable. |
| `tests/scientific.test.ts` | no (network on first run) | `workspaces/scientific.yaml` boots with 23 scientific packages preloaded, each one imports and does a small piece of real work (scipy optimize, sklearn and statsmodels fits, sympy solve, matplotlib PNG to `/out`, networkx, skimage, shapely, h5py, duckdb, ...), requests and micropip are denied, astropy is fetched lazily on first import, the vendored pure-python wheels (seaborn, plotly, openpyxl, dask, autograd, pint, tifffile, scikit-posthocs) import from `/wheels` and do real work, cvxpy solves with clarabel and highs, xgboost and lightgbm fit lazily, and a compiled PyPI wheel for this ABI (jiter) loads from a path. Prints boot time and RSS. Set `MIRAGE_SKIP_NETWORK=1` to skip offline. |

Why TypeScript: the Python `mirage-ai` package does not ship a Pyodide runtime
(its runtimes are monty, wasi, sandlock, local, quickjs). Pyodide only exists in
`@struktoai/mirage-core`.

## Setup

Node 20.10+ is required. This machine uses a portable Node at
`%USERPROFILE%\.local\node\node-v24.21.0-win-x64`; add it to `PATH` if `node`
is not found.

```powershell
npm install
```

The Pyodide distribution ships with the `pyodide` npm package. The numpy and
pandas wheels are fetched from the Pyodide CDN on first workspace start, so the
first run needs network access.

## Running

```powershell
npm run test:direct            # no API key needed
$env:ANTHROPIC_API_KEY = "sk-ant-..."
npm run test:agent             # deepagents + Anthropic API
npm run test:tenant            # multi-tenant isolation (agent half needs the key)
npm run test:yaml              # YAML -> workspace converter
npm run fetch:wheels           # seaborn, plotly, openpyxl wheels from PyPI into workspaces/wheels/
npm run test:sci               # scientific stack (downloads wheels on first run)
npm test                       # both
```

Instead of exporting the variable you can copy `.env.example` to `.env`.
`MIRAGE_TEST_MODEL` overrides the model (default `claude-sonnet-5`).
If your key is an organization-level key rather than a workspace-scoped one, the
API rejects requests with a 400 asking for the `anthropic-workspace-id` header; set
`ANTHROPIC_WORKSPACE_ID` (Console > Settings > Workspaces) and the test adds it.

## Fixture

`tests/workspace.ts` builds the workspace used by both tests:

- `RAMResource` mounted at `/data` for inputs and `DiskResource` rooted at the
  project's `vfs/` directory mounted at `/out` for outputs, both in
  `MountMode.EXEC` (EXEC is required for `python3` to run scripts from a mount).
- `PyodideRuntime` with `config.packages = ['numpy', 'pandas']`.
- `/data/sales.csv` seeded in RAM only (never written to disk) through the shell with a 5-row dataset whose per-region
  revenue is east 50, north 65, south 25.
- The linear system `[[3,1],[1,2]] x = [9,8]`, whose solution is `x = [2, 3]`
  and determinant 5.

## Workspaces from YAML

`src/config.ts` turns a YAML file into a mirage `Workspace`. The schema is
strict: an unknown key, a bad mount mode, a disk mount without a root, or a
Pyodide config key the runtime does not have fails with the key's path before
anything is built. Examples live in `workspaces/`:

| File | What it shows |
| --- | --- |
| `default.yaml` | The workspace the tests and chat use by default: RAM `/data`, disk `/out` at `vfs/`, numpy and pandas preloaded. |
| `numpy-only.yaml` | Selecting packages: only numpy preloaded, pandas denied, lazy wheel fetching off, a bootstrap snippet that silences warnings. |
| `tenant.yaml` | One workspace per user from `${TENANT_ID}`: seeds from inline text, a host file and a nested path, a `/lib` mount filled from a host directory with `seedDir`, a read-only `/ref` mount, a wiped per-tenant disk root, and an `agentId`. |
| `scientific.yaml` | The popular scientific stack: numpy, scipy, pandas, polars, pyarrow, xarray, scikit-learn, statsmodels, patsy, sympy, mpmath, matplotlib (Agg), networkx, scikit-image, pillow, shapely, pywavelets, h5py, duckdb, pyyaml, regex, tqdm, joblib. Lazy fetching on for the rest of the distribution; requests and micropip denied. cvxpy-base with clarabel and highspy. seaborn, plotly, openpyxl, dask, autograd, pint, tifffile and scikit-posthocs, which the distribution lacks, are vendored as unpacked wheels on a read-only `/wheels` mount via `sysPath`; jiter shows a compiled PyPI wheel loaded by path. |

```ts
import { loadWorkspace } from './src/config.ts'

const { ws, mountInfo, diskRoots } = await loadWorkspace('workspaces/tenant.yaml', {
  vars: { TENANT_ID: 'alice', TENANT_SECRET: '...' },
})
// ws is a ready Workspace; mountInfo feeds buildSystemPrompt({ mountInfo }).
```

The full schema:

```yaml
name: analyst                  # optional label
mode: exec                     # default mount mode: read | write | exec

mounts:                        # keys are absolute virtual paths; /lib, /dev, /proc are
                               #   rejected (Pyodide keeps its stdlib and site-packages in /lib)
  /data:
    type: ram                  # ram | disk | s3 | redis
    description: Inputs.       # shown to the agent in the mount table
    mode: write                # per-mount override
    backend: vfs               # vfs | fuse | fskit
    mountpoint: /mnt/x         # kernel mountpoint for fuse/fskit
    seed:                      # files created before the mount is exposed,
      a.csv: |                 #   so read-only mounts can be seeded too
        x,y
      b.bin: { file: ./b.bin } # host file (text or binary), relative to the yaml
      sub/c.txt: nested        # parent directories are created
    seedDir: ./fixtures        # copy a whole host directory tree into the mount
  /out:
    type: disk
    root: ../vfs/${TENANT_ID}   # relative to the yaml file
    wipe: true                 # delete the whole root first
    clean: [summary.csv]       # or just these files
  /s3:
    type: s3                   # options are passed to the constructor as-is
    options: { bucket: my-bucket }

runtimes:                      # ordered; first capturer of a command wins.
  - type: pyodide              # omit the whole list for mirage's defaults
    captures: [python3, python]
    config:
      packages: [numpy, pandas]        # preloaded at init: distribution names,
      #   or compiled wheels for this ABI by path/URL, e.g.
      #   ./wheels/wasm/jiter-0.17.0-cp314-cp314-pyemscripten_2026_0_wasm32.whl
      denyPackages: [requests]         # import fails, wheel never fetched
      autoLoadFromImports: true        # fetch wheels for imports lazily
      bootstrapCode: |                 # runs once after the interpreter loads
        import warnings; warnings.filterwarnings("ignore")
      sysPath: [/data/lib]             # mount paths or .whl files added to sys.path
      home: /path/to/pyodide           # distribution dir (default: the npm package)
      packageBaseUrl: https://...      # wheel base URL
      lockFileURL: https://...
  - vfs                        # the shell's own builtins

python:                        # workspace-wide defaults for any python runtime
  denyPackages: []
  autoLoadFromImports: true
  bootstrapCode: ""

options:                       # scalar Workspace options
  workspaceId: ws-1
  agentId: agent-1
  sessionId: s-1
  cacheLimit: 64MB
```

Any string may contain `${NAME}` or `${NAME:-default}`. Names resolve
from the `vars` passed to `loadWorkspace` first, then the environment; an
unresolved name without a default is an error. The chat CLI takes
`--workspace <yaml>` and `--var NAME=value`.

Packages named in `packages` or imported lazily come from the Pyodide
distribution (357 packages for this version; see `node_modules/pyodide/pyodide-lock.json`).
numpy and pandas ship with the npm package; anything else is fetched from the
Pyodide CDN on first use and cached as a `.whl` next to the distribution in
`node_modules/pyodide`, so later starts are offline. Some names differ: cvxpy is
`cvxpy-base` (with `clarabel` and `highspy` as solvers), scikit-learn
imports as `sklearn`.

### Packages the distribution lacks

There are three routes, in order of preference. This Pyodide (314.0.7) is
Python 3.14 on the `pyemscripten_2026_0` ABI, which decides what the second
route can use.

| Route | Works for | How |
| --- | --- | --- |
| Vendor a pure-python wheel | seaborn, plotly, openpyxl, dask, autograd, pint, tifffile, scikit-posthocs, and any `none-any` wheel whose dependencies are covered | `fetch:wheels` unpacks it into `workspaces/wheels/site-packages/`, a RAM mount seeded from that directory goes on `sysPath` |
| Load a compiled wheel built for this ABI | packages publishing `cp314-cp314-pyemscripten_2026_0_wasm32` wheels on PyPI (PEP 783): jiter, pydantic-core, mypy, xxhash, blosc2, arro3, geoarrow-rust-core, uuid7-rs, imgui-bundle, ... | name the wheel in `packages` by path (relative to the yaml) or https URL; the Pyodide loader installs it. Proven with jiter in `scientific.yaml` |
| Nothing | numba, torch, jax, rdkit, numexpr, gensim, sparse (needs numba), pulp (needs a native solver binary) | no WebAssembly build exists. numba would need an LLVM JIT that can emit wasm at runtime (JupyterLite has an experiment, not usable here); torch and jax have no Emscripten build; rdkit has an open pull request to build wheels with pyodide/emscripten; numexpr and gensim are C/Cython with no recipe |

Wheels tagged for other ABIs (`pyemscripten_2025_0` is Python 3.13, e.g.
statsmodels' own PyPI wheel) do not load here. To find what is available for
a package, look for `pyemscripten_2026_0_wasm32` in its PyPI file list.

Alternatives inside the sandbox: for numba-style speedups use numpy
vectorisation or scipy; for torch-style ML use scikit-learn, xgboost and
lightgbm (all in the distribution, loaded lazily on import); for cvxpy use
`cvxpy-base` with clarabel or highs; for pulp use highspy or
`cvxpy-base` directly.

### Vendoring pure-python packages

A package the distribution lacks can still be used if it is pure python:
unpack its wheel into a directory inside a mount and put that directory in
the runtime's `sysPath`. `scientific.yaml` does this for seaborn, plotly
and openpyxl (plus openpyxl's dependency et_xmlfile):

```yaml
mounts:
  /wheels:
    type: ram
    seedDir: ./wheels/site-packages   # copied into RAM at build time
    mode: read
runtimes:
  - type: pyodide
    config:
      packages: [..., narwhals, packaging]   # plotly's distribution deps
      sysPath: ["/wheels"]
```

`npm run fetch:wheels` (`cli/fetch-wheels.ts`) downloads the pinned wheels
from PyPI, accepting only `none-any` builds and checking each sha256 against
PyPI's digest, then unpacks them into `workspaces/wheels/site-packages/`
(gitignored). Rules learned the hard way:

- A vendored package's own dependencies must be covered: distribution ones go
  in `packages` (lazy loading only scans the code being run, not what the
  vendored package imports), pure-python ones get vendored too.
- Unpack, do not put `.whl` files on `sysPath`. zipimport can import modules
  from a wheel, but a package that `open()`s a data file next to its own
  `__file__` (plotly's validators) fails inside a zip.
- Use a RAM mount with `seedDir`, not a disk mount, for the directory. On
  Windows, subdirectories of a disk mount reach Pyodide with mode `0o40666`
  (no execute bit), so the interpreter gets `PermissionError` traversing
  them even though the shell reads them fine. This is a mirage 0.0.6 issue in
  the disk resource's stat; RAM mounts report `0o40777` and work.
- Anything with compiled code cannot be vendored this way. If it publishes a
  wheel for this ABI, use the `packages` route above; otherwise it would
  need a Pyodide build.

## Multi-tenant fixture

`src/tenant.ts` builds one workspace per user id: a fresh `RAMResource` at
`/data` seeded with `secret.txt` (a random per-tenant value) plus any extra
inputs, a `DiskResource` at `/out` rooted at `vfs/tenants/<userId>/` (wiped at
start), and a fresh `PyodideRuntime`. The virtual paths are identical for every
tenant on purpose: isolation has to come from the backing stores and from each
`PyodideRuntime` instance owning its own interpreter, WASM heap, and Emscripten
MEMFS (so even `/tmp` and `/home` are per tenant). Each agent run is logged to
`logs/tenant-<userId>.jsonl`.

## Benchmarks

`npm run bench:tenants [-- N]` spins up N tenant workspaces one after another and
reports, per instance, construction time, first `python3` call (Pyodide boot,
wheel install, numpy and pandas import), warm call time, and RSS growth. It
then checks whether two warm instances run CPU-bound python in parallel (they
do not: Pyodide runs on the Node main thread), times a concurrent spin-up of
two instances, and measures what `close()` returns.

`npm run bench:warm` splits a cold instance's first call into interpreter boot,
numpy import, and pandas import, then pre-warms a `PyodideRuntime` before any
workspace exists and hands it to a new tenant workspace. That moves the ~2.5 s
spin-up off the request path: the tenant's first call takes about 10 ms.

## Event log

The agent test streams the run through deepagents' v3 interface and logs every
model turn (streamed text, tool calls, usage), every tool call (input, output,
status), lifecycle entries, and any subagent runs.

The console shows a readable view: one block per model turn, the command each
tool call ran, its output, and how long it took. Set `MIRAGE_TEST_VERBOSE=1` to
also print lifecycle entries. The complete log is written to
`logs/agent-events.jsonl`, one JSON object per line, for scripts and diffing.

To re-render the last saved log without calling the API:

```powershell
npm.cmd run replay
npm.cmd run replay -- path\to\other.jsonl
```

## Chat CLI

`cli/chat.ts` is an interactive chat with the same agent and workspace. Inputs
you add land in `/data` (RAM); anything the agent writes to `/out` appears in
`vfs/`. Conversation memory persists across turns until `/reset`.

```powershell
npm.cmd run chat
npm.cmd run chat -- --put .\data.csv            # copy a text file into /data first
npm.cmd run chat -- --model claude-opus-5 -v    # other model, show lifecycle events
```

Inside the chat:

| Command | Effect |
| --- | --- |
| `/put <file> [name]` | copy a host text file into `/data` |
| `/sh <command>` | run a shell command in the workspace, e.g. `/sh python3 -c "import numpy"` |
| `/ls` | list `/data` and `/out` |
| `/verbose` | toggle lifecycle events in the trace |
| `/reset` | forget the conversation and start a new thread |
| `/exit` | quit (Ctrl+D also works; Ctrl+C interrupts a running turn) |

Every turn is rendered with the readable event view, and the whole session is
saved to `logs/chat-<timestamp>.jsonl`, which `npm run replay -- <file>` can
re-render.

Layout: `src/` holds the shared workspace builder, event log, and run observer;
`cli/` the chat and replay commands; `tests/` the vitest files.
