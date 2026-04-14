#!/bin/bash
# Baseline downloader — hero/swatch/output for all 9 benchmark jobs.
# Uses the Supabase anon key + signed URL endpoint to avoid leaking service role.
# Run from repo root: bash benchmarks/download-baseline.sh
set -e

SUPA_KEY=$(grep '^NEXT_PUBLIC_SUPABASE_ANON_KEY=' .env.local | cut -d= -f2-)
SUPA_URL=$(grep '^NEXT_PUBLIC_SUPABASE_URL=' .env.local | cut -d= -f2-)
DEST="benchmarks/2026-04-14-baseline/images"
mkdir -p "$DEST"

# Format: jobId|role|storagePath|ext
JOBS=(
  "59311c2c|hero|projects/d1080ce4-90c4-472b-ba4f-58fa92780cb7/heroes/79636377-9fee-44fd-add4-fd53ebe04742.jpg|jpg"
  "59311c2c|swatch|projects/d1080ce4-90c4-472b-ba4f-58fa92780cb7/swatches/de257eee-854a-48c8-89ae-f713ba7e49f6.jpg|jpg"
  "59311c2c|output|projects/d1080ce4-90c4-472b-ba4f-58fa92780cb7/generated/59311c2c-77c4-423f-a368-e2b64278caa5.png|png"

  "4dd41eb8|hero|projects/d1080ce4-90c4-472b-ba4f-58fa92780cb7/heroes/c79d2124-41fb-442c-b5b2-db9bc8501938.jpg|jpg"
  "4dd41eb8|swatch|projects/d1080ce4-90c4-472b-ba4f-58fa92780cb7/swatches/922f2ae2-4071-4f6c-8907-2ea3f7db7103.jpg|jpg"
  "4dd41eb8|output|projects/d1080ce4-90c4-472b-ba4f-58fa92780cb7/generated/4dd41eb8-5697-48c8-9a3e-7d2ce5f87b59.png|png"

  "ce8f8632|hero|projects/d1080ce4-90c4-472b-ba4f-58fa92780cb7/heroes/74bf0fbf-bd52-412a-8370-5f9280e7edff.png|png"
  "ce8f8632|swatch|projects/d1080ce4-90c4-472b-ba4f-58fa92780cb7/swatches/38ca2d47-102b-494d-8160-c661b7b3c86d.jpg|jpg"
  "ce8f8632|output|projects/d1080ce4-90c4-472b-ba4f-58fa92780cb7/generated/ce8f8632-5326-49e9-a2fb-1299b2586ec5.png|png"

  "24e9e5c5|hero|projects/d1080ce4-90c4-472b-ba4f-58fa92780cb7/heroes/c9e4e2d8-1e8c-428a-af11-9e23d770d577.jpg|jpg"
  "24e9e5c5|swatch|projects/d1080ce4-90c4-472b-ba4f-58fa92780cb7/swatches/e9b25dcd-7f5b-462c-b602-f3ae299a7b8b.jpg|jpg"
  "24e9e5c5|output|projects/d1080ce4-90c4-472b-ba4f-58fa92780cb7/generated/24e9e5c5-b65b-40c9-a75f-62c7cda15233.png|png"

  "be60f007|hero|projects/d1080ce4-90c4-472b-ba4f-58fa92780cb7/heroes/f2d5abe2-3fc2-46d7-8e82-3742ed435f21.png|png"
  "be60f007|swatch|projects/d1080ce4-90c4-472b-ba4f-58fa92780cb7/swatches/f12c8d3f-548d-4bea-9261-e19655b6d7c4.jpg|jpg"
  "be60f007|output|projects/d1080ce4-90c4-472b-ba4f-58fa92780cb7/generated/be60f007-a5e1-42a9-95a3-30770324a4de.png|png"

  "b358c64f|hero|projects/d1080ce4-90c4-472b-ba4f-58fa92780cb7/heroes/c79d2124-41fb-442c-b5b2-db9bc8501938.jpg|jpg"
  "b358c64f|swatch|projects/d1080ce4-90c4-472b-ba4f-58fa92780cb7/swatches/6c0e261f-690c-421b-85b2-59c2521cc590_from_result.png|png"
  "b358c64f|output|projects/d1080ce4-90c4-472b-ba4f-58fa92780cb7/generated/b358c64f-bdc6-4066-a77c-4258c3bfbfe5.png|png"

  "98827373|hero|projects/c91ff606-b40a-4831-9494-6e07c1c72aa8/heroes/907f7a99-22b9-4db4-8bf6-e70098c0c5f1.png|png"
  "98827373|swatch|projects/c91ff606-b40a-4831-9494-6e07c1c72aa8/swatches/c085c238-7eef-42c5-a045-9d7143b9b253.jpg|jpg"
  "98827373|output|projects/c91ff606-b40a-4831-9494-6e07c1c72aa8/generated/98827373-8a37-43f1-8434-add20379f5c9.png|png"

  "f651b980|hero|projects/d1080ce4-90c4-472b-ba4f-58fa92780cb7/heroes/c79d2124-41fb-442c-b5b2-db9bc8501938.jpg|jpg"
  "f651b980|swatch|projects/d1080ce4-90c4-472b-ba4f-58fa92780cb7/swatches/de257eee-854a-48c8-89ae-f713ba7e49f6.jpg|jpg"
  "f651b980|output|projects/d1080ce4-90c4-472b-ba4f-58fa92780cb7/generated/f651b980-2894-44e7-aa6d-4bcd9b359aee.png|png"

  "28a3a069|hero|projects/1967331d-7d07-49af-92c6-7f77e5292b72/heroes/7c3d97ff-310c-42d5-81b5-9cf8ddc1d721.png|png"
  "28a3a069|swatch|projects/1967331d-7d07-49af-92c6-7f77e5292b72/swatches/8439fc25-b2ad-44a4-8671-9b58b2fdde7a.webp|webp"
  "28a3a069|output|projects/1967331d-7d07-49af-92c6-7f77e5292b72/generated/JSAFAB430P20S_rojo_lifestyle_v2_28a3a069.png|png"
)

ok=0
fail=0
for entry in "${JOBS[@]}"; do
  IFS='|' read -r jobId role path ext <<< "$entry"
  out="$DEST/${jobId}_${role}.${ext}"
  if [ -f "$out" ]; then
    echo "SKIP $out (exists)"
    ok=$((ok+1))
    continue
  fi
  # Get signed URL
  signResp=$(curl -sS -X POST "${SUPA_URL}/storage/v1/object/sign/images/${path}" \
    -H "Authorization: Bearer ${SUPA_KEY}" \
    -H "Content-Type: application/json" \
    -d '{"expiresIn":3600}')
  token=$(echo "$signResp" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('signedURL',''))")
  if [ -z "$token" ]; then
    echo "FAIL sign $jobId $role ($path): $signResp" >&2
    fail=$((fail+1))
    continue
  fi
  # Download
  http=$(curl -sS -o "$out" -w '%{http_code}' "${SUPA_URL}/storage/v1${token}")
  if [ "$http" != "200" ]; then
    echo "FAIL download $jobId $role http=$http"
    rm -f "$out"
    fail=$((fail+1))
  else
    size=$(wc -c < "$out" | tr -d ' ')
    echo "OK   $out (${size}B)"
    ok=$((ok+1))
  fi
done

echo ""
echo "=== Summary: $ok ok, $fail fail ==="
ls -la "$DEST" | tail -40
