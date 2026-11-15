# local-magpie

A [DeepSeek Harness](https://github.com/deepseek-ai) (`dsh-go`) native plugin that owns the
local [magpie](https://github.com/yetone/magpie) gateway: it starts and stops the gateway from
inside the engine, repairs the engine → magpie route after every restart, and exposes a small
panel for everyday use.

## What it does

1. **Process lifecycle** — starts `magpie serve --web` detached (gateway on `127.0.0.1:3425`,
   Web UI on `127.0.0.1:3430`), piped into `bin/serve.log`. The binary is always resolved from
   the plugin directory (`bin/magpie` via `import.meta.url`), never from `PATH`, so a second
   magpie installed elsewhere cannot shadow it. Starts only if nothing is running
   (`pgrep -f "<bin> serve"`).

2. **Base-link repair** — this is the part that saves you from a dead engine after a restart.
   magpie, when the *billion-context* plugin is enabled, writes the engine's magpie provider
   route as a proxied URL:

   ```yaml
   baseURL: http://127.0.0.1:8787/bili/http://127.0.0.1:3425/v1
   ```

   with `8787` being billion-context's `bili` proxy in front of magpie's own `3425`. The proxy
   is spawned by the billion-context installer, not by magpie — so after an engine restart
   magpie comes back up, the route still points at `8787`, and `bili` is gone. The engine then
   cannot reach the provider at all (`chain=000`), and the old workaround was toggling the
   DeepSeek Harness switch in magpie's Library panel every time.

   On load (i.e. every engine start) and every 30 s, the plugin:

   - reads the route out of `$DSH_HOME/settings.yaml` and every
     `$DSH_HOME/profiles/*/cordis.patch.yml` (6/8-space indent, `/bili/` form only);
   - probes `GET <origin>/bili/http://127.0.0.1:3425/v1/models`;
   - if that fails, kills a wedged proxy and respawns `bili start` the same way magpie does
     (detached, appended to `~/.config/magpie/bili-start.log`), with a 60 s cooldown, at most
     2 spawn attempts and a 75 s boot wait;
   - if the proxy comes up on a different port, rewrites the route line to the observed port;
   - if the proxy still cannot be brought up, rewrites the route to magpie directly
     (`http://127.0.0.1:3425/v1`) so the engine keeps working without the proxy hop.

   The 30 s watchdog is `unref()`ed so it never keeps a short-lived process (or the plugin
   checker) alive.

3. **Panel** (`magpie 网关`, in the session tabs and in Features) — version, gateway/Web UI
   endpoints, live `/v1/models` status, base-link state, and four actions:

   - **启动网关** — start gateway + Web UI
   - **关闭网关** — `pkill -f "<bin> serve"`
   - **打开 Web UI** — opens the Web UI URL (with the current run key) in the default browser
     via an Android `VIEW` intent; if no browser takes it, copies the link instead
   - **复制网关链接** — copies the Web UI URL (`http://127.0.0.1:3430/?k=…`) to the clipboard

   Plus an uninstall action that stops the process and removes `bin/`.

4. **Composer strip** — one short status line (`magpie 运行中`, `magpie 2.x.y`,
   `magpie 运行中·链接异常`), refreshed every 15 s.

## Install

The magpie binary is ~84 MB, so it is **not** in this repo. Lay it out like this:

```
local-magpie/
├── bin/
│   └── magpie          # download a magpie release for your platform, chmod +x
├── lib/index.js
├── package.json
└── cordis.patch.yml
```

```bash
git clone https://github.com/suptf/local-magpie.git
cd local-magpie
mkdir -p bin
curl -L <magpie-release-asset-url> -o bin/magpie && chmod +x bin/magpie
dsh plugin --profile web add "$PWD"
```

Then restart the engine. Requires dsh-go `>=0.2.1-rc.2 <0.3.0-0` (declared in `engines.dsh`);
no npm dependencies at runtime, plain ESM.

## Notes

- The base-link logic only acts on the `/bili/` route form. If you never enabled
  billion-context, the route points straight at `3425` and the plugin leaves it alone
  (link state `直连`).
- magpie self-updates through its own Web UI (`serve` swaps the binary in place and restarts
  with the same pid/args); this plugin deliberately does not run `magpie update`, so the two
  never fight.
- `bin/serve.log` and `bin/` are gitignored.

## License

MIT