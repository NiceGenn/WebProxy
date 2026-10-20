import json
import base64
import io
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from collector.extract import extract, parse_link
from collector.store import Store
from collector.publish import publish

SECRET = "Dd0123456789abcdef0123456789ABCDEF"
LINK = f"https://t.me/webproxy?server=Web.Example.org&secret={SECRET}"


class MessageEntityUrl:
    def __init__(self, offset, length):
        self.offset, self.length = offset, length


class CollectorTests(unittest.TestCase):
    def message(self, message_id, body="", entities=None, buttons=None, edit_date=None):
        return SimpleNamespace(id=message_id, date=datetime(2026, 10, 13, tzinfo=timezone.utc),
                               message=body, entities=entities or [], buttons=buttons or [], edit_date=edit_date)

    def test_text_entities_buttons_and_non_webproxy_links(self):
        tg = f"tg://webproxy?server=Web.Example.org&secret={SECRET}"
        body = "😀 " + LINK + "\n" + tg + "\nhttps://t.me/proxy?server=bad.example.org&secret=" + SECRET
        offset = len("😀 ".encode("utf-16-le")) // 2
        entity = MessageEntityUrl(offset, len(LINK))
        hidden = SimpleNamespace(url=LINK)
        button = SimpleNamespace(url=tg)
        message = self.message(1, body, [entity, hidden], [[button]])
        self.assertEqual(extract(message), [("Web.Example.org", SECRET)])
        self.assertIsNone(parse_link("https://t.me/webproxy"))
        self.assertIsNone(parse_link(f"https://t.me/proxy?server=Web.Example.org&secret={SECRET}"))
        self.assertIsNone(parse_link(f"{LINK}&secret=1234"))

    def test_store_dedup_export_and_restart_cursor(self):
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as directory:
            store = Store(directory)
            self.assertTrue(store.ingest(self.message(10, LINK), [("Web.Example.org", SECRET)], "webproxy"))
            self.assertTrue(store.ingest(self.message(11, LINK), [("Web.Example.org", SECRET)], "webproxy"))
            self.assertEqual(store.get("last_id"), "11")
            self.assertTrue(store.export_if_changed())
            first = (Path(directory) / "webproxy.json").read_bytes()
            self.assertFalse(store.export_if_changed())
            self.assertEqual(first, (Path(directory) / "webproxy.json").read_bytes())
            data = json.loads(first)
            self.assertEqual(len(data["proxies"]), 1)
            self.assertEqual(data["proxies"][0]["secret"], SECRET)
            self.assertEqual(data["proxies"][0]["source_url"], "https://t.me/webproxy/11")
            store.db.close()
            reopened = Store(directory)
            self.assertEqual(reopened.get("last_id"), "11")
            self.assertFalse(reopened.export_if_changed())
            reopened.ingest(self.message(13, LINK), [("Web.Example.org", SECRET)], "webproxy", False)
            self.assertEqual(reopened.get("last_id"), "11")
            reopened.ingest(self.message(12), [], "webproxy")
            self.assertEqual(reopened.get("last_id"), "12")
            reopened.ingest(self.message(13, LINK), [("Web.Example.org", SECRET)], "webproxy")
            self.assertEqual(reopened.get("last_id"), "13")
            reopened.db.close()

    def test_github_publisher_skips_equal_data_and_writes_changed_data(self):
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as directory:
            root = Path(directory)
            (root / "github_pat").write_text("test-token", encoding="utf-8")
            (root / "webproxy.json").write_bytes(b'{"proxies":[]}\n')
            calls = []

            def fake_urlopen(request, timeout):
                calls.append(request)
                if request.get_method() == "GET":
                    content = b'{"proxies":[]}\n' if len(calls) == 1 else b'{"proxies":[1]}\n'
                    return io.BytesIO(json.dumps({"sha": "test-sha", "content": base64.b64encode(content).decode()}).encode())
                return io.BytesIO(b'{}')

            with patch("collector.publish.urlopen", fake_urlopen):
                self.assertEqual(publish(root, "NiceGenn/WebProxy", "main"), "unchanged")
                self.assertEqual(publish(root, "NiceGenn/WebProxy", "main"), "updated")
            self.assertEqual([call.get_method() for call in calls], ["GET", "GET", "PUT"])
            body = json.loads(calls[-1].data)
            self.assertEqual(body["sha"], "test-sha")
            self.assertEqual(base64.b64decode(body["content"]), b'{"proxies":[]}\n')
            self.assertTrue(calls[-1].full_url.endswith("/contents/site/webproxy.json"))


if __name__ == "__main__":
    unittest.main()
