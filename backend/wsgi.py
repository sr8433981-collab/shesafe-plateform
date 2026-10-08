"""SheSafe API entrypoint.

Run with either::

    python -m backend.wsgi            # from the repository root
    python backend/wsgi.py            # from anywhere
    flask --app backend.wsgi run

Environment:

===========================  =========================================================
``SHESAFE_ENV``              ``development`` (default) | ``production`` | ``testing``
``SHESAFE_SECRET_KEY``       **Required** in production. Never commit it.
``SHESAFE_DEMO_MODE``        ``1`` enables the clearly-labelled Demo Mode.
``SHESAFE_DB``               Path to the SQLite file.
``PORT`` / ``HOST``          Listen address (default ``127.0.0.1:5000``).
``SHESAFE_CORS_ORIGINS``     Comma-separated allowlist for credentialed requests.
===========================  =========================================================
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent
REPO_ROOT = BACKEND_DIR.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from backend.app import create_app  # noqa: E402
from backend.app.security import is_trusted_origin  # noqa: E402,F401

app = create_app()


def main() -> None:  # pragma: no cover - manual entrypoint
    from backend.app.config import load_config

    cfg = load_config()
    debug = cfg.ENV == "development" and bool(os.environ.get("SHESAFE_FLASK_DEBUG"))
    app.run(host=cfg.HOST, port=cfg.PORT, debug=debug, use_reloader=False)


if __name__ == "__main__":  # pragma: no cover
    main()