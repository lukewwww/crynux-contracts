---
name: inspect-crynux-on-base-sepolia
description: Inspect the crynux-on-base-sepolia Nitro/DAS deployment over SSH on host cnx-base. Use ONLY when the user explicitly asks to check the crynux-on-base-sepolia network, its Nitro nodes, DAS, sequencer, private operators, or related logs. Never use this skill prophylactically or for any other host/directory.
---

# Inspect Crynux-on-Base-Sepolia

Read-only inspection of the crynux-on-base-sepolia Orbit chain node stack on `cnx-base`.

## Usage Restrictions

- This skill MUST NOT be used unless the user explicitly asks to inspect crynux-on-base-sepolia, its Nitro/DAS services, sequencer, private operators, or their logs.
- All access is strictly READ-ONLY. You MUST NOT modify, create, delete, move, or overwrite anything on the server: no file writes, no config edits, no container restarts, no `docker compose up/down/restart/stop`, no Redis `SET`/`DEL`, no package installs.
- You MUST stay inside `~/base-sepolia`. Do not `cd` into or read any other directory on the server.
- Do not print secrets into the conversation:
  - `private/nitro-node/nitro-node.json` batch-poster / staker `private-key` values
  - Redis password embedded in `public/docker-compose.yml` and in any `redis-url`
  - `public/das/keys/das_bls` private key material
  - Full unredacted `docker-compose.yml` or nitro config dumps that include those values
- When showing nitro configs, redact `private-key`, `redis-url` credentials, and any other key material first.
- Log timestamps on this host are UTC. When reporting times to the user, convert to UTC+8.

## Connection

Preconfigured SSH alias:

```bash
ssh cnx-base "<command>"
```

Always run commands non-interactively through `ssh cnx-base "..."` and keep the working directory under `~/base-sepolia`.

Public and private stacks have separate compose files. Prefix with the correct subdirectory:

- Public: `cd ~/base-sepolia/public && ...`
- Private: `cd ~/base-sepolia/private && ...`

The `ubuntu` user has passwordless `sudo`. Use `sudo` only for read operations such as `docker compose ps`, `docker compose logs`, and `docker compose exec` read-only redis-cli queries.

On Windows PowerShell, prefer piping a bash script to avoid quoting breakage:

```powershell
$script = @'
cd ~/base-sepolia/public || exit 1
sudo docker compose ps -a
'@
$script | ssh cnx-base bash -s
```

## Deployment Layout

Everything lives in `~/base-sepolia`:

```text
~/base-sepolia/
  public/
    docker-compose.yml
    das/
      daserver.json
      keys/                 # DAS BLS key material; never print das_bls
    nitro-node/
      nitro-node.json       # public sequencer / RPC node config
  private/
    docker-compose.yml
    nitro-node/
      nitro-node.json       # batch poster + validator; contains private keys
```

### Public compose services

| Service | Container name | Role | Host ports |
|---|---|---|---|
| `init-data-volumes` | one-shot | chown data volumes | none |
| `das` | `crynux-base-sepolia-das` | AnyTrust DAS RPC/REST | `9878`, `9879` |
| `sequencer-redis` | `crynux-base-sepolia-sequencer-redis` | sequencer coordinator Redis | `6488` |
| `public-rpc-sequencer` | `crynux-base-sepolia-public-rpc-sequencer` | public sequencer + JSON-RPC | `8450` |

Image: `offchainlabs/nitro-node:v3.10.1-d7f07be` for Nitro/DAS; `redis:7-alpine` for Redis.

### Private compose services

| Service | Container name | Role |
|---|---|---|
| `init-nitro-volume` | one-shot | chown nitro volume |
| `private-operators` | `crynux-base-sepolia-private-operators` | batch poster + staker/validator |

Private operators reach public DAS/Redis through `host.docker.internal`.

### Network facts

- Chain id: `188962142`
- Public external RPC: `https://json-rpc.base-sepolia.crynux.io`
- Local sequencer RPC on the host: `http://127.0.0.1:8450`
- Parent chain RPC configured as `https://sepolia.base.org`
- Sequencer coordinator `my-url` / expected Redis `coordinator.priorities`: `https://json-rpc.base-sepolia.crynux.io`
- Initial chain owner / deployer: `0x1B4F6290434821211D8313Aa19317449F80bBd89`

Repo-side reference configs live under `deployments/primary/testnet/crynux-on-base-sepolia/` in this repository. Server files under `~/base-sepolia` are the live deployment.

## Health Checks

### Container status

```bash
ssh cnx-base "cd ~/base-sepolia/public && sudo docker compose ps -a"
ssh cnx-base "cd ~/base-sepolia/private && sudo docker compose ps -a"
```

### Local sequencer RPC

```powershell
$script = @'
cd ~/base-sepolia/public || exit 1
printf %s '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
  | curl -sS -m 10 -X POST http://127.0.0.1:8450 -H 'Content-Type: application/json' -d @-
echo
printf %s '{"jsonrpc":"2.0","method":"eth_syncing","params":[],"id":1}' \
  | curl -sS -m 10 -X POST http://127.0.0.1:8450 -H 'Content-Type: application/json' -d @-
echo
printf %s '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' \
  | curl -sS -m 10 -X POST http://127.0.0.1:8450 -H 'Content-Type: application/json' -d @-
echo
'@
$script | ssh cnx-base bash -s
```

To check whether the chain is advancing, sample `eth_blockNumber` twice several seconds apart.

External RPC can also be checked from the local machine without SSH:

```text
https://json-rpc.base-sepolia.crynux.io
```

### Redis coordinator priorities

Extract the Redis password from `public/docker-compose.yml` inside the remote command. Pass it via `REDISCLI_AUTH`. Never print the password.

```powershell
$script = @'
cd ~/base-sepolia/public || exit 1
PASS=$(python3 - <<'PY'
import re
from pathlib import Path
text = Path("docker-compose.yml").read_text()
m = re.search(r"requirepass '([^']+)'", text)
if not m:
    raise SystemExit("redis password not found")
print(m.group(1))
PY
)
sudo docker compose exec -T -e REDISCLI_AUTH="$PASS" sequencer-redis \
  redis-cli -p 6488 --no-auth-warning GET coordinator.priorities
echo
'@
$script | ssh cnx-base bash -s
```

Expected value: `https://json-rpc.base-sepolia.crynux.io`

Use only read-only Redis commands (`GET`, `INFO`, `PING`). Never write keys.

## Viewing Logs

Use bounded, non-following logs only. Avoid `docker compose logs -f`.

```bash
ssh cnx-base "cd ~/base-sepolia/public && sudo docker compose logs --tail 100 public-rpc-sequencer"
ssh cnx-base "cd ~/base-sepolia/public && sudo docker compose logs --tail 100 das"
ssh cnx-base "cd ~/base-sepolia/public && sudo docker compose logs --tail 50 sequencer-redis"
ssh cnx-base "cd ~/base-sepolia/private && sudo docker compose logs --tail 100 private-operators"
```

Useful filters after fetching logs:

- Public sequencer / DAS: parent-chain failures such as `502 Bad Gateway`, `503`, `context deadline exceeded` against `sepolia.base.org`
- Private operators: `eth_getLogs` range-limit / `413 Request Entity Too Large`, batch-poster or staker errors
- Confirm whether sequencer is still emitting recent `Latest confirmed assertion` lines

When summarizing log times, convert UTC timestamps to UTC+8.

## Inspecting Configs Safely

List files only when needed:

```bash
ssh cnx-base "cd ~/base-sepolia && find . -maxdepth 4 -type f | sort"
```

Safe to print:

- `public/das/daserver.json`
- Redacted nitro configs
- Service/container status and bounded logs

Never print:

- `public/das/keys/das_bls`
- Unredacted `private/nitro-node/nitro-node.json`
- Redis password or full `redis-url` with credentials

Example redacted nitro config dump:

```powershell
$script = @'
cd ~/base-sepolia || exit 1
python3 - <<'PY'
import json
from pathlib import Path

def redact(obj):
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            lk = k.lower()
            if lk in {"private-key", "password", "secret", "mnemonic"} or "privatekey" in lk.replace("-", ""):
                out[k] = "<redacted>"
            elif lk == "redis-url" and isinstance(v, str):
                out[k] = "<redacted redis-url>"
            else:
                out[k] = redact(v)
        return out
    if isinstance(obj, list):
        return [redact(x) for x in obj]
    return obj

for rel in [
    "public/nitro-node/nitro-node.json",
    "private/nitro-node/nitro-node.json",
]:
    print("====", rel)
    print(json.dumps(redact(json.loads(Path(rel).read_text())), indent=2))
PY
'@
$script | ssh cnx-base bash -s
```

## Typical Inspection Order

1. `docker compose ps -a` for public and private.
2. Local `eth_blockNumber` / `eth_syncing` / `eth_chainId` on `:8450`.
3. Redis `coordinator.priorities`.
4. Recent `public-rpc-sequencer`, `das`, and `private-operators` logs.
5. If blocks are stuck, check parent-chain RPC errors in sequencer/DAS logs and private-operator batch/staker errors.
