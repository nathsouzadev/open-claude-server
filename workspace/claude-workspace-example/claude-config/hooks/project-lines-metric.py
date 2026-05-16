#!/usr/bin/env python3
"""
PostToolUse hook: pushes per-project lines added/removed to OTel after Edit/Write.
"""
import sys
import json
import os
import subprocess
import urllib.request
import time
import difflib


def get_project_name(file_path):
    try:
        dir_path = os.path.dirname(os.path.abspath(file_path)) if file_path else os.getcwd()
        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, cwd=dir_path, timeout=2
        )
        if result.returncode == 0:
            return os.path.basename(result.stdout.strip())
    except Exception:
        pass
    return os.path.basename(os.getcwd())


def diff_lines(old, new):
    old_lines = old.splitlines()
    new_lines = new.splitlines()
    added = removed = 0
    for op, _, _, _, _ in difflib.SequenceMatcher(None, old_lines, new_lines).get_opcodes():
        if op in ("replace", "insert"):
            added += 1
        if op in ("replace", "delete"):
            removed += 1
    return added, removed


def push(project, added, removed):
    time_ns = str(int(time.time() * 1e9))

    def metric(name, value):
        return {
            "name": name,
            "gauge": {
                "dataPoints": [{
                    "asInt": str(value),
                    "timeUnixNano": time_ns,
                    "attributes": [
                        {"key": "project", "value": {"stringValue": project}}
                    ]
                }]
            }
        }

    payload = {
        "resourceMetrics": [{
            "resource": {
                "attributes": [
                    {"key": "service.name", "value": {"stringValue": "claude-project-lines"}},
                    {"key": "project", "value": {"stringValue": project}}
                ]
            },
            "scopeMetrics": [{"metrics": [metric("claude_project_lines_added", added),
                                          metric("claude_project_lines_removed", removed)]}]
        }]
    }

    try:
        req = urllib.request.Request(
            "http://localhost:4318/v1/metrics",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        urllib.request.urlopen(req, timeout=2)
    except Exception:
        pass


def main():
    try:
        hook_input = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    tool = hook_input.get("tool_name", "")
    inp = hook_input.get("tool_input", {})
    file_path = inp.get("file_path", "")

    if tool == "Edit":
        added, removed = diff_lines(inp.get("old_string", ""), inp.get("new_string", ""))
    elif tool == "Write":
        added = len(inp.get("content", "").splitlines())
        removed = 0
    else:
        sys.exit(0)

    if added == 0 and removed == 0:
        sys.exit(0)

    push(get_project_name(file_path), added, removed)


if __name__ == "__main__":
    main()
