"""Extract only WebProxy links, retaining the exact server and secret values."""
import html
import re
from urllib.parse import urlsplit, parse_qsl

LINK_RE = re.compile(r"(?:https://t\.me/webproxy|tg://webproxy)\?[^\s<>\"'\]\[{}]+", re.I)
HOST_RE = re.compile(r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\Z", re.I)
SECRET_RE = re.compile(r"[a-f0-9]{16,512}\Z", re.I)


def parse_link(raw):
    try:
        url = urlsplit(html.unescape(raw).rstrip(".,;!?)"))
        if not ((url.scheme.lower() == "https" and url.netloc.lower() == "t.me" and url.path == "/webproxy")
                or (url.scheme.lower() == "tg" and url.netloc.lower() == "webproxy" and url.path in ("", "/"))):
            return None
        if url.fragment or url.username or url.password:
            return None
        pairs = parse_qsl(url.query, keep_blank_values=True, strict_parsing=True)
        if len(pairs) != 2 or {key for key, _ in pairs} != {"server", "secret"}:
            return None
        params = dict(pairs)
        server, secret = params["server"], params["secret"]
        if len(server) > 253 or not HOST_RE.fullmatch(server) or server.lower().endswith((".local", ".localhost", ".internal", ".test", ".invalid")):
            return None
        if not SECRET_RE.fullmatch(secret):
            return None
        return server, secret
    except (ValueError, TypeError):
        return None


def utf16_slice(value, offset, length):
    return value.encode("utf-16-le")[offset * 2:(offset + length) * 2].decode("utf-16-le", errors="ignore")


def extract(message):
    candidates = []
    body = getattr(message, "message", None) or ""
    candidates.extend(match.group() for match in LINK_RE.finditer(html.unescape(body)))
    for entity in getattr(message, "entities", None) or []:
        if getattr(entity, "url", None):
            candidates.append(entity.url)
        elif entity.__class__.__name__ == "MessageEntityUrl":
            candidates.append(utf16_slice(body, entity.offset, entity.length))
    for row in getattr(message, "buttons", None) or []:
        for button in row:
            if getattr(button, "url", None):
                candidates.append(button.url)
    found = []
    for candidate in candidates:
        for match in LINK_RE.finditer(html.unescape(candidate)):
            parsed = parse_link(match.group())
            if parsed and parsed not in found:
                found.append(parsed)
    return found
