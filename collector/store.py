import hashlib
import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Store:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.directory / "collector.sqlite3")
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, fingerprint TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS proxies (
                server TEXT NOT NULL, secret TEXT NOT NULL,
                source_url TEXT NOT NULL, message_date TEXT NOT NULL,
                first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
                PRIMARY KEY (server, secret)
            );
        """)

    def get(self, key, default=None):
        row = self.db.execute("SELECT value FROM state WHERE key=?", (key,)).fetchone()
        return row[0] if row else default

    def set(self, key, value):
        self.db.execute("INSERT INTO state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, str(value)))
        self.db.commit()

    def ingest(self, message, links, channel, advance_position=True):
        message_id = int(message.id)
        source_date = message.date.astimezone(timezone.utc).isoformat(timespec="seconds")
        fingerprint = hashlib.sha256(json.dumps([source_date, getattr(message, "edit_date", None).isoformat() if getattr(message, "edit_date", None) else None, links], sort_keys=True).encode()).hexdigest()
        old = self.db.execute("SELECT fingerprint FROM messages WHERE id=?", (message_id,)).fetchone()
        if old and old[0] == fingerprint and not advance_position:
            return False
        observed = utc_now()
        source = f"https://t.me/{channel}/{message_id}"
        with self.db:
            self.db.execute("INSERT INTO messages(id,fingerprint) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET fingerprint=excluded.fingerprint", (message_id, fingerprint))
            if not old or old[0] != fingerprint:
                for server, secret in links:
                    self.db.execute("""INSERT INTO proxies VALUES(?,?,?,?,?,?)
                    ON CONFLICT(server,secret) DO UPDATE SET
                    source_url=excluded.source_url, message_date=excluded.message_date, last_seen=excluded.last_seen""",
                    (server, secret, source, source_date, observed, observed))
            current = int(self.get("last_id", "0"))
            if advance_position and message_id > current:
                self.db.execute("INSERT INTO state(key,value) VALUES('last_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (str(message_id),))
        return not old or old[0] != fingerprint

    def payload(self, collected_at):
        rows = self.db.execute("SELECT server, secret, source_url, message_date, first_seen, last_seen FROM proxies ORDER BY first_seen, server, secret").fetchall()
        return {"schema_version": 1, "channel": "webproxy", "collected_at": collected_at, "proxies": [dict(row) for row in rows]}

    def export_if_changed(self):
        path = self.directory / "webproxy.json"
        rows = self.payload("")["proxies"]
        digest = hashlib.sha256(json.dumps(rows, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        if path.exists() and self.get("export_digest") == digest:
            return False
        data = self.payload(utc_now())
        temporary = path.with_suffix(".json.tmp")
        with temporary.open("w", encoding="utf-8") as stream:
            json.dump(data, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        self.set("export_digest", digest)
        return True
