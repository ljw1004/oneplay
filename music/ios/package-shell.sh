#!/bin/sh
# Xcode declares the exact source list. Only those compiled modules and assets
# may enter the bundle or be served by the scheme handler.
set -eu
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
cd "$SRCROOT/.."
compiled="$DERIVED_FILE_DIR/OnePlayModules"
# Reject duplicate keys here so a bad manifest never reaches the installed app.
inputs="$SRCROOT/ShellInputs.xcfilelist"
if [ -n "$(sort "$inputs" | uniq -d)" ]; then
    echo "error: Duplicate entry in ShellInputs.xcfilelist" >&2
    exit 1
fi
web=$(mktemp -d "$DERIVED_FILE_DIR/OnePlayWeb.XXXXXX")
trap 'rm -rf "$web"' EXIT
mkdir -p "$compiled" "$web/dist" "$web/assets"
npm run build -- --outDir "$compiled" --sourceMap false
manifest="$web/manifest.txt"
: > "$manifest"
while IFS= read -r input; do
    source=${input#'$(SRCROOT)/../'}
    case "$source" in
        src/*.ts) asset="dist/$(basename "$source" .ts).js"; source="$compiled/$(basename "$asset")" ;;
        *) asset="$source" ;;
    esac
    cp "$source" "$web/$asset"
    echo "$asset" >> "$manifest"
done < "$inputs"
# The native build counter is independent of the deployed PWA counter.
sed -i '' "s/__DEPLOY_COUNTER__/$CURRENT_PROJECT_VERSION/g" "$web/dist/index.js"
# Incremental builds must remove assets dropped from the manifest.
mkdir -p "$SCRIPT_OUTPUT_FILE_0"
/usr/bin/rsync -a --delete "$web/" "$SCRIPT_OUTPUT_FILE_0/"
