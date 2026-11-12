# Lift + Keto (Android)

Nathan's Lift & Keto Log as an installable Android app. It reads daily steps from
Health Connect (Samsung Health and the Galaxy Watch sync there) and uses Claude
through the owner's own Anthropic API key for food photos, labels, ketone strips
and the daily plan. All log data stays on the phone.

## How it fits together

- `web/app.html` is the whole app (screens, logic, styles). It started as the
  claude.ai artifact and still runs there unchanged.
- `src/native.js` is bundled into `web/native.js` and runs first inside the
  Android app. It stands in for the claude.ai runtime (`window.claude.use`):
  `db` saves on the phone, `sample` calls the Anthropic API, `downloads` opens the
  share sheet. It also syncs steps and loads app updates.
- On launch the app shows the newest of: the `app.html` built into the APK, or a
  newer one it downloaded earlier from GitHub Pages. It then checks Pages for a
  newer `version.json` and offers a restart when one is ready.

## Making a change (most changes)

1. Edit `web/app.html`.
2. Bump `<meta name="app-version" content="N">` by one.
3. Push to `main`. The workflow publishes `app.html` and `version.json` to Pages,
   and the phone picks it up the next time the app opens.

`app.html` must keep the `window.APP={...}` line and the `window.NATIVE` hooks in
the Setup tab, or the build refuses it.

## Changing the Android side (rare)

Native plugins, permissions, icon, or `src/native.js` changes need a new install:
bump `shell-version.txt`, push, and the workflow builds a signed APK and publishes
it as a GitHub release. The app tells the user a new install is available.

The APK is signed with a key stored in the `KEYSTORE_B64` and `KEYSTORE_PASSWORD`
repository secrets. Never change that key: Android only updates an app in place
when the new APK has the same signature.

## Local build

    npm ci
    npm run build          # bundles native.js, checks app.html, writes version.json
    npx cap sync android   # then build with Android Studio or ./gradlew in android/
