"""Fork-only exact-head shipped agent-exec proof. This new scenario is UNRUN.

prepare: add observational stderr receipts before a fresh full build.
run: launch the actual agent exec CLI with pinned synthetic provider/plugin config.
No direct loader/catalog/discovery calls, activation, or injected registries.
"""

import argparse
import hashlib
import http.server
import json
import os
import pathlib
import re
import signal
import socket
import subprocess
import sys
import threading
import time

CHANNEL = "message-catalog-fixture"
MARKER = "E2_OBSERVER "


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def git(root, *args):
    return subprocess.check_output(["git", "-c", "gc.auto=0", *args], cwd=root, text=True).strip()


class ProviderCapture:
    """Own the accept loop AND every bounded request handler, socket and error."""

    def __init__(self, out):
        self.out = out
        self.lock = threading.Lock()
        self.local = threading.local()
        self.handlers = []
        self.errors = []
        self.requests = []
        self.thread = None
        owner = self

        class Provider(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                try:
                    self.handle_post()
                except BaseException as error:
                    owner.remember("provider-request", error, owner.local.receipt["id"])
                    raise

            def handle_post(self):
                receipt = owner.local.receipt
                receipt.update(method=self.command, path=self.path)
                assert self.command == "POST" and self.path == "/v1/chat/completions", "unexpected method/path"
                assert self.headers.get("Authorization") == "Bearer synthetic-e2-proof", "synthetic auth sentinel mismatch"
                assert self.headers.get("Transfer-Encoding") is None, "unexpected chunked request"
                length = int(self.headers["Content-Length"])
                assert 0 < length <= 8 * 1024 * 1024, "invalid/beyond-bound request length"
                raw = self.rfile.read(length)
                raw_file = f"request-{receipt['id']}.utf8"
                (out / raw_file).write_bytes(raw)
                receipt.update(requestRawFile=raw_file, requestDeclaredLength=length,
                               requestReceivedLength=len(raw), requestSha256=hashlib.sha256(raw).hexdigest())
                assert len(raw) == length, "incomplete request body"
                text = raw.decode("utf-8", errors="strict")
                body = json.loads(text)
                assert isinstance(body, dict), "request JSON is not an object"
                assert body.get("model") == "catalog-model", "unexpected model"
                assert body.get("stream") is True, "expected streaming provider request"
                receipt["requestValidated"] = True
                with owner.lock:
                    owner.requests.append({"handlerId": receipt["id"], "path": self.path, "body": body})
                common = {"id": "e2-fixture-reply", "object": "chat.completion.chunk", "created": 1, "model": body["model"]}
                chunks = [
                    {**common, "choices": [{"index": 0, "delta": {"role": "assistant", "content": "E2_ENTRYPOINT_OK"}, "finish_reason": None}]},
                    {**common, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}},
                ]
                wire = b"".join(("data: " + json.dumps(chunk) + "\n\n").encode("utf-8") for chunk in chunks) + b"data: [DONE]\n\n"
                response_file = f"server-attempted-response-{receipt['id']}.sse"
                (out / response_file).write_bytes(wire)
                receipt.update(responseAttemptedFile=response_file, responseAttemptedLength=len(wire),
                               responseAttemptedSha256=hashlib.sha256(wire).hexdigest(),
                               responseObservation="Server-side attempted bytes/write/flush/finish only; not client capture")
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                written = self.wfile.write(wire)
                receipt["responseWrittenLength"] = written
                assert written == len(wire), "partial SSE write"
                receipt["responseWriteSucceeded"] = True
                self.wfile.flush()
                receipt["responseFlushSucceeded"] = True

            def finish(self):
                try:
                    super().finish()
                    owner.local.receipt["serverFinishSucceeded"] = True
                except BaseException as error:
                    owner.remember("provider-finish", error, owner.local.receipt["id"])
                    raise

        class Server(http.server.HTTPServer):
            def handle_error(self, request, address):
                owner.remember("provider-server", sys.exc_info()[1])

            def process_request(self, request, address):
                request.settimeout(10)
                if len(owner.handlers) >= 8:
                    owner.remember("provider-handler-bound", RuntimeError("more than eight accepted handler owners"))
                    self.shutdown_request(request)
                    return
                with owner.lock:
                    receipt = {"id": len(owner.handlers) + 1, "handlerFinished": False,
                               "requestValidated": False, "responseWriteSucceeded": False,
                               "responseFlushSucceeded": False, "serverFinishSucceeded": False,
                               "forcedSocketClose": False}
                    handler = {"receipt": receipt, "socket": request, "thread": None}
                    owner.handlers.append(handler)

                def run_handler():
                    owner.local.receipt = receipt
                    try:
                        self.finish_request(request, address)
                    except BaseException as error:
                        owner.remember("provider-handler", error, receipt["id"])
                    finally:
                        try:
                            self.shutdown_request(request)
                        except BaseException as error:
                            owner.remember("provider-handler-socket-close", error, receipt["id"])
                        receipt["handlerFinished"] = True

                thread = threading.Thread(target=run_handler, name=f"e2-provider-{receipt['id']}", daemon=False)
                handler["thread"] = thread
                try:
                    thread.start()
                except BaseException as error:
                    owner.remember("provider-handler-start", error, receipt["id"])
                    self.shutdown_request(request)

        self.server = Server(("127.0.0.1", 0), Provider)

    def remember(self, phase, error, handler_id=None):
        with self.lock:
            self.errors.append({"atNs": time.monotonic_ns(), "phase": phase, "handlerId": handler_id,
                                "type": type(error).__name__, "message": str(error), "exception": error})

    def __enter__(self):
        def serve():
            try:
                self.server.serve_forever(poll_interval=0.1)
            except BaseException as error:
                self.remember("provider-accept-loop", error)

        self.thread = threading.Thread(target=serve, name="e2-provider-accept", daemon=False)
        try:
            self.thread.start()
        except BaseException:
            self.server.server_close()
            raise
        return self

    def __exit__(self, error_type, error, traceback):
        if error is not None:
            self.remember("driver", error)

        def cleanup(phase, operation):
            try:
                operation()
            except BaseException as cleanup_error:
                self.remember(phase, cleanup_error)

        if self.thread.is_alive():
            cleanup("provider-stop-accept", self.server.shutdown)
        cleanup("provider-accept-join", lambda: self.thread.join(timeout=10))
        cleanup("provider-server-close", self.server.server_close)
        cleanup("provider-accept-final-join", lambda: self.thread.join(timeout=10))
        # The accept loop has stopped: this is now the complete handler-owner set.
        deadline = time.monotonic() + 10
        for handler in self.handlers:
            thread = handler["thread"]
            if thread.ident is not None:
                cleanup("provider-handler-join", lambda: thread.join(timeout=max(0, deadline - time.monotonic())))
            if thread.is_alive():
                handler["receipt"]["forcedSocketClose"] = True
                cleanup("provider-force-socket-shutdown", lambda: handler["socket"].shutdown(socket.SHUT_RDWR))
                cleanup("provider-force-socket-close", handler["socket"].close)
        deadline = time.monotonic() + 10
        for handler in self.handlers:
            thread = handler["thread"]
            if thread.ident is not None:
                cleanup("provider-handler-final-join", lambda: thread.join(timeout=max(0, deadline - time.monotonic())))
            handler["receipt"]["handlerJoined"] = thread.ident is not None and not thread.is_alive()
        receipt = {"acceptJoined": not self.thread.is_alive(),
                   "handlers": [handler["receipt"] for handler in self.handlers]}
        receipt["allHandlersJoined"] = all(row["handlerJoined"] for row in receipt["handlers"])
        if not receipt["acceptJoined"] or not receipt["allHandlersJoined"]:
            self.remember("provider-cleanup", RuntimeError("provider accept/handler owner did not join"))
        if any(row["forcedSocketClose"] for row in receipt["handlers"]):
            self.remember("provider-cleanup", RuntimeError("cleanup forcibly closed a live handler socket"))
        cleanup("provider-receipt-write", lambda: save(self.out / "provider-cleanup.json", receipt))
        cleanup("request-receipt-write", lambda: save(self.out / "requests.json", self.requests))
        diagnostics = [{key: value for key, value in item.items() if key != "exception"}
                       for item in sorted(self.errors, key=lambda item: item["atNs"])]
        cleanup("diagnostics-write", lambda: save(self.out / "diagnostics.json", diagnostics))
        if self.errors:
            first = min(self.errors, key=lambda item: item["atNs"])
            raise RuntimeError(f"Earliest diagnostic {first['phase']}: {first['type']}: {first['message']}") from first["exception"]


def prepare(root, out, target, expect):
    assert git(root, "rev-parse", "HEAD") == target
    assert not git(root, "status", "--porcelain", "--untracked-files=no"), "fresh checkout required"
    before = {}

    def observe(file, anchor, replacement):
        path = root / file
        text = path.read_text()
        assert text.count(anchor) == 1, (file, "observer anchor changed")
        before[file] = hashlib.sha256(path.read_bytes()).hexdigest()
        path.write_text(text.replace(anchor, replacement))

    # Diagnostic identity only: keyed by the actual loader-returned object. Product
    # caches/catalogs/registries never read this map or change behavior from it.
    anchor = "const catalogsByRegistry = new WeakMap<PluginRegistry, PreparedMessageToolCatalog>();\n"
    observe(
        "src/plugins/prepared-message-tool-catalog.ts",
        anchor,
        anchor + '''
const e2ObservedLoads = new WeakMap<PluginRegistry, {
  id: number; pid: number; activateFalse: boolean; cacheFalse: boolean;
}>();
let e2ObservationSequence = 0;
export function recordE2ObservedRegistryLoad(
  registry: PluginRegistry, activateFalse: boolean, cacheFalse: boolean,
): void {
  const receipt = { id: ++e2ObservationSequence, pid: process.pid, activateFalse, cacheFalse };
  e2ObservedLoads.set(registry, receipt);
  console.error("E2_OBSERVER " + JSON.stringify({
    kind: "registry-loaded", ...receipt,
    plugins: registry.plugins.map(({ id, status }) => ({ id, status })),
    channels: registry.channels.map(({ plugin }) => plugin.id),
  }));
}
''',
    )

    # This observer only reads the existing exact argument, WeakMap and root snapshot.
    # The original return expression immediately following this insertion is unchanged.
    anchor = "  registry: PluginRegistry,\n): PreparedMessageToolCatalog | undefined {\n"
    # The source before hash was recorded above; retain that pristine hash.
    file = "src/plugins/prepared-message-tool-catalog.ts"
    path = root / file
    text = path.read_text()
    assert text.count(anchor) == 1
    path.write_text(text.replace(anchor, anchor + '''  console.error("E2_OBSERVER " + JSON.stringify({
    kind: "catalog-lookup", pid: process.pid,
    exactRegistryLoadObservation: e2ObservedLoads.get(registry) ?? null,
    rootPresent: getActivePluginChannelRegistrySnapshotFromState().registry !== null,
    rootVersion: getActivePluginChannelRegistrySnapshotFromState().version,
    rootMatchesExactRegistry: getActivePluginChannelRegistrySnapshotFromState().registry === registry,
    catalogAlreadyPrepared: catalogsByRegistry.has(registry),
    plugins: registry.plugins.map(({ id, status }) => ({ id, status })),
    channels: registry.channels.map(({ plugin }) => plugin.id),
  }));
'''))
    anchor = "  const previousSnapshot = captureActivePluginRegistrySnapshot();\n  const registry = params.activeRegistry;"
    observe(
        "src/plugins/runtime.ts",
        anchor,
        '''  console.error("E2_OBSERVER " + JSON.stringify({
    kind: "root-install", pid: process.pid,
    channels: params.activeRegistry?.channels.map(({ plugin }) => plugin.id) ?? [],
  }));
''' + anchor,
    )
    file = "src/plugins/loader-runtime-core.ts"
    path = root / file
    text = path.read_text()
    before[file] = hashlib.sha256(path.read_bytes()).hexdigest()
    text = 'import { recordE2ObservedRegistryLoad } from "./prepared-message-tool-catalog.js";\n' + text
    anchor = "    registryInputs.set(registry, inputs);\n    return registry;"
    assert text.count(anchor) == 1
    text = text.replace(anchor, "    recordE2ObservedRegistryLoad(registry, options.activate === false, options.cache === false);\n" + anchor)
    path.write_text(text)
    save(out / "observer-sources.json", {
        "head": target,
        "expect": expect,
        "tree": git(root, "rev-parse", "HEAD^{tree}"),
        "before": before,
        "after": {f: hashlib.sha256((root / f).read_bytes()).hexdigest() for f in before},
        "constraint": "Diagnostic same-object identity bookkeeping and stderr only; product catalog/cache/root owners and original operations retained verbatim",
    })
    (out / "observer.diff").write_text(git(root, "diff", "--", *before) + "\n")


def run(root, out, target, expect):
    assert git(root, "rev-parse", "HEAD") == target
    identity = json.loads((out / "observer-sources.json").read_text())
    assert identity["head"] == target
    assert identity["expect"] == expect
    assert all(hashlib.sha256((root / f).read_bytes()).hexdigest() == sha for f, sha in identity["after"].items())
    assert any((root / file).exists() for file in ["dist/entry.js", "dist/entry.mjs"]), "fresh complete build required"
    save(out / "dist-sha256.json", {
        str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted((root / "dist").rglob("*"))
        if path.is_file() and path.suffix in [".js", ".mjs", ".json"]
    })
    save(out / "launcher-sha256.json", {"openclaw.mjs": hashlib.sha256((root / "openclaw.mjs").read_bytes()).hexdigest()})
    home = out / "home"
    workspace = home / "workspace"
    state = home / "state"
    fixture = home / "fixture"
    for directory in [home, workspace, state, fixture]:
        directory.mkdir(parents=True, exist_ok=False)
    plugin = fixture / "index.cjs"
    plugin.write_text('''module.exports = {
  id: "message-catalog-fixture",
  register(api) {
    api.registerChannel({ plugin: {
      id: "message-catalog-fixture",
      meta: { id: "message-catalog-fixture", label: "Fixture", selectionLabel: "Fixture",
        docsPath: "/channels/fixture", blurb: "Synthetic proof channel" },
      capabilities: { chatTypes: ["direct"] },
      config: { listAccountIds: () => ["default"],
        resolveAccount: () => ({ accountId: "default", token: "configured" }) },
      outbound: { deliveryMode: "direct" },
      actions: { describeMessageTool: () => ({
        actions: ["send", "react"],
        schema: { visibility: "all-configured", properties: {
          fixtureLabel: { type: "string", description: "Fixture label" }
        } }
      }) }
    } });
  }
};
''')
    save(fixture / "openclaw.plugin.json", {
        "id": CHANNEL, "channels": [CHANNEL],
        "configSchema": {"type": "object", "properties": {}},
    })
    process = None
    timed_out = False
    cleanup_killed_group = False

    def group_alive():
        if process is None:
            return False
        try:
            os.killpg(process.pid, 0)
            return True
        except ProcessLookupError:
            return False

    def signal_group(which):
        try:
            os.killpg(process.pid, which)
        except ProcessLookupError:
            pass

    with ProviderCapture(out) as provider:
        model = "proof-fixture/catalog-model"
        config = {
            "agents": {
                "defaults": {"workspace": str(workspace), "model": {"primary": model}},
                "entries": {"main": {"workspace": str(workspace), "agentDir": str(state / "agents/main/agent")}},
            },
            "plugins": {
                "allow": [CHANNEL], "load": {"paths": [str(plugin)]},
                "entries": {CHANNEL: {"enabled": True}}, "slots": {"memory": "none"},
            },
            "tools": {"profile": "messaging", "allow": ["message"]},
            "models": {"mode": "replace", "providers": {"proof-fixture": {
                "baseUrl": f"http://127.0.0.1:{provider.server.server_port}/v1",
                "api": "openai-completions", "apiKey": "synthetic-e2-proof",
                "request": {"allowPrivateNetwork": True},
                "models": [{"id": "catalog-model", "name": "Synthetic catalog fixture", "reasoning": False,
                    "input": ["text"], "contextWindow": 128000, "maxTokens": 1024,
                    "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}}],
            }}},
        }
        config_path = home / "openclaw.json"
        save(config_path, config)
        # Construct, do not inherit, the child environment: no Actions or local credentials.
        env = {
            "PATH": os.environ["PATH"], "HOME": str(home), "USERPROFILE": str(home),
            "OPENCLAW_STATE_DIR": str(state), "OPENCLAW_CONFIG_PATH": str(config_path),
            "OPENCLAW_NO_RESPAWN": "1", "NO_COLOR": "1",
        }
        cmd = ["node", str(root / "openclaw.mjs"), "agent", "exec", "Reply with E2_ENTRYPOINT_OK only.",
               "--config", str(config_path), "--cwd", str(workspace), "--state-dir", str(state),
               "--thinking", "off", "--code-mode", "direct", "--timeout", "120", "--json"]
        save(out / "command.json", {"argv": cmd, "envKeys": sorted(env), "target": target})
        try:
            process = subprocess.Popen(cmd, cwd=root, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
            try:
                stdout, stderr = process.communicate(timeout=150)
            except subprocess.TimeoutExpired:
                timed_out = True
                cleanup_killed_group = True
                signal_group(signal.SIGTERM)
                try:
                    stdout, stderr = process.communicate(timeout=10)
                except subprocess.TimeoutExpired:
                    signal_group(signal.SIGKILL)
                    stdout, stderr = process.communicate(timeout=10)
            (out / "cli.stdout").write_text(stdout)
            (out / "cli.stderr").write_text(stderr)
        except BaseException as error:
            provider.remember("cli-execution", error)
            raise
        finally:
            if group_alive():
                cleanup_killed_group = True
                signal_group(signal.SIGTERM)
                for _ in range(50):
                    if not group_alive():
                        break
                    time.sleep(0.1)
                if group_alive():
                    signal_group(signal.SIGKILL)
                    for _ in range(50):
                        if not group_alive():
                            break
                        time.sleep(0.1)
            save(out / "cleanup.json", {
                "cliPid": process.pid if process else None,
                "cliExitCode": process.returncode if process else None,
                "cliJoined": process is not None and process.poll() is not None,
                "timedOut": timed_out, "cliGroupGone": not group_alive(),
                "cleanupKilledCliGroup": cleanup_killed_group,
            })
        assert not timed_out and process.returncode == 0, "CLI setup/terminal failure, not product RED"
        assert not group_alive(), "CLI cleanup incomplete"
        assert not cleanup_killed_group, "CLI leaked owned descendants; diagnostic cleanup killed them"
    requests = provider.requests
    handler_receipts = [handler["receipt"] for handler in provider.handlers]
    assert len(requests) == 1 and len(handler_receipts) == 1, "expected one actual provider exchange/handler"
    assert all(row["requestValidated"] and row["responseWriteSucceeded"] and row["responseFlushSucceeded"]
               and row["serverFinishSucceeded"] and row["handlerFinished"] and row["handlerJoined"]
               for row in handler_receipts), "request or server-side transmission/finish incomplete"
    terminal = json.loads(stdout)
    save(out / "cli-terminal.json", terminal)
    assert isinstance(terminal, dict), "CLI terminal JSON is not an object"
    assert terminal.get("payloads") == [{"text": "E2_ENTRYPOINT_OK", "mediaUrl": None}], "CLI returned unexpected successful payload"
    # This entrypoint's real stable envelope is not the --local raw meta shape.
    flags = {key: terminal.get(key) for key in ["ok", "status", "final", "error", "provider", "model", "sessionId"]}
    save(out / "cli-terminal-flags.json", flags)
    assert flags["ok"] is True and flags["status"] == "ok", "agent-exec terminal failed or timed out"
    assert flags["final"] == "E2_ENTRYPOINT_OK" and flags["error"] is None, "agent-exec terminal output/error mismatch"
    assert flags["provider"] == "proof-fixture" and flags["model"] == "catalog-model", "agent-exec provider/model identity mismatch"
    assert isinstance(flags["sessionId"], str) and flags["sessionId"].strip(), "agent-exec session identity missing"
    events = [json.loads(line.split(MARKER, 1)[1]) for line in stderr.splitlines() if MARKER in line]
    save(out / "observer-events.json", events)
    lookups = [e for e in events if e["kind"] == "catalog-lookup" and CHANNEL in e["channels"]]
    assert lookups, "actual CLI never reached loaded-channel catalog owner"
    first = lookups[0]
    assert first["pid"] == process.pid, "catalog observer belongs to another process"
    assert not first["catalogAlreadyPrepared"], "cold exact-registry premise absent"
    assert not first["rootPresent"] and first["rootVersion"] == 0, "process-root premise absent"
    assert not first["rootMatchesExactRegistry"]
    assert {"id": CHANNEL, "status": "loaded"} in first["plugins"]
    assert not [e for e in events if e["kind"] == "root-install"], "headless CLI unexpectedly activated root"
    acquisition = first["exactRegistryLoadObservation"]
    assert acquisition is not None and acquisition["activateFalse"] is True, "same-object activate:false load not observed"
    assert acquisition["pid"] == process.pid, "same-object acquisition belongs to another PID"
    matching_loads = [e for e in events if e["kind"] == "registry-loaded" and e["id"] == acquisition["id"] and e["pid"] == process.pid]
    assert len(matching_loads) == 1 and matching_loads[0]["activateFalse"] is True, "common loader return observation missing/ambiguous"
    assert CHANNEL in matching_loads[0]["channels"], "actual returned registry omitted fixture"
    assert events.index(matching_loads[0]) < events.index(first), "acquisition receipt must precede cold exact getter"
    tools = requests[0]["body"].get("tools", [])
    message = [tool.get("function", tool) for tool in tools if tool.get("function", tool).get("name") == "message"]
    assert len(message) == 1, "actual provider request lacks message tool"
    params = message[0]["parameters"]
    save(out / "message-schema.json", params)
    properties = params["properties"]
    # Action enum schemas can use an enum or an anyOf-of-consts. Inspect only action.
    def enum_values(value):
        if isinstance(value, dict):
            return list(value.get("enum", [])) + ([value["const"]] if "const" in value else []) + [item for child in value.values() for item in enum_values(child)]
        if isinstance(value, list):
            return [item for child in value for item in enum_values(child)]
        return []
    actions = sorted(set(enum_values(properties["action"])))
    has_react = "react" in actions
    has_field = properties.get("fixtureLabel", {}).get("type") == "string"
    primary_failures = []
    for label, passed in [("react advertised in provider schema", has_react), ("fixtureLabel string advertised in provider schema", has_field)]:
        try:
            assert passed, label
        except AssertionError as error:
            primary_failures.append(str(error))
    behavior = {"actions": actions, "reactAdvertised": has_react, "fixtureLabelStringAdvertised": has_field,
                "target": target, "premiseVerified": True, "cliCompleted": True,
                "providerExchanges": len(requests), "paidProviderUsed": False,
                "primaryAssertionFailures": primary_failures}
    save(out / "behavior.json", behavior)
    print(json.dumps(behavior, indent=2), flush=True)
    if expect == "baseline":
        assert len(primary_failures) == 2, "expected exact base omission not reproduced"
        print("BASELINE EXPECTED RED: actual CLI provider schema omits react and fixtureLabel", flush=True)
    else:
        assert not primary_failures, "candidate actual CLI provider schema still missing channel metadata"
        print("CANDIDATE GREEN: actual CLI provider schema advertises react and fixtureLabel", flush=True)


parser = argparse.ArgumentParser()
parser.add_argument("phase", choices=["prepare", "run"])
parser.add_argument("--root", type=pathlib.Path, required=True)
parser.add_argument("--out", type=pathlib.Path, required=True)
parser.add_argument("--target", required=True)
parser.add_argument("--expect", choices=["baseline", "candidate"], required=True)
args = parser.parse_args()
assert re.fullmatch(r"[0-9a-f]{40}", args.target), "full immutable target SHA required"
args.out.mkdir(parents=True, exist_ok=True)
globals()[args.phase](args.root.resolve(), args.out.resolve(), args.target, args.expect)
