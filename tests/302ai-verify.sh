#!/usr/bin/env bash
# Live regression check of 302.AI as the AI-proxy upstream (ai-proxy.js).
# Unlike a plain curl dump, every check here ASSERTS on HTTP status / error
# shape / stream framing and exits non-zero if anything regresses — 302.AI's
# model catalogue, error shapes, or streaming format can all change under us.
#
#   1-2. qwen3.8-flash / qwen3.7-plus / glm-5.3-flash — model exists, real
#        completion
#   3.   streaming — SSE `data: {...}` frames + usage frame + [DONE]
#        (postStream() in src/lib/http.js parses this exact shape)
#   4.   vision — a REAL 64x64 data:image/png;base64 part on the live models.
#        NOTE: a 1x1 pixel here 400s with err_code -10003 "Parameter error" —
#        302.AI enforces a minimum image size, so a tiny placeholder image
#        proves nothing. Do not shrink this back down.
#   5.   JSON mode — response_format {"type":"json_object"}, text-only
#   6.   quality policy per model — qwen3.8-flash's reasoning_effort in its own
#        low/medium/xhigh vocabulary; GLM forced thinking + max effort; older
#        Qwen sent bare. This is exactly what the VPS builds.
#   7.   error shape — deliberately bogus model name, protects the
#        isUnpurchased() regex in backend/src/ai-proxy.js from silently
#        breaking if 302.AI ever changes their error format
#
# CHECK 6 IS THE LOAD-BEARING ONE. The whole routing consolidation rests on
# 302.AI accepting `reasoning_effort` on qwen3.8-flash: Qwen documents the knob
# for this model (levels xhigh / medium / low — note there is NO "high"), but a
# reseller passthrough is a separate fact from a vendor doc, and only this
# script settles it. If the xhigh case fails with err_code -10003, the model
# does NOT take the field on 302.AI: move `qwen3.8-flash` back under
# QWEN_NO_EFFORT in backend-vps/server.js + backend/src/ai-proxy.js and say so
# in the comment there. (Until then the servers degrade rather than break — a
# -10003 makes them retry the same model once with the field removed, see
# isParameterRejection.)
#
# The "high" case below documents the vocabulary gap: the client's hint set is
# low/medium/high, so the servers TRANSLATE high → xhigh rather than forwarding
# it. If that check starts passing, 302.AI has widened what it accepts and the
# translation is merely redundant, not wrong.
#
# Usage:  API_302_KEY=sk-... bash tests/302ai-verify.sh
set -u
BASE="https://api.302.ai/v1/chat/completions"
KEY="${API_302_KEY:?Set API_302_KEY to your 302.AI API key}"
FAIL=0

# 64x64 solid-red PNG, generated fresh each run (no binary fixture to rot).
PNG_B64=$(python3 - <<'PYEOF'
import zlib, struct, base64
w = h = 64
def chunk(tag, data):
    c = tag + data
    return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c))
raw = b''.join(b'\x00' + b'\xE8\x3E\x30' * w for _ in range(h))
png = (b'\x89PNG\r\n\x1a\n'
       + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
       + chunk(b'IDAT', zlib.compress(raw))
       + chunk(b'IEND', b''))
print(base64.b64encode(png).decode())
PYEOF
)
if [ -z "$PNG_B64" ]; then
  echo "✘ failed to generate the test PNG (need python3 with zlib) — aborting"
  exit 1
fi

pass() { echo "  ✔ $1"; }
fail() { echo "  ✘ $1"; FAIL=1; }
note() { echo "  ℹ $1"; }

# assert_ok <label> <json-body> — expects HTTP 200 and no top-level error object.
assert_ok() {
  local label="$1" body="$2" resp status payload
  resp=$(curl -sS --max-time 90 "$BASE" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d "$body" -w $'\n%{http_code}')
  status=$(echo "$resp" | tail -1)
  payload=$(echo "$resp" | sed '$d')
  if [ "$status" != "200" ]; then fail "$label — HTTP $status: $(echo "$payload" | head -c 300)"; return; fi
  if echo "$payload" | grep -q '"error":{'; then fail "$label — HTTP 200 with an error payload: $(echo "$payload" | head -c 300)"; return; fi
  pass "$label"
}

# assert_stream <label> <json-body> — expects SSE frames, a usage object, and
# a terminal [DONE], with no error frame anywhere in the stream.
assert_stream() {
  local label="$1" body="$2" out
  out=$(curl -sS -N --max-time 90 "$BASE" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d "$body")
  if echo "$out" | grep -q '"error":{'; then fail "$label — error frame in stream: $(echo "$out" | grep -o '"error":{[^}]*}' | head -1)"; return; fi
  if ! echo "$out" | grep -q '^data: \[DONE\]'; then fail "$label — stream did not end with [DONE]"; return; fi
  if ! echo "$out" | grep -q '"usage":{"'; then fail "$label — no usage frame in stream"; return; fi
  pass "$label"
}

# report_only <label> <json-body> — dispatches and PRINTS the verdict without
# ever failing the run. For facts worth knowing that no code depends on.
report_only() {
  local label="$1" body="$2" resp status payload
  resp=$(curl -sS --max-time 90 "$BASE" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d "$body" -w $'\n%{http_code}')
  status=$(echo "$resp" | tail -1)
  payload=$(echo "$resp" | sed '$d')
  if [ "$status" == "200" ] && ! echo "$payload" | grep -q '"error":{'; then
    note "$label — ACCEPTED (HTTP 200)"
  else
    note "$label — rejected (HTTP $status): $(echo "$payload" | head -c 200)"
  fi
}

# assert_error <label> <json-body> <expected-substring-in-body> — expects a
# non-200 with the given marker, protecting isUnpurchased()'s assumptions.
assert_error() {
  local label="$1" body="$2" marker="$3" resp status payload
  resp=$(curl -sS --max-time 90 "$BASE" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d "$body" -w $'\n%{http_code}')
  status=$(echo "$resp" | tail -1)
  payload=$(echo "$resp" | sed '$d')
  if [ "$status" == "200" ]; then fail "$label — expected an error, got HTTP 200: $(echo "$payload" | head -c 300)"; return; fi
  if ! echo "$payload" | grep -q "$marker"; then fail "$label — error body missing expected marker '$marker': $(echo "$payload" | head -c 300)"; return; fi
  pass "$label (HTTP $status)"
}

echo "1-2. model existence"
assert_ok "qwen3.8-flash plain completion"     '{"model":"qwen3.8-flash","messages":[{"role":"user","content":"привет"}],"max_tokens":20}'
assert_ok "qwen3.7-plus plain completion"      '{"model":"qwen3.7-plus","messages":[{"role":"user","content":"привет"}],"max_tokens":20}'
assert_ok "glm-5.3-flash plain completion"     '{"model":"glm-5.3-flash","messages":[{"role":"user","content":"привет"}],"max_tokens":100}'

echo "3. streaming + usage frame"
assert_stream "qwen3.8-flash streaming"     '{"model":"qwen3.8-flash","messages":[{"role":"user","content":"скажи одно слово"}],"reasoning_effort":"xhigh","max_tokens":300,"stream":true,"stream_options":{"include_usage":true}}'
assert_stream "qwen3.7-plus streaming"      '{"model":"qwen3.7-plus","messages":[{"role":"user","content":"скажи одно слово"}],"max_tokens":20,"stream":true,"stream_options":{"include_usage":true}}'
assert_stream "glm-5.3-flash streaming"     '{"model":"glm-5.3-flash","messages":[{"role":"user","content":"скажи одно слово"}],"thinking":{"type":"enabled"},"reasoning_effort":"max","max_tokens":300,"stream":true,"stream_options":{"include_usage":true}}'

echo "4. vision (64x64 data: image_url part)"
# The live model for every image, on both routes. A test solve from the pill
# sends exactly this shape (page screenshot + prompt) with NO response_format —
# see the VPS's dropJsonForQwenVision.
assert_ok "qwen3.8-flash vision" '{"model":"qwen3.8-flash","messages":[{"role":"user","content":[{"type":"text","text":"Какого цвета картинка? Одно слово."},{"type":"image_url","image_url":{"url":"data:image/png;base64,'"$PNG_B64"'"}}]}],"reasoning_effort":"xhigh","max_tokens":600}'
assert_ok "glm-5.3-flash vision" '{"model":"glm-5.3-flash","messages":[{"role":"user","content":[{"type":"text","text":"Какого цвета картинка? Одно слово."},{"type":"image_url","image_url":{"url":"data:image/png;base64,'"$PNG_B64"'"}}]}],"thinking":{"type":"enabled"},"reasoning_effort":"max","max_tokens":300}'
assert_ok "qwen3.7-plus vision (fallback)" '{"model":"qwen3.7-plus","messages":[{"role":"user","content":[{"type":"text","text":"Какого цвета картинка? Одно слово."},{"type":"image_url","image_url":{"url":"data:image/png;base64,'"$PNG_B64"'"}}]}],"max_tokens":300}'

echo "5. JSON mode (text-only)"
# The text test-solve path on the live model: JSON mode AND an effort field.
assert_ok "qwen3.8-flash JSON mode" '{"model":"qwen3.8-flash","messages":[{"role":"user","content":"Верни JSON вида {\"answers\": [{\"n\": 1, \"a\": \"4\"}]} с ответом 2+2"}],"response_format":{"type":"json_object"},"reasoning_effort":"xhigh","max_tokens":600}'
assert_ok "glm-5.3-flash JSON mode" '{"model":"glm-5.3-flash","messages":[{"role":"user","content":"Верни JSON вида {\"answer\": \"...\"} с ответом 2+2"}],"response_format":{"type":"json_object"},"thinking":{"type":"enabled"},"reasoning_effort":"max","max_tokens":300}'
assert_ok "qwen3.7-plus JSON mode (fallback)" '{"model":"qwen3.7-plus","messages":[{"role":"user","content":"Верни JSON вида {\"answers\": [{\"n\": 1, \"a\": \"4\"}]} с ответом 2+2"}],"response_format":{"type":"json_object"},"max_tokens":300}'

echo "6. per-model quality policy"
# THE check this consolidation depends on: does 302.AI pass reasoning_effort
# through to qwen3.8-flash at all, in Qwen's own vocabulary? xhigh is what
# every МЭШ homework and test solve sends; low is the any-site cheap chain.
assert_ok "qwen3.8-flash reasoning_effort=xhigh (frontier)" '{"model":"qwen3.8-flash","messages":[{"role":"user","content":"сколько будет 17*23? Сначала проверь вычисление."}],"reasoning_effort":"xhigh","max_tokens":900}'
assert_ok "qwen3.8-flash reasoning_effort=medium"           '{"model":"qwen3.8-flash","messages":[{"role":"user","content":"сколько будет 17*23? Сначала проверь вычисление."}],"reasoning_effort":"medium","max_tokens":900}'
assert_ok "qwen3.8-flash reasoning_effort=low (any-site)"   '{"model":"qwen3.8-flash","messages":[{"role":"user","content":"сколько будет 17*23? Сначала проверь вычисление."}],"reasoning_effort":"low","max_tokens":900}'
# Informational only — nothing sends this. Qwen documents xhigh/medium/low and
# no "high", which is why the servers translate the client's hint instead of
# forwarding it. Whether 302.AI is strict about it is worth knowing, not worth
# failing over.
report_only "qwen3.8-flash reasoning_effort=high (not a Qwen level)" '{"model":"qwen3.8-flash","messages":[{"role":"user","content":"привет"}],"reasoning_effort":"high","max_tokens":20}'
assert_ok "glm-5.3-flash thinking=max" '{"model":"glm-5.3-flash","messages":[{"role":"user","content":"сколько будет 17*23? Сначала проверь вычисление."}],"thinking":{"type":"enabled"},"reasoning_effort":"max","max_tokens":500}'
# Older Qwen is sent BARE — it thinks by default and has no effort levels.
assert_ok "qwen3.7-plus bare (thinks by default)" '{"model":"qwen3.7-plus","messages":[{"role":"user","content":"сколько будет 17*23? Сначала проверь вычисление."}],"max_tokens":500}'

echo "7. error shape for an unavailable model (guards isUnpurchased())"
assert_error "bogus model name" '{"model":"smesh-definitely-not-a-model","messages":[{"role":"user","content":"hi"}],"max_tokens":5}' '"err_code":-10008'

echo
if [ "$FAIL" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
else
  echo "SOME CHECKS FAILED — see ✘ above"
  exit 1
fi
