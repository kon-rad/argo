"""Minimal Docker-backed DeskRunner adapter reference; fails closed off Linux."""
import hashlib
import json
import os
import platform
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.request
from pathlib import Path


class DeskRunner:
    mode = "live"

    def __init__(self, corpus_dir, state_dir, gateway_container="desk-gateway", image="desk-worker:dev", gateway_url="http://127.0.0.1:8787"):
        self.corpus = Path(corpus_dir).resolve()
        self.state = Path(state_dir).resolve()
        self.gateway_container = gateway_container
        self.image = image
        self.gateway_url = gateway_url.rstrip("/")
        self.active = {}
        self.finished = {}

    def _docker(self, *args):
        result = subprocess.run(["docker", *args], capture_output=True, text=True, timeout=20)
        if result.returncode:
            raise RuntimeError(f"docker {args[0]} failed ({result.returncode})")
        return result.stdout.strip()

    def _check_host(self):
        if platform.system() != "Linux":
            raise RuntimeError("runner requires a dedicated Linux VM")
        self._docker("info")
        self._docker("inspect", self.gateway_container)
        if not self.corpus.is_dir():
            raise RuntimeError("approved corpus directory is unavailable")

    def reap_orphans(self):
        """Kill jobs left running after a runner restart; call before accepting dispatches."""
        try:
            containers = self._docker("ps", "-aq", "--filter", "label=desk.attempt").splitlines()
            for container in containers:
                if container:
                    self._docker("rm", "-f", container)
            networks = self._docker("network", "ls", "-q", "--filter", "label=desk.attempt").splitlines()
            for network in networks:
                if network:
                    self._docker("network", "rm", network)
            return {"kind": "ok", "value": {"containersRemoved": len(containers), "networksRemoved": len(networks)}}
        except Exception as exc:
            return {"kind": "unavailable", "message": str(exc)}

    def start(self, spec, capability):
        root = None
        network = None
        name = None
        try:
            self._check_host()
            if not capability or spec.get("audience") != "gateway" or int(spec["expiresAt"]) <= int(time.time()):
                return {"kind": "denied", "message": "invalid or expired dispatch"}
            attempt = spec["attemptId"]
            if attempt in self.active:
                return {"kind": "denied", "message": "attempt already active"}
            self.state.mkdir(parents=True, exist_ok=True)
            root = Path(tempfile.mkdtemp(prefix="desk-", dir=self.state))
            (root / "spec").mkdir()
            (root / "scratch").mkdir(mode=0o700)
            (root / "result").mkdir(mode=0o700)
            os.chown(root / "scratch", 10001, 10001)
            (root / "spec" / "spec.json").write_text(json.dumps(spec, sort_keys=True, separators=(",", ":")), encoding="utf-8")
            name = "desk-" + hashlib.sha256(attempt.encode()).hexdigest()[:20]
            network = "desk-job-" + hashlib.sha256(attempt.encode()).hexdigest()[:20]
            self._docker("network", "create", "--internal", "--label", "desk.attempt=" + attempt, network)
            self._docker("network", "connect", "--alias", "desk-gateway", network, self.gateway_container)
            timeout = min(3600, int(spec["limits"]["maxRuntimeSeconds"]))
            self._docker("run", "--detach", "--name", name, "--label", "desk.attempt=" + attempt,
                         "--network", network, "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
                         "--pids-limit=64", "--memory=512m", "--cpus=1", "--user=10001:10001",
                         "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m",
                         "--mount", f"type=bind,src={self.corpus},dst=/corpus,readonly",
                         "--mount", f"type=bind,src={root / 'spec'},dst=/spec,readonly",
                         "--mount", f"type=bind,src={root / 'scratch'},dst=/scratch",
                         "--env", "DESK_CAPABILITY=" + capability,
                         "--env", "DESK_GATEWAY=http://desk-gateway:8787",
                         "--stop-timeout", "2", self.image)
            expires = min(int(spec["expiresAt"]), int(time.time()) + timeout)
            timer = threading.Timer(max(0, expires - time.time()), self._enforce_deadline, args=(attempt,))
            timer.daemon = True
            self.active[attempt] = {"name": name, "network": network, "root": str(root), "expires": expires, "capability": capability, "timer": timer}
            timer.start()
            return {"kind": "ok", "value": {"attemptId": attempt}}
        except Exception as exc:
            if name:
                subprocess.run(["docker", "rm", "-f", name], capture_output=True, check=False)
            if network:
                subprocess.run(["docker", "network", "rm", network], capture_output=True, check=False)
            if root:
                shutil.rmtree(root, ignore_errors=True)
            return {"kind": "unavailable", "message": str(exc)}

    def status(self, attempt_id):
        if attempt_id in self.finished:
            return {"kind": "ok", "value": self.finished[attempt_id]}
        run = self.active.get(attempt_id)
        if not run:
            return {"kind": "unavailable", "message": "unknown attempt"}
        try:
            state = json.loads(self._docker("inspect", "--format", "{{json .State}}", run["name"]))
            if state["Running"]:
                if int(time.time()) >= run["expires"]:
                    self.cancel(attempt_id)
                    self.finished[attempt_id] = {"status": "failed"}
                    return {"kind": "ok", "value": self.finished[attempt_id]}
                return {"kind": "ok", "value": {"status": "running"}}
            if state["ExitCode"] != 0:
                run["timer"].cancel()
                self._docker("rm", "-f", run["name"])
                self._docker("network", "rm", run["network"])
                shutil.rmtree(Path(run["root"]) / "scratch", ignore_errors=True)
                self.finished[attempt_id] = {"status": "failed"}
                self.active.pop(attempt_id, None)
                return {"kind": "ok", "value": {"status": "failed"}}
            result_path = Path(run["root"]) / "scratch" / "result.md"
            if not result_path.is_file():
                run["timer"].cancel()
                self._docker("rm", "-f", run["name"])
                self._docker("network", "rm", run["network"])
                shutil.rmtree(run["root"], ignore_errors=True)
                self.active.pop(attempt_id, None)
                self.finished[attempt_id] = {"status": "failed"}
                return {"kind": "ok", "value": {"status": "failed"}}
            result = result_path.read_bytes()
            metadata = json.loads(self._docker("logs", run["name"]).splitlines()[-1])
            actual = hashlib.sha256(result).hexdigest()
            if metadata.get("artifactHash") != actual or metadata.get("artifactRef") != "result.md":
                run["timer"].cancel()
                self._docker("rm", "-f", run["name"])
                self._docker("network", "rm", run["network"])
                shutil.rmtree(run["root"], ignore_errors=True)
                self.active.pop(attempt_id, None)
                self.finished[attempt_id] = {"status": "failed"}
                return {"kind": "ok", "value": {"status": "failed"}}
            # Move the finished artifact out of disposable scratch for P3 to persist/review.
            durable = Path(run["root"]) / "result" / "result.md"
            shutil.copyfile(result_path, durable)
            self._docker("rm", "-f", run["name"])
            self._docker("network", "rm", run["network"])
            shutil.rmtree(Path(run["root"]) / "scratch", ignore_errors=True)
            run["timer"].cancel()
            completed = {"status": "complete", "result": {"artifactHash": actual, "mediaType": "text/markdown", "artifactRef": str(durable), "boundedTrace": metadata.get("boundedTrace", "")}}
            self.finished[attempt_id] = completed
            self.active.pop(attempt_id, None)
            return {"kind": "ok", "value": completed}
        except Exception as exc:
            return {"kind": "failed", "message": str(exc)}

    def _enforce_deadline(self, attempt_id):
        run = self.active.get(attempt_id)
        if not run:
            return
        try:
            state = json.loads(self._docker("inspect", "--format", "{{json .State}}", run["name"]))
            if state["Running"]:
                self.cancel(attempt_id)
                self.finished[attempt_id] = {"status": "failed"}
            else:
                self.status(attempt_id)
        except Exception:
            self.cancel(attempt_id)
            self.finished[attempt_id] = {"status": "failed"}

    def cancel(self, attempt_id):
        run = self.active.get(attempt_id)
        if not run:
            return {"kind": "ok", "value": None}
        run["timer"].cancel()
        revoke_error = None
        try:
            # Revoke first so a racing container cannot make another gateway call.
            req = urllib.request.Request(self.gateway_url + "/v1/revoke", b"{}", {"Authorization": "Bearer " + run["capability"], "Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=3):
                pass
        except Exception as exc:
            revoke_error = exc
        try:
            # Stop the process even if revocation could not be confirmed. Expiry is
            # independently enforced by the gateway when the capability has expired.
            self._docker("rm", "-f", run["name"])
            self._docker("network", "rm", run["network"])
            shutil.rmtree(run["root"], ignore_errors=True)
            self.active.pop(attempt_id, None)
            self.finished[attempt_id] = {"status": "cancelled"}
            if revoke_error:
                return {"kind": "failed", "message": "container stopped; gateway revocation was not confirmed: " + str(revoke_error)}
            return {"kind": "ok", "value": None}
        except Exception as exc:
            return {"kind": "failed", "message": "cancellation could not be confirmed: " + str(exc)}
