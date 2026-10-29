#!/usr/bin/env bash
# Renders Chrome Web Store images from store/src/*.html into store/*.png with headless Chrome.
set -euo pipefail

cd "$(dirname "$0")"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

# The popup demo is the real popup.html with API stubs injected, so screenshots track the actual UI.
mkdir -p build
sed \
  -e 's#href="popup.css"#href="../../popup.css"#' \
  -e 's#<script src="core.js"></script>#<script src="../src/demo-stub.js"></script><script src="../../core.js"></script>#' \
  -e 's#<script src="popup.js"></script>#<script src="../../popup.js"></script>#' \
  ../popup.html > build/popup-demo.html

for page in src/*.html; do
  name="$(basename "$page" .html)"
  size="$(grep -o 'body { width: [0-9]*px; height: [0-9]*px' "$page" | grep -o '[0-9]*' | paste -sd, -)"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --allow-file-access-from-files --virtual-time-budget=4000 \
    --window-size="$size" --screenshot="$PWD/$name.png" "file://$PWD/$page" 2>/dev/null
  echo "$name.png ($size)"
done

# The website shows the bare popup at 2x.
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
  --allow-file-access-from-files --virtual-time-budget=4000 \
  --window-size=440,620 --screenshot="$PWD/../docs/assets/popup.png" "file://$PWD/build/popup-demo.html?scene=list" 2>/dev/null
echo "../docs/assets/popup.png (440x620 @2x)"
