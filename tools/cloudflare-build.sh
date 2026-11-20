#!/usr/bin/env bash
# Cloudflare Pages build (2026-11-20). Cloudflare builds the website from the private GitHub repository:
#   Build command:          bash tools/cloudflare-build.sh
#   Build output directory: _site
#   Environment variable:   NODE_VERSION = 20
# Same compiled, minified site as the old GitHub Pages workflow, with the same safety checks:
# the readable app source and the admin screens never reach the published copy.
set -euo pipefail
npm install --no-save --no-package-lock --no-audit --no-fund @babel/standalone@7.29.7 terser@5.36.0
node tools/build-site.js _site
grep -q 'id="app-compiled"' _site/index.html
! grep -q 'id="app-source"' _site/index.html
grep -q 'id="q-adm"' _site/index.html
! grep -q 'Platform Admin — Cost' _site/index.html
! grep -q 'id="workspaces"' _site/index.html
# GitHub's CNAME file means nothing to Cloudflare (the domain is set in the Cloudflare dashboard)
rm -f _site/CNAME
# nothing from the repository's private parts may be published
for p in supabase tests tools .github; do [ ! -e "_site/$p" ] || { echo "refusing to publish $p"; exit 1; }; done
echo "Cloudflare build ready: $(find _site -type f | wc -l) files"
