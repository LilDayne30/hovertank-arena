#!/usr/bin/env bash
# Build the iOS app and upload it to App Store Connect (TestFlight) in one go. Run on the Mac:
#   TEAM=XXXXXXXXXX npm run ios:upload
# TEAM = your Apple Developer Team ID (developer.apple.com → Account → Membership details).
# Xcode must be signed in to your Apple ID once (Xcode → Settings → Accounts). The build number is
# raised automatically on upload (manageAppVersionAndBuildNumber).
set -euo pipefail
cd "$(dirname "$0")/../.."
: "${TEAM:?set TEAM to your Apple Developer Team ID}"
npm ci
npm run build:app
rm -rf build/ios && mkdir -p build/ios
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release -destination 'generic/platform=iOS' \
  -archivePath build/ios/App.xcarchive DEVELOPMENT_TEAM="$TEAM" -allowProvisioningUpdates archive
xcodebuild -exportArchive -archivePath build/ios/App.xcarchive -exportOptionsPlist tools/ios/ExportOptions.plist \
  -exportPath build/ios/export -allowProvisioningUpdates
echo "Uploaded. It appears in App Store Connect → TestFlight after processing (about 10–30 minutes)."
