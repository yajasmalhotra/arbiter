from __future__ import annotations

import json
import os
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from arbiter_integrations.http_client import ArbiterHTTPClient


class TestHTTPClientLocalDiscovery(unittest.TestCase):
    def test_discovers_base_url_from_local_config(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            cfg_path = pathlib.Path(temp_dir) / "config.json"
            cfg_path.write_text(
                json.dumps(
                    {
                        "base_url": "http://127.0.0.1:18080/",
                        "tenant_id": "tenant-local",
                    }
                ),
                encoding="utf-8",
            )

            old = os.environ.get("ARBITER_LOCAL_CONFIG_PATH")
            os.environ["ARBITER_LOCAL_CONFIG_PATH"] = str(cfg_path)
            try:
                client = ArbiterHTTPClient()
            finally:
                if old is None:
                    os.environ.pop("ARBITER_LOCAL_CONFIG_PATH", None)
                else:
                    os.environ["ARBITER_LOCAL_CONFIG_PATH"] = old

            self.assertEqual(client.base_url, "http://127.0.0.1:18080")


if __name__ == "__main__":
    unittest.main()

