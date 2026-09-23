// workspaces/scientific.yaml: every preloaded package imports, and each one
// does a small piece of real work. The first run downloads wheels from the
// Pyodide CDN (later runs use the cache in node_modules/pyodide); set
// MIRAGE_SKIP_NETWORK=1 to skip this file on an offline machine.
//
// The test prints the boot time and RSS cost of the full stack so the yaml's
// package list can be trimmed with numbers in hand.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadWorkspace, type BuiltWorkspace } from '../src/config.js'
import { writeText } from '../src/workspace.js'
import { WHEELS, fetchWheels, wheelBase, wheelsPresent } from '../cli/fetch-wheels.js'

const YAML = fileURLToPath(new URL('../workspaces/scientific.yaml', import.meta.url))
const SKIP = process.env.MIRAGE_SKIP_NETWORK === '1'

let built: BuiltWorkspace
let bootMs = 0
let bootRssMb = 0

beforeAll(async () => {
  if (SKIP) return
  // The vendored wheels are gitignored; download them once (PyPI) if absent.
  if (!wheelsPresent()) await fetchWheels()
  built = await loadWorkspace(YAML)
  const rss0 = process.memoryUsage().rss
  const t0 = performance.now()
  const io = await built.ws.execute('python3 -c "print(1)"')
  bootMs = performance.now() - t0
  bootRssMb = (process.memoryUsage().rss - rss0) / 1024 / 1024
  expect(io.exitCode, io.stderrText).toBe(0)
})

afterAll(async () => {
  await built?.ws.close()
})

async function py(script: string) {
  await writeText(built.ws, '/data/t.py', script)
  const io = await built.ws.execute('python3 /data/t.py')
  return { out: io.stdoutText, err: io.stderrText, code: io.exitCode }
}

describe.skipIf(SKIP)('workspaces/scientific.yaml', () => {
  it('boots with every preloaded package importable', async () => {
    const packages = (built.config.runtimes![0] as { config: { packages: string[] } }).config.packages.filter(
      (p) => !p.endsWith('.whl'), // compiled wheels by path are covered by their own test
    )
    // Distribution names → import names where they differ.
    const importName: Record<string, string> = {
      'scikit-learn': 'sklearn',
      'scikit-image': 'skimage',
      pillow: 'PIL',
      pywavelets: 'pywt',
      pyyaml: 'yaml',
      'cvxpy-base': 'cvxpy',
      'typing-extensions': 'typing_extensions',
    }
    const r = await py(
      [
        'import importlib, importlib.metadata, json, time',
        `names = ${JSON.stringify(packages.map((p) => [p, importName[p] ?? p]))}`,
        'versions = {}',
        'timings = {}',
        'for dist, n in names:',
        '    t = time.time()',
        '    m = importlib.import_module(n)',
        '    timings[n] = round((time.time() - t) * 1000)',
        '    try: versions[n] = importlib.metadata.version(dist.removesuffix("-base"))',
        '    except importlib.metadata.PackageNotFoundError: versions[n] = getattr(m, "__version__", "?")',
        'print(json.dumps({"versions": versions, "import_ms": timings}))',
      ].join('\n'),
    )
    expect(r.code, r.err).toBe(0)
    const { versions, import_ms } = JSON.parse(r.out.trim().split('\n').at(-1)!)
    console.log(`scientific stack: boot ${bootMs.toFixed(0)} ms, +${bootRssMb.toFixed(0)} MB RSS, ${packages.length} packages preloaded`)
    console.table(
      Object.keys(versions).map((n) => ({ package: n, version: versions[n], 'first import ms': import_ms[n] })),
    )
    for (const n of Object.keys(versions)) expect(versions[n], n).not.toBe('?')
  })

  it('denies requests and micropip', async () => {
    for (const name of ['requests', 'micropip']) {
      const r = await py(`import ${name}`)
      expect(r.code, name).not.toBe(0)
    }
  })

  it('does real work in each family and writes artifacts to /out', async () => {
    const r = await py(`
import json
import numpy as np, scipy.optimize as opt, scipy.stats as st
import pandas as pd, polars as pl, pyarrow as pa, xarray as xr
from sklearn.linear_model import LinearRegression
import statsmodels.api as sm
import sympy, mpmath
import matplotlib.pyplot as plt
import networkx as nx
from skimage import filters
from PIL import Image
from shapely.geometry import Point, Polygon
import pywt, h5py, duckdb, yaml, regex, joblib
from tqdm import tqdm

out = {}
# scipy: minimize a quadratic, t-test
out["min_x"] = float(opt.minimize(lambda x: (x[0] - 3) ** 2, [0]).x[0])
out["ttest_p"] = float(st.ttest_1samp(np.arange(10.0), 4.5).pvalue)
# pandas / polars / pyarrow / xarray round trips
df = pd.DataFrame({"a": [1, 2, 3], "b": [2.0, 4.0, 6.0]})
out["polars_sum"] = int(pl.from_pandas(df)["a"].sum())
out["arrow_rows"] = pa.Table.from_pandas(df).num_rows
out["xarray_mean"] = float(xr.DataArray(df["b"].values).mean())
# sklearn / statsmodels: fit y = 2x
X = df[["a"]].values; y = df["b"].values
out["sklearn_coef"] = float(LinearRegression().fit(X, y).coef_[0])
out["sm_coef"] = float(sm.OLS(y, sm.add_constant(X)).fit().params[1])
# sympy / mpmath
x = sympy.symbols("x")
out["sympy_roots"] = [int(r) for r in sympy.solve(x**2 - 5*x + 6, x)]
out["mp_pi"] = str(mpmath.mp.pi)[:6]
# matplotlib → /out/plot.png
plt.figure(figsize=(3, 2)); plt.plot([0, 1], [0, 1]); plt.savefig("/out/plot.png"); plt.close()
# networkx
G = nx.path_graph(5); out["nx_path"] = nx.shortest_path_length(G, 0, 4)
# skimage / PIL
img = np.zeros((8, 8)); img[2:6, 2:6] = 1
out["sobel_max"] = round(float(filters.sobel(img).max()), 3)
Image.fromarray((img * 255).astype("uint8")).save("/out/img.png")
# shapely
out["poly_contains"] = Polygon([(0, 0), (2, 0), (2, 2), (0, 2)]).contains(Point(1, 1))
# pywt
out["wavelet_len"] = len(pywt.dwt([1, 2, 3, 4], "haar")[0])
# h5py → /out/data.h5, then read back
with h5py.File("/out/data.h5", "w") as f: f["v"] = np.arange(5)
with h5py.File("/out/data.h5", "r") as f: out["h5_sum"] = int(f["v"][...].sum())
# duckdb over the pandas frame
out["duck"] = duckdb.query("select sum(b) from df").fetchone()[0]
# yaml / regex / joblib / tqdm
out["yaml"] = yaml.safe_load("k: [1, 2]")["k"]
out["regex"] = regex.findall(r"\\p{L}+", "héllo wörld")
out["joblib"] = joblib.hash([1, 2, 3])[:6]
out["tqdm"] = sum(i for i in tqdm(range(3), disable=True))
print(json.dumps(out))
`)
    expect(r.code, r.err).toBe(0)
    const out = JSON.parse(r.out.trim().split('\n').at(-1)!)
    expect(out.min_x).toBeCloseTo(3, 3)
    expect(out.ttest_p).toBeCloseTo(1, 6)
    expect(out.polars_sum).toBe(6)
    expect(out.arrow_rows).toBe(3)
    expect(out.xarray_mean).toBeCloseTo(4, 9)
    expect(out.sklearn_coef).toBeCloseTo(2, 9)
    expect(out.sm_coef).toBeCloseTo(2, 9)
    expect(out.sympy_roots.sort()).toEqual([2, 3])
    expect(out.mp_pi).toBe('3.1415')
    expect(out.nx_path).toBe(4)
    expect(out.sobel_max).toBeGreaterThan(0)
    expect(out.poly_contains).toBe(true)
    expect(out.wavelet_len).toBe(2)
    expect(out.h5_sum).toBe(10)
    expect(out.duck).toBe(12)
    expect(out.yaml).toEqual([1, 2])
    expect(out.regex).toEqual(['héllo', 'wörld'])
    expect(out.tqdm).toBe(3)
    for (const f of ['plot.png', 'img.png', 'data.h5']) {
      expect(existsSync(join(built.diskRoots['/out'], f)), f).toBe(true)
    }
  })

  it('vendored pure-python wheels on sysPath import and work (seaborn, plotly, openpyxl)', async () => {
    const r = await py(`
import json, sys, time
timings = {}
for n in ["seaborn", "plotly", "openpyxl", "et_xmlfile"]:
    t = time.time(); __import__(n); timings[n] = round((time.time() - t) * 1000)
import seaborn as sns, plotly, plotly.graph_objects as go, openpyxl, pandas as pd
out = {"timings": timings, "versions": {"seaborn": sns.__version__, "plotly": plotly.__version__, "openpyxl": openpyxl.__version__}}
out["site_on_path"] = "/wheels" in sys.path
import os
out["dist_infos"] = sorted(d for d in os.listdir("/wheels") if d.endswith(".dist-info"))
# seaborn: a histogram through matplotlib (Agg) to /out
ax = sns.histplot([1, 2, 2, 3, 3, 3]); ax.figure.savefig("/out/sns.png"); ax.figure.clf()
# plotly: a figure serialised to JSON and written as HTML
fig = go.Figure(go.Scatter(x=[1, 2, 3], y=[2, 4, 6]))
out["plotly_trace"] = json.loads(fig.to_json())["data"][0]["type"]
fig.write_html("/out/fig.html", include_plotlyjs=False)
# openpyxl: pandas round trip through .xlsx, and the workbook read directly
df = pd.DataFrame({"a": [1, 2, 3], "b": [10, 20, 30]})
df.to_excel("/out/table.xlsx", index=False)
out["xlsx_sum"] = int(pd.read_excel("/out/table.xlsx")["b"].sum())
wb = openpyxl.load_workbook("/out/table.xlsx"); out["xlsx_rows"] = wb.active.max_row
print(json.dumps(out))
`)
    expect(r.code, r.err).toBe(0)
    const out = JSON.parse(r.out.trim().split('\n').at(-1)!)
    console.log('vendored wheels first import ms:', out.timings)
    expect(out.site_on_path).toBe(true)
    for (const w of WHEELS) {
      expect(out.dist_infos, w.name).toContain(`${wheelBase(w)}.dist-info`)
    }
    expect(out.versions).toEqual({ seaborn: '0.13.2', plotly: '7.1.0', openpyxl: '3.1.5' })
    expect(out.plotly_trace).toBe('scatter')
    expect(out.xlsx_sum).toBe(60)
    expect(out.xlsx_rows).toBe(4)
    for (const f of ['sns.png', 'fig.html', 'table.xlsx']) {
      expect(existsSync(join(built.diskRoots['/out'], f)), f).toBe(true)
    }
    // The wheels mount is read-only from inside python.
    const w = await py('open("/wheels/x.txt", "w").write("x")')
    expect(w.code).not.toBe(0)
  })

  it('cvxpy (cvxpy-base) solves with clarabel and highs', async () => {
    const r = await py(`
import json, cvxpy as cp, numpy as np
x = cp.Variable(2)
prob = cp.Problem(cp.Minimize(cp.sum_squares(x - np.array([1.0, 2.0]))), [x >= 0, cp.sum(x) <= 2])
out = {"installed": sorted(cp.installed_solvers())}
prob.solve(solver=cp.CLARABEL); out["clarabel_x"] = [round(float(v), 4) for v in x.value]
lp = cp.Problem(cp.Maximize(x[0] + 2 * x[1]), [x >= 0, x[0] + x[1] <= 4, x[1] <= 3])
lp.solve(solver=cp.HIGHS); out["highs_x"] = [round(float(v), 4) for v in x.value]
print(json.dumps(out))
`)
    expect(r.code, r.err).toBe(0)
    const out = JSON.parse(r.out.trim().split('\n').at(-1)!)
    expect(out.installed).toEqual(expect.arrayContaining(['CLARABEL', 'HIGHS']))
    expect(out.clarabel_x[0]).toBeCloseTo(0.5, 2)
    expect(out.clarabel_x[1]).toBeCloseTo(1.5, 2)
    expect(out.highs_x).toEqual([1, 3])
  })

  it('xgboost and lightgbm (distribution, loaded lazily) fit a model', async () => {
    const r = await py(`
import json, numpy as np
X = np.arange(40.0).reshape(-1, 1); y = (X[:, 0] >= 20).astype(int)
import xgboost as xgb, lightgbm as lgb
xm = xgb.XGBClassifier(n_estimators=20, max_depth=2).fit(X, y)
lm = lgb.LGBMClassifier(n_estimators=20, min_child_samples=2, verbose=-1).fit(X, y)
print(json.dumps({"xgb_acc": float((xm.predict(X) == y).mean()), "lgb_acc": float((lm.predict(X) == y).mean()), "xgb_v": xgb.__version__, "lgb_v": lgb.__version__}))
`)
    expect(r.code, r.err).toBe(0)
    const out = JSON.parse(r.out.trim().split('\n').at(-1)!)
    expect(out.xgb_acc).toBe(1)
    expect(out.lgb_acc).toBeGreaterThanOrEqual(0.9)
  })

  it('vendored pure-python extras work (dask, autograd, pint, tifffile, scikit-posthocs)', async () => {
    const r = await py(`
import json, numpy as np
import dask, dask.array as da, dask.dataframe as dd, pandas as pd
import autograd, autograd.numpy as anp
from autograd import grad
import pint, tifffile, scikit_posthocs as sp
from importlib.metadata import version
out = {"versions": {n: version(n) for n in ["dask", "autograd", "pint", "tifffile", "scikit-posthocs"]}}
dask.config.set(scheduler="synchronous")
out["dask_array"] = float(da.arange(10, chunks=3).sum().compute())
ddf = dd.from_pandas(pd.DataFrame({"g": ["a", "b", "a"], "v": [1, 2, 3]}), npartitions=2)
out["dask_df"] = ddf.groupby("g").v.sum().compute().to_dict()
out["autograd"] = float(grad(lambda x: anp.sin(x) * x)(0.0))  # d/dx (x sin x) at 0 = 0
ureg = pint.UnitRegistry(); out["pint"] = (3 * ureg.km).to(ureg.m).magnitude
tifffile.imwrite("/out/img.tif", np.arange(16, dtype="uint8").reshape(4, 4))
out["tif_sum"] = int(tifffile.imread("/out/img.tif").sum())
out["dunn_shape"] = list(sp.posthoc_dunn([[1, 2, 3], [4, 5, 6], [7, 8, 9]]).shape)
print(json.dumps(out))
`)
    expect(r.code, r.err).toBe(0)
    const out = JSON.parse(r.out.trim().split('\n').at(-1)!)
    expect(out.dask_array).toBe(45)
    expect(out.dask_df).toEqual({ a: 4, b: 2 })
    expect(out.autograd).toBeCloseTo(0, 9)
    expect(out.pint).toBe(3000)
    expect(out.tif_sum).toBe(120)
    expect(out.dunn_shape).toEqual([3, 3])
  })

  it('a compiled PyPI wheel for this ABI (jiter, pyemscripten_2026_0) loads from a path in packages', async () => {
    const r = await py('import jiter; print(jiter.__version__, jiter.from_json(b\'{"a": [1, 2.5]}\'), jiter.__file__)')
    expect(r.code, r.err).toBe(0)
    expect(r.out).toContain("0.17.0 {'a': [1, 2.5]} /lib/python3.14/site-packages/jiter/")
  })

  it('fetches a distribution package lazily on first import (astropy)', async () => {
    const r = await py('import astropy.units as u; print((3 * u.km).to(u.m).value)')
    expect(r.code, r.err).toBe(0)
    expect(r.out.trim()).toBe('3000.0')
  })
})
