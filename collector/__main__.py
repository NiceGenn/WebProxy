import asyncio
import getpass
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from .extract import extract
from .publish import publish
from .store import Store, utc_now

DATA_DIR = Path(os.getenv("DATA_DIR", "/data"))
LOG = logging.getLogger("collector")


def settings():
    api_id = int(os.environ["TELEGRAM_API_ID"])
    api_hash = os.environ["TELEGRAM_API_HASH"]
    if not api_hash or not (1 <= int(os.getenv("INITIAL_DEPTH", "500")) <= 10000):
        raise ValueError("Invalid Telegram settings")
    channel = os.getenv("TELEGRAM_CHANNEL", "webproxy").lstrip("@")
    return api_id, api_hash, channel


def auth():
    from telethon.sync import TelegramClient
    api_id, api_hash, _ = settings()
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    client = TelegramClient(str(DATA_DIR / "telegram"), api_id, api_hash)
    try:
        client.start(phone=lambda: getpass.getpass("Telegram phone (hidden): "), code_callback=lambda: getpass.getpass("Telegram code (hidden): "), password=lambda: getpass.getpass("Telegram 2FA password (hidden): "))
        if not client.is_user_authorized():
            raise RuntimeError("Telegram authorization failed")
    finally:
        client.disconnect()
    print("Telegram authorization saved in the private Docker volume.")


def save_pat():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    token = getpass.getpass("Fine-grained GitHub PAT (Contents read/write): ").strip()
    if not token:
        raise ValueError("Empty token")
    target = DATA_DIR / "github_pat"
    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        stream.write(token)
    print("GitHub token saved in the private Docker volume.")


def health():
    path = DATA_DIR / "health.txt"
    try:
        last = datetime.fromisoformat(path.read_text(encoding="utf-8"))
        age = (datetime.now(timezone.utc) - last).total_seconds()
        return 0 if age < int(os.getenv("POLL_SECONDS", "600")) * 3 + 120 else 1
    except (OSError, ValueError):
        return 1


async def run():
    from telethon import TelegramClient, events
    from telethon.errors import FloodWaitError
    api_id, api_hash, channel = settings()
    depth = int(os.getenv("INITIAL_DEPTH", "500"))
    rescan_depth = int(os.getenv("RESCAN_DEPTH", "500"))
    poll_seconds = int(os.getenv("POLL_SECONDS", "600"))
    if rescan_depth < 1 or poll_seconds < 60:
        raise ValueError("RESCAN_DEPTH must be positive and POLL_SECONDS at least 60")
    store = Store(DATA_DIR)
    client = TelegramClient(str(DATA_DIR / "telegram"), api_id, api_hash, auto_reconnect=True)
    lock = asyncio.Lock()
    pending = []
    catching_up = True

    async def process(message, advance_position=True):
        async with lock:
            store.ingest(message, extract(message), channel, advance_position)

    async def fetch_since(last_id):
        count = 0
        async for message in client.iter_messages(channel, min_id=last_id, reverse=True):
            await process(message)
            count += 1
        return count

    async def scan_recent(limit):
        messages = [message async for message in client.iter_messages(channel, limit=limit)]
        for message in reversed(messages):
            await process(message)
        return len(messages)

    async def finish_collection():
        store.set("last_success", utc_now())
        (DATA_DIR / "health.txt").write_text(store.get("last_success"), encoding="utf-8")
        store.export_if_changed()
        try:
            outcome = await asyncio.to_thread(publish, DATA_DIR, os.getenv("GITHUB_REPOSITORY", "NiceGenn/WebProxy"), os.getenv("GITHUB_BRANCH", "main"))
            LOG.info("GitHub publication: %s", outcome)
        except Exception as error:
            LOG.warning("GitHub publication failed: %s", type(error).__name__)

    @client.on(events.NewMessage(chats=channel))
    @client.on(events.MessageEdited(chats=channel))
    async def on_message(event):
        nonlocal catching_up
        if catching_up:
            pending.append(event.message)
        else:
            await process(event.message, False)
            # The next periodic pass publishes a stable batch.

    while True:
        try:
            await client.connect()
            if not await client.is_user_authorized():
                LOG.error("Telegram session missing or expired. Run the separate auth command.")
                return 2
            catching_up = True
            start_id = int(store.get("last_id", "0"))
            if start_id == 0 and store.get("initialized") is None:
                count = await scan_recent(depth)
                store.set("initialized", "1")
            else:
                count = await fetch_since(start_id)
            # Re-read recent messages to detect edits made while the collector was offline.
            await scan_recent(rescan_depth)
            while pending:
                await process(pending.pop(0), False)
            catching_up = False
            await finish_collection()
            LOG.info("Telegram collection successful; catch-up messages: %d", count)
            while client.is_connected():
                try:
                    await asyncio.wait_for(asyncio.shield(client.disconnected), timeout=poll_seconds)
                    break
                except asyncio.TimeoutError:
                    pass
                await fetch_since(int(store.get("last_id", "0")))
                await scan_recent(rescan_depth)
                await finish_collection()
        except FloodWaitError as error:
            LOG.warning("Telegram FloodWait: waiting %d seconds", error.seconds)
            await asyncio.sleep(error.seconds + 1)
        except (OSError, TimeoutError, ConnectionError) as error:
            LOG.warning("Temporary Telegram/network failure: %s; retrying in 30 seconds", type(error).__name__)
            await asyncio.sleep(30)
        except Exception as error:
            LOG.error("Collector error: %s; retrying in 60 seconds", type(error).__name__)
            await asyncio.sleep(60)
        finally:
            catching_up = True
            if client.is_connected():
                await client.disconnect()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    logging.getLogger("telethon").setLevel(logging.ERROR)
    command = sys.argv[1] if len(sys.argv) > 1 else "run"
    if command == "auth":
        auth()
    elif command == "token":
        save_pat()
    elif command == "health":
        sys.exit(health())
    elif command == "run":
        sys.exit(asyncio.run(run()))
    else:
        raise SystemExit("Use run, auth, token or health")
