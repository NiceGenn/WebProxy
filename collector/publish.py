"""Publish only changed JSON with a fine-grained GitHub PAT, never a workflow GITHUB_TOKEN."""
import base64
import json
import re
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def publish(data_dir, repository, branch):
    token_file = Path(data_dir) / "github_pat"
    if not token_file.exists():
        return "disabled"
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository) or not re.fullmatch(r"[A-Za-z0-9_./-]+", branch):
        raise ValueError("Invalid GitHub repository or branch setting")
    path = Path(data_dir) / "webproxy.json"
    content = path.read_bytes()
    token = token_file.read_text(encoding="utf-8").strip()
    if not token:
        return "disabled"
    url = f"https://api.github.com/repos/{repository}/contents/site/webproxy.json"
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "webproxy-collector"}
    sha = None
    try:
        with urlopen(Request(url + f"?ref={branch}", headers=headers), timeout=20) as response:
            remote = json.load(response)
        sha = remote["sha"]
        remote_content = base64.b64decode(remote.get("content", ""))
        if remote_content == content:
            return "unchanged"
    except HTTPError as error:
        if error.code != 404:
            raise
    body = {"message": "Update collected WebProxy links", "branch": branch, "content": base64.b64encode(content).decode("ascii")}
    if sha:
        body["sha"] = sha
    request = Request(url, data=json.dumps(body).encode(), headers={**headers, "Content-Type": "application/json"}, method="PUT")
    with urlopen(request, timeout=30):
        pass
    return "updated"
