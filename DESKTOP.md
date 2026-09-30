# Desktop build (Tauri)

The app ships as a native Windows desktop application via **[Tauri v2](https://tauri.app)**.
Tauri wraps the *existing* Vite/React frontend in a system-webview window (WebView2
on Windows) with a small Rust host process — it is **not** Electron and bundles no
Chromium. The physics core still runs as the `burn-core` **WASM** module inside the
webview, exactly as it does in the browser build; nothing about the UI or the solver
changed.

Everything Tauri-specific lives in [`src-tauri/`](src-tauri/):

| File | Purpose |
| --- | --- |
| `tauri.conf.json` | Window, bundle, icons, CSP, signing config |
| `Cargo.toml` / `build.rs` / `src/main.rs` | The Rust host (a thin webview launcher — no custom commands yet) |
| `capabilities/default.json` | Tauri permission set for the main window (core defaults only) |
| `icons/` | App icons (placeholder — see *Replacing the icon*) |

The web build is untouched: `npm run dev` and `npm run build` still produce the
plain browser app. The Tauri scripts wrap those.

---

## Prerequisites (one-time, on the build machine)

Tauri compiles a native Windows binary, so the build machine needs the Microsoft
C/C++ toolchain. `npx tauri info` on this repo currently reports these missing.

1. **Visual Studio Build Tools** with the *Desktop development with C++* workload
   (MSVC + Windows SDK): <https://aka.ms/vs/17/release/vs_BuildTools.exe>
2. **MSVC Rust toolchain** (the default here is the unsupported `gnu` one):
   ```bash
   rustup default stable-msvc
   rustup target add x86_64-pc-windows-msvc
   ```
3. **WebView2 runtime** — already present on this machine (`tauri info` ✔). End-user
   machines without it get it automatically: the installer is configured with
   `webviewInstallMode: downloadBootstrapper`, which fetches it at install time.

Node dependencies (`@tauri-apps/cli`, `@tauri-apps/api`) are already in
`package.json`; `npm install` pulls them.

> **Smart App Control (SAC).** This machine has SAC enabled, which blocks freshly
> compiled, unsigned binaries (`os error 4551` — see `scripts/build-wasm.sh`). A
> `tauri build` here will produce a binary SAC may immediately quarantine. Build on
> a machine with SAC off or in CI, and **sign the output** (below) before shipping.

---

## Develop

```bash
npm run tauri:dev
```

Starts Vite on port 3000 (`beforeDevCommand`) and opens the desktop window pointed
at it, with hot-reload. Equivalent to the browser dev flow, in a native window.

## Build an installer

```bash
npm run tauri:build
```

Runs `npm run build` (the Vite production build → `dist/`), compiles the Rust host,
and emits an **NSIS** installer at:

```
src-tauri/target/release/bundle/nsis/APRO Burn & Geometry Modeler_0.1.0_x64-setup.exe
```

To also emit an MSI, add `"msi"` to `bundle.targets` in `tauri.conf.json` (MSI
requires the WiX toolset installed).

---

## Code signing — the actual fix for "Windows deletes it"

An **unsigned** installer will be flagged by SmartScreen/Defender and blocked by
Smart App Control, regardless of Tauri. The build is currently unsigned. To stop
Windows from quarantining it, the installer and the app binary must carry a valid
**Authenticode** signature from a certificate Windows trusts:

- **OV (Organization Validation) certificate** — signs the binary, but SmartScreen
  still shows "unknown publisher" until the signature accrues download *reputation*.
- **EV (Extended Validation) certificate** — gets SmartScreen/SAC reputation
  immediately. This is the reliable option for avoiding warnings on day one.
- **[Azure Trusted Signing](https://learn.microsoft.com/azure/trusted-signing/)** —
  cloud signing, no local private key, EV-grade reputation, low cost. Recommended.

Signing is **not** wired on by default (there is no certificate in the repo, and
private keys must never live here). Enable one of these in
`src-tauri/tauri.conf.json` under `bundle.windows`:

**A local OV/EV cert (by thumbprint, from the machine's cert store):**
```jsonc
"windows": {
  "webviewInstallMode": { "type": "downloadBootstrapper" },
  "certificateThumbprint": "<THUMBPRINT WITH NO SPACES>",
  "digestAlgorithm": "sha256",
  "timestampUrl": "http://timestamp.digicert.com"
}
```

**Azure Trusted Signing (or any HSM/cloud signer) via a custom command:**
```jsonc
"windows": {
  "webviewInstallMode": { "type": "downloadBootstrapper" },
  "signCommand": "trusted-signing-cli -e <ENDPOINT> -a <ACCOUNT> -c <CERT_PROFILE> %1"
}
```
(`%1` is the file Tauri passes to be signed; install the signer CLI on the build
machine.) Credentials come from the environment / Azure login — never commit them.

After signing, the timestamp keeps the signature valid past the certificate's
expiry. Verify with `signtool verify /pa /v <file>`.

---

## Replacing the placeholder icon

`src-tauri/icons/` currently holds a generated placeholder mark. To swap in a real
logo, drop a square PNG (≥ 1024×1024) somewhere and run:

```bash
npm run tauri icon path/to/logo.png
```

This regenerates every size plus `icon.ico`/`icon.icns` in place.

---

## Known things to verify in the webview

These work in a browser but exercise webview-specific paths; confirm them in a
`tauri:dev` window when you first build:

- **CSV / file export.** The exporters trigger downloads via an `<a download>`
  anchor. WebView2 handles anchor downloads, but if a save dialog does not appear,
  switch those paths to the Tauri `dialog` + `fs` plugins.
- **wasm worker + CSP.** The solver runs in a module Web Worker that instantiates
  wasm. The CSP in `tauri.conf.json` already allows this
  (`script-src 'wasm-unsafe-eval'`, `worker-src 'self' blob:`). If the solver fails
  to load, that CSP is the first place to look.
