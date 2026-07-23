# Common Workflows

Quick reference for operating our Open Computer fork. All commands run from `open-computer/`.

## First-time setup (new machine)

```bash
# 1. Unzip the bundled QEMU (macOS ARM64)
tar -xzf master/qemu/qemu-darwin-arm64.tar.gz -C master/qemu/

# 2. Build the CLI
cd cli && npm install && npm run build && cd ..

# 3. Fetch the prebuilt base image (~2.9 GB)
scripts/fetch-base-image.sh

# 4. Apply our fork's provisioning (KMP toolchain, Chromium flags, shared-folder mount)
./open-computer base up && ./open-computer base provision && ./open-computer base compact
```

Rebuild the CLI (`cd cli && npm run build`) after any change under `cli/src/`.

## Install something into every future agent (base image rebuild)

1. Edit `master/setup/provision.sh` (add packages/config in the appropriate section).
2. Rebuild:
   ```bash
   ./open-computer base up
   ./open-computer base provision   # waits for SSH automatically
   ./open-computer base compact     # shuts down + shrinks base.qcow2
   ```
3. Verify with a throwaway agent:
   ```bash
   ./open-computer create check && ./open-computer ssh check "java -version"
   ./open-computer destroy check
   ```

## Launch a task agent

```bash
./host/launch-task.sh \
  --name mytask \
  --repo org/repo --branch main \
  --ai-url http://localhost:1234/v1 --ai-api-key sk-... --ai-model my-model
```
- Clones the repo into `agents/mytask/shared/` (shared into the VM at `/home/agent/shared`).
- Writes `agents/mytask/.env`, starts the whitelist proxy, boots the VM.
- Task output: whatever the agent leaves in the shared folder — it's a live host folder.

## Chat with the agent from the terminal

```bash
node host/chat.mjs --agent mytask
```
Slash commands: `/abort` `/new` `/compact` `/status` `/usage` `/deliverables` `/quit`.
Web UI alternative: http://localhost:9800 (port from `./open-computer list`).

## Allow a new domain through the network lockdown

1. Add the domain to `host/allowlist.txt` (one per line; `example.com` covers subdomains).
2. Done — the proxy hot-reloads. No VM restart needed.

## Change LLM settings for an existing agent

1. Edit `agents/<name>/.env`.
2. `./open-computer restart <name>` (re-pushes .env, restarts the in-VM service; kills the current agent session).

## Tear down

```bash
./open-computer down mytask      # graceful stop (shared-folder output stays on host)
./open-computer destroy mytask   # delete VM + agent dir (shared folder included — copy out first!)
```

## Gotchas

- Provision changes do nothing until the base is rebuilt; existing agents keep their old image.
- Network lockdown is always on. Cloud LLM URLs (e.g. api.openai.com): the LLM pinhole only supports localhost endpoints — add the API domain to `host/allowlist.txt` instead.
- Gradle builds are slow on the shared folder (9p). Tell the agent to copy to local disk, build, copy results back.
- Agent RAM/CPUs are constants in `cli/src/config.ts` (`CPUS`, `RAM`) — changing them needs `cd cli && npm run build`.
