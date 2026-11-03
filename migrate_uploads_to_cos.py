"""Migrate local uploads/ to Tencent COS and update DB references."""
import os
import sys
import glob
import mimetypes
from qcloud_cos import CosConfig, CosS3Client

# --- COS config ---
BUCKET = "ccy-canvas-1334659054"
REGION = "ap-beijing"
SECRET_ID = os.environ["COS_SECRET_ID"]
SECRET_KEY = os.environ["COS_SECRET_KEY"]
KEY_PREFIX = os.environ.get("COS_KEY_PREFIX", "ccy-canvas")
PUBLIC_BASE = os.environ.get("COS_PUBLIC_BASE_URL",
    f"https://{BUCKET}.cos.{REGION}.myqcloud.com").rstrip("/")

config = CosConfig(Region=REGION, SecretId=SECRET_ID, SecretKey=SECRET_KEY)
client = CosS3Client(config)

UPLOADS_DIR = os.path.join(os.path.dirname(__file__), "uploads")

def upload_file(local_path, cos_key):
    content_type = mimetypes.guess_type(local_path)[0] or "application/octet-stream"
    with open(local_path, "rb") as f:
        client.put_object(
            Bucket=BUCKET,
            Key=cos_key,
            Body=f,
            ContentType=content_type,
            CacheControl="public, max-age=31536000",
        )

def main():
    files = glob.glob(os.path.join(UPLOADS_DIR, "**", "*"), recursive=True)
    files = [f for f in files if os.path.isfile(f)]
    total = len(files)
    print(f"Found {total} files to upload")

    ok, fail = 0, 0
    for i, fpath in enumerate(files, 1):
        # uploads/2026-06/xxx.png -> 2026-06/xxx.png
        rel = os.path.relpath(fpath, UPLOADS_DIR).replace("\\", "/")
        cos_key = f"{KEY_PREFIX}/{rel}"
        try:
            upload_file(fpath, cos_key)
            ok += 1
            if i % 50 == 0 or i == total:
                print(f"  [{i}/{total}] uploaded {cos_key}")
        except Exception as e:
            fail += 1
            print(f"  FAIL {cos_key}: {e}")

    print(f"\nDone: {ok} uploaded, {fail} failed")

    # Print old->new URL mapping info
    old_prefix = "/uploads/"
    new_prefix = f"{PUBLIC_BASE}/{KEY_PREFIX}/"
    print(f"\nDB update: replace '{old_prefix}' with '{new_prefix}'")

if __name__ == "__main__":
    main()
