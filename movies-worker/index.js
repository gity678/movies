name: 🎬 Upload Movie
on:
  workflow_dispatch:
    inputs:
      movie_url:
        description: 'رابط الفيلم'
        required: true
        type: string
      movie_name:
        description: 'اسم الفيلم'
        required: true
        type: string

jobs:
  upload:
    runs-on: ubuntu-latest
    timeout-minutes: 120

    steps:
      - name: Install dependencies
        run: |
          sudo apt-get update -qq
          sudo apt-get install -y ffmpeg python3-pip
          pip install yt-dlp boto3

      - name: Download & Convert & Upload
        env:
          B2_KEY_ID: ${{ secrets.B2_KEY_ID }}
          B2_APP_KEY: ${{ secrets.B2_APP_KEY }}
          B2_BUCKET: ${{ secrets.B2_BUCKET }}
          B2_ENDPOINT: ${{ secrets.B2_ENDPOINT }}
        run: |
          python3 - <<'EOF'
          import os, subprocess, boto3, glob
          from botocore.client import Config
          from concurrent.futures import ThreadPoolExecutor

          MOVIE_URL  = "${{ github.event.inputs.movie_url }}"
          RAW_NAME   = "${{ github.event.inputs.movie_name }}"
          CLEAN_NAME = RAW_NAME.strip().replace(" ", "_")

          B2_KEY_ID   = os.environ["B2_KEY_ID"]
          B2_APP_KEY  = os.environ["B2_APP_KEY"]
          B2_BUCKET   = os.environ["B2_BUCKET"]
          B2_ENDPOINT = os.environ["B2_ENDPOINT"]

          WORK_DIR = f"/tmp/{CLEAN_NAME}"
          os.makedirs(WORK_DIR, exist_ok=True)
          RAW_FILE = f"{WORK_DIR}/raw.mp4"

          print("⏳ جاري تحميل الفيلم...")
          result = subprocess.run([
              "yt-dlp",
              "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
              "--merge-output-format", "mp4",
              "-o", RAW_FILE,
              MOVIE_URL
          ], capture_output=True, text=True)

          if result.returncode != 0:
              print("❌ فشل التحميل:")
              print(result.stderr)
              exit(1)

          print("✅ تم التحميل")

          out_dir = f"{WORK_DIR}/480p"
          os.makedirs(out_dir, exist_ok=True)
          print("⚙️ جاري التحويل إلى 480p...")

          r = subprocess.run([
              "ffmpeg", "-i", RAW_FILE,
              "-vf", "scale=854:480",
              "-c:v", "libx264", "-b:v", "1000k",
              "-c:a", "aac", "-b:a", "128k",
              "-hls_time", "10",
              "-hls_playlist_type", "vod",
              "-hls_segment_filename", f"{out_dir}/seg_%03d.ts",
              f"{out_dir}/index.m3u8"
          ], capture_output=True, text=True)

          if r.returncode != 0:
              print("❌ فشل التحويل:")
              print(r.stderr[-1000:])
              exit(1)

          print("✅ تم التحويل إلى 480p")

          B2_BASE = f"https://{B2_ENDPOINT}/{B2_BUCKET}/movies/{CLEAN_NAME}"
          MASTER  = f"{WORK_DIR}/master.m3u8"

          with open(MASTER, "w") as f:
              f.write("#EXTM3U\n#EXT-X-VERSION:3\n\n")
              f.write(f"#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=854x480\n{B2_BASE}/480p/index.m3u8\n")

          print("✅ تم إنشاء master.m3u8")
          print("☁️ جاري الرفع إلى Backblaze B2...")

          s3 = boto3.client(
              "s3",
              endpoint_url=f"https://{B2_ENDPOINT}",
              aws_access_key_id=B2_KEY_ID,
              aws_secret_access_key=B2_APP_KEY,
              config=Config(signature_version="s3v4", max_pool_connections=20)
          )

          def upload_file(args):
              local, key, ctype = args
              s3.upload_file(local, B2_BUCKET, key, ExtraArgs={"ContentType": ctype})
              print(f"  ✅ {key}")

          files = [
              (MASTER, f"movies/{CLEAN_NAME}/master.m3u8", "application/vnd.apple.mpegurl"),
              (f"{out_dir}/index.m3u8", f"movies/{CLEAN_NAME}/480p/index.m3u8", "application/vnd.apple.mpegurl")
          ]

          for ts in sorted(glob.glob(f"{out_dir}/seg_*.ts")):
              fname = os.path.basename(ts)
              files.append((ts, f"movies/{CLEAN_NAME}/480p/{fname}", "video/mp2t"))

          with ThreadPoolExecutor(max_workers=10) as ex:
              ex.map(upload_file, files)

          print(f"\n🎉 تم الرفع بنجاح!")
          print(f"🔗 {B2_BASE}/master.m3u8")
          EOF