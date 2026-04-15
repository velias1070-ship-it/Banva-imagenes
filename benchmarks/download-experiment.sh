#!/bin/bash
# Download experiment outputs after Fase 1 regens — ONLY the output.png
# (hero and swatch are identical to baseline, no need to re-download).
# Usage: bash benchmarks/download-experiment.sh <label>
# Example: bash benchmarks/download-experiment.sh h1-h3
set -e

LABEL="${1:-h1-h3}"
SUPA_KEY=$(grep '^NEXT_PUBLIC_SUPABASE_ANON_KEY=' .env.local | cut -d= -f2-)
SUPA_URL=$(grep '^NEXT_PUBLIC_SUPABASE_URL=' .env.local | cut -d= -f2-)
DEST="benchmarks/2026-04-14-experiment-${LABEL}/images"
mkdir -p "$DEST"

# Fetch the CURRENT output_storage_path for each job via debug endpoint,
# since the path can change across regens (BRAND_ONLY flow bumps filename).
JOBS=(
  "59311c2c-77c4-423f-a368-e2b64278caa5"
  "4dd41eb8-5697-48c8-9a3e-7d2ce5f87b59"
  "ce8f8632-5326-49e9-a2fb-1299b2586ec5"
  "24e9e5c5-b65b-40c9-a75f-62c7cda15233"
  "be60f007-a5e1-42a9-95a3-30770324a4de"
  "b358c64f-bdc6-4066-a77c-4258c3bfbfe5"
  "f651b980-2894-44e7-aa6d-4bcd9b359aee"
  "98827373-8a37-43f1-8434-add20379f5c9"
  "28a3a069-a81a-482a-9cd9-287397f6ae14"
)

ok=0
fail=0
for jobId in "${JOBS[@]}"; do
  short="${jobId:0:8}"
  # Use debug endpoint to get the fresh signed URL (handles URL expiry automatically)
  debugResp=$(curl -sS "https://banva-app.vercel.app/api/debug/jobs/${jobId}")
  url=$(echo "$debugResp" | python3 -c "import sys,json;d=json.load(sys.stdin);print((d.get('images') or {}).get('output') or '')")
  if [ -z "$url" ] || [ "$url" = "null" ]; then
    echo "FAIL ${short}: no output URL"
    fail=$((fail+1))
    continue
  fi
  out="$DEST/${short}_output.png"
  http=$(curl -sS -o "$out" -w '%{http_code}' "$url")
  if [ "$http" != "200" ]; then
    echo "FAIL ${short}: http=$http"
    rm -f "$out"
    fail=$((fail+1))
  else
    size=$(wc -c < "$out" | tr -d ' ')
    status=$(echo "$debugResp" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('status','?'))")
    echo "OK   ${short}: ${size}B (status=$status)"
    ok=$((ok+1))
  fi
done

echo ""
echo "=== Summary: $ok ok, $fail fail — saved to $DEST ==="
